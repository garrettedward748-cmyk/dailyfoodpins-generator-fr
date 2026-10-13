import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { closeDatabase, openDatabase } = await import('../src/db/index.js');
const { upsertSite } = await import('../src/db/repos.js');
const { Settings } = await import('../src/settings.js');
const { buildServer } = await import('../src/web/server.js');
const { setLogLevel } = await import('../src/lib/logger.js');
const { startResearchJob, getResearchJob } = await import('../src/research/batch.js');

const KEY = randomBytes(32);
let app: FastifyInstance;
let cookie: string;
const mk = (name: string, domain: string) => upsertSite({ name, domain, status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });

beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => { await app.close(); closeDatabase(); });

async function finishedJob() {
  const job = startResearchJob(['banana pudding'], 20, '', async (seed) => ({
    seed,
    recipes: [{ text: 'banana pudding cups', source: 'autocomplete' as const }],
    questions: [],
    notes: [],
  }));
  for (let i = 0; i < 100 && !getResearchJob(job.id)!.finished; i++) await new Promise((r) => setTimeout(r, 5));
  return job.id;
}

it('shows the Send to chooser with every site in the search form', async () => {
  mk('A', 'a.com');
  mk('B', 'b.com');
  const r = await get('/research');
  expect(r.body).toContain('Send to');
  expect(r.body).toContain('a.com');
  expect(r.body).toContain('b.com');
  expect(r.body.indexOf('Send to')).toBeLessThan(r.body.indexOf('Find keywords'));
});

it('refuses to search when no site is ticked', async () => {
  mk('A', 'a.com');
  mk('B', 'b.com');
  const r = await get('/research?seed=banana+pudding');
  expect(r.statusCode).toBe(303);
  expect(String(r.headers.location)).not.toContain('job=');
});

it('carries the ticked sites through the search', async () => {
  const a = mk('A', 'a.com');
  const b = mk('B', 'b.com');
  const r = await get(`/research?seed=banana+pudding&site_ids=${a}&site_ids=${b}`);
  expect(r.statusCode).toBe(302);
  const loc = new URL(String(r.headers.location), 'http://x');
  expect(loc.searchParams.get('job')).toBeTruthy();
  expect(loc.searchParams.getAll('site_ids')).toEqual([String(a), String(b)]);
});

it('renders the results with the chosen site pre-ticked and the job id', async () => {
  const a = mk('A', 'a.com');
  mk('B', 'b.com');
  const job = await finishedJob();
  const r = await get(`/research?job=${job}&site_ids=${a}`);
  expect(r.body).toContain('banana pudding cups');
  expect(r.body).toContain(`name="job" value="${job}"`);
  const boxes = r.body.match(/<input[^>]*name="site_ids"[^>]*>/g) ?? [];
  const checked = boxes.filter((x) => /\schecked/.test(x));
  expect(checked.some((x) => x.includes(`value="${a}"`))).toBe(true);
  expect(checked.length).toBeGreaterThan(0);
  expect(checked.every((x) => x.includes(`value="${a}"`))).toBe(true);
});

it('keeps the results when adding with no site ticked', async () => {
  mk('A', 'a.com');
  mk('B', 'b.com');
  const job = await finishedJob();
  const form = new URLSearchParams({ job, group: 'Banana' });
  form.append('recipes', 'banana||banana pudding cups');
  const r = await app.inject({ method: 'POST', url: '/research/import', payload: form.toString(), headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });
  expect(r.statusCode).toBe(303);
  expect(String(r.headers.location)).toContain(`/research?job=${job}`);
  const page = await get(String(r.headers.location));
  expect(page.body).toContain('Your results are still here.');
});
