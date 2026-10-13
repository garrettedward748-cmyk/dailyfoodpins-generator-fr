import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { createRun, insertKeyword, upsertSite } from '../src/db/repos.js';
import {
  addPhotoStyle, listPhotoStyles, markRunPhotoStyle, photoStyleUses, pickPhotoStyle, savePhotoStyle,
  shootBlock, sitePhotoHistory, type PhotoStyle,
} from '../src/core/photo-styles.js';
import { pickInRotation } from '../src/core/rotation.js';
import { render } from '../src/pipeline/prompts.js';
import { readFileSync } from 'node:fs';

const KEY = randomBytes(32);
const s = (id: number, enabled = 1): PhotoStyle => ({ id, name: `s${id}`, body: `shoot ${id}`, enabled: enabled as 0 | 1, position: id });

describe('the shared rotation rule', () => {
  const item = (id: number) => ({ id });

  it('avoids the last three, then the least used, then splits by site', () => {
    const all = [1, 2, 3, 4, 5].map(item);
    expect(pickInRotation(all, [1, 2, 3], {}, 0)!.id).toBe(4);
    expect(pickInRotation(all, [], { 1: 2, 2: 2, 3: 1, 4: 2, 5: 2 }, 0)!.id).toBe(3);
    expect(pickInRotation(all, [], {}, 0)!.id).not.toBe(pickInRotation(all, [], {}, 1)!.id);
  });

  it('never avoids so many that nothing is left', () => {
    expect(pickInRotation([item(1), item(2)], [1, 2], {}, 0)!.id).toBe(2);
    expect(pickInRotation([item(1)], [1], {}, 0)!.id).toBe(1);
    expect(pickInRotation([], [], {}, 0)).toBeNull();
  });
});

describe('photo styles', () => {
  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  it('starts with six shoots that differ in surface, light and camera', () => {
    const styles = listPhotoStyles();
    expect(styles).toHaveLength(6);
    expect(listPhotoStyles()).toHaveLength(6); // not seeded twice
    // Every shoot says where the camera is, which is the thing that stops six
    // briefs being one brief with six names.
    expect(styles.every((x) => /camera/i.test(x.body))).toBe(true);
    expect(new Set(styles.map((x) => x.name)).size).toBe(6);
  });

  it('rotates like the pin designs, and skips the ones switched off or empty', () => {
    expect(pickPhotoStyle([s(1), s(2), s(3), s(4)], [1, 2, 3], {}, 0)!.id).toBe(4);
    expect(pickPhotoStyle([s(1, 0), { ...s(2), body: '   ' }, s(3)], [], {}, 0)!.id).toBe(3);
    expect(pickPhotoStyle([s(1, 0)], [], {}, 0)).toBeNull();
  });

  it("reads a site's history from its runs", () => {
    const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    const k = insertKeyword({ seed_keyword: 'x', spy_title: 'X' });
    const ids = listPhotoStyles().map((x) => x.id);
    for (const id of [ids[0]!, ids[1]!, ids[1]!, ids[2]!]) markRunPhotoStyle(createRun(k, siteId), id);
    const h = sitePhotoHistory(siteId);
    expect(h.recent).toEqual([ids[2], ids[1], ids[1]]);
    expect(h.uses[ids[1]!]).toBe(2);
    expect(photoStyleUses()[ids[1]!]).toBe(2);
  });

  it('adds and edits a style', () => {
    listPhotoStyles();
    const id = addPhotoStyle('Mine', 'blue tiles, hard midday light, camera straight on');
    savePhotoStyle(id, { name: 'Mine 2', body: 'x', enabled: false });
    expect(listPhotoStyles().find((x) => x.id === id)).toMatchObject({ name: 'Mine 2', enabled: 0 });
  });
});

describe('the shoot as the prompt reads it', () => {
  it('carries the shoot and tells the model not to choose its own', () => {
    const block = shootBlock(s(1));
    expect(block).toContain('shoot 1');
    expect(block).toMatch(/Do not choose a surface/);
  });

  it('leaves no trace at all when every style is off', () => {
    expect(shootBlock(null)).toBe('');
    const template = readFileSync('prompts/image-prompts.user.txt', 'utf8');
    expect(template).toContain('{{photoShoot}}');
    const rendered = render(template, { seo: {}, spy: {}, recipe: {}, recipeJson: '{}', photoShoot: shootBlock(null) });
    expect(rendered).not.toContain('photoShoot');
    expect(rendered).not.toContain('{{');
    // The prompt still reads as it did before any of this existed.
    expect(rendered).toContain('Write the five image prompts for this recipe.');
  });

  it('puts the shoot into the prompt the model is sent', () => {
    const template = readFileSync('prompts/image-prompts.user.txt', 'utf8');
    const rendered = render(template, { seo: {}, spy: {}, recipe: {}, recipeJson: '{}', photoShoot: shootBlock(s(7)) });
    expect(rendered).toContain('THE SHOOT FOR THIS RECIPE');
    expect(rendered).toContain('shoot 7');
  });
});
