import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import {
  addProfile, createReel, createRun, fanoutPosted, firstProfile, getFbPageByProfile, getKeyword, getReel, getSite,
  insertKeyword, markRunPublished, pageForSite, setPostToAll, updateProfile, updateReel, upsertBufferAccount,
  upsertFbPageForProfile, upsertSite, type ReelView,
} from '../src/db/repos.js';
import { AccountOffError, publishReel, tickReels, type ReelDeps } from '../src/reels/engine.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { publishToBuffer, resolveBufferTarget } from '../src/pipeline/steps/publish.js';
import { instagramPostStep } from '../src/pipeline/steps/instagram-post.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * The toggle on an account's card (Channels -> Accounts) stops that account
 * posting, on every network and every route: article posts, the collage and
 * reels, through Buffer or straight to Facebook.
 *
 * What made it leak: with nothing usable in rotation (switched on + a Buffer
 * token), pickProfile still returns the site's only account so a run has
 * something to carry, and several routes then posted through it without ever
 * looking at its switch.
 */

const KEY = randomBytes(32);
beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => closeDatabase());

const newSite = () =>
  upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);

/** The site's only account on a network: has a Buffer token, switched off. */
function onlyAccountOff(siteId: number, platform: 'facebook' | 'pinterest' | 'instagram' | 'youtube' | 'tiktok'): number {
  const id = firstProfile(siteId, platform).id;
  upsertBufferAccount({ siteId, label: 'a', token: 'tok', enabled: true, profileId: id }, KEY);
  updateProfile(id, { enabled: 0 });
  return id;
}

const contextFor = (siteId: number) => {
  const kw = insertKeyword({ seed_keyword: 'x', spy_title: 'X' });
  const runId = createRun(kw, siteId);
  return new PipelineContext({ runId, site: getSite(siteId)!, keyword: getKeyword(kw)!, settings: new Settings(KEY), encryptionKey: KEY });
};

