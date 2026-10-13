import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, get as dbGet, openDatabase, run } from '../src/db/index.js';
import {
  bulkSetKeywordStatus,
  createRun,
  getLinkShare,
  getKeyword,
  markRunPublished,
  insertKeyword,
  loadLinkGrid,
  setLink,
  upsertSite,
} from '../src/db/repos.js';
import { exportDataset } from '../src/db/exports.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * The pages that changed shape: the rail lost Prompts, Decisions and Browser;
 * the keywords table gained bulk editing; and history became something you can
 * export and delete. The last of those destroys data, so it is tested the way
 * anything destructive should be — including the case where it must refuse.
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

const seedSite = (domain: string): number =>
  upsertSite(
    {
      name: domain.split('.')[0]!,
      domain,
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 3,
      interval_minutes: 60,
    },
    KEY,
  );

describe('web UI after the layout changes', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
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

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });

  const post = (url: string, fields: Record<string, string | string[]>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      for (const one of Array.isArray(value) ? value : [value]) params.append(key, one);
    }
    return app.inject({
      method: 'POST',
      url,
      payload: params.toString(),
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    });
  };

  /* -- navigation ------------------------------------------------------- */

  describe('navigation', () => {
    it('puts the browser behind a button that opens its own tab', async () => {
      const response = await get('/');
      expect(response.body).toContain('class="button browser"');
      expect(response.body).toContain('target="_blank"');
    });

    it('lists the seven sections in the rail, and nothing else', async () => {
      // Pages are not in the rail: they are tabs inside their section. A rail
      // that listed pages by table -- Sites, Keywords, Runs, Events -- left a
      // new person not knowing where to start.
      const response = await get('/');
      const rail = response.body.slice(
        response.body.indexOf('<nav>'),
        response.body.indexOf('</nav>'),
      );
      const links = [...rail.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(links).toEqual(['/', '/runs', '/sites', '/gsc', '/taxonomy', '/events', '/settings']);
    });

    it("shows a section's pages as tabs, with the current one marked", async () => {
      const response = await get('/settings/prompts');
      const tabs = response.body.slice(
        response.body.indexOf('<nav class="subnav"'),
        response.body.indexOf('</nav>', response.body.indexOf('<nav class="subnav"')),
      );
      expect(tabs).toContain('href="/settings/keys"');
      expect(tabs).toMatch(/href="\/settings\/prompts" class="active"/);
      expect(tabs).not.toContain('href="/sites"');
    });

    it('serves decisions as a page under Activity', async () => {
      const response = await get('/decisions?cycle=abc');
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('href="/events"');
    });

    it('serves the prompts editor from under settings', async () => {
      const response = await get('/settings/prompts');
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Prompts');
    });

    it('keeps deployment wiring off the settings page', async () => {
      // These resolve from their defaults and their environment overrides
      // exactly as before. They are simply not questions worth asking: the
      // image service URL is always the container next door, and the poll
      // numbers are a timeout nobody has needed to move.
      const response = await get('/settings');

      for (const key of [
        'timezone',
        'llm_base_url',
        'image_base_url',
        'image_poll_interval_seconds',
        'image_poll_max_attempts',
      ]) {
        expect(response.body).not.toContain(`name="${key}"`);
      }
    });

    it('offers the image model as a picker, and saves the pick', async () => {
      // Hidden from the generic renderer -- it is drawn by the images group's
      // footer so each model's verdict from Google can sit beside it -- but
      // still a setting: the select submits under its key and the save stores
      // it. Picking the third model and running an article is how a name read
      // off the Flow page gets verified, so the pick has to round-trip.
      const before = await get('/settings');
      expect(before.body).toContain('name="image_model"');
      expect(before.body).toContain('value="auto"');
      expect(before.body).toContain('value="NANO_BANANA_PRO"');
      expect(before.body).toContain('value="NANO_BANANA_2_LITE"');

      // Saving an images-group setting checks the image service is reachable.
      // There is none here; answer at once rather than waiting out a timeout.
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error('no image service in tests');
      }) as unknown as typeof fetch;
      try {
        await post('/settings', { image_model: 'NANO_BANANA_2' });
      } finally {
        globalThis.fetch = realFetch;
      }

      const { Settings } = await import('../src/settings.js');
      expect(new Settings(KEY).get('image_model')).toBe('NANO_BANANA_2');
      const after = await get('/settings');
      expect(after.body).toMatch(/value="NANO_BANANA_2"\s+selected/);
    });

    it('still resolves the hidden values', async () => {
      const { Settings } = await import('../src/settings.js');
      const settings = new Settings(KEY);

      expect(settings.get('image_base_url')).toContain('imagegen');
      expect(settings.getNumber('image_poll_max_attempts')).toBe(120);
      expect(settings.get('timezone')).not.toBe('');
    });

    it('still asks for the things that are real decisions', async () => {
      const response = await get('/settings');

      expect(response.body).toContain('name="automation_enabled"');
      expect(response.body).not.toContain('name="flow_project_id"'); // per Google account now
      expect(response.body).toContain('name="tick_minutes"');
    });

    it('does not lecture about environment variables', async () => {
      // They are read once when the container starts, so a field for them
      // would look like it worked and change nothing — and a table explaining
      // that is a paragraph of deployment trivia on a page meant for the two
      // or three decisions somebody actually makes. It lives in DEPLOY.md.
      const response = await get('/settings');

      expect(response.body).not.toContain('Set where the app is deployed');
      expect(response.body).not.toContain('WATCHDOG_DISCONNECT_GRACE');
      expect(response.body).not.toContain('MAX_CONCURRENT_REQUESTS');
    });

    it('links prompts from the settings page, and no history page', async () => {
      const response = await get('/settings');
      expect(response.body).toContain('href="/settings/prompts"');
      expect(response.body).not.toContain('href="/settings/data"');
      // Per-step token counts live on the run that spent them, not on a page
      // of their own.
      expect(response.body).not.toContain('href="/settings/usage"');
    });
  });

  /* -- dashboard -------------------------------------------------------- */

  describe('dashboard', () => {
    it('shows the decisions section with the reasons for a check', async () => {
      run(
        `INSERT INTO decisions (cycle_id, subject_type, subject_label, decision, reason)
         VALUES ('cycle-1', 'site', 'bitespoon.com', 'rejected', 'Daily publishing limit reached')`,
      );

      const response = await get('/decisions');
      expect(response.body).toContain('Decisions');
      expect(response.body).toContain('Daily publishing limit reached');
    });

    it('keeps the home recent list short instead of letting it grow', async () => {
      const siteId = seedSite('a.com');
      const keywordId = insertKeyword({ seed_keyword: 'k' });
      for (let i = 0; i < 20; i++) createRun(keywordId, siteId);

      const response = await get('/');
      const rows = (response.body.match(/href="\/runs\/\d+"/g) ?? []).length;
      expect(rows).toBeLessThanOrEqual(12);
    });
  });

  it("folds a published run's article away", async () => {
    // Browsing runs is the common case: you opened one to see why Buffer
    // rejected it, not to reread two thousand words of recipe.
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({
      seed_keyword: 'chicken',
      spy_title: 'Honey Soy',
      status: 'go',
    });
    const runId = createRun(keywordId, siteId);
    run(
      `INSERT INTO run_steps (run_id, step, status, output_json)
       VALUES (?, 'generate-article', 'ok', ?)`,
      runId,
      JSON.stringify({ title: 'Honey Soy', body: 'text' }),
    );
    markRunPublished(runId, 'p1', 'https://bitespoon.com/a', 'Honey Soy');

    const response = await get(`/runs/${runId}`);

    expect(response.body).toContain('<details class="card article" >');
    expect(response.body).not.toContain('<details class="card article" open>');
  });

  /* -- the view picker --------------------------------------------------- */

  describe('choosing a view', () => {
    let siteId: number;

    beforeEach(() => {
      siteId = seedSite('bitespoon.com');
      const going = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      insertKeyword({ seed_keyword: 'beef stew', status: 'done' });
      // Set to go and linked to nothing — supply on paper, nothing in practice.
      insertKeyword({ seed_keyword: 'lemon tart', status: 'go' });
      setLink(going, siteId, 'go');
    });

    it('defaults to everything', async () => {
      const response = await get('/keywords');
      expect(response.body).toContain('chicken soup');
      expect(response.body).toContain('beef stew');
      expect(response.body).toContain('lemon tart');
    });

    it('shows only what will actually publish', async () => {
      const response = await get('/keywords?view=queued');
      expect(response.body).toContain('chicken soup');
      expect(response.body).not.toContain('beef stew');
      expect(response.body).not.toContain('lemon tart');
    });

    it('finds the keywords that are going nowhere', async () => {
      // The state that counts as supply on the dashboard and publishes
      // nothing. It gets a view of its own precisely because it is invisible.
      const response = await get('/keywords?view=stuck');
      expect(response.body).toContain('lemon tart');
      expect(response.body).not.toContain('chicken soup');
    });

    it('shows the finished ones', async () => {
      const response = await get('/keywords?view=done');
      expect(response.body).toContain('beef stew');
      expect(response.body).not.toContain('chicken soup');
    });

    it('narrows a view to one site', async () => {
      const other = seedSite('longlivo.com');
      const response = await get(`/keywords?view=queued&site=${other}`);
      expect(response.body).not.toContain('chicken soup');
      expect(response.body).toContain('longlivo.com');
    });

    it('searches the words', async () => {
      const response = await get('/keywords?q=chicken');
      expect(response.body).toContain('chicken soup');
      expect(response.body).not.toContain('beef stew');
    });

    it('explains what the chosen view means', async () => {
      const response = await get('/keywords?view=stuck');
      expect(response.body).toContain('no site is set to go for it');
    });

    it('keeps the search on the form after a reload', async () => {
      const response = await get('/keywords?q=chicken');
      expect(response.body).toContain('value="chicken"');
    });

    it('falls back to everything for a view it does not know', async () => {
      const response = await get('/keywords?view=nonsense');
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('beef stew');
    });
  });

  /* -- bulk actions ------------------------------------------------------- */

  describe('bulk actions', () => {
    let siteA: number;
    let siteB: number;
    let one: number;
    let two: number;

    beforeEach(() => {
      siteA = seedSite('bitespoon.com');
      siteB = seedSite('longlivo.com');
      one = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      two = insertKeyword({ seed_keyword: 'beef stew', status: 'go' });
    });

    it('publishes the ticked keywords on every site', async () => {
      await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'publish-on',
        site_id: '',
        back: '/keywords',
      });

      const grid = loadLinkGrid().filter((l) => l.keywordId === one);
      expect(grid).toHaveLength(2);
      expect(grid.every((l) => l.status === 'go')).toBe(true);
    });

    it('publishes on only the site that was chosen', async () => {
      await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'publish-on',
        site_id: String(siteA),
        back: '/keywords',
      });

      const grid = loadLinkGrid().filter((l) => l.keywordId === one);
      expect(grid).toHaveLength(1);
      expect(grid[0]?.siteId).toBe(siteA);
    });

    it('switches a keyword back on when publishing it', async () => {
      // Setting the cell alone would leave a keyword whose own status is `no`
      // looking correct on the page and still never being offered.
      bulkSetKeywordStatus([one], 'no');

      await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'publish-on',
        site_id: String(siteA),
        back: '/keywords',
      });

      expect(getKeyword(one)?.status).toBe('go');
    });

    it('stops the ticked keywords on a site', async () => {
      setLink(one, siteA, 'go');

      await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'stop-on',
        site_id: String(siteA),
        back: '/keywords',
      });

      expect(loadLinkGrid().find((l) => l.keywordId === one)?.status).toBe('no');
    });

    it('marks them finished', async () => {
      await post('/keywords/bulk', {
        ids: [String(one), String(two)],
        action: 'finish',
        back: '/keywords',
      });

      expect(getKeyword(one)?.status).toBe('done');
      expect(getKeyword(two)?.status).toBe('done');
    });

    it('turns them off', async () => {
      await post('/keywords/bulk', { ids: [String(one)], action: 'off', back: '/keywords' });
      expect(getKeyword(one)?.status).toBe('no');
    });

    it('switches image reuse off', async () => {
      setLink(one, siteA, 'go');
      setLink(one, siteB, 'go');

      await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'share-off',
        site_id: '',
        back: '/keywords',
      });

      expect(getLinkShare(one, siteA)).toBe(false);
      expect(getLinkShare(one, siteB)).toBe(false);
    });

    it('deletes every ticked keyword', async () => {
      await post('/keywords/bulk', {
        ids: [String(one), String(two)],
        action: 'delete',
        back: '/keywords',
      });

      expect(getKeyword(one)).toBeUndefined();
      expect(getKeyword(two)).toBeUndefined();
    });

    it('says so rather than acting when nothing is ticked', async () => {
      const response = await post('/keywords/bulk', { action: 'delete', back: '/keywords' });

      expect(response.headers.location).toContain('Nothing%20was%20ticked');
      expect(getKeyword(one)).toBeDefined();
    });

    it('refuses an action it does not have', async () => {
      const response = await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'drop-database',
        back: '/keywords',
      });

      expect(response.headers.location).toContain('error=');
      expect(getKeyword(one)?.status).toBe('go');
    });

    it('refuses to be redirected off this app', async () => {
      const response = await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'off',
        back: 'https://example.com/evil',
      });

      expect(response.headers.location).toMatch(/^\/keywords/);
    });

    it('returns to the view it came from', async () => {
      const response = await post('/keywords/bulk', {
        ids: [String(one)],
        action: 'off',
        back: '/keywords?view=queued',
      });

      expect(response.headers.location).toContain('/keywords?view=queued');
    });
  });

  /* -- history and storage ---------------------------------------------- */

  describe('exports', () => {
    beforeEach(() => {
      const site = seedSite('bitespoon.com');
      const keyword = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      run(
        `INSERT INTO runs (keyword_id, site_id, status, started_at, title, post_url)
         VALUES (?, ?, 'published', datetime('now'), 'Chicken Soup', 'https://bitespoon.com/chicken-soup')`,
        keyword,
        site,
      );
    });

    it('has no history page and nothing to clear, back up or compact', async () => {
      expect((await get('/settings/data')).statusCode).toBe(404);
      expect((await get('/data/backup')).statusCode).toBe(404);
      expect((await post('/data/clear', { what: 'runs', days: '0' })).statusCode).toBe(404);
      expect((await get('/data/export/runs')).statusCode).toBe(404);
      expect((await get('/data/export/events')).statusCode).toBe(404);
    });

    it('exports the articles from the Articles page', async () => {
      const page = await get('/runs');
      expect(page.body).toContain('href="/data/export/articles"');

      const response = await get('/data/export/articles');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('articles.csv');
      expect(response.body).toContain('Chicken Soup');
      expect(response.body).toContain('https://bitespoon.com/chicken-soup');
    });

    it('exports the reels from the Reels page', async () => {
      const page = await get('/reels');
      expect(page.body).toContain('href="/data/export/reels"');
      const response = await get('/data/export/reels');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('reels.csv');
    });

    it('exports keywords in the shape the importer reads back', () => {
      const data = exportDataset('keywords');
      expect(data.rows[0]).toEqual([
        'seed_keyword', 'spy_title', 'spy_description', 'annotation', 'status',
        'bitespoon.com',
      ]);
    });

    it('keeps site credentials out of the ordinary export', () => {
      // The columns are present and empty on purpose, so the file round-trips
      // through the importer without wiping the tokens it does not carry.
      // What matters is that no *value* is a credential.
      const sites = exportDataset('sites');
      const header = sites.rows[0]!;
      const api = header.indexOf('api_token');
      const buffer = header.indexOf('buffer_token');

      expect(api).toBeGreaterThan(-1);
      expect(buffer).toBeGreaterThan(-1);

      for (const row of sites.rows.slice(1)) {
        expect(row[api]).toBe('');
        expect(row[buffer]).toBe('');
      }
    });

    it('rejects an unknown dataset', async () => {
      expect((await get('/data/export/settings')).statusCode).toBe(404);
    });
  });
});
