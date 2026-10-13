import { get } from '../db/index.js';

/**
 * How much work is left in the queue, and how long it lasts.
 *
 * "Keywords ready" on its own was never the useful number. A keyword set to
 * `go` that is not linked to any active site is not work — it looks like
 * supply and produces nothing. What matters is the count of *pairs* that could
 * actually run, measured against how fast the sites consume them.
 *
 * The failure this exists to prevent is quiet: the queue empties, every tick
 * finds nothing, and the platform sits there looking healthy while publishing
 * stops. Nothing errors, so nothing tells you.
 */

export interface Supply {
  /** Keyword-and-site pairs that could run: keyword go, link go, site active. */
  readyPairs: number;
  /** Articles the active sites would publish in a day at their current targets. */
  dailyDemand: number;
  /** Days of work left, or null when nothing is configured to consume it. */
  daysRemaining: number | null;
  level: 'empty' | 'low' | 'ok';
}

/** Below this many days remaining, it is worth saying something. */
export const LOW_SUPPLY_DAYS = 3;

export function readSupply(): Supply {
  const readyPairs =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM keyword_sites ks
         JOIN keywords k ON k.id = ks.keyword_id
         JOIN sites s    ON s.id = ks.site_id
        WHERE ks.status = 'go'
          AND k.status  = 'go'
          AND s.status  = 'active'
          AND s.daily_target > 0`,
    )?.n ?? 0;

  const dailyDemand =
    get<{ n: number }>(
      `SELECT COALESCE(SUM(daily_target), 0) AS n FROM sites WHERE status = 'active'`,
    )?.n ?? 0;

  // No demand means no runway to run out of. A platform with every site paused
  // is idle on purpose, and warning about it would be noise.
  const daysRemaining = dailyDemand > 0 ? readyPairs / dailyDemand : null;

  const level: Supply['level'] =
    readyPairs === 0
      ? 'empty'
      : daysRemaining !== null && daysRemaining < LOW_SUPPLY_DAYS
        ? 'low'
        : 'ok';

  return { readyPairs, dailyDemand, daysRemaining, level };
}

/** One sentence an operator can act on, or null when there is nothing to say. */
export function supplyWarning(supply: Supply): string | null {
  if (supply.level === 'ok') return null;

  if (supply.level === 'empty') {
    return supply.dailyDemand === 0
      ? 'No keyword is ready to run, and no active site has a daily target. Nothing will publish.'
      : 'No keyword is ready to run on any active site. Publishing has stopped until you add some — import a CSV under Keywords.';
  }

  const days = supply.daysRemaining ?? 0;
  const rounded = days < 1 ? days.toFixed(1) : String(Math.floor(days));
  return (
    `Only ${supply.readyPairs} keyword-site pair(s) left, about ${rounded} day(s) ` +
    `at ${supply.dailyDemand} article(s) a day. Add more before it runs dry.`
  );
}
