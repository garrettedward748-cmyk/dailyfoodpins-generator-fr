import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import {
  clearSharedImages,
  getLinkShare,
  getSharedImages,
  insertKeyword,
  loadLinkGrid,
  saveSharedImages,
  setKeywordShareImages,
  setLink,
  setLinkShareImages,
  upsertSite,
  type SharedImageUrls,
} from '../src/db/repos.js';
import {
  ARTICLE_IMAGE_STEPS,
  generateArticleImages,
  type ArticleImageUploads,
} from '../src/pipeline/steps/images.js';
import type { PipelineContext } from '../src/pipeline/context.js';
import type { ImagePromptSet } from '../src/pipeline/steps/content.js';

const KEY = randomBytes(32);

/**
 * Drive the image steps the way the pipeline does: one step per image, then
 * the collector. Straight through the steps' `run`, without the engine, so
 * there is no database and no checkpoint in the way of what is being tested.
 */
async function runImages(ctx: PipelineContext, prompts: ImagePromptSet) {
  const uploads = {} as ArticleImageUploads;
  for (const step of ARTICLE_IMAGE_STEPS) {
    uploads[step.slot] = await step.run(ctx, prompts[step.slot]);
  }
  return generateArticleImages.run(ctx, { uploads, stepNumbers: [] });
}

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

const URLS = {
  hero: 'https://bitespoon.com/uploads/recipes/a.webp',
  stepA: 'https://bitespoon.com/uploads/recipes/b.webp',
  stepB: 'https://bitespoon.com/uploads/recipes/c.webp',
  stepC: 'https://bitespoon.com/uploads/recipes/d.webp',
};

describe('shared article image storage', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('returns nothing before any images are recorded', () => {
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    expect(getSharedImages(keywordId)).toBeUndefined();
  });

  it('round-trips the four urls', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });

    saveSharedImages(keywordId, siteId, URLS);
    expect(getSharedImages(keywordId)).toEqual(URLS);
  });

  it('overwrites rather than duplicating on a second save', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });

    saveSharedImages(keywordId, siteId, URLS);
    saveSharedImages(keywordId, siteId, { ...URLS, hero: 'https://x.com/new.webp' });

    expect(getSharedImages(keywordId)?.hero).toBe('https://x.com/new.webp');
  });

  it('clears a stale row', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });

    saveSharedImages(keywordId, siteId, URLS);
    clearSharedImages(keywordId);

    expect(getSharedImages(keywordId)).toBeUndefined();
  });

  it('never hands one keyword the images of another', async () => {
    // The fear this test exists for: seeing four article images and many more
    // Pinterest ones and concluding the four are being reused across every
    // keyword. They cannot be — the store is keyed by keyword_id — and this
    // asserts it through the step, not just the table.
    const siteId = seedSite('bitespoon.com');
    const chicken = insertKeyword({ seed_keyword: 'chicken thighs', status: 'go' });
    const beef = insertKeyword({ seed_keyword: 'beef stew', status: 'go' });

    saveSharedImages(chicken, siteId, URLS);

    expect(getSharedImages(chicken)).toEqual(URLS);
    expect(getSharedImages(beef)).toBeUndefined();

    // A second keyword with sharing on and a warm cache belonging to the first
    // still generates its own four.
    const { ctx, rec } = fakeContext({ shareImages: true, cached: undefined });
    (ctx as unknown as { keyword: { id: number; seed_keyword: string } }).keyword = {
      id: beef,
      seed_keyword: 'beef stew',
    };

    await runImages(ctx, PROMPTS);

    expect(rec.generated).toHaveLength(4);
    expect(rec.downloaded).toHaveLength(0);
    expect(rec.imagesCounted).toBe(4);
  });

  it('drops the row when the keyword is deleted', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    saveSharedImages(keywordId, siteId, URLS);

    run('DELETE FROM keywords WHERE id = ?', keywordId);

    expect(getSharedImages(keywordId)).toBeUndefined();
  });

  it('survives the source site being deleted, since the urls are public', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    saveSharedImages(keywordId, siteId, URLS);

    run('DELETE FROM sites WHERE id = ?', siteId);

    expect(getSharedImages(keywordId)).toEqual(URLS);
  });
});

