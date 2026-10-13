import { describe, expect, it } from 'vitest';
import { fixProperNouns, fixProperNounsInHtml, PROPER_NOUNS } from '../src/core/proper-nouns.js';
import { attachSiteFields } from '../src/pipeline/steps/article.js';

/**
 * Capitalising the names the model keeps lower-casing.
 *
 * "these halloween rice krispie treats" shipped twice in five articles. The
 * tests that matter here are the ones about what this must NOT touch: a URL,
 * a slug, a keyword, and any word that is only sometimes a proper noun.
 */

describe('the names themselves', () => {
  it('capitalises an occasion wherever it falls', () => {
    expect(fixProperNouns('these halloween treats are easy')).toBe('these Halloween treats are easy');
    expect(fixProperNouns('for christmas and easter')).toBe('for Christmas and Easter');
    expect(fixProperNouns('during ramadan')).toBe('during Ramadan');
  });

  it('capitalises a cuisine', () => {
    expect(fixProperNouns('a moroccan flatbread')).toBe('a Moroccan flatbread');
    expect(fixProperNouns('italian and japanese technique')).toBe('Italian and Japanese technique');
  });

  it('leaves a name that is already right exactly as it is', () => {
    const text = 'A Moroccan dish for Halloween.';
    expect(fixProperNouns(text)).toBe(text);
  });

  it('prefers the longer name where two overlap', () => {
    expect(fixProperNouns('for lunar new year')).toBe('for Lunar New Year');
  });

  it('leaves a name inside a longer word alone', () => {
    expect(fixProperNouns('americano coffee')).toBe('americano coffee');
    expect(fixProperNouns('greekish')).toBe('greekish');
  });

  it('holds no word that is also an everyday kitchen word', () => {
    // french fries, a turkey, a chile, a danish: capitalising these would do
    // more damage than the lower-case names ever did.
    for (const risky of ['French', 'Turkey', 'Chile', 'Danish', 'Swiss', 'Hamburger', 'Frankfurter']) {
      expect(PROPER_NOUNS).not.toContain(risky);
    }
  });
});

describe('over HTML', () => {
  it('fixes the words and not the markup', () => {
    const html = '<p>these halloween bars are a moroccan idea</p>';
    expect(fixProperNounsInHtml(html)).toBe('<p>these Halloween bars are a Moroccan idea</p>');
  });

  it('never touches a URL, which would break the link', () => {
    const html = '<p>See <a href="https://s.com/recipe/halloween-bars">the halloween bars</a>.</p>';
    expect(fixProperNounsInHtml(html)).toBe(
      '<p>See <a href="https://s.com/recipe/halloween-bars">the Halloween bars</a>.</p>',
    );
  });

  it('never touches an attribute, so a class or an alt stays as written', () => {
    const html = '<img class="halloween-hero" alt="halloween bars">';
    expect(fixProperNounsInHtml(html)).toBe(html);
  });
});

describe('the article as it is handed to the site', () => {
  const article = {
    title: 'halloween Rice Bars',
    slug: 'halloween-rice-bars',
    focus_keyword: 'halloween rice bars',
    headline: 'a moroccan twist on a classic',
    intro_html: '<p>These halloween bars take an italian turn.</p>',
    steps: [{ heading: 'Melt the butter', body: 'Stir in the moroccan spice blend.', timer_seconds: null }],
    faqs: [{ question: 'Can I make these for christmas?', answer_html: '<p>Yes, at christmas too.</p>' }],
  };

  const input = {
    seo: { category: 'Dessert', cuisine: 'American', title: 'x', keyword: 'x', description: 'x' },
    recipe: { raw: '{}', parsed: {} },
    images: { hero: '/i/hero.webp', stepA: '', stepB: '', stepC: '' },
  } as unknown as Parameters<typeof attachSiteFields>[1];

  const out = attachSiteFields(article, input);

  it('fixes the prose a reader sees', () => {
    expect(out.title).toBe('Halloween Rice Bars');
    expect(out.headline).toBe('a Moroccan twist on a classic');
    expect(out.intro_html).toBe('<p>These Halloween bars take an Italian turn.</p>');
    expect((out.steps as { body: string }[])[0]!.body).toBe('Stir in the Moroccan spice blend.');
    expect((out.faqs as { question: string; answer_html: string }[])[0]).toMatchObject({
      question: 'Can I make these for Christmas?',
      answer_html: '<p>Yes, at Christmas too.</p>',
    });
  });

  it('leaves the slug and the focus keyword lower case, because both are meant to be', () => {
    // Capitalising the slug would change the page's address; capitalising the
    // keyword would change the phrase the page is written to target.
    expect(out.slug).toBe('halloween-rice-bars');
    expect(out.focus_keyword).toBe('halloween rice bars');
  });
});
