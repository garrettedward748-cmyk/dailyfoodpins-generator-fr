import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { createRun, getKeyword, getRun, getSite, insertKeyword, listSteps, setLink, upsertSite } from '../src/db/repos.js';
import { upsertEndpoint } from '../src/llm/pool.js';
import { Settings } from '../src/settings.js';
import { configurePrompts } from '../src/pipeline/prompts.js';
import { executePipeline } from '../src/pipeline/index.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { setLogLevel } from '../src/lib/logger.js';
import { brandName, isSocialOnly, siteAssetUrl, siteKey, sitePostUrl, socialHandle } from '../src/core/social-only.js';
import { cleanupMedia, configureMediaStore, isMediaName, saveMediaImage } from '../src/integrations/media-store.js';
import { siteApiFor, SocialOnlySiteApi } from '../src/integrations/site-api-for.js';
import { SiteApiClient } from '../src/integrations/site-api.js';
import { reelCta } from '../src/reels/cta.js';
import { facebookPost } from '../src/reels/recipe-text.js';
import { instagramLink } from '../src/core/instagram-link.js';
import { referenceUrls } from '../src/reels/compose.js';
import { youtubeDescription } from '../src/reels/engine.js';
import { buildWorld, writeFakePrompts } from './helpers/pipeline-world.js';

const KEY = randomBytes(32);

describe('social-only accounts: what makes one', () => {
  it('is a site whose domain has no dot', () => {
    expect(isSocialOnly({ domain: 'arbmom-social' })).toBe(true);
    expect(isSocialOnly({ domain: 'arbmom.com' })).toBe(false);
    expect(isSocialOnly({ domain: 'https://www.arbmom.com/' })).toBe(false);
  });

  it('takes its handle from the name when the domain is left blank', () => {
    expect(siteKey('Arbmom Social', '')).toBe('arbmom-social');
    expect(siteKey('Arbmom Social', '  ')).toBe('arbmom-social');
    expect(siteKey('Anything', 'https://www.Example.com/x')).toBe('example.com');
    expect(socialHandle('Crème Brûlée Club!')).toBe('creme-brulee-club');
  });

  it('refuses a blank domain with a name that gives no handle', () => {
    expect(() => siteKey('!!!', '')).toThrow(/name/);
  });

  it('builds no link for its posts, and passes full image urls through', () => {
    const social = { domain: 'arbmom-social', name: 'Arbmom Social' };
    expect(sitePostUrl(social, '/r/x')).toBe('');
    expect(sitePostUrl({ domain: 'arbmom.com' }, '/r/x')).toBe('https://arbmom.com/r/x');
    expect(siteAssetUrl(social, 'https://p.test/media/a.jpg')).toBe('https://p.test/media/a.jpg');
    expect(siteAssetUrl({ domain: 'arbmom.com' }, '/uploads/a.jpg')).toBe('https://arbmom.com/uploads/a.jpg');
    expect(brandName(social)).toBe('Arbmom Social');
    expect(brandName({ domain: 'https://arbmom.com/' })).toBe('arbmom.com');
  });
});

describe('social-only accounts: captions without a link', () => {
  it('drops {domain} from the reel call to action', () => {
    expect(reelCta('La recette complète : {domain}', 'arbmom-social')).toBe('La recette complète');
    expect(reelCta('La recette complète : {domain}', 'arbmom.com')).toBe('La recette complète : arbmom.com');
  });

  it('never promises a link by message when there is none', () => {
    const post = facebookPost({ body: 'Hello', recipe: '', postUrl: '', link: 'keyword', keyword: 'yum' });
    expect(post.text).toBe('Hello');
    expect(post.firstComment).toBeUndefined();
    const comment = facebookPost({ body: 'Hello', recipe: '', postUrl: '', link: 'comment' });
    expect(comment.firstComment).toBeUndefined();
  });

  it('writes no Instagram link line without a link', () => {
    const settings = { get: (k: string) => (k === 'ig_link_mode' ? 'bio' : '') };
    expect(instagramLink(settings as never, '').line).toBe('');
    expect(instagramLink(settings as never, 'https://a.com/r').line).toMatch(/bio/);
  });

  it('leaves the "More recipes" line off a YouTube description', () => {
    const text = youtubeDescription('T', 'Caption', '', 'arbmom-social');
    expect(text).not.toMatch(/https:\/\//);
  });

  it('keeps platform-hosted reel references as they are', () => {
    const images = { hero: 'https://p.test/media/h.jpg', stepA: '/uploads/a.jpg', stepB: '', stepC: '' };
    expect(referenceUrls('arbmom.com', images, ['hero', 'stepA'])).toEqual([
      'https://p.test/media/h.jpg',
      'https://arbmom.com/uploads/a.jpg',
    ]);
  });
});

describe('social-only accounts: media kept on the platform', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'media-'));
    configureMediaStore({ dir, publicUrl: () => 'https://platform.test/', keepDays: () => 7 });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('re-encodes a picture as JPEG and serves it from the public address', async () => {
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#c33' } }).png().toBuffer();
    const saved = await saveMediaImage(png, 'image/png');
    expect(saved.name).toMatch(/\.jpg$/);
    expect(isMediaName(saved.name)).toBe(true);
    expect(saved.url).toBe(`https://platform.test/media/${saved.name}`);
    expect(existsSync(join(dir, saved.name))).toBe(true);
  });

  it('keeps a picture it cannot read exactly as it came', async () => {
    const saved = await saveMediaImage(Buffer.from([1, 2, 3]), 'image/webp');
    expect(saved.name).toMatch(/\.webp$/);
  });

  it('refuses to store anything without a public address, naming the setting', async () => {
    configureMediaStore({ publicUrl: () => '' });
    await expect(saveMediaImage(Buffer.from([1]), 'image/webp')).rejects.toThrow(/Public address/);
  });

  it('removes files older than the keep period and nothing else', () => {
    const old = join(dir, 'img-old.jpg');
    const fresh = join(dir, 'img-fresh.jpg');
    const foreign = join(dir, 'notes.txt');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'y');
    writeFileSync(foreign, 'z');
    const eightDaysAgo = (Date.now() - 8 * 86_400_000) / 1000;
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    utimesSync(foreign, eightDaysAgo, eightDaysAgo);

    const result = cleanupMedia();
    expect(result.removed).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(['img-fresh.jpg', 'notes.txt']);
  });

  it('only accepts names the store writes', () => {
    expect(isMediaName('img-abc.jpg')).toBe(true);
    expect(isMediaName('../secret.jpg')).toBe(false);
    expect(isMediaName('platform.db')).toBe(false);
  });

  it('gives a social-only account the stand-in and a site its own API', async () => {
    expect(siteApiFor({ domain: 'arbmom-social' }, '')).toBeInstanceOf(SocialOnlySiteApi);
    const real = siteApiFor({ domain: 'arbmom.com' }, 't');
    expect(real).toBeInstanceOf(SiteApiClient);
    expect(real).not.toBeInstanceOf(SocialOnlySiteApi);

    const api = new SocialOnlySiteApi('arbmom-social');
    expect((await api.getCategories()).length).toBeGreaterThan(5);
    expect(await api.getContent()).toEqual([]);
    await expect(api.postRecipe()).rejects.toThrow(/no website/);
    const uploaded = await api.uploadImage(Buffer.from([1, 2, 3]), 'x.webp', 'image/webp');
    expect(uploaded.url).toMatch(/^https:\/\/platform\.test\/media\//);
    expect(api.absoluteUrl(uploaded.url)).toBe(uploaded.url);
  });
});

