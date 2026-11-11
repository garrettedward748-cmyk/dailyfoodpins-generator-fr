import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run as dbRun } from '../src/db/index.js';
import {
  createRun,
  getKeyword,
  getRun,
  getSite,
  insertKeyword,
  listImageWaits,
  listSteps,
  loadSiteViews,
  nextImageWait,
  setLink,
  upsertSite,
} from '../src/db/repos.js';
import { upsertEndpoint } from '../src/llm/pool.js';
import { Settings } from '../src/settings.js';
import { configurePrompts } from '../src/pipeline/prompts.js';
import { executePipeline } from '../src/pipeline/index.js';
import { postRetry } from '../src/pipeline/steps/article.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { setLogLevel } from '../src/lib/logger.js';
import { buildWorld, writeFakePrompts } from './helpers/pipeline-world.js';

/**
 * Write first, pictures after: an article is written in full and waits,
 * unpublished, for its pictures; they are made later, between articles, and
 * the article is published then. A picture that fails puts it back in the
 * wait; past the deadline it goes out with the pictures it has.
 */
const KEY = randomBytes(32);
const PROMPT_DIR = './data/test-prompts';

describe('write first, pictures after', () => {
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
    settings.set('buffer_enabled', 'true');
    settings.set('telegram_enabled', 'false');
    upsertEndpoint({ name: 'ollama-a', baseUrl: 'http://a:11434', apiKey: '', models: [], enabled: true }, KEY);
    siteId = upsertSite(
      {
        name: 'testsite', domain: 'testsite.com', status: 'active', pin_username: 'testsite', project_id: 'p1',
        daily_target: 5, interval_minutes: 0, apiToken: 'test-token', bufferToken: 'buffer-token', writing_style: 'us' as const,
      },
      KEY,
    );
    keywordId = insertKeyword({ seed_keyword: 'chicken breast', spy_title: 'Test Chicken' });
    setLink(keywordId, siteId, 'go');
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });

  const ctx = (runId: number, picturesNow = false): PipelineContext =>
    new PipelineContext({
      runId, site: getSite(siteId)!, keyword: getKeyword(keywordId)!, settings, encryptionKey: KEY, picturesNow,
    });
  const reopen = (runId: number): void => {
    dbRun("UPDATE runs SET status = 'running', hold = '', retry_after = NULL, waiting_images = 0 WHERE id = ?", runId);
  };

  it('is on by default', () => {
    expect(new Settings(KEY).getBool('write_first')).toBe(true);
  });

  it('writes the whole article, makes no picture and waits, unpublished', async () => {
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);
    const runId = createRun(keywordId, siteId);

    const outcome = await executePipeline(ctx(runId));
    expect(outcome).toMatchObject({ status: 'held', hold: 'images' });
    expect(world.calls.filter((u) => u.includes('/v1/generate'))).toEqual([]);
    expect(world.calls.some((u) => u.includes('/api/recipe'))).toBe(false);

    const done = Object.fromEntries(listSteps(runId).map((s) => [s.step, s.status]));
    expect(done['generate-recipe']).toBe('ok');
    expect(done['generate-article']).toBe('ok');
    expect(getRun(runId)).toMatchObject({ status: 'cancelled', waiting_images: 1 });
    expect(listImageWaits().map((r) => r.id)).toEqual([runId]);
    // It is the day's article for the site already, so the writing is paced as before.
    expect(loadSiteViews(new Date().toISOString().slice(0, 10), 'UTC')[0]!.publishedToday).toBe(1);
  });

  it('makes the pictures later, without writing again, and publishes', async () => {
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    const runId = createRun(keywordId, siteId);
    await executePipeline(ctx(runId));

    const later = buildWorld();
    vi.stubGlobal('fetch', later.fetchStub);
    reopen(runId);
    const outcome = await executePipeline(ctx(runId, true));

    expect(outcome.status).toBe('published');
    // Four article pictures and the pin graphic; no prompt written twice.
    expect(later.calls.filter((u) => u.includes('/v1/generate'))).toHaveLength(5);
    expect(later.promptCalls['recipe-generator'] ?? 0).toBe(0);
    expect(later.promptCalls['part-1'] ?? 0).toBe(0);
    expect(getRun(runId)?.status).toBe('published');
  });

  it('puts the article back in the wait when a picture fails, to be tried again later', async () => {
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    const runId = createRun(keywordId, siteId);
    await executePipeline(ctx(runId));

    vi.stubGlobal('fetch', buildWorld({ failImageAfter: 1 }).fetchStub);
    reopen(runId);
    const outcome = await executePipeline(ctx(runId, true));

    expect(outcome).toMatchObject({ status: 'held', hold: 'images' });
    const row = getRun(runId)!;
    expect(row).toMatchObject({ status: 'cancelled', waiting_images: 1 });
    expect(row.retry_after).toBeTruthy();
    expect(row.error).toMatch(/Pictures not done yet/);
    expect(nextImageWait()).toBeUndefined(); // not before its retry time
  });

  it('past the deadline, goes out with the pictures it has', async () => {
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    const runId = createRun(keywordId, siteId);
    await executePipeline(ctx(runId));
    dbRun("UPDATE runs SET started_at = datetime('now', '-30 hours') WHERE id = ?", runId);

    vi.stubGlobal('fetch', buildWorld({ failImageAfter: 1 }).fetchStub);
    reopen(runId);
    await executePipeline(ctx(runId, true));
    // On the site with the one picture made (the main one), the others left out.
    const done = Object.fromEntries(listSteps(runId).map((s) => [s.step, s.status]));
    expect(done['post-article']).toBe('ok');
    expect(getRun(runId)?.post_url).toBeTruthy();
  });
});
