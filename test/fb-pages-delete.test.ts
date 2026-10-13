import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { closeDatabase, openDatabase, get, run } = await import('../src/db/index.js');
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

it('deletes the ticked Facebook pages only', async () => {
  // Only pages brought in by a token show on this screen now — a manual page
  // lives entirely on its Facebook account's own card.
  run("INSERT INTO fb_tokens (name, token_encrypted) VALUES ('App 1', 'x')");
  const token = get<{ id: number }>("SELECT id FROM fb_tokens WHERE name = 'App 1'")!.id;
  run("INSERT INTO fb_pages (page_id, name, token_id) VALUES ('1', 'A', ?), ('2', 'B', ?)", token, token);
  const a = get<{ id: number }>("SELECT id FROM fb_pages WHERE page_id = '1'")!.id;
  const page = await app.inject({ method: 'GET', url: '/accounts', headers: { cookie } });
  expect(page.body).toContain('Delete selected');
  const r = await app.inject({ method: 'POST', url: '/settings/facebook/pages/delete', payload: `pick=${a}`, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });
  expect(r.statusCode).toBe(303);
  expect(get<{ n: number }>('SELECT COUNT(*) AS n FROM fb_pages')!.n).toBe(1);
});
