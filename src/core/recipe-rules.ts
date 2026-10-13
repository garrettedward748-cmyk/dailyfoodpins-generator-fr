import { canonicalTimes } from './recipe-times.js';
import {
  applySpelling, measureProblems, temperatureProblems, type WritingStyle,
} from './writing-style.js';

/**
 * The recipe, checked before three more prompts are asked to copy it.
 *
 * Every later part is told to use the recipe's quantities, temperatures and
 * times "word for word". So a Celsius-first oven temperature in the recipe is
 * not one mistake: it is the number every part is ordered to repeat, in
 * conflict with the units rule they were also given, and the article comes out
 * with both. This is the one place it is cheap to stop it — nothing has been
 * drawn or paid for yet.
 */

/** Every string in the recipe, whatever its depth, with the key it came from. */
function strings(value: unknown, key = ''): { key: string; text: string }[] {
  if (typeof value === 'string') return [{ key, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${key}[${i + 1}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => strings(v, k));
  }
  return [];
}

/** Spelling put right in every string of the recipe, so what later prompts copy is already right. */
export function fixRecipeSpelling<T>(value: T, style: WritingStyle): T {
  if (typeof value === 'string') return applySpelling(value, style) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => fixRecipeSpelling(v, style)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fixRecipeSpelling(v, style)]),
    ) as T;
  }
  return value;
}

/** Keys that hold a time, which are not prose and are checked separately. */
const TIME_KEYS = new Set(['prep_time', 'cook_time', 'total_time']);

/**
 * What is wrong with a recipe, written for the model that has to rewrite it.
 *
 * Empty when it is usable. The units checks run over the instructions, the
 * tips, the storage notes and the ingredient lines alike, since a cook meets
 * all of them.
 */
export function recipeProblems(parsed: Record<string, unknown>, style: WritingStyle): string[] {
  const problems: string[] = [];

  for (const { key, text } of strings(parsed)) {
    if (TIME_KEYS.has(key)) continue;
    for (const p of temperatureProblems(text, style, key)) problems.push(`${p.where}: ${p.detail}`);
    for (const p of measureProblems(text, style, key)) problems.push(`${p.where}: ${p.detail}`);
  }

  const times = canonicalTimes(parsed);
  if (times === null) {
    problems.push(
      'prep_time and cook_time must each be a single time written like "15 minutes" or '
      + '"1 hour 30 minutes" — use "0 minutes" for a dish with no cooking, and never a range or a word',
    );
  } else if (times.adjusted) {
    problems.push(
      'total_time is shorter than prep_time plus cook_time. It is the whole time from starting to '
      + 'eating: prep + cook + any resting, chilling or marinating, and can never be less than prep + cook',
    );
  }

  return [...new Set(problems)];
}

/** The note a rewrite carries. */
export function recipeFeedback(problems: string[]): string {
  if (problems.length === 0) return '';
  return (
    'YOUR LAST DRAFT BROKE THESE RULES. Write the recipe again, fix every one of them,\n'
    + 'and keep everything else that was right:\n'
    + problems.slice(0, 12).map((p) => `- ${p}`).join('\n')
  );
}

/** A recipe that is still wrong after the rewrite. The run stops before anything is generated or paid for. */
export class RecipeRulesError extends Error {
  constructor(readonly title: string, readonly problems: string[]) {
    super(
      `The recipe for “${title}” still breaks the rules after a rewrite, so the run stopped before any `
      + `image was made: ${problems.slice(0, 5).join('; ')}. Resume the run to try again.`,
    );
    this.name = 'RecipeRulesError';
  }
}