describe('the per-link sharing flag', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('defaults a new link to sharing off: each article makes its own images', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });

    setLink(keywordId, siteId, 'go');
    expect(getLinkShare(keywordId, siteId)).toBe(false);
  });

  it('turns sharing off for one link without touching its status', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    setLink(keywordId, siteId, 'go');

    setLinkShareImages(keywordId, siteId, false);

    const row = loadLinkGrid().find((l) => l.siteId === siteId)!;
    expect(row.shareImages).toBe(false);
    expect(row.status).toBe('go');
  });

  it('does not reset sharing when the status changes', () => {
    const siteId = seedSite('bitespoon.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    setLink(keywordId, siteId, 'go');
    setLinkShareImages(keywordId, siteId, false);

    setLink(keywordId, siteId, 'done');

    expect(getLinkShare(keywordId, siteId)).toBe(false);
  });

  it('sets sharing across every site for one keyword', () => {
    const a = seedSite('a.com');
    const b = seedSite('b.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    setLink(keywordId, a, 'go');
    setLink(keywordId, b, 'go');

    setKeywordShareImages(keywordId, false);
    expect(loadLinkGrid().every((l) => l.shareImages === false)).toBe(true);

    setKeywordShareImages(keywordId, true);
    expect(loadLinkGrid().every((l) => l.shareImages === true)).toBe(true);
  });

  it('leaves other keywords alone when setting one keyword', () => {
    const siteId = seedSite('a.com');
    const mine = insertKeyword({ seed_keyword: 'mine' });
    const theirs = insertKeyword({ seed_keyword: 'theirs' });
    setLink(mine, siteId, 'go');
    setLink(theirs, siteId, 'go');

    setKeywordShareImages(mine, true);

    expect(getLinkShare(mine, siteId)).toBe(true);
    expect(getLinkShare(theirs, siteId)).toBe(false);
  });

  it('reports false for a pair that has no link at all', () => {
    const siteId = seedSite('a.com');
    const keywordId = insertKeyword({ seed_keyword: 'chicken' });
    expect(getLinkShare(keywordId, siteId)).toBe(false);
  });
});

/* =========================================================================
 * The step itself.
 *
 * Driven with a hand-built context rather than a real PipelineContext: the
 * step touches six properties, and a fake makes the call counts observable,
 * which is the entire point of the feature.
 * ====================================================================== */

interface Recorder {
  generated: string[];
  downloaded: string[];
  saved: { keywordId: number; siteId: number; urls: SharedImageUrls }[];
  cleared: number[];
  /** Images reported to the run's usage figures — generated ones only. */
  imagesCounted: number;
}

function fakeContext(
  options: {
    shareImages?: boolean;
    cached?: SharedImageUrls;
    downloadFails?: boolean;
    /** One cached url that no longer answers, while the rest still do. */
    deadUrl?: string;
  } = {},
): { ctx: PipelineContext; rec: Recorder } {
  const rec: Recorder = {
    generated: [],
    downloaded: [],
    saved: [],
    cleared: [],
    imagesCounted: 0,
  };
  let counter = 0;
  // The store forgets on clear, as the real one does: the steps after a dead
  // link have to see no cache, and the collector has to see something to save.
  let cache = options.cached;

  const ctx = {
    // The engine reads this back per step for the usage figures. Counted here
    // too, so the fake stays honest about which path calls it: generating an
    // image counts, copying one does not.
    countImages: (n: number) => {
      rec.imagesCounted += n;
    },
    // No pause between generations here; the gap has its own tests.
    imageGapMs: 0,
    lastImageGeneratedAt: null,
    now: () => 0,
    pause: async () => {},
    keyword: { id: 1, seed_keyword: 'chicken' },
    site: { id: 7, domain: 'bitespoon.com' },
    projectId: { projectId: 'proj-1', source: 'site' as const },
    shareImages: options.shareImages ?? false,
    sharedImages: {
      get: () => cache,
      save: (keywordId: number, siteId: number, urls: SharedImageUrls) =>
        rec.saved.push({ keywordId, siteId, urls }),
      clear: (keywordId: number) => {
        cache = undefined;
        rec.cleared.push(keywordId);
      },
    },
    images: {
      generate: async (prompt: string) => {
        rec.generated.push(prompt);
        return { data: Buffer.from('img'), contentType: 'image/webp', jobId: 'job' };
      },
      download: async (url: string) => {
        if (options.downloadFails) throw new Error('HTTP 404');
        if (options.deadUrl === url) throw new Error('HTTP 404');
        rec.downloaded.push(url);
        return { data: Buffer.from('img'), contentType: 'image/webp' };
      },
    },
    siteApi: {
      uploadImage: async () => ({ url: `/uploads/recipes/${++counter}.webp` }),
      absoluteUrl: (p: string) => `https://bitespoon.com${p}`,
    },
  };

  return { ctx: ctx as unknown as PipelineContext, rec };
}

