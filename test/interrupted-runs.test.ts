import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run as dbRun } from '../src/db/index.js';
import {
  beginStep,
  closeInterruptedRuns,
  createRun,
  finishStep,
  getRun,
  insertKeyword,
  listSteps,
  upsertSite,
} from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * A restart (a deploy, a crash) cuts off the run in progress. It used to stay
 * "running" for ever -- one was two weeks old -- and never move again. At
 * start-up it is now failed at the step it was on, so it can be resumed, and a
 * recent one is queued for an automatic retry.
 */
describe('runs a restart interrupted', () => {
  const KEY = randomBytes(32);

  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    upsertSite(
      { name: 'S', domain: 's.test', status: 'active', pin_username: '', project_id: 'p',
        daily_target: 1, interval_minutes: 60, auto_publish: true },
      KEY,
    );
  });
  afterEach(() => closeDatabase());

  const startRun = (keyword: string): number => {
    const runId = createRun(insertKeyword({ seed_keyword: keyword, status: 'go' }), 1);
    beginStep(runId, 'generate-recipe');
    finishStep(runId, 'generate-recipe', { status: 'ok' });
    beginStep(runId, 'generate-pin-image');
    return runId;
  };

  it('fails a cut-off run at the step it was on and queues a retry when recent', () => {
    const runId = startRun('double cheeseburger');
    expect(closeInterruptedRuns()).toEqual([runId]);

    const row = getRun(runId)!;
    expect(row.status).toBe('failed');
    expect(row.failed_step).toBe('generate-pin-image');
    expect(row.error).toMatch(/restarted/);
    expect(row.retry_after).toBeTruthy();

    const steps = Object.fromEntries(listSteps(runId).map((s) => [s.step, s.status]));
    expect(steps).toEqual({ 'generate-recipe': 'ok', 'generate-pin-image': 'failed' });
  });

  it('closes an old one too, but leaves it for a person', () => {
    const runId = startRun('cheeseburger maison');
    dbRun("UPDATE runs SET started_at = datetime('now', '-14 days') WHERE id = ?", runId);
    closeInterruptedRuns();
    const row = getRun(runId)!;
    expect(row.status).toBe('failed');
    expect(row.retry_after).toBeNull();
  });

  it('touches nothing that is not running', () => {
    const runId = startRun('soup');
    dbRun("UPDATE runs SET status = 'published' WHERE id = ?", runId);
    expect(closeInterruptedRuns()).toEqual([]);
    expect(getRun(runId)!.status).toBe('published');
  });
});
