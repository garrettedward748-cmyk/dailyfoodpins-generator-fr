import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createReel, createRun, getReel, insertFbToken, insertKeyword, markRunPublished,
  setFbPageOptions, updateReel, upsertFbPage, upsertSite, type ReelView,
} from '../src/db/repos.js';
import {
  CAPTION_NETWORKS_NONE, parseCaptionNetworks, serializeCaptionNetworks,
} from '../src/core/caption-structures.js';
import { publishReel, type ReelDeps } from '../src/reels/engine.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Which networks get the written caption, and which go back to the title.
 *
 * The caption is written once per reel and sent to Facebook, Instagram and the
 * YouTube description. Setup -> Caption structures now says which of those
 * three take it; the rest get the recipe title and the link, which is the text
 * they carried before any caption was written.
 */

const KEY = randomBytes(32);

describe('the stored list', () => {
  it('reads back what was written, and drops names it does not know', () => {
    expect([...parseCaptionNetworks('facebook,youtube')]).toEqual(['facebook', 'youtube']);
    // Order is the canonical one, not the one the form happened to submit.
    expect([...parseCaptionNetworks('youtube, FACEBOOK ')]).toEqual(['facebook', 'youtube']);
    expect([...parseCaptionNetworks('pinterest,twitter')]).toEqual([]);
    expect([...parseCaptionNetworks('')]).toEqual([]);
  });

  it('writes "none" rather than an empty value when every box is unticked', () => {
    // Not cosmetic: Settings.get falls back to a setting's default whenever the
    // stored value is empty, so "" would read back as all three networks and
    // the page would quietly ignore what was just unticked.
    expect(serializeCaptionNetworks([])).toBe(CAPTION_NETWORKS_NONE);
    expect(parseCaptionNetworks(CAPTION_NETWORKS_NONE).size).toBe(0);
    expect(serializeCaptionNetworks(['youtube', 'facebook'])).toBe('facebook,youtube');
    expect(serializeCaptionNetworks(['pinterest'])).toBe(CAPTION_NETWORKS_NONE);
  });
});

/* -- What a reel actually posts ------------------------------------------- */

const CAPTION = 'Twelve minutes. One pan.\n\nThe cream goes in off the heat.\n\n#stew #slowcooker';
const TITLE = 'Slow Cooker Beef Stew';

function fakeDeps(overrides: Partial<ReelDeps> = {}): ReelDeps {
  return {
    facebookFor: vi.fn(() => ({})) as unknown as ReelDeps['facebookFor'],
    images: {} as ReelDeps['images'],
    telegram: { sendMessage: vi.fn(async () => true) } as unknown as ReelDeps['telegram'],
    download: vi.fn(async () => Buffer.from('mp4 bytes')),
    prompt: vi.fn(async () => ({ content: '{}' })),
    clipsDir: '',
    assemble: vi.fn(async () => {}),
    uploadImage: vi.fn(async () => 'https://bitespoon.com/fresh.webp'),
    uploadVideo: vi.fn(async () => 'https://bitespoon.com/video/reel-1.mp4'),
    scheduleReel: vi.fn(async () => 'BUF-1'),
    instagramReel: vi.fn(async () => 'IG-1'),
    youtubeShort: vi.fn(async () => 'YT-1'),
    reelPublisher: 'buffer',
    pause: vi.fn(async () => {}),
    ...overrides,
  };
}

function seed(): number {
  const siteId = upsertSite(
    {
      name: 'bitespoon', domain: 'bitespoon.com', status: 'active', pin_username: '',
      project_id: '', daily_target: 1, interval_minutes: 60,
    },
    KEY,
  );
  const keywordId = insertKeyword({ seed_keyword: 'slow cooker', spy_title: TITLE });
  const runId = createRun(keywordId, siteId);
  markRunPublished(runId, 'p1', 'https://bitespoon.com/stew', TITLE);

  const tokenId = insertFbToken('A', 'tok', KEY);
  const pageId = upsertFbPage({ pageId: '999', name: 'Suppers', tokenId });
  setFbPageOptions(pageId, { siteId, autoPublish: true, enabled: true });

  // The caption and the title differ, which is the only way to see which of
  // the two a network was given.
  const reelId = createReel({
    runId, siteId, keywordId, fbPageId: pageId,
    prompt: 'a stew, steaming', caption: CAPTION, references: ['https://bitespoon.com/a.webp'],
  });
  updateReel(reelId, { status: 'ready', videoUrl: 'https://flow.example/clip.mp4' });
  return reelId;
}

