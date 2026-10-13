import { get } from '../db/index.js';
import { getSite, listSites } from '../db/repos.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import { NETWORKS, listPublishedRecipes, makeExtraPosts, networkStates, type Network } from './engine.js';

const log = createLogger('extra-auto');

/**
 * Automatic More posts: each tick, for each active site under today's cap, the recipe that has
 * waited longest gets a batch on every network that is switched on and past its gap.
 * One batch per site per tick, under the same run lock as a recipe run.
 */

/** Batches the scheduler made for this site today (by the server's clock, like the runs counters). */
export function autoBatchesToday(siteId: number): number {
  return (
    get<{ n: number }>(
      "SELECT COUNT(DISTINCT run_id) AS n FROM extra_posts WHERE site_id = ? AND auto = 1 AND date(created_at) = date('now')",
      siteId,
    )?.n ?? 0
  );
}

/** A recipe whose last automatic attempt failed in the past day is left alone, so a broken one does not loop. */
function failedRecently(sourceRunId: number): boolean {
  return Boolean(
    get(
      "SELECT 1 AS x FROM extra_posts WHERE source_run_id = ? AND auto = 1 AND status = 'failed' AND created_at >= datetime('now', '-1 day') LIMIT 1",
      sourceRunId,
    ),
  );
}

export interface AutoPick {
  sourceRunId: number;
  networks: Network[];
}

/** The recipe to post for next, or null when nothing is ready. */
export function pickAutoRecipe(settings: Settings, siteId: number, now = Date.now()): AutoPick | null {
  const site = getSite(siteId);
  if (!site) return null;
  let best: { pick: AutoPick; since: string } | null = null;
  for (const recipe of listPublishedRecipes(siteId, 500)) {
    const states = networkStates(settings, site, recipe.runId, now).filter((s) => NETWORKS.includes(s.network));
    const ready = states.filter((s) => s.ready);
    if (ready.length === 0 || failedRecently(recipe.runId)) continue;
    // The most recent post on any network it would reach: the recipe untouched longest goes first.
    const since = ready.map((s) => s.lastAt ?? '').sort().pop() ?? '';
    if (!best || since < best.since) best = { pick: { sourceRunId: recipe.runId, networks: ready.map((s) => s.network) }, since };
  }
  return best?.pick ?? null;
}

export async function tickExtraAuto(
  settings: Settings,
  key: Buffer,
  lock: { tryLock: () => boolean; unlock: () => void },
): Promise<void> {
  if (!settings.getBool('automation_enabled') || !settings.getBool('extra_auto_enabled')) return;
  const cap = Math.max(0, Math.floor(settings.getNumber('extra_auto_per_day')));
  for (const s of listSites()) {
    const site = getSite(s.id);
    if (!site || site.status !== 'active' || autoBatchesToday(site.id) >= cap) continue;
    const pick = pickAutoRecipe(settings, site.id);
    if (!pick) continue;
    if (!lock.tryLock()) return; // a recipe run, a blog article or a taxonomy page is in progress
    try {
      const report = await makeExtraPosts({ ...pick, angle: 'auto', auto: true }, settings, key);
      log.info(`${site.domain}: automatic More posts for run ${pick.sourceRunId} — ${report.outcomes.map((o) => `${o.network} ${o.ok ? 'ok' : 'failed'}`).join(', ')}`);
    } catch (err) {
      log.warn(`${site.domain}: automatic More posts for run ${pick.sourceRunId} failed — ${errorMessage(err)}`);
    } finally {
      lock.unlock();
    }
    return; // one batch per tick; the next tick takes the next site
  }
}