describe('article posts, on any network', () => {
  it.each(['facebook', 'pinterest', 'instagram'] as const)(
    'an account switched off is never sent to — %s, in rotation',
    async (platform) => {
      const siteId = newSite();
      onlyAccountOff(siteId, platform);
      const ctx = contextFor(siteId);
      const send = vi.fn(async () => 'P');
      const result = await ctx.eachAccount(platform, send);
      expect(send).not.toHaveBeenCalled();
      expect(result.postId).toBe('');
      expect(fanoutPosted(ctx.runId, platform)).toEqual({});
    },
  );

  it('posting to all, skips the account that is off and posts on the others', async () => {
    const siteId = newSite();
    const on = firstProfile(siteId, 'pinterest').id;
    upsertBufferAccount({ siteId, label: 'on', token: 'tok', enabled: true, profileId: on }, KEY);
    const off = addProfile(siteId, 'pinterest');
    upsertBufferAccount({ siteId, label: 'off', token: 'tok', enabled: true, profileId: off }, KEY);
    updateProfile(off, { enabled: 0 });
    setPostToAll(siteId, 'pinterest', true);
    const ctx = contextFor(siteId);
    const send = vi.fn(async (_pool: unknown, profile: { id: number } | undefined) => `P${profile!.id}`);
    await ctx.eachAccount('pinterest', send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(Object.keys(fanoutPosted(ctx.runId, 'pinterest'))).toEqual([String(on)]);
  });

  it('a site with no accounts at all still posts, as every site did before accounts existed', async () => {
    const siteId = newSite();
    const ctx = contextFor(siteId);
    // No profile rows are created until something asks; a run's pool with no
    // profile (a test context, a legacy site) is `undefined` and must post.
    const send = vi.fn(async () => 'P');
    await ctx.eachAccount('pinterest', send);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('the Pinterest and Instagram steps', () => {
  const pin = {
    seo: { title: 'Lemon Bars' } as never,
    posted: { href: '/recipe/lemon-bars', title: 'Lemon Bars' } as never,
    pinImageUrl: '/image/pins/p.webp',
    cta: '',
  };

  it('pinning with the only Pinterest account off is skipped, and never asks Buffer for channels', async () => {
    const siteId = newSite();
    onlyAccountOff(siteId, 'pinterest');
    const ctx = contextFor(siteId);
    const getOrganizationId = vi.fn(async () => { throw new Error('should not be asked'); });
    Object.defineProperty(ctx, 'buffer', { get: () => ({ getOrganizationId }) });

    const target = (await resolveBufferTarget.run(ctx, { title: 'Lemon Bars' } as never)) as { value?: unknown };
    expect(getOrganizationId).not.toHaveBeenCalled();
    expect(target.value).toEqual({ channelId: '', boardServiceId: '', boardName: '' });
  });

  it('publishing to Buffer with the only Pinterest account off reports skipped, not a post', async () => {
    const siteId = newSite();
    onlyAccountOff(siteId, 'pinterest');
    const ctx = contextFor(siteId);
    const settings = { getBool: (k: string) => k === 'buffer_enabled', get: () => '' };
    (ctx as unknown as { settings: unknown }).settings = settings;
    const out = await publishToBuffer.run(ctx, {
      pin,
      description: 'Zesty.',
      target: { channelId: '', boardServiceId: '', boardName: '' },
    });
    expect(out).toEqual({ skipped: true });
  });

  it('the Instagram post with the only Instagram account off is skipped', async () => {
    const siteId = newSite();
    run('UPDATE sites SET ig_posts = 1 WHERE id = ?', siteId);
    onlyAccountOff(siteId, 'instagram');
    const ctx = contextFor(siteId);
    (ctx as unknown as { site: unknown }).site = getSite(siteId);
    const uploadImage = vi.fn(async () => ({ url: '/i.jpg' }));
    Object.defineProperty(ctx, 'images', { get: () => ({ download: vi.fn(async () => ({ data: await import('sharp').then((m) => m.default({ create: { width: 40, height: 40, channels: 3, background: '#c87832' } }).jpeg().toBuffer()), contentType: 'image/jpeg' })) }) });
    Object.defineProperty(ctx, 'siteApi', { get: () => ({ uploadImage, absoluteUrl: (p: string) => `https://s.com${p}` }) });
    Object.defineProperty(ctx, 'prompt', { value: vi.fn(async () => ({ content: 'Caption' })) });

    const out = await instagramPostStep.run(ctx, {
      seo: { title: 'Lemon Bars' } as never,
      title: 'Lemon Bars',
      postUrl: 'https://s.com/recipe/lemon-bars',
      heroImageUrl: '/image/recipes/hero.webp',
    });
    expect(out).toMatchObject({ skipped: expect.stringContaining('switched off') });
  });
});

describe('Facebook pages and reels', () => {
  it('a page set from an account card takes nothing while its account is off, whatever its ticks say', () => {
    const siteId = newSite();
    const id = firstProfile(siteId, 'facebook').id;
    upsertFbPageForProfile(id, siteId, 'Page', true, true, true); // Posts, Reels, Collage all ticked

    expect(pageForSite(siteId, 'posts')).toBeDefined();
    expect(pageForSite(siteId, 'reels')).toBeDefined();
    expect(pageForSite(siteId, 'collage')).toBeDefined();

    updateProfile(id, { enabled: 0 });
    expect(pageForSite(siteId, 'posts')).toBeUndefined();
    expect(pageForSite(siteId, 'reels')).toBeUndefined();
    expect(pageForSite(siteId, 'collage')).toBeUndefined();

    // Switched back on, the ticks are exactly as they were left.
    updateProfile(id, { enabled: 1 });
    expect(pageForSite(siteId, 'posts')).toBeDefined();
  });

  it('every reel sender sends nothing for an account that is off', async () => {
    const { defaultDeps } = await import('../src/reels/engine.js');
    const siteId = newSite();
    run('UPDATE sites SET ig_reels = 1, yt_reels = 1, tt_reels = 1, pin_reels = 1 WHERE id = ?', siteId);
    const deps = defaultDeps(new Settings(KEY), KEY);
    const ids = {
      facebook: onlyAccountOff(siteId, 'facebook'),
      instagram: onlyAccountOff(siteId, 'instagram'),
      youtube: onlyAccountOff(siteId, 'youtube'),
      tiktok: onlyAccountOff(siteId, 'tiktok'),
      pinterest: onlyAccountOff(siteId, 'pinterest'),
    };
    const common = { siteId, runId: null, title: 'Stew', caption: 'Hook.', postUrl: 'https://s.com/stew', videoUrl: 'https://s.com/v.mp4', linkUrl: 'https://s.com/stew' };

    expect(await deps.scheduleReel({ siteId, runId: null, text: 'Stew', videoUrl: common.videoUrl, profileId: ids.facebook })).toBeNull();
    expect(await deps.instagramReel!({ ...common, profileId: ids.instagram })).toBeNull();
    expect(await deps.youtubeShort!({ ...common, profileId: ids.youtube })).toBeNull();
    expect(await deps.tiktokReel!({ ...common, profileId: ids.tiktok })).toBeNull();
    expect(await deps.pinReel!({ ...common, profileId: ids.pinterest })).toBeNull();
  });
});

describe('publishing a reel whose account is off', () => {
  /** A reel on the page set from an account's card; the account is on or off as asked. */
  function reelOnAccount(accountOn: boolean): { reelId: number; siteId: number; profileId: number } {
    const siteId = newSite();
    const profileId = firstProfile(siteId, 'facebook').id;
    upsertBufferAccount({ siteId, label: 'a', token: 'tok', enabled: true, profileId }, KEY);
    upsertFbPageForProfile(profileId, siteId, 'Page', true, true, true);
    const keywordId = insertKeyword({ seed_keyword: 'stew', spy_title: 'Stew' });
    const runId = createRun(keywordId, siteId);
    markRunPublished(runId, 'p1', 'https://s.com/stew', 'Stew');
    const reelId = createReel({ runId, siteId, keywordId, fbPageId: getFbPageByProfile(profileId)!.id, prompt: 'p', caption: 'Hook.', references: [] });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://flow/clip.mp4' });
    if (!accountOn) updateProfile(profileId, { enabled: 0 });
    return { reelId, siteId, profileId };
  }

  const deps = (overrides: Partial<ReelDeps>): ReelDeps => ({
    facebookFor: vi.fn() as never,
    images: {} as never,
    telegram: { sendMessage: vi.fn(async () => true) } as never,
    download: vi.fn(async () => Buffer.from('mp4')),
    normalize: vi.fn(async (b: Buffer) => b),
    prompt: vi.fn(async () => ({ content: '{}' })),
    clipsDir: '',
    assemble: vi.fn(async () => {}),
    uploadImage: vi.fn(async () => ''),
    uploadVideo: vi.fn(async () => 'https://s.com/v.mp4'),
    scheduleReel: vi.fn(async () => 'FB'),
    reelPublisher: 'buffer',
    pause: vi.fn(async () => {}),
    ...overrides,
  });

  it('straight to Facebook: refused by hand with a message, nothing sent, the reel stays ready', async () => {
    const { reelId } = reelOnAccount(false);
    const d = deps({ reelPublisher: 'facebook' });
    await expect(publishReel(getReel(reelId) as ReelView, d)).rejects.toThrow(AccountOffError);
    await expect(publishReel(getReel(reelId) as ReelView, d)).rejects.toThrow(/"Facebook 1" is switched off/);
    expect(d.facebookFor).not.toHaveBeenCalled();
    expect(d.download).not.toHaveBeenCalled();
    expect(getReel(reelId)).toMatchObject({ status: 'ready', error: null });
  });

  it('through Buffer: every account off, so nothing is sent and the reel is not marked published', async () => {
    const { reelId } = reelOnAccount(false);
    // The real senders answer null for an account that is off.
    const d = deps({ scheduleReel: vi.fn(async () => null) });
    await expect(publishReel(getReel(reelId) as ReelView, d)).rejects.toThrow(/Every account this reel goes to is switched off/);
    expect(getReel(reelId)).toMatchObject({ status: 'ready', error: null });
  });

  it('through Buffer: one account off does not hold back the others', async () => {
    const { reelId } = reelOnAccount(false);
    const d = deps({ scheduleReel: vi.fn(async () => null), instagramReel: vi.fn(async () => 'IG-1') });
    await publishReel(getReel(reelId) as ReelView, d);
    expect(d.instagramReel).toHaveBeenCalledTimes(1);
    expect(getReel(reelId)!.status).toBe('published');
  });

  it('with the account on, publishing works exactly as before', async () => {
    const { reelId } = reelOnAccount(true);
    const d = deps({});
    await publishReel(getReel(reelId) as ReelView, d);
    expect(d.scheduleReel).toHaveBeenCalledTimes(1);
    expect(getReel(reelId)!.status).toBe('published');
  });

  it('the scheduler leaves the reel waiting, not failed, and publishes it once the account is on', async () => {
    const { reelId, profileId } = reelOnAccount(false);
    const settings = new Settings(KEY);
    settings.set('fb_enabled', 'true');
    const d = deps({ reelPublisher: 'facebook', scheduleReel: vi.fn(async () => 'FB') });

    const first = await tickReels(settings, d);
    expect(first.failed).toBe(0);
    expect(getReel(reelId)).toMatchObject({ status: 'ready', error: null });

    // Switched on, the next tick publishes it.
    updateProfile(profileId, { enabled: 1 });
    const second = await tickReels(settings, deps({ scheduleReel: vi.fn(async () => 'FB') }));
    expect(second.failed).toBe(0);
    expect(getReel(reelId)!.status).toBe('published');
  });
});
