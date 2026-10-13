import { sitePostUrl } from '../core/social-only.js';
import { tickBlog } from '../blog/engine.js';
import { tickTaxonomy } from '../taxonomy/engine.js';
import { tickAboutRefresh } from '../pages/engine.js';
import { tickExtraAuto } from '../extra/auto.js';
import { randomUUID } from 'node:crypto';
import { get, run } from '../db/index.js';
import {
  consumeRetry,
  createRun,
  dueRetry,
  getKeyword,
  getLinkShare,
  getSite,
  loadKeywordViews,
  loadLinkViews,
  loadGroupLastUsed,
  loadSiteViews,
  pruneDecisions,
  pruneEvents,
  blockLink,
  consecutiveFailuresForPair,
  markRunFailed,
  pauseSite,
  recordDecisions,
  resumeExpiredPauses,
  scheduleRetry,
} from '../db/repos.js';
import { isTransient, planRetry, type RetryPolicy } from '../core/retry.js';
import { announceNotices } from '../core/notices.js';
import { localDateKey, selectTask } from '../core/selector.js';
import { RESEARCH_UNAVAILABLE } from '../pipeline/steps/research.js';
import { isBufferExhausted } from '../integrations/buffer-pool.js';
import type { Decision } from '../core/types.js';
import { articleTitle, executePipeline, PipelineContext } from '../pipeline/index.js';
import { runStep } from '../pipeline/engine.js';
import { generatePinDescription, publishToBuffer, resolveBufferTarget } from '../pipeline/steps/publish.js';
import { collagePostStep } from '../pipeline/steps/collage.js';
import { getCompletedStep } from '../db/repos.js';
import type { Settings } from '../settings.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { backfillNativeFeedPostIds, backfillNativeVideoIds, defaultDeps, tickReels } from '../reels/engine.js';

const log = createLogger('scheduler');

/**
 * Everything worth interrupting someone about, sent only when it changes.
 *
 * This replaced a bespoke announcer that knew about one thing (the keyword
 * queue) and carried its own de-duplication. The set of things worth an alert
 * grew — a site that has stopped working, the image service being down,
 * articles waiting for approval — and each of them needed the same "only when
 * it changes" logic. See core/notices.ts.
 */
async function announce(settings: Settings): Promise<void> {
  try {
    // The image service's health is polled by the web server; the scheduler
    // sees only what the last poll left behind.
    await announceNotices(settings, imageServiceProblem());
  } catch (err) {
    // Never let a notification failure take down a publishing run.
    log.warn(`could not send notifications: ${errorMessage(err)}`);
  }
}

/**
 * The web server's view of the image service, without importing the server.
 *
 * The server polls it on a timer and calls setImageServiceProblem; the
 * scheduler reads whatever that left. A getter rather than an import because
 * the dependency only runs in that direction — the server owns the scheduler,
 * not the other way round.
 */
let lastImageServiceProblem: string | null = null;

export function setImageServiceProblem(problem: string | null): void {
  lastImageServiceProblem = problem;
}

function imageServiceProblem(): string | null {
  return lastImageServiceProblem;
}

/**
 * The scheduler.
 *
 * One tick does at most one thing: find a valid keyword+site pair and publish
 * it. It never loops, never retries in place, and never runs concurrently
 * with itself. If a tick finds nothing, it records why and stops — the next
 * tick starts from fresh state.
 */

export interface TickResult {
  cycleId: string;
  outcome:
    | 'published'
    | 'failed'
    | 'spy-rejected'
    | 'duplicate'
    | 'held'
    | 'no-task'
    | 'busy'
    | 'disabled'
    | 'misconfigured';
  runId?: number;
  detail?: string;
  /** Set when the outcome is 'held': why it stopped before publishing. */
  hold?: 'awaiting' | 'dry';
}

/** The automatic-retry settings, read once per tick. */
function retryPolicy(settings: Settings): RetryPolicy {
  return {
    enabled: settings.getBool('auto_retry_enabled'),
    maxAttempts: Math.max(0, settings.getNumber('auto_retry_max')),
    delayMinutes: Math.max(1, settings.getNumber('auto_retry_delay_minutes')),
  };
}

/**
 * Decide what happens to a run that just failed.
 *
 * Called from both tick and resume, because a retry that fails should be
 * considered for another retry on exactly the same terms.
 */
