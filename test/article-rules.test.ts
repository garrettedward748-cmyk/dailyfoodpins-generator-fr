import { describe, expect, it } from 'vitest';
import {
  ArticleRulesError, bannedList, checkBlogArticle, checkPart, feedbackFor, openingProblems,
  proseProblems, ruleContextFor,
} from '../src/core/article-rules.js';
import { LLM_REPLIES, RECIPE } from './helpers/pipeline-world.js';

/**
 * The flavorza pages shipped a title past its limit, "ready in 27 minutes" over
 * a card that said 47, "260°C (500°F)" on an American site and "You must decide…"
 * as an opening. Each is a case below; a good draft must pass untouched.
 */

const parse = (key: string): Record<string, any> => JSON.parse(LLM_REPLIES[key]!);
const recipe = { raw: JSON.stringify(RECIPE), parsed: RECIPE as Record<string, unknown> };
const us = ruleContextFor('us', recipe);
const uk = ruleContextFor('uk', recipe);

describe('a good draft', () => {
  it.each(['part-1', 'part-2', 'part-3'] as const)('%s passes with no problems', (part) => {
    expect(checkPart(part, parse(part), us).problems).toEqual([]);
  });
});

describe('part 1', () => {
  const check = (patch: Record<string, unknown>) => checkPart('part-1', { ...parse('part-1'), ...patch }, us).problems.join(' | ');

  it('REGRESSION: refuses a title past 65 characters', () => {
    const title = 'Honey Roasted Butternut Squash Stuffed with Chicken: A Savory Autumn Dinner';
    expect(title.length).toBeGreaterThan(65);
    expect(check({ title })).toContain('limit is 65');
  });

  it('refuses a title with no colon, or that ends with "Recipe"', () => {
    expect(check({ title: 'Simple Chicken' })).toContain('colon');
    expect(check({ title: 'Test Chicken: Simple Recipe' })).toContain('"Recipe"');
  });

  it('refuses a headline with a colon or a full stop', () => {
    expect(check({ headline: 'Crisp: skin' })).toContain('colon');
    expect(check({ headline: 'Crisp skin.' })).toContain('full stop');
  });

  it('refuses a meta description outside 120-160 characters', () => {
    expect(check({ meta_desc: 'Too short.' })).toContain('meta_desc: 10 characters');
    expect(check({ meta_desc: 'x'.repeat(170) })).toContain('170 characters');
  });

  it('REGRESSION: refuses "ready in 47 minutes" when the recipe says 27', () => {
    const out = check({ meta_desc: 'Sear chicken thighs until the skin crisps, then finish them in a hot oven. Ready in just 47 minutes and serves four people.' });
    expect(out).toContain('47 minutes');
  });

  it('allows the recipe\'s own total', () => {
    const out = check({ meta_desc: 'Sear chicken thighs until the skin crisps, then finish them in a hot oven. Ready in just 27 minutes and serves four people.' });
    expect(out).not.toContain('27 minutes');
  });

  it('REGRESSION: refuses "You must decide…" as an opening', () => {
    expect(check({ intro_html: '<p>You must decide how crisp you want the skin. Then sear.</p>' })).toContain('you must decide');
    expect(openingProblems('<p>When it comes to chicken, skin matters.</p>')).toHaveLength(1);
    expect(openingProblems('<p>Chicken thighs stay moist. You must decide later.</p>')).toEqual([]);
  });

  it('converts British spelling instead of retrying', () => {
    const fixed = checkPart('part-1', { ...parse('part-1'), headline: 'A savoury colour in the pan' }, us);
    expect(fixed.data.headline).toBe('A savory color in the pan');
    expect(fixed.problems).toEqual([]);
  });
});

