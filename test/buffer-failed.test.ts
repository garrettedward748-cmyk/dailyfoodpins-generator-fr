import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run as dbRun } from '../src/db/index.js';
import {
  addProfile,
  createReel,
  createRun,
  firstProfile,
  getReel,
  insertFbToken,
  insertKeyword,
  markRunPublished,
  setFbPageOptions,
  updateReel,
  upsertBufferAccount,
  upsertFbPage,
  upsertSite,
  type ReelView,
} from '../src/db/repos.js';
import { publishReel, readChannels, type ReelDeps } from '../src/reels/engine.js';
import { retryFailedBufferReels } from '../src/reels/buffer-failed.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * A reel Buffer took and then could not publish is found and sent again once.
 *
 * (Setup copied from reel-via-buffer.test.ts.)
 *
 * Buffer holds the Facebook connection, so this route has no Page token to
 * mint or renew — the reason it exists. It costs a round trip the Graph
 * route does not need: Buffer will not accept a file, so the video has to be
 * published to the site and handed over as a url.
 */

const KEY = randomBytes(32);

function fakeDeps(overrides: Partial<ReelDeps> = {}): ReelDeps & {
  facebook: { publishReel: ReturnType<typeof vi.fn>; commentOnReel: ReturnType<typeof vi.fn> };
} {
  const facebook = {
    publishReel: vi.fn(async () => ({ videoId: 'VID1', permalink: 'https://fb/VID1' })),
    commentOnReel: vi.fn(async () => ({ commentId: 'C1' })),
  };

  return {
    facebook,
    facebookFor: vi.fn(() => facebook),
    images: {} as ReelDeps['images'],
    telegram: { sendMessage: vi.fn(async () => true) } as unknown as ReelDeps['telegram'],
    download: vi.fn(async () => Buffer.from('mp4 bytes')),
    prompt: vi.fn(async () => ({ content: '{}' })),
    clipsDir: '',
    assemble: vi.fn(async () => {}),
    uploadImage: vi.fn(async () => 'https://bitespoon.com/fresh.webp'),
    uploadVideo: vi.fn(async () => 'https://bitespoon.com/video/videos/reel-1.mp4'),
    scheduleReel: vi.fn(async () => 'BUF-1'),
    reelPublisher: 'buffer',
    pause: vi.fn(async () => {}),
    ...overrides,
  };
}

function seed(): { reelId: number; siteId: number } {
  const siteId = upsertSite(
    {
      name: 'bitespoon',
      domain: 'bitespoon.com',
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 1,
      interval_minutes: 60,
    },
    KEY,
  );
  const keywordId = insertKeyword({ seed_keyword: 'slow cooker', spy_title: 'Stew' });
  const runId = createRun(keywordId, siteId);
  markRunPublished(runId, 'p1', 'https://bitespoon.com/stew', 'Stew');

  const tokenId = insertFbToken('A', 'tok', KEY);
  const pageId = upsertFbPage({ pageId: '999', name: 'Slow Cooker Suppers', tokenId });
  setFbPageOptions(pageId, { siteId, autoPublish: true, enabled: true });

  const reelId = createReel({
    runId,
    siteId,
    keywordId,
    fbPageId: pageId,
    prompt: 'a stew, steaming',
    caption: 'Stew',
    references: ['https://bitespoon.com/a.webp'],
  });

  updateReel(reelId, { status: 'ready', videoUrl: 'https://flow.example/clip.mp4' });

  return { reelId, siteId };
}

const reelOf = (id: number): ReelView => getReel(id)!;

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
});

afterEach(() => closeDatabase());

function fakeBuffer(failed: { id: string; message: string }[]) {
  return {
    getOrganizationIds: vi.fn(async () => ['ORG']),
    failedPosts: vi.fn(async () => failed.map((f) => ({ ...f, channelId: 'CH' }))),
    deletePost: vi.fn(async () => true),
  };
}

async function published(): Promise<{ reelId: number; settings: Settings; deps: ReturnType<typeof fakeDeps> }> {
  const { reelId, siteId } = seed();
  upsertBufferAccount({ siteId, label: 'Main', token: 'buf-token', enabled: true, platform: 'facebook' }, KEY);
  const settings = new Settings(KEY);
  settings.set('fb_enabled', 'true');
  const deps = fakeDeps();
  await publishReel(reelOf(reelId), deps);
  expect(readChannels(reelOf(reelId)).facebook).toMatchObject({ status: 'ok', id: 'BUF-1' });
  return { reelId, settings, deps };
}

describe('reels Buffer could not publish', () => {
  it('sends the failed channel again, once, and removes the dead copy from Buffer', async () => {
    const { reelId, settings, deps } = await published();
    deps.scheduleReel.mockResolvedValue('BUF-2');
    const buffer = fakeBuffer([{ id: 'BUF-1', message: 'Facebook was unable to process the media' }]);

    const result = await retryFailedBufferReels(settings, KEY, deps, { client: () => buffer });

    expect(result).toMatchObject({ failed: 1, retried: 1 });
    expect(deps.scheduleReel).toHaveBeenCalledTimes(2);
    expect(readChannels(reelOf(reelId)).facebook).toMatchObject({ status: 'ok', id: 'BUF-2' });
    expect(buffer.deletePost).toHaveBeenCalledWith('BUF-1');
    expect(reelOf(reelId).status).toBe('published');

    // The new copy fails too: a person decides now, it is not sent a third time.
    const again = fakeBuffer([{ id: 'BUF-2', message: 'An unknown error has occurred' }]);
    const second = await retryFailedBufferReels(settings, KEY, deps, { client: () => again });
    expect(second.retried).toBe(0);
    expect(deps.scheduleReel).toHaveBeenCalledTimes(2);
    expect(again.deletePost).not.toHaveBeenCalled();
  });

  it('leaves alone failed posts that are not one of its reels', async () => {
    const { settings, deps } = await published();
    const buffer = fakeBuffer([{ id: 'SOMEONE-ELSE', message: 'x' }]);
    const result = await retryFailedBufferReels(settings, KEY, deps, { client: () => buffer });
    expect(result).toMatchObject({ failed: 0, retried: 0 });
    expect(deps.scheduleReel).toHaveBeenCalledTimes(1);
  });

  it('asks Buffer nothing when no reel went out lately', async () => {
    seed();
    const settings = new Settings(KEY);
    settings.set('fb_enabled', 'true');
    const buffer = fakeBuffer([]);
    await retryFailedBufferReels(settings, KEY, fakeDeps(), { client: () => buffer });
    expect(buffer.getOrganizationIds).not.toHaveBeenCalled();
  });
});
