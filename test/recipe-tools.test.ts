import { describe, expect, it, vi } from 'vitest';
import { recipeToolsStep } from '../src/pipeline/steps/recipe-tools.js';

const ctx = (answer: string, on = true) => {
  const sent: unknown[] = [];
  return {
    sent,
    value: {
      settings: { getBool: () => on },
      prompt: vi.fn(async () => ({ content: answer })),
      siteApi: { setRecipeTools: vi.fn(async (id: string, tools: unknown) => { sent.push({ id, tools }); }) },
    } as never,
  };
};
const input = { title: 'Banana Bread', recipe: { steps: ['Grease a loaf pan'] }, posted: { id: 42 } as never };

describe('the tools list', () => {
  it('sends the tools to the site, at most six, without haram items', async () => {
    const c = ctx(JSON.stringify({ tools: [
      { name: '9x5-inch loaf pan', search: '9x5 metal loaf pan' },
      { name: 'Wine glasses', search: 'wine glasses' },
      { name: 'Hand mixer' },
    ] }));
    const out = await recipeToolsStep.run(c.value, input);
    expect(out).toEqual({ tools: [{ name: '9x5-inch loaf pan', search: '9x5 metal loaf pan' }, { name: 'Hand mixer', search: 'Hand mixer' }] });
    expect(c.sent[0]).toEqual({ id: '42', tools: (out as { tools: unknown }).tools });
  });

  it('does nothing when switched off', async () => {
    const c = ctx('{}', false);
    expect(await recipeToolsStep.run(c.value, input)).toMatchObject({ skipped: expect.any(String) });
    expect(c.sent).toHaveLength(0);
  });
});
