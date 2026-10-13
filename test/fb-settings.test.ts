import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  getFbPage,
  insertFbToken,
  insertKeyword,
  listFbPages,
  listFbTokens,
  setFbPageOptions,
  syncFbPages,
  upsertSite,
} from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Settings -> Facebook is two tables. A token brings its pages the moment it
 * is added; a page belongs to one site. Nothing on the page waits for Graph.
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

let app: FastifyInstance;
let cookie: string;

/** Answer /me/accounts with these pages, and nothing else over the network. */
const graphReturns = (pages: { id: string; name: string }[]): void => {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    if (!url.includes('/me/accounts')) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify({ data: pages }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
};

const post = (url: string, fields: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url,
    payload: new URLSearchParams(fields).toString(),
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  });

const flashOf = (res: { headers: Record<string, unknown> }): string =>
  decodeURIComponent(String(res.headers.location ?? '')).replace(/\+/g, ' ');

const mkSite = (domain: string) =>
  upsertSite({ name: domain, domain, status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);

const sorted = () => [...listFbPages()].sort((a, b) => a.page_id.localeCompare(b.page_id));

/** One page's row of the pages form, the way the form names its fields. */
const row = (
  id: number,
  f: { site?: number; auto?: boolean; enabled?: boolean; presenter?: string },
): Record<string, string> => ({
  [`site_${id}`]: f.site ? String(f.site) : '',
  ...(f.auto ? { [`auto_${id}`]: 'on' } : {}),
  ...(f.enabled ? { [`enabled_${id}`]: 'on' } : {}),
  ...(f.presenter !== undefined ? { [`presenter_${id}`]: f.presenter } : {}),
});

beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');

  const settings = new Settings(KEY);
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
  vi.unstubAllGlobals();
  await app.close();
  closeDatabase();
});

