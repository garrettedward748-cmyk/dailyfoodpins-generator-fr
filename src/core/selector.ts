import type {
  Decision,
  KeywordView,
  LinkView,
  SelectionResult,
  SiteView,
} from './types.js';

/**
 * The selector: given the current state of the world, produce at most one
 * valid publishing task and a full account of how that conclusion was reached.
 *
 * This function is deliberately pure. No database, no HTTP, no `new Date()` —
 * `now` is a parameter. Three arrays in, a decision out. That is what makes it
 * testable, and being testable is what makes the system supportable.
 *
 * TERMINATION IS STRUCTURAL. This is a bounded iteration over a finite list
 * with no back edge. The system it replaces looped forever because a node
 * wired back to an earlier node while re-reading the same first row; there is
 * no equivalent here because there is nowhere to loop back to. The rule from
 * section 12 of the specification — "if no eligible site remains for this
 * keyword, skip it and move to the next" — is not enforced by a counter, it
 * is simply what `continue` does.
 */

export interface SelectorOptions {
  /** Treat `now` as the reference time for interval and daily-window checks. */
  now: Date;
  /** IANA timezone used to decide which calendar day "today" refers to. */
  timezone: string;
  /**
   * When each topic group last ran on each site, as ms, keyed
   * `${siteId}|${group in lower case}`. Missing: never.
   */
  groupLastUsed?: Map<string, number>;
}

export const groupKey = (siteId: number, seedKeyword: string): string =>
  `${siteId}|${seedKeyword.trim().toLowerCase()}`;

/** Format a Date as YYYY-MM-DD in the given IANA timezone. */
export function localDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Minutes elapsed between two instants; null when `since` is unusable. */
function minutesSince(since: string | null, now: Date): number | null {
  if (!since) return null;

  const parsed = new Date(since);
  if (Number.isNaN(parsed.getTime())) {
    // The old system wrote the literal string "{{ $json.now_iso }}" here and
    // then treated the unparseable result as "interval satisfied", silently
    // disabling rate limiting. We treat it as a data problem instead.
    return null;
  }

  return (now.getTime() - parsed.getTime()) / 60_000;
}

/** Render a minute count the way a person would say it. */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface SiteEligibility {
  site: SiteView;
  eligible: boolean;
  reason: string;
}

/**
 * Filter 1 of the specification: is this site able to publish right now,
 * on purely operational grounds?
 */
export function evaluateSite(site: SiteView, options: SelectorOptions): SiteEligibility {
  const reject = (reason: string): SiteEligibility => ({ site, eligible: false, reason });

  if (site.status !== 'active') {
    return reject('Site is not active');
  }

  if (site.dailyTarget <= 0) {
    return reject('Daily target is 0');
  }

  const remaining = site.dailyTarget - site.publishedToday;
  if (remaining <= 0) {
    return reject(
      `Daily publishing limit reached (${site.publishedToday}/${site.dailyTarget})`,
    );
  }

  const elapsed = minutesSince(site.lastPublishAt, options.now);

  if (site.lastPublishAt !== null && elapsed === null) {
    // Explicitly a rejection, not a free pass. An unreadable timestamp is a
    // problem to surface, not to ignore.
    return reject(`Unreadable last_publish value: ${JSON.stringify(site.lastPublishAt)}`);
  }

  const gap = gapAfter(site);
  if (elapsed !== null && elapsed < gap) {
    return reject(
      `Minimum interval not elapsed (${formatMinutes(Math.floor(elapsed))} of ` +
        `${formatMinutes(gap)}; ` +
        `${formatMinutes(Math.ceil(gap - elapsed))} remaining)`,
    );
  }

  return {
    site,
    eligible: true,
    reason: `${remaining} of ${site.dailyTarget} posts remaining today`,
  };
}

