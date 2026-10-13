import { describe, expect, it } from 'vitest';
import { collapsedToGroup } from '../src/pipeline/steps/content.js';
import { STEP_CONTEXTS } from '../src/pipeline/prompt-contexts.js';
import { configurePrompts, loadPrompt } from '../src/pipeline/prompts.js';

/**
 * The seed keyword is a research label, not a recipe.
 *
 * Spying on one topic yields five or ten different dishes under it. The
 * pipeline used to write every article from `spy.title` alone — description
 * and annotation were put into the step's context and then never referenced by
 * any template — so five recipes sharing a topic produced five copies of the
 * same article with the same pictures.
 */

configurePrompts('./prompts');

const SPY = {
  group: 'Chicken Thighs',
  title: 'Baked Chicken Thighs in Honey Soy Sauce',
  description: 'Sticky, sweet and salty thighs roasted in a honey soy glaze.',
  annotation: 'reader favourite, 30 minutes, one pan',
  articleUrl: 'https://example.com/honey-soy',
};

const SEO = {
  keyword: 'honey soy baked chicken thighs',
  title: 'Honey Soy Baked Chicken Thighs',
  description: 'Sticky honey soy chicken thighs, roasted in one pan.',
  category: 'Dinner',
};

describe('the research reaches the prompts', () => {
  it('gives spy-validation the description and the annotation, not just the title', () => {
    const { user } = loadPrompt('spy-validation', {
      spy: SPY,
      categoryTitles: '["Dinner"]',
      site: { domain: 'bitespoon.com' },
    });

    expect(user).toContain(SPY.title);
    expect(user).toContain(SPY.description);
    expect(user).toContain(SPY.annotation);
  });

  it('tells spy-validation the group is context and not the subject', () => {
    const { system, user } = loadPrompt('spy-validation', {
      spy: SPY,
      categoryTitles: '[]',
      site: { domain: 'bitespoon.com' },
    });

    expect(user).toContain('Chicken Thighs');
    expect(user.toLowerCase()).toContain('context only');
    expect(system).toContain('THE TOPIC GROUP IS NOT THE DISH');
  });

  it('gives the recipe generator the source dish, not only the derived SEO', () => {
    const { user } = loadPrompt('recipe-generator', { seo: SEO, spy: SPY });

    expect(user).toContain(SPY.title);
    expect(user).toContain(SPY.description);
    expect(user).toContain(SPY.annotation);
  });

  it('gives the image prompts the source dish', () => {
    const { user } = loadPrompt('image-prompts', {
      seo: SEO,
      spy: SPY,
      recipe: { raw: '{}' },
      recipeJson: '{}',
    });

    expect(user).toContain(SPY.title);
  });

  it('renders no empty placeholder in any of them', () => {
    // A placeholder nothing supplies renders blank and the article quietly
    // comes out worse, which is how the description and annotation went
    // missing for so long.
    for (const name of ['spy-validation', 'recipe-generator', 'image-prompts']) {
      const context = STEP_CONTEXTS[name]!;
      const { system, user } = loadPrompt(name, context);
      expect(`${system}${user}`).not.toMatch(/\{\{/);
    }
  });

  it('declares spy.group and spy.description in the shared contract', () => {
    const spy = (STEP_CONTEXTS['recipe-generator'] as { spy: Record<string, unknown> }).spy;
    expect(spy).toHaveProperty('group');
    expect(spy).toHaveProperty('description');
    expect(spy).toHaveProperty('annotation');
  });
});

describe('noticing when the model answered with the group', () => {
  it('flags the exact label', () => {
    expect(collapsedToGroup('chicken thighs', 'Chicken Thighs')).toBe(true);
  });

  it('flags it through plurals and case', () => {
    expect(collapsedToGroup('Chicken Thigh', 'chicken thighs')).toBe(true);
  });

  it('flags a subset of the label, which is no more specific', () => {
    expect(collapsedToGroup('chicken', 'chicken thighs')).toBe(true);
  });

  it('accepts a dish that adds the sauce', () => {
    expect(collapsedToGroup('honey soy chicken thighs', 'chicken thighs')).toBe(false);
  });

  it('accepts a dish that adds the method', () => {
    expect(collapsedToGroup('caramelized bbq chicken thighs oven', 'Chicken Thighs')).toBe(false);
  });

  it('accepts a dish that is simply different', () => {
    expect(collapsedToGroup('one pot chicken and rice', 'Chicken Thighs')).toBe(false);
  });

  it('says nothing when there is no group to compare against', () => {
    expect(collapsedToGroup('honey soy chicken thighs', '')).toBe(false);
  });
});
