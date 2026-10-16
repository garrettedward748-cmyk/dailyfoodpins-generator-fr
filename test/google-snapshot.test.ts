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
