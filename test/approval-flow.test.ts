import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run as dbRun } from '../src/db/index.js';
import {
  createRun,
  getRun,
  insertKeyword,
  setLink,
  upsertSite,
  type KeywordRow,
  type SiteRow,
} from '../src/db/repos.js';
import { executePipeline, PipelineContext } from '../src/pipeline/index.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * The gate before anything reaches a live site, exercised end to end.
 *
 * The bug this file exists for: approving is a resume, and by then the site's
 * auto-publish setting has not changed — so the naive implementation held the
 * article a second time and approval published nothing, forever.
 */

const KEY = randomBytes(32);

const site = (over: Partial<SiteRow> = {}): SiteRow =>
  ({
    id: 1,
    name: 'bitespoon',
    domain: 'bitespoon.com',
    status: 'active',
    pin_username: '',
    project_id: 'proj-1',
    paused_reason: '',
    paused_until: null,
    auto_publish: 1,
    api_token_encrypted: '',
    buffer_token_encrypted: '',
    daily_target: 3,
    interval_minutes: 60,
    created_at: '',
    updated_at: '',
    ...over,
  }) as SiteRow;

const keyword = (): KeywordRow =>
  ({
    id: 1,
    seed_keyword: 'chicken soup',
    spy_title: 'Chicken Soup',
    spy_description: '',
    spy_image_url: '',
    spy_article_url: '',
    spy_pin_image: '',
    annotation: '',
    status: 'go',
    created_at: '',
    updated_at: '',
  }) as KeywordRow;

/**
 * Pre-fill every step up to the article, so the pipeline reaches the gate
 * without a network. The engine reuses a completed checkpoint verbatim, which
 * is the same mechanism approval relies on.
 */
function checkpointUpTo(runId: number, article: Record<string, unknown>): void {
  const done: [string, unknown][] = [
    ['fetch-categories', [{ id: 1, name: 'Dinner' }]],
    ['fetch-cuisines', [{ id: 1, title: 'North African' }]],
    ['validate-spy', { title: 'Chicken Soup', slug: 'chicken-soup' }],
    ['generate-recipe', { raw: 'a recipe' }],
    ['generate-image-prompts', { hero: 'a', stepA: 'b', stepB: 'c', stepC: 'd' }],
    ['generate-image-hero', { path: '/1.webp', absolute: 'https://x/1.webp' }],
    ['generate-image-step-a', { path: '/2.webp', absolute: 'https://x/2.webp' }],
    ['generate-image-step-b', { path: '/3.webp', absolute: 'https://x/3.webp' }],
    ['generate-image-step-c', { path: '/4.webp', absolute: 'https://x/4.webp' }],
    [
      'generate-images',
      { hero: '/1.webp', stepA: '/2.webp', stepB: '/3.webp', stepC: '/4.webp' },
    ],
    ['generate-article', article],
  ];

  for (const [step, output] of done) {
    dbRun(
      `INSERT INTO run_steps (run_id, step, status, output_json)
       VALUES (?, ?, 'ok', ?)`,
      runId,
      step,
      JSON.stringify(output),
    );
  }
}

describe('holding an article before it is published', () => {
  let settings: Settings;

  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    settings = new Settings(KEY);
    settings.set('buffer_enabled', 'false');
    settings.set('telegram_enabled', 'false');
  });

  afterEach(() => {
    closeDatabase();
  });

  const prepare = (over: Partial<SiteRow> = {}): { runId: number; row: SiteRow } => {
    const row = site(over);
    upsertSite(
      {
        name: row.name,
        domain: row.domain,
        status: row.status,
        pin_username: '',
        project_id: row.project_id,
        daily_target: row.daily_target,
        interval_minutes: row.interval_minutes,
        auto_publish: row.auto_publish === 1,
      },
      KEY,
    );
    const keywordId = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
    setLink(keywordId, 1, 'go');

    const runId = createRun(keywordId, 1);
    checkpointUpTo(runId, { title: 'Baked Chicken Breast', intro: 'A weeknight dinner.' });

    return { runId, row };
  };

  it('stops before publishing when the site requires approval', async () => {
    const { runId, row } = prepare({ auto_publish: 0 });

    const outcome = await executePipeline(
      new PipelineContext({ runId, site: row, keyword: keyword(), settings, encryptionKey: KEY }),
    );

    expect(outcome.status).toBe('held');
    expect(outcome.hold).toBe('awaiting');

    const run = getRun(runId)!;
    expect(run.hold).toBe('awaiting');
    expect(run.status).toBe('cancelled');
    expect(run.title).toBe('Baked Chicken Breast');
    expect(run.post_url).toBeNull();
  });

  it('stops on a dry run even where publishing is automatic', async () => {
    const { runId, row } = prepare({ auto_publish: 1 });

    const outcome = await executePipeline(
      new PipelineContext({
        runId,
        site: row,
        keyword: keyword(),
        settings,
        encryptionKey: KEY,
        mode: 'dry',
      }),
    );

    expect(outcome.hold).toBe('dry');
    expect(getRun(runId)?.post_url).toBeNull();
  });

  it('publishes on approval instead of holding a second time', async () => {
    // The regression. The site still says auto_publish = 0 at this point —
    // approving has to win over that, or approval can never publish anything.
    const { runId, row } = prepare({ auto_publish: 0 });

    const posted = vi.fn(async () => ({ id: 'p1', href: '/recipes/baked-chicken' }));

    const ctx = new PipelineContext({
      runId,
      site: row,
      keyword: keyword(),
      settings,
      encryptionKey: KEY,
      approved: true,
    });
    // Only the site call is faked; every step before it comes from its
    // checkpoint, exactly as a real resume would replay it.
    (ctx as unknown as { siteApi: unknown }).siteApi = {
      postRecipe: posted,
      uploadImage: async () => ({ url: '/uploads/pin.webp' }),
      absoluteUrl: (p: string) => `https://bitespoon.com${p}`,
    };
    (ctx as unknown as { images: unknown }).images = {
      generate: async () => ({ data: Buffer.from('x'), contentType: 'image/webp', jobId: 'j' }),
      download: async () => ({ data: Buffer.from('x'), contentType: 'image/webp' }),
    };

    const outcome = await executePipeline(ctx);

    expect(posted).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('published');

    const run = getRun(runId)!;
    expect(run.status).toBe('published');
    expect(run.hold).toBe('');
    expect(run.post_url).toBe('https://bitespoon.com/recipes/baked-chicken');
    expect(run.title).toBe('Baked Chicken Breast');
  });

  it('marks the pair done only once it has actually published', async () => {
    const { runId, row } = prepare({ auto_publish: 0 });

    await executePipeline(
      new PipelineContext({ runId, site: row, keyword: keyword(), settings, encryptionKey: KEY }),
    );

    // Held, not published — so the keyword must still be waiting for this site.
    // Marking it done here would retire a keyword whose article nobody has
    // even read yet.
    const link = getRun(runId);
    expect(link?.hold).toBe('awaiting');

    const status = (
      await import('../src/db/repos.js')
    ).getLinksForKeyword(1)[0]?.status;
    expect(status).toBe('go');
  });
});
