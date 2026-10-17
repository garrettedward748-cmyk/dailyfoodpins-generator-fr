import { describe, expect, it } from 'vitest';
import { checkPart, ruleContextFor } from '../src/core/article-rules.js';
import { wordDurationsIn } from '../src/core/recipe-times.js';
import { LLM_REPLIES, RECIPE } from './helpers/pipeline-world.js';

/**
 * Run #1010 (pumpkin cheesecake milkshake) failed part 2 on every attempt: the
 * recipe listed 15 ingredients while the card was capped at 14 and told never
 * to drop one, and the steps said "2 hours" and "6 hours" for a wait the
 * recipe wrote in words.
 */

const draft = (): Record<string, any> => JSON.parse(LLM_REPLIES['part-2']!);
const line = (i: number) => ({ amount: '1', unit: 'cup', item: `thing ${i}`, note: '' });

describe('the ingredient count', () => {
  it('follows the source when it lists more than 14, up to 20', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => `1 cup thing ${i}`);
    const ctx = ruleContextFor('us', { raw: JSON.stringify({ ...RECIPE, ingredients: fifteen }), parsed: { ...RECIPE, ingredients: fifteen } });
    const ingredients = Array.from({ length: 15 }, (_, i) => line(i));
    expect(checkPart('part-2', { ...draft(), ingredients }, ctx).problems.join(' | ')).not.toContain('ingredients: 15 lines');

    const thirty = Array.from({ length: 30 }, (_, i) => `1 cup thing ${i}`);
    expect(ruleContextFor('us', { raw: '', parsed: { ...RECIPE, ingredients: thirty } }).maxIngredients).toBe(20);
  });

  it('keeps 14 for a source with fewer', () => {
    const ctx = ruleContextFor('us', { raw: JSON.stringify(RECIPE), parsed: RECIPE as Record<string, unknown> });
    const ingredients = Array.from({ length: 15 }, (_, i) => line(i));
    expect(checkPart('part-2', { ...draft(), ingredients }, ctx).problems.join(' | ')).toContain('ingredients: 15 lines, it must be 8 to 14');
  });
});

describe('times the recipe writes in words', () => {
  it('reads them, ranges and "up to" included', () => {
    expect(wordDurationsIn('Chill for at least two hours, or up to six.')).toEqual([120, 360]);
    expect(wordDurationsIn('Freeze two to six hours.')).toEqual([120, 360]);
    expect(wordDurationsIn('Rest ten minutes.')).toEqual([10]);
    expect(wordDurationsIn('Someone hours later')).toEqual([]);
    expect(wordDurationsIn("Réfrigérer au moins deux heures, ou jusqu'à six.")).toEqual([120, 360]);
    expect(wordDurationsIn('Laisser reposer dix minutes.')).toEqual([10]);
    expect(wordDurationsIn('Une heure de cuisson.')).toEqual([60]);
  });

  it('lets a step say "2 hours" when the recipe said "two hours"', () => {
    const raw = JSON.stringify({ ...RECIPE, step_5: 'Chill for at least two hours, or up to six.' });
    const ctx = ruleContextFor('us', { raw, parsed: RECIPE as Record<string, unknown> });
    const steps = draft().steps.map((s: Record<string, unknown>, i: number) => (i === 0 ? { ...s, body: `${s.body} Chill it 2 hours, or up to 6 hours.` } : s));
    expect(checkPart('part-2', { ...draft(), steps }, ctx).problems.join(' | ')).not.toContain('not a time in the recipe');
  });
});