describe('part 2', () => {
  const draft = () => parse('part-2');

  it('REGRESSION: sets the minutes from the recipe, so the card cannot say 47', () => {
    const out = checkPart('part-2', { ...draft(), prep_minutes: 10, cook_minutes: 12, rest_minutes: 25 }, us);
    expect(out.data).toMatchObject({ prep_minutes: 10, cook_minutes: 12, rest_minutes: 5 });
  });

  it('REGRESSION: refuses "260°C (500°F)" on an American site', () => {
    const steps = draft().steps;
    steps[0].body = 'Place the skillet into an oven preheated to 260°C (500°F). It sears the steak fast.';
    const out = checkPart('part-2', { ...draft(), steps }, us);
    expect(out.problems.join(' | ')).toContain('260°C');
  });

  it('accepts the same step on a British site', () => {
    const steps = draft().steps;
    steps[0].body = 'Place the skillet into an oven preheated to 260°C (500°F). It sears the steak fast.';
    const out = checkPart('part-2', { ...draft(), steps }, uk);
    expect(out.problems.join(' | ')).not.toContain('260°C');
  });

  it('refuses metric ingredient units on an American site', () => {
    const ingredients = draft().ingredients;
    ingredients[0] = { amount: '900', unit: 'g', item: 'chicken thighs', note: '' };
    expect(checkPart('part-2', { ...draft(), ingredients }, us).problems.join(' | ')).toContain('ingredients line 1');
  });

  it('refuses too few steps or ingredients, and a bad difficulty', () => {
    const out = checkPart('part-2', { ...draft(), steps: draft().steps.slice(0, 3), ingredients: [], difficulty: 'tricky' }, us).problems.join(' | ');
    expect(out).toContain('steps: 3 steps');
    expect(out).toContain('ingredients: 0 lines');
    expect(out).toContain('difficulty');
  });

  it('refuses a step time the recipe never gave', () => {
    const steps = draft().steps;
    steps[2].body = 'Sear the chicken skin side down for 9 minutes until deeply golden. Leave it alone.';
    expect(checkPart('part-2', { ...draft(), steps }, us).problems.join(' | ')).toContain('9 minutes');
  });
});

describe('part 3', () => {
  it('refuses missing questions and the wrong number of tags', () => {
    const out = checkPart('part-3', { ...parse('part-3'), faqs: [], tags: ['a'] }, us).problems.join(' | ');
    expect(out).toContain('faqs');
    expect(out).toContain('tags: 1');
  });

  it('lets a reader ask "Can I…" but not the site to say "I"', () => {
    expect(checkPart('part-3', parse('part-3'), us).problems).toEqual([]);
    const p3 = parse('part-3');
    p3.faqs[0].answer_html = '<p>I always use boneless thighs, and I think they work well here.</p>';
    expect(checkPart('part-3', p3, us).problems.join(' | ')).toContain('first person');
  });
});

describe('voice', () => {
  it('names each banned thing it finds', () => {
    const out = proseProblems('A delicious, mouthwatering dish! 😀 I love it.', 'intro').join(' | ');
    expect(out).toContain('"delicious"');
    expect(out).toContain('"mouthwatering"');
    expect(out).toContain('exclamation');
    expect(out).toContain('emoji');
    expect(out).toContain('first person');
  });

  it('does not match inside another word', () => {
    expect(proseProblems('Indelicate handling of a delicately cooked fish.', 'x')).toEqual([]);
  });

  it('prints the list the prompts show', () => {
    expect(bannedList()).toContain('"delicious"');
  });
});

describe('feedback and failure', () => {
  it('tells the model each rule it broke, and nothing when there is none', () => {
    expect(feedbackFor([])).toBe('');
    expect(feedbackFor(['title: too long'])).toContain('- title: too long');
  });

  it('carries the problems in the error that stops a run', () => {
    const error = new ArticleRulesError('part-1', ['title: too long']);
    expect(error.message).toContain('part-1');
    expect(error.message).toContain('title: too long');
    expect(error.name).toBe('ArticleRulesError');
  });
});

describe('blog articles', () => {
  const article = {
    title: 'How to Sear Chicken', slug: 'how-to-sear-chicken', title_tag: 'How to Sear Chicken',
    meta_desc: 'Learn to sear chicken.', excerpt: 'Searing basics.', cover_alt: 'A pan of chicken',
    body_html: '<p>Chicken thighs sear best in a hot pan at 450°F (230°C).</p>',
  };

  it('passes a clean article', () => {
    expect(checkBlogArticle(article, 'us').problems).toEqual([]);
  });

  it('fixes spelling and refuses Celsius-first on an American site', () => {
    const out = checkBlogArticle({ ...article, body_html: '<p>A savoury crust at 230°C (450°F).</p>' }, 'us');
    expect(out.article.body_html).toContain('savory');
    expect(out.problems.join(' | ')).toContain('230°C');
  });
});
