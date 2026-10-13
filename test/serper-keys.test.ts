import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { closeDatabase, openDatabase } = await import('../src/db/index.js');
const { Settings } = await import('../src/settings.js');
const { buildServer } = await import('../src/web/server.js');
const { setLogLevel } = await import('../src/lib/logger.js');

const KEY = randomBytes(32);
let app: FastifyInstance;
let cookie: string;
let settings: InstanceType<typeof Settings>;
beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  settings = new Settings(KEY);
  app = buildServer(settings, KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => { await app.close(); closeDatabase(); });

const post = (url: string, form: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: new URLSearchParams(form).toString(), headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });

it('adds keys one per line, lists each, and removes one', async () => {
  await post('/settings/serper/add', { serper_new: 'aaaa1111bbbb2222\ncccc3333dddd4444\naaaa1111bbbb2222' });
  expect(settings.get('serper_api_key')).toBe('aaaa1111bbbb2222\ncccc3333dddd4444');
  const page = await app.inject({ method: 'GET', url: '/settings', headers: { cookie } });
  expect(page.body).toContain('aaaa…2222');
  expect(page.body).toContain('cccc…4444');
  expect(page.body).toContain('serper.dev/signup');
  await post('/settings/serper/1/use');
  expect(settings.get('serper_key_index')).toBe('1');
  await post('/settings/serper/0/remove');
  expect(settings.get('serper_api_key')).toBe('cccc3333dddd4444');
  expect(settings.get('serper_key_index')).toBe('0');
});
