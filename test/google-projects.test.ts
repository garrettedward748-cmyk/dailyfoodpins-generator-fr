import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, get, openDatabase } from '../src/db/index.js';
import { upsertSite } from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/** Flow projects belong to Google accounts, not to sites. */

const KEY = randomBytes(32);
let app: FastifyInstance;
let cookie: string;
const calls: { method: string; path: string; body: string }[] = [];
let accounts: { id: number; label: string; status: string; until: null; reason: null; active: boolean; project_id: string }[];

beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  calls.length = 0;
  accounts = [
    { id: 1, label: 'Account 1', status: 'ok', until: null, reason: null, active: true, project_id: '' },
    { id: 2, label: 'Second', status: 'ok', until: null, reason: null, active: false, project_id: '' },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method ?? 'GET', path, body: String(init.body ?? '') });
    const m = /\/flow\/accounts\/(\d+)\/project$/.exec(path);
    if (m) accounts.find((a) => a.id === Number(m[1]))!.project_id = JSON.parse(String(init.body)).project_id;
    const lim = /\/flow\/accounts\/(\d+)\/limits$/.exec(path);
    if (lim) Object.assign(accounts.find((a) => a.id === Number(lim[1]))!, JSON.parse(String(init.body)));
    if (/\/login$/.test(path)) {
      return new Response(JSON.stringify({ state: 'need_code', message: 'Google asks for a verification code.', running: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ accounts, pending: null }), { status: 200 });
  }));
  const settings = new Settings(KEY);
  settings.set('image_base_url', 'http://img');
  app = buildServer(settings, KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
  closeDatabase();
});

describe('Flow project per Google account', () => {
  it('moves the project typed on a site to account 1 and asks for one on the others', async () => {
    upsertSite({ name: 'D', domain: 'd.com', status: 'active', project_id: 'old-project', daily_target: 1, interval_minutes: 60 }, KEY);
    const page = await app.inject({ method: 'GET', url: '/settings/google', headers: { cookie } });
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/flow/accounts/1/project' && c.body.includes('old-project'))).toBe(true);
    expect(page.body).toContain('value="old-project"');
    expect(page.body).toContain('needs project ID');
  });

  it('saves a project for an account', async () => {
    const r = await app.inject({
      method: 'POST', url: '/settings/google/2/project', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'project_id=abc-123',
    });
    expect(r.statusCode).toBe(303);
    expect(accounts[1]!.project_id).toBe('abc-123');
  });

  it('no longer asks for a project on the site form, and keeps the stored one', async () => {
    const id = upsertSite({ name: 'D', domain: 'd.com', status: 'active', project_id: 'kept', daily_target: 1, interval_minutes: 60 }, KEY);
    const form = await app.inject({ method: 'GET', url: `/sites/${id}`, headers: { cookie } });
    expect(form.body).not.toContain('name="project_id"');
    upsertSite({ name: 'D2', domain: 'd.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY, id);
    expect(get<{ project_id: string }>('SELECT project_id FROM sites WHERE id = ?', id)?.project_id).toBe('kept');
  });

  it('saves credit limits, blank meaning none, and offers Remove on every account', async () => {
    const r = await app.inject({
      method: 'POST', url: '/settings/google/1/limits', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'daily_limit=&monthly_limit=50',
    });
    expect(r.statusCode).toBe(303);
    expect(accounts[0]).toMatchObject({ daily_limit: null, monthly_limit: 50 });
    const page = await app.inject({ method: 'GET', url: '/settings/google', headers: { cookie } });
    expect(page.body).toContain('action="/settings/google/1/remove"'); // the one in use too
    expect(page.body).toContain('action="/settings/google/2/remove"');
    expect(page.body).toContain('name="clip_cost"');
  });

  it('starts a sign-in with the Gmail and password, then shows its progress', async () => {
    const r = await app.inject({
      method: 'POST', url: '/settings/google/login', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'account=2&email=me%40gmail.com&password=p%26ss',
    });
    expect(r.headers.location).toBe('/settings/google?login=2');
    const sent = calls.find((c) => c.method === 'POST' && c.path === '/flow/accounts/2/login')!;
    expect(JSON.parse(sent.body)).toEqual({ email: 'me@gmail.com', password: 'p&ss' });
    const page = await app.inject({ method: 'GET', url: '/settings/google?login=2', headers: { cookie } });
    expect(page.body).toContain('verification code');
    expect(page.body).toContain('action="/settings/google/2/login/code"');
  });
});
