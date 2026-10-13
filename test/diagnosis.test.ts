import { describe, expect, it } from 'vitest';
import { diagnoseKeyword } from '../src/core/diagnosis.js';
import { findDuplicate, titleSimilarity } from '../src/core/similar-title.js';
import type { SiteView } from '../src/core/types.js';

const OPTS = { now: new Date('2026-08-28T12:00:00Z'), timezone: 'UTC' };

const site = (over: Partial<SiteView> = {}): SiteView => ({
  id: 1,
  name: 'bitespoon',
  domain: 'bitespoon.com',
  status: 'active',
  dailyTarget: 3,
  intervalMinutes: 60,
  publishedToday: 0,
  lastPublishAt: null,
  lastAttemptAt: null,
  ...over,
});

const keyword = { id: 10, seedKeyword: 'chicken soup', status: 'go' as const };

describe('why one keyword is not publishing', () => {
  it('says it is ready when it is', () => {
    const result = diagnoseKeyword(keyword, [site()], [{ siteId: 1, status: 'go' }], OPTS);

    expect(result.readyCount).toBe(1);
    expect(result.sites[0]?.ready).toBe(true);
    expect(result.summary).toContain('ready to publish');
  });

  it('names the site it is not linked to', () => {
    const result = diagnoseKeyword(keyword, [site()], [], OPTS);

    expect(result.sites[0]?.link).toBe('unlinked');
    expect(result.sites[0]?.reason).toContain('Not linked');
    expect(result.summary).toContain('not set to go on any site');
  });

  it('reports the daily limit as the site condition it is', () => {
    const result = diagnoseKeyword(
      keyword,
      [site({ publishedToday: 3, dailyTarget: 3 })],
      [{ siteId: 1, status: 'go' }],
      OPTS,
    );

    expect(result.readyCount).toBe(0);
    expect(result.sites[0]?.reason).toContain('Daily publishing limit');
  });

  it('extracts how long the interval has left', () => {
    const result = diagnoseKeyword(
      keyword,
      [site({ lastPublishAt: '2026-08-28T11:30:00Z', intervalMinutes: 120 })],
      [{ siteId: 1, status: 'go' }],
      OPTS,
    );

    expect(result.sites[0]?.waitMinutes).toBe(90);
    expect(result.summary).toContain('free in');
  });

  it('never calls a keyword ready when its own status blocks it', () => {
    // The site is perfectly healthy; the keyword is done. Reporting "ready"
    // here and then never publishing is the confusion this page exists to fix.
    const result = diagnoseKeyword(
      { ...keyword, status: 'done' },
      [site()],
      [{ siteId: 1, status: 'go' }],
      OPTS,
    );

    expect(result.readyCount).toBe(0);
    expect(result.sites[0]?.reason).toContain('marked done');
    expect(result.keywordProblem).toContain('done');
  });

  it('recognises a keyword that is simply finished everywhere', () => {
    const result = diagnoseKeyword(keyword, [site()], [{ siteId: 1, status: 'done' }], OPTS);
    expect(result.summary).toContain('published on every site');
  });

  it('handles having no sites at all', () => {
    const result = diagnoseKeyword(keyword, [], [], OPTS);
    expect(result.sites).toHaveLength(0);
    expect(result.readyCount).toBe(0);
  });
});

describe('near-duplicate titles', () => {
  it('matches a reworded version of the same dish', () => {
    expect(
      titleSimilarity('Easy Baked Chicken Breast', 'Baked Chicken Breast (Easy!)'),
    ).toBeGreaterThan(0.7);
  });

  it('leaves two different dishes that share an ingredient alone', () => {
    expect(
      titleSimilarity('Baked Chicken Breast', 'Chicken Noodle Soup With Ginger'),
    ).toBeLessThan(0.7);
  });

  it('ignores the filler words every recipe title carries', () => {
    expect(titleSimilarity('The Best Homemade Beef Stew Recipe', 'Beef Stew')).toBe(1);
  });

  it('finds the closest existing article, not merely the first', () => {
    const match = findDuplicate('Slow Cooker Beef Stew', [
      { title: 'Chicken Soup', url: '/a' },
      { title: 'Beef Stew In The Slow Cooker', url: '/b' },
    ]);

    expect(match?.url).toBe('/b');
  });

  it('returns nothing when the site has published nothing like it', () => {
    expect(findDuplicate('Beef Stew', [{ title: 'Lemon Tart', url: '/a' }])).toBeNull();
  });

  it('does not match on an empty title', () => {
    expect(findDuplicate('', [{ title: 'Beef Stew', url: null }])).toBeNull();
    expect(findDuplicate('Beef Stew', [{ title: '   ', url: null }])).toBeNull();
  });
});
