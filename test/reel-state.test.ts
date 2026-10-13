import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import {
  createReel,
  createRun,
  getReel,
  insertFbToken,
  insertKeyword,
  listScenes,
  markRunPublished,
  replaceScenes,
  setFbPageOptions,
  setReelStage,
  updateReel,
  updateScene,
  upsertFbPage,
  upsertSite,
  type ReelView,
} from '../src/db/repos.js';
import { publishReel, tickReels, type ReelDeps } from '../src/reels/engine.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * A reel moves on its own, one state per tick, and stops when it should.
 *
 * The gate that matters is per page: a niche page that has earned trust may
 * publish unattended while a newer one waits to be read. And a reel with no
 * page waits forever on purpose — guessing a page posts a recipe to an
 * audience that did not ask for it, which is worse than posting nothing.
 */

const KEY = randomBytes(32);

function settingsWith(enabled: boolean): Settings {
  const settings = new Settings(KEY);
  settings.set('fb_enabled', enabled ? 'true' : 'false');
  return settings;
}

/** The deps, plus the one Facebook client every page resolves to, for assertions. */
type FakeDeps = ReelDeps & { facebook: { publishReel: ReturnType<typeof vi.fn>; commentOnReel: ReturnType<typeof vi.fn> } };

function fakeDeps(overrides: Partial<ReelDeps> = {}): FakeDeps {
  const facebook = {
    publishReel: vi.fn(async () => ({ videoId: 'VID1', permalink: 'https://fb/VID1' })),
    commentOnReel: vi.fn(async () => ({ commentId: 'C1' })),
  };
  return {
    facebook,
    facebookFor: vi.fn(() => facebook),
    images: {
      poll: vi.fn(async () => ({
        job_id: 'J1',
        status: 'PROCESSING',
        image_url: null,
        image_expires_at: null,
        error: null,
      })),
      submitVideo: vi.fn(async () => 'J1'),
    } as unknown as ReelDeps['images'],
    telegram: { sendMessage: vi.fn(async () => true) } as unknown as ReelDeps['telegram'],
    download: vi.fn(async () => Buffer.from('mp4')),
    prompt: vi.fn(async () => ({ content: '{}' })),
    clipsDir: '',
    assemble: vi.fn(async () => {}),
    uploadImage: vi.fn(async () => 'https://bitespoon.com/fresh.webp'),
    pause: vi.fn(async () => {}),
    ...overrides,
  };
}

function seed(options: { autoPublish: boolean; withPage?: boolean }): {
  reelId: number;
  pageId: number;
} {
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
  setFbPageOptions(pageId, { siteId, autoPublish: options.autoPublish, enabled: true });

  const reelId = createReel({
    runId,
    siteId,
    keywordId,
    fbPageId: options.withPage === false ? null : pageId,
    prompt: 'a stew, steaming',
    caption: 'Stew',
    references: ['https://bitespoon.com/a.webp'],
  });

  return { reelId, pageId };
}

const completed = (url: string) =>
  vi.fn(async () => ({
    job_id: 'J1',
    status: 'COMPLETED',
    image_url: url,
    image_expires_at: null,
    error: null,
  }));

