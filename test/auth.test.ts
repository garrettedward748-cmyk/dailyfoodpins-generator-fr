import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * The UI holds every credential and can publish to live sites. Deployed on a
 * Docker platform it gets a public URL, so these tests exist to make sure a
 * refactor can never quietly leave it open.
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

describe('authentication', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
    app = buildServer(new Settings(KEY), KEY, {
      password: PASSWORD,
      secret: KEY,
      generated: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  const login = async (password: string) =>
    app.inject({
      method: 'POST',
      url: '/login',
      payload: new URLSearchParams({ password }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

  const sessionCookie = async (): Promise<string> => {
    const response = await login(PASSWORD);
    const header = response.headers['set-cookie'];
    return Array.isArray(header) ? header[0]! : String(header);
  };

  describe('protected routes', () => {
    const PROTECTED = [
      '/', '/runs', '/sites', '/keywords', '/decisions', '/settings', '/events',
    ];

    it.each(PROTECTED)('%s requires a session', async (path) => {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode).toBe(401);
      // The login form, not a particular sentence — the copy is free to change.
      expect(response.body).toContain('action="/login"');
      expect(response.body).toContain('name="password"');
    });

    it('does not leak page content in the unauthorised response', async () => {
      const response = await app.inject({ method: 'GET', url: '/settings' });
      expect(response.body).not.toContain('LLM endpoints');
      expect(response.body).not.toContain('Site API token');
    });

    it('rejects mutations without a session', async () => {
      const response = await app.inject({ method: 'POST', url: '/run-now' });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a forged cookie', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/settings',
        headers: { cookie: 'ap_session=9999999999999.abc.forged-signature' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a session signed with a different key', async () => {
      const other = buildServer(new Settings(KEY), KEY, {
        password: PASSWORD,
        secret: randomBytes(32),
        generated: false,
      });
      await other.ready();

      const stolen = await other.inject({
        method: 'POST',
        url: '/login',
        payload: new URLSearchParams({ password: PASSWORD }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      const cookie = String(
        Array.isArray(stolen.headers['set-cookie'])
          ? stolen.headers['set-cookie'][0]
          : stolen.headers['set-cookie'],
      );
      await other.close();

      const response = await app.inject({ method: 'GET', url: '/', headers: { cookie } });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('public routes', () => {
    it('/healthz is reachable so the platform can health check', async () => {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true });
    });

    it('/healthz exposes no secrets', async () => {
      const body = await app.inject({ method: 'GET', url: '/healthz' });
      expect(body.body).not.toContain(PASSWORD);
    });

    it('the stylesheet loads so the login page is not unstyled', async () => {
      const response = await app.inject({ method: 'GET', url: '/static/style.css' });
      expect(response.statusCode).toBe(200);
    });

    it('/login is reachable', async () => {
      expect((await app.inject({ method: 'GET', url: '/login' })).statusCode).toBe(200);
    });
  });

  describe('signing in', () => {
    it('accepts the correct password and sets an HttpOnly cookie', async () => {
      const response = await login(PASSWORD);
      expect(response.statusCode).toBe(303);

      const cookie = String(
        Array.isArray(response.headers['set-cookie'])
          ? response.headers['set-cookie'][0]
          : response.headers['set-cookie'],
      );
      expect(cookie).toContain('ap_session=');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
    });

    it('rejects the wrong password', async () => {
      const response = await login('wrong');
      expect(response.statusCode).toBe(401);
      expect(response.body).toContain('Incorrect password');
    });

    it('rejects an empty password', async () => {
      expect((await login('')).statusCode).toBe(401);
    });

    it('grants access to every page once signed in', async () => {
      const cookie = await sessionCookie();
      for (const path of ['/', '/runs', '/sites', '/keywords', '/settings']) {
        const response = await app.inject({ method: 'GET', url: path, headers: { cookie } });
        expect(response.statusCode, `${path} should be reachable`).toBe(200);
      }
    });

    it('signing out invalidates the cookie', async () => {
      const cookie = await sessionCookie();
      const response = await app.inject({ method: 'POST', url: '/logout', headers: { cookie } });

      expect(response.statusCode).toBe(303);
      const cleared = String(
        Array.isArray(response.headers['set-cookie'])
          ? response.headers['set-cookie'][0]
          : response.headers['set-cookie'],
      );
      expect(cleared).toContain('Max-Age=0');
    });
  });
});
