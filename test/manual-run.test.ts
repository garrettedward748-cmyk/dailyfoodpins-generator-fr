import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { insertKeyword, markRunPublished, createRun, setLink, upsertSite } from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { tick } from '../src/scheduler/index.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * "Run once now" starts the pair a person picked, immediately.
 *
 * It used to hand the decision back to the selector, which meant it ran
 * whatever the scheduler would have run anyway — and refused outright once
 * every site had hit its daily target, which is the moment someone reaches for
 * a manual run in the first place.
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

/**
 * Enough configuration that Settings.validate() passes.
 *
 * Without it every tick returns 'misconfigured' before it reaches the part
 * under test, and the assertions below would pass for the wrong reason.
 */
const configured = (): Settings => {
  process.env.IMAGE_API_KEY = 'test-image-key';
  const settings = new Settings(KEY);
  settings.set('flow_project_id', 'test-project');
  return settings;
};

let app: FastifyInstance;
let cookie: string;

const seed = () => {
  const siteId = upsertSite(
    {
      name: 'bitespoon',
      domain: 'bitespoon.com',
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 1,
      interval_minutes: 600,
    },
    KEY,
  );
  const keywordId = insertKeyword({
    seed_keyword: 'chicken thighs',
    spy_title: 'Honey Soy Chicken Thighs',
    status: 'go',
  });
  setLink(keywordId, siteId, 'go');
  return { siteId, keywordId };
};

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

const dashboard = async () =>
  (await app.inject({ method: 'GET', url: '/', headers: { cookie } })).body;

const runNow = async (fields: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: '/run-now',
    payload: new URLSearchParams(fields).toString(),
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  });

describe('the manual run picker', () => {
  it('offers every site and keyword to choose between', async () => {
    seed();
    const body = await dashboard();

    expect(body).toContain('id="run-once"');
    expect(body).toContain('name="site_id"');
    expect(body).toContain('name="keyword_id"');
    expect(body).toContain('bitespoon.com');
    expect(body).toContain('Honey Soy Chicken Thighs');
  });

  it('lists a paused site, and says that it is paused', async () => {
    // Pausing stops the scheduler from choosing a site. It is not meant to
    // stop a person who names it.
    upsertSite(
      {
        name: 'quiet',
        domain: 'quiet.com',
        status: 'paused',
        pin_username: '',
        project_id: '',
        daily_target: 1,
        interval_minutes: 60,
      },
      KEY,
    );
    expect(await dashboard()).toContain('(paused)');
  });

  it('refuses half a pair rather than falling back to the selector', async () => {
    const { siteId } = seed();
    const response = await runNow({ site_id: String(siteId) });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toContain('Pick%20both');
  });
});

describe('a hand-picked run', () => {
  it('runs the pair even when the site has hit its daily target', { timeout: 30_000 }, async () => {
    const { siteId, keywordId } = seed();

    // Daily target is 1, and it is already met — the selector would refuse.
    markRunPublished(createRun(keywordId, siteId), 'https://bitespoon.com/x', 'Done');

    const settings = configured();
    settings.set('automation_enabled', 'true');

    const result = await tick(settings, KEY, { mode: 'dry', pick: { siteId, keywordId } });

    // It got past selection and into the pipeline, which is the whole point.
    // Where the pipeline then stops depends on configuration this test has
    // none of; what matters is that it was never refused as "no-task".
    expect(result.outcome).not.toBe('no-task');
    expect(result.runId).toBeGreaterThan(0);
  });

  it('runs with automation off', { timeout: 30_000 }, async () => {
    // The switch decides whether the scheduler acts on its own. Someone
    // choosing a site and a keyword by hand has already decided.
    const { siteId, keywordId } = seed();
    const settings = configured();
    settings.set('automation_enabled', 'false');

    const result = await tick(settings, KEY, { pick: { siteId, keywordId } });
    expect(result.outcome).not.toBe('disabled');
    expect(result.runId).toBeGreaterThan(0);
  });

  it('still refuses when automation is off and nothing was picked', async () => {
    seed();
    const settings = configured();
    settings.set('automation_enabled', 'false');

    expect((await tick(settings, KEY)).outcome).toBe('disabled');
  });

  it('records why it ran, since no selector decision explains it', { timeout: 30_000 }, async () => {
    const { siteId, keywordId } = seed();
    const settings = configured();
    settings.set('automation_enabled', 'true');

    await tick(settings, KEY, { mode: 'dry', pick: { siteId, keywordId } });

    const events = (await app.inject({ method: 'GET', url: '/decisions', headers: { cookie } })).body;
    expect(events).toContain('Manual run');
  });
});
