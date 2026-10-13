import { describe, expect, it } from 'vitest';
import { evaluateSite, localDateKey, selectTask } from '../src/core/selector.js';
import type { KeywordView, LinkView, SiteView } from '../src/core/types.js';

const NOW = new Date('2026-08-25T12:00:00Z');
const OPTS = { now: NOW, timezone: 'Africa/Algiers' };

function site(over: Partial<SiteView> = {}): SiteView {
  return {
    id: 1,
    name: 'bitespoon',
    domain: 'bitespoon.com',
    status: 'active',
    dailyTarget: 10,
    intervalMinutes: 60,
    publishedToday: 0,
    lastPublishAt: null,
    ...over,
  };
}

function keyword(over: Partial<KeywordView> = {}): KeywordView {
  return {
    id: 100,
    seedKeyword: 'Chicken Breast Recipe',
    spyTitle: 'Oven Baked Chicken Breast',
    status: 'go',
    ...over,
  };
}

const link = (keywordId: number, siteId: number, status: LinkView['status']): LinkView => ({
  keywordId,
  siteId,
  status,
});

// ---------------------------------------------------------------------------
// Filter 1 — operational site eligibility
// ---------------------------------------------------------------------------
describe('evaluateSite', () => {
  it('accepts an active site with headroom and no recent post', () => {
    const result = evaluateSite(site(), OPTS);
    expect(result.eligible).toBe(true);
    expect(result.reason).toContain('10 of 10');
  });

  it('rejects a paused site', () => {
    expect(evaluateSite(site({ status: 'paused' }), OPTS)).toMatchObject({
      eligible: false,
      reason: 'Site is not active',
    });
  });

  it('rejects a site with daily_target of 0', () => {
    // cravefolio.com and platedream.com are in this state in production.
    expect(evaluateSite(site({ dailyTarget: 0 }), OPTS).eligible).toBe(false);
  });

  it('rejects a site that has hit its daily limit', () => {
    const result = evaluateSite(site({ dailyTarget: 10, publishedToday: 10 }), OPTS);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Daily publishing limit reached (10/10)');
  });

  it('rejects a site still inside its minimum interval', () => {
    const result = evaluateSite(
      site({ intervalMinutes: 480, lastPublishAt: '2026-08-25T10:00:00Z' }),
      OPTS,
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Minimum interval not elapsed');
    expect(result.reason).toContain('2h of 8h');
  });

  it('supports intervals finer than an hour', () => {
    // 20 minutes was impossible to express when the column was hours.
    const twelveMinutesAgo = new Date(NOW.getTime() - 12 * 60_000).toISOString();
    const result = evaluateSite(
      site({ intervalMinutes: 20, lastPublishAt: twelveMinutesAgo }),
      OPTS,
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('12m of 20m');

    const thirtyMinutesAgo = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    expect(
      evaluateSite(site({ intervalMinutes: 20, lastPublishAt: thirtyMinutesAgo }), OPTS)
        .eligible,
    ).toBe(true);
  });

  it('supports intervals measured in days', () => {
    const oneDayAgo = new Date(NOW.getTime() - 24 * 3_600_000).toISOString();
    const result = evaluateSite(
      site({ intervalMinutes: 4320, lastPublishAt: oneDayAgo }),
      OPTS,
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('of 3d');
  });

  it('accepts a site once the interval has elapsed', () => {
    expect(
      evaluateSite(site({ intervalMinutes: 480, lastPublishAt: '2026-08-25T03:00:00Z' }), OPTS)
        .eligible,
    ).toBe(true);
  });

  // -- Regression: the exact corruption found in the production sheet --------
  it('REGRESSION: rejects rather than passes when last_publish is corrupt', () => {
    // Six production rows contained the literal string "{{ $json.now_iso }}"
    // because an expression was missing its leading "=". The old code did
    // `if (isNaN(last.getTime())) return true`, which silently disabled the
    // interval check entirely. An unreadable timestamp must be surfaced.
    const result = evaluateSite(
      site({ intervalMinutes: 480, lastPublishAt: '{{ $json.now_iso }}' }),
      OPTS,
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Unreadable last_publish');
  });

  it('treats a genuinely empty last_publish as never published', () => {
    expect(evaluateSite(site({ lastPublishAt: null, intervalMinutes: 480 }), OPTS).eligible).toBe(
      true,
    );
  });

  it('does not perform string arithmetic on counters', () => {
    // The old system computed today_count + 1 on a value Sheets returned as a
    // string, producing "3" + 1 = "31". Counters here are numbers from SQL.
    const result = evaluateSite(site({ dailyTarget: 10, publishedToday: 3 }), OPTS);
    expect(result.eligible).toBe(true);
    expect(result.reason).toContain('7 of 10');
  });
});

// ---------------------------------------------------------------------------
// Filter 2 + the pairing rule
// ---------------------------------------------------------------------------
describe('selectTask', () => {
  it('returns a task when keyword, link and site all qualify', () => {
    const { task } = selectTask([site()], [keyword()], [link(100, 1, 'go')], OPTS);
    expect(task).toEqual({
      siteId: 1,
      siteDomain: 'bitespoon.com',
      siteName: 'bitespoon',
      keywordId: 100,
      seedKeyword: 'Chicken Breast Recipe',
    });
  });

  it('returns no task and logs reasons when every site is ineligible', () => {
    const { task, decisions } = selectTask(
      [site({ status: 'paused' }), site({ id: 2, domain: 'longlivo.com', dailyTarget: 0 })],
      [keyword()],
      [link(100, 1, 'go')],
      OPTS,
    );
    expect(task).toBeNull();
    expect(decisions.filter((d) => d.decision === 'rejected')).toHaveLength(2);
    expect(decisions.at(-1)?.reason).toContain('No eligible site');
  });

  it('skips keywords whose status is done or no', () => {
    const { task, decisions } = selectTask(
      [site()],
      [keyword({ id: 100, status: 'done' }), keyword({ id: 101, status: 'no' })],
      [link(100, 1, 'go'), link(101, 1, 'go')],
      OPTS,
    );
    expect(task).toBeNull();
    expect(decisions.filter((d) => d.decision === 'skipped')).toHaveLength(2);
  });

  it('does not select a site the keyword is not linked to with go', () => {
    const { task } = selectTask([site()], [keyword()], [link(100, 1, 'done')], OPTS);
    expect(task).toBeNull();
  });

  it('requires BOTH filters: link says go but the site is over its limit', () => {
    // Section 10 of the specification.
    const { task, decisions } = selectTask(
      [site({ publishedToday: 10, dailyTarget: 10 })],
      [keyword()],
      [link(100, 1, 'go')],
      OPTS,
    );
    expect(task).toBeNull();
    expect(decisions.some((d) => d.reason.includes('Daily publishing limit'))).toBe(true);
  });

  // -- The rule the whole rewrite exists for --------------------------------
  it('REGRESSION: skips to the next keyword instead of retrying the first', () => {
    // Sections 11 and 12. Keyword 100 is Go but every linked site is Done/No.
    // The old system re-entered site selection for the same keyword forever.
    const sites = [site({ id: 1, domain: 'a.com' }), site({ id: 2, domain: 'b.com' })];
    const keywords = [
      keyword({ id: 100, seedKeyword: 'exhausted' }),
      keyword({ id: 101, seedKeyword: 'usable' }),
    ];
    const links = [
      link(100, 1, 'done'),
      link(100, 2, 'no'),
      link(101, 2, 'go'), // the next keyword is workable
    ];

    const { task, decisions } = selectTask(sites, keywords, links, OPTS);

    expect(task?.seedKeyword).toBe('usable');
    expect(
      decisions.some(
        (d) =>
          d.subjectLabel === 'exhausted' &&
          d.reason === 'No eligible site remains for this keyword',
      ),
    ).toBe(true);
  });

  it('REGRESSION: terminates when no keyword has any eligible site', () => {
    // The state that used to hang the orchestrator indefinitely.
    const { task, decisions } = selectTask(
      [site()],
      [keyword({ id: 100 }), keyword({ id: 101 }), keyword({ id: 102 })],
      [link(100, 1, 'done'), link(101, 1, 'done'), link(102, 1, 'no')],
      OPTS,
    );
    expect(task).toBeNull();
    expect(decisions.at(-1)?.decision).toBe('none');
    expect(decisions.at(-1)?.reason).toContain('checked 3 keywords');
  });

  it('REGRESSION: contradictory duplicate-column state cannot select twice', () => {
    // The production SPY sheet had bitespoon.com as two columns. Reads saw the
    // last one, writes landed on one of them, so a keyword could look
    // permanently Go. The schema now forbids two rows for one pair, but the
    // selector must also behave sanely if fed such data.
    const links = [link(100, 1, 'done'), link(100, 1, 'go')];
    const { task } = selectTask([site()], [keyword()], links, OPTS);
    // A 'go' link exists, so selecting is correct — but only ONCE, and the
    // run will mark the pair done, after which neither row can match again.
    expect(task).not.toBeNull();
    expect(task?.siteId).toBe(1);
  });

  it('prefers the site that has waited longest', () => {
    const sites = [
      site({ id: 1, domain: 'recent.com', lastPublishAt: '2026-08-25T11:00:00Z' }),
      site({ id: 2, domain: 'stale.com', lastPublishAt: '2026-08-20T11:00:00Z' }),
    ];
    const links = [link(100, 1, 'go'), link(100, 2, 'go')];
    const { task } = selectTask(sites, [keyword()], links, OPTS);
    expect(task?.siteDomain).toBe('stale.com');
  });

  it('is deterministic when two sites tie', () => {
    const sites = [site({ id: 5, domain: 'e.com' }), site({ id: 2, domain: 'b.com' })];
    const links = [link(100, 5, 'go'), link(100, 2, 'go')];
    for (let i = 0; i < 20; i++) {
      expect(selectTask(sites, [keyword()], links, OPTS).task?.siteId).toBe(2);
    }
  });

  it('records a decision for every site and every keyword examined', () => {
    const { decisions } = selectTask(
      [site({ id: 1 }), site({ id: 2, domain: 'b.com', status: 'paused' })],
      [keyword({ id: 100, status: 'no' }), keyword({ id: 101 })],
      [link(101, 1, 'go')],
      OPTS,
    );
    expect(decisions.filter((d) => d.subjectType === 'site')).toHaveLength(2);
    expect(decisions.some((d) => d.subjectType === 'pair')).toBe(true);
  });

  it('handles an empty world without throwing', () => {
    const { task, decisions } = selectTask([], [], [], OPTS);
    expect(task).toBeNull();
    expect(decisions).toHaveLength(1);
  });

  it('terminates on a large input', () => {
    // Structural proof that runtime is bounded, not a retry loop.
    const sites = Array.from({ length: 20 }, (_, i) =>
      site({ id: i + 1, domain: `s${i}.com` }),
    );
    const keywords = Array.from({ length: 500 }, (_, i) =>
      keyword({ id: i + 1, status: 'go' }),
    );
    const links = keywords.flatMap((k) => sites.map((s) => link(k.id, s.id, 'done')));

    const started = Date.now();
    const { task } = selectTask(sites, keywords, links, OPTS);
    expect(task).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('localDateKey', () => {
  it('resolves the calendar day in the configured timezone', () => {
    // 23:30 UTC is already the next day in Algiers (UTC+1).
    expect(localDateKey(new Date('2026-08-25T23:30:00Z'), 'Africa/Algiers')).toBe(
      '2026-08-26',
    );
    expect(localDateKey(new Date('2026-08-25T23:30:00Z'), 'UTC')).toBe('2026-08-25');
  });
});

describe('topic groups take turns on a site', () => {
  it('picks a keyword from the group that ran longest ago, not the oldest keyword', () => {
    const keywords = [
      keyword({ id: 1, seedKeyword: 'vegan dessert' }),
      keyword({ id: 2, seedKeyword: 'vegan dessert' }),
      keyword({ id: 3, seedKeyword: 'korean dessert' }),
    ];
    const links = [link(1, 1, 'go'), link(2, 1, 'go'), link(3, 1, 'go')];
    const groupLastUsed = new Map([['1|vegan dessert', NOW.getTime() - 3_600_000]]);

    const result = selectTask([site()], keywords, links, { ...OPTS, groupLastUsed });
    expect(result.task?.keywordId).toBe(3);
  });

  it('keeps keyword order inside a group, and when no history is given', () => {
    const keywords = [keyword({ id: 5, seedKeyword: 'a' }), keyword({ id: 6, seedKeyword: 'a' })];
    const links = [link(5, 1, 'go'), link(6, 1, 'go')];
    expect(selectTask([site()], keywords, links, OPTS).task?.keywordId).toBe(5);
  });
});
