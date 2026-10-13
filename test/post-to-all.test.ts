import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  addProfile, createReel, createRun, fanoutPosted, firstProfile, getKeyword, getReel, getSite, insertFbToken,
  insertKeyword, markRunPublished, postsToAll, runTargets, setFbPageOptions, setPostToAll, updateProfile,
  updateReel, upsertBufferAccount, upsertFbPage, upsertSite, type ReelView,
} from '../src/db/repos.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { publishReel, readChannels, type ReelDeps } from '../src/reels/engine.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Rotate, or post to every account.
 *
 * Rotation is the default and what every site had: one account per article,
 * the next account for the next one. Posting to all sends the same post to
 * every account of the network that is on and has a Buffer token. What has to
 * hold either way: rotation is untouched, and a failure on one account is
 * retried on that account alone — never by posting again where it succeeded.
 */

const KEY = randomBytes(32);
beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => closeDatabase());

const newSite = () =>
  upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);

/** Three Facebook accounts with tokens, and a fourth switched off. */
function threeAccounts(siteId: number, platform: 'facebook' | 'youtube' = 'facebook'): number[] {
  const ids = [firstProfile(siteId, platform).id, addProfile(siteId, platform), addProfile(siteId, platform)];
  for (const id of ids) upsertBufferAccount({ siteId, label: `t${id}`, token: 'tok', enabled: true, profileId: id }, KEY);
  const off = addProfile(siteId, platform);
  upsertBufferAccount({ siteId, label: 'off', token: 'tok', enabled: true, profileId: off }, KEY);
  updateProfile(off, { enabled: 0 });
  return ids;
}

describe('the setting', () => {
  it('is off for every network until set, and set per network', () => {
    const id = newSite();
    expect(postsToAll(id, 'facebook')).toBe(false);
    setPostToAll(id, 'facebook', true);
    expect(postsToAll(id, 'facebook')).toBe(true);
    expect(postsToAll(id, 'youtube')).toBe(false);
    setPostToAll(id, 'facebook', false);
    expect(postsToAll(id, 'facebook')).toBe(false);
  });

  it('in rotation, targets the run\'s one account — and the next run the next one', () => {
    const siteId = newSite();
    const ids = threeAccounts(siteId);
    const kw = insertKeyword({ seed_keyword: 'x', spy_title: 'X' });
    const first = runTargets(createRun(kw, siteId), siteId, 'facebook');
    const second = runTargets(createRun(kw, siteId), siteId, 'facebook');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.id).not.toBe(second[0]!.id);
    expect(ids).toContain(first[0]!.id);
  });

  it('posting to all, targets every usable account, the run\'s own first, never the one switched off', () => {
    const siteId = newSite();
    const ids = threeAccounts(siteId);
    setPostToAll(siteId, 'facebook', true);
    const runId = createRun(insertKeyword({ seed_keyword: 'x', spy_title: 'X' }), siteId);
    const targets = runTargets(runId, siteId, 'facebook').map((p) => p!.id);
    expect(targets.sort()).toEqual([...ids].sort());
    // The run's own account is first, and asking again does not move it.
    expect(runTargets(runId, siteId, 'facebook')[0]!.id).toBe(targets[0]);
  });
});

