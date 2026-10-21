import { describe, expect, it } from 'vitest';
import { captionWords } from '../src/reels/assemble.js';
import { isDidYouKnowSeed, reelMode } from '../src/reels/compose.js';

describe('"Did you know" reels', () => {
  it('is a reel mode of its own', () => {
    const settings = { get: () => 'didyouknow' } as unknown as Parameters<typeof reelMode>[0];
    expect(reelMode(settings)).toBe('didyouknow');
  });

  it('is told apart by its plan', () => {
    expect(isDidYouKnowSeed(JSON.stringify({ didYouKnow: true }))).toBe(true);
    expect(isDidYouKnowSeed(JSON.stringify({ mixed: true }))).toBe(false);
    expect(isDidYouKnowSeed('not json')).toBe(false);
  });

  it('shows each word until the next one is said, upper case, without punctuation', () => {
    const out = captionWords([
      { w: 'Did', start: 0.1, end: 0.3 },
      { w: 'you', start: 0.35, end: 0.5 },
      { w: 'know?', start: 0.55, end: 0.9 },
      { w: '—', start: 1, end: 1.1 },
      { w: 'Bake.', start: 2.5, end: 2.8 },
    ]);
    expect(out.map((x) => x[0])).toEqual(['DID', 'YOU', 'KNOW', 'BAKE']);
    expect(out[0]![1]).toBe(0.1);
    expect(out[0]![2]).toBeCloseTo(0.31);
    // Never two words on screen at once.
    for (let i = 1; i < out.length; i++) expect(out[i]![1]).toBeGreaterThan(out[i - 1]![2]);
    // A pause: the word comes off a moment after it is said, not when the next one starts.
    expect(out[2]![2]).toBeCloseTo(1.15);
  });
});

import { buildDidYouKnowPrompt, ingredientCount, validateDidYouKnow } from '../src/reels/compose.js';

const goodPlan = {
  dish: 'pumpkin caramels',
  shots: [
    'hands pour pumpkin puree and cream into a saucepan of melted butter and sugar',
    'the glossy caramel is poured into a parchment-lined pan',
    'soft caramel squares on a plate, a hand lifts one toward the camera',
  ],
  voiceover: 'Vous saviez que la purée de potiron transforme un simple caramel en bonbon fondant ? On mélange, on verse, on coupe. Trop fondant.',
};
const recipe = JSON.stringify({ raw: '', parsed: { ingredients: ['1', '2', '3', '4', '5', '6', '7', '8'] } });

describe('le prompt « Vous saviez que »', () => {
  it('compte les ingrédients', () => {
    expect(ingredientCount(recipe)).toBe(8);
  });

  it('refuse un nombre d\'ingrédients faux', () => {
    expect(() => validateDidYouKnow({ ...goodPlan, voiceover: 'Vous saviez que ces bonbons fondants au potiron se font avec seulement trois ingrédients et sans farine ? Trop fondant.' }, 8)).toThrow(/recipe has 8/);
    expect(() => validateDidYouKnow({ ...goodPlan, voiceover: 'Vous saviez que ces bonbons fondants au potiron demandent huit ingrédients et une seule casserole ? Trop fondant.' }, 8)).not.toThrow();
  });

  it('refuse une voix qui ne commence pas par « Vous saviez que »', () => {
    expect(() => validateDidYouKnow({ ...goodPlan, voiceover: 'Ces bonbons au potiron se font dans une seule casserole, puis on les coupe en petits carrés. Trop fondant.' }, 8)).toThrow(/Vous saviez que/);
  });

  it('écrit le prompt Flow avec trois plans minutés et une voix française', async () => {
    const out = await buildDidYouKnowPrompt({ title: 'Bonbons caramel potiron', recipe }, async () => ({ content: JSON.stringify(goodPlan) }));
    expect(out).toMatch(/0–3 s: .*3–6 s: .*6–10 s: /);
    expect(out).toMatch(/Voiceover in French \(France\).*word for word: « Vous saviez que/);
  });
});

import { isFinishedSeed } from '../src/reels/compose.js';

describe('a reel whose video is already the finished copy', () => {
  it('is recognised, so it is not re-encoded a second time', () => {
    expect(isFinishedSeed(JSON.stringify({ didYouKnow: true, finished: true }))).toBe(true);
    expect(isFinishedSeed(JSON.stringify({ didYouKnow: true }))).toBe(false);
  });
});
