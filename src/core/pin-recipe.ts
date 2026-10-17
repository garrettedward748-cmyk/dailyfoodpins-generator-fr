import { recipeOfRun } from '../reels/recipe-text.js';

/**
 * The recipe as a pin design can write it on the picture: a short ingredient
 * list and three short steps (the first, one from the middle, the last).
 *
 * An image model spells short lines far better than long ones, so everything
 * here is cut down in code rather than left to the model: an ingredient loses
 * what follows its first comma or sits in brackets, a step keeps its first
 * sentence and, when that is still long, the words before a comma.
 */
export interface PinRecipe {
  /** One ingredient per line, at most eight. */
  ingredients: string;
  step1: string;
  step2: string;
  step3: string;
  /** The ribbon at the top: "Prêt en …", or "Fait maison" without a time. */
  badge: string;
}

const MAX_INGREDIENTS = 8;
const MAX_STEP_WORDS = 12;

const clean = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();

export function shortIngredient(item: string): string {
  return clean(item.replace(/\([^)]*\)/g, ' ').split(/[,;]/)[0]);
}

export function shortStep(step: string): string {
  const plain = clean(step).replace(/^(?:étape\s*)?\d+\s*[.):-]\s*/i, '');
  if (!plain) return '';
  let sentence = (plain.split(/(?<=[.!?])\s+/)[0] ?? plain).replace(/[.!?]+$/, '');
  let words = sentence.split(' ');
  if (words.length > MAX_STEP_WORDS) {
    // The words before a comma, when that leaves a real phrase; otherwise the first words.
    const parts = sentence.split(/,\s*/);
    let kept = '';
    for (const part of parts) {
      const next = kept ? `${kept}, ${part}` : part;
      if (next.split(' ').length > MAX_STEP_WORDS) break;
      kept = next;
    }
    sentence = kept.split(' ').length >= 4 ? kept : words.slice(0, MAX_STEP_WORDS).join(' ');
    words = sentence.split(' ');
  }
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** The fields for a run, or null when it has no recipe (the design is then left out of the rotation). */
export function pinRecipeFields(runId: number | null | undefined): PinRecipe | null {
  const recipe = recipeOfRun(runId);
  if (!recipe) return null;
  const ingredients = (Array.isArray(recipe.ingredients) ? recipe.ingredients : [])
    .map((item) => shortIngredient(clean(item)))
    .filter(Boolean)
    .slice(0, MAX_INGREDIENTS);
  const steps = Array.from({ length: 12 }, (_, i) => shortStep(clean(recipe[`step_${i + 1}`]))).filter(Boolean);
  if (ingredients.length === 0 || steps.length < 3) return null;
  const middle = steps[Math.floor((steps.length - 1) / 2)]!;
  const time = clean(recipe.total_time) || clean(recipe.cook_time);
  return {
    ingredients: ingredients.join('\n'),
    step1: steps[0]!,
    step2: steps.length === 3 ? steps[1]! : middle === steps[0] ? steps[1]! : middle,
    step3: steps[steps.length - 1]!,
    badge: time ? `Prêt en ${time}` : 'Fait maison',
  };
}

/** Whether a design writes the recipe on the pin, and so needs one. */
export const usesRecipe = (body: string): boolean => /\{\{\s*recipe\./.test(body);
