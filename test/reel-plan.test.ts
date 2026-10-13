import { describe, expect, it } from 'vitest';
import { FORMATS, pickFormat } from '../src/reels/formats.js';
import { planReel, scenesFor, validatePlan } from '../src/reels/plan.js';
import { loadPrompt } from '../src/pipeline/prompts.js';

/**
 * The storyboard: thirteen shapes a reel can take, a rotation so a page never
 * repeats one soon, and a validator that reads the model's plan before a
 * single clip is paid for.
 */

const reveal = FORMATS.find((f) => f.key === 'reveal')!;
const CTA = 'Full recipe in the comments';
const rules = () => ({
  sources: ['hero', 'stepA', 'pin'] as ('hero' | 'stepA' | 'pin')[],
  hasPresenter: true,
  targetSeconds: 30,
  format: reveal,
});
const scene = (over: Record<string, unknown> = {}) => ({
  seconds: 10, sources: ['hero'], presenter: false, image: '', motion: 'a slow pour', line: '',
  ...over,
});
const plan = (scenes: unknown[], over: Record<string, unknown> = {}) => ({
  format: 'reveal', hook: 'Wait for it', cta: CTA, scenes, ...over,
});

describe('formats', () => {
  it('has the thirteen shapes, and pov never has the presenter', () => {
    expect(FORMATS).toHaveLength(13);
    expect(FORMATS.find((f) => f.key === 'pov')?.presenter).toBe('never');
    expect(FORMATS.find((f) => f.key === 'asmr')?.speech).toBe(false);
  });

  it('avoids what the page used last', () => {
    const allowed = FORMATS.map((f) => f.key);
    for (let i = 0; i < 20; i++) {
      const picked = pickFormat(allowed, ['reveal', 'myth', 'pov', 'story'], () => i / 20);
      expect(['reveal', 'myth', 'pov', 'story']).not.toContain(picked.key);
    }
  });

  it('falls back to any allowed format when every one was used recently', () => {
    expect(pickFormat(['reveal'], ['reveal'], () => 0).key).toBe('reveal');
  });

  it('refuses an empty allow-list', () => {
    expect(() => pickFormat([], [], () => 0)).toThrow(/no format/i);
  });
});

describe('the plan validator', () => {
  it('accepts a plan that fits the rules', () => {
    const ok = validatePlan(
      plan([scene({ presenter: true, line: 'Here we go' }), scene({ sources: ['stepA'] }),
        scene({ sources: ['pin'], line: CTA })]),
      rules(),
    );
    expect(ok.scenes).toHaveLength(3);
    expect(ok.format).toBe('reveal');
  });

  it.each([
    ['too few scenes', plan([scene()]), /2 and 6/],
    ['a line too long to say in ten seconds', plan([scene({ presenter: true, line: 'word '.repeat(30) }), scene(), scene({ line: CTA })]), /22 words/],
    ['no presenter anywhere although the page has one', plan([scene(), scene(), scene({ line: CTA })]), /presenter/],
    ['the CTA missing from the last scene', plan([scene({ presenter: true, line: 'hi' }), scene(), scene({ line: 'bye' })]), /last scene/],
    ['the wrong number of scenes for the length', plan([scene({ presenter: true }), scene(), scene(), scene(), scene(), scene({ line: CTA })]), /30 seconds/],
    ['a scene with nothing happening in it', plan([scene({ presenter: true, motion: '' }), scene(), scene({ line: CTA })]), /what happens/],
  ])('rejects %s', (_label, raw, reason) => {
    expect(() => validatePlan(raw, rules())).toThrow(reason);
  });

  it('films from the feature image when a scene names a photo the article does not have', () => {
    const out = validatePlan(
      plan([scene({ sources: ['cookingProcess'], presenter: true }),
        scene({ sources: ['cookingProcess', 'stepA'] }), scene({ line: CTA })]),
      rules(),
    );
    expect(out.scenes[0]!.sources).toEqual(['hero']);
    expect(out.scenes[1]!.sources).toEqual(['stepA']);
  });

  it('does not require the presenter when the page has none, and forbids one for pov', () => {
    const noOne = { ...rules(), hasPresenter: false };
    expect(() => validatePlan(plan([scene(), scene(), scene({ line: CTA })]), noOne)).not.toThrow();

    const pov = { ...rules(), format: FORMATS.find((f) => f.key === 'pov')! };
    const out = validatePlan(plan([scene({ presenter: true }), scene(), scene({ line: CTA })]), pov);
    expect(out.scenes[0]!.presenter).toBe(false);
    expect(validatePlan(plan([scene({ presenter: true }), scene(), scene({ line: CTA })]), noOne)
      .scenes[0]!.presenter).toBe(false);
  });

  it('lets a silent format skip the spoken CTA', () => {
    const asmr = { ...rules(), format: FORMATS.find((f) => f.key === 'asmr')! };
    expect(() => validatePlan(plan([scene(), scene(), scene()]), asmr)).not.toThrow();
    expect(() => validatePlan(plan([scene({ line: 'shh' }), scene(), scene()]), asmr)).toThrow(/no speech/);
  });

  it('maps a length to a scene count', () => {
    expect([15, 30, 45, 60].map(scenesFor)).toEqual([2, 3, 5, 6]);
  });
});