function considerRetry(
  runId: number,
  error: string,
  attempts: number,
  settings: Settings,
  siteId?: number,
): string {
  // A site whose Buffer accounts are all full is not a broken run. The article
  // is written, the images are made, the post is live on the site — only the
  // pin is missing, and the one thing that fixes it is time. Retrying on the
  // usual schedule would burn the attempt budget against a queue that will not
  // move for hours and then give up for good.
  if (siteId && isBufferExhausted(error)) {
    return holdForBufferQueue(runId, siteId, settings);
  }

  // No Google research yet (every Serper key and web search failed): not a
  // broken run. It waits an hour and tries again without spending the retry
  // budget; after six hours the research step writes it without research.
  if (error.includes(RESEARCH_UNAVAILABLE)) {
    const due = new Date(Date.now() + 60 * 60_000).toISOString();
    scheduleRetry(runId, due);
    run('UPDATE runs SET attempts = MAX(attempts - 1, 0) WHERE id = ?', runId);
    log.info(`run ${runId}: Google research unavailable, trying again in 1 hour`);
    return 'Waiting for Google research: trying again in 1 hour (up to 6 hours, then written without it).';
  }

  const decision = planRetry(error, attempts, retryPolicy(settings), new Date());
  scheduleRetry(runId, decision.retryAfter);

  if (decision.retry) log.info(`run ${runId}: ${decision.reason}`);
  else log.debug(`run ${runId}: not retrying — ${decision.reason}`);

  // Only once the retries are done with it. A run that is going to be tried
  // again has not failed yet in the sense that matters here.
  const held = decision.retry ? '' : considerBlockingPair(runId, error, settings);

  return held ? `${decision.reason} ${held}` : decision.reason;
}

/**
 * Stop offering a pair that keeps failing the same way.
 *
 * The count is deliberately narrow, because the obvious version of this is
 * wrong in three ways:
 *
 *   It would punish a pair for the world's problems. When the image service is
 *   down, every pair that runs fails, and none of them is what broke. So only
 *   failures that `isTransient` calls permanent are counted — the ones that
 *   will happen identically next time. That is the same classifier the retry
 *   policy uses, rather than a second opinion that can drift from it.
 *
 *   It would count across successes. A pair that published fine last week and
 *   failed twice today is not a hopeless pair. The count runs from the last run
 *   that got somewhere, so any success clears it.
 *
 *   It would write 'no' into the link, which is where a person records that a
 *   keyword does not belong on a site. Then nobody could tell a decision from a
 *   surrender, and unblocking would mean guessing which it was. This sets its
 *   own field and leaves the status alone.
 *
 * What it deliberately does not do is require the same failing step each time.
 * Three permanent failures at three different steps is still a pair nothing can
 * publish, and demanding they match would keep offering it for as long as it
 * found new ways to fail.
 */
function considerBlockingPair(runId: number, error: string, settings: Settings): string {
  const limit = Math.max(0, settings.getNumber('pair_failure_limit'));
  if (limit === 0) return '';

  const row = get<{ keyword_id: number | null; site_id: number | null }>(
    'SELECT keyword_id, site_id FROM runs WHERE id = ?',
    runId,
  );
  if (!row?.keyword_id || !row.site_id) return '';

  // The world's problems are the retry policy's business, not this one's.
  if (isTransient(error)) return '';

  const failures = consecutiveFailuresForPair(row.keyword_id, row.site_id);
  if (failures < limit) return '';

  const reason =
    `Failed ${failures} times in a row with nothing published in between. ` +
    `Last error: ${error.slice(0, 300)}`;

  blockLink(row.keyword_id, row.site_id, reason);
  log.warn(`keyword ${row.keyword_id} held back on site ${row.site_id}: ${reason}`);

  return `Held back on this site after ${failures} failures — clear it on the keyword page.`;
}

/**
 * Park a site whose Buffer accounts are all full, and finish the article later.
 *
 * The site is paused so the selector stops handing it new work — publishing
 * more articles it cannot pin would only deepen the backlog — and the run is
 * scheduled to resume when the pause lifts. Resume reuses every completed
 * step, so it picks up at the pin: the same article, on the same site, posted
 * to Buffer as soon as there is room for it.
 *
 * Both use the same instant, so the site comes back exactly when its article
 * is due rather than the two drifting apart.
 */
export function holdForBufferQueue(runId: number, siteId: number, settings: Settings): string {
  const hours = Math.max(1, settings.getNumber('buffer_hold_hours'));
  const until = new Date(Date.now() + hours * 60 * 60 * 1000);
  const site = getSite(siteId);
  const domain = site?.domain ?? `site ${siteId}`;

  const reason =
    `Every Buffer account is full. Paused for ${hours} hours, then run ${runId} ` +
    `resumes and posts its pin.`;

  pauseSite(siteId, reason, until.toISOString());
  scheduleRetry(runId, until.toISOString());

  log.warn(`${domain}: ${reason}`);
  return `Buffer queue full — ${domain} paused for ${hours}h, resuming run ${runId} after that.`;
}

