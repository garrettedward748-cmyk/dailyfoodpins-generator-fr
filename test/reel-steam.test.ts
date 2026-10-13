import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, getDb, openDatabase, run } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { DEFAULT_REEL_STRUCTURES } from '../src/core/reel-structures.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Steam in the reels.
 *
 * The video template allowed steam on any dish "served hot (baked, ...)", so
 * a muffin opened on curls of steam — the clearest sign a food video was
 * generated. Steam is now off by default, never on baked goods, and at most a
 * few faint wisps on a dish eaten straight from the stove.
 */

const template = readFileSync('prompts/reel-video.template.txt', 'utf8');
const plan = readFileSync('prompts/reel-plan.system.txt', 'utf8');

describe('the prompts', () => {
  it('make no steam the default and rule it out for baked goods', () => {
    for (const text of [template, plan]) {
      expect(text).toMatch(/No steam by default|STEAM: none, by default/);
      expect(text).toMatch(/muffins, cakes, cookies, bread, pies/);
      expect(text).toMatch(/never clouds, curls or swirls|Never thick clouds, never curls or swirls/);
    }
  });

  it('no longer lets "baked" stand for "served hot"', () => {
    expect(template).not.toMatch(/served hot \(baked/);
    expect(plan).not.toMatch(/only when this dish is served hot/);
  });

  it('no shipped reel structure asks for steam', () => {
    for (const s of DEFAULT_REEL_STRUCTURES) expect(s.body.toLowerCase()).not.toContain('steam');
  });
});

describe('migration 038', () => {
  beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
  afterEach(() => closeDatabase());

  const migration = MIGRATIONS.find((m) => m.id === '038-first-bite-no-steam')!;
  const now = DEFAULT_REEL_STRUCTURES.find((s) => s.name === 'First bite, then back')!.body;
  const shipped = now.replace('its crumb or its set texture', 'the steam or the set texture');

  it('updates the stored structure while it is still the shipped text, and leaves an edited one alone', () => {
    expect(shipped).not.toBe(now);
    const edited = `${shipped}\nMy own extra line.`;
    run('INSERT INTO reel_structures (name, body, enabled, position) VALUES (?, ?, 1, 1)', 'First bite, then back', shipped);
    run('INSERT INTO reel_structures (name, body, enabled, position) VALUES (?, ?, 1, 2)', 'Mine', edited);

    migration.up(getDb());

    const rows = all<{ name: string; body: string }>('SELECT name, body FROM reel_structures ORDER BY position');
    expect(rows[0]!.body).toBe(now);
    expect(rows[1]!.body).toBe(edited);
  });
});