const reelOf = (id: number): ReelView => getReel(id)!;
const sentTo = (fn: unknown, field: string): string =>
  String(((fn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>)[field] ?? '');

describe('publishing with some networks unticked', () => {
  beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
  afterEach(() => closeDatabase());

  it('gives the written caption to every network when deps say nothing', async () => {
    // Absent means all of them, so a caller building its own deps — a script, a
    // test — does not lose the caption by not knowing about this.
    const reelId = seed();
    const deps = fakeDeps();

    await publishReel(reelOf(reelId), deps);

    expect(sentTo(deps.scheduleReel, 'text')).toContain('Twelve minutes. One pan.');
    expect(sentTo(deps.instagramReel, 'caption')).toBe(CAPTION);
    expect(sentTo(deps.youtubeShort, 'caption')).toBe(CAPTION);
  });

  it('sends the caption only where it is ticked, and the title everywhere else', async () => {
    const reelId = seed();
    const deps = fakeDeps({ captionOn: new Set(['youtube']) });

    await publishReel(reelOf(reelId), deps);

    // Facebook: the title and the link, exactly as before the caption existed.
    expect(sentTo(deps.scheduleReel, 'text')).toBe(`${TITLE}\n\nLa recette complète : https://bitespoon.com/stew`);
    // Instagram: an empty caption, which its own step reads as "use the title".
    expect(sentTo(deps.instagramReel, 'caption')).toBe('');
    expect(sentTo(deps.instagramReel, 'title')).toBe(TITLE);
    // YouTube, the one that was ticked, gets the words.
    expect(sentTo(deps.youtubeShort, 'caption')).toBe(CAPTION);

    expect(getReel(reelId)!.status).toBe('published');
  });

  it('still publishes everywhere when no network takes the caption', async () => {
    const reelId = seed();
    const deps = fakeDeps({ captionOn: new Set<string>() });

    await publishReel(reelOf(reelId), deps);

    expect(sentTo(deps.scheduleReel, 'text')).toBe(`${TITLE}\n\nLa recette complète : https://bitespoon.com/stew`);
    expect(sentTo(deps.youtubeShort, 'caption')).toBe('');
    expect(getReel(reelId)!.status).toBe('published');
  });
});

/* -- The page and its one Save button -------------------------------------- */

describe('the Caption structures page', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
    app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({
      method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterEach(async () => { await app.close(); closeDatabase(); });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (url: string, payload: string) =>
    app.inject({ method: 'POST', url, payload, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });

  it('starts with all three ticked and offers them on the page', async () => {
    const page = await get('/settings/caption-structures');
    for (const network of ['facebook', 'instagram', 'youtube']) {
      expect(page.body).toContain(`name="network" value="${network}" checked`);
    }
    // No warning to read while YouTube is still on.
    expect(page.body).not.toContain('YouTube is unticked');
  });

  it('saves the networks with the same button as the structures', async () => {
    const { listCaptionStructures } = await import('../src/core/caption-structures.js');
    const rows = listCaptionStructures().slice(0, 2);
    const payload = [
      ...rows.flatMap((r) => [
        `id=${r.id}`, `name=${encodeURIComponent(r.name)}`, `body=${encodeURIComponent(r.body)}`,
        `enabled=${r.id}`,
      ]),
      'network=facebook',
      'network=youtube',
    ].join('&');

    expect((await post('/settings/caption-structures/save', payload)).statusCode).toBe(303);

    expect(new Settings(KEY).get('caption_networks')).toBe('facebook,youtube');

    const page = await get('/settings/caption-structures');
    expect(page.body).toContain('name="network" value="facebook" checked');
    expect(page.body).toContain('name="network" value="youtube" checked');
    expect(page.body).not.toContain('name="network" value="instagram" checked');
  });

  it('stores "none" when every box is cleared, and says so', async () => {
    const { listCaptionStructures } = await import('../src/core/caption-structures.js');
    const row = listCaptionStructures()[0]!;
    const payload = [`id=${row.id}`, `name=${encodeURIComponent(row.name)}`, `body=${encodeURIComponent(row.body)}`].join('&');

    await post('/settings/caption-structures/save', payload);

    expect(new Settings(KEY).get('caption_networks')).toBe(CAPTION_NETWORKS_NONE);
    const page = await get('/settings/caption-structures');
    expect(page.body).toContain('No network is set to use them');
    expect(page.body).toContain('YouTube is unticked');
  });

  it('keeps a site on the default until it is customized, then saves its own without touching the others', async () => {
    const { upsertSite } = await import('../src/db/repos.js');
    const siteId = upsertSite({ name: 'A', domain: 'a.test', status: 'active', daily_target: 1, interval_minutes: 60 } as never, KEY);
    const { listCaptionStructures } = await import('../src/core/caption-structures.js');

    const follows = await get(`/settings/caption-structures?site=${siteId}`);
    expect(follows.body).toContain('Follows the default');
    expect(follows.body).toContain('Customize for this site');
    expect(follows.body).not.toContain('Save all structures');
    // A save for a site that has not been customized is refused.
    expect((await post('/settings/caption-structures/save', `site=${siteId}&network=youtube`)).headers.location).toContain('Customize');

    await post('/settings/caption-structures/customize', `site=${siteId}`);
    const own = listCaptionStructures(siteId);
    expect(own.length).toBeGreaterThan(0);
    const payload = [`site=${siteId}`, `id=${own[0]!.id}`, `name=${encodeURIComponent(own[0]!.name)}`, `body=${encodeURIComponent(own[0]!.body)}`, `enabled=${own[0]!.id}`, 'network=youtube', 'fbp_link=none', 'extra_link=no'].join('&');
    expect((await post('/settings/caption-structures/save', payload)).statusCode).toBe(303);

    const settings = new Settings(KEY);
    expect(settings.get('caption_networks')).toBe('facebook,instagram,youtube,tiktok'); // the default is untouched
    const page = await get(`/settings/caption-structures?site=${siteId}`);
    expect(page.body).toContain('Own settings');
    expect(page.body).toContain('name="network" value="youtube" checked');
    expect(page.body).not.toContain('name="network" value="facebook" checked');
    expect((await get('/settings/caption-structures')).body).toContain('name="network" value="facebook" checked');

    await post('/settings/caption-structures/default', `site=${siteId}`);
    expect((await get(`/settings/caption-structures?site=${siteId}`)).body).toContain('Follows the default');
  });
});
