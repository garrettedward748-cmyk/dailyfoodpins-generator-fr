import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run as dbRun } from '../src/db/index.js';
import {
  createRun,
  getKeyword,
  getRun,
  getSite,
  insertKeyword,
  listSteps,
  markRunPublished,
  setLink,
  upsertSite,
  getLinksForKeyword,
  getCompletedStep,
} from '../src/db/repos.js';
import { upsertEndpoint } from '../src/llm/pool.js';
import { Settings } from '../src/settings.js';
import { configurePrompts } from '../src/pipeline/prompts.js';
import { executePipeline, isPayloadRejection } from '../src/pipeline/index.js';
import { postRetry } from '../src/pipeline/steps/article.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { setLogLevel } from '../src/lib/logger.js';
import { buildWorld, writeFakePrompts } from './helpers/pipeline-world.js';

const KEY = randomBytes(32);

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

const PROMPT_DIR = './data/test-prompts';

/**
 * Reopen a closed run, the way resumeRun does before it re-enters the
 * pipeline. Without it the run is still `failed`, and publishing refuses to
 * post on behalf of a run that is not the live one.
 */
const reopen = (runId: number): void => {
  dbRun("UPDATE runs SET status = 'running', error = NULL, failed_step = NULL WHERE id = ?", runId);
};

