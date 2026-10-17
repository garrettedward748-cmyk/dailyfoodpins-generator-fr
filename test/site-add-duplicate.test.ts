import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { getSite, listSites, upsertSite } from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/** Adding a domain that is already a site is refused; it used to overwrite that site. */

const KEY = randomBytes(32);
let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  app = buildServer(new Settings(KEY), KEY, { password: 'pw-123456', secret: KEY, generated: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=pw-123456', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const header = login.headers['set-cookie'];
  cookie = Array.isArray(header) ? header[0]! : String(header);
});
afterEach(async () => { await app.close(); closeDatabase(); });

it('refuses arbmom.com a second time, and leaves the first one as it was', async () => {
  const id = upsertSite({ name: 'Arbmom', domain: 'arbmom.com', status: 'active', daily_target: 3, interval_minutes: 480 }, KEY);
  const res = await app.inject({
    method: 'POST', url: '/sites',
    payload: new URLSearchParams({ name: 'Other name', domain: 'https://arbmom.com/', status: 'paused', daily_target: '1', interval: '2', interval_unit: 'hours' }).toString(),
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(decodeURIComponent(String(res.headers.location))).toContain('already a site here');
  expect(listSites()).toHaveLength(1);
  expect(getSite(id)).toMatchObject({ name: 'Arbmom', status: 'active', daily_target: 3, interval_minutes: 480 });
});
