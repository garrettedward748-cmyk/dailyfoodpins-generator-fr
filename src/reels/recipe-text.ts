import { getCompletedStep } from '../db/repos.js';
import { fixProperNouns } from '../core/proper-nouns.js';

/**
 * The recipe as plain text for a post, and the two choices that decide what a
 * Facebook reel carries besides its caption: how much of the recipe, and where
 * the link goes.
 *
 * The text is built from the recipe the article was written from, not asked of
 * a model. A model rewriting "1 1/2 cups" or "175°C" into a post can drift by
 * one digit, and a scheduled post is not something a person can correct.
 */

export type RecipeInPost = 'none' | 'ingredients' | 'full';
export type FacebookLinkMode = 'text' | 'comment' | 'keyword' | 'none';

export const RECIPE_IN_POST: readonly RecipeInPost[] = ['full', 'ingredients', 'none'];
export const FACEBOOK_LINK_MODES: readonly FacebookLinkMode[] = ['text', 'comment', 'keyword', 'none'];

/** The stored choice read back; anything unknown is the default, "full". */
export const parseRecipeInPost = (value: string): RecipeInPost =>
  RECIPE_IN_POST.find((mode) => mode === value.trim().toLowerCase()) ?? 'full';

/** The stored choice read back; anything unknown is the default, the link in the text. */
export const parseFacebookLinkMode = (value: string): FacebookLinkMode =>
  FACEBOOK_LINK_MODES.find((mode) => mode === value.trim().toLowerCase()) ?? 'text';

/** Words that are never the dish: connectors, and the adjectives every recipe title carries. */
const NOT_THE_DISH = new Set([
  'the', 'and', 'with', 'for', 'from', 'your', 'you', 'our', 'that', 'this', 'into', 'over', 'under', 'out', 'any',
  'best', 'easy', 'quick', 'simple', 'fast', 'homemade', 'perfect', 'ultimate', 'classic', 'creamy', 'delicious',
  'healthy', 'recipe', 'recipes', 'ideas', 'idea', 'make', 'made', 'how', 'why', 'what', 'ways', 'way', 'style',
  'minute', 'minutes', 'ingredient', 'ingredients', 'super', 'extra', 'ever', 'tasty', 'amazing', 'favorite',
  // French (accents are stripped before this is consulted).
  'les', 'des', 'une', 'aux', 'pour', 'avec', 'sans', 'sur', 'sous', 'dans', 'que', 'qui', 'votre', 'vos', 'notre', 'nos',
  'recette', 'recettes', 'facile', 'faciles', 'rapide', 'rapides', 'simple', 'simples', 'maison', 'parfait', 'parfaite',
  'meilleur', 'meilleure', 'ultime', 'classique', 'cremeux', 'cremeuse', 'delicieux', 'delicieuse', 'healthy', 'ideal',
  'idees', 'idee', 'comment', 'faire', 'astuce', 'astuces',
]);

/**
 * The one word a post asks readers to comment: the dish, taken from the
 * recipe's title ("Cheesecake Bars" -> "cheesecake"), so that every post
 * invites its own word. The longest word that is not filler wins, the
 * earliest on a tie; `fallback` (the global trigger word) when a title has
 * nothing usable. Lowercase, letters only: it is typed by a person on a phone.
 */
export function commentKeywordFor(title: string | null | undefined, fallback = ''): string {
  const words = (title ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z]{3,}/g) ?? [];
  let best = '';
  for (const word of words) {
    if (NOT_THE_DISH.has(word)) continue;
    if (word.length > best.length) best = word;
  }
  return best || fallback.trim().toLowerCase();
}

/**
 * The model's pick, checked. A model asked for "one word" sometimes returns a
 * sentence, a quoted word or a hashtag; anything that is not a plain word of
 * 4 to 14 letters, or is filler, is thrown away for the title-based
 * `commentKeywordFor`, so a post always has a word and never a bad one.
 */
export async function pickCommentKeyword(
  title: string | null | undefined,
  ask: (title: string) => Promise<string>,
  fallback = '',
): Promise<string> {
  const plain = commentKeywordFor(title, fallback);
  if (!title?.trim()) return plain;
  try {
    const answer = (await ask(title.trim()))
      .trim()
      .toLowerCase()
      .replace(/^["'#\s]+|["'.#\s]+$/g, '');
    if (/^[a-z]{4,14}$/.test(answer) && !NOT_THE_DISH.has(answer)) return answer;
  } catch {
    // no model today: the title still gives a word
  }
  return plain;
}

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

/** "Step 3:" and "3." in front of a step are dropped: the list numbers them itself. */
const stripNumbering = (step: string): string =>
  step.replace(/^\s*(?:step\s*\d+\s*[:.)-]?|\d+\s*[.):-])\s*/i, '').trim();

/**
 * The recipe the run's article was written from, or null when the run has none
 * (a reel made by hand from no article, or a run that failed before this step).
 */
