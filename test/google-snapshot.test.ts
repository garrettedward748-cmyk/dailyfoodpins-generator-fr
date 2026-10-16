import { describe, expect, it } from 'vitest';
import { parseSnapshot, restorableCount, serviceIsBehind, takeSnapshot } from '../src/web/google-snapshot.js';
import { clearEvents, insertEvent, listEvents } from '../src/db/repos.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';

const acc = (id: number, project = '') => ({ id, label: `Account ${id}`, status: 'ok' as const, until: null, reason: null, active: id === 1, project_id: project });

describe('the saved copy of the Google accounts', () => {
  it('round-trips through JSON', () => {
    const snap = takeSnapshot([acc(1, 'p1'), acc(2)], 20);
    expect(parseSnapshot(JSON.stringify(snap))).toEqual(snap);
    expect(parseSnapshot('')).toBeNull();
    expect(parseSnapshot('not json')).toBeNull();
  });

  it('sees a fresh service as behind, and a matching one as not', () => {
    const snap = takeSnapshot([acc(1, 'p1'), acc(2, 'p2')]);
    expect(serviceIsBehind(snap, [acc(1)])).toBe(true);
    expect(restorableCount(snap, [acc(1)])).toBe(2);
    expect(serviceIsBehind(snap, [acc(1, 'p1'), acc(2, 'p2')])).toBe(false);
    expect(restorableCount(snap, [acc(1, 'p1'), acc(2, 'p2')])).toBe(0);
  });
});

describe('clearing the event log', () => {
  it('empties it, or only the problems', () => {
    openDatabase(':memory:');
    insertEvent('info', 't', 'a');
    insertEvent('warn', 't', 'b');
    insertEvent('error', 't', 'c');
    expect(clearEvents('warn') + clearEvents('error')).toBe(2);
    expect(listEvents(10).map((e) => e.message)).toEqual(['a']);
    expect(clearEvents()).toBe(1);
    expect(listEvents(10)).toEqual([]);
    closeDatabase();
  });
});

describe('clearing the history', () => {
  it('removes finished runs and reels and keeps what is running', async () => {
    const { upsertSite, createRun, insertKeyword, clearHistory, get } = await import('../src/db/repos.js').then(async (m) => ({ ...m, get: (await import('../src/db/index.js')).get }));
    const { randomBytes } = await import('node:crypto');
    openDatabase(':memory:');
    const site = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, randomBytes(32));
    const a = createRun(insertKeyword({ seed_keyword: 'a', spy_title: 'A' }), site);
    createRun(insertKeyword({ seed_keyword: 'b', spy_title: 'B' }), site);
    const { run } = await import('../src/db/index.js');
    run("UPDATE runs SET status = 'published' WHERE id = ?", a);
    expect(clearHistory().runs).toBe(1);
    expect(get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')?.n).toBe(1);
    closeDatabase();
  });
});
