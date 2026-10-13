import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import {
  createRun,
  insertKeyword,
  listSites,
  loadKeywordViews,
  loadLinkViews,
  loadSiteViews,
  markRunFailed,
  markRunPublished,
  recordDecisions,
  listDecisions,
  setLink,
  upsertSite,
  getLinksForKeyword,
  beginStep,
  finishStep,
  getCompletedStep,
  keywordImageCounts,
} from '../src/db/repos.js';
import { localDateKey, selectTask } from '../src/core/selector.js';
import { randomBytes } from 'node:crypto';

const TZ = 'Africa/Algiers';
const KEY = randomBytes(32);

function seedSite(domain: string, over: Partial<Parameters<typeof upsertSite>[0]> = {}): number {
  return upsertSite(
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
}

describe('database integration', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('creates the schema and starts empty', () => {
    expect(listSites()).toHaveLength(0);
    expect(loadKeywordViews()).toHaveLength(0);
  });

  // -- The central claim of the redesign ------------------------------------
  describe('derived counters', () => {
    it('computes publishedToday from run history rather than a stored column', () => {
      const siteId = seedSite('bitespoon.com');
      const keywordId = insertKeyword({ seed_keyword: 'chicken' });

      const dayKey = localDateKey(new Date(), TZ);
      expect(loadSiteViews(dayKey, TZ)[0]?.publishedToday).toBe(0);

      const runId = createRun(keywordId, siteId);
      markRunPublished(runId, 'post-1', 'https://bitespoon.com/r/1');

      expect(loadSiteViews(dayKey, TZ)[0]?.publishedToday).toBe(1);
    });

    it('counts only published runs, never failed ones', () => {
      const siteId = seedSite('bitespoon.com');
      const keywordId = insertKeyword({ seed_keyword: 'chicken' });

      markRunFailed(createRun(keywordId, siteId), 'boom', 'post-article');
      markRunPublished(createRun(keywordId, siteId), 'p1', 'https://x/1');
      markRunFailed(createRun(keywordId, siteId), 'boom again', 'generate-images');

      const view = loadSiteViews(localDateKey(new Date(), TZ), TZ)[0];
      expect(view?.publishedToday).toBe(1);
    });

    it('returns a numeric counter, so arithmetic cannot concatenate', () => {
      const siteId = seedSite('bitespoon.com');
      const keywordId = insertKeyword({ seed_keyword: 'k' });
      for (let i = 0; i < 3; i++) {
        markRunPublished(createRun(keywordId, siteId), `p${i}`, `https://x/${i}`);
      }

      const count = loadSiteViews(localDateKey(new Date(), TZ), TZ)[0]!.publishedToday;
      expect(typeof count).toBe('number');
      expect(count + 1).toBe(4); // the old system produced "31"
    });

    it('rolls over without a reset job: yesterday does not count toward today', () => {
      const siteId = seedSite('bitespoon.com');
      const keywordId = insertKeyword({ seed_keyword: 'k' });
      const runId = createRun(keywordId, siteId);
      markRunPublished(runId, 'p', 'https://x');

      // Backdate the publication by two days.
      run("UPDATE runs SET published_at = datetime('now', '-2 days') WHERE id = ?", runId);

      const view = loadSiteViews(localDateKey(new Date(), TZ), TZ)[0];
      expect(view?.publishedToday).toBe(0);
      expect(view?.lastPublishAt).not.toBeNull();
    });
  });

  // -- The constraint that makes the old corruption impossible --------------
  describe('keyword x site matrix', () => {
    it('cannot hold two contradictory statuses for one pair', () => {
      const siteId = seedSite('bitespoon.com');
      const keywordId = insertKeyword({ seed_keyword: 'chicken' });

      setLink(keywordId, siteId, 'go');
      setLink(keywordId, siteId, 'done'); // upsert, not a second row

      const links = getLinksForKeyword(keywordId);
      expect(links).toHaveLength(1);
      expect(links[0]?.status).toBe('done');
    });

    it('adding a site does not change any schema', () => {
      const keywordId = insertKeyword({ seed_keyword: 'chicken' });
      for (const domain of ['a.com', 'b.com', 'c.com', 'd.com', 'e.com']) {
        setLink(keywordId, seedSite(domain), 'go');
      }
      expect(getLinksForKeyword(keywordId)).toHaveLength(5);
    });

    it('removes links when a site is deleted', () => {
      const siteId = seedSite('gone.com');
      const keywordId = insertKeyword({ seed_keyword: 'k' });
      setLink(keywordId, siteId, 'go');

      run('DELETE FROM sites WHERE id = ?', siteId);
      expect(getLinksForKeyword(keywordId)).toHaveLength(0);
    });
  });

  // -- End to end through the selector -------------------------------------
  describe('selector against real data', () => {
    it('selects a valid pair', () => {
      const siteId = seedSite('bitespoon.com');
      const keywordId = insertKeyword({ seed_keyword: 'chicken', status: 'go' });
      setLink(keywordId, siteId, 'go');

      const now = new Date();
      const { task } = selectTask(
        loadSiteViews(localDateKey(now, TZ), TZ),
        loadKeywordViews(),
        loadLinkViews(),
        { now, timezone: TZ },
      );

      expect(task?.siteDomain).toBe('bitespoon.com');
      expect(task?.seedKeyword).toBe('chicken');
    });

    it('stops offering a site once it reaches its daily target', () => {
      const siteId = seedSite('bitespoon.com', { daily_target: 1, interval_minutes: 0 });
      const keywordId = insertKeyword({ seed_keyword: 'chicken' });
      const second = insertKeyword({ seed_keyword: 'beef' });
      setLink(keywordId, siteId, 'go');
      setLink(second, siteId, 'go');

      const select = () => {
        const now = new Date();
        return selectTask(
          loadSiteViews(localDateKey(now, TZ), TZ),
          loadKeywordViews(),
          loadLinkViews(),
          { now, timezone: TZ },
        );
      };

      expect(select().task).not.toBeNull();
      markRunPublished(createRun(keywordId, siteId), 'p1', 'https://x/1');
      expect(select().task).toBeNull();
    });

    it('REGRESSION: repeated selection terminates instead of looping', () => {
      // Emulates the scheduler running many ticks against a world where one
      // keyword can never be satisfied. The old orchestrator span forever here.
      const siteId = seedSite('bitespoon.com', { daily_target: 100, interval_minutes: 0 });
      const stuck = insertKeyword({ seed_keyword: 'stuck', status: 'go' });
      setLink(stuck, siteId, 'done'); // linked, but already used

      for (let tickNumber = 0; tickNumber < 50; tickNumber++) {
        const now = new Date();
        const { task } = selectTask(
          loadSiteViews(localDateKey(now, TZ), TZ),
          loadKeywordViews(),
          loadLinkViews(),
          { now, timezone: TZ },
        );
        expect(task).toBeNull();
      }
    });
  });

  describe('decision log', () => {
    it('persists every decision with its reason', () => {
      seedSite('a.com', { status: 'paused' });
      seedSite('b.com', { daily_target: 0 });

      const now = new Date();
      const { decisions } = selectTask(
        loadSiteViews(localDateKey(now, TZ), TZ),
        loadKeywordViews(),
        loadLinkViews(),
        { now, timezone: TZ },
      );
      recordDecisions('cycle-1', decisions);

      const stored = listDecisions('cycle-1');
      expect(stored.length).toBe(decisions.length);
      expect(stored.some((d) => d.reason.includes('not active'))).toBe(true);
      expect(stored.some((d) => d.reason.includes('Daily target is 0'))).toBe(true);
    });
  });

  // -- Checkpointing --------------------------------------------------------
  describe('what a keyword cost at the image service', () => {
    const finishOk = (runId: number, step: string, images: number) => {
      beginStep(runId, step);
      finishStep(runId, step, { status: 'ok', output: {}, images });
    };

    it('reads a generating run from the per-image steps, and a copying run from their absence', () => {
      const a = seedSite('a.com');
      const b = seedSite('b.com');
      const keywordId = insertKeyword({ seed_keyword: 'k' });

      // The site that generated: four image steps, one image each, then the
      // collector, which reaches Google for nothing.
      const generating = createRun(keywordId, a);
      for (const slot of ['hero', 'top-shot', 'texture-macro', 'before-after']) {
        finishOk(generating, `generate-image-${slot}`, 1);
      }
      finishOk(generating, 'generate-images', 0);

      // The site that copied: the same steps, none of which generated.
      const copying = createRun(keywordId, b);
      for (const slot of ['hero', 'top-shot', 'texture-macro', 'before-after']) {
        finishOk(copying, `generate-image-${slot}`, 0);
      }
      finishOk(copying, 'generate-images', 0);

      const counts = keywordImageCounts(keywordId);
      expect(counts.generatedRuns).toBe(1);
      expect(counts.copiedRuns).toBe(1);
    });

    it('still reads a run from before the split, where the count sat on generate-images', () => {
      const a = seedSite('a.com');
      const keywordId = insertKeyword({ seed_keyword: 'k' });
      const old = createRun(keywordId, a);
      finishOk(old, 'generate-images', 4);

      expect(keywordImageCounts(keywordId).generatedRuns).toBe(1);
      expect(keywordImageCounts(keywordId).copiedRuns).toBe(0);
    });
  });

  describe('run step checkpoints', () => {
    it('stores output so a completed step can be skipped on resume', () => {
      const siteId = seedSite('a.com');
      const keywordId = insertKeyword({ seed_keyword: 'k' });
      const runId = createRun(keywordId, siteId);

      beginStep(runId, 'generate-recipe');
      finishStep(runId, 'generate-recipe', {
        status: 'ok',
        output: { title: 'Chicken' },
        durationMs: 1234,
        endpoint: 'ollama-01',
      });

      const checkpoint = getCompletedStep(runId, 'generate-recipe');
      expect(checkpoint?.status).toBe('ok');
      expect(checkpoint?.endpoint).toBe('ollama-01');
      expect(JSON.parse(checkpoint!.output_json!)).toEqual({ title: 'Chicken' });
    });

    it('does not treat a failed step as a checkpoint', () => {
      const siteId = seedSite('a.com');
      const keywordId = insertKeyword({ seed_keyword: 'k' });
      const runId = createRun(keywordId, siteId);

      beginStep(runId, 'post-article');
      finishStep(runId, 'post-article', { status: 'failed', error: 'HTTP 500' });

      expect(getCompletedStep(runId, 'post-article')).toBeUndefined();
    });

    it('increments the attempt counter when a step re-runs', () => {
      const siteId = seedSite('a.com');
      const keywordId = insertKeyword({ seed_keyword: 'k' });
      const runId = createRun(keywordId, siteId);

      beginStep(runId, 'post-article');
      finishStep(runId, 'post-article', { status: 'failed', error: 'first' });
      beginStep(runId, 'post-article');
      finishStep(runId, 'post-article', { status: 'ok', output: { id: 'x' } });

      const step = getCompletedStep(runId, 'post-article');
      expect(step?.attempt).toBe(2);
      expect(step?.status).toBe('ok');
    });
  });
});
