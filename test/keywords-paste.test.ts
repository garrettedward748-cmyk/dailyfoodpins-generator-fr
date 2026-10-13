import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/** Keywords pasted one per line land switched on and set to go on the ticked sites. */

const KEY = randomBytes(32);
let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  run("INSERT INTO sites (name, domain, status) VALUES ('A', 'a.com', 'active'), ('B', 'b.com', 'active')");
  app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  closeDatabase();
});

const paste = (fields: [string, string][]) =>
  app.inject({
    method: 'POST', url: '/keywords/paste',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });

it('adds one keyword per line on the ticked sites, and skips repeats', async () => {
  const lines = '1. Lemon Bars with Shortbread Crust\n\nCreamy Tuscan Chicken Pasta\n- lemon bars with shortbread crust\nab';
  const r = await paste([['lines', lines], ['seed_keyword', 'Dessert'], ['site_ids', '2']]);
  expect(r.statusCode).toBe(303);
  expect(decodeURIComponent(String(r.headers.location))).toContain('2 keyword(s) added, 2 skipped');
  expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM keywords WHERE seed_keyword = 'dessert' AND status = 'go'")?.n).toBe(2);
  expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM keyword_sites WHERE site_id = 2 AND status = 'go'")?.n).toBe(2);
  expect(get<{ n: number }>('SELECT COUNT(*) AS n FROM keyword_sites WHERE site_id = 1')?.n).toBe(0);
});

it('shows the paste box on the Add keywords page', async () => {
  const page = await app.inject({ method: 'GET', url: '/keywords/add', headers: { cookie } });
  expect(page.body).toContain('action="/keywords/paste"');
  expect(page.body).toContain('a.com');
});