/* -- Lock ---------------------------------------------------------------- */

interface LockRow {
  id: number;
  run_id: number | null;
  locked_at: string | null;
  heartbeat_at: string | null;
}

/** A lock older than this is assumed orphaned by a crash or restart. */
const STALE_LOCK_MINUTES = 90;

function acquireLock(): boolean {
  const result = run(
    `UPDATE scheduler_lock
        SET locked_at = datetime('now'), heartbeat_at = datetime('now')
      WHERE id = 1
        AND (locked_at IS NULL OR locked_at < datetime('now', ?))`,
    `-${STALE_LOCK_MINUTES} minutes`,
  );
  return result.changes > 0;
}

function releaseLock(): void {
  run('UPDATE scheduler_lock SET locked_at = NULL, run_id = NULL, heartbeat_at = NULL WHERE id = 1');
}

function attachRunToLock(runId: number): void {
  run("UPDATE scheduler_lock SET run_id = ?, heartbeat_at = datetime('now') WHERE id = 1", runId);
}

/** The run lock, for work outside article runs that must not overlap them (blog articles). */
export const tryAcquireRunLock = (): boolean => acquireLock();
export const releaseRunLock = (): void => releaseLock();

export function heartbeat(): void {
  run("UPDATE scheduler_lock SET heartbeat_at = datetime('now') WHERE id = 1");
}

export const lockStatus = (): LockRow | undefined =>
  get<LockRow>('SELECT * FROM scheduler_lock WHERE id = 1');

export function forceReleaseLock(): void {
  log.warn('scheduler lock released manually');
  releaseLock();
}

/* -- Tick ---------------------------------------------------------------- */

export async function tick(
  settings: Settings,
  encryptionKey: Buffer,
  options: { mode?: 'live' | 'dry'; pick?: { siteId: number; keywordId: number } } = {},
): Promise<TickResult> {
  const cycleId = randomUUID();
  const mode = options.mode ?? 'live';
  const pick = options.pick;

  // Before anything else: a pause that has run out is not a pause. Done here
  // rather than derived at read time so the sites table never says "paused"
  // over a site the scheduler is treating as active.
  const resumed = resumeExpiredPauses();
  if (resumed.length > 0) log.info(`pause expired, resuming: ${resumed.join(', ')}`);

  // The automation switch guards publishing. A dry run publishes nothing, and
  // "try a prompt before turning automation on" is the main thing it is for,
  // so it is not gated on that switch.
  //
  // Neither is a hand-picked run. The switch decides whether the scheduler
  // acts on its own; someone standing at the dashboard choosing a site and a
  // keyword has already made that decision themselves.
  if (mode === 'live' && !pick && !settings.getBool('automation_enabled')) {
    return { cycleId, outcome: 'disabled' };
  }

  const problems = settings.validate();
  if (problems.length > 0) {
    log.warn('cannot run: configuration incomplete', problems);
    recordDecisions(cycleId, [
      {
        subjectType: 'cycle',
        subjectId: null,
        subjectLabel: '',
        decision: 'none',
        reason: `Configuration incomplete: ${problems.join(' ')}`,
      },
    ]);
    return { cycleId, outcome: 'misconfigured', detail: problems.join(' ') };
  }

  if (!acquireLock()) {
    log.debug('a run is already in progress; skipping this tick');
    return { cycleId, outcome: 'busy' };
  }

  try {
    // A failure that is due to be tried again takes this slot ahead of new
    // work. It is cheaper — every completed step is reused — and leaving it
    // behind new work would mean a busy queue never retries anything.
    // A hand-picked run skips this: it was asked for by name, and handing its
    // slot to a queued retry would run something the person did not choose.
    const retry = mode === 'live' && !pick ? dueRetry() : undefined;
    if (retry) {
      releaseLock();
      log.info(`run ${retry.id}: automatic retry (attempt ${retry.attempts + 1})`);
      consumeRetry(retry.id);
      const result = await resumeRun(retry.id, settings, encryptionKey);
      await announce(settings);
      return { ...result, cycleId };
    }

    const timezone = settings.get('timezone');
    const now = new Date();
    const dayKey = localDateKey(now, timezone);

    // A hand-picked run goes straight to the pipeline. The selector's job is
    // to answer "what should run next", and that question has already been
    // answered by a person — running it anyway would only find reasons to
    // refuse a pair they can see on the screen in front of them: the site's
    // daily target, its interval since the last post, a keyword already used
    // elsewhere. Those pace the automation. They are not a veto over someone
    // asking for one article now.
    let task: { siteId: number; keywordId: number } | null = null;
    let decisions: Decision[] = [];

    if (pick) {
      task = { siteId: pick.siteId, keywordId: pick.keywordId };
    } else {
      const sites = loadSiteViews(dayKey, timezone);
      const keywords = loadKeywordViews();
      const links = loadLinkViews();
      const selection = selectTask(sites, keywords, links, { now, timezone, groupLastUsed: loadGroupLastUsed() });
      recordDecisions(cycleId, selection.decisions);
      task = selection.task;
      decisions = selection.decisions;
    }

    if (!task) {
      const reason = decisions.at(-1)?.reason ?? 'No valid pair';
      log.info(`nothing to publish: ${reason}`);
      await announce(settings);
      return { cycleId, outcome: 'no-task', detail: reason };
    }

    // Also checked on a productive tick, so "running low" is noticed while
    // there is still time to act rather than only once it has stopped.
    void announce(settings);

    const site = getSite(task.siteId);
    const keyword = getKeyword(task.keywordId);
    if (!site || !keyword) {
      return {
        cycleId,
        outcome: 'no-task',
        detail: pick ? 'That site or keyword no longer exists' : 'Selected site or keyword disappeared',
      };
    }

    log.info(
      `${pick ? 'hand-picked' : 'selected'} "${keyword.seed_keyword}" for ${site.domain}`,
    );

    // Recorded so the events log says why this ran, since no selector
    // decision explains it.
    if (pick) {
      recordDecisions(cycleId, [
        {
          subjectType: 'cycle',
          subjectId: null,
          subjectLabel: '',
          decision: 'eligible',
          reason: `Manual run: "${keyword.seed_keyword}" on ${site.domain}, chosen by hand`,
        },
      ]);
    }

    const runId = createRun(task.keywordId, task.siteId, mode);
    attachRunToLock(runId);

    const ctx = new PipelineContext({
      runId,
      site,
      keyword,
      settings,
      encryptionKey,
      shareImages: getLinkShare(keyword.id, site.id),
      mode,
    });
    const outcome = await withRunTimeout(executePipeline(ctx), settings, runId);

    const detail =
      outcome.status === 'failed'
        ? `${outcome.error ?? ''} ${considerRetry(
            runId,
            outcome.error ?? '',
            0,
            settings,
            task.siteId,
          )}`.trim()
        : (outcome.error ?? outcome.postUrl);

    return { cycleId, outcome: outcome.status, runId, detail, hold: outcome.hold };
  } catch (err) {
    log.error('tick failed unexpectedly', errorMessage(err));
    return { cycleId, outcome: 'failed', detail: errorMessage(err) };
  } finally {
    releaseLock();
  }
}

