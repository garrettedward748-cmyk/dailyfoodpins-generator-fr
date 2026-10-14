import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { addPastedKeywords, researchRepeats, upsertSite } from '../src/db/repos.js';
import { expireAutoAdded } from '../src/research/auto.js';
import { setLogLevel } from '../src/lib/logger.js';

/** A keyword taken by one site is still free for the others. */

const KEY = randomBytes(32);
let a: number;
let b: number;
const mk = (domain: string) => upsertSite({ name: domain, domain, status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
const linksOf = (title: string) =>
  all<{ site_id: number; status: string }>(
    'SELECT ks.site_id, ks.status FROM keyword_sites ks JOIN keywords k ON k.id = ks.keyword_id WHERE k.spy_title = ? ORDER BY ks.site_id',
    title,
  );

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  a = mk('a.com');
  b = mk('b.com');
});
afterEach(() => closeDatabase());

describe('repeats per site', () => {
  it('counts a keyword as a repeat only for the sites that have it', () => {
    addPastedKeywords(['Banana Pudding Cups'], 'banana', [a]);
    expect(researchRepeats([a]).here).toEqual(['Banana Pudding Cups']);
    expect(researchRepeats([b])).toEqual({ here: [], elsewhere: [{ title: 'Banana Pudding Cups', where: 'a.com' }] });
    // Ticked on both: b still lacks it, so it is not a repeat.
    expect(researchRepeats([a, b]).here).toEqual([]);
  });

  it('links an existing keyword to a new site instead of skipping it', () => {
    addPastedKeywords(['Banana Pudding Cups'], 'banana', [a]);
    const r = addPastedKeywords(['banana pudding cups'], 'banana', [b]);
    expect(r).toMatchObject({ added: 0, linked: 1, skipped: 0 });
    expect(get<{ n: number }>('SELECT COUNT(*) AS n FROM keywords')!.n).toBe(1);
    expect(linksOf('Banana Pudding Cups')).toEqual([
      { site_id: a, status: 'go' },
      { site_id: b, status: 'go' },
    ]);
    // Now on both: a repeat for either.
    expect(addPastedKeywords(['Banana Pudding Cups'], 'banana', [a, b])).toMatchObject({ added: 0, linked: 0, skipped: 1 });
  });

  it('opens a keyword finished on its other site again for the new one', () => {
    addPastedKeywords(['Lemon Bars'], 'lemon', [a]);
    run("UPDATE keywords SET status = 'done'");
    run("UPDATE keyword_sites SET status = 'done'");
    addPastedKeywords(['Lemon Bars'], 'lemon', [b]);
    expect(get<{ status: string }>('SELECT status FROM keywords')!.status).toBe('go');
    expect(linksOf('Lemon Bars')).toEqual([
      { site_id: a, status: 'done' },
      { site_id: b, status: 'go' },
    ]);
  });

  it('keeps a keyword turned down for all sites out', () => {
    addPastedKeywords(['Lemon Bars'], 'lemon', [a]);
    run("UPDATE keywords SET status = 'no'");
    expect(addPastedKeywords(['Lemon Bars'], 'lemon', [b])).toMatchObject({ linked: 0, skipped: 1 });
    expect(researchRepeats([b]).here).toEqual(['Lemon Bars']);
  });

  it('expires only the site that daily research added it to', () => {
    addPastedKeywords(['Lemon Bars'], 'lemon', [a]);
    addPastedKeywords(['Lemon Bars'], 'lemon', [b], { auto: true });
    run("UPDATE keyword_sites SET auto_added_at = datetime('now', '-30 hours') WHERE auto_added_at IS NOT NULL");
    expect(expireAutoAdded(b, 24).keywords).toBe(1);
    expect(linksOf('Lemon Bars')).toEqual([{ site_id: a, status: 'go' }]);
  });
});