describe('article posts', () => {
  const contextFor = (siteId: number) => {
    const kw = insertKeyword({ seed_keyword: 'x', spy_title: 'X' });
    const runId = createRun(kw, siteId);
    return new PipelineContext({ runId, site: getSite(siteId)!, keyword: getKeyword(kw)!, settings: new Settings(KEY), encryptionKey: KEY });
  };

  it('in rotation, post once', async () => {
    const siteId = newSite();
    threeAccounts(siteId);
    const ctx = contextFor(siteId);
    const send = vi.fn(async () => 'P');
    const result = await ctx.eachAccount('facebook', send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ postId: 'P', accounts: 1 });
  });

  it('posting to all, post the same thing on each account, and keep going past a refusal', async () => {
    const siteId = newSite();
    const ids = threeAccounts(siteId);
    setPostToAll(siteId, 'facebook', true);
    const ctx = contextFor(siteId);

    const seen: number[] = [];
    let refuse = true;
    const send = vi.fn(async (_pool: unknown, profile: { id: number } | undefined) => {
      seen.push(profile!.id);
      if (profile!.id === seen[1] && refuse) throw new Error('queue full');
      return `P${profile!.id}`;
    });

    // The second account refuses; the third is still posted to.
    await expect(ctx.eachAccount('facebook', send)).rejects.toThrow(/Posted on 2 of 3 facebook accounts/);
    expect(seen.sort()).toEqual([...ids].sort());
    expect(Object.keys(fanoutPosted(ctx.runId, 'facebook'))).toHaveLength(2);

    // The retry posts only where it failed — that account and no other.
    const failedId = seen[1]!;
    const done = Object.keys(fanoutPosted(ctx.runId, 'facebook')).map(Number);
    expect(done).not.toContain(failedId);
    refuse = false;
    seen.length = 0;
    const again = await ctx.eachAccount('facebook', send);
    expect(seen).toEqual([failedId]);
    expect(again.accounts).toBe(3);
    expect(Object.keys(fanoutPosted(ctx.runId, 'facebook'))).toHaveLength(3);
  });

  /**
   * The article post and the photo collage both post to 'facebook', on the
   * same account, in the same run. Without separate purpose keys, the
   * collage's own eachAccount call would see the article post's record and
   * believe it, too, had already posted — handing back the article's post id
   * without ever actually sending the collage to Buffer.
   */
  it('a second step posting to the same platform under its own purpose is not mistaken for the first', async () => {
    const siteId = newSite();
    const ctx = contextFor(siteId);

    const articlePost = vi.fn(async () => 'ART1');
    const firstResult = await ctx.eachAccount('facebook', articlePost, 'facebook');
    expect(firstResult.postId).toBe('ART1');

    const collagePost = vi.fn(async () => 'COLLAGE1');
    const secondResult = await ctx.eachAccount('facebook', collagePost, 'facebook-collage');
    expect(collagePost).toHaveBeenCalledTimes(1);
    expect(secondResult.postId).toBe('COLLAGE1');

    expect(fanoutPosted(ctx.runId, 'facebook')).toEqual({ '0': 'ART1' });
    expect(fanoutPosted(ctx.runId, 'facebook-collage')).toEqual({ '0': 'COLLAGE1' });
  });

  /**
   * A step that gates on "does any account of this site take this kind of
   * post" and then fans out in rotation or to all can land on an account
   * whose own page has that kind of post switched off (bug: the gate and the
   * actual destination account were decided by two different, unrelated
   * selections). `send` returning `null` lets the step check each account
   * against its own settings and skip it without that counting as a failure.
   */
  it('posting to all, an account that returns null is skipped, not failed, and not recorded', async () => {
    const siteId = newSite();
    const ids = threeAccounts(siteId);
    const off = ids[1]!; // this one's own page says not to post
    setPostToAll(siteId, 'facebook', true);
    const ctx = contextFor(siteId);

    const send = vi.fn(async (_pool: unknown, profile: { id: number } | undefined) => {
      if (profile!.id === off) return null;
      return `P${profile!.id}`;
    });

    const result = await ctx.eachAccount('facebook', send);
    expect(send).toHaveBeenCalledTimes(3);
    expect(result.accounts).toBe(3);
    // Something was posted (the run's own account, first in the list) — unless
    // that happened to be the skipped one, in which case postId stays empty.
    const done = fanoutPosted(ctx.runId, 'facebook');
    expect(Object.keys(done)).toHaveLength(2); // the two that actually posted
    expect(Object.keys(done)).not.toContain(String(off));
  });

  it('in rotation, when the one account chosen returns null, nothing is posted and nothing fails', async () => {
    const siteId = newSite();
    threeAccounts(siteId);
    const ctx = contextFor(siteId);

    const send = vi.fn(async () => null);
    const result = await ctx.eachAccount('facebook', send);
    expect(result).toEqual({ postId: '', accounts: 1 });
    expect(fanoutPosted(ctx.runId, 'facebook')).toEqual({});
  });
});