/**
 * Schedule a published run's Pinterest pin again, after a failure there.
 *
 * The run itself is published and stays so: only the three Pinterest steps
 * run, each reusing its checkpoint when it already succeeded -- the
 * description is not written twice, the failed step is tried again.
 */
export async function retryPinterestPin(runId: number, settings: Settings, encryptionKey: Buffer): Promise<string> {
  if (!acquireLock()) throw new Error('A run is working right now. Try again in a minute.');
  try {
    const row = get<{ keyword_id: number | null; site_id: number | null }>('SELECT keyword_id, site_id FROM runs WHERE id = ?', runId);
    const site = row?.site_id ? getSite(row.site_id) : undefined;
    const keyword = row?.keyword_id ? getKeyword(row.keyword_id) : undefined;
    if (!site || !keyword) throw new Error('The site or keyword of this run no longer exists.');

    const output = <T>(step: string): T | undefined => {
      const done = getCompletedStep(runId, step);
      try {
        return done?.output_json ? (JSON.parse(done.output_json) as T) : undefined;
      } catch {
        return undefined;
      }
    };
    const seo = output<Parameters<typeof resolveBufferTarget.run>[1]>('validate-spy');
    const posted = output<Record<string, unknown>>('post-article');
    const pinImage = output<{ url: string; cta: string }>('generate-pin-image');
    if (!seo || !posted) throw new Error('This run has no published article to pin.');
    if (!pinImage?.url) throw new Error('This run made no pin image (Pinterest posts were off for the site).');
    if (!settings.getBool('buffer_enabled')) throw new Error('Buffer is off in Settings.');

    const ctx = new PipelineContext({
      runId, site, keyword, settings, encryptionKey,
      shareImages: getLinkShare(keyword.id, site.id),
      mode: 'live',
      approved: true,
    });
    const pin = { seo, posted, pinImageUrl: pinImage.url, cta: pinImage.cta } as Parameters<typeof generatePinDescription.run>[1];
    const description = await runStep(ctx, generatePinDescription, pin);
    const target = await runStep(ctx, resolveBufferTarget, seo);
    const result = await runStep(ctx, publishToBuffer, { pin, description, target });
    return 'postId' in result ? `Pin scheduled on "${target.boardName}".` : 'Buffer publishing is off; nothing was scheduled.';
  } finally {
    releaseLock();
  }
}