describe('pipeline end to end', () => {
  let settings: Settings;
  let siteId: number;
  let keywordId: number;

  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    writeFakePrompts(PROMPT_DIR);
    configurePrompts(PROMPT_DIR);

    settings = new Settings(KEY);
    settings.set('image_api_key', 'image-key');
    settings.set('image_base_url', 'https://imggen.test');
    settings.set('image_poll_interval_seconds', '0');
    settings.set('image_gap_seconds', '0');
    settings.set('image_poll_max_attempts', '5');
    settings.set('buffer_enabled', 'true');
    settings.set('telegram_enabled', 'false');

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
        project_id: 'p1',
        daily_target: 5,
        interval_minutes: 0,
        apiToken: 'test-token',
        bufferToken: 'buffer-token',
      },
      KEY,
    );

    keywordId = insertKeyword({ seed_keyword: 'chicken breast', spy_title: 'Test Chicken' });
    setLink(keywordId, siteId, 'go');
  });

  beforeEach(() => {
    // The post step's real backoff is two then four seconds; nothing here is
    // testing the wait.
    postRetry.baseMs = 0;
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });

  const makeContext = (runId: number): PipelineContext =>
    new PipelineContext({
      runId,
      site: getSite(siteId)!,
      keyword: getKeyword(keywordId)!,
      settings,
      encryptionKey: KEY,
    });

  it('publishes successfully through every stage', async () => {
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);

    const runId = createRun(keywordId, siteId);
    const outcome = await executePipeline(makeContext(runId));

    expect(outcome.status).toBe('published');
    expect(outcome.postId).toBe('recipe-1');
    expect(outcome.postUrl).toBe('https://testsite.com/r/test-chicken');

    const run = getRun(runId);
    expect(run?.status).toBe('published');
    expect(run?.published_at).not.toBeNull();

    const steps = listSteps(runId);
    expect(steps.every((s) => s.status === 'ok')).toBe(true);
    expect(steps.map((s) => s.step)).toContain('publish-to-buffer');
  });

  it('marks the keyword done for that site after publishing', async () => {
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    await executePipeline(makeContext(createRun(keywordId, siteId)));

    expect(getLinksForKeyword(keywordId)[0]?.status).toBe('done');
    // No site is still 'go', so the keyword closes globally too.
    expect(getKeyword(keywordId)?.status).toBe('done');
  });

  // -- The duplicate gate ---------------------------------------------------
  //
  // Three runs of one keyword went through in half an hour while the panel
  // was unreachable. Each warned that the title was already on the site at
  // 100%, and each published. Four copies of one article on the front page.

  it('skips a keyword whose dish is already on the site, before writing anything', async () => {
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);

    const earlier = createRun(keywordId, siteId);
    markRunPublished(earlier, 'recipe-0', 'https://testsite.com/r/test-chicken', 'Test Chicken');

    const runId = createRun(keywordId, siteId);
    const outcome = await executePipeline(makeContext(runId));

    expect(outcome.status).toBe('duplicate');
    expect(outcome.error).toMatch(/already on the site/);
    // Skipped, not failed: it must not count among the day's failures.
    expect(getRun(runId)?.status).toBe('cancelled');
    // Nothing was spent: no model call, no image, no post.
    expect(world.calls.some((u) => u.includes('/api/chat') || u.includes('/v1/generate') || u.includes('/api/publish'))).toBe(false);
  });

  it('holds a run whose written title is already on the site, instead of publishing it twice', async () => {
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);
    // The keyword reads differently; the article the model writes does not.
    dbRun("UPDATE keywords SET spy_title = 'Oven Dinner Idea' WHERE id = ?", keywordId);

    const earlier = createRun(keywordId, siteId);
    markRunPublished(earlier, 'recipe-0', 'https://testsite.com/r/test-chicken', 'Test Chicken');

    const runId = createRun(keywordId, siteId);
    const outcome = await executePipeline(makeContext(runId));

    expect(outcome.status).toBe('held');
    expect(outcome.hold).toBe('awaiting');
    expect(world.calls.some((u) => u.includes('/recipes') && !u.includes('categories'))).toBe(false);
    expect(getRun(runId)?.hold).toBe('awaiting');
  });

  it('makes no pin at all when the site has Pinterest posts off', async () => {
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);
    dbRun('UPDATE sites SET pin_posts = 0 WHERE id = ?', siteId);
    const runId = createRun(keywordId, siteId);
    const outcome = await executePipeline(makeContext(runId));
    expect(outcome.status).toBe('published');
    const { all } = await import('../src/db/index.js');
    const steps = all<{ step: string }>('SELECT step FROM run_steps WHERE run_id = ?', runId).map((r) => r.step);
    expect(steps).not.toContain('generate-pin-image');
    expect(steps).not.toContain('publish-to-buffer');
  });

  it('still publishes a near-duplicate, with a warning, as it always did', async () => {
    // "Easy Baked Chicken" vs "Test Chicken" share a word but are not the same
    // title. The similarity score is a heuristic; it warns and does not gate.
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);

    const earlier = createRun(keywordId, siteId);
    markRunPublished(earlier, 'recipe-0', 'https://testsite.com/r/other', 'Chicken Test Dinner');

    const outcome = await executePipeline(makeContext(createRun(keywordId, siteId)));

    expect(outcome.status).toBe('published');
  });

  it('publishes an identical title once a person has approved it', async () => {
    // Approve is a resume with `approved` set. The hold must not re-apply on
    // the way back through, or approving publishes nothing.
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    dbRun("UPDATE keywords SET spy_title = 'Oven Dinner Idea' WHERE id = ?", keywordId);

    const earlier = createRun(keywordId, siteId);
    markRunPublished(earlier, 'recipe-0', 'https://testsite.com/r/test-chicken', 'Test Chicken');

    const runId = createRun(keywordId, siteId);
    const ctx = makeContext(runId);
    ctx.approved = true;
    const outcome = await executePipeline(ctx);

    expect(outcome.status).toBe('published');
  });

  // -- When the site will not take the article -------------------------------
  //
  // longlivo.com answered a post with HTTP 400 and a validation body naming
  // recipeInfo.servings: "4 medium pizzas" is not a yield phrase. The repair
  // prompt at the time forbade changing values, so three attempts sent the
  // same document, and a resume reused the stored article and sent it again.

  it('rewrites the article when the site rejects it and repair does not help', async () => {
    // Every post of the first article is refused; the rewrite is accepted.
    const world = buildWorld({ rejectPayloadTimes: 3 });
    vi.stubGlobal('fetch', world.fetchStub);

    const outcome = await executePipeline(makeContext(createRun(keywordId, siteId)));

    expect(outcome.status).toBe('published');
    // Repair was asked after the first two refusals, as before...
    expect(world.promptCalls['repair-json']).toBe(2);
    // ...and when that was not enough, the article was written a second time.
    expect(world.promptCalls['part-1']).toBe(2);
    expect(world.postAttempts()).toBe(4);
  });

  it('leaves no article checkpoint when the rewrite is refused too, so a resume writes a third', async () => {
    const world = buildWorld({ rejectPayloadTimes: 99 });
    vi.stubGlobal('fetch', world.fetchStub);

    const runId = createRun(keywordId, siteId);
    const outcome = await executePipeline(makeContext(runId));

    expect(outcome.status).toBe('failed');
    expect(outcome.failedStep).toBe('post-article');
    // Two articles were written, and neither is stored as good: resuming this
    // run must not hand the second one back as "already completed".
    expect(world.promptCalls['part-1']).toBe(2);
    expect(getCompletedStep(runId, 'generate-article')).toBeUndefined();
  });

  it('does not rewrite the article for a bad token', async () => {
    // A 401 is about us, not the document. A different article fails the same
    // way, and writing one would spend the model on nothing.
    const world = buildWorld({ postStatus: 401 });
    vi.stubGlobal('fetch', world.fetchStub);

    const outcome = await executePipeline(makeContext(createRun(keywordId, siteId)));

    expect(outcome.status).toBe('failed');
    expect(world.promptCalls['part-1']).toBe(1);
  });

  it('tells a payload rejection apart from every other way a post fails', () => {
    const refused = 'Publishing to longlivo.com failed after 3 attempts. Last error: ' +
      'POST /api/recipe rejected by longlivo.com: HTTP 400 — {"error":"Recipe payload validation failed"}';
    expect(isPayloadRejection(refused)).toBe(true);
    expect(isPayloadRejection('POST /api/recipe rejected by x.com: HTTP 422 — unprocessable')).toBe(true);

    expect(isPayloadRejection('POST /api/recipe rejected by x.com: HTTP 401 — Unauthorized')).toBe(false);
    expect(isPayloadRejection('POST /api/recipe rejected by x.com: HTTP 503 — down')).toBe(false);
    expect(isPayloadRejection('fetch failed: ETIMEDOUT')).toBe(false);
  });

  it('treats a database insert failure as a payload rejection too, but not a bare 500', () => {
    // arbmom.com's own words for a slug/title collision: the row is refused,
    // not accepted-then-broken. A different article gets a different slug.
    const insertFailed = 'Publishing to arbmom.com failed after 3 attempts. Last error: ' +
      'POST /api/recipe rejected by arbmom.com: HTTP 500 (the site itself returned an error) — ' +
      '{"error":"insert_failed","detail":null}';
    expect(isPayloadRejection(insertFailed)).toBe(true);

    // A 500 that is not this specific shape is left alone -- rewriting the
    // article would not bring a down site back.
    expect(isPayloadRejection('POST /api/recipe rejected by x.com: HTTP 500 — Internal Server Error')).toBe(false);
  });

  it('generates four article images plus the Pinterest graphic', async () => {
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);
    await executePipeline(makeContext(createRun(keywordId, siteId)));

    const generates = world.calls.filter((u) => u.includes('/v1/generate'));
    expect(generates).toHaveLength(5);
  });

  it('polls a pending image job until it completes', async () => {
    const world = buildWorld({ imagePendingPolls: 2 });
    vi.stubGlobal('fetch', world.fetchStub);

    const outcome = await executePipeline(makeContext(createRun(keywordId, siteId)));
    expect(outcome.status).toBe('published');
  });

  // -- The second infinite loop, now bounded --------------------------------
  it('REGRESSION: a FAILED image job fails the step instead of polling forever', async () => {
    vi.stubGlobal('fetch', buildWorld({ failImageJobs: true }).fetchStub);

    const runId = createRun(keywordId, siteId);
    const outcome = await executePipeline(makeContext(runId));

    expect(outcome.status).toBe('failed');
    expect(outcome.failedStep).toBe('generate-image-hero');
    expect(outcome.error).toContain('GPU unavailable');
    expect(getRun(runId)?.status).toBe('failed');
  });

  // -- Each image is its own checkpoint -------------------------------------
  // The four article images used to be one step, so a failure at the third
  // threw away the first two: a resume regenerated all four, and the images
  // and the wait were paid twice. Now the run says which image it is on, and
  // a resume asks Google only for the ones it does not have.
  it('names the image that failed and keeps the ones before it', async () => {
    vi.stubGlobal('fetch', buildWorld({ failImageAfter: 2 }).fetchStub);

    const runId = createRun(keywordId, siteId);
    const outcome = await executePipeline(makeContext(runId));

    expect(outcome.status).toBe('failed');
    expect(outcome.failedStep).toBe('generate-image-step-b');

    const byName = Object.fromEntries(listSteps(runId).map((s) => [s.step, s.status]));
    expect(byName['generate-image-hero']).toBe('ok');
    expect(byName['generate-image-step-a']).toBe('ok');
    expect(byName['generate-image-step-b']).toBe('failed');
    expect(byName['generate-image-step-c']).toBeUndefined();
  });

  it('resumes by generating only the images that are missing', async () => {
    vi.stubGlobal('fetch', buildWorld({ failImageAfter: 2 }).fetchStub);
    const runId = createRun(keywordId, siteId);
    await executePipeline(makeContext(runId));

    const second = buildWorld();
    vi.stubGlobal('fetch', second.fetchStub);
    reopen(runId);
    const outcome = await executePipeline(makeContext(runId));

    expect(outcome.status).toBe('published');
    // Two article images still owed, plus the Pinterest graphic. Not five.
    const generates = second.calls.filter((u) => u.includes('/v1/generate'));
    expect(generates).toHaveLength(3);
  });

  it('repairs and retries when the site rejects the article JSON', async () => {
    const world = buildWorld({ failPostOnce: true });
    vi.stubGlobal('fetch', world.fetchStub);

    const outcome = await executePipeline(makeContext(createRun(keywordId, siteId)));
    expect(outcome.status).toBe('published');
    expect(world.postAttempts()).toBe(2);
  });

  // -- Checkpointing --------------------------------------------------------
  it('resumes from the failed step without repeating completed work', async () => {
    vi.stubGlobal('fetch', buildWorld({ failImageJobs: true }).fetchStub);

    const runId = createRun(keywordId, siteId);
    const first = await executePipeline(makeContext(runId));
    expect(first.status).toBe('failed');

    const completedFirstTime = listSteps(runId).filter((s) => s.status === 'ok').length;
    expect(completedFirstTime).toBeGreaterThan(0);

    // The image service recovers; re-running must not redo the LLM calls.
    const second = buildWorld();
    vi.stubGlobal('fetch', second.fetchStub);

    reopen(runId);
    const outcome = await executePipeline(makeContext(runId));
    expect(outcome.status).toBe('published');

    const chatCalls = second.calls.filter((u) => u.includes('/api/chat'));
    // Only the article, pin description and board prompts remain — the spy,
    // recipe and image-prompt calls were restored from checkpoints.
    expect(chatCalls.length).toBeLessThan(8);
    expect(second.calls.some((u) => u.includes('/api/categories'))).toBe(false);
  });

  it('records which endpoint served each LLM step', async () => {
    vi.stubGlobal('fetch', buildWorld().fetchStub);
    const runId = createRun(keywordId, siteId);
    await executePipeline(makeContext(runId));

    const step = listSteps(runId).find((s) => s.step === 'validate-spy');
    expect(step?.endpoint).toBe('ollama-a');
  });

  it('fails the run with a clear message when no LLM endpoint works', async () => {
    vi.stubGlobal('fetch', buildWorld({ failEndpoint: 'a' }).fetchStub);

    const outcome = await executePipeline(makeContext(createRun(keywordId, siteId)));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('ollama-a');
  });

  it('stays published when the pin cannot be scheduled, and still notifies', async () => {
    // A site with no Buffer account is a setting nobody filled in, not a
    // broken run. Failing here overwrote a published run with "failed" and
    // skipped everything behind it, while the article sat live on the site.
    const world = buildWorld({ bufferUnconfigured: true });
    vi.stubGlobal('fetch', world.fetchStub);

    const runId = createRun(keywordId, siteId);
    const outcome = await executePipeline(makeContext(runId));

    expect(outcome.status).toBe('published');
    expect(outcome.postUrl).toBeTruthy();
    expect(getRun(runId)?.status).toBe('published');

    // The steps behind the pin still ran.
    const steps = listSteps(runId).filter((s) => s.status === 'ok').map((s) => s.step);
    expect(steps).toContain('notify');
  });

  it('skips Buffer when it is disabled', async () => {
    settings.set('buffer_enabled', 'false');
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);

    const outcome = await executePipeline(makeContext(createRun(keywordId, siteId)));
    expect(outcome.status).toBe('published');
    expect(world.calls.some((u) => u.includes('api.buffer.com'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * The features working together, not just individually.
 * ---------------------------------------------------------------------- */

describe('a run end to end, with the pieces combined', () => {
  let settings: Settings;
  let siteId: number;
  let otherSiteId: number;
  let keywordId: number;

  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    writeFakePrompts(PROMPT_DIR);
    configurePrompts(PROMPT_DIR);

    settings = new Settings(KEY);
    settings.set('image_api_key', 'image-key');
    settings.set('image_base_url', 'https://imggen.test');
    settings.set('image_poll_interval_seconds', '0');
    settings.set('image_gap_seconds', '0');
    settings.set('image_poll_max_attempts', '5');
    settings.set('buffer_enabled', 'false');
    settings.set('telegram_enabled', 'false');
    settings.set('flow_project_id', 'shared-project');

    upsertEndpoint(
      { name: 'ollama-a', baseUrl: 'http://a:11434', apiKey: '', models: [], enabled: true },
      KEY,
    );

    const base = {
      status: 'active' as const,
      pin_username: 'x',
      daily_target: 5,
      interval_minutes: 0,
      apiToken: 'test-token',
      bufferToken: 'buffer-token',
    };

    siteId = upsertSite(
      { ...base, name: 'first', domain: 'first.com', project_id: 'site-own-project' },
      KEY,
    );
    otherSiteId = upsertSite(
      { ...base, name: 'second', domain: 'second.com', project_id: '' },
      KEY,
    );

    keywordId = insertKeyword({ seed_keyword: 'chicken breast', spy_title: 'Test Chicken' });
    setLink(keywordId, siteId, 'go');
    setLink(keywordId, otherSiteId, 'go');
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });

  const contextFor = (site: number, share: boolean): PipelineContext =>
    new PipelineContext({
      runId: createRun(keywordId, site),
      site: getSite(site)!,
      keyword: getKeyword(keywordId)!,
      settings,
      encryptionKey: KEY,
      shareImages: share,
    });

  it("sends the site's own project id to the image service", async () => {
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);

    await executePipeline(contextFor(siteId, false));

    expect(world.generateBodies).not.toHaveLength(0);
    for (const body of world.generateBodies) {
      expect(body.project_id).toBe('site-own-project');
    }
  });

  it('falls back to the shared project for a site without one', async () => {
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);

    await executePipeline(contextFor(otherSiteId, false));

    expect(world.generateBodies.every((b) => b.project_id === 'shared-project')).toBe(true);
  });

  it('uses a placeholder rather than refusing when no project is set anywhere', async () => {
    settings.set('flow_project_id', '');
    const world = buildWorld();
    vi.stubGlobal('fetch', world.fetchStub);

    const outcome = await executePipeline(contextFor(otherSiteId, false));

    // Generating into a placeholder beats not generating at all.
    expect(outcome.status).toBe('published');
    expect(world.generateBodies[0]?.project_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('publishes despite the model returning malformed JSON', async () => {
    // The exact shape that killed run #1: bare keys and trailing commas.
    const world = buildWorld({
      llmOverrides: {
        'recipe-generator': `{
          title: 'Crispy Chicken',
          prep_time: '10 minutes',
          cook_time: '12 minutes',
          total_time: '27 minutes',
          "ingredients": ["chicken", "oil",],
          "instructions": ["Season.", "Roast.",],
        }`,
      },
    });
    vi.stubGlobal('fetch', world.fetchStub);

    const outcome = await executePipeline(contextFor(siteId, false));

    expect(outcome.status).toBe('published');
  });

  it('does not call Google again for a second site sharing the images', async () => {
    const first = buildWorld();
    vi.stubGlobal('fetch', first.fetchStub);
    await executePipeline(contextFor(siteId, true));
    const firstGenerations = first.generateBodies.length;

    const second = buildWorld();
    vi.stubGlobal('fetch', second.fetchStub);
    await executePipeline(contextFor(otherSiteId, true));

    // Five generations the first time: four article images plus the pin.
    expect(firstGenerations).toBe(5);
    // One the second time: only the Pinterest graphic, which stays unique per
    // site. The four article images are copied from first.com's URLs.
    expect(second.generateBodies).toHaveLength(1);
  });

  it('still generates all five for a site with sharing off', async () => {
    const first = buildWorld();
    vi.stubGlobal('fetch', first.fetchStub);
    await executePipeline(contextFor(siteId, true));

    const second = buildWorld();
    vi.stubGlobal('fetch', second.fetchStub);
    await executePipeline(contextFor(otherSiteId, false));

    expect(second.generateBodies).toHaveLength(5);
  });
});
