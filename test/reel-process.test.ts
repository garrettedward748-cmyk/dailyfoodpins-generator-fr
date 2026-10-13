import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createReel, createRun, getReel, insertFbToken, insertKeyword, listScenes, markRunPublished,
  setFbPageOptions, setReelStage, upsertFbPage, upsertSite,
} from '../src/db/repos.js';
import { tickReels, type ReelDeps } from '../src/reels/engine.js';
import { processClipPrompt, validateProcess } from '../src/reels/plan.js';
import { assembleProcessReel, lastFrame } from '../src/reels/assemble.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Process reels: eight hands-only shots, the third on filmed from the last
 * frame of the one before, whichever Google account Flow is on by then.
 */

const KEY = randomBytes(32);
const STYLE = 'A white marble countertop, a plain softly blurred light background, white ceramic and clear glass bowls, a black non-stick pan, light-skinned hands with short plain nails and a beige apron, soft daylight from a window on the left, shot on a phone, sharp, natural colours.';
const PLAN = {
  style: STYLE,
  shots: Array.from({ length: 8 }, (_, i) => ({
    camera: 'overhead',
    action: `Hands do step number ${i + 1} of the recipe with the dough`,
    sources: i === 0 ? ['hero'] : ['stepA'],
  })),
};
let dir = '';