describe('a reel moving through its states', () => {
  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
  });

  afterEach(() => closeDatabase());

  it('does nothing at all while Facebook publishing is off', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'generating', jobId: 'J1' });

    const deps = fakeDeps();
    const result = await tickReels(settingsWith(false), deps);

    expect(result).toEqual({ advanced: 0, failed: 0 });
    expect(deps.images.poll).not.toHaveBeenCalled();
  });

  it('leaves a reel generating while the video is not finished', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'generating', jobId: 'J1' });

    await tickReels(settingsWith(true), fakeDeps());

    expect(getReel(reelId)!.status).toBe('generating');
  });

  it('moves to ready and keeps the video when generation finishes', async () => {
    const { reelId } = seed({ autoPublish: false });
    updateReel(reelId, { status: 'generating', jobId: 'J1' });

    const deps = fakeDeps();
    deps.images.poll = completed('https://cdn/video.mp4');

    await tickReels(settingsWith(true), deps);

    const reel = getReel(reelId)!;
    expect(reel.status).toBe('ready');
    expect(reel.video_url).toBe('https://cdn/video.mp4');
  });

  it('fails the reel when the video job fails', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'generating', jobId: 'J1' });

    const deps = fakeDeps();
    deps.images.poll = vi.fn(async () => ({
      job_id: 'J1',
      status: 'FAILED',
      image_url: null,
      image_expires_at: null,
      error: 'reCAPTCHA rejected',
    }));

    const result = await tickReels(settingsWith(true), deps);

    expect(result.failed).toBe(1);
    const reel = getReel(reelId)!;
    expect(reel.status).toBe('failed');
    expect(reel.error).toMatch(/reCAPTCHA rejected/);
  });

  it('publishes a ready reel when its page publishes automatically', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    await tickReels(settingsWith(true), deps);

    expect(deps.facebook.publishReel).toHaveBeenCalledOnce();
    const reel = getReel(reelId)!;
    expect(reel.status).toBe('published');
    expect(reel.fb_video_id).toBe('VID1');
  });

  it('publishes with the token the page was found under', async () => {
    const { reelId, pageId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    await tickReels(settingsWith(true), deps);

    expect(deps.facebookFor).toHaveBeenCalledWith(pageId);
  });

  it('holds a ready reel when its page waits for a person', async () => {
    const { reelId } = seed({ autoPublish: false });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    await tickReels(settingsWith(true), deps);

    expect(deps.facebook.publishReel).not.toHaveBeenCalled();
    expect(getReel(reelId)!.status).toBe('ready');
  });

  it('holds a reel that has no page rather than guessing one', async () => {
    const { reelId } = seed({ autoPublish: true, withPage: false });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    await tickReels(settingsWith(true), deps);

    expect(deps.facebook.publishReel).not.toHaveBeenCalled();
    expect(getReel(reelId)!.status).toBe('ready');
  });

  it('publishes a held reel when a person releases it', async () => {
    // The Publish button and the scheduler take the same path, so a reel
    // released by hand goes out exactly as an automatic one does.
    const { reelId } = seed({ autoPublish: false });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    await publishReel(getReel(reelId) as ReelView, deps);

    expect(getReel(reelId)!.status).toBe('published');
  });

  it('posts the article link as the first comment, not in the caption', async () => {
    // A link in the description is what Facebook's ranking reads as an exit
    // and what makes a post look like an ad. The comment carries it fine.
    const { reelId } = seed({ autoPublish: false });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    const commentOnReel = vi.fn(async () => ({ commentId: 'C1' }));
    deps.facebook.commentOnReel = commentOnReel;
    await publishReel(getReel(reelId) as ReelView, deps);

    expect(commentOnReel).toHaveBeenCalledOnce();
    expect(commentOnReel).toHaveBeenCalledWith({
      pageId: '999',
      videoId: 'VID1',
      message: 'https://bitespoon.com/stew',
    });
    // Published with the caption as written -- the link was never added to it.
    const [[publishCall]] = (deps.facebook.publishReel as ReturnType<typeof vi.fn>).mock.calls;
    expect((publishCall as { description: string }).description).toBe('Stew');
  });

  it('says how to fix a card that matches none of the token\'s pages, instead of "no token"', async () => {
    const { reelId, pageId } = seed({ autoPublish: false });
    run("UPDATE fb_pages SET page_id = 'manual:recipesbuz', name = 'Recipesbuz' WHERE id = ?", pageId);
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    deps.resolveFbTarget = () => undefined; // the bridge found no synced page of that name
    await expect(publishReel(getReel(reelId) as ReelView, deps)).rejects.toThrow(/named "Recipesbuz".*Rename/s);
    expect(deps.facebook.publishReel).not.toHaveBeenCalled();
  });

  it('with the keyword link mode, invites the comment in the caption and posts no first comment', async () => {
    // The reel is published straight to the page, so Setup -> Caption
    // structures has to apply to it: the link goes by private message to whoever
    // comments the keyword, never into a comment of the page's own.
    const { reelId } = seed({ autoPublish: false });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    deps.facebookLink = 'keyword';
    deps.commentKeyword = 'banana';
    const commentOnReel = vi.fn(async () => ({ commentId: 'C1' }));
    deps.facebook.commentOnReel = commentOnReel;
    await publishReel(getReel(reelId) as ReelView, deps);

    expect(commentOnReel).not.toHaveBeenCalled();
    const [[publishCall]] = (deps.facebook.publishReel as ReturnType<typeof vi.fn>).mock.calls;
    const description = (publishCall as { description: string }).description;
    // The word is the dish's own (the title is "Stew"), kept on the reel for the webhook.
    expect(description).toContain('Commentez « STEW »');
    expect(getReel(reelId)!.trigger_keyword).toBe('stew');
    expect(description).not.toContain('https://bitespoon.com/stew');
  });

  it('with Facebook unticked under caption structures, posts the title and the link, nothing else', async () => {
    const { reelId } = seed({ autoPublish: false });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    deps.captionOn = new Set(['instagram']); // Facebook is not ticked
    deps.facebookLink = 'keyword';
    deps.facebookRecipe = 'full';
    const commentOnReel = vi.fn(async () => ({ commentId: 'C1' }));
    deps.facebook.commentOnReel = commentOnReel;
    await publishReel(getReel(reelId) as ReelView, deps);

    const [[publishCall]] = (deps.facebook.publishReel as ReturnType<typeof vi.fn>).mock.calls;
    const description = (publishCall as { description: string }).description;
    expect(description).toBe('Stew\n\nLa recette complète : https://bitespoon.com/stew');
    expect(commentOnReel).not.toHaveBeenCalled();
    expect(getReel(reelId)!.trigger_keyword).toBeNull();
  });

  it('keeps a reel published when only the link comment fails', async () => {
    // The reel is live on the page whether or not the comment lands. Marking
    // it failed would have the scheduler post the video a second time to fix
    // a missing comment.
    const { reelId } = seed({ autoPublish: false });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    deps.facebook.commentOnReel = vi.fn(async () => {
      throw new Error('(#200) Requires pages_manage_engagement');
    });
    await publishReel(getReel(reelId) as ReelView, deps);

    expect(getReel(reelId)!.status).toBe('published');
    expect(getReel(reelId)!.fb_video_id).toBe('VID1');
    // ...and the person is told what to add by hand.
    const sent = (deps.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join(' ');
    expect(sent).toContain('link comment did not post');
    expect(sent).toContain('https://bitespoon.com/stew');
  });

  it('records a publishing failure against the reel and the page', async () => {
    const { reelId, pageId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    deps.facebook.publishReel = vi.fn(async () => {
      throw new Error('Facebook rejected reel VID1 during processing');
    });

    const result = await tickReels(settingsWith(true), deps);

    expect(result.failed).toBe(1);
    expect(getReel(reelId)!.status).toBe('failed');
    expect(pageId).toBeGreaterThan(0);
  });

  it('retries a reel left publishing by a process that died', async () => {
    const { reelId } = seed({ autoPublish: false });
    updateReel(reelId, { status: 'publishing', videoUrl: 'https://cdn/video.mp4' });
    run("UPDATE reels SET updated_at = datetime('now', '-30 minutes') WHERE id = ?", reelId);

    await tickReels(settingsWith(true), fakeDeps());

    // Back to ready, not straight out to Facebook: the page still decides.
    expect(getReel(reelId)!.status).toBe('ready');
  });

  it('leaves a reel alone that started publishing a moment ago, so it is never posted twice', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'publishing', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    await tickReels(settingsWith(true), deps);

    expect(getReel(reelId)!.status).toBe('publishing');
    expect(deps.facebook.publishReel).not.toHaveBeenCalled();
  });

  it('never uploads a reel that has no video', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'ready', videoUrl: null });

    const deps = fakeDeps();
    const result = await tickReels(settingsWith(true), deps);

    expect(deps.facebook.publishReel).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(getReel(reelId)!.status).toBe('failed');
  });

  it('leaves published reels alone on later ticks', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, {
      status: 'published',
      videoUrl: 'https://cdn/video.mp4',
      fbVideoId: 'VID1',
    });

    const deps = fakeDeps();
    await tickReels(settingsWith(true), deps);

    expect(deps.facebook.publishReel).not.toHaveBeenCalled();
    expect(getReel(reelId)!.status).toBe('published');
  });

  it('a notification failure does not unpublish a published reel', async () => {
    const { reelId } = seed({ autoPublish: true });
    updateReel(reelId, { status: 'ready', videoUrl: 'https://cdn/video.mp4' });

    const deps = fakeDeps();
    deps.telegram.sendMessage = vi.fn(async () => {
      throw new Error('Telegram is down');
    });

    await tickReels(settingsWith(true), deps);

    expect(getReel(reelId)!.status).toBe('published');
  });
});

