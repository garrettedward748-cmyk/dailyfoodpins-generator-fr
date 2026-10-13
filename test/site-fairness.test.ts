import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import {
  createRun,
  insertKeyword,
  loadKeywordViews,
  loadLinkViews,
  loadSiteViews,
  markRunFailed,
  markRunPublished,
  setLink,
  upsertSite,
} from '../src/db/repos.js';
import { localDateKey, selectTask } from '../src/core/selector.js';

const TZ = 'Africa/Algiers';
const KEY = randomBytes(32);

const site = (domain: string, over: Record<string, unknown> = {}): number =>
  upsertSite(
    {
      name: domain.split('.')[0]!,
      domain,
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 10,
      interval_minutes: 0,
      ...over,
    } as Parameters<typeof upsertSite>[0],
    KEY,
  );

const select = () => {
  const now = new Date();
  return selectTask(
    loadSiteViews(localDateKey(now, TZ), TZ),
    loadKeywordViews(),
    loadLinkViews(),
    { now, timezone: TZ },
  );
};

/** Nudge a run's timestamps into the past so ordering is deterministic. */
function age(runId: number, seconds: number): void {
  run(
    `UPDATE runs SET started_at = datetime('now', ?), published_at =
       CASE WHEN published_at IS NULL THEN NULL ELSE datetime('now', ?) END
     WHERE id = ?`,
    `-${seconds} seconds`,
    `-${seconds} seconds`,
    runId,
  );
}

describe('sites take turns', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  /**
   * The reported bug. Turn order keyed on the last *publish*, and a site that
   * fails never publishes — so its timestamp never moved, it sorted first
   * forever, and it took every tick while the other sites never ran at all.
   * One broken site stopped the whole network.
   */
  it('REGRESSION: a site that keeps failing does not take every turn', () => {
    const broken = site('broken.com');
    const healthy = site('healthy.com');

    for (let i = 0; i < 6; i++) {
      const keyword = insertKeyword({ seed_keyword: `k${i}`, status: 'go' });
      setLink(keyword, broken, 'go');
      setLink(keyword, healthy, 'go');
    }

    const picked: string[] = [];
    for (let tick = 0; tick < 6; tick++) {
      const { task } = select();
      if (!task) break;
      picked.push(task.siteDomain);

      // Every run on the broken site fails; the healthy one publishes.
      const runId = createRun(task.keywordId, task.siteId);
      if (task.siteDomain === 'broken.com') {
        markRunFailed(runId, 'HTTP 500', 'post-article');
      } else {
        markRunPublished(runId, `p${tick}`, `https://healthy.com/${tick}`);
        setLink(task.keywordId, task.siteId, 'done');
      }
      age(runId, 6 - tick);
    }

    expect(picked).toContain('healthy.com');
    expect(picked.filter((d) => d === 'healthy.com').length).toBeGreaterThan(1);
  });

  it('alternates between two healthy sites rather than draining one', () => {
    const a = site('a.com');
    const b = site('b.com');

    for (let i = 0; i < 4; i++) {
      const keyword = insertKeyword({ seed_keyword: `k${i}`, status: 'go' });
      setLink(keyword, a, 'go');
      setLink(keyword, b, 'go');
    }

    const picked: string[] = [];
    for (let tick = 0; tick < 4; tick++) {
      const { task } = select();
      if (!task) break;
      picked.push(task.siteDomain);
      const runId = createRun(task.keywordId, task.siteId);
      markRunPublished(runId, `p${tick}`, `https://x/${tick}`);
      setLink(task.keywordId, task.siteId, 'done');
      age(runId, 4 - tick);
    }

    expect(new Set(picked).size).toBe(2);
  });

  it('gives a site that has never run the first turn', () => {
    const established = site('old.com');
    const keyword = insertKeyword({ seed_keyword: 'k', status: 'go' });
    setLink(keyword, established, 'go');
    age(createRun(keyword, established), 60);

    const fresh = site('new.com');
    setLink(keyword, fresh, 'go');

    expect(select().task?.siteDomain).toBe('new.com');
  });

  it('lets site turn order beat keyword order', () => {
    // A keyword linked only to one site used to hand that site the tick
    // regardless of whose turn it was, because the first keyword with any
    // candidate won.
    const busy = site('busy.com');
    const waiting = site('waiting.com');

    const firstKeyword = insertKeyword({ seed_keyword: 'aaa-first', status: 'go' });
    setLink(firstKeyword, busy, 'go');

    const secondKeyword = insertKeyword({ seed_keyword: 'zzz-second', status: 'go' });
    setLink(secondKeyword, waiting, 'go');

    // busy.com ran a moment ago; waiting.com never has.
    age(createRun(firstKeyword, busy), 5);

    expect(select().task?.siteDomain).toBe('waiting.com');
  });

  it('still respects the daily target while taking turns', () => {
    const a = site('a.com', { daily_target: 1 });
    const b = site('b.com', { daily_target: 5 });

    for (let i = 0; i < 3; i++) {
      const keyword = insertKeyword({ seed_keyword: `k${i}`, status: 'go' });
      setLink(keyword, a, 'go');
      setLink(keyword, b, 'go');
    }

    const first = select().task!;
    const runId = createRun(first.keywordId, first.siteId);
    markRunPublished(runId, 'p', 'https://x/1');
    setLink(first.keywordId, first.siteId, 'done');
    age(runId, 3);

    // Whichever ran first, a.com is now finished for the day if it was a.com.
    for (let tick = 0; tick < 4; tick++) {
      const { task } = select();
      if (!task) break;
      const id = createRun(task.keywordId, task.siteId);
      markRunPublished(id, `p${tick}`, `https://x/${tick}`);
      setLink(task.keywordId, task.siteId, 'done');
      age(id, 2);
    }

    const views = loadSiteViews(localDateKey(new Date(), TZ), TZ);
    expect(views.find((v) => v.domain === 'a.com')?.publishedToday).toBeLessThanOrEqual(1);
  });

  it('records the last attempt whether the run succeeded or failed', () => {
    const a = site('a.com');
    const keyword = insertKeyword({ seed_keyword: 'k', status: 'go' });
    setLink(keyword, a, 'go');

    markRunFailed(createRun(keyword, a), 'boom', 'post-article');

    const view = loadSiteViews(localDateKey(new Date(), TZ), TZ)[0]!;
    expect(view.lastAttemptAt).not.toBeNull();
    // A failure is an attempt, not a publication — that distinction is the fix.
    expect(view.lastPublishAt).toBeNull();
  });
});
