import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { listEndpoints } from '../src/llm/pool.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('adding API keys', () => {
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
      headers: FORM,
    });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
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
      headers: { ...FORM, cookie },
    });

  it('refuses a key that is already stored when pasting several', async () => {
    await post('/settings/endpoints/bulk', { keys: 'abcdefgh12345678' });
    await post('/settings/endpoints/bulk', { keys: 'abcdefgh12345678\nsecondkey987654' });

    expect(listEndpoints(KEY).map((e) => e.apiKey).sort()).toEqual(['abcdefgh12345678', 'secondkey987654']);
  });

  it('refuses a stored key under a new label', async () => {
    await post('/settings/endpoints', { name: 'one', api_key: 'abcdefgh12345678' });
    await post('/settings/endpoints', { name: 'two', api_key: 'abcdefgh12345678' });

    expect(listEndpoints(KEY).map((e) => e.name)).toEqual(['one']);
  });

  it('shows the start of each key and never the whole of it', async () => {
    await post('/settings/endpoints/bulk', { keys: 'abcdefgh12345678' });
    const page = await app.inject({ method: 'GET', url: '/settings/keys', headers: { cookie } });

    expect(page.body).toContain('abcdefgh…');
    expect(page.body).not.toContain('abcdefgh12345678');
  });
});