/**
 * Make and post the step-by-step photo collage again, by hand, after it
 * skipped or failed (Setup -> Collage, or the run page's own Retry).
 *
 * Unlike retryPinterestPin, this does not reuse a checkpoint: collage-post
 * never throws, so its own earlier result -- `{ skipped }` or `{ error }` --
 * is itself a completed 'ok' checkpoint, and a plain resume would just hand
 * that same answer back. `allowResume: false` on this one-off context makes
 * sure the step actually runs again instead of repeating its old verdict.
 */
export async function retryCollagePost(runId: number, settings: Settings, encryptionKey: Buffer): Promise<string> {
  if (!acquireLock()) throw new Error('A run is working right now. Try again in a minute.');
  try {
    const row = get<{ keyword_id: number | null; site_id: number | null }>('SELECT keyword_id, site_id FROM runs WHERE id = ?', runId);
    const site = row?.site_id ? getSite(row.site_id) : undefined;
    const keyword = row?.keyword_id ? getKeyword(row.keyword_id) : undefined;
    if (!site || !keyword) throw new Error('The site or keyword of this run no longer exists.');

    const output = <T>(step: string): T | undefined => {
      const done = getCompletedStep(runId, step);
      try {
        return done?.output_json ? (JSON.parse(done.output_json) as T) : undefined;
      } catch {
        return undefined;
      }
    };
    const seo = output<Parameters<typeof collagePostStep.run>[1]['seo']>('validate-spy');
    const recipe = output<{ raw: string }>('generate-recipe');
    const article = output<Record<string, unknown>>('generate-article');
    const posted = output<{ href?: string }>('post-article');
    if (!seo || !recipe || !posted) throw new Error('This run has no published article to make a collage from.');

    const title = (article && articleTitle(article)) || seo.title;
    const postUrl = sitePostUrl(site, posted.href);

    const ctx = new PipelineContext({
      runId, site, keyword, settings, encryptionKey,
      shareImages: getLinkShare(keyword.id, site.id),
      mode: 'live',
      approved: true,
      allowResume: false,
    });
    const result = await runStep(ctx, collagePostStep, { seo, title, postUrl, recipe: recipe.raw });
    if ('postId' in result) return 'Collage posted.';
    if ('skipped' in result) return `Not posted: ${result.skipped}`;
    throw new Error(result.error);
  } finally {
    releaseLock();
  }
}

/** Re-run a failed run, reusing every completed checkpoint. */
export async function resumeRun(
  runId: number,
  settings: Settings,
  encryptionKey: Buffer,
): Promise<TickResult> {
  const cycleId = randomUUID();

  if (!acquireLock()) return { cycleId, outcome: 'busy' };

  try {
    const runRow = get<{
      keyword_id: number | null;
      site_id: number | null;
      attempts: number;
      mode: 'live' | 'dry';
      hold: string;
    }>('SELECT keyword_id, site_id, attempts, mode, hold FROM runs WHERE id = ?', runId);
    if (!runRow?.site_id || !runRow.keyword_id) {
      return { cycleId, outcome: 'failed', detail: `Run ${runId} not found` };
    }

    const site = getSite(runRow.site_id);
    const keyword = getKeyword(runRow.keyword_id);
    if (!site || !keyword) {
      return { cycleId, outcome: 'failed', detail: 'Site or keyword no longer exists' };
    }

    run(
      `UPDATE runs SET status = 'running', error = NULL, failed_step = NULL,
         hold = '', retry_after = NULL
       WHERE id = ?`,
      runId,
    );
    attachRunToLock(runId);

    log.info(`resuming run ${runId}`);

    // Approving a held run means publishing it, so the resume is always live —
    // resuming a dry run is exactly the "publish it after all" action — and it
    // must not be stopped by the same gate a second time.
    const ctx = new PipelineContext({
      runId,
      site,
      keyword,
      settings,
      encryptionKey,
      shareImages: getLinkShare(keyword.id, site.id),
      mode: 'live',
      approved: true,
    });
    const outcome = await executePipeline(ctx);

    const detail =
      outcome.status === 'failed'
        ? `${outcome.error ?? ''} ${considerRetry(
            runId,
            outcome.error ?? '',
            runRow.attempts ?? 0,
            settings,
            runRow.site_id ?? undefined,
          )}`.trim()
        : (outcome.error ?? outcome.postUrl);

    return { cycleId, outcome: outcome.status, runId, detail, hold: outcome.hold };
  } finally {
    releaseLock();
  }
}

