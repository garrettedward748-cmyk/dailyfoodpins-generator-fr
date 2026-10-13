import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, get, openDatabase } from '../src/db/index.js';
import { addPastedKeywords, insertKeyword, upsertSite } from '../src/db/repos.js';
import { getQueueCheck, queuedKeywords, removeFromQueue, startQueueCheck } from '../src/research/queue-check.js';

const KEY = randomBytes(32);

describe('checking the keyword queue', () => {
  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  it('flags topics without asking, asks the model about the rest in batches, and removes only what is ticked', async () => {
    const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    addPastedKeywords(['Lemon Bars', 'Christmas Dessert Recipes', 'Banana Pudding'], 'dessert', [siteId]);
    // A keyword with no dish name, linked to the site.
    const bare = insertKeyword({ seed_keyword: 'fall dessert', spy_title: '' });
    const { run } = await import('../src/db/index.js');
    run("INSERT INTO keyword_sites (keyword_id, site_id, status) VALUES (?, ?, 'go')", bare, siteId);
    expect(queuedKeywords()).toHaveLength(4);

    const asked: string[] = [];
    const job = startQueueCheck(async (items) => {
      asked.push(items);
      const n = items.split('\n').findIndex((l) => l.includes('Christmas')) + 1;
      return JSON.stringify({ flag: [{ n, why: 'topic' }] });
    });
    for (let i = 0; i < 50 && !getQueueCheck(job.id)!.finished; i++) await new Promise((r) => setTimeout(r, 5));
    const done = getQueueCheck(job.id)!;
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain('fall dessert');
    expect(done.flags.map((f) => f.why)).toEqual(expect.arrayContaining(['a topic or occasion, not one dish', 'no dish name (spy title), only a topic group']));
    expect(done.flags).toHaveLength(2);

    const christmas = done.flags.find((f) => f.title.includes('Christmas'))!;
    expect(removeFromQueue([christmas.id])).toBe(1);
    expect(get<{ status: string }>('SELECT status FROM keywords WHERE id = ?', christmas.id)!.status).toBe('no');
    expect(queuedKeywords()).toHaveLength(3);
  });
});
