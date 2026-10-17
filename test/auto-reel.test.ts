import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import {
  createRun,
  updateReel,
  getKeyword,
  getSite,
  insertFbToken,
  insertKeyword,
  insertPresenter,
  listReels,
  listSteps,
  setFbPageOptions,
  setFbPagePresenter,
  setLink,
  upsertFbPage,
  upsertSite,
} from '../src/db/repos.js';
import { upsertEndpoint } from '../src/llm/pool.js';
import { exportDataset } from '../src/db/exports.js';
import { Settings } from '../src/settings.js';
import { configurePrompts } from '../src/pipeline/prompts.js';
import { executePipeline } from '../src/pipeline/index.js';
import { postRetry } from '../src/pipeline/steps/article.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { setLogLevel } from '../src/lib/logger.js';
import { ARTICLE_TITLE, buildWorld, writeFakePrompts } from './helpers/pipeline-world.js';

/**
 * A published article becomes a reel on a page of its site, with nobody
 * asked. The step is the one place that decides a run gets a reel, and it
 * never fails the run: by then the article is live, and a run marked failed
 * after publishing reads as an article that did not go out.
 */

const KEY = randomBytes(32);
const PROMPT_DIR = './data/test-prompts-reel';

describe('the create-reel step', () => {
  let settings: Settings;
  let siteId: number;
  let keywordId: number;

  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    writeFakePrompts(PROMPT_DIR);
    configurePrompts(PROMPT_DIR);
    postRetry.baseMs = 0;

    settings = new Settings(KEY);
    settings.set('image_api_key', 'image-key');
    settings.set('image_base_url', 'https://imggen.test');
    settings.set('image_poll_interval_seconds', '0');
    settings.set('image_gap_seconds', '0');
    settings.set('image_poll_max_attempts', '5');
    settings.set('buffer_enabled', 'false');
    settings.set('telegram_enabled', 'false');
    settings.set('fb_enabled', 'true');

    upsertEndpoint(
      { name: 'ollama-a', baseUrl: 'http://a:11434', apiKey: '', models: [], enabled: true },
      KEY,
    );

    siteId = upsertSite(
      {
        name: 'testsite',
        domain: 'testsite.com',
        status: 'active',
        pin_username: 'testsite',
        writing_style: 'us' as const,
        project_id: 'p1',
        daily_target: 5,
        interval_minutes: 0,
        apiToken: 'test-token',
        bufferToken: '',
      },
      KEY,
    );

    keywordId = insertKeyword({ seed_keyword: 'chicken breast', spy_title: 'Test Chicken' });
    setLink(keywordId, siteId, 'go');
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const makeContext = (runId: number): PipelineContext =>
    new PipelineContext({
      runId,
      site: getSite(siteId)!,
      keyword: getKeyword(keywordId)!,
      settings,
      encryptionKey: KEY,
    });

  const pageForKeyword = (autoPublish = true): number => {
    const token = insertFbToken('A', 'tok', KEY);
    const id = upsertFbPage({ pageId: '77', name: 'Chicken Page', tokenId: token });
    setFbPageOptions(id, { siteId, autoPublish, enabled: true });
    return id;
  };

  const reelStep = (runId: number) => listSteps(runId).find((s) => s.step === 'create-reel');

  it('makes one clip from the prompt, the chosen photos and the page presenter, by default', async () => {
    const pageId = pageForKeyword();
    const presenterId = insertPresenter({ name: 'Rima', flowCharacterId: 'char-1', flowVoiceId: 'voice-1',
      voiceDescription: 'warm', portraitUrl: '' });
    setFbPagePresenter(pageId, presenterId);
    settings.set('reel_single_references', '["hero","stepC"]');
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);
    const runId = createRun(keywordId, siteId);

    const outcome = await executePipeline(makeContext(runId));

    expect(outcome.status).toBe('published');
    const [reel] = listReels();
    expect(reel).toMatchObject({ run_id: runId, fb_page_id: pageId, status: 'generating', stage: 'done' });
    expect(reel!.prompt).toContain('Test Chicken');
    // Filmed on a structure from Setup -> Reel structures, and recorded, so the
    // next reel on this site is filmed on a different one.
    const structureId = (reel as { reel_structure_id?: number | null }).reel_structure_id;
    expect(structureId).toBeTruthy();
    expect(reel!.prompt).toMatch(/SCENE 1 — /);
    expect(reel!.prompt).not.toMatch(/\{\{/);
    expect(world.videoBodies).toHaveLength(1);
    expect(world.videoBodies[0]).toMatchObject({
      reference_urls: [expect.stringMatching(/^https:\/\/testsite\.com\//), expect.stringMatching(/^https:\/\/testsite\.com\//)],
      character_media_id: 'char-1',
      voice_media_id: 'voice-1',
    });
    expect((world.videoBodies[0] as { reference_urls: string[] }).reference_urls).toHaveLength(2);
    expect(reelStep(runId)?.status).toBe('ok');
  });

  it('exports what was made: the article with its images and pin, and the reel with its Facebook link', async () => {
    pageForKeyword();
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);
    const runId = createRun(keywordId, siteId);
    await executePipeline(makeContext(runId));
    const [reel] = listReels();
    updateReel(reel!.id, { status: 'published', fbVideoId: '4242' });

    const articles = exportDataset('articles');
    expect(articles.filename).toBe('articles.csv');
    const article = Object.fromEntries(articles.rows[0]!.map((h, i) => [h, articles.rows[1]![i]]));
    expect(article).toMatchObject({
      run_id: String(runId),
      site: 'testsite.com',
      status: 'published',
      title: expect.stringContaining('Chicken'),
      hero_image: expect.stringMatching(/^https:\/\/testsite\.com\//),
      method_shot_3: expect.stringMatching(/^https:\/\/testsite\.com\//),
    });
    expect(article.post_url).not.toBe('');
    expect(Object.keys(article)).not.toContain('error');

    const reels = exportDataset('reels');
    const row = Object.fromEntries(reels.rows[0]!.map((h, i) => [h, reels.rows[1]![i]]));
    expect(row).toMatchObject({
      site: 'testsite.com',
      fb_page: 'Chicken Page',
      status: 'published',
      mode: 'single',
      scenes: '',
      facebook_url: 'https://www.facebook.com/reel/4242',
    });
    expect(Object.keys(row)).not.toContain('prompt');
  });

  it('queues a reel for planning, with the article and its images, and a written caption', async () => {
    settings.set('reel_mode', 'scenes');
    const pageId = pageForKeyword();
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);
    const runId = createRun(keywordId, siteId);

    const outcome = await executePipeline(makeContext(runId));

    expect(outcome.status).toBe('published');
    const [reel] = listReels();
    expect(reel).toMatchObject({ run_id: runId, fb_page_id: pageId, status: 'generating', stage: 'planning' });
    // The caption is written for the reel, not the article's title repeated.
    // It used to be the title, so every automatic reel went out as its own
    // headline — and nearly every reel is made here rather than by hand.
    expect(reel!.caption).toBe('Hook line!\n\nA cosy stew.');
    expect(reel!.caption).not.toBe(ARTICLE_TITLE);
    // The shape it was written in is recorded, so the rotation can count.
    expect(reel!.caption_structure_id).toBeTruthy();

    const seed = JSON.parse(reel!.plan_json) as { article: { title: string; imagePrompts: Record<string, string> }; sources: Record<string, string> };
    expect(seed.article.title).toBe(ARTICLE_TITLE);
    expect(Object.keys(seed.sources)).toEqual(expect.arrayContaining(['hero', 'stepA', 'stepB', 'stepC', 'pin']));
    expect(seed.sources.hero).toMatch(/^https:\/\/testsite\.com\//);
    // Nothing is filmed inside the run: the engine does that, one scene per pass.
    expect(world.videoBodies).toHaveLength(0);
    expect(reelStep(runId)?.status).toBe('ok');
  });

  it('skips, and the run is still published, when the site has no page', async () => {
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    const runId = createRun(keywordId, siteId);

    expect((await executePipeline(makeContext(runId))).status).toBe('published');

    expect(listReels()).toEqual([]);
    expect(reelStep(runId)?.status).toBe('ok');
    expect(reelStep(runId)?.output_json).toContain('no Facebook page');
  });

  it('makes the reel with no Facebook page when another network takes reels, through Buffer', async () => {
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    run('UPDATE sites SET pin_reels = 1 WHERE id = ?', siteId);
    settings.set('reel_publisher', 'buffer');
    const runId = createRun(keywordId, siteId);

    expect((await executePipeline(makeContext(runId))).status).toBe('published');

    const [reel] = listReels();
    expect(reel).toMatchObject({ run_id: runId, fb_page_id: null });
  });

  it('still makes none for the other networks when reels go straight to Facebook, which only Buffer can send on', async () => {
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    run('UPDATE sites SET pin_reels = 1 WHERE id = ?', siteId);
    const runId = createRun(keywordId, siteId);
    await executePipeline(makeContext(runId));
    expect(listReels()).toEqual([]);
    expect(reelStep(runId)?.output_json).toContain('need Publish reels through Buffer');
  });

  it('does nothing when reels are switched off', async () => {
    settings.set('fb_enabled', 'false');
    pageForKeyword();
    vi.stubGlobal('fetch', buildWorld().fetchStub);

    await executePipeline(makeContext(createRun(keywordId, siteId)));

    expect(listReels()).toEqual([]);
  });

  it('falls back to the title when the caption model answers nothing', async () => {
    pageForKeyword();
    vi.stubGlobal('fetch', buildWorld({ llmOverrides: { 'reel-caption': '' } }).fetchStub);

    await executePipeline(makeContext(createRun(keywordId, siteId)));

    expect(listReels()[0]!.caption).toBe(ARTICLE_TITLE);
  });

  it('a resumed run does not make a second reel', async () => {
    pageForKeyword();
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    const runId = createRun(keywordId, siteId);

    await executePipeline(makeContext(runId));
    await executePipeline(makeContext(runId));

    expect(listReels()).toHaveLength(1);
  });
});
