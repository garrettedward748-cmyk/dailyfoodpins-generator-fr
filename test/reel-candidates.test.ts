import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { createRun, dismissReelCandidates, insertKeyword, markRunPublished, reelCandidates, upsertSite } from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';

/** Articles can be taken off "Make a reel from", one at a time or all at once. */
const KEY = randomBytes(32);
beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => closeDatabase());

function published(title: string): number {
  const site = upsertSite({ name: 'D', domain: 'd.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
  const kw = insertKeyword({ seed_keyword: 'x', spy_title: title });
  const id = createRun(kw, site);
  markRunPublished(id, '1', `https://d.com/recipe/${title}`, title);
  run("INSERT INTO run_steps (run_id, step, status, output_json) VALUES (?, 'generate-images', 'ok', '{}')", id);
  return id;
}

describe('the reel candidates list', () => {
  it('drops one, then the rest', () => {
    const a = published('a');
    published('b');
    published('c');
    expect(reelCandidates()).toHaveLength(3);
    dismissReelCandidates([a]);
    expect(reelCandidates().map((c) => c.run_id)).not.toContain(a);
    expect(dismissReelCandidates('all')).toBe(2);
    expect(reelCandidates()).toHaveLength(0);
  });
});