const PROMPTS = {
  hero: 'p-feature',
  stepA: 'p-top',
  stepB: 'p-texture',
  stepC: 'p-before',
} as ImagePromptSet;

const CACHED: SharedImageUrls = {
  hero: 'https://a.com/1.webp',
  stepA: 'https://a.com/2.webp',
  stepB: 'https://a.com/3.webp',
  stepC: 'https://a.com/4.webp',
};

describe('generateArticleImages sharing behaviour', () => {
  it('generates all four when sharing is off', async () => {
    const { ctx, rec } = fakeContext({ shareImages: false });

    await runImages(ctx, PROMPTS);

    expect(rec.generated).toHaveLength(4);
    expect(rec.downloaded).toHaveLength(0);
  });

  it('records nothing when sharing is off, so it does not seed other sites', async () => {
    const { ctx, rec } = fakeContext({ shareImages: false });

    await runImages(ctx, PROMPTS);

    expect(rec.saved).toHaveLength(0);
  });

  it('ignores a warm cache when sharing is off for this link', async () => {
    const { ctx, rec } = fakeContext({ shareImages: false, cached: CACHED });

    await runImages(ctx, PROMPTS);

    expect(rec.generated).toHaveLength(4);
    expect(rec.downloaded).toHaveLength(0);
  });

  it('records the four absolute urls when sharing is on and the cache is empty', async () => {
    const { ctx, rec } = fakeContext({ shareImages: true });

    await runImages(ctx, PROMPTS);

    expect(rec.generated).toHaveLength(4);
    expect(rec.saved).toHaveLength(1);
    expect(rec.saved[0]).toEqual({
      keywordId: 1,
      siteId: 7,
      urls: {
        hero: 'https://bitespoon.com/uploads/recipes/1.webp',
        stepA: 'https://bitespoon.com/uploads/recipes/2.webp',
        stepB: 'https://bitespoon.com/uploads/recipes/3.webp',
        stepC: 'https://bitespoon.com/uploads/recipes/4.webp',
      },
    });
  });

  it('downloads instead of generating when the cache is warm', async () => {
    const { ctx, rec } = fakeContext({ shareImages: true, cached: CACHED });

    const result = await runImages(ctx, PROMPTS);

    expect(rec.generated).toHaveLength(0);
    expect(rec.downloaded).toEqual(Object.values(CACHED));
    expect(rec.saved).toHaveLength(0);
    expect(result.hero).toBe('/uploads/recipes/1.webp');
  });

  it('returns this site own paths, never the source site urls', async () => {
    const { ctx } = fakeContext({ shareImages: true, cached: CACHED });

    const result = await runImages(ctx, PROMPTS);

    for (const path of [result.hero, result.stepA, result.stepB, result.stepC]) {
      expect(path.startsWith('/uploads/recipes/')).toBe(true);
    }
  });

  it('falls back to generating when a cached url cannot be downloaded', async () => {
    const { ctx, rec } = fakeContext({
      shareImages: true,
      cached: CACHED,
      downloadFails: true,
    });

    const result = await runImages(ctx, PROMPTS);

    expect(rec.cleared).toEqual([1]);
    expect(rec.generated).toHaveLength(4);
    expect(result.hero).toBe('/uploads/recipes/1.webp');
  });

  it('re-records after a fallback, so the next site gets a working cache', async () => {
    const { ctx, rec } = fakeContext({
      shareImages: true,
      cached: CACHED,
      downloadFails: true,
    });

    await runImages(ctx, PROMPTS);

    expect(rec.saved).toHaveLength(1);
    expect(rec.saved[0]!.urls.hero).toBe('https://bitespoon.com/uploads/recipes/1.webp');
  });

  it('regenerates only the image whose cached url is dead, and keeps the copies', async () => {
    const { ctx, rec } = fakeContext({
      shareImages: true,
      cached: CACHED,
      deadUrl: CACHED.stepB,
    });

    await runImages(ctx, PROMPTS);

    // The first two copied before the dead link was found; the third is
    // generated; and with the row gone, the fourth is generated too.
    expect(rec.downloaded).toEqual([CACHED.hero, CACHED.stepA]);
    expect(rec.generated).toEqual([PROMPTS.stepB, PROMPTS.stepC]);
    expect(rec.cleared).toEqual([1]);
    // What this site now holds -- copied and generated alike -- is the set
    // the next site copies.
    expect(rec.saved).toHaveLength(1);
  });
});