export function recipeOfRun(runId: number | null | undefined): Record<string, unknown> | null {
  if (!runId) return null;
  const step = getCompletedStep(runId, 'generate-recipe');
  if (!step?.output_json) return null;
  try {
    const output = JSON.parse(step.output_json) as { parsed?: unknown } | null;
    const parsed = output && typeof output === 'object' && 'parsed' in output ? output.parsed : output;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Ingredients, and with `full` the method, as text a feed shows as it is.
 * Empty when there is nothing to show, so the caller never prints a heading
 * over nothing.
 */
export function formatRecipe(recipe: Record<string, unknown>, mode: Exclude<RecipeInPost, 'none'>): string {
  const ingredients = (Array.isArray(recipe.ingredients) ? recipe.ingredients : [])
    .map(text)
    .filter(Boolean);
  const steps = Array.from({ length: 10 }, (_, i) => stripNumbering(text(recipe[`step_${i + 1}`])))
    .filter(Boolean);

  const facts = [
    text(recipe.prep_time) && `Préparation ${text(recipe.prep_time)}`,
    text(recipe.cook_time) && `Cuisson ${text(recipe.cook_time)}`,
    text(recipe.servings) && `Portions ${text(recipe.servings)}`,
  ].filter(Boolean).join(' · ');

  const sections: string[] = [];
  if (ingredients.length > 0) {
    sections.push(`INGRÉDIENTS\n${ingredients.map((item) => `• ${item}`).join('\n')}`);
  }
  if (mode === 'full' && steps.length > 0) {
    sections.push(`PRÉPARATION\n${steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}`);
  }
  if (sections.length === 0) return '';

  return fixProperNouns([facts, ...sections].filter(Boolean).join('\n\n'), 'fr');
}

/** What goes in the post for this run, or '' for none. */
export function recipePostText(runId: number | null | undefined, mode: RecipeInPost): string {
  if (mode === 'none') return '';
  const recipe = recipeOfRun(runId);
  return recipe ? formatRecipe(recipe, mode) : '';
}

/**
 * The words of a Facebook reel post and, separately, its first comment.
 *
 * The caption always leads. The recipe follows it when asked and available.
 * The link is one of three things the setting chooses between, never two: in
 * the text, or in the first comment, or nowhere.
 */
export function facebookPost(input: {
  body: string;
  recipe: string;
  postUrl: string | null | undefined;
  link: FacebookLinkMode;
  /** The comment trigger word; with link 'keyword' the post invites it and the link arrives by private message. */
  keyword?: string;
}): { text: string; firstComment?: string } {
  const url = (input.postUrl ?? '').trim();
  const line = url ? `Full recipe: ${url}` : '';
  const recipe = input.recipe.trim();
  // With a recipe the hashtags close the post, under it, not between the words and the recipe.
  const { body, tags } = recipe ? splitHashtags(input.body) : { body: input.body.trim(), tags: '' };
  const word = (input.keyword ?? '').trim();
  const invite = input.link === 'keyword' && word && url ? `Comment "${word.toUpperCase()}" and we'll message you the full recipe link!` : '';
  const parts = [body, recipe, input.link === 'text' ? line : '', invite, tags].filter(Boolean);

  return {
    text: parts.join('\n\n'),
    ...(input.link === 'comment' && line ? { firstComment: line } : {}),
  };
}

/**
 * The recipe texts a network can carry, best first: the whole recipe, then the
 * ingredients alone. A caption that does not fit with the first tries the next,
 * and finally none -- a recipe is never cut off half way through a step.
 */
export function recipeCandidates(runId: number | null | undefined, mode: RecipeInPost): string[] {
  if (mode === 'none') return [];
  const recipe = recipeOfRun(runId);
  if (!recipe) return [];
  const full = mode === 'full' ? formatRecipe(recipe, 'full') : '';
  const ingredients = formatRecipe(recipe, 'ingredients');
  return [full, ingredients].filter((item, i, all) => item && all.indexOf(item) === i);
}

/** A caption whose last line is only hashtags, split from the words above it. */
export function splitHashtags(caption: string): { body: string; tags: string } {
  const lines = caption.trim().split(/\r?\n/);
  const last = (lines[lines.length - 1] ?? '').trim();
  if (lines.length > 1 && /^(#[^\s#]+\s*)+$/.test(last)) {
    return { body: lines.slice(0, -1).join('\n').trim(), tags: last };
  }
  return { body: caption.trim(), tags: '' };
}

/**
 * A caption with a recipe under it and the link lines after, inside a limit.
 *
 * With a recipe the hashtags move below it, since a recipe cut between the
 * words and their tags reads badly; without one nothing moves. When the
 * whole does not fit, the next smaller recipe is tried, then none.
 */
export function composeWithRecipe(input: {
  body: string;
  recipes: readonly string[];
  tail: readonly string[];
  limit: number;
}): string {
  const tail = input.tail.map((part) => part.trim()).filter(Boolean);
  const plain = [input.body.trim(), ...tail].filter(Boolean).join('\n\n');
  const { body, tags } = splitHashtags(input.body);
  for (const recipe of input.recipes) {
    if (!recipe.trim()) continue;
    const text = [body, recipe.trim(), ...tail, tags].filter(Boolean).join('\n\n');
    if (text.length <= input.limit) return text;
  }
  return plain.slice(0, input.limit);
}
