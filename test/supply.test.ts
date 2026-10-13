import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { insertKeyword, setLink, upsertSite } from '../src/db/repos.js';
import { readSupply, supplyWarning } from '../src/core/supply.js';

const KEY = randomBytes(32);

const site = (domain: string, over: Record<string, unknown> = {}): number =>
  upsertSite(
    {
      name: domain.split('.')[0]!,
      domain,
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 3,
      interval_minutes: 60,
      ...over,
    } as Parameters<typeof upsertSite>[0],
    KEY,
  );

describe('how much work is left', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('reports empty when there is nothing at all', () => {
    expect(readSupply().level).toBe('empty');
  });

  it('counts a keyword linked go to an active site', () => {
    const s = site('a.com');
    const k = insertKeyword({ seed_keyword: 'chicken', status: 'go' });
    setLink(k, s, 'go');

    expect(readSupply().readyPairs).toBe(1);
  });

  it('counts each site a keyword runs on separately', () => {
    const a = site('a.com');
    const b = site('b.com');
    const k = insertKeyword({ seed_keyword: 'chicken', status: 'go' });
    setLink(k, a, 'go');
    setLink(k, b, 'go');

    // One keyword across two sites is two articles of work, not one.
    expect(readSupply().readyPairs).toBe(2);
  });

  it('ignores a keyword that is go but linked nowhere', () => {
    site('a.com');
    insertKeyword({ seed_keyword: 'orphan', status: 'go' });

    // This is the number the old "keywords ready" stat got wrong: it looked
    // like supply and produced nothing.
    expect(readSupply().readyPairs).toBe(0);
  });

  it('ignores a link whose keyword is not go', () => {
    const s = site('a.com');
    const k = insertKeyword({ seed_keyword: 'chicken', status: 'no' });
    setLink(k, s, 'go');

    expect(readSupply().readyPairs).toBe(0);
  });

  it('ignores a link already marked done', () => {
    const s = site('a.com');
    const k = insertKeyword({ seed_keyword: 'chicken', status: 'go' });
    setLink(k, s, 'done');

    expect(readSupply().readyPairs).toBe(0);
  });

  it('ignores paused sites and sites with no daily target', () => {
    const paused = site('paused.com', { status: 'paused' });
    const zero = site('zero.com', { daily_target: 0 });
    const k = insertKeyword({ seed_keyword: 'chicken', status: 'go' });
    setLink(k, paused, 'go');
    setLink(k, zero, 'go');

    expect(readSupply().readyPairs).toBe(0);
  });

  it('measures the runway against what the sites consume', () => {
    const a = site('a.com', { daily_target: 2 });
    const b = site('b.com', { daily_target: 3 });
    for (let i = 0; i < 20; i++) {
      const k = insertKeyword({ seed_keyword: `k${i}`, status: 'go' });
      setLink(k, a, 'go');
    }

    const supply = readSupply();
    expect(supply.readyPairs).toBe(20);
    expect(supply.dailyDemand).toBe(5);
    expect(supply.daysRemaining).toBe(4);
    expect(supply.level).toBe('ok');
  });

  it('calls it low when there are only a couple of days left', () => {
    const a = site('a.com', { daily_target: 5 });
    for (let i = 0; i < 5; i++) {
      const k = insertKeyword({ seed_keyword: `k${i}`, status: 'go' });
      setLink(k, a, 'go');
    }

    expect(readSupply().level).toBe('low');
  });

  it('has no runway to run out of when every site is paused', () => {
    const paused = site('a.com', { status: 'paused' });
    const k = insertKeyword({ seed_keyword: 'chicken', status: 'go' });
    setLink(k, paused, 'go');

    // Idle on purpose is not a problem, and warning about it would be noise.
    expect(readSupply().daysRemaining).toBeNull();
  });
});

describe('what it says', () => {
  it('says nothing when supply is fine', () => {
    expect(supplyWarning({ readyPairs: 50, dailyDemand: 5, daysRemaining: 10, level: 'ok' })).toBeNull();
  });

  it('names the fix when the queue is empty', () => {
    const message = supplyWarning({
      readyPairs: 0,
      dailyDemand: 5,
      daysRemaining: 0,
      level: 'empty',
    });

    expect(message).toContain('Publishing has stopped');
    expect(message).toContain('Keywords');
  });

  it('distinguishes an empty queue from nothing configured to consume it', () => {
    const message = supplyWarning({
      readyPairs: 0,
      dailyDemand: 0,
      daysRemaining: null,
      level: 'empty',
    });

    expect(message).toContain('no active site has a daily target');
  });

  it('gives the number of days when it is running low', () => {
    const message = supplyWarning({
      readyPairs: 5,
      dailyDemand: 5,
      daysRemaining: 1,
      level: 'low',
    });

    expect(message).toContain('1 day');
    expect(message).toContain('5 keyword-site pair');
  });
});