const timestamp = (value: string | null): number => {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Whose turn it is: the site that has waited longest since its last *attempt*.
 *
 * Attempt, not publish. This ordering used to key on lastPublishAt, and a site
 * that fails never publishes — so its timestamp never moved, it sorted first
 * on every tick forever, and it took every slot while the other sites never
 * ran at all. One broken site stopped the whole network.
 *
 * Ordering by attempt makes the sites independent: a site that just ran goes
 * to the back of the queue whether it succeeded or failed, so a permanently
 * broken site costs one tick per rotation instead of all of them.
 *
 * A site that has never run sorts first, which is what you want for a site
 * just added.
 */
function longestWaiting(a: SiteView, b: SiteView): number {
  const va = timestamp(a.lastAttemptAt);
  const vb = timestamp(b.lastAttemptAt);
  if (va !== vb) return va - vb;

  // Same attempt time (usually both never): fall back to publish time, then id
  // so the order is reproducible rather than dependent on row order.
  const pa = timestamp(a.lastPublishAt);
  const pb = timestamp(b.lastPublishAt);
  if (pa !== pb) return pa - pb;
  return a.id - b.id;
}

export function selectTask(
  sites: SiteView[],
  keywords: KeywordView[],
  links: LinkView[],
  options: SelectorOptions,
): SelectionResult {
  const decisions: Decision[] = [];

  // -- Filter 1: which sites can publish at all? -----------------------------
  const eligibleSites: SiteView[] = [];

  for (const site of sites) {
    const verdict = evaluateSite(site, options);

    decisions.push({
      subjectType: 'site',
      subjectId: site.id,
      subjectLabel: site.domain,
      decision: verdict.eligible ? 'eligible' : 'rejected',
      reason: verdict.reason,
    });

    if (verdict.eligible) eligibleSites.push(site);
  }

  if (eligibleSites.length === 0) {
    decisions.push({
      subjectType: 'cycle',
      subjectId: null,
      subjectLabel: '',
      decision: 'none',
      reason: `No eligible site (checked ${sites.length})`,
    });
    return { task: null, decisions };
  }

  const eligibleById = new Map(eligibleSites.map((s) => [s.id, s]));

  // Index the matrix once so the keyword loop stays linear.
  const linksByKeyword = new Map<number, LinkView[]>();
  for (const link of links) {
    const bucket = linksByKeyword.get(link.keywordId);
    if (bucket) bucket.push(link);
    else linksByKeyword.set(link.keywordId, [link]);
  }

  // -- Filter 2: which keyword can run, and on which of those sites? ---------
  const viable: { keyword: KeywordView; site: SiteView }[] = [];

  for (const keyword of keywords) {
    if (keyword.status !== 'go') {
      decisions.push({
        subjectType: 'keyword',
        subjectId: keyword.id,
        subjectLabel: keyword.seedKeyword,
        decision: 'skipped',
        reason: `Keyword status is '${keyword.status}'`,
      });
      continue;
    }

    const candidates = (linksByKeyword.get(keyword.id) ?? [])
      // A blocked pair is still 'go' — nobody decided against it — but it has
      // failed the same way often enough that offering it again would spend
      // the site's slot on a known failure. It waits for a person instead.
      .filter((link) => link.status === 'go' && !link.blocked)
      .map((link) => eligibleById.get(link.siteId))
      .filter((site): site is SiteView => site !== undefined)
      .sort(longestWaiting);

    if (candidates.length === 0) {
      // Section 11 and 12: do not retry this keyword, move to the next one.
      // This `continue` is the entire fix for the original infinite loop.
      decisions.push({
        subjectType: 'keyword',
        subjectId: keyword.id,
        subjectLabel: keyword.seedKeyword,
        decision: 'skipped',
        reason: 'No eligible site remains for this keyword',
      });
      continue;
    }

    // Every viable pair is collected rather than returning on the first one.
    // Returning early made keyword order decide which site ran, so a keyword
    // linked only to one site could hand that site every tick regardless of
    // whose turn it was. Whose turn it is has to be the site's property, not a
    // side effect of which keyword happens to be first in the list.
    viable.push({ keyword, site: candidates[0]! });
  }

  if (viable.length === 0) {
    decisions.push({
      subjectType: 'cycle',
      subjectId: null,
      subjectLabel: '',
      decision: 'none',
      reason: `No valid keyword + site pair (checked ${keywords.length} keywords)`,
    });
    return { task: null, decisions };
  }

  // Site turn order decides. Between pairs on the same site, the topic group
  // that has waited longest goes first, so a batch of keywords from one group
  // does not send every pin to the same board for days: the groups -- and
  // their boards -- take turns. Keyword order breaks what is left.
  const groupAge = (p: { keyword: KeywordView; site: SiteView }): number =>
    options.groupLastUsed?.get(groupKey(p.site.id, p.keyword.seedKeyword)) ?? 0;
  viable.sort(
    (a, b) =>
      longestWaiting(a.site, b.site) ||
      (a.site.id === b.site.id ? groupAge(a) - groupAge(b) : 0) ||
      a.keyword.id - b.keyword.id,
  );
  const { keyword, site: chosen } = viable[0]!;

  decisions.push({
    subjectType: 'pair',
    subjectId: keyword.id,
    subjectLabel: `${keyword.seedKeyword} → ${chosen.domain}`,
    decision: 'selected',
    reason: 'Keyword is go, site is go for this keyword, site is eligible, and it is its turn',
  });

  return {
    task: {
      siteId: chosen.id,
      siteDomain: chosen.domain,
      siteName: chosen.name,
      keywordId: keyword.id,
      seedKeyword: keyword.seedKeyword,
    },
    decisions,
  };
}

/**
 * The gap this site waits after its last post.
 *
 * With a range (intervalMaxMinutes above intervalMinutes) the gap is a random
 * length between the two, so posts do not land at clockwork times. It is
 * drawn from the site and the time of its last post rather than stored: every
 * tick until the next post gets the same answer, and a new post draws anew.
 */
export function gapAfter(site: Pick<SiteView, 'id' | 'intervalMinutes' | 'intervalMaxMinutes' | 'lastPublishAt'>): number {
  const min = Math.max(0, site.intervalMinutes);
  const max = site.intervalMaxMinutes ?? 0;
  if (max <= min || site.lastPublishAt === null) return min;
  // FNV-1a over "site|last post": spread evenly, the same every time.
  let h = 0x811c9dc5;
  for (const ch of `${site.id}|${site.lastPublishAt}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return min + (h % (max - min + 1));
}
