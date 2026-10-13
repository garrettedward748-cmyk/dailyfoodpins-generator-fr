import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createRun,
  insertKeyword,
  markRunHeld,
  setLink,
  upsertSite,
} from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Every form on every page must post somewhere that exists.
 *
 * Written after `POST /keywords/import` was deleted by a block removal that
 * was aiming at the routes either side of it. Nothing failed: it typechecked,
 * 447 tests passed, and the button stayed on the page. The only symptom was a
 * 404 in someone's face days later, on the one page you cannot use the app
 * without.
 *
 * A unit test per route would not have caught it either, because the route
 * that vanished had no test — that is what made it deletable. So this asserts
 * the property instead: crawl the rendered HTML, collect every action and
 * internal href, and check the server answers each of them with something
 * other than "no such route".
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

/** Pages worth crawling: everything with a form on it. */
const PAGES = [
  '/',
  '/runs',
  '/sites',
  '/keywords',
  '/keywords/add',
  '/reels',
  '/accounts',
  '/events',
  '/settings',
  '/settings/keys',
  '/settings/prompts',
  '/settings/account',
];

describe('every control points at a route that exists', () => {
  let app: FastifyInstance;
  let cookie: string;
  let extra: string[] = [];

  beforeAll(async () => {
    setLogLevel('error');
    openDatabase(':memory:');

    // Enough rows that the per-record pages render with real ids in their
    // form actions rather than collapsing to empty states.
    const siteId = upsertSite(
      {
        name: 'bitespoon',
        domain: 'bitespoon.com',
        status: 'active',
        pin_username: '',
        project_id: '',
        daily_target: 3,
        interval_minutes: 60,
      },
      KEY,
    );
    const keywordId = insertKeyword({
      seed_keyword: 'chicken thighs',
      spy_title: 'Honey Soy Chicken Thighs',
      status: 'go',
    });
    setLink(keywordId, siteId, 'go');

    const runId = createRun(keywordId, siteId);
    markRunHeld(runId, 'awaiting', 'Honey Soy Chicken Thighs');

    extra = [`/sites/${siteId}`, `/keywords/${keywordId}`, `/runs/${runId}`];

    app = buildServer(new Settings(KEY), KEY, {
      password: PASSWORD,
      secret: KEY,
      generated: false,
    });
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

  afterAll(async () => {
    await app.close();
    closeDatabase();
  });

  /** Collect form actions and internal links from one rendered page. */
  const controlsOn = async (url: string): Promise<{ posts: string[]; gets: string[] }> => {
    const response = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(response.statusCode, `${url} should render`).toBe(200);

    const posts = [...response.body.matchAll(/<form[^>]*method="post"[^>]*action="([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    const gets = [...response.body.matchAll(/href="(\/[^"#?]*)/g)]
      .map((m) => m[1]!)
      .filter((href) => !href.startsWith('/static/'));

    return { posts, gets };
  };

  it('crawls every page and finds no dead control', async () => {
    const posts = new Set<string>();
    const gets = new Set<string>();

    for (const url of [...PAGES, ...extra]) {
      const found = await controlsOn(url);
      found.posts.forEach((a) => posts.add(a));
      found.gets.forEach((h) => gets.add(h));
    }

    // Sanity: the crawl has to have actually found things, or this test would
    // pass by finding nothing and checking nothing.
    expect(posts.size).toBeGreaterThan(15);
    expect(gets.size).toBeGreaterThan(15);

    const dead: string[] = [];

    for (const url of posts) {
      // The database is in memory and thrown away, so a real POST is safe and
      // is the only way to be sure the route resolves the way a browser's
      // submission would.
      const res = await app.inject({
        method: 'POST',
        url,
        payload: '',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      });
      if (res.statusCode === 404) dead.push(`POST ${url}`);
    }

    for (const url of gets) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      if (res.statusCode === 404) dead.push(`GET ${url}`);
    }

    expect(dead, 'controls pointing at routes that do not exist').toEqual([]);
  });

  it('serves the import endpoints the CSV buttons post to', async () => {
    // Named explicitly as well as crawled: these two are the whole of bulk
    // entry, and losing one is losing the ability to load the app with work.
    for (const url of ['/keywords/import', '/sites/import']) {
      const res = await app.inject({
        method: 'POST',
        url,
        payload: '',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.statusCode, `POST ${url}`).not.toBe(404);
    }
  });
});
