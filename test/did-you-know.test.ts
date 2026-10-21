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

import { buildDidYouKnowPrompt } from '../src/reels/compose.js';

describe('the "Did you know" prompt', () => {
  it('asks again when the voiceover does not open on « Vous saviez que », then gives up', async () => {
    let calls = 0;
    const bad = async () => ({ content: (calls++, 'Video of bars. VOICEOVER: « Vous pouvez les cuire. »') });
    await expect(buildDidYouKnowPrompt({ title: 't', recipe: 'r' }, bad)).rejects.toThrow(/Vous saviez que/);
    expect(calls).toBe(2);
    const good = async () => ({ content: 'Video of bars. VOICEOVER: « Vous saviez que ces barres se font en 10 minutes ? »' });
    await expect(buildDidYouKnowPrompt({ title: 't', recipe: 'r' }, good)).resolves.toMatch(/Vous saviez que/);
  });
});
