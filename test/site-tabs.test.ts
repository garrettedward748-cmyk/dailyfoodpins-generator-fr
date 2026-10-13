import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { closeDatabase, openDatabase, run } = await import('../src/db/index.js');
const { upsertSite } = await import('../src/db/repos.js');
const { Settings } = await import('../src/settings.js');
const { buildServer } = await import('../src/web/server.js');
const { setLogLevel } = await import('../src/lib/logger.js');

const KEY = randomBytes(32);
let app: FastifyInstance;
let cookie: string;
let a: number;
let b: number;
const mk = (name: string, domain: string) => upsertSite({ name, domain, status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
const get = (url: string, extra = '') => app.inject({ method: 'GET', url, headers: { cookie: cookie + extra } });
const tabs = (body: string) => body.match(/<nav class="row wrap site-tabs"[\s\S]*?<\/nav>/)?.[0] ?? '';

beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
  a = mk('A', 'a.com');
  b = mk('B', 'b.com');
});
afterEach(async () => { await app.close(); closeDatabase(); });

it('shows the site tabs, All sites first, on every Content page', async () => {
  for (const path of ['/runs', '/keywords', '/research', '/blog', '/reels']) {
    const t = tabs((await get(path)).body);
    expect(t, path).toContain('All sites');
    expect(t.indexOf('All sites'), path).toBeLessThan(t.indexOf('a.com'));
    expect(t, path).toContain('b.com');
  }
  expect((await get('/sites')).body).not.toContain('site-tabs');
});

it('highlights the chosen site and remembers it across pages', async () => {
  const r = await get(`/keywords?site=${a}`);
  expect(r.headers['set-cookie']).toContain(`scope_site=${a}`);
  const t = tabs(r.body);
  expect(t).toMatch(new RegExp(`class="button primary" href="/keywords\\?site=${a}"`));
  // Another page, no ?site: the remembered one applies.
  const blog = await get('/blog', `; scope_site=${a}`);
  expect(tabs(blog.body)).toMatch(new RegExp(`class="button primary" href="/blog\\?site=${a}"`));
  // All sites clears it.
  const all = await get('/keywords?site=all', `; scope_site=${a}`);
  expect(all.headers['set-cookie']).toContain('scope_site=all');
  expect(tabs(all.body)).toMatch(/class="button primary" href="\/keywords\?site=all"/);
});

it('lists only the chosen site\'s keywords, with its own dot only', async () => {
  const add = (seed: string, title: string, site: number) => {
    run("INSERT INTO keywords (seed_keyword, spy_title, status) VALUES (?, ?, 'go')", seed, title);
    run('INSERT INTO keyword_sites (keyword_id, site_id, status) VALUES ((SELECT max(id) FROM keywords), ?, \'go\')', site);
  };
  add('soup', 'Alpha Soup', a);
  add('cake', 'Beta Cake', b);
  const all = (await get('/keywords?site=all')).body;
  expect(all).toContain('Alpha Soup');
  expect(all).toContain('Beta Cake');
  const onlyA = (await get(`/keywords?site=${a}`)).body;
  expect(onlyA).toContain('Alpha Soup');
  expect(onlyA).not.toContain('Beta Cake');
  const row = onlyA.match(/<div class="dots">[\s\S]*?<\/div>/)?.[0] ?? '';
  expect((row.match(/class="dot /g) ?? []).length).toBe(1);
  expect((all.match(/<div class="dots">[\s\S]*?<\/div>/)?.[0].match(/class="dot /g) ?? []).length).toBe(2);
});

it('pre-ticks the chosen site in Research and has no All tab on Radar', async () => {
  const r = (await get(`/research?site=${b}`)).body;
  const boxes = r.match(/<input[^>]*name="site_ids"[^>]*>/g) ?? [];
  expect(boxes.filter((x) => /\schecked/.test(x)).every((x) => x.includes(`value="${b}"`))).toBe(true);
  expect(boxes.some((x) => /\schecked/.test(x))).toBe(true);
  expect(tabs((await get('/radar')).body)).not.toContain('All sites');
});

it('with a site chosen, Blog shows only that site and no second site chooser', async () => {
  const all = (await get('/blog?site=all')).body;
  expect(all).toContain('name="site_id"');
  expect(all).toContain('/blog/sites/' + a);
  expect(all).toContain('/blog/sites/' + b);
  const one = (await get(`/blog?site=${a}`)).body;
  expect(one).toContain('/blog/sites/' + a);
  expect(one).not.toContain('/blog/sites/' + b);
  expect(one).toMatch(new RegExp(`<input type="hidden" name="site_id" value="${a}"`));
  expect(one).not.toMatch(/<select name="site_id"/);
});

it('with a site chosen, Keywords actions and Research have no site list to pick from', async () => {
  run("INSERT INTO keywords (seed_keyword, spy_title, status) VALUES ('soup', 'Alpha Soup', 'go')");
  run("INSERT INTO keyword_sites (keyword_id, site_id, status) VALUES ((SELECT max(id) FROM keywords), ?, 'go')", a);
  const k = (await get(`/keywords?site=${a}`)).body;
  expect(k).not.toContain('Which site these actions apply to');
  expect(k).toMatch(new RegExp(`<input type="hidden" name="site_id" value="${a}"`));
  const r = (await get(`/research?site=${a}`)).body;
  expect(r).toContain('chosen in the tabs above');
  expect(r).not.toContain('b.com</label>');
});
