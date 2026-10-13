import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/** Setup -> Google accounts shows the image service's accounts and passes actions to it. */

const KEY = randomBytes(32);
let app: FastifyInstance;
let cookie: string;
const calls: string[] = [];

beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  calls.length = 0;
  const settings = new Settings(KEY);
  settings.set('image_base_url', 'http://imagegen:8100');
  settings.set('image_api_key', 'k');
  app = buildServer(settings, KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/flow/accounts') && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify({
        active: 1, pending: null,
        accounts: [
          { id: 1, label: 'Main', status: 'cooldown', until: Date.now() / 1000 + 7200, reason: 'Out of credits or quota', active: true },
          { id: 2, label: 'Second', status: 'signed_out', until: null, reason: 'New — sign in', active: false },
        ],
      }));
    }
    if (url.endsWith('/flow/accounts')) return new Response(JSON.stringify({ id: 3 }));
    return new Response(JSON.stringify({ ok: true }));
  }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  closeDatabase();
});

it('lists the accounts with their state', async () => {
  const page = await app.inject({ method: 'GET', url: '/settings/google', headers: { cookie } });
  expect(page.body).toContain('resting');
  expect(page.body).toContain('needs sign-in');
  expect(page.body).toContain('back in 2 h');
});

it('adds, switches and removes through the image service', async () => {
  const post = (url: string, body = '') =>
    app.inject({ method: 'POST', url, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: body });
  expect((await post('/settings/google/add', 'label=Third')).headers.location).toContain('Account%20%233%20added');
  await post('/settings/google/2/use');
  await post('/settings/google/2/remove');
  expect(calls).toEqual([
    'POST http://imagegen:8100/flow/accounts',
    'POST http://imagegen:8100/flow/accounts/2/use',
    'DELETE http://imagegen:8100/flow/accounts/2',
  ]);
});
