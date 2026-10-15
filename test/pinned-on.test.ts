import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { closeDatabase, openDatabase } = await import('../src/db/index.js');
const { addProfile, createRun, firstProfile, insertKeyword, listRuns, markFanoutPosted, updateProfile, upsertSite } = await import('../src/db/repos.js');
const { mergeRecent } = await import('../src/web/views/home.js');

const KEY = randomBytes(32);
beforeEach(() => openDatabase(':memory:'));
afterEach(() => closeDatabase());

describe('which Pinterest account a pin went to', () => {
  it('names the account the run recorded as posted', () => {
    const site = upsertSite({ name: 'Arbmom', domain: 'arbmom.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    const one = firstProfile(site, 'pinterest');
    updateProfile(one.id, { channel_name: 'ArbmomRecipes' });
    const two = addProfile(site, 'pinterest'); // no username: its label

    const a = createRun(insertKeyword({ seed_keyword: 'dessert' }), site);
    markFanoutPosted(a, 'pinterest', one.id, 'p1');
    const b = createRun(insertKeyword({ seed_keyword: 'cake' }), site);
    markFanoutPosted(b, 'pinterest', two, 'p2');
    createRun(insertKeyword({ seed_keyword: 'pie' }), site); // no pin

    const rows = listRuns(10);
    expect(rows.find((r) => r.id === a)!.pinned_on).toBe('ArbmomRecipes');
    expect(rows.find((r) => r.id === b)!.pinned_on).toBe('Pinterest 2');
    expect(rows.find((r) => r.seed_keyword === 'pie')!.pinned_on).toBe('');

    const recent = mergeRecent(rows, []);
    expect(recent.find((r) => r.what.endsWith('dessert'))!.detail).toBe('pinned on ArbmomRecipes');
  });
});