describe('Settings -> Facebook', () => {
  it('adding a token lists its pages at once', async () => {
    graphReturns([
      { id: '1', name: 'One' },
      { id: '2', name: 'Two' },
    ]);

    const res = await post('/settings/facebook/tokens', { name: 'App 1', token: 'EAAB' });

    expect(res.statusCode).toBe(303);
    expect(flashOf(res)).toContain('App 1: 2 page(s)');
    expect(listFbPages().map((p) => p.name).sort()).toEqual(['One', 'Two']);
    expect(listFbTokens()[0]!.page_count).toBe(2);
  });

  it('a token Graph refuses is not saved, and the reason is in the message', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const res = await post('/settings/facebook/tokens', { name: 'Bad', token: 'nope' });

    expect(flashOf(res)).toContain('not saved');
    expect(flashOf(res)).toContain('Invalid OAuth');
    expect(listFbTokens()).toEqual([]);
    expect(listFbPages()).toEqual([]);
  });

  it('refuses an empty token without creating anything', async () => {
    const res = await post('/settings/facebook/tokens', { name: 'X', token: '  ' });
    expect(flashOf(res)).toContain('error=');
    expect(listFbTokens()).toEqual([]);
  });

  it('gives a page a site, and two pages may share one (they take turns)', async () => {
    const a = mkSite('a.com');
    graphReturns([
      { id: '1', name: 'One' },
      { id: '2', name: 'Two' },
    ]);
    await post('/settings/facebook/tokens', { name: 'A', token: 'x' });
    const [one, two] = sorted();

    let res = await post(`/settings/facebook/pages/${one!.id}`, row(one!.id, { site: a, auto: true, enabled: true }));
    expect(flashOf(res)).toContain('ok=');
    expect(getFbPage(one!.id)).toMatchObject({ site_id: a, auto_publish: 1, enabled: 1 });

    res = await post(`/settings/facebook/pages/${two!.id}`, row(two!.id, { site: a, auto: true, enabled: true }));
    expect(flashOf(res)).toContain('ok=');
    expect(getFbPage(two!.id)!.site_id).toBe(a);
  });

  it('an unticked box is off', async () => {
    graphReturns([{ id: '1', name: 'One' }]);
    await post('/settings/facebook/tokens', { name: 'A', token: 'x' });

    const id = listFbPages()[0]!.id;
    await post(`/settings/facebook/pages/${id}`, row(id, {}));

    expect(listFbPages()[0]).toMatchObject({ site_id: null, auto_publish: 0, enabled: 0 });
  });

  it('refuses a site that does not exist', async () => {
    graphReturns([{ id: '1', name: 'One' }]);
    await post('/settings/facebook/tokens', { name: 'A', token: 'x' });

    const id = listFbPages()[0]!.id;
    const res = await post(`/settings/facebook/pages/${id}`, row(id, { site: 999, enabled: true }));

    expect(flashOf(res)).toContain('no longer exists');
  });

  it('saves every page at once, even two swapping sites', async () => {
    const a = mkSite('a.com');
    const b = mkSite('b.com');
    graphReturns([
      { id: '1', name: 'One' },
      { id: '2', name: 'Two' },
      { id: '3', name: 'Three' },
    ]);
    await post('/settings/facebook/tokens', { name: 'A', token: 'x' });
    const [one, two, three] = sorted();
    setFbPageOptions(one!.id, { siteId: a, autoPublish: true, enabled: true });
    setFbPageOptions(two!.id, { siteId: b, autoPublish: true, enabled: true });

    const res = await post('/settings/facebook/pages', {
      ...row(one!.id, { site: b, auto: true, enabled: true }),
      ...row(two!.id, { site: a, auto: false, enabled: true }),
      ...row(three!.id, { site: 0, auto: true, enabled: false }),
    });

    expect(flashOf(res)).toContain('3 page(s) saved');
    expect(getFbPage(one!.id)).toMatchObject({ site_id: b, auto_publish: 1, enabled: 1 });
    expect(getFbPage(two!.id)).toMatchObject({ site_id: a, auto_publish: 0, enabled: 1 });
    expect(getFbPage(three!.id)).toMatchObject({ site_id: null, auto_publish: 1, enabled: 0 });
  });

  it('saving all reports the pages it could not save and keeps the rest', async () => {
    const a = mkSite('a.com');
    graphReturns([
      { id: '1', name: 'One' },
      { id: '2', name: 'Two' },
    ]);
    await post('/settings/facebook/tokens', { name: 'A', token: 'x' });
    const [one, two] = sorted();

    const res = await post('/settings/facebook/pages', {
      ...row(one!.id, { site: a, enabled: true }),
      ...row(two!.id, { site: 999, enabled: true }),
    });

    expect(flashOf(res)).toContain('1 page(s) saved');
    expect(flashOf(res)).toContain('Two: ');
    expect(getFbPage(one!.id)!.site_id).toBe(a);
    expect(getFbPage(two!.id)!.site_id).toBeNull();
  });

  it('refreshing a token disables a page it no longer manages', async () => {
    graphReturns([
      { id: '1', name: 'One' },
      { id: '2', name: 'Two' },
    ]);
    await post('/settings/facebook/tokens', { name: 'A', token: 'x' });

    graphReturns([{ id: '1', name: 'One' }]);
    const res = await post(`/settings/facebook/tokens/${listFbTokens()[0]!.id}/refresh`, {});

    expect(flashOf(res)).toContain('1 no longer there');
    expect(sorted()[1]).toMatchObject({ enabled: 0 });
  });

  it('removing a token removes its pages', async () => {
    graphReturns([{ id: '1', name: 'One' }]);
    await post('/settings/facebook/tokens', { name: 'A', token: 'x' });

    await post(`/settings/facebook/tokens/${listFbTokens()[0]!.id}/delete`, {});

    expect(listFbTokens()).toEqual([]);
    expect(listFbPages()).toEqual([]);
  });

  it('renders the page without calling Graph', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('no network on render');
    });
    const a = mkSite('a.com');
    const token = insertFbToken('A', 'x', KEY);
    syncFbPages(token, [{ id: '1', name: 'One' }]);
    setFbPageOptions(listFbPages()[0]!.id, { siteId: a, autoPublish: true, enabled: true });

    const res = await app.inject({ method: 'GET', url: `/accounts/${a}`, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Tokens');
    expect(res.body).toContain('Pages');
    expect(res.body).toMatch(new RegExp(`value="${a}"\\s+selected`));
    expect(res.body).not.toMatch(/route/i);
  });
});
