import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createReel,
  getReel,
  insertFbToken,
  insertKeyword,
  listFbPages,
  listScenes,
  replaceScenes,
  setReelStage,
  updateReel,
  updateScene,
  upsertFbPage,
  upsertSite,
} from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Setup → Reels shapes every reel; the reel page shows its storyboard and
 * lets one failed scene be filmed again without touching the others.
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

describe('reel settings and the storyboard', () => {
  let app: FastifyInstance;
  let cookie: string;
  let settings: Settings;

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
    settings = new Settings(KEY);
    app = buildServer(settings, KEY, { password: PASSWORD, secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/login',
      payload: new URLSearchParams({ password: PASSWORD }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const header = login.headers['set-cookie'];
    cookie = Array.isArray(header) ? header[0]! : String(header);
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (url: string, fields: Record<string, string | string[]>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      for (const one of Array.isArray(value) ? value : [value]) params.append(key, one);
    }
    return app.inject({
      method: 'POST',
      url,
      payload: params.toString(),
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    });
  };

  const seedReel = () => {
    const siteId = upsertSite(
      { name: 'a', domain: 'a.com', status: 'active', pin_username: '', project_id: '',
        daily_target: 1, interval_minutes: 60 },
      KEY,
    );
    const keywordId = insertKeyword({ seed_keyword: 'soup' });
    const pageId = upsertFbPage({ pageId: '1', name: 'Page', tokenId: insertFbToken('App', 'tok', KEY) });
    const reelId = createReel({ runId: null, siteId, keywordId, fbPageId: pageId, prompt: '',
      caption: 'c', references: [], stage: 'filming' });
    setReelStage(reelId, 'filming', { format: 'reveal' });
    replaceScenes(reelId, [
      { seconds: 10, presenter: false, sources: ['hero'], imagePrompt: '', motionPrompt: 'a pour', line: 'hi' },
      { seconds: 10, presenter: false, sources: ['pin'], imagePrompt: '', motionPrompt: 'steam', line: '' },
    ]);
    const [first, second] = listScenes(reelId);
    updateScene(first!.id, { status: 'failed', error: 'no credits' });
    updateScene(second!.id, { status: 'done', clipPath: '/tmp/none.mp4' });
    return { reelId, failedSceneId: first!.id };
  };

  it('shows the reel style page under Setup, with every shape on by default', async () => {
    const body = (await get('/settings/reels')).body;
    expect(body).toMatch(/name="reel_mode" value="single"\s+checked/);
    expect(body).toContain('name="reel_length_seconds"');
    expect((body.match(/name="reel_formats" value="[a-z-]+"\s+checked/g) ?? []).length).toBe(13);
  });

  it('saves the shapes that are ticked, and refuses none', async () => {
    await post('/settings/reels', {
      reel_mode: 'scenes', reel_single_references: ['hero', 'stepA'],
      reel_length_seconds: '45', reel_formats: ['reveal', 'myth'], reel_cta_text: 'Recipe below',
    });
    expect(settings.get('reel_mode')).toBe('scenes');
    expect(JSON.parse(settings.get('reel_single_references'))).toEqual(['hero', 'stepA']);
    expect(JSON.parse(settings.get('reel_formats'))).toEqual(['reveal', 'myth']);
    expect(settings.getNumber('reel_length_seconds')).toBe(45);
    expect(settings.get('reel_cta_text')).toBe('Recipe below');

    const refused = await post('/settings/reels', {
      reel_mode: 'scenes', reel_single_references: 'hero', reel_length_seconds: '45', reel_cta_text: 'x',
    });
    expect(String(refused.headers.location)).toMatch(/error=/);

    const tooMany = await post('/settings/reels', {
      reel_mode: 'single', reel_single_references: ['hero', 'stepA', 'stepB', 'stepC'],
      reel_length_seconds: '30', reel_formats: ['reveal'], reel_cta_text: 'x',
    });
    expect(decodeURIComponent(String(tooMany.headers.location))).toMatch(/at most 3/);
  });

  it('saves each music box on its own, dropping lines that are not a link, and renders every box back', async () => {
    await post('/settings/reels', {
      reel_mode: 'mixed', reel_single_references: ['hero'], reel_length_seconds: '30',
      reel_formats: ['reveal'], reel_cta_text: 'x',
      reel_music_urls: 'https://a/1.mp3\nnot a link\nhttps://a/2.mp3',
      reel_music_urls_2: 'https://a/3.mp3',
      reel_music_urls_6: 'https://a/last.mp3',
    });
    expect(settings.get('reel_music_urls')).toBe('https://a/1.mp3\nhttps://a/2.mp3');
    expect(settings.get('reel_music_urls_2')).toBe('https://a/3.mp3');
    expect(settings.get('reel_music_urls_3')).toBe('');
    expect(settings.get('reel_music_urls_6')).toBe('https://a/last.mp3');

    const body = (await get('/settings/reels')).body;
    expect(body).toContain('https://a/1.mp3');
    expect(body).toContain('https://a/3.mp3');
    expect(body).toContain('https://a/last.mp3');
    expect(body).toContain('Box 1');
    expect(body).toContain('Box 6');
    expect(body).not.toContain('not a link');
  });

  it('uploads a song from disk into the box it was aimed at, and keeps it on save', async () => {
    const boundary = '----musicuploadtest';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="song.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
    );
    const body = Buffer.concat([head, Buffer.from('fake mp3 bytes'), Buffer.from(`\r\n--${boundary}--\r\n`)]);

    const res = await app.inject({
      method: 'POST',
      url: '/settings/reels/music/upload?slot=3',
      payload: body,
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(String(res.headers.location)).toMatch(/ok=/);
    expect(settings.get('reel_music_urls_3')).toMatch(/^local:[\w-]+\.mp3$/);

    const page = (await get('/settings/reels')).body;
    expect(page).toMatch(/local:[\w-]+\.mp3/);

    // Saving the form again (as the textarea posts it back) keeps the upload.
    const savedLine = settings.get('reel_music_urls_3');
    await post('/settings/reels', {
      reel_mode: 'mixed', reel_single_references: ['hero'], reel_length_seconds: '30',
      reel_formats: ['reveal'], reel_cta_text: 'x',
      reel_music_urls_3: savedLine,
    });
    expect(settings.get('reel_music_urls_3')).toBe(savedLine);
  });

  it('refuses an upload that is not an audio file', async () => {
    const boundary = '----musicuploadtest2';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\n`,
    );
    const body = Buffer.concat([head, Buffer.from('hello'), Buffer.from(`\r\n--${boundary}--\r\n`)]);

    const res = await app.inject({
      method: 'POST',
      url: '/settings/reels/music/upload?slot=1',
      payload: body,
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(String(res.headers.location)).toMatch(/error=/);
    expect(settings.get('reel_music_urls')).toBe('');
  });

  it('accepts the hands-only mode, a one-shot reel like single but written hands-only', async () => {
    await post('/settings/reels', {
      reel_mode: 'hands', reel_single_references: ['hero', 'stepB'],
      reel_length_seconds: '30', reel_formats: ['reveal'], reel_cta_text: 'x',
    });
    expect(settings.get('reel_mode')).toBe('hands');

    const body = (await get('/settings/reels')).body;
    expect(body).toMatch(/name="reel_mode" value="hands"\s+checked/);
  });


  it('renders the storyboard: one card per scene with its state and a retry on the failed one', async () => {
    const { reelId } = seedReel();
    const body = (await get(`/reels/${reelId}`)).body;
    expect(body).toContain('Scene 1');
    expect(body).toContain('Scene 2');
    expect(body).toContain('no credits');
    expect(body).toContain('Retry this scene');
    expect(body).toContain('Reveal');
  });

  it('offers Publish on the reel page once it is ready', async () => {
    const { reelId } = seedReel();
    setReelStage(reelId, 'done', { outputPath: '/tmp/none.mp4' });
    updateReel(reelId, { status: 'ready' });
    const body = (await get(`/reels/${reelId}`)).body;
    expect(body).toContain(`action="/reels/${reelId}/publish"`);
  });

  it('lets a ready reel with no page be published to a page picked on the spot', async () => {
    const { reelId } = seedReel();
    updateReel(reelId, { status: 'ready', fbPageId: null });
    setReelStage(reelId, 'done', { outputPath: '/tmp/none.mp4' });

    const body = (await get('/reels')).body;
    expect(body).toContain('name="page_id"');
    expect(body).toContain('>Page</option>');

    expect(getReel(reelId)!.fb_page_id).toBeNull();
    // The publish itself reaches for Facebook and fails here; what matters is
    // the page was remembered on the reel.
    await post(`/reels/${reelId}/publish`, { page_id: String(listFbPages()[0]!.id) });
    expect(getReel(reelId)!.fb_page_id).toBe(listFbPages()[0]!.id);
  });

  it('retries one scene without touching the others', async () => {
    const { reelId, failedSceneId } = seedReel();
    const response = await post(`/reels/${reelId}/scenes/${failedSceneId}/retry`, {});
    expect(response.statusCode).toBe(303);
    expect(listScenes(reelId).map((s) => s.status)).toEqual(['pending', 'done']);
    expect(getReel(reelId)).toMatchObject({ status: 'generating', stage: 'filming' });
  });

  it('retries a failed studio reel at the stage it was in, not as a one-shot video', async () => {
    const { reelId } = seedReel();
    updateReel(reelId, { status: 'failed', error: 'no credits' });

    const response = await post(`/reels/${reelId}/retry`, {});
    expect(response.statusCode).toBe(303);
    expect(String(response.headers.location)).not.toMatch(/error=/);
    expect(getReel(reelId)).toMatchObject({ status: 'generating', stage: 'filming', error: null });
    expect(listScenes(reelId).map((s) => s.status)).toEqual(['pending', 'done']);
  });

  it('lists Reels as a Setup tab and keeps Presenters out of the tabs but reachable', async () => {
    const body = (await get('/settings')).body;
    expect(body).toContain('href="/settings/reels"');
    expect(body).not.toContain('href="/settings/presenters"');
    expect((await get('/settings/presenters')).statusCode).toBe(200);
  });
});