describe('planning with the model', () => {
  it('renders the prompt with every placeholder filled', () => {
    const { system, user } = loadPrompt('reel-plan', {
      article: { title: 'Soup', recipe: 'boil', imagePrompts: 'hero: a bowl' },
      sources: 'feature, stepA, pin',
      presenter: { name: 'Rima', voice: 'warm' },
      format: { key: 'reveal', title: 'Reveal', shape: 'close on ingredients' },
      scenes: 3,
      targetSeconds: 30,
      cta: CTA,
      note: '',
    });
    expect(system + user).not.toMatch(/\{\{/);
    expect(user).toContain('Rima');
  });

  it('asks once more with the refusal when the first plan breaks a rule', async () => {
    const calls: Record<string, unknown>[] = [];
    const good = plan([scene({ presenter: true, line: 'hi' }), scene(), scene({ line: CTA })]);
    const out = await planReel({
      prompt: async (_name, vars) => {
        calls.push(vars);
        return { content: JSON.stringify(calls.length === 1 ? plan([scene()]) : good) };
      },
      article: { title: 'Soup', recipe: 'boil', imagePrompts: {} },
      sources: ['hero'],
      presenter: { name: 'Rima', voice: 'warm' },
      targetSeconds: 30,
      format: reveal,
    });
    expect(calls).toHaveLength(2);
    expect(String(calls[1]!.note)).toContain('refused');
    expect(out.scenes).toHaveLength(3);
  });

  it('shows the model only the prompts of photos the article has', async () => {
    let user = '';
    await planReel({
      prompt: async (_name, vars) => {
        user = JSON.stringify(vars);
        return { content: JSON.stringify(plan([scene({ presenter: true, line: 'hi' }), scene(), scene({ line: CTA })])) };
      },
      article: { title: 'Soup', recipe: 'boil', imagePrompts: { hero: 'a bowl', cookingProcess: 'a pot' } },
      sources: ['hero', 'stepA'],
      presenter: { name: 'Rima', voice: 'warm' },
      targetSeconds: 30,
      format: reveal,
    });
    expect(user).toContain('hero: a bowl');
    expect(user).not.toContain('cookingProcess');
    expect(user).toContain('Reveal');
  });

  it('asks the model once and returns the validated plan', async () => {
    const answer = plan([
      scene({ presenter: true, line: 'hi' }),
      scene({ sources: ['stepA'] }),
      scene({ line: CTA }),
    ]);
    const calls: string[] = [];
    const out = await planReel({
      prompt: async (name) => {
        calls.push(name);
        return { content: '```json\n' + JSON.stringify(answer) + '\n```' };
      },
      article: { title: 'Soup', recipe: 'boil', imagePrompts: { hero: 'a bowl' } },
      sources: ['hero', 'stepA', 'pin'],
      presenter: { name: 'Rima', voice: 'warm' },
      targetSeconds: 30,
      format: reveal,
    });
    expect(calls).toEqual(['reel-plan']);
    expect(out.scenes[0]!.presenter).toBe(true);
  });
});
