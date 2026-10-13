import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createReel,
  getReel,
  insertFbToken,
  insertKeyword,
  insertPresenter,
  listScenes,
  replaceScenes,
  setFbPagePresenter,
  setReelStage,
  upsertFbPage,
  upsertSite,
} from '../src/db/repos.js';
import { filmPending } from '../src/reels/film.js';
import { clipPrompt, sourceUrls } from '../src/reels/compose.js';
import { Settings } from '../src/settings.js';

/**
 * Filming: one clip per scene, the presenter and voice riding along when the
 * scene has them, a finished clip landing next to the reel, and a failed
 * scene stopping the reel without touching the others.
 */

const KEY = randomBytes(32);

describe('the clip prompt', () => {
  it('puts the line in as dialogue and repeats the voice, word for word', () => {
    const text = clipPrompt(
      { motion: 'she lifts the spoon', line: 'La recette complète in the comments.' },
      { name: 'Rima', voice: 'warm, unhurried' },
    );
    expect(text).toContain('she lifts the spoon');
    expect(text).toContain('Rima says: "La recette complète in the comments."');
    expect(text).toContain('warm, unhurried');
  });

  it('names the dish and the pace in every clip, and nobody when nobody speaks', () => {
    const text = clipPrompt({ motion: 'steam rises', line: '' }, null, 'Baked Ziti');
    expect(text).toMatch(/^steam rises The dish is Baked Ziti/);
    expect(text).toContain('no slow motion');
    expect(text).not.toContain('says');
  });

  it('marks a line as voiceover when the presenter is off screen', () => {
    const text = clipPrompt({ motion: 'a ladle', line: 'hi', onScreen: false }, { name: 'Rima', voice: 'warm' });
    expect(text).toContain('Rima is not on screen; her voiceover says: "hi"');
    expect(text).toContain('Voice: warm.');
  });
});

describe('source urls', () => {
  const images = { hero: '/f.webp', stepA: '/t.webp', stepB: '/m.webp', stepC: '/b.webp' };

  it('names each article image by role, and the pin when there is one', () => {
    const urls = sourceUrls('a.com', images, '/p.webp');
    expect(urls.hero).toBe('https://a.com/f.webp');
    expect(urls.pin).toBe('https://a.com/p.webp');
    expect(Object.keys(sourceUrls('a.com', images, null))).not.toContain('pin');
  });
});

