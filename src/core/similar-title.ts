/**
 * Catch an article that is a near-duplicate of one this site already has.
 *
 * A keyword can legitimately run on several sites, and two runs of the same
 * keyword on the *same* site — after a re-import, or after a link was set back
 * to go by hand — produce two articles about the same dish with almost the
 * same title. That is the case worth catching: it splits the site's own
 * ranking between two pages and reads as thin content.
 *
 * Deliberately not exact string equality. "Easy Baked Chicken Breast" and
 * "Baked Chicken Breast (Easy!)" are the same article, and exact matching
 * catches neither.
 *
 * Pure, so the threshold can be argued with in a test rather than in
 * production.
 */

/** Words too common to carry any signal in a recipe title. */
const NOISE = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'to',
  'best', 'easy', 'quick', 'simple', 'perfect', 'ultimate', 'homemade',
  'recipe', 'recipes', 'how', 'make', 'making', 'your', 'my',
]);

/** Title reduced to the words that actually name the dish. */
export function significantWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !NOISE.has(word));
}

/**
 * How much two titles overlap, from 0 to 1.
 *
 * Jaccard over the significant words: shared words divided by the total
 * distinct words. Symmetric, and it does not reward a long title for
 * containing a short one by accident.
 */
export function titleSimilarity(a: string, b: string): number {
  const left = new Set(significantWords(a));
  const right = new Set(significantWords(b));

  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;

  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Where "too similar" starts.
 *
 * 0.7 means roughly "the same nouns in a different order". Measured against
 * the pairs in the tests: it catches rewordings of one dish and leaves
 * genuinely different dishes that share a main ingredient alone.
 */
export const SIMILARITY_THRESHOLD = 0.7;

export interface DuplicateMatch {
  title: string;
  url: string | null;
  similarity: number;
}

/** The closest existing title, when it is close enough to be a problem. */
export function findDuplicate(
  candidate: string,
  existing: { title: string; url: string | null }[],
  threshold = SIMILARITY_THRESHOLD,
): DuplicateMatch | null {
  let best: DuplicateMatch | null = null;

  for (const other of existing) {
    if (!other.title.trim()) continue;

    const similarity = titleSimilarity(candidate, other.title);
    if (similarity < threshold) continue;
    if (best && similarity <= best.similarity) continue;

    best = { title: other.title, url: other.url, similarity };
  }

  return best;
}

/* -- Same dish? ------------------------------------------------------------ */

/**
 * Words that name the same kind of dish, folded to one: "Apple Crumble",
 * "Apple Crisp" and "Apple Cobbler" are one article to a reader and to Google,
 * as are "Lemon Bars" and "Lemon Squares". Applied after plurals are folded.
 */
const DISH_FAMILY: Record<string, string> = {
  crumble: 'crisp',
  cobbler: 'crisp',
  square: 'bar',
  slice: 'bar',
};

/** Words of a title with plurals folded, so "cheesecakes" meets "cheesecake". */
export function dishWords(title: string): Set<string> {
  return new Set(
    significantWords(title).map((word) => {
      let w = word;
      if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`; // berries -> berry, cookies -> cooky
      if (w.length > 3 && w.endsWith('ie')) return `${w.slice(0, -2)}y`; // cookie -> cooky
      if (w.length > 4 && /(ch|sh|ss|x|o)es$/.test(w)) w = w.slice(0, -2); // dishes, potatoes
      else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
      return DISH_FAMILY[w] ?? w;
    }),
  );
}

export interface Dish {
  words: Set<string>;
  /** The words before any subtitle: "Lemon Bars" in "Lemon Bars: Easy Shortbread Crust". */
  main: Set<string>;
  /** The dish's head noun: the last word before any subtitle ("Pudding" in "Biscoff Banana Pudding: No-Bake…"). */
  head: string;
}

export function dishOf(title: string): Dish {
  const main = title.split(/\s[:\-–—|(]|:|\(/)[0] ?? title;
  const mainWords = [...dishWords(main)];
  return { words: dishWords(title), main: dishWords(main), head: mainWords[mainWords.length - 1] ?? '' };
}

/**
 * Two titles name the same dish.
 *
 * Either they share most of their words (Jaccard >= SIMILARITY_THRESHOLD), or
 * every word of the shorter one -- when it has at least three -- is in the
 * longer and both end on the same dish: "Biscoff Banana Pudding" is the same
 * as "Biscoff Banana Pudding: No-Bake Layered Dessert", while "Chocolate Chip
 * Cookies" is not "Chocolate Chip Cookie Cheesecake Bars".
 */
export function sameDishOf(a: Dish, b: Dish): boolean {
  if (a.words.size === 0 || b.words.size === 0) return false;
  let shared = 0;
  for (const w of a.words) if (b.words.has(w)) shared += 1;
  const jaccard = shared / (a.words.size + b.words.size - shared);
  if (jaccard >= SIMILARITY_THRESHOLD) return true;
  // A short dish name (two words) is the same dish when the other title is that
  // name plus a subtitle: "Lemon Bars" = "Lemon Bars: Easy Shortbread Crust".
  // Not when it is merely contained ("Cheesecake Bars" in "Chocolate Chip
  // Cookie Cheesecake Bars"): that is a different dish.
  const [small, large] = a.words.size <= b.words.size ? [a, b] : [b, a];
  if (small.words.size >= 2 && small.words.size === large.main.size && [...small.words].every((w) => large.main.has(w))) {
    return true;
  }
  const shorter = Math.min(a.words.size, b.words.size);
  return shorter >= 3 && shared === shorter && a.head !== '' && a.head === b.head;
}

export const sameDish = (a: string, b: string): boolean => sameDishOf(dishOf(a), dishOf(b));

/**
 * A growing list of titles to test new ones against, fast enough for a
 * 4,000-line import: candidates are only the titles sharing a word.
 */
export class DishIndex {
  private readonly titles: { title: string; dish: Dish }[] = [];
  private readonly byWord = new Map<string, number[]>();

  constructor(titles: string[] = []) {
    for (const t of titles) this.add(t);
  }

  add(title: string): void {
    const dish = dishOf(title);
    if (dish.words.size === 0) return;
    const index = this.titles.push({ title, dish }) - 1;
    for (const w of dish.words) {
      const list = this.byWord.get(w);
      if (list) list.push(index);
      else this.byWord.set(w, [index]);
    }
  }

  /** The first stored title naming the same dish; an exact (case-insensitive) match is skipped when asked. */
  find(title: string, ignoreExact = false): string | null {
    const dish = dishOf(title);
    const seen = new Set<number>();
    for (const w of dish.words) {
      for (const i of this.byWord.get(w) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const other = this.titles[i]!;
        if (ignoreExact && other.title.trim().toLowerCase() === title.trim().toLowerCase()) continue;
        if (sameDishOf(dish, other.dish)) return other.title;
      }
    }
    return null;
  }
}

/* -- Same question? ---------------------------------------------------------- */

/** Words a question is built from that say nothing about what it asks. */
const QUESTION_NOISE = new Set([
  'can', 'you', 'does', 'did', 'what', 'why', 'when', 'which', 'who', 'where', 'are', 'should',
  'would', 'could', 'will', 'its', 'it', 'there', 'this', 'that', 'these', 'those', 'much', 'many',
  'need', 'use', 'using', 'get', 'good', 'way', 'ways', 'tip', 'tips', 'really', 'actually', 'about',
]);

export function questionWords(text: string): Set<string> {
  return new Set([...dishWords(text)].filter((w) => !QUESTION_NOISE.has(w)));
}

/**
 * Two blog titles or People-Also-Ask questions ask the same thing:
 * most words shared, or every word of the shorter one (three or more) in the
 * longer -- "Can you freeze cheesecake?" and "Can You Freeze Cheesecake? Yes,
 * Here Is How" are one article.
 */
export function sameQuestionWords(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  if (shared / (a.size + b.size - shared) >= SIMILARITY_THRESHOLD) return true;
  const shorter = Math.min(a.size, b.size);
  return shorter >= 2 && shared === shorter && shared / Math.max(a.size, b.size) >= 0.4;
}

export const sameQuestion = (a: string, b: string): boolean => sameQuestionWords(questionWords(a), questionWords(b));

/** DishIndex's twin for questions and blog titles. */
export class QuestionIndex {
  private readonly items: { text: string; words: Set<string> }[] = [];
  private readonly byWord = new Map<string, number[]>();

  constructor(texts: string[] = []) {
    for (const t of texts) this.add(t);
  }

  add(text: string): void {
    const words = questionWords(text);
    if (words.size === 0) return;
    const index = this.items.push({ text, words }) - 1;
    for (const w of words) {
      const list = this.byWord.get(w);
      if (list) list.push(index);
      else this.byWord.set(w, [index]);
    }
  }

  find(text: string, ignoreExact = false): string | null {
    const words = questionWords(text);
    const seen = new Set<number>();
    for (const w of words) {
      for (const i of this.byWord.get(w) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const other = this.items[i]!;
        if (ignoreExact && other.text.trim().toLowerCase() === text.trim().toLowerCase()) continue;
        if (sameQuestionWords(words, other.words)) return other.text;
      }
    }
    return null;
  }
}