describe('social-only accounts: a run end to end', () => {
  const PROMPT_DIR = './data/test-prompts-social';
  let dir: string;
  let settings: Settings;
  let siteId: number;
  let keywordId: number;

  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    writeFakePrompts(PROMPT_DIR);
    configurePrompts(PROMPT_DIR);
    dir = mkdtempSync(join(tmpdir(), 'media-'));
    configureMediaStore({ dir, publicUrl: () => 'https://platform.test', keepDays: () => 7 });

    settings = new Settings(KEY);
    settings.set('image_api_key', 'image-key');
    settings.set('image_base_url', 'https://imggen.test');
    settings.set('image_poll_interval_seconds', '0');
    settings.set('image_gap_seconds', '0');
    settings.set('image_poll_max_attempts', '5');
    settings.set('buffer_enabled', 'true');
    settings.set('telegram_enabled', 'false');

    upsertEndpoint({ name: 'ollama-a', baseUrl: 'http://a:11434', apiKey: '', models: [], enabled: true }, KEY);

    siteId = upsertSite(
      {
        name: 'Arbmom Social',
        domain: siteKey('Arbmom Social', ''),
        status: 'active',
        pin_username: 'testsite',
        writing_style: 'us' as const,
        project_id: 'p1',
        daily_target: 5,
        interval_minutes: 0,
        bufferToken: 'buffer-token',
      },
      KEY,
    );
    keywordId = insertKeyword({ seed_keyword: 'chicken breast', spy_title: 'Test Chicken' });
    setLink(keywordId, siteId, 'go');
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the recipe, skips the article, and pins without a link', async () => {
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);

    const runId = createRun(keywordId, siteId);
    const outcome = await executePipeline(
      new PipelineContext({ runId, site: getSite(siteId)!, keyword: getKeyword(keywordId)!, settings, encryptionKey: KEY }),
    );

    expect(outcome.status).toBe('published');
    expect(outcome.postUrl ?? '').toBe('');
    expect(getRun(runId)?.status).toBe('published');

    // Nothing went to a website: no upload, no article post, not even a request to one.
    expect(world.calls.some((u) => u.includes('/api/upload') || u.includes('/api/recipe') || u.includes('/api/categories'))).toBe(false);
    expect(world.promptCalls['part-1'] ?? 0).toBe(0);
    expect(world.promptCalls['recipe-generator'] ?? 0).toBeGreaterThan(0);

    const steps = listSteps(runId).map((s) => s.step);
    expect(steps).toContain('post-article');
    expect(steps).not.toContain('generate-article');
    expect(steps).toContain('publish-to-buffer');

    // The pin went to Buffer with the platform's picture and no link.
    const pinCall = world.fetchStub.mock.calls.find(
      ([url, init]) => String(url).includes('api.buffer.com') && String(init?.body ?? '').includes('CreatePost'),
    );
    const body = String(pinCall?.[1]?.body ?? '');
    expect(body).toContain('https://platform.test/media/');
    expect(body).not.toMatch(/url: \\?"https:\/\/arbmom/);
    expect(body).not.toMatch(/\burl: \\?""/);

    // The pictures are on the platform.
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  });
});
