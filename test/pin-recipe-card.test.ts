import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDb, openDatabase, run } from '../src/db/index.js';
import { beginStep, createRun, finishStep, insertKeyword, upsertSite } from '../src/db/repos.js';
import { pinRecipeFields, shortIngredient, shortStep, usesRecipe } from '../src/core/pin-recipe.js';
import { RECIPE_CARD_BODY, RECIPE_CARD_NAME } from '../src/core/pin-design-recipe-card.js';
import { designProblems, listPinDesigns, pickPinDesign } from '../src/core/pin-designs.js';
import { render } from '../src/pipeline/prompts.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { setLogLevel } from '../src/lib/logger.js';

describe('the recipe as a pin writes it', () => {
  it('keeps an ingredient up to its first comma, without brackets', () => {
    expect(shortIngredient('1 kg de pommes de terre (à chair ferme), épluchées')).toBe('1 kg de pommes de terre');
  });

  it('keeps a step to its first sentence, and a long one to the words before a comma', () => {
    expect(shortStep('1. Frotter le plat avec l’ail. Beurrer ensuite.')).toBe('Frotter le plat avec l’ail.');
    expect(shortStep('Verser la crème et le lait assaisonnés sur les pommes de terre, puis enfourner à 160 °C pendant environ une heure et quart')).toBe(
      'Verser la crème et le lait assaisonnés sur les pommes de terre.',
    );
  });

  it('tells a design that writes the recipe from one that does not', () => {
    expect(usesRecipe(RECIPE_CARD_BODY)).toBe(true);
    expect(usesRecipe('{{imagePrompts.pin}} {{pinTitle}} {{site.domain}}')).toBe(false);
    expect(designProblems(RECIPE_CARD_BODY)).toEqual([]);
  });
});

describe('with a run', () => {
  let run1 = 0;
  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    const site = upsertSite({ name: 'D', domain: 'd.fr', status: 'active', daily_target: 1, interval_minutes: 60 }, randomBytes(32));
    run1 = createRun(insertKeyword({ seed_keyword: 'gratin', spy_title: 'Gratin dauphinois' }), site);
  });
  afterEach(() => closeDatabase());

  it('gives the ingredients, the first, a middle and the last step, and the time', () => {
    beginStep(run1, 'generate-recipe');
    finishStep(run1, 'generate-recipe', {
      status: 'ok',
      output: {
        raw: '',
        parsed: {
          total_time: '1 h 30',
          ingredients: ['1 kg pommes de terre', '40 cl crème', '20 cl lait', 'ail', 'muscade'],
          step_1: 'Frotter le plat avec l’ail.',
          step_2: 'Trancher finement les pommes de terre.',
          step_3: 'Disposer les pommes de terre finement tranchées.',
          step_4: 'Verser crème et lait. Cuire à 160 °C.',
        },
      },
    });
    const r = pinRecipeFields(run1)!;
    expect(r.ingredients).toBe('1 kg pommes de terre\n40 cl crème\n20 cl lait\nail\nmuscade');
    expect([r.step1, r.step2, r.step3]).toEqual([
      'Frotter le plat avec l’ail.',
      'Trancher finement les pommes de terre.',
      'Verser crème et lait.',
    ]);
    expect(r.badge).toBe('Prêt en 1 h 30');
    const prompt = render(RECIPE_CARD_BODY, { pinTitle: 'Gratin dauphinois', site: { domain: 'd.fr' }, imagePrompts: { pin: 'A gratin.' }, recipe: r });
    expect(prompt).not.toMatch(/\{\{/);
    expect(prompt).toContain('"1 kg pommes de terre\n40 cl crème');
  });

  it('is null without a recipe, so the card sits out', () => {
    expect(pinRecipeFields(run1)).toBeNull();
  });

  it('comes with a fresh install, and the migration adds it once to one that has its designs', () => {
    expect(listPinDesigns().some((d) => d.name === RECIPE_CARD_NAME)).toBe(true);
    run('DELETE FROM pin_designs WHERE name = ?', RECIPE_CARD_NAME);
    const migration = MIGRATIONS.find((m) => m.id === '060-pin-design-recipe-card')!;
    migration.up(getDb());
    migration.up(getDb());
    const cards = listPinDesigns().filter((d) => d.name === RECIPE_CARD_NAME);
    expect(cards).toHaveLength(1);
    expect(pickPinDesign(cards, [], {}, 1)?.name).toBe(RECIPE_CARD_NAME);
  });
});
