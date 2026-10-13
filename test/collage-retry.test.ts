import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  beginStep,
  createRun,
  finishStep,
  getCompletedStep,
  insertKeyword,
  markRunPublished,
  upsertSite,
} from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * retryCollagePost: the manual "Retry" for collage-post, which -- unlike a
 * plain resume -- has to actually run the step again rather than hand back
 * its own earlier `{ skipped }`/`{ error }`, since collage-post never throws
 * and so always looks like a completed checkpoint.
 */

const KEY = randomBytes(32);

const run = vi.fn();
vi.mock('../src/pipeline/steps/collage.js', () => ({
  collagePostStep: { name: 'collage-post', title: 'x', run: (...args: unknown[]) => run(...args) },
}));

function seed() {
  const siteId = upsertSite({ name: 'a', domain: 'a.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
  const keywordId = insertKeyword({ seed_keyword: 'dessert' });
  const runId = createRun(keywordId, siteId);
  markRunPublished(runId, 'p1', '/recipe/dessert-bars', 'Dessert Bars');

  beginStep(runId, 'validate-spy');
  finishStep(runId, 'validate-spy', { status: 'ok', output: { title: 'Dessert Bars', description: 'Bars' } });
  beginStep(runId, 'generate-recipe');
  finishStep(runId, 'generate-recipe', { status: 'ok', output: { raw: '{"ingredients":[]}' } });
  beginStep(runId, 'generate-article');
  finishStep(runId, 'generate-article', { status: 'ok', output: { title: 'Dessert Bars' } });
  beginStep(runId, 'post-article');
  finishStep(runId, 'post-article', { status: 'ok', output: { href: '/recipe/dessert-bars' } });

  // An earlier, failed collage: a completed ('ok') checkpoint whose own
  // output says it did not actually post anything.
  beginStep(runId, 'collage-post');
  finishStep(runId, 'collage-post', { status: 'ok', output: { error: 'only 2 of 9 photos came out' } });

  return runId;
}

describe('retrying the photo collage by hand', () => {
  let retryCollagePost: typeof import('../src/scheduler/index.js').retryCollagePost;

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
    run.mockReset();
    ({ retryCollagePost } = await import('../src/scheduler/index.js'));
  });
  afterEach(() => closeDatabase());

  it('runs the step again rather than replaying the stale "failed" checkpoint', async () => {
    const runId = seed();
    run.mockResolvedValueOnce({ postId: 'C9', imageUrl: 'https://a.com/collage.jpg' });

    const message = await retryCollagePost(runId, new Settings(KEY), KEY);

    expect(run).toHaveBeenCalledTimes(1);
    expect(message).toBe('Collage posted.');
    // The checkpoint now reflects the fresh, successful attempt.
    expect(JSON.parse(getCompletedStep(runId, 'collage-post')!.output_json!)).toEqual({
      postId: 'C9',
      imageUrl: 'https://a.com/collage.jpg',
    });
  });

  it('surfaces a skip as a message, not an error', async () => {
    const runId = seed();
    run.mockResolvedValueOnce({ skipped: 'the photo collage is off' });

    const message = await retryCollagePost(runId, new Settings(KEY), KEY);
    expect(message).toBe('Not posted: the photo collage is off');
  });

  it('throws the step\'s own error message when it fails again', async () => {
    const runId = seed();
    run.mockResolvedValueOnce({ error: 'image service down' });

    await expect(retryCollagePost(runId, new Settings(KEY), KEY)).rejects.toThrow('image service down');
  });

  it('refuses a run with no published article to work from', async () => {
    const siteId = upsertSite({ name: 'b', domain: 'b.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    const keywordId = insertKeyword({ seed_keyword: 'soup' });
    const runId = createRun(keywordId, siteId);

    await expect(retryCollagePost(runId, new Settings(KEY), KEY)).rejects.toThrow(/no published article/);
    expect(run).not.toHaveBeenCalled();
  });
});
