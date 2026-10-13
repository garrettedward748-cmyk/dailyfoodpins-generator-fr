import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, get as dbGet, openDatabase, run as dbRun } from '../src/db/index.js';
import {
  activateSite,
  consumeRetry,
  createRun,
  dueRetry,
  getRun,
  getSite,
  insertKeyword,
  listHeldRuns,
  listPromptVersions,
  listModelOverrides,
  markRunHeld,
  markRunPublished,
  noticeChanged,
  pauseSite,
  publishedTitles,
  resumeExpiredPauses,
  runUsage,
  savePromptVersion,
  scheduleRetry,
  setLink,
  setModelOverride,
  upsertSite,
  PROMPT_VERSION_LIMIT,
} from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

const seedSite = (domain: string, over: Record<string, unknown> = {}): number =>
  upsertSite(
    {
      name: domain.split('.')[0]!,
      domain,
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 3,
      interval_minutes: 60,
      ...over,
    },
    KEY,
  );

describe('the new workflow features', () => {
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

  const post = (url: string, fields: Record<string, string | string[]> = {}) => {
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

  /* -- pausing a site ---------------------------------------------------- */

  describe('pausing a site', () => {
    it('records the reason and the end', async () => {
      const id = seedSite('bitespoon.com');
      await post(`/sites/${id}/pause`, { reason: 'their API is down', hours: '24' });

      const site = getSite(id)!;
      expect(site.status).toBe('paused');
      expect(site.paused_reason).toBe('their API is down');
      expect(site.paused_until).not.toBeNull();
    });

    it('shows the reason on the site page rather than a bare "paused"', async () => {
      const id = seedSite('bitespoon.com');
      await post(`/sites/${id}/pause`, { reason: 'their API is down', hours: '24' });

      const response = await get(`/sites/${id}`);
      expect(response.body).toContain('their API is down');
    });

    it('allows a pause with no end', async () => {
      const id = seedSite('bitespoon.com');
      await post(`/sites/${id}/pause`, { reason: 'rebuilding the site', hours: '0' });

      expect(getSite(id)?.paused_until).toBeNull();
    });

    it('brings a site back when its pause has run out', () => {
      const id = seedSite('bitespoon.com');
      pauseSite(id, 'brief outage', new Date(Date.now() - 60_000).toISOString());

      expect(resumeExpiredPauses()).toEqual(['bitespoon.com']);

      const site = getSite(id)!;
      expect(site.status).toBe('active');
      expect(site.paused_reason).toBe('');
      expect(site.paused_until).toBeNull();
    });

    it('leaves a pause that has not run out alone', () => {
      const id = seedSite('bitespoon.com');
      pauseSite(id, 'still broken', new Date(Date.now() + 3_600_000).toISOString());

      expect(resumeExpiredPauses()).toEqual([]);
      expect(getSite(id)?.status).toBe('paused');
    });

    it('never resumes a pause that has no end', () => {
      const id = seedSite('bitespoon.com');
      pauseSite(id, 'indefinite', null);

      expect(resumeExpiredPauses()).toEqual([]);
      expect(getSite(id)?.status).toBe('paused');
    });

    it('does not clear the pause when the settings form is saved', () => {
      // The form no longer carries paused_reason or auto_publish — they are
      // their own controls now — so saving it must leave them alone. Reading
      // an absent field as an empty one would un-pause a site every time
      // somebody changed its daily target.
      const id = seedSite('bitespoon.com', { auto_publish: false });
      pauseSite(id, 'their API is down', null);

      upsertSite(
        {
          name: 'bitespoon',
          domain: 'bitespoon.com',
          status: 'paused',
          pin_username: '',
          project_id: '',
          daily_target: 9,
          interval_minutes: 60,
        },
        KEY,
      );

      const site = getSite(id)!;
      expect(site.daily_target).toBe(9);
      expect(site.paused_reason).toBe('their API is down');
      expect(site.auto_publish).toBe(0);
    });

    it('switches publishing mode from its own control', async () => {
      const id = seedSite('bitespoon.com');
      await post(`/sites/${id}/publishing`, { auto_publish: '0' });
      expect(getSite(id)?.auto_publish).toBe(0);

      await post(`/sites/${id}/publishing`, { auto_publish: '1' });
      expect(getSite(id)?.auto_publish).toBe(1);
    });

    it('clears the reason when the site is made active again', () => {
      const id = seedSite('bitespoon.com');
      pauseSite(id, 'a reason', null);
      activateSite(id);

      expect(getSite(id)?.paused_reason).toBe('');
    });
  });

  /* -- holding an article for approval ----------------------------------- */

  describe('articles held before publishing', () => {
    let siteId: number;
    let runId: number;

    beforeEach(() => {
      siteId = seedSite('bitespoon.com', { auto_publish: false });
      const keywordId = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      setLink(keywordId, siteId, 'go');
      runId = createRun(keywordId, siteId);
      markRunHeld(runId, 'awaiting', 'Baked Chicken Breast');
    });

    it('is cancelled rather than failed, so it counts as neither', () => {
      const run = getRun(runId)!;
      expect(run.status).toBe('cancelled');
      expect(run.hold).toBe('awaiting');

      const failedToday =
        dbGet<{ n: number }>(
          "SELECT COUNT(*) AS n FROM runs WHERE status = 'failed' AND date(started_at) = date('now')",
        )?.n ?? 0;
      expect(failedToday).toBe(0);
    });

    it('appears on Home as something that needs a person', async () => {
      const response = await get('/');
      expect(response.body).toContain('Needs you');
      expect(response.body).toContain('Baked Chicken Breast');
    });

    it('is labelled as awaiting approval, never as cancelled', async () => {
      const response = await get(`/runs/${runId}`);
      expect(response.body).toContain('awaiting approval');
      expect(response.body).not.toContain('>cancelled<');
    });

    it('is listed by listHeldRuns', () => {
      expect(listHeldRuns().map((r) => r.id)).toEqual([runId]);
    });

    it('goes back to go when discarded, so it can be written again', async () => {
      const before = getRun(runId)!;
      await post(`/runs/${runId}/discard`);

      const link = dbGet<{ status: string }>(
        'SELECT status FROM keyword_sites WHERE keyword_id = ? AND site_id = ?',
        before.keyword_id!,
        siteId,
      );
      expect(link?.status).toBe('go');
      expect(getRun(runId)?.hold).toBe('');
    });

    it('refuses to discard a run that is not held', async () => {
      const other = createRun(getRun(runId)!.keyword_id!, siteId);
      const response = await post(`/runs/${other}/discard`);
      expect(response.headers.location).toContain('error=');
    });
  });

  /* -- editing the article before approving ------------------------------ */

  describe('editing a held article', () => {
    let runId: number;

    beforeEach(() => {
      const siteId = seedSite('bitespoon.com', { auto_publish: false });
      const keywordId = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      runId = createRun(keywordId, siteId);

      dbRun(
        `INSERT INTO run_steps (run_id, step, status, output_json)
         VALUES (?, 'generate-article', 'ok', ?)`,
        runId,
        JSON.stringify({ title: 'First Title', body: 'text' }),
      );
      markRunHeld(runId, 'awaiting', 'First Title');
    });

    it('replaces the checkpoint a resume would replay', async () => {
      await post(`/runs/${runId}/article`, {
        article: JSON.stringify({ title: 'Better Title', body: 'edited' }),
      });

      const stored = dbGet<{ output_json: string }>(
        "SELECT output_json FROM run_steps WHERE run_id = ? AND step = 'generate-article'",
        runId,
      );
      expect(JSON.parse(stored!.output_json)).toEqual({ title: 'Better Title', body: 'edited' });
      expect(getRun(runId)?.title).toBe('Better Title');
    });

    it('refuses malformed JSON instead of storing it', async () => {
      const response = await post(`/runs/${runId}/article`, { article: '{ not json' });

      expect(response.headers.location).toContain('error=');
      const stored = dbGet<{ output_json: string }>(
        "SELECT output_json FROM run_steps WHERE run_id = ? AND step = 'generate-article'",
        runId,
      );
      expect(JSON.parse(stored!.output_json).title).toBe('First Title');
    });

    it('refuses an array, which would post as nothing useful', async () => {
      const response = await post(`/runs/${runId}/article`, { article: '[1, 2, 3]' });
      expect(response.headers.location).toContain('error=');
    });

    it('renders the article as prose rather than a JSON blob', async () => {
      const response = await get(`/runs/${runId}`);

      // Field sections, not a <pre> of JSON. The title lives in the fold's
      // summary so it reads as something shut, rather than as a row saying
      // "Read the article" over content you cannot see.
      expect(response.body).toContain('article-block');
      expect(response.body).toContain('First Title');
    });

    it('opens the article on a held run, where reading it is the task', async () => {
      const response = await get(`/runs/${runId}`);
      expect(response.body).toMatch(/<details class="card article" open>/);
    });
  });

  /* -- automatic retries -------------------------------------------------- */

  describe('automatic retries', () => {
    it('picks up a run whose retry is due', () => {
      const siteId = seedSite('bitespoon.com');
      const keywordId = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      const runId = createRun(keywordId, siteId);
      dbRun("UPDATE runs SET status = 'failed' WHERE id = ?", runId);
      scheduleRetry(runId, new Date(Date.now() - 60_000).toISOString());

      expect(dueRetry()?.id).toBe(runId);
    });

    it('leaves a retry that is not due yet', () => {
      const siteId = seedSite('bitespoon.com');
      const keywordId = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      const runId = createRun(keywordId, siteId);
      dbRun("UPDATE runs SET status = 'failed' WHERE id = ?", runId);
      scheduleRetry(runId, new Date(Date.now() + 3_600_000).toISOString());

      expect(dueRetry()).toBeUndefined();
    });

    it('cannot pick the same run twice', () => {
      const siteId = seedSite('bitespoon.com');
      const keywordId = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      const runId = createRun(keywordId, siteId);
      dbRun("UPDATE runs SET status = 'failed' WHERE id = ?", runId);
      scheduleRetry(runId, new Date(Date.now() - 60_000).toISOString());

      consumeRetry(runId);

      expect(dueRetry()).toBeUndefined();
      expect(getRun(runId)?.attempts).toBe(1);
    });

    it('never offers a run that succeeded', () => {
      const siteId = seedSite('bitespoon.com');
      const keywordId = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      const runId = createRun(keywordId, siteId);
      scheduleRetry(runId, new Date(Date.now() - 60_000).toISOString());
      markRunPublished(runId, 'p1', 'https://bitespoon.com/a', 'Title');

      expect(dueRetry()).toBeUndefined();
    });
  });

  /* -- the duplicate guard ------------------------------------------------ */

  describe('published titles', () => {
    it('records the title so the next run can be checked against it', () => {
      const siteId = seedSite('bitespoon.com');
      const keywordId = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      const runId = createRun(keywordId, siteId);
      markRunPublished(runId, 'p1', 'https://bitespoon.com/a', 'Baked Chicken Breast');

      expect(publishedTitles(siteId)).toEqual([
        { title: 'Baked Chicken Breast', url: 'https://bitespoon.com/a' },
      ]);
    });

    it('keeps each site separate', () => {
      const a = seedSite('bitespoon.com');
      const b = seedSite('longlivo.com');
      const keywordId = insertKeyword({ seed_keyword: 'beef stew', status: 'go' });
      markRunPublished(createRun(keywordId, a), 'p1', 'https://bitespoon.com/a', 'Beef Stew');

      expect(publishedTitles(b)).toEqual([]);
    });
  });

  /* -- usage -------------------------------------------------------------- */

  describe('usage accounting', () => {
    it('adds up tokens and images across a run', () => {
      const siteId = seedSite('bitespoon.com');
      const keywordId = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      const runId = createRun(keywordId, siteId);

      dbRun(
        `INSERT INTO run_steps (run_id, step, status, tokens_in, tokens_out, images, duration_ms, model)
         VALUES (?, 'generate-article', 'ok', 1200, 3400, 0, 5000, 'gemma4:31b')`,
        runId,
      );
      dbRun(
        `INSERT INTO run_steps (run_id, step, status, tokens_in, tokens_out, images, duration_ms)
         VALUES (?, 'generate-article-images', 'ok', 0, 0, 4, 60000)`,
        runId,
      );

      const usage = runUsage(runId);
      expect(usage.tokensIn).toBe(1200);
      expect(usage.tokensOut).toBe(3400);
      expect(usage.images).toBe(4);
      expect(usage.llmCalls).toBe(1);
      expect(usage.durationMs).toBe(65_000);
    });

  });

  /* -- models per prompt --------------------------------------------------- */

  describe('choosing a model per prompt', () => {
    it('stores an override and applies it', async () => {
      await post('/settings/prompts/model', { prompt: 'part-1', model: 'llama3:70b' });
      expect(listModelOverrides().get('part-1')).toBe('llama3:70b');
    });

    it('treats a blank model as "back to the shipped default"', async () => {
      setModelOverride('part-1', 'llama3:70b');
      await post('/settings/prompts/model', { prompt: 'part-1', model: '' });

      expect(listModelOverrides().has('part-1')).toBe(false);
    });

    it('refuses a prompt that does not exist', async () => {
      const response = await post('/settings/prompts/model', {
        prompt: 'not-a-prompt',
        model: 'x',
      });
      expect(response.headers.location).toContain('error=');
    });
  });

  /* -- prompt versions ----------------------------------------------------- */

  describe('prompt history', () => {
    it('keeps each save', () => {
      savePromptVersion('part-1.user.txt', 'first');
      savePromptVersion('part-1.user.txt', 'second');

      expect(listPromptVersions('part-1.user.txt').map((v) => v.body)).toEqual([
        'second',
        'first',
      ]);
    });

    it('does not record a save that changed nothing', () => {
      savePromptVersion('part-1.user.txt', 'same');
      savePromptVersion('part-1.user.txt', 'same');

      expect(listPromptVersions('part-1.user.txt')).toHaveLength(1);
    });

    it('keeps only the most recent versions', () => {
      for (let i = 0; i < PROMPT_VERSION_LIMIT + 5; i++) {
        savePromptVersion('part-1.user.txt', `version ${i}`);
      }

      const versions = listPromptVersions('part-1.user.txt');
      expect(versions).toHaveLength(PROMPT_VERSION_LIMIT);
      expect(versions[0]?.body).toBe(`version ${PROMPT_VERSION_LIMIT + 4}`);
    });

    it('keeps prompts separate from each other', () => {
      savePromptVersion('part-1.user.txt', 'a');
      savePromptVersion('part-2.user.txt', 'b');

      expect(listPromptVersions('part-1.user.txt')).toHaveLength(1);
    });
  });

  /* -- notice de-duplication ----------------------------------------------- */

  describe('notification de-duplication', () => {
    it('reports a change once and then stays quiet', () => {
      expect(noticeChanged('image-service', 'down')).toBe(true);
      expect(noticeChanged('image-service', 'down')).toBe(false);
      expect(noticeChanged('image-service', 'down')).toBe(false);
    });

    it('reports the recovery too', () => {
      noticeChanged('image-service', 'down');
      expect(noticeChanged('image-service', 'ok')).toBe(true);
    });

    it('keeps subjects apart, so two sites are two notices', () => {
      expect(noticeChanged('site-failing:a.com', 'failing')).toBe(true);
      expect(noticeChanged('site-failing:b.com', 'failing')).toBe(true);
    });
  });

  /* -- keyword diagnosis page ---------------------------------------------- */

  describe('the keyword page', () => {
    it('explains why a keyword is going nowhere', async () => {
      const keywordId = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      seedSite('bitespoon.com');

      const response = await get(`/keywords/${keywordId}`);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('not set to go on any site');
    });

    it('404s to the list for a keyword that is not there', async () => {
      const response = await get('/keywords/9999');
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain('/keywords');
    });

    it('refuses a dry run for a keyword linked to nothing', async () => {
      const keywordId = insertKeyword({ seed_keyword: 'chicken soup', status: 'go' });
      const response = await post(`/keywords/${keywordId}/dry-run`);

      expect(response.headers.location).toContain('warn=');
      expect(response.headers.location).toContain('go');
    });
  });
});