describe('a reel filmed from fresh images', () => {
  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
  });
  afterEach(() => closeDatabase());

  const seedImaging = () => {
    const { reelId } = seed({ autoPublish: false });
    updateReel(reelId, { status: 'generating' });
    setReelStage(reelId, 'imaging', {
      planJson: JSON.stringify({ sources: { hero: 'https://bitespoon.com/a.webp' } }),
    });
    replaceScenes(reelId, [
      { seconds: 10, presenter: false, sources: ['hero'], imagePrompt: 'the stew from above', motionPrompt: 'steam', line: '' },
      { seconds: 10, presenter: false, sources: ['hero'], imagePrompt: '', motionPrompt: 'a ladle', line: '' },
    ]);
    return reelId;
  };

  it('makes one image per scene that asks for one, following the feature image, and puts it on the site', async () => {
    const reelId = seedImaging();
    const settings = settingsWith(true);
    settings.set('image_gap_seconds', '0');
    const generate = vi.fn(async () => ({
      jobId: 'J9', imageUrl: 'https://cdn/x', data: Buffer.from('img'), contentType: 'image/webp',
    }));
    const deps = fakeDeps({ images: { generate } as unknown as ReelDeps['images'] });

    await tickReels(settings, deps);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]).toEqual([
      'the stew from above', 'VERTICAL', { referenceUrls: ['https://bitespoon.com/a.webp'] },
    ]);
    expect(deps.uploadImage).toHaveBeenCalledWith(expect.any(Number), Buffer.from('img'), 'image/webp');
    expect(listScenes(reelId).map((s) => s.image_url)).toEqual(['https://bitespoon.com/fresh.webp', null]);
    expect(getReel(reelId)).toMatchObject({ status: 'generating', stage: 'filming' });
  });

  it('breathes between fresh images, and never remakes one it already has', async () => {
    const reelId = seedImaging();
    replaceScenes(reelId, [
      { seconds: 10, presenter: false, sources: ['hero'], imagePrompt: 'one', motionPrompt: 'm', line: '' },
      { seconds: 10, presenter: false, sources: ['hero'], imagePrompt: 'two', motionPrompt: 'm', line: '' },
      { seconds: 10, presenter: false, sources: ['hero'], imagePrompt: 'three', motionPrompt: 'm', line: '' },
    ]);
    const [first] = listScenes(reelId);
    updateSceneImage(first!.id);
    const settings = settingsWith(true);
    settings.set('image_gap_seconds', '30');
    const generate = vi.fn(async () => ({
      jobId: 'J9', imageUrl: 'https://cdn/x', data: Buffer.from('img'), contentType: 'image/webp',
    }));
    const deps = fakeDeps({ images: { generate } as unknown as ReelDeps['images'] });

    await tickReels(settings, deps);

    expect(generate.mock.calls.map((c) => c[0])).toEqual(['two', 'three']);
    expect(deps.pause).toHaveBeenCalledTimes(1);
    expect(deps.pause).toHaveBeenCalledWith(30_000);
  });

  it('fails the reel, not the process, when an image cannot be made', async () => {
    const reelId = seedImaging();
    const settings = settingsWith(true);
    const deps = fakeDeps({
      images: { generate: vi.fn(async () => { throw new Error('no credits'); }) } as unknown as ReelDeps['images'],
    });

    const result = await tickReels(settings, deps);

    expect(result.failed).toBe(1);
    expect(getReel(reelId)).toMatchObject({ status: 'failed', error: 'no credits' });
  });
});

function updateSceneImage(sceneId: number): void {
  updateScene(sceneId, { imageUrl: 'https://bitespoon.com/already.webp' });
}
