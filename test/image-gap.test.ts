import { describe, expect, it } from 'vitest';
import {
  ARTICLE_IMAGE_STEPS,
  generateArticleImages,
  generatePinImage,
  type ArticleImageUploads,
} from '../src/pipeline/steps/images.js';
import type { PipelineContext } from '../src/pipeline/context.js';
import type { ImagePromptSet } from '../src/pipeline/steps/content.js';

/**
 * The pause between one image generation and the next.
 *
 * Four generations fired back to back at one shared Chrome is the burst that
 * produced runs failing at the third or fourth image: the image service reloads
 * the Flow tab before every job, and the next request was being injected into
 * a page that had not finished coming back. The gap is a setting, because the
 * right number depends on how starved that container is.
 */


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

const PROMPTS = {
  hero: 'p-feature',
  stepA: 'p-top',
  stepB: 'p-texture',
  stepC: 'p-before',
} as ImagePromptSet;

function fakeContext(gapMs: number) {
  const events: string[] = [];
  let now = 0;
  const ctx = {
    imageGapMs: gapMs,
    lastImageGeneratedAt: null as number | null,
    now: () => now,
    pause: async (ms: number) => {
      events.push(`pause ${ms}`);
      now += ms;
    },
    countImages: () => {},
    keyword: { id: 1, seed_keyword: 'chicken' },
    site: { id: 7, domain: 'bitespoon.com' },
    projectId: { projectId: 'proj-1', source: 'site' as const },
    shareImages: false,
    sharedImages: { get: () => undefined, save: () => {}, clear: () => {} },
    images: {
      generate: async (prompt: string) => {
        events.push(`generate ${prompt}`);
        // Generation itself takes time; the pause is measured from its end.
        now += 1000;
        return { data: Buffer.from('img'), contentType: 'image/webp', jobId: 'job' };
      },
      download: async () => ({ data: Buffer.from('img'), contentType: 'image/webp' }),
    },
    siteApi: {
      uploadImage: async () => ({ url: '/uploads/recipes/x.webp' }),
      absoluteUrl: (p: string) => `https://bitespoon.com${p}`,
    },
    settings: { get: () => '' },
  };
  return { ctx: ctx as unknown as PipelineContext, events, clock: () => now };
}

describe('the pause between image generations', () => {
  it('waits the configured gap before every generation after the first', async () => {
    const { ctx, events } = fakeContext(30_000);

    await runImages(ctx, PROMPTS);

    expect(events).toEqual([
      'generate p-feature',
      'pause 30000',
      'generate p-top',
      'pause 30000',
      'generate p-texture',
      'pause 30000',
      'generate p-before',
    ]);
  });

  it('does not wait at all when the gap is zero', async () => {
    const { ctx, events } = fakeContext(0);

    await runImages(ctx, PROMPTS);

    expect(events.filter((e) => e.startsWith('pause'))).toEqual([]);
  });

  it('only waits out the part of the gap that has not already passed', async () => {
    const { ctx, events } = fakeContext(30_000);
    // The first image was generated a while ago -- the article was being
    // written in between -- so the pin image owes only the remainder.
    await runImages(ctx, PROMPTS);
    events.length = 0;
    (ctx as unknown as { now: () => number }).now = () => ctx.lastImageGeneratedAt! + 25_000;

    await generatePinImage.run(ctx, { seo: { title: 't' } as never, prompts: PROMPTS });

    expect(events).toEqual(['pause 5000', expect.stringMatching(/^generate /)]);
  });
});