function setup() {
  const siteId = upsertSite(
    { name: 's', domain: 'bitespoon.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 },
    KEY,
  );
  const keywordId = insertKeyword({ seed_keyword: 'dessert', spy_title: 'Bars' });
  const runId = createRun(keywordId, siteId);
  markRunPublished(runId, 'p1', 'https://bitespoon.com/bars', 'Bars');
  const pageId = upsertFbPage({ pageId: '9', name: 'P', tokenId: insertFbToken('A', 'tok', KEY) });
  setFbPageOptions(pageId, { siteId, autoPublish: false, enabled: true });
  const reelId = createReel({ runId, siteId, keywordId, fbPageId: pageId, prompt: '', caption: 'Bars', references: [], stage: 'planning' });
  setReelStage(reelId, 'planning', {
    planJson: JSON.stringify({
      process: true,
      article: { title: 'Date Nut Roll', recipe: '{}', imagePrompts: {} },
      sources: { hero: 'https://x/hero.webp', stepA: 'https://x/a.webp', stepB: 'https://x/b.webp' },
    }),
  });
  return reelId;
}

describe('process reels', () => {
  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'proc-'));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('plans eight shots, films them as a chain from the last frames, and joins them', async () => {
    const settings = new Settings(KEY);
    settings.set('fb_enabled', 'true');
    const reelId = setup();
    const submitted: { prompt: string; referenceUrls: string[] }[] = [];
    let n = 0;
    const deps = {
      facebookFor: vi.fn(),
      images: {
        submitVideo: vi.fn(async (input: { prompt: string; referenceUrls: string[] }) => {
          submitted.push(input);
          return `J${++n}`;
        }),
        poll: vi.fn(async (id: string) => ({ job_id: id, status: 'COMPLETED', image_url: `https://flow/${id}.mp4`, image_expires_at: null, error: null })),
      },
      telegram: { sendMessage: vi.fn(async () => true) },
      download: vi.fn(async () => Buffer.from('mp4')),
      prompt: vi.fn(async () => ({ content: JSON.stringify(PLAN) })),
      clipsDir: dir,
      assemble: vi.fn(),
      assembleProcess: vi.fn(async () => {}),
      lastFrame: vi.fn(async (p: string) => Buffer.from(`frame of ${p}`)),
      uploadImage: vi.fn(async (_s: number, data: Buffer) => `https://bitespoon.com/${data.toString().replace(/^.*scene-/, 'frame-')}.jpg`),
      pause: vi.fn(async () => {}),
    } as unknown as ReelDeps;

    await tickReels(settings, deps); // plan
    expect(getReel(reelId)!.stage).toBe('filming');
    expect(listScenes(reelId)).toHaveLength(8);

    await tickReels(settings, deps); // shots 1 and 2 go out; 3 waits for 2
    expect(submitted).toHaveLength(2);

    for (let i = 0; i < 20 && getReel(reelId)!.stage === 'filming'; i++) await tickReels(settings, deps);
    expect(submitted).toHaveLength(8);
    // Shot 3 starts from shot 2's last frame, and from nothing else.
    expect(submitted[2]!.referenceUrls[0]).toBe('https://bitespoon.com/frame-2.mp4.jpg');
    expect(submitted[2]!.referenceUrls).toHaveLength(1); // the frame alone
    expect(submitted[2]!.prompt).toContain('opens exactly on the reference image');
    expect(submitted[1]!.prompt).not.toContain('opens exactly on the reference image');
    // The same set description in every clip.
    expect(submitted.every((s) => s.prompt.includes(STYLE))).toBe(true);

    await tickReels(settings, deps); // assemble
    expect(deps.assembleProcess).toHaveBeenCalledTimes(1);
    expect(getReel(reelId)!.status).toBe('ready');
  });

  it('films a shot from the photos when Flow will not take the frame', async () => {
    const settings = new Settings(KEY);
    settings.set('fb_enabled', 'true');
    const reelId = setup();
    const submitted: string[][] = [];
    let n = 0;
    const deps = {
      facebookFor: vi.fn(),
      images: {
        submitVideo: vi.fn(async (input: { referenceUrls: string[] }) => {
          submitted.push(input.referenceUrls);
          return `J${++n}`;
        }),
        poll: vi.fn(async (id: string) =>
          id === 'J3' || id === 'J4'
            ? { job_id: id, status: 'FAILED', image_url: null, image_expires_at: null, error: 'Uploading a reference failed: RpcError: maseQ failed: [13]' }
            : { job_id: id, status: 'COMPLETED', image_url: `https://flow/${id}.mp4`, image_expires_at: null, error: null },
        ),
      },
      telegram: { sendMessage: vi.fn(async () => true) },
      download: vi.fn(async () => Buffer.from('mp4')),
      prompt: vi.fn(async () => ({ content: JSON.stringify(PLAN) })),
      clipsDir: dir,
      assemble: vi.fn(),
      assembleProcess: vi.fn(async () => {}),
      lastFrame: vi.fn(async () => Buffer.from('f')),
      uploadImage: vi.fn(async () => 'https://bitespoon.com/frame.jpg'),
      pause: vi.fn(async () => {}),
    } as unknown as ReelDeps;

    for (let i = 0; i < 30 && getReel(reelId)!.status === 'generating'; i++) await tickReels(settings, deps);
    expect(getReel(reelId)!.status).toBe('ready');
    expect(submitted[2]![0]).toBe('https://bitespoon.com/frame.jpg');
    expect(submitted[3]).toEqual(['https://bitespoon.com/frame.jpg']); // the frame once more
    expect(submitted[4]).toEqual(['https://x/a.webp']); // then photos only
    expect(listScenes(reelId)[2]!.image_url).toBe('none');
  });

  it('fills in what the model left out and refuses a plan without a kitchen', () => {
    const plan = validateProcess({ style: STYLE, shots: PLAN.shots.map((s) => ({ ...s, sources: [], camera: 'drone' })) }, ['hero', 'stepA', 'stepB', 'stepC']);
    expect(plan.shots[0]!.sources).toEqual(['hero']);
    expect(plan.shots[7]!.sources).toEqual(['stepC']);
    expect(plan.shots[0]!.camera).toBe('overhead');
    expect(() => validateProcess({ style: 'a kitchen', shots: PLAN.shots }, ['hero'])).toThrow(/kitchen/);
    expect(() => validateProcess({ style: STYLE, shots: PLAN.shots.slice(0, 5) }, ['hero'])).toThrow(/exactly 8/);
    expect(processClipPrompt(plan, 1, 'Date Nut Roll', false)).toMatch(/^A white marble/);
  });

  it('cuts real clips into a short reel and takes a last frame', async () => {
    const clips: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = join(dir, `c${i}.mp4`);
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=24:d=8', '-f', 'lavfi', '-i', 'sine=d=8', '-shortest', p]);
      clips.push(p);
    }
    const music = join(dir, 'm.mp3');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=3', music]);
    const out = join(dir, 'out.mp4');
    await assembleProcessReel(clips, out, { music });
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
    expect(duration).toBeGreaterThan(7.4);
    expect(duration).toBeLessThan(7.8);
    const frame = await lastFrame(clips[0]!);
    expect(frame.subarray(0, 2).toString('hex')).toBe('ffd8');
    writeFileSync(join(dir, 'x'), '');
    expect(existsSync(out)).toBe(true);
  }, 60_000);
});
