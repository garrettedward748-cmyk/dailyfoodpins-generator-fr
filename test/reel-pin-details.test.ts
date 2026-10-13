import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { createRun, insertKeyword, upsertSite } from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';

vi.mock('../src/llm/ask.js', () => ({
  askPrompt: vi.fn(async (_s: unknown, _k: unknown, name: string) => ({ content: `written by ${name}` })),
}));
const { reelPinDetails } = await import('../src/reels/engine.js');

/** The video pin's description: the article pin's own, or one written the same way. */
const KEY = randomBytes(32);
beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => closeDatabase());

function aRun(): number {
  const site = upsertSite({ name: 'D', domain: 'd.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
  return createRun(insertKeyword({ seed_keyword: 'x', spy_title: 'Lemon Bars' }), site);
}
const step = (runId: number, name: string, value: unknown) =>
  run("INSERT INTO run_steps (run_id, step, status, output_json) VALUES (?, ?, 'ok', ?)", runId, name, JSON.stringify(value));

describe('the reel pin', () => {
  it('reuses the article pin description and board', async () => {
    const id = aRun();
    step(id, 'generate-pin-description', 'Tangy lemon bars with a buttery crust… #lemonbars');
    step(id, 'resolve-buffer-target', { channelId: 'c', boardServiceId: 'b', boardName: 'Desserts' });
    expect(await reelPinDetails(id, 'Lemon Bars', 'd.com', {} as never, KEY))
      .toEqual({ board: 'Desserts', description: 'Tangy lemon bars with a buttery crust… #lemonbars' });
  });

  it('writes one with the pin prompt when the site does not pin posts', async () => {
    const id = aRun();
    expect(await reelPinDetails(id, 'Lemon Bars', 'd.com', {} as never, KEY))
      .toEqual({ board: '', description: 'written by pin-description' });
  });
});
