import { describe, expect, it } from 'vitest';
import { alignRecipeToArticle, extraStepNumbers, parseStepPhotoMode, recipeStepCount, recipeStepText } from '../src/core/step-photos.js';
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

describe('an article that merged two recipe steps into one', () => {
  // The beef gyro: the recipe heats the grill and grills the steak in two
  // steps, the article in one. Placed by number, every photograph after it
  // showed the step before (resting under the grilling photo, slicing under
  // the foil, assembling under the slices).
  const recipe = {
    step_1: 'Whisk the Greek yoghurt, grated cucumber, lemon juice, dill and salt for the tzatziki and chill it.',
    step_2: 'Marinate the flank steak with olive oil, garlic, lemon juice, oregano, salt and pepper.',
    step_3: 'Pre-heat the grill pan to 200C and pat the steak dry with paper towels.',
    step_4: 'Grill the steak 3-4 minutes per side until 60C inside for medium-rare.',
    step_5: 'Rest the steak on a cutting board, loosely covered with foil, for 5 minutes.',
    step_6: 'Slice the rested steak thinly against the grain and warm the pita breads in a dry pan.',
    step_7: 'Assemble the gyros: steak slices, tomato, onion, lettuce and tzatziki on each pita, then roll tight.',
    step_8: '', step_9: '', step_10: '',
  };
  const article = {
    title: 'Beef Steak Gyro',
    steps: [
      { heading: 'Prepare the tzatziki', body: 'Whisk together the Greek yoghurt, grated cucumber, lemon juice, dill and salt. Chill it.' },
      { heading: 'Marinate the steak', body: 'Place the flank steak in a bowl with olive oil, minced garlic, lemon juice, oregano, salt and pepper.' },
      { heading: 'Grill the beef', body: 'Pre-heat your grill pan to 200C. Pat the steak dry with paper towels. Grill for 3-4 minutes per side until 60C for medium-rare.' },
      { heading: 'Rest the meat', body: 'Transfer the steak to a cutting board and cover it loosely with foil. Let it rest for 5 minutes.' },
      { heading: 'Slice and warm', body: 'Slice the rested steak thinly against the grain. Warm your pita breads in a dry pan.' },
      { heading: 'Assemble the gyros', body: 'Lay the steak slices on each pita and add the tomato, onion and lettuce, tzatziki, then roll the pita tight.' },
    ],
  };
  const run = (stepNumbers: number[], extraSteps: { step: number; path: string }[]) =>
    ((attachSiteFields(article, {
      seo: { keyword: 'k', title: 'Gyro', description: 'd', category: 'Lunch', cuisine: '' },
      recipe: { raw: '', parsed: recipe },
      images: { hero: '/h.webp', stepA: '/s2.webp', stepB: '/s4.webp', stepC: '/s6.webp', stepNumbers, extraSteps },
    } as never).steps) as { image?: string }[]).map((s) => s.image);

  it('puts each photograph on the step that tells its moment', () => {
    expect(run([2, 4, 6], [
      { step: 1, path: '/s1.webp' }, { step: 3, path: '/s3.webp' }, { step: 5, path: '/s5.webp' }, { step: 7, path: '/s7.webp' },
    ])).toEqual(['/s1.webp', '/s2.webp', '/s4.webp', '/s5.webp', '/s6.webp', '/s7.webp']);
  });

  it('with only the three, still puts them on the right steps', () => {
    expect(run([2, 5, 6], [])).toEqual([undefined, '/s2.webp', undefined, '/s4.webp', '/s6.webp', undefined]);
  });
});

describe('lining up recipe steps with article steps', () => {
  it('maps one to one when the texts follow each other', () => {
    expect(alignRecipeToArticle(['boil the pasta', 'make the sauce', 'toss and serve'], ['Boil pasta in salted water', 'Make a garlic sauce', 'Toss the pasta and serve'])).toEqual([0, 1, 2]);
  });
  it('sends two merged recipe steps to the same article step', () => {
    expect(alignRecipeToArticle(['chop the onion', 'heat the oven', 'roast the chicken', 'carve and serve'], ['Chop the onion', 'Heat the oven and roast the chicken', 'Carve and serve'])).toEqual([0, 1, 1, 2]);
  });
});
