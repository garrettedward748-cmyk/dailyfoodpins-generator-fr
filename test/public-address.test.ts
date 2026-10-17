import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { getSetting } from '../src/db/repos.js';
import { DETECTED_PUBLIC_URL, Settings } from '../src/settings.js';
import { buildServer, requestOrigin, sameOrigin } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * "Public address of this platform" fills itself in with the address the
 * platform is opened at, and stays automatic unless someone types another.
 */

const KEY = randomBytes(32);
const req = (headers: Record<string, string>, protocol = 'http') => ({ headers, protocol }) as never;

describe('the address a request came in at', () => {
  it("takes the proxy's forwarded host and scheme first", () => {
    expect(requestOrigin(req({ host: 'app:3000', 'x-forwarded-host': '100.recipenestle.com', 'x-forwarded-proto': 'https' }))).toBe('https://100.recipenestle.com');
    expect(requestOrigin(req({ host: 'Platform.Example.com:443' }, 'https'))).toBe('https://platform.example.com');
  });

  it('skips a local or bare-IP address, which Buffer could never reach', () => {
    for (const host of ['localhost:3000', '127.0.0.1:3000', '10.0.0.5', 'app']) expect(requestOrigin(req({ host }))).toBeNull();
  });

  it('compares addresses without minding case or a trailing slash', () => {
    expect(sameOrigin('https://100.recipenestle.com/', 'https://100.Recipenestle.com')).toBe(true);
    expect(sameOrigin('', 'https://x.com')).toBe(false);
  });
});

describe('the setting', () => {
  let app: FastifyInstance;
  let settings: Settings;
  let cookie: string;
  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
    settings = new Settings(KEY);
    app = buildServer(settings, KEY, { password: 'pw-123456', secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({
      method: 'POST', url: '/login', payload: 'password=pw-123456',
      headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'gen.example.com', 'x-forwarded-proto': 'https' },
    });
    const header = login.headers['set-cookie'];
    cookie = Array.isArray(header) ? header[0]! : String(header);
  });
  afterEach(async () => { await app.close(); closeDatabase(); });

  it('is the address the platform was opened at, shown on Settings, and kept automatic when saved unchanged', async () => {
    expect(getSetting(DETECTED_PUBLIC_URL, KEY)).toBe('https://gen.example.com');
    expect(settings.get('public_url')).toBe('https://gen.example.com');
    const page = await app.inject({ method: 'GET', url: '/settings', headers: { cookie, host: 'gen.example.com' } });
    expect(page.body).toContain('value="https://gen.example.com"');

    await app.inject({
      method: 'POST', url: '/settings', payload: 'public_url=https%3A%2F%2Fgen.example.com%2F',
      headers: { cookie, host: 'gen.example.com', 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(getSetting('public_url', KEY)).toBe('');
    // Moved to another domain: it follows.
    await app.inject({ method: 'GET', url: '/settings', headers: { cookie, host: 'new.example.org', 'x-forwarded-proto': 'https' } });
    expect(settings.get('public_url')).toBe('https://new.example.org');
  });

  it('keeps an address typed in by hand', async () => {
    await app.inject({
      method: 'POST', url: '/settings', payload: 'public_url=https%3A%2F%2Fmedia.example.net',
      headers: { cookie, host: 'gen.example.com', 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(settings.get('public_url')).toBe('https://media.example.net');
  });
});
