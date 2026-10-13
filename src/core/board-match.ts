import { dishWords } from './similar-title.js';

/**
 * Is a suggested board name really a board the account already has?
 * "Easy Dessert Recipes" and "Desserts" are the same board; "Chicken Dinner
 * Recipes" and "Chicken Dinners" too. Filler words are ignored, plurals folded.
 */
const FILLER = new Set([
  'recipe', 'easy', 'best', 'idea', 'simple', 'quick', 'homemade', 'delicious', 'favorite', 'favourite',
  'yummy', 'tasty', 'everyday', 'all', 'our', 'my', 'good', 'great', 'top', 'food', 'dish', 'and', 'the', 'for', 'with', 'of', 'to', 'a',
]);

export function boardWords(name: string): Set<string> {
  return new Set([...dishWords(name.replace(/&/g, ' '))].filter((w) => !FILLER.has(w)));
}

export function sameBoard(a: string, b: string): boolean {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  const x = boardWords(a);
  const y = boardWords(b);
  if (x.size === 0 || y.size === 0) return x.size === y.size; // "Easy Recipes" and "Best Recipes": both general
  const shared = [...x].filter((w) => y.has(w)).length;
  if (shared === x.size && shared === y.size) return true;
  if (shared / (x.size + y.size - shared) >= 0.67) return true;
  // One is the other plus a single word: "Chicken Dinners" / "Chicken Dinner Recipes Ideas".
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return shared === small.size && small.size >= 2 && big.size - small.size <= 1;
}

/** The existing board a name stands for, if any. */
export const findBoard = (name: string, existing: string[]): string | undefined =>
  existing.find((e) => e.trim().toLowerCase() === name.trim().toLowerCase()) ?? existing.find((e) => sameBoard(name, e));
