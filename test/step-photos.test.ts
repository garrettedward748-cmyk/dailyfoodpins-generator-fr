import { describe, expect, it } from 'vitest';
import { extraStepNumbers, parseStepPhotoMode, recipeStepCount, recipeStepText } from '../src/core/step-photos.js';
import { attachSiteFields } from '../src/pipeline/steps/article.js';

describe('parseStepPhotoMode', () => {
  it('accepts 3, 5 and all, and falls back to 3', () => {
    expect(parseStepPhotoMode('5')).toBe('5');
    expect(parseStepPhotoMode(' ALL ')).toBe('all');
    expect(parseStepPhotoMode('8')).toBe('3');
    expect(parseStepPhotoMode('')).toBe('3');
    expect(parseStepPhotoMode(undefined)).toBe('3');
  });
});

describe('recipeStepCount', () => {
  it('counts the filled step_N keys', () => {
    expect(recipeStepCount({ step_1: 'a', step_2: 'b', step_3: 'c', step_4: '', step_10: '' })).toBe(3);
  });
  it('counts a steps array', () => {
    expect(recipeStepCount({ steps: ['a', 'b', ''] })).toBe(2);
  });
  it('reads one step text', () => {
    expect(recipeStepText({ step_2: ' Whisk. ' }, 2)).toBe('Whisk.');
    expect(recipeStepText({ steps: [{ body: 'Fold.' }] }, 1)).toBe('Fold.');
  });
});

describe('extraStepNumbers', () => {
  it('adds nothing on 3', () => {
    expect(extraStepNumbers('3', 8, [2, 5, 7])).toEqual([]);
  });

  it('adds every remaining step on all, the last included', () => {
    expect(extraStepNumbers('all', 8, [2, 5, 7])).toEqual([1, 3, 4, 6, 8]);
  });

  it('adds two spread-out steps on 5, avoiding the serving step', () => {
    const extra = extraStepNumbers('5', 8, [2, 5, 7]);
    expect(extra).toHaveLength(2);
    expect(extra).not.toContain(8);
    expect(extra.some((n) => [2, 5, 7].includes(n))).toBe(false);
  });

  it('never asks for more photos than the recipe has steps', () => {
    expect(extraStepNumbers('5', 4, [1, 2, 3])).toEqual([4]);
    expect(extraStepNumbers('5', 3, [1, 2, 3])).toEqual([]);
  });

  it('ignores chosen numbers outside the recipe', () => {
    expect(extraStepNumbers('all', 3, [0, 9, 2])).toEqual([1, 3]);
  });
});

describe('spreading extra method photos', () => {
  const article = {
    title: 'Pudding',
    steps: Array.from({ length: 8 }, (_, i) => ({ heading: `Step ${i + 1}`, body: 'Do it.' })),
  };
  const input = (extraSteps: { step: number; path: string }[]) => ({
    seo: { keyword: 'k', title: 'Pudding', description: 'd', category: 'Desserts', cuisine: '' },
    recipe: { raw: '{}', parsed: {} },
    images: { hero: '/h.webp', stepA: '/a.webp', stepB: '/b.webp', stepC: '/c.webp', stepNumbers: [2, 5, 7], extraSteps },
  });

  it('puts every photo on its own step', () => {
    const filled = attachSiteFields(article, input([
      { step: 1, path: '/1.webp' }, { step: 3, path: '/3.webp' }, { step: 4, path: '/4.webp' },
      { step: 6, path: '/6.webp' }, { step: 8, path: '/8.webp' },
    ]) as never);
    const images = (filled.steps as { image?: string }[]).map((s) => s.image);
    expect(images).toEqual(['/1.webp', '/a.webp', '/3.webp', '/4.webp', '/b.webp', '/6.webp', '/c.webp', '/8.webp']);
  });

  it('moves a clashing extra to the nearest free step', () => {
    const filled = attachSiteFields(article, input([{ step: 5, path: '/x.webp' }]) as never);
    const images = (filled.steps as { image?: string }[]).map((s) => s.image);
    expect(images[3]).toBe('/x.webp');
    expect(images[4]).toBe('/b.webp');
  });

  it('leaves runs without extras as they were', () => {
    const filled = attachSiteFields(article, input([]) as never);
    const images = (filled.steps as { image?: string }[]).map((s) => s.image);
    expect(images.filter(Boolean)).toEqual(['/a.webp', '/b.webp', '/c.webp']);
  });
});
