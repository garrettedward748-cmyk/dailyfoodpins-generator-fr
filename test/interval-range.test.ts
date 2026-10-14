import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { getSite, upsertSite } from '../src/db/repos.js';
import { gapAfter } from '../src/core/selector.js';

/** A gap given as a range: a random length between the two after each post. */

describe('gap between posts as a range', () => {
  const site = (last: string | null, max = 240) => ({ id: 7, intervalMinutes: 120, intervalMaxMinutes: max, lastPublishAt: last });

  it('stays inside the range and spreads across it', () => {
    const gaps = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const g = gapAfter(site(`2026-10-14T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:${String(i % 59).padStart(2, '0')}.000Z`));
      expect(g).toBeGreaterThanOrEqual(120);
      expect(g).toBeLessThanOrEqual(240);
      gaps.add(g);
    }
    expect(gaps.size).toBeGreaterThan(60);
  });

  it('gives the same gap for the same last post, so every check agrees', () => {
    const last = '2026-10-14T21:03:11.000Z';
    expect(gapAfter(site(last))).toBe(gapAfter(site(last)));
  });

  it('is the fixed gap without a range', () => {
    expect(gapAfter(site('2026-10-14T21:03:11.000Z', 0))).toBe(120);
    expect(gapAfter(site('2026-10-14T21:03:11.000Z', 100))).toBe(120);
    expect(gapAfter({ id: 7, intervalMinutes: 120, lastPublishAt: 'x' })).toBe(120);
  });
});

describe('storing the range', () => {
  const KEY = randomBytes(32);
  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  it('keeps the stored range when a form does not carry it', () => {
    const id = upsertSite({ name: 'a', domain: 'a.com', status: 'active', daily_target: 5, interval_minutes: 120, interval_max_minutes: 240 }, KEY);
    upsertSite({ name: 'a', domain: 'a.com', status: 'active', daily_target: 6, interval_minutes: 120 }, KEY, id);
    expect(getSite(id)!.interval_max_minutes).toBe(240);
    upsertSite({ name: 'a', domain: 'a.com', status: 'active', daily_target: 6, interval_minutes: 120, interval_max_minutes: 0 }, KEY, id);
    expect(getSite(id)!.interval_max_minutes).toBe(0);
  });
});
