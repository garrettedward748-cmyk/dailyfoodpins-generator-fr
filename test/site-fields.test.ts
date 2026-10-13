import { describe, expect, it } from 'vitest';
import { attachSiteFields } from '../src/pipeline/steps/article.js';
import { matchTaxonomy } from '../src/pipeline/steps/content.js';

/**
 * The fields the site needs that the model is never asked for.
 *
 * Taxonomy and image paths are facts already established by earlier steps.
 * They used to be interpolated into three prompts and copied back out, which
 * gave three chances to publish a recipe with a broken photograph or a
 * cuisine the site refuses.
 */

const seo = {
  keyword: 'msemen',
  title: 'Msemen',
  description: 'd',
  category: 'Breakfast',
  cuisine: 'North African',
};

const images = {
  hero: '/image/recipes/hero.webp',
  stepA: '/image/recipes/top.webp',
  stepB: '/image/recipes/macro.webp',
  stepC: '/image/recipes/plated.webp',
  stepNumbers: [] as number[],
};

const recipe = { raw: '{}', parsed: {} };

const input = { seo, recipe, images };

function steps(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ heading: `h${i}`, body: `b${i}` }));
}

describe('attaching the site fields to a finished article', () => {
  it('takes the hero photograph and the taxonomy from the run, not the model', () => {
    const article = attachSiteFields(
      { title: 'Msemen', category: 'Dessert', cuisine: 'Algerian', image: '/wrong.webp' },
      input,
    );

    expect(article.image).toBe('/image/recipes/hero.webp');
    expect(article.category).toBe('Breakfast');
    expect(article.cuisine).toBe('North African');
    expect(article.status).toBe('published');
  });

  it('falls back to the title for the alt text, and keeps a real one', () => {
    expect(attachSiteFields({ title: 'Msemen' }, input).image_alt).toBe('Msemen');

    expect(
      attachSiteFields({ title: 'Msemen', image_alt: 'Square flatbread, torn open' }, input)
        .image_alt,
    ).toBe('Square flatbread, torn open');
  });

  it('omits the cuisine entirely when none matched, rather than sending one the site refuses', () => {
    const article = attachSiteFields(
      { title: 'Msemen', cuisine: 'Algerian' },
      { ...input, seo: { ...seo, cuisine: '' } },
    );

    expect('cuisine' in article).toBe(false);
  });

  it('puts each method photograph on the step it was drawn for', () => {
    const chosen = { ...input, images: { ...images, stepNumbers: [3, 4, 6] } };
    const article = attachSiteFields({ title: 't', steps: steps(7) }, chosen);
    const withImages = (article.steps as Record<string, unknown>[]).map((s) => s.image);

    expect(withImages).toEqual([
      undefined,
      undefined,
      '/image/recipes/top.webp',
      '/image/recipes/macro.webp',
      undefined,
      '/image/recipes/plated.webp',
      undefined,
    ]);
  });

  it('never lands a photograph on the serving step when the model chose well', () => {
    const chosen = { ...input, images: { ...images, stepNumbers: [2, 3, 5] } };
    const article = attachSiteFields({ title: 't', steps: steps(7) }, chosen);
    const withImages = (article.steps as Record<string, unknown>[]).map((s) => s.image);

    // The last step is "serve hot" — its photograph would be the hero again.
    expect(withImages[6]).toBeUndefined();
  });

  it('falls back to an even spread when the chosen steps cannot be used', () => {
    // Out of range, repeated, and too few: each is a model answer that would
    // otherwise drop a photograph, and a misplaced photograph beats none.
    for (const stepNumbers of [[3, 4, 99], [4, 4, 5], [3]]) {
      const article = attachSiteFields(
        { title: 't', steps: steps(7) },
        { ...input, images: { ...images, stepNumbers } },
      );
      const used = (article.steps as Record<string, unknown>[])
        .map((s) => s.image)
        .filter(Boolean);

      expect(used).toHaveLength(3);
    }
  });

  it('spreads them evenly when the model named no steps at all', () => {
    const article = attachSiteFields({ title: 't', steps: steps(7) }, input);
    const withImages = (article.steps as Record<string, unknown>[]).map((s) => s.image);

    expect(withImages).toEqual([
      '/image/recipes/top.webp',
      undefined,
      undefined,
      '/image/recipes/macro.webp',
      undefined,
      undefined,
      '/image/recipes/plated.webp',
    ]);
  });

  it('never gives one step two photographs, however few steps there are', () => {
    const article = attachSiteFields({ title: 't', steps: steps(2) }, input);
    const used = (article.steps as Record<string, unknown>[]).map((s) => s.image);

    expect(new Set(used.filter(Boolean)).size).toBe(used.filter(Boolean).length);
  });

  it('leaves the steps alone when the model wrote none', () => {
    expect(attachSiteFields({ title: 't' }, input).steps).toBeUndefined();
    expect(attachSiteFields({ title: 't', steps: [] }, input).steps).toEqual([]);
  });
});

describe('matching a model answer to the site vocabulary', () => {
  const allowed = ['North African', 'Middle Eastern'];

  it('accepts a term the site has, whatever the casing or punctuation', () => {
    expect(matchTaxonomy('north-african', allowed)).toBe('North African');
    expect(matchTaxonomy('  NORTH AFRICAN  ', allowed)).toBe('North African');
  });

  it('refuses a term the site does not have rather than guessing the nearest', () => {
    expect(matchTaxonomy('Algerian', allowed)).toBe('');
    expect(matchTaxonomy('African', allowed)).toBe('');
  });

  it('returns nothing when the site files nothing by that taxonomy', () => {
    expect(matchTaxonomy('North African', [])).toBe('');
    expect(matchTaxonomy('', allowed)).toBe('');
  });
});
