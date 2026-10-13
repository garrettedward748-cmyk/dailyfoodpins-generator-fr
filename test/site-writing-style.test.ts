import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { getSite, upsertSite } from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

const seed = (domain: string, id?: number): number =>
  upsertSite(
    { name: domain.split('.')[0]!, domain, status: 'active', pin_username: '', project_id: '', daily_target: 3, interval_minutes: 60 },
    KEY,
    id,
  );

describe('migration 051', () => {
  const migration = MIGRATIONS.find((m) => m.id === '051-site-writing-style')!;

  it('keeps every existing site British, and starts flavorza.com American', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE sites (id INTEGER PRIMARY KEY, domain TEXT)');
    db.prepare('INSERT INTO sites (domain) VALUES (?), (?), (?)').run('arbmom.com', 'flavorza.com', 'dailyfoodpins.com');

    migration.up(db);

    const rows = db.prepare('SELECT domain, writing_style FROM sites ORDER BY id').all() as { domain: string; writing_style: string }[];
    expect(rows).toEqual([
      { domain: 'arbmom.com', writing_style: 'uk' },
      { domain: 'flavorza.com', writing_style: 'us' },
      { domain: 'dailyfoodpins.com', writing_style: 'uk' },
    ]);
    db.close();
  });
});

describe('the site setting', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
    app = buildServer(new Settings(KEY), KEY, { password: PASSWORD, secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/login',
      payload: new URLSearchParams({ password: PASSWORD }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const header = login.headers['set-cookie'];
    cookie = Array.isArray(header) ? header[0]! : String(header);
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  const post = (url: string, fields: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      payload: new URLSearchParams(fields).toString(),
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    });

  it('starts a new site as American', () => {
    expect(getSite(seed('fresh.com'))!.writing_style).toBe('us');
  });

  it('keeps the style when the site is saved again', async () => {
    const id = seed('bitespoon.com');
    await post(`/sites/${id}/style`, { writing_style: 'uk' });
    seed('bitespoon.com', id);
    expect(getSite(id)!.writing_style).toBe('uk');
  });

  it('switches with the site page form, both ways', async () => {
    const id = seed('bitespoon.com');

    const toUk = await post(`/sites/${id}/style`, { writing_style: 'uk' });
    expect(toUk.statusCode).toBe(303);
    expect(getSite(id)!.writing_style).toBe('uk');

    await post(`/sites/${id}/style`, { writing_style: 'us' });
    expect(getSite(id)!.writing_style).toBe('us');
  });

  it('treats anything unrecognised as American, never as a third style', async () => {
    const id = seed('bitespoon.com');
    await post(`/sites/${id}/style`, { writing_style: 'uk' });
    await post(`/sites/${id}/style`, { writing_style: 'martian' });
    expect(getSite(id)!.writing_style).toBe('us');
  });

  it('does not fail for a site that is not there', async () => {
    const res = await post('/sites/9999/style', { writing_style: 'uk' });
    expect(res.statusCode).toBe(303);
  });

  it('offers the choice on the site page, with the current one selected', async () => {
    const id = seed('bitespoon.com');
    await post(`/sites/${id}/style`, { writing_style: 'uk' });
    const page = await app.inject({ method: 'GET', url: `/sites/${id}`, headers: { cookie } });
    expect(page.body).toContain('name="writing_style"');
    expect(page.body).toMatch(/<option value="uk" selected/);
  });
});