describe('filming', () => {
  let dir: string;
  let settings: Settings;

  beforeEach(() => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
    settings.set('flow_project_id', 'P');
    dir = mkdtempSync(join(tmpdir(), 'reel-'));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = () => {
    const siteId = upsertSite(
      { name: 'a', domain: 'a.com', status: 'active', pin_username: '', project_id: '',
        daily_target: 1, interval_minutes: 60 },
      KEY,
    );
    const keywordId = insertKeyword({ seed_keyword: 'soup' });
    const pageId = upsertFbPage({ pageId: '1', name: 'Page', tokenId: insertFbToken('App', 'tok', KEY) });
    const presenterId = insertPresenter({ name: 'Rima', flowCharacterId: 'char-1',
      flowVoiceId: 'voice-1', voiceDescription: 'warm', portraitUrl: '' });
    setFbPagePresenter(pageId, presenterId);
    const reelId = createReel({ runId: null, siteId, keywordId, fbPageId: pageId, prompt: '',
      caption: 'c', references: [], stage: 'filming' });
    setReelStage(reelId, 'filming', {
      planJson: JSON.stringify({ sources: { hero: 'https://a.com/f.webp', pin: 'https://a.com/p.webp' } }),
    });
    replaceScenes(reelId, [
      { seconds: 10, presenter: true, sources: ['hero'], imagePrompt: '', motionPrompt: 'she lifts the spoon', line: 'hi' },
      { seconds: 10, presenter: false, sources: ['pin', 'hero'], imagePrompt: '', motionPrompt: 'steam', line: '' },
      { seconds: 10, presenter: false, sources: ['hero'], imagePrompt: '', motionPrompt: 'a ladle', line: 'and that is it' },
    ]);
    return reelId;
  };

  const fakeImages = (jobs: Record<string, string>) => ({
    submitVideo: vi.fn(async () => {
      const id = `job-${Object.keys(jobs).length + 1}`;
      jobs[id] = 'PENDING';
      return id;
    }),
    poll: vi.fn(async (id: string) => ({
      job_id: id,
      status: jobs[id]!,
      image_url: jobs[id] === 'COMPLETED' ? `https://cdn/${id}.mp4` : null,
      image_expires_at: null,
      error: jobs[id] === 'FAILED' ? 'no credits' : null,
    })),
  });

  const deps = (images: ReturnType<typeof fakeImages>) => ({
    images,
    download: async () => Buffer.from('mp4'),
    clipsDir: dir,
  });

  it('submits one clip per scene with its sources, the presenter and the voice, for scenes not yet done', async () => {
    const reelId = seed();
    const images = fakeImages({});

    const state = await filmPending(getReel(reelId)!, deps(images), settings);

    expect(state).toBe('working');
    expect(images.submitVideo).toHaveBeenCalledTimes(3);
    expect(images.submitVideo.mock.calls[0]![0]).toMatchObject({
      referenceUrls: ['https://a.com/f.webp'], characterMediaId: 'char-1', voiceMediaId: 'voice-1', projectId: 'P',
    });
    expect(images.submitVideo.mock.calls[0]![0].prompt).toContain('Rima says: "hi"');
    expect(images.submitVideo.mock.calls[1]![0]).toMatchObject({
      referenceUrls: ['https://a.com/p.webp', 'https://a.com/f.webp'],
    });
    expect(images.submitVideo.mock.calls[1]![0].characterMediaId).toBeUndefined();
    expect(images.submitVideo.mock.calls[1]![0].voiceMediaId).toBeUndefined();
    // Off screen but speaking: the voice goes, the character does not.
    expect(images.submitVideo.mock.calls[2]![0]).toMatchObject({ voiceMediaId: 'voice-1' });
    expect(images.submitVideo.mock.calls[2]![0].characterMediaId).toBeUndefined();
    expect(images.submitVideo.mock.calls[2]![0].prompt).toContain('voiceover says: "and that is it"');
    expect(listScenes(reelId).map((s) => s.status)).toEqual(['working', 'working', 'working']);
  });

  it('downloads a finished clip next to the reel, and is done when every scene is', async () => {
    const reelId = seed();
    const jobs: Record<string, string> = {};
    const d = deps(fakeImages(jobs));

    await filmPending(getReel(reelId)!, d, settings);
    jobs['job-1'] = 'COMPLETED';
    expect(await filmPending(getReel(reelId)!, d, settings)).toBe('working');
    jobs['job-2'] = 'COMPLETED';
    expect(await filmPending(getReel(reelId)!, d, settings)).toBe('working');
    jobs['job-3'] = 'COMPLETED';
    expect(await filmPending(getReel(reelId)!, d, settings)).toBe('done');

    const scenes = listScenes(reelId);
    expect(scenes.every((s) => s.status === 'done')).toBe(true);
    expect(existsSync(scenes[0]!.clip_path!)).toBe(true);
    expect(scenes[0]!.clip_path).toContain(join(dir, String(reelId)));
  });

  it('marks a scene failed with the reason, leaves the others, and stops there', async () => {
    const reelId = seed();
    const jobs: Record<string, string> = {};
    const d = deps(fakeImages(jobs));

    await filmPending(getReel(reelId)!, d, settings);
    jobs['job-1'] = 'FAILED';
    await expect(filmPending(getReel(reelId)!, d, settings)).rejects.toThrow(/scene 1/i);

    expect(listScenes(reelId)[0]).toMatchObject({ status: 'failed', error: 'no credits' });
    expect(listScenes(reelId)[1]!.status).toBe('working');
  });
});
