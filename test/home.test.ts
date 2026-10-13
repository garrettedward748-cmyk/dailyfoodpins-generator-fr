import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  createRun,
  insertFbToken,
  insertKeyword,
  markRunHeld,
  markRunPublished,
  upsertFbPage,
  upsertSite,
} from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';
import { mergeRecent } from '../src/web/views/home.js';

/**
 * Home answers "what is happening, and what do you need from me?" -- and
 * every answer to the second question is one line with one button.
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

describe('the home page', () => {
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

  const site = () =>
    upsertSite(
      { name: 'a', domain: 'a.com', status: 'active', pin_username: '', project_id: '',
        daily_target: 3, interval_minutes: 60 },
      KEY,
    );

  it('lists an article waiting for approval under "Needs you", with a Review button', async () => {
    const runId = createRun(insertKeyword({ seed_keyword: 'soup' }), site());
    markRunHeld(runId, 'awaiting', 'Soup');

    const body = (await get('/')).body;
    const needs = body.slice(body.indexOf('Needs you'), body.indexOf('Today'));
    expect(needs).toContain('waiting for approval');
    expect(needs).toContain(`href="/runs/${runId}"`);
    expect(needs).toContain('Review');
  });

  it('lists a Facebook page with no site, with an Assign button', async () => {
    const tokenId = insertFbToken('App', 'tok', KEY);
    upsertFbPage({ pageId: '1', name: 'Sweet Table', tokenId });

    const body = (await get('/')).body;
    const needs = body.slice(body.indexOf('Needs you'), body.indexOf('Today'));
    expect(needs).toContain('Sweet Table');
    expect(needs).toContain('href="/accounts#facebook-pages"');
  });

  it('says so when nothing needs a person', async () => {
    // A fresh install has real problems (no keys); give it the minimum.
    const body = (await get('/')).body;
    expect(body).toContain('Needs you');
    // Configuration problems still count as needing someone.
    expect(body).toContain('href="/settings/keys"');
  });

  it('turns automation on and off from the status bar', async () => {
    expect(settings.getBool('automation_enabled')).toBe(false);

    const on = await post('/automation', { enabled: '1' });
    expect(on.statusCode).toBe(303);
    expect(String(on.headers.location)).toMatch(/^\/(\?|$)/);
    expect(settings.getBool('automation_enabled')).toBe(true);

    await post('/automation', { enabled: '0' });
    expect(settings.getBool('automation_enabled')).toBe(false);
  });

  it('shows the site table under Channels, not on Home', async () => {
    site();
    const body = (await get('/')).body;
    expect(body).not.toContain('Eligible now?');
  });

  it('serves decisions as a page of its own under Activity', async () => {
    const response = await get('/decisions');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Decisions');
    expect(response.body).toContain('<nav class="subnav"');
  });
});

describe('the recent list', () => {
  it('merges articles and reels newest first', () => {
    const runs = [
      { id: 1, started_at: '2026-09-15 10:00:00', status: 'published', site_domain: 'a.com',
        seed_keyword: 'soup', title: 'Soup', failed_step: null, hold: '' },
      { id: 2, started_at: '2026-09-15 12:00:00', status: 'failed', site_domain: 'a.com',
        seed_keyword: 'pie', title: '', failed_step: 'generate-image-hero', hold: '' },
    ] as never[];
    const reels = [
      { id: 7, created_at: '2026-09-15 11:00:00', status: 'published', page_name: 'Sweet',
        seed_keyword: 'soup', run_title: 'Soup', error: null },
    ] as never[];

    const items = mergeRecent(runs, reels);
    expect(items.map((i) => i.href)).toEqual(['/runs/2', '/reels/7', '/runs/1']);
    expect(items[0]!.detail).toBe('failed at generate-image-hero');
    expect(items[1]).toMatchObject({ kind: 'reel', what: 'Sweet · soup' });
    expect(items[2]).toMatchObject({ kind: 'article', detail: '' });
  });
});
