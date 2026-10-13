import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHandsPrompt, isStudioMode, reelMode } from '../src/reels/compose.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { randomBytes } from 'node:crypto';

/**
 * Hands-only: a one-shot reel like single -- one Flow generation, no
 * assembly stage -- but its prompt is written by the model for this recipe
 * rather than filled into a fixed template, because it has to name the
 * dish's own ingredients and steps.
 */

describe('hands-only reel mode', () => {
  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  it('reads back from settings, defaulting to single for anything else', () => {
    const settings = new Settings(randomBytes(32));
    expect(reelMode(settings)).toBe('single');
    settings.set('reel_mode', 'hands');
    expect(reelMode(settings)).toBe('hands');
    settings.set('reel_mode', 'nonsense');
    expect(reelMode(settings)).toBe('single');
  });

  it('is a one-shot mode, not a studio one', () => {
    expect(isStudioMode('hands')).toBe(false);
    expect(isStudioMode('single')).toBe(false);
    expect(isStudioMode('mixed')).toBe(false);
    expect(isStudioMode('scenes')).toBe(true);
    expect(isStudioMode('process')).toBe(true);
  });

  it('asks the model once, with the title and recipe, and returns its answer trimmed', async () => {
    const prompt = vi.fn(async (name: string, vars: Record<string, unknown>) => {
      expect(name).toBe('reel-hands');
      expect(vars).toMatchObject({ title: 'Skillet Brownies' });
      expect(String(vars.recipe)).toContain('bananas');
      return { content: '  Cinematic ASMR food preparation video of skillet brownies...  \n' };
    });

    const text = await buildHandsPrompt(
      { title: 'Skillet Brownies', recipe: '{"ingredients":["2 bananas","2 eggs","cocoa powder"]}' },
      prompt,
    );

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(text).toBe('Cinematic ASMR food preparation video of skillet brownies...');
  });

  it('truncates a very long recipe before sending it to the model', async () => {
    const longRecipe = 'x'.repeat(20_000);
    const prompt = vi.fn(async (_name: string, vars: Record<string, unknown>) => {
      expect(String(vars.recipe).length).toBeLessThanOrEqual(8000);
      return { content: 'ok' };
    });
    await buildHandsPrompt({ title: 't', recipe: longRecipe }, prompt);
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