/**
 * The backstop for a run that keeps moving but never finishes.
 *
 * The step timeout catches one step that stops responding. This catches the
 * other shape: steps that each return in time, on a run that has been going
 * for an hour and is not going to stop on its own.
 */
async function withRunTimeout<T>(
  work: Promise<T>,
  settings: Settings,
  runId: number,
): Promise<T> {
  const minutes = Math.max(1, settings.getNumber('run_timeout_minutes'));
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Run ${runId} exceeded the ${minutes} minute run timeout`)),
          minutes * 60_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reap a run whose process is gone.
 *
 * The two timeouts above only fire inside the process that started the run. A
 * container killed mid-run leaves the lock held and the run row saying
 * "running" forever — until now, for ninety minutes, with the dashboard
 * cheerfully reporting a run in progress and no way to clear it.
 *
 * Silence is the signal: the engine stamps the lock at every step, so a
 * heartbeat older than the step timeout means nothing is running any more.
 */
export function reapStalledRun(settings: Settings, now = new Date()): number | null {
  const lock = lockStatus();
  if (!lock?.locked_at) return null;

  const stallMinutes = Math.max(1, settings.getNumber('run_step_timeout_minutes')) + 5;
  const last = lock.heartbeat_at ?? lock.locked_at;
  const silentFor = now.getTime() - Date.parse(`${last.replace(' ', 'T')}Z`);

  if (!Number.isFinite(silentFor) || silentFor < stallMinutes * 60_000) return null;

  const minutes = Math.round(silentFor / 60_000);
  const reason =
    `Stalled: nothing happened for ${minutes} minutes. The run was abandoned — ` +
    `usually the container restarted mid-run. Resume it to carry on from the ` +
    `last completed step.`;

  log.warn(`run ${lock.run_id ?? '?'}: ${reason}`);

  if (lock.run_id) {
    markRunFailed(lock.run_id, reason, 'stalled');
    considerRetry(lock.run_id, reason, 0, settings);
  }
  releaseLock();

  return lock.run_id;
}

/**
 * Stop the run in progress, by hand.
 *
 * The pipeline itself cannot be interrupted — it is awaiting somebody else's
 * network call — so this marks the run failed and frees the lock, which is
 * what unblocks the scheduler and the dashboard. Any late reply from the work
 * still in flight lands on a run that is already closed and changes nothing.
 */
export function stopRun(reason = 'Stopped by hand from the dashboard'): number | null {
  const lock = lockStatus();
  if (!lock?.locked_at) return null;

  log.warn(`run ${lock.run_id ?? '?'} stopped by hand`);
  if (lock.run_id) markRunFailed(lock.run_id, reason, 'stopped');
  releaseLock();

  return lock.run_id;
}

/* -- Loop ---------------------------------------------------------------- */

/**
 * How often reels are advanced, separately from articles.
 *
 * Reels used to move only on the article tick, which is tick_minutes -- fifteen
 * on the deployed platform. A reel moves one state per tick, so a video that
 * Google finished in two minutes sat there for up to fifteen before the
 * platform noticed it was ready, and up to fifteen more before it published.
 * Half an hour for a two-minute clip, all of it waiting on a timer that exists
 * to pace article publishing and has nothing to say about video.
 *
 * A minute is about what one poll of the image service costs, and it is the
 * granularity the wait is already measured in on the other side.
 */
const REEL_TICK_MS = 60_000;
const BLOG_TICK_MS = 60_000;
const EXTRA_TICK_MS = 10 * 60_000;
/** Taxonomy: one term per site per tick. */
const TAXO_TICK_MS = 5 * 60_000;
/** The About page's weekly check: cheap when nothing is due (a database read), so hourly. */
const ABOUT_TICK_MS = 60 * 60_000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private reelTimer: NodeJS.Timeout | null = null;
  private blogTimer: NodeJS.Timeout | null = null;
  private taxoTimer: NodeJS.Timeout | null = null;
  private running = false;
  private reelsRunning = false;
  private blogRunning = false;
  private extraTimer: NodeJS.Timeout | null = null;
  private extraRunning = false;
  private taxoRunning = false;
  private aboutTimer: NodeJS.Timeout | null = null;
  private aboutRunning = false;
  private stopped = false;
  private announcedMinutes = 0;
  private lastCheckEndedAt = 0;

  constructor(
    private readonly settings: Settings,
    private readonly encryptionKey: Buffer,
    /** The work of one check. Replaceable so the cadence can be tested alone. */
    private readonly work: () => Promise<unknown> = async () => {
      // Before anything else: a lock held by a run that no longer exists is
      // not a run in progress, and leaving it would block every tick after it.
      reapStalledRun(this.settings);

      const result = await tick(this.settings, this.encryptionKey);
      if (result.outcome !== 'disabled' && result.outcome !== 'busy') {
        log.debug(`tick: ${result.outcome}`);
      }

      // Reels are not advanced here any more; they have their own timer above.
      // Doing it here as well would run two reel ticks against each other.

      this.maybePrune();
    },
  ) {}

  start(): void {
    this.stopped = false;
    log.info(`scheduler started, checking every ${this.minutes()} minute(s)`);
    // Give the web server a moment to come up before the first check.
    this.timer = setTimeout(() => void this.safeTick(), 10_000);

    // Reels on their own clock. Not inside safeTick: that runs on the article
    // cadence and holds the article lock, and a reel waiting on Google should
    // depend on neither.
    this.reelTimer = setInterval(() => void this.safeTickReels(), REEL_TICK_MS);

    // Blog articles on a third clock: each site's own interval and daily
    // number, apart from its recipes. Checked every minute; one article at a
    // time, under the same lock as a recipe run so they never overlap.
    this.blogTimer = setInterval(() => void this.safeTickBlog(), BLOG_TICK_MS);

    // Taxonomy pages: one term per switched-on site every few minutes, under
    // the same lock, so a picture never competes with a recipe run for Flow.
    this.taxoTimer = setInterval(() => void this.safeTickTaxonomy(), TAXO_TICK_MS);

    // More posts, automatic: new posts for recipes already published, one batch per tick.
    this.extraTimer = setInterval(() => void this.safeTickExtra(), EXTRA_TICK_MS);

    // The About page, once a week and only when the site has grown.
    this.aboutTimer = setInterval(() => void this.safeTickAbout(), ABOUT_TICK_MS);
  }

  private async safeTickAbout(): Promise<void> {
    if (this.aboutRunning || this.running) return;
    this.aboutRunning = true;
    try {
      await tickAboutRefresh(this.settings, this.encryptionKey, { tryLock: tryAcquireRunLock, unlock: releaseRunLock });
    } catch (err) {
      log.error('the About refresh tick threw', errorMessage(err));
    } finally {
      this.aboutRunning = false;
    }
  }

  private async safeTickExtra(): Promise<void> {
    if (this.extraRunning || this.running) return;
    this.extraRunning = true;
    try {
      await tickExtraAuto(this.settings, this.encryptionKey, { tryLock: tryAcquireRunLock, unlock: releaseRunLock });
    } catch (err) {
      log.error('the More posts tick threw', errorMessage(err));
    } finally {
      this.extraRunning = false;
    }
  }

  private async safeTickTaxonomy(): Promise<void> {
    if (this.taxoRunning || this.running) return;
    this.taxoRunning = true;
    try {
      await tickTaxonomy(this.settings, this.encryptionKey, { tryLock: tryAcquireRunLock, unlock: releaseRunLock, heartbeat });
    } catch (err) {
      log.error('the taxonomy tick threw', errorMessage(err));
    } finally {
      this.taxoRunning = false;
    }
  }

  private async safeTickBlog(): Promise<void> {
    if (this.blogRunning || this.running) return;
    this.blogRunning = true;
    try {
      await tickBlog(this.settings, this.encryptionKey, {
        tryLock: tryAcquireRunLock,
        unlock: releaseRunLock,
        heartbeat,
      });
    } catch (err) {
      log.error('the blog tick threw', errorMessage(err));
    } finally {
      this.blogRunning = false;
    }
  }

  /** The reel tick, guarded so a slow publish is never overlapped by the next. */
  private async safeTickReels(): Promise<void> {
    if (this.reelsRunning) return;
    this.reelsRunning = true;
    try {
      await this.tickReels();
    } finally {
      this.reelsRunning = false;
    }
  }

  /**
   * "Check every (minutes)", as it is now.
   *
   * Read before every wait rather than once at boot: this was a setInterval
   * built from the value at start-up, so saving a new number on the Settings
   * page changed nothing until the container restarted. A site set to post
   * every 5 minutes kept posting every 15, because nobody was looking in
   * between, and the page gave no sign that the number it showed was not the
   * one in force.
   */
  private minutes(): number {
    return Math.max(1, this.settings.getNumber('tick_minutes'));
  }

  /**
   * Wake at most a minute from now and see whether a check is due.
   *
   * Not one sleep for the whole period: a period armed at 15 minutes would
   * sit out the remaining fourteen after someone saved 1, which is the same
   * "nothing happened" the restart-only reading gave. Waking every minute
   * costs nothing and means a saved number is in force within a minute.
   */
  private scheduleNext(): void {
    if (this.stopped) return;
    const minutes = this.minutes();
    if (minutes !== this.announcedMinutes) {
      if (this.announcedMinutes) log.info(`scheduler now checking every ${minutes} minute(s)`);
      this.announcedMinutes = minutes;
    }
    const due = this.lastCheckEndedAt + minutes * 60_000;
    const wait = Math.max(0, Math.min(60_000, due - Date.now()));
    this.timer = setTimeout(() => {
      if (Date.now() >= this.lastCheckEndedAt + this.minutes() * 60_000) {
        void this.safeTick();
      } else {
        this.scheduleNext();
      }
    }, wait);
  }

  private async safeTick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await this.work();
    } catch (err) {
      log.error('scheduler tick threw', errorMessage(err));
    } finally {
      this.running = false;
      // Timed from the end of one check to the start of the next, so a long
      // run and the wait never overlap into a second run.
      this.lastCheckEndedAt = Date.now();
      this.scheduleNext();
    }
  }

  /**
   * Advance any reels that are waiting on something.
   *
   * Isolated from the article tick: a reel that cannot publish must never be
   * the reason an article does not.
   */
  private async tickReels(): Promise<void> {
    try {
      const reels = await tickReels(this.settings, defaultDeps(this.settings, this.encryptionKey));
      if (reels.advanced > 0 || reels.failed > 0) {
        log.info(`reels: ${reels.advanced} advanced, ${reels.failed} failed`);
      }
    } catch (err) {
      log.error('the reel tick threw', errorMessage(err));
    }
    this.maybeBackfillFbVideoIds();
    this.maybeBackfillFbPostIds();
  }

  private lastVideoBackfill = 0;

  /**
   * Fill in the real Facebook video id for reels Buffer published.
   *
   * Every ten minutes, not every tick: it is one Graph call per page with
   * something still waiting, not per reel, so there is no cost to checking
   * often, but nothing changes between one tick and the next either.
   */
  private maybeBackfillFbVideoIds(): void {
    const TEN_MINUTES = 10 * 60_000;
    if (Date.now() - this.lastVideoBackfill < TEN_MINUTES) return;
    this.lastVideoBackfill = Date.now();

    void backfillNativeVideoIds(this.settings, this.encryptionKey).then(
      (result) => {
        if (result.matched > 0) {
          log.info(`video backfill: matched ${result.matched} of ${result.checked} waiting reel(s)`);
        }
      },
      (err) => log.error('video backfill threw', errorMessage(err)),
    );
  }

  private lastPostBackfill = 0;

  /**
   * Fill in the real Facebook post id for feed posts (article posts, the
   * photo collage) Buffer published. Same cadence as `maybeBackfillFbVideoIds`
   * and the same reason: one Graph call per page with something waiting, not
   * per post, so there is no cost to checking often.
   */
  private maybeBackfillFbPostIds(): void {
    const TEN_MINUTES = 10 * 60_000;
    if (Date.now() - this.lastPostBackfill < TEN_MINUTES) return;
    this.lastPostBackfill = Date.now();

    void backfillNativeFeedPostIds(this.settings, this.encryptionKey).then(
      (result) => {
        if (result.matched > 0) {
          log.info(`post backfill: matched ${result.matched} of ${result.checked} waiting feed post(s)`);
        }
      },
      (err) => log.error('post backfill threw', errorMessage(err)),
    );
  }

  private lastPrune = 0;

  private maybePrune(): void {
    const DAY = 86_400_000;
    if (Date.now() - this.lastPrune < DAY) return;
    this.lastPrune = Date.now();

    const days = Math.max(1, this.settings.getNumber('retention_days'));
    const removed = pruneDecisions(days) + pruneEvents(days);
    if (removed > 0) log.info(`pruned ${removed} old log rows (retention ${days}d)`);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.reelTimer) clearInterval(this.reelTimer);
    if (this.blogTimer) clearInterval(this.blogTimer);
    this.blogTimer = null;
    if (this.aboutTimer) clearInterval(this.aboutTimer);
    this.aboutTimer = null;
    if (this.taxoTimer) clearInterval(this.taxoTimer);
    this.taxoTimer = null;
    if (this.extraTimer) clearInterval(this.extraTimer);
    this.extraTimer = null;
    this.timer = null;
    this.reelTimer = null;
    log.info('scheduler stopped');
  }
}
