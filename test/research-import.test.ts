import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { closeDatabase, openDatabase, all } = await import('../src/db/index.js');
const { upsertSite } = await import('../src/db/repos.js');
const { Settings } = await import('../src/settings.js');
const { buildServer } = await import('../src/web/server.js');
const { setLogLevel } = await import('../src/lib/logger.js');

const KEY = randomBytes(32);
let app: FastifyInstance;
let cookie: string;
beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => { await app.close(); closeDatabase(); });

it('adds the ticked recipes to Keywords and the questions to Blog', async () => {
  const site = upsertSite({ name: 'a', domain: 'a.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
  const form = new URLSearchParams();
  form.append('group', 'Banana Dessert');
  form.append('site_ids', String(site));
  form.append('recipes', 'banana dessert bars');
  form.append('recipes', 'banana pudding cups');
  form.append('questions', 'Can you freeze banana pudding?');
  const r = await app.inject({ method: 'POST', url: '/research/import', payload: form.toString(), headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });
  expect(r.statusCode).toBe(303);
  const kws = all<{ seed_keyword: string; spy_title: string }>('SELECT seed_keyword, spy_title FROM keywords ORDER BY id');
  expect(kws).toEqual([
    { seed_keyword: 'banana dessert', spy_title: 'Banana Dessert Bars' },
    { seed_keyword: 'banana dessert', spy_title: 'Banana Pudding Cups' },
  ]);
  expect(all<{ question: string }>('SELECT question FROM blog_questions').map((q) => q.question)).toHaveLength(1);
  const page = await app.inject({ method: 'GET', url: '/research', headers: { cookie } });
  expect(page.body).toContain('Keyword research');
});
