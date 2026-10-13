import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/** Setup → Collage: on/off, how many photographs, and the address watermark. */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

describe('collage settings', () => {
  let app: FastifyInstance;
  let cookie: string;
  let settings: Settings;

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
    settings = new Settings(KEY);
    app = buildServer(settings, KEY, { password: PASSWORD, secret: KEY, generated: false });
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

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (url: string, fields: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      payload: new URLSearchParams(fields).toString(),
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    });

  it('renders the three fields, off by default', async () => {
    const body = (await get('/settings/collage')).body;
    expect(body).toContain('name="collage_enabled"');
    expect(body).not.toMatch(/name="collage_enabled"[^>]*checked/);
    expect(body).toContain('name="collage_steps"');
    expect(body).toMatch(/value="9"\s+selected/);
    expect(body).toContain('name="collage_watermark"');
    expect(body).toMatch(/name="collage_watermark"[^>]*checked/); // on by default
  });

  it('saves what is posted, clamping the step count to 6/9/12', async () => {
    await post('/settings/collage', { collage_enabled: '1', collage_steps: '12', collage_watermark: '1' });
    expect(settings.getBool('collage_enabled')).toBe(true);
    expect(settings.getNumber('collage_steps')).toBe(12);
    expect(settings.getBool('collage_watermark')).toBe(true);

    // Unticking a checkbox means the form omits it entirely.
    await post('/settings/collage', { collage_steps: '7' });
    expect(settings.getBool('collage_enabled')).toBe(false);
    expect(settings.getNumber('collage_steps')).toBe(9); // 7 is not one of 6/9/12
    expect(settings.getBool('collage_watermark')).toBe(false);

    const body = (await get('/settings/collage')).body;
    expect(body).toMatch(/value="9"\s+selected/);
  });

  it('lists Collage as a Setup tab, next to Reels', async () => {
    const body = (await get('/settings')).body;
    expect(body).toContain('href="/settings/collage"');
  });
});
