import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createRun,
  getKeyword,
  getRun,
  getSite,
  insertKeyword,
  markRunFailed,
  upsertSite,
} from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { postArticle } from '../src/pipeline/steps/article.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * A stopped run must not still publish.
 *
 * Stopping a run by hand marks it failed and frees the scheduler lock, but it
 * cannot interrupt a pipeline already awaiting somebody else's network call.
 * The stopped run carried on in the background, the next run started on the
 * same keyword, and both posted — two copies of one recipe on the live site,
 * thirty seconds apart, from a single press of Stop.
 */

const KEY = randomBytes(32);

let posts = 0;

function contextFor(runId: number, siteId: number, keywordId: number): PipelineContext {
  return new PipelineContext({
    runId,
    site: getSite(siteId)!,
    keyword: getKeyword(keywordId)!,
    settings: new Settings(KEY),
    encryptionKey: KEY,
  });
}

function world(): { runId: number; siteId: number; keywordId: number } {
  const siteId = upsertSite(
    {
      name: 'dailyfoodpins',
      domain: 'dailyfoodpins.com',
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 3,
      interval_minutes: 60,
      api_token: 'token',
    },
    KEY,
  );
  const keywordId = insertKeyword({
    seed_keyword: 'smores cake',
    spy_title: "Cookie Dough S'mores Cake",
    status: 'go',
  });

  return { runId: createRun(keywordId, siteId), siteId, keywordId };
}

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  posts = 0;

  vi.stubGlobal('fetch', async (input: string | URL) => {
    if (String(input).includes('/api/recipe')) {
      posts++;
      return new Response(JSON.stringify({ id: '99', href: '/recipe/x' }), { status: 201 });
    }
    return new Response('{}', { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDatabase();
});

describe('publishing on behalf of a run that was stopped', () => {
  it('refuses to post, and says the run has to be resumed', async () => {
    const { runId, siteId, keywordId } = world();

    // What "Stop" does: the run is closed while its pipeline is still in the
    // air, somewhere between generating the article and posting it.
    markRunFailed(runId, 'Stopped by hand from the dashboard', 'stopped');

    await expect(
      postArticle.run(contextFor(runId, siteId, keywordId), { title: 'Cake' }),
    ).rejects.toThrow(/stopped before its article reached dailyfoodpins\.com/);

    expect(posts).toBe(0);
  });

  it('posts normally while the run is still the live one', async () => {
    const { runId, siteId, keywordId } = world();

    const result = await postArticle.run(contextFor(runId, siteId, keywordId), { title: 'Cake' });

    expect(posts).toBe(1);
    expect(getRun(runId)?.status).toBe('running');
    expect(result).toBeDefined();
  });
});
