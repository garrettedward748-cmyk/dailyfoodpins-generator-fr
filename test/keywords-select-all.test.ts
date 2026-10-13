import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { bulkDeleteKeywords, keywordIdsMatching } from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';

/** "Select all N in this view" reaches past the 100 rows one page shows. */

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  for (let i = 0; i < 4000; i++) {
    run("INSERT INTO keywords (seed_keyword, spy_title, status) VALUES ('dessert', ?, 'go')", `Recipe ${i}`);
  }
  run("INSERT INTO keywords (seed_keyword, spy_title, status) VALUES ('soup', 'Lentil soup', 'go')");
});
afterEach(() => closeDatabase());

it('finds every match and deletes them all at once', () => {
  const ids = keywordIdsMatching({ q: 'Recipe' });
  expect(ids).toHaveLength(4000);
  expect(bulkDeleteKeywords(ids)).toBe(4000);
  expect(keywordIdsMatching({})).toHaveLength(1);
});

it('applies publish to every match through the bulk form', async () => {
  const { randomBytes } = await import('node:crypto');
  const { buildServer } = await import('../src/web/server.js');
  const { Settings } = await import('../src/settings.js');
  const { get } = await import('../src/db/index.js');
  run("INSERT INTO sites (name, domain, status) VALUES ('D', 'd.com', 'active')");
  const key = randomBytes(32);
  const app = buildServer(new Settings(key), key, { password: 'correct-horse-battery-staple', secret: key, generated: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const r = await app.inject({
    method: 'POST', url: '/keywords/bulk', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ ids: '1', scope: 'all', filter_q: 'Recipe', filter_view: 'all', filter_site: '', action: 'publish-on', site_id: '', back: '/keywords' }).toString(),
  });
  await app.close();
  expect(r.statusCode).toBe(303);
  expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM keyword_sites WHERE status = 'go'")?.n).toBe(4000);
});
