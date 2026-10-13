import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createReel,
  createRun,
  getReel,
  insertFbToken,
  insertKeyword,
  markRunPublished,
  setFbPageOptions,
  setReelStage,
  updateReel,
  upsertFbPage,
  upsertSite,
} from '../src/db/repos.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pickMusic, tickReels, type ReelDeps } from '../src/reels/engine.js';
import { wrapWords } from '../src/reels/assemble.js';
import { MUSIC_SLOTS, allMusicUrls, musicSlotKey, musicUploadsDir, reelMode } from '../src/reels/compose.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

/** Clip + steps: the Flow clip, then the article's photos with their steps, then the call to action. */

const KEY = randomBytes(32);
let dir = '';

function setup(mixed: boolean) {
  const siteId = upsertSite(
    { name: 's', domain: 'bitespoon.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 },
    KEY,
  );
  const keywordId = insertKeyword({ seed_keyword: 'dessert', spy_title: 'Bars' });
  const runId = createRun(keywordId, siteId);
  markRunPublished(runId, 'p1', 'https://bitespoon.com/bars', 'Bars');
  const pageId = upsertFbPage({ pageId: '9', name: 'P', tokenId: insertFbToken('A', 'tok', KEY) });
  setFbPageOptions(pageId, { siteId, autoPublish: false, enabled: true });
  const reelId = createReel({ runId, siteId, keywordId, fbPageId: pageId, prompt: 'p', caption: 'Bars', references: ['https://x/a.webp'] });
  if (mixed) {
    setReelStage(reelId, 'done', {
      planJson: JSON.stringify({
        mixed: true,
        article: { title: 'Cookie Cheesecake Bars', recipe: '{}', imagePrompts: { step_a: 'dough pressed' } },
        sources: { hero: 'https://x/hero.webp', stepA: 'https://x/a.webp', stepB: 'https://x/b.webp', stepC: 'https://x/c.webp' },
      }),
    });
  }
  updateReel(reelId, { status: 'generating', jobId: 'J1' });
  return reelId;
}

function deps(overrides: Partial<ReelDeps> = {}): ReelDeps {
  return {
    facebookFor: vi.fn(),
    images: {
      poll: vi.fn(async () => ({ job_id: 'J1', status: 'COMPLETED', image_url: 'https://flow/clip.mp4', image_expires_at: null, error: null })),
      submitVideo: vi.fn(async () => 'J1'),
    } as unknown as ReelDeps['images'],
    telegram: { sendMessage: vi.fn(async () => true) } as unknown as ReelDeps['telegram'],
    download: vi.fn(async () => Buffer.from('data')),
    prompt: vi.fn(async () => ({ content: '{"hook":"Cookie dough meets cheesecake","steps":["Press the dough","Pour the filling","Bake 35 min"]}' })),
    clipsDir: dir,
    assemble: vi.fn(),
    uploadImage: vi.fn(),
    uploadVideo: vi.fn(),
    scheduleReel: vi.fn(),
    reelPublisher: 'buffer',
    pause: vi.fn(async () => {}),
    mix: vi.fn(async () => {}),
    ...overrides,
  } as ReelDeps;
}

describe('clip + steps reels', () => {
  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'mix-'));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the clip, then builds the reel with the steps written on the photos', async () => {
    const settings = new Settings(KEY);
    settings.set('fb_enabled', 'true');
    const reelId = setup(true);
    const d = deps();

    await tickReels(settings, d);
    let reel = getReel(reelId)!;
    expect(reel.stage).toBe('mixing');
    expect(reel.status).toBe('generating');
    expect(reel.video_url).toBeFalsy(); // the bare clip is never published

    await tickReels(settings, d);
    reel = getReel(reelId)!;
    expect(reel.status).toBe('ready');
    expect(reel.output_path).toBe(join(dir, `${reelId}.mp4`));
    const [input] = (d.mix as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(input.hook).toBe('Cookie dough meets cheesecake');
    expect(input.steps.map((s: { caption: string }) => s.caption)).toEqual(['Press the dough', 'Pour the filling', 'Bake 35 min']);
    // The operator's line with this reel's own site stamped into it, not the
    // raw setting: one Call to action serves every site, so {domain} is what
    // keeps one site's address off another site's reels.
    expect(settings.get('reel_cta_text')).toContain('{domain}');
    expect(input.cta).toBe('La recette complète : bitespoon.com');
    expect(input.music).toBeUndefined();
  });

  it('still makes the reel when the model cannot write the captions', async () => {
    const settings = new Settings(KEY);
    settings.set('fb_enabled', 'true');
    const reelId = setup(true);
    const d = deps({ prompt: vi.fn(async () => { throw new Error('down'); }) });
    await tickReels(settings, d);
    await tickReels(settings, d);
    expect(getReel(reelId)!.status).toBe('ready');
    const [input] = (d.mix as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(input.hook).toBe('Cookie Cheesecake Bars');
    expect(input.steps.every((s: { caption: string }) => s.caption === '')).toBe(true);
  });

  it('downloads one of the music links when there are some', async () => {
    const settings = new Settings(KEY);
    settings.set('fb_enabled', 'true');
    settings.set('reel_music_urls', 'https://site/m1.mp3');
    setup(true);
    const d = deps();
    await tickReels(settings, d);
    await tickReels(settings, d);
    expect(d.download).toHaveBeenCalledWith('https://site/m1.mp3');
    const [input] = (d.mix as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(input.music).toMatch(/music/);
  });

  it('uses an uploaded song straight off disk, without downloading it', async () => {
    mkdirSync(musicUploadsDir(), { recursive: true });
    writeFileSync(join(musicUploadsDir(), 'uploaded-test-track.mp3'), 'real song bytes');

    const settings = new Settings(KEY);
    settings.set('fb_enabled', 'true');
    settings.set('reel_music_urls', 'local:uploaded-test-track.mp3');
    setup(true);
    const d = deps();
    await tickReels(settings, d);
    await tickReels(settings, d);
    // The clip and the article's photos still come through download; only the
    // music, since it was uploaded, is read straight off disk instead.
    expect(d.download).not.toHaveBeenCalledWith('local:uploaded-test-track.mp3');
    const [input] = (d.mix as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(input.music).toMatch(/music/);
  });

  it('a one-clip reel is ready as soon as its clip is', async () => {
    const settings = new Settings(KEY);
    settings.set('fb_enabled', 'true');
    const reelId = setup(false);
    const d = deps();
    await tickReels(settings, d);
    expect(getReel(reelId)!.status).toBe('ready');
    expect(d.mix).not.toHaveBeenCalled();
  });

  it('reads the mode and the helpers', () => {
    const settings = new Settings(KEY);
    settings.set('reel_mode', 'mixed');
    expect(reelMode(settings)).toBe('mixed');
    expect(pickMusic('')).toBeNull();
    expect(pickMusic('not a link\nhttps://a/1.mp3\nhttps://a/2.mp3', () => 0.9)).toBe('https://a/2.mp3');
    expect(pickMusic('https://a/1.mp3\nlocal:song.mp3', () => 0.9)).toBe('local:song.mp3');
    expect(wrapWords('Press the cookie dough into the pan', 18)).toBe('Press the cookie\ndough into the pan');
  });

  it('pools every music box into one list, in order, skipping empty boxes', () => {
    const settings = new Settings(KEY);
    expect(musicSlotKey(1)).toBe('reel_music_urls');
    expect(musicSlotKey(2)).toBe('reel_music_urls_2');
    expect(musicSlotKey(MUSIC_SLOTS)).toBe(`reel_music_urls_${MUSIC_SLOTS}`);

    expect(allMusicUrls(settings)).toBe('');

    settings.set('reel_music_urls', 'https://a/1.mp3\nhttps://a/2.mp3');
    settings.set('reel_music_urls_3', 'https://a/3.mp3');
    settings.set(musicSlotKey(MUSIC_SLOTS), 'https://a/last.mp3');

    expect(allMusicUrls(settings)).toBe(
      'https://a/1.mp3\nhttps://a/2.mp3\nhttps://a/3.mp3\nhttps://a/last.mp3',
    );
    // Pooled text is still just newline-separated links, so the existing picker needs no changes.
    expect(pickMusic(allMusicUrls(settings), () => 0.99)).toBe('https://a/last.mp3');
  });
});
