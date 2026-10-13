import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run as dbRun } from '../src/db/index.js';
import {
  blockLink,
  consecutiveFailuresForPair,
  createRun,
  insertKeyword,
  listBlockedPairs,
  loadLinkViews,
  markRunFailed,
  markRunHeld,
  markRunPublished,
  setLink,
  unblockLink,
  upsertSite,
} from '../src/db/repos.js';
import { selectTask } from '../src/core/selector.js';
import { diagnoseKeyword } from '../src/core/diagnosis.js';
import { setLogLevel } from '../src/lib/logger.js';
import type { SiteView } from '../src/core/types.js';

/**
 * A pair that cannot publish must stop taking the site's slot.
 *
 * Nothing marked a keyword-site pair as tried-and-hopeless: the link stayed
 * 'go' after a failure, so the selector offered it again the next time the
 * site came up, it failed the same way, and the site's daily target went on
 * being spent on a known failure.
 */

const KEY = randomBytes(32);

const seed = () => {
  const siteId = upsertSite(
    {
      name: 'bitespoon',
      domain: 'bitespoon.com',
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 5,
      interval_minutes: 0,
    },
    KEY,
  );
  const keywordId = insertKeyword({
    seed_keyword: 'chicken thighs',
    spy_title: 'Honey Soy Chicken Thighs',
    status: 'go',
  });
  setLink(keywordId, siteId, 'go');
  return { siteId, keywordId };
};

const fail = (keywordId: number, siteId: number, error = 'HTTP 422: validation failed'): number => {
  const runId = createRun(keywordId, siteId);
  markRunFailed(runId, error, 'post-article');
  return runId;
};

const siteView = (siteId: number): SiteView => ({
  id: siteId,
  name: 'bitespoon',
  domain: 'bitespoon.com',
  status: 'active',
  dailyTarget: 5,
  intervalMinutes: 0,
  publishedToday: 0,
  lastPublishAt: null,
  lastAttemptAt: null,
});

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
});

afterEach(() => {
  closeDatabase();
});

describe('counting what actually counts', () => {
  it('counts the failures since the pair last got somewhere', () => {
    const { siteId, keywordId } = seed();

    fail(keywordId, siteId);
    fail(keywordId, siteId);
    expect(consecutiveFailuresForPair(keywordId, siteId)).toBe(2);
  });

  it('starts again from a success', () => {
    // A pair that published fine and then failed twice is not a hopeless pair.
    const { siteId, keywordId } = seed();

    fail(keywordId, siteId);
    fail(keywordId, siteId);
    markRunPublished(createRun(keywordId, siteId), 'https://bitespoon.com/x', 'Done');
    fail(keywordId, siteId);

    expect(consecutiveFailuresForPair(keywordId, siteId)).toBe(1);
  });

  it('treats an article held for approval as getting somewhere', () => {
    // The doubt is whether the pair can produce an article at all, and a held
    // run is an article sitting there waiting to be read.
    const { siteId, keywordId } = seed();

    fail(keywordId, siteId);
    fail(keywordId, siteId);
    markRunHeld(createRun(keywordId, siteId), 'awaiting', 'Honey Soy Chicken Thighs');

    expect(consecutiveFailuresForPair(keywordId, siteId)).toBe(0);
  });

  it('does not count another pair on the same site', () => {
    const { siteId, keywordId } = seed();
    const other = insertKeyword({ seed_keyword: 'beef stew', spy_title: 'Beef Stew', status: 'go' });
    setLink(other, siteId, 'go');

    fail(keywordId, siteId);
    fail(other, siteId);
    fail(other, siteId);

    expect(consecutiveFailuresForPair(keywordId, siteId)).toBe(1);
    expect(consecutiveFailuresForPair(other, siteId)).toBe(2);
  });
});

describe('a blocked pair', () => {
  it('is skipped by the selector while its status stays go', () => {
    const { siteId, keywordId } = seed();
    blockLink(keywordId, siteId, 'Failed 3 times in a row');

    const links = loadLinkViews();
    expect(links[0]!.status).toBe('go');
    expect(links[0]!.blocked).toBe(true);

    const { task } = selectTask(
      [siteView(siteId)],
      [{ id: keywordId, seedKeyword: 'chicken thighs', spyTitle: '', status: 'go' }],
      links,
      { now: new Date(), timezone: 'UTC' },
    );

    expect(task).toBeNull();
  });

  it('leaves the pair choosable again once cleared', () => {
    const { siteId, keywordId } = seed();
    blockLink(keywordId, siteId, 'Failed 3 times in a row');
    unblockLink(keywordId, siteId);

    const { task } = selectTask(
      [siteView(siteId)],
      [{ id: keywordId, seedKeyword: 'chicken thighs', spyTitle: '', status: 'go' }],
      loadLinkViews(),
      { now: new Date(), timezone: 'UTC' },
    );

    expect(task?.keywordId).toBe(keywordId);
  });

  it('says on the keyword page why, and that it is waiting for a person', () => {
    const { siteId, keywordId } = seed();
    blockLink(keywordId, siteId, 'Failed 3 times in a row. Last error: HTTP 422');

    const diagnosis = diagnoseKeyword(
      { id: keywordId, seedKeyword: 'chicken thighs', status: 'go' },
      [siteView(siteId)],
      [{ siteId, status: 'go', blocked: true, blockedReason: 'Failed 3 times in a row.' }],
      { now: new Date(), timezone: 'UTC' },
    );

    const verdict = diagnosis.sites[0]!;
    expect(verdict.ready).toBe(false);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain('Held back');
    expect(verdict.reason).toContain('Failed 3 times');
  });

  it('is listed with its keyword and site, for a page that shows them together', () => {
    const { siteId, keywordId } = seed();
    blockLink(keywordId, siteId, 'Failed 3 times in a row');

    const [pair] = listBlockedPairs();
    expect(pair?.seedKeyword).toBe('chicken thighs');
    expect(pair?.domain).toBe('bitespoon.com');
    expect(pair?.blockedReason).toContain('Failed 3 times');
  });

  it('does not block a pair a person set to no', () => {
    // Blocking writes its own field. Overloading 'no' would make a decision
    // and a surrender indistinguishable, and clearing one would mean guessing.
    const { siteId, keywordId } = seed();
    setLink(keywordId, siteId, 'no');
    blockLink(keywordId, siteId, 'Failed 3 times in a row');

    expect(loadLinkViews()[0]!.status).toBe('no');
    unblockLink(keywordId, siteId);
    expect(loadLinkViews()[0]!.status).toBe('no');
  });
});

describe('the old data', () => {
  it('treats a link that predates blocking as not blocked', () => {
    const { siteId, keywordId } = seed();
    dbRun('UPDATE keyword_sites SET blocked_at = NULL, blocked_reason = NULL');

    expect(loadLinkViews()[0]!.blocked).toBe(false);
    expect(listBlockedPairs()).toEqual([]);
    void keywordId;
    void siteId;
  });
});
