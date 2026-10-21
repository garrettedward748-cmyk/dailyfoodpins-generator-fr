import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { createRun, insertKeyword, upsertSite } from '../src/db/repos.js';
import {
  addPinDesign, designProblems, listPinDesigns, markRunPinDesign, pickPinDesign, savePinDesign, siteDesignHistory, type PinDesign,
} from '../src/core/pin-designs.js';

const KEY = randomBytes(32);
const d = (id: number, enabled = 1): PinDesign => ({ id, name: `d${id}`, body: '{{imagePrompts.pin}} {{pinTitle}} {{site.domain}}', enabled: enabled as 0 | 1, position: id });

describe('pin designs', () => {
  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  it('starts with eight designs, the first being the old template, each carrying the three fields', () => {
    const designs = listPinDesigns();
    expect(designs).toHaveLength(8);
    expect(designs[0]!.body).toContain('{{pinTitle}}');
    expect(designs.every((x) => designProblems(x.body).length === 0)).toBe(true);
    expect(listPinDesigns()).toHaveLength(8); // not seeded twice
  });

  it('never repeats one of the last three, prefers the least used, and differs by site', () => {
    const all = [d(1), d(2), d(3), d(4), d(5)];
    expect(pickPinDesign(all, [1, 2, 3], {}, 0)!.id).toBe(4);
    expect(pickPinDesign(all, [], { 1: 2, 2: 2, 3: 1, 4: 2, 5: 2 }, 0)!.id).toBe(3);
    expect(pickPinDesign(all, [], {}, 0)!.id).not.toBe(pickPinDesign(all, [], {}, 1)!.id);
  });

  it('skips designs that are off or broken, and still picks when only one is left', () => {
    const broken = { ...d(2), body: 'no fields' };
    expect(pickPinDesign([d(1, 0), broken, d(3)], [3], {}, 0)!.id).toBe(3);
    expect(pickPinDesign([d(1, 0)], [], {}, 0)).toBeNull();
  });

  it("reads a site's history from its runs", () => {
    const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    const k = insertKeyword({ seed_keyword: 'x', spy_title: 'X' });
    const ids = listPinDesigns().map((x) => x.id);
    for (const id of [ids[0]!, ids[1]!, ids[1]!, ids[2]!]) markRunPinDesign(createRun(k, siteId), id);
    const h = siteDesignHistory(siteId);
    expect(h.recent).toEqual([ids[2], ids[1], ids[1]]);
    expect(h.uses[ids[1]!]).toBe(2);
  });

  it('adds and edits a design', () => {
    listPinDesigns();
    const id = addPinDesign('Mine', '{{imagePrompts.pin}} {{pinTitle}} {{site.domain}}');
    savePinDesign(id, { name: 'Mine 2', body: 'x', enabled: false });
    const mine = listPinDesigns().find((x) => x.id === id)!;
    expect(mine).toMatchObject({ name: 'Mine 2', enabled: 0 });
    expect(designProblems(mine.body)).toHaveLength(3);
    run('SELECT 1');
  });
});
