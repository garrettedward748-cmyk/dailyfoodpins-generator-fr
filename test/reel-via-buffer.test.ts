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
  upsertFbPage,
  upsertSite,
  type ReelView,
} from '../src/db/repos.js';
import { publishReel, type ReelDeps } from '../src/reels/engine.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Publishing a reel through Buffer instead of straight to the Page.
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

describe('publishing a reel through Buffer', () => {
  it('adds the video to the recipe page, and a failure there does not fail the reel', async () => {
    const { reelId, siteId } = seed();
    const attachVideo = vi.fn(async () => { throw new Error('HTTP 404'); });
    await publishReel(reelOf(reelId), fakeDeps({ attachVideo }));
    expect(attachVideo).toHaveBeenCalledWith(expect.objectContaining({
      siteId, videoUrl: 'https://bitespoon.com/video/videos/reel-1.mp4',
    }));
    expect(getReel(reelId)!.status).toBe('published');
  });

  it('also pins the video on Pinterest, and a failed pin does not fail the reel', async () => {
    const { reelId, siteId } = seed();
    const pinReel = vi.fn(async () => { throw new Error('board missing'); });
    await publishReel(reelOf(reelId), fakeDeps({ pinReel }));
    expect(pinReel).toHaveBeenCalledWith(expect.objectContaining({
      siteId, linkUrl: 'https://bitespoon.com/stew', videoUrl: 'https://bitespoon.com/video/videos/reel-1.mp4',
    }));
    expect(getReel(reelId)!.status).toBe('published');
  });

  it('goes through the account of the page the reel is for, not whichever account the run\'s turn held', async () => {
    // Seven Facebook accounts in turn: the reel was shown for RecipeCorner2
    // (Facebook 7) but went out through Recipesbuzz (Facebook 2), the run's turn.
    const { reelId, siteId } = seed();
    firstProfile(siteId, 'facebook');
    const own = addProfile(siteId, 'facebook');
    dbRun('UPDATE fb_pages SET profile_id = ? WHERE id = ?', own, reelOf(reelId).fb_page_id);
    const deps = fakeDeps();

    await publishReel(reelOf(reelId), deps);

    expect(deps.scheduleReel).toHaveBeenCalledWith(expect.objectContaining({ profileId: own }));
  });

  it('sends the Instagram and YouTube copies after the reel\'s page, and records where each really went', async () => {
    const { reelId, siteId } = seed();
    firstProfile(siteId, 'facebook');
    const own = addProfile(siteId, 'facebook');
    dbRun('UPDATE fb_pages SET profile_id = ? WHERE id = ?', own, reelOf(reelId).fb_page_id);
    dbRun('UPDATE sites SET ig_reels = 1, yt_reels = 1 WHERE id = ?', siteId);
    const scheduleReel = vi.fn(async (input: { onPage?: (p: string) => void }) => { input.onPage?.('Amanda Recipes'); return 'BUF-1'; });
    const instagramReel = vi.fn(async (input: { onPage?: (p: string) => void }) => { input.onPage?.('amanda.recipes'); return 'IG-1'; });
    const youtubeShort = vi.fn(async () => 'YT-1');
    await publishReel(reelOf(reelId), fakeDeps({ scheduleReel, instagramReel, youtubeShort } as Partial<ReelDeps>));

    expect(instagramReel).toHaveBeenCalledWith(expect.objectContaining({ pageProfileId: own }));
    expect(youtubeShort).toHaveBeenCalledWith(expect.objectContaining({ pageProfileId: own }));
    const channels = JSON.parse(getReel(reelId)!.channels_json!);
    expect(channels.facebook).toMatchObject({ status: 'ok', page: 'Amanda Recipes' });
    expect(channels.instagram).toMatchObject({ status: 'ok', page: 'amanda.recipes' });
    expect(channels.youtube.page).toBeUndefined(); // nothing said: nothing recorded, never a guess
  });

  it('puts the video on the site and schedules it, without touching the Page token', async () => {
    const { reelId, siteId } = seed();
    const deps = fakeDeps();

    await publishReel(reelOf(reelId), deps);

    expect(deps.uploadVideo).toHaveBeenCalledWith(siteId, expect.any(Buffer), expect.any(String));
    expect(deps.scheduleReel).toHaveBeenCalledWith({
      siteId,
      runId: expect.anything(),
      text: expect.stringMatching(/^La recette complète : https:\/\/bitespoon\.com\/stew\n\n.+$/),
      videoUrl: 'https://bitespoon.com/video/videos/reel-1.mp4',
      // Named, so Facebook does not list it as "Untitled Video".
      title: 'Stew',
      // Told which page Buffer really posted to, for the reel's record.
      onPage: expect.any(Function),
    });

    // The whole point: no Graph call, so no Page token to expire.
    expect(deps.facebook.publishReel).not.toHaveBeenCalled();
    expect(deps.facebook.commentOnReel).not.toHaveBeenCalled();
  });

  it('records Buffer post id, since there is no Facebook video id to record', async () => {
    const { reelId } = seed();

    await publishReel(reelOf(reelId), fakeDeps());

    const reel = getReel(reelId)!;
    expect(reel.status).toBe('published');
    expect(reel.fb_video_id).toBe('BUF-1');
  });

  it('says in the notification that Buffer holds the queue, not this page', async () => {
    const { reelId } = seed();
    const deps = fakeDeps();

    await publishReel(reelOf(reelId), deps);

    const sent = String((deps.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(sent).toContain('BUF-1');
    expect(sent).toMatch(/Buffer/);
  });

  it('leaves the reel unpublished when Buffer refuses it', async () => {
    const { reelId } = seed();
    const deps = fakeDeps({
      scheduleReel: vi.fn(async () => {
        throw new Error('Buffer rejected the reel: video longer than 90 seconds');
      }),
    });

    await expect(publishReel(reelOf(reelId), deps)).rejects.toThrow(/90 seconds/);
    expect(getReel(reelId)?.status).not.toBe('published');
  });

  it('never asks the page for a token, which a hand-added page does not have', async () => {
    const { reelId } = seed();
    const deps = fakeDeps({
      // What defaultDeps does for a page with no token: building the client
      // is itself the failure, before a single Graph call.
      facebookFor: vi.fn(() => {
        throw new Error('This page has no Facebook token. Add one under Settings → Facebook.');
      }) as unknown as ReelDeps['facebookFor'],
    });

    await publishReel(reelOf(reelId), deps);

    expect(deps.facebookFor).not.toHaveBeenCalled();
    expect(getReel(reelId)?.status).toBe('published');
  });

  it('still uses the Page directly when the route is set to facebook', async () => {
    const { reelId } = seed();
    const deps = fakeDeps({ reelPublisher: 'facebook' });

    await publishReel(reelOf(reelId), deps);

    expect(deps.facebook.publishReel).toHaveBeenCalled();
    expect(deps.uploadVideo).not.toHaveBeenCalled();
    expect(getReel(reelId)?.fb_video_id).toBe('VID1');
  });

  it('a full Facebook queue does not keep the reel off Pinterest and Instagram, and a retry only redoes Facebook', async () => {
    const { reelId } = seed();
    const scheduleReel = vi.fn(async () => { throw new Error('All Buffer accounts are full'); });
    const pinReel = vi.fn(async () => 'PIN-1');
    const instagramReel = vi.fn(async () => 'IG-1');
    const deps = fakeDeps({ scheduleReel, pinReel, instagramReel });
    await publishReel(reelOf(reelId), deps);
    let reel = getReel(reelId)!;
    expect(reel.status).toBe('published');
    expect(reel.error).toMatch(/Not on:\nfacebook: All Buffer accounts are full/);
    expect(pinReel).toHaveBeenCalledTimes(1);
    expect(instagramReel).toHaveBeenCalledTimes(1);

    // Retry: Facebook has room now; Pinterest and Instagram are not posted twice, the video not uploaded twice.
    scheduleReel.mockResolvedValue('BUF-2');
    updateReel(reelId, { status: 'ready' });
    await publishReel(reelOf(reelId), deps);
    reel = getReel(reelId)!;
    expect(reel.status).toBe('published');
    expect(reel.error).toBeNull();
    expect(reel.fb_video_id).toBe('BUF-2');
    expect(pinReel).toHaveBeenCalledTimes(1);
    expect(instagramReel).toHaveBeenCalledTimes(1);
    expect(deps.uploadVideo).toHaveBeenCalledTimes(1);
  });

  it('fails only when no channel took it', async () => {
    const { reelId } = seed();
    const deps = fakeDeps({ scheduleReel: vi.fn(async () => { throw new Error('queue full'); }) });
    await expect(publishReel(reelOf(reelId), deps)).rejects.toThrow(/facebook: queue full/);
  });
});

describe('reels refused for a full Buffer queue', () => {
  it('go back to ready on their own after six hours, at most four times; other failures stay', async () => {
    const { reelsToRetryForFullBuffer, markReelAutoRetry } = await import('../src/db/repos.js');
    const { run } = await import('../src/db/index.js');
    const { reelId } = seed();
    const other = seed().reelId;
    updateReel(reelId, { status: 'failed', error: 'facebook: All Buffer accounts are full: all 1 Buffer account(s)…' });
    updateReel(other, { status: 'failed', error: 'Video generation failed' });
    expect(reelsToRetryForFullBuffer(6, 4)).toHaveLength(0); // too soon
    run("UPDATE reels SET updated_at = datetime('now', '-7 hours')");
    expect(reelsToRetryForFullBuffer(6, 4).map((r) => r.id)).toEqual([reelId]);
    markReelAutoRetry(reelId);
    expect(getReel(reelId)!.status).toBe('ready');
    run("UPDATE reels SET status = 'failed', error = 'All Buffer accounts are full', auto_retries = 4, updated_at = datetime('now', '-7 hours') WHERE id = ?", reelId);
    expect(reelsToRetryForFullBuffer(6, 4)).toHaveLength(0); // tried enough
  });
});

describe('a reel no Facebook page takes', () => {
  it('goes to the other networks through Buffer, and Facebook is left out', async () => {
    const { reelId, siteId } = seed();
    updateReel(reelId, { fbPageId: null });
    const pinReel = vi.fn(async () => 'PIN-1');
    const deps = fakeDeps({ pinReel });
    await publishReel(reelOf(reelId), deps);
    expect(deps.scheduleReel).not.toHaveBeenCalled();
    expect(pinReel).toHaveBeenCalledWith(expect.objectContaining({ siteId }));
    expect(getReel(reelId)).toMatchObject({ status: 'published', fb_page_id: null });
  });

  it('is refused straight to Facebook, which has no page for it', async () => {
    const { reelId } = seed();
    updateReel(reelId, { fbPageId: null });
    await expect(publishReel(reelOf(reelId), fakeDeps({ reelPublisher: 'facebook' }))).rejects.toThrow(/only take reels through Buffer/);
  });
});