describe('reels', () => {
  function seedReel(): { reelId: number; siteId: number } {
    const siteId = newSite();
    const keywordId = insertKeyword({ seed_keyword: 'stew', spy_title: 'Stew' });
    const runId = createRun(keywordId, siteId);
    markRunPublished(runId, 'p1', 'https://s.com/stew', 'Stew');
    const pageId = upsertFbPage({ pageId: '9', name: 'P', tokenId: insertFbToken('A', 'tok', KEY) });
    setFbPageOptions(pageId, { siteId, autoPublish: true, enabled: true });
    const reelId = createReel({ runId, siteId, keywordId, fbPageId: pageId, prompt: 'p', caption: 'Hook.', references: [] });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://flow/clip.mp4' });
    return { reelId, siteId };
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

  it('in rotation, goes to the run\'s account once, under the network\'s plain name', async () => {
    const { reelId } = seedReel();
    const d = deps({ targets: () => [0] });
    await publishReel(getReel(reelId) as ReelView, d);
    expect(d.scheduleReel).toHaveBeenCalledTimes(1);
    expect((d.scheduleReel as ReturnType<typeof vi.fn>).mock.calls[0]![0].profileId).toBeUndefined();
    expect(Object.keys(readChannels(getReel(reelId)!))).toContain('facebook');
  });

  it('posting to all, goes to every account; a retry sends again only where it failed', async () => {
    const { reelId } = seedReel();
    let refuse = true;
    const scheduleReel = vi.fn(async (input: { profileId?: number }) => {
      if (input.profileId === 9 && refuse) throw new Error('queue full');
      return `FB${input.profileId}`;
    });
    const d = deps({ targets: ({ platform }) => (platform === 'facebook' ? [5, 7, 9] : [0]), scheduleReel });

    await publishReel(getReel(reelId) as ReelView, d);
    expect(scheduleReel.mock.calls.map((c) => c[0].profileId)).toEqual([5, 7, 9]);
    let reel = getReel(reelId)!;
    const channels = readChannels(reel);
    expect(channels.facebook).toMatchObject({ status: 'ok', id: 'FB5' });
    expect(channels['facebook:7']).toMatchObject({ status: 'ok', id: 'FB7' });
    expect(channels['facebook:9']).toMatchObject({ status: 'failed' });
    // Published, because it went somewhere — with the one account it missed named.
    expect(reel.status).toBe('published');
    expect(reel.error).toMatch(/facebook:9: queue full/);

    refuse = false;
    scheduleReel.mockClear();
    await publishReel(reel, d);
    expect(scheduleReel.mock.calls.map((c) => c[0].profileId)).toEqual([9]);
    reel = getReel(reelId)!;
    expect(readChannels(reel)['facebook:9']).toMatchObject({ status: 'ok', id: 'FB9' });
    expect(reel.error).toBeNull();
  });

  /**
   * With the real account logic, not a stub. A reel with no run moves the
   * turn every time it asks for its accounts, so asking again on a retry once
   * posted the first account a second time under another key.
   */
  it('a reel with no run, posting to all, never posts twice to one account on retry', async () => {
    const { defaultDeps } = await import('../src/reels/engine.js');
    const siteId = newSite();
    const ids = threeAccounts(siteId);
    setPostToAll(siteId, 'facebook', true);
    const keywordId = insertKeyword({ seed_keyword: 'stew', spy_title: 'Stew' });
    const pageId = upsertFbPage({ pageId: '9', name: 'P', tokenId: insertFbToken('A', 'tok', KEY) });
    setFbPageOptions(pageId, { siteId, autoPublish: true, enabled: true });
    const reelId = createReel({ runId: null, siteId, keywordId, fbPageId: pageId, prompt: 'p', caption: 'Hook.', references: [] });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://flow/clip.mp4' });

    const posted: number[] = [];
    let refuse: number | null = null;
    const scheduleReel = vi.fn(async (input: { profileId?: number }) => {
      if (refuse === null) refuse = input.profileId!; // the first account asked refuses, once
      if (input.profileId === refuse && posted.filter((p) => p === refuse).length === 0 && scheduleReel.mock.calls.length === 1) {
        throw new Error('queue full');
      }
      posted.push(input.profileId!);
      return `FB${input.profileId}`;
    });
    const d = deps({ targets: defaultDeps(new Settings(KEY), KEY).targets, scheduleReel });

    await publishReel(getReel(reelId) as ReelView, d);
    await publishReel(getReel(reelId) as ReelView, d);
    await publishReel(getReel(reelId) as ReelView, d);

    // Every account exactly once, however many times it was retried.
    expect(posted.sort()).toEqual([...ids].sort());
    expect(getReel(reelId)!.error).toBeNull();
  });

  it('keeps retrying the account that failed after the network is switched back to rotation', async () => {
    const { defaultDeps } = await import('../src/reels/engine.js');
    const { reelId, siteId } = seedReel();
    threeAccounts(siteId);
    setPostToAll(siteId, 'facebook', true);

    let refuse = true;
    const sent: number[] = [];
    const scheduleReel = vi.fn(async (input: { profileId?: number }) => {
      if (refuse && sent.length === 2) throw new Error('queue full'); // the third account
      sent.push(input.profileId!);
      return `FB${input.profileId}`;
    });
    const d = deps({ targets: defaultDeps(new Settings(KEY), KEY).targets, scheduleReel });

    await publishReel(getReel(reelId) as ReelView, d);
    expect(getReel(reelId)!.error).toMatch(/queue full/);

    // Back to rotation, then a retry: the reel still owes that one account.
    setPostToAll(siteId, 'facebook', false);
    refuse = false;
    await publishReel(getReel(reelId) as ReelView, d);
    expect(sent).toHaveLength(3);
    expect(new Set(sent).size).toBe(3);
    expect(getReel(reelId)!.error).toBeNull();
  });

  it('does not ask the other accounts when the network is off for the site', async () => {
    const { reelId } = seedReel();
    const instagramReel = vi.fn(async () => null);
    const d = deps({ targets: () => [5, 7, 9], instagramReel });
    await publishReel(getReel(reelId) as ReelView, d);
    expect(instagramReel).toHaveBeenCalledTimes(1);
    expect(Object.keys(readChannels(getReel(reelId)!)).filter((k) => k.startsWith('instagram'))).toEqual(['instagram']);
  });
});

describe('Channels -> Accounts', () => {
  it('offers Rotate (ticked) and Post to all per network, and saves the choice', async () => {
    const { buildServer } = await import('../src/web/server.js');
    const siteId = newSite();
    threeAccounts(siteId, 'youtube');
    const app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;

    let page = await app.inject({ method: 'GET', url: `/accounts/${siteId}`, headers: { cookie } });
    expect(page.body).toContain(`action="/accounts/${siteId}/youtube/mode"`);
    expect(page.body).toMatch(/value="rotate" checked/);
    expect(page.body).not.toContain('coordinated networks of channels');

    const saved = await app.inject({ method: 'POST', url: `/accounts/${siteId}/youtube/mode`, payload: 'mode=all', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });
    expect(saved.statusCode).toBe(303);
    expect(postsToAll(siteId, 'youtube')).toBe(true);
    expect(postsToAll(siteId, 'facebook')).toBe(false);

    page = await app.inject({ method: 'GET', url: `/accounts/${siteId}`, headers: { cookie } });
    // The warning appears once YouTube posts to all, and the header says so.
    expect(page.body).toContain('coordinated networks of channels');
    expect(page.body).toContain('posted to all');
    await app.close();
  });
});
