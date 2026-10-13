import { DishIndex, QuestionIndex } from '../core/similar-title.js';
import { halalOnly, isHaram } from '../core/halal.js';
import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('keyword-research');

/**
 * Keyword research from what people actually type into Google.
 *
 *   Autocomplete   free, no key: the seed, then the seed + a..z and a few
 *                  question starters. Every suggestion is a real search.
 *   Serper.dev     optional key: "People also ask" and "Related searches"
 *                  for the seed.
 *
 * Suggestions are split into recipe keywords (for Keywords) and questions
 * (for Blog), cleaned of shopping and place searches, and marked when they
 * are the same dish as a keyword the platform already has.
 */

export type ResearchSource = 'autocomplete' | 'related' | 'people-also-ask';

export interface ResearchItem {
  text: string;
  source: ResearchSource;
  /** Autocomplete position of the first appearance: lower = searched more. */
  rank: number;
  /** In Google's own suggestions for the bare topic: its most searched forms. */
  top?: boolean;
  /** "banana dessert recipes": a list of dishes, not one dish. */
  broad: boolean;
  /** Same dish as an existing keyword (its title), when one is found. */
  existing?: string;
}

export interface ResearchResult {
  seed: string;
  recipes: ResearchItem[];
  questions: ResearchItem[];
  /** Short notes: sources that failed, a missing key. */
  notes: string[];
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const QUESTION_STARTS = ['comment faire', 'comment préparer', 'combien de temps', 'peut-on', 'est-ce que', 'pourquoi', 'comment conserver', 'quelle'];

/** Searches that are not a recipe or a cooking question. */
const OFF_TOPIC =
  /(?<![\p{L}])(near me|delivery|restaurant|restaurants|menu|price|prices|cost|store|stores|walmart|costco|target|aldi|kroger|trader joe'?s?|mcdonald'?s?|starbucks|coupon|png|clipart|clip art|drawing|meme|svg|tattoo|wallpaper|shirt|lyrics|movie|game|logo|jobs?|reddit|youtube|tiktok|instagram|calories in|nutrition facts|près de chez moi|pres de chez moi|livraison|restaurants?|prix|coût|cout|magasin|carrefour|leclerc|auchan|lidl|intermarché|intermarche|monoprix|picard|thiriet|mcdo|quick|burger king|bon de réduction|code promo|dessin|coloriage|paroles|film|jeu|emploi|offre d'emploi|calories dans|valeurs nutritionnelles|marmiton|cyril lignac|philippe etchebest)(?![\p{L}])/iu;

const QUESTION = /^(how|what|why|when|where|which|who|can|could|is|are|do|does|did|should|will|would|comment|pourquoi|quand|où|ou est|quel|quelle|quels|quelles|qui|que|quoi|combien|peut-on|puis-je|peut on|est-ce|est ce|faut-il|faut il|doit-on|doit on|sert-on|se conserve|se congèle)(?![\p{L}])/iu;

/** Words that make a keyword a list of dishes rather than one. */
const BROAD = /(?<![\p{L}])(recipes|ideas|dishes|meals|options|list|types|kinds|varieties|recettes|idées|idees|plats|repas|liste|types|sortes|variétés|varietes|façons|facons)(?![\p{L}])/iu;

/** "How do you make banana pudding cookies?" -> "banana pudding cookies"; null for other questions. */
export function howToMakeDish(question: string): string | null {
  const q = question.trim();
  const m = /^how (?:to|do you|do i|can i|can you) (?:make|bake|cook|prepare) (?:a |an |the )?(.+?)\??$/i.exec(q)
    ?? /^comment (?:faire|préparer|cuisiner|cuire|réaliser|réussir|faire cuire) (?:des |du |de la |de l'|d'|un |une |le |la |les |l')?(.+?)\s?\??$/iu.exec(q);
  if (!m) return null;
  const dish = m[1]!.trim();
  // "... from scratch", "... with vanilla wafers": a way of making the dish, still a question worth a post.
  return /(?<![\p{L}])(from scratch|with|without|in|at home|using|ahead|the day|the night|maison|avec|sans|à l'avance|a l'avance|la veille)(?![\p{L}])/iu.test(dish) ? null : dish;
}

export const isQuestion = (text: string): boolean => QUESTION.test(text.trim()) || text.trim().endsWith('?');

const withTimeout: typeof fetch = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) });

/** One Google Autocomplete call: the suggestions, in Google's order. */
export async function autocomplete(query: string, fetchImpl: typeof fetch = withTimeout): Promise<string[]> {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=fr&gl=fr&ie=utf-8&oe=utf-8&q=${encodeURIComponent(query)}`;
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Autocomplete HTTP ${response.status}`);
  const body = (await response.json()) as [string, string[]];
  return Array.isArray(body?.[1]) ? body[1].map(String) : [];
}

export interface SerperAnswer {
  questions: string[];
  related: string[];
  organic: { title: string; url: string; snippet: string }[];
}

/** People also ask, related searches and the organic results for one query, through Serper.dev. */
export async function serperSearch(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch = withTimeout,
): Promise<SerperAnswer> {
  const response = await fetchImpl('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, gl: 'fr', hl: 'fr' }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Serper HTTP ${response.status}${text ? ` — ${text.slice(0, 160)}` : ''}`);
  }
  const body = (await response.json()) as {
    peopleAlsoAsk?: { question?: string }[];
    relatedSearches?: { query?: string }[];
    organic?: { title?: string; link?: string; snippet?: string }[];
  };
  return {
    questions: (body.peopleAlsoAsk ?? []).map((q) => String(q.question ?? '')).filter(Boolean),
    related: (body.relatedSearches ?? []).map((r) => String(r.query ?? '')).filter(Boolean),
    organic: (body.organic ?? [])
      .filter((o) => o.link)
      .map((o) => ({ title: String(o.title ?? ''), url: String(o.link), snippet: String(o.snippet ?? '') })),
  };
}

export const serperKeys = (raw: string | undefined): string[] =>
  (raw ?? '').split(/[\s,;]+/).map((k) => k.trim()).filter(Boolean);

/** A refusal that means "this key is spent or not allowed", not "Google has nothing". */
const KEY_SPENT = /HTTP (400|401|402|403|429)|credit|quota|limit|not enough|unauthori[sz]ed|invalid api key/i;

/**
 * Serper with several keys: start from the key in use, and when it is spent
 * move to the next and remember it, so the next search goes on from there
 * rather than trying the empty first key again.
 */
export async function serperRotating(
  query: string,
  options: ResearchOptions,
  fetchImpl: typeof fetch = withTimeout,
): Promise<SerperAnswer> {
  const keys = serperKeys(options.serperKey);
  if (keys.length === 0) throw new Error('no Serper key');
  const start = Math.max(0, options.serperState?.get() ?? 0) % keys.length;
  let lastError: unknown;
  for (let step = 0; step < keys.length; step++) {
    const index = (start + step) % keys.length;
    try {
      const out = await serperSearch(query, keys[index]!, fetchImpl);
      if (index !== start) {
        options.serperState?.set(index);
        log.info(`Serper: key ${start + 1} spent, now using key ${index + 1} of ${keys.length}`);
      }
      return out;
    } catch (err) {
      lastError = err;
      if (!KEY_SPENT.test(errorMessage(err))) throw err;
    }
  }
  throw new Error(`all ${keys.length} Serper key(s) are spent or refused — last: ${errorMessage(lastError)}`);
}

/** Run tasks a few at a time: Google answers a burst with a block. */
async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]!);
      }
    }),
  );
  return out;
}

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

export interface ResearchOptions {
  /** One or more Serper keys, separated by commas, spaces or new lines. */
  serperKey?: string;
  /** Where the key in use is remembered, so the next search goes on from it. */
  serperState?: { get(): number; set(index: number): void };
  /** Titles of the keywords already on the platform, to mark repeats. */
  existingTitles?: string[];
  fetchImpl?: typeof fetch;
}

export async function researchKeywords(seedInput: string, options: ResearchOptions = {}): Promise<ResearchResult> {
  const seed = clean(seedInput).toLowerCase();
  const notes: string[] = [];
  const fetchImpl = options.fetchImpl ?? withTimeout;
  const seen = new Map<string, ResearchItem>();
  const halal = halalOnly();

  const add = (raw: string, source: ResearchSource, rank: number) => {
    const text = clean(raw);
    const key = text.toLowerCase().replace(/[?.!]+$/, '');
    if (text.length < 4 || key === seed || OFF_TOPIC.test(text)) return;
    if (halal && isHaram(text)) return;
    const found = seen.get(key);
    if (found) {
      found.rank = Math.min(found.rank, rank);
      return;
    }
    seen.set(key, { text, source, rank, broad: !isQuestion(text) && BROAD.test(text) });
  };

  // Autocomplete: the seed, the seed + each letter, and question starters.
  const queries = [seed, ...LETTERS.map((l) => `${seed} ${l}`), ...QUESTION_STARTS.map((q) => `${q} ${seed}`)];
  let failures = 0;
  const lists = await pool(queries, 5, async (q) => {
    try {
      return await autocomplete(q, fetchImpl);
    } catch (err) {
      failures++;
      log.warn(`autocomplete "${q}": ${errorMessage(err)}`);
      return [] as string[];
    }
  });
  lists.forEach((list) => list.forEach((s, i) => add(s, 'autocomplete', i)));
  for (const s of lists[0] ?? []) {
    const item = seen.get(clean(s).toLowerCase().replace(/[?.!]+$/, ''));
    if (item) item.top = true;
  }
  if (failures === queries.length) notes.push('Google Autocomplete did not answer. Try again in a few minutes.');
  else if (failures > 0) notes.push(`${failures} of ${queries.length} Autocomplete calls failed; the list may be shorter.`);

  // Serper: what Google shows under the results.
  if (options.serperKey?.trim()) {
    try {
      const serp = await serperRotating(seed, options, fetchImpl);
      serp.questions.forEach((q, i) => add(q, 'people-also-ask', i));
      serp.related.forEach((r, i) => add(r, 'related', i));
    } catch (err) {
      notes.push(`Serper: ${errorMessage(err)}`);
    }
  } else {
    notes.push('No Serper key: "People also ask" and related searches are left out. Add one under Setup → General.');
  }

  // Mark the ones that are a dish the platform already has.
  const dishes = new DishIndex(options.existingTitles ?? []);
  const exact = new Set((options.existingTitles ?? []).map((t) => t.trim().toLowerCase()));
  const items = [...seen.values()];
  for (const item of items) {
    if (isQuestion(item.text)) continue;
    if (exact.has(item.text.toLowerCase())) item.existing = item.text;
    else {
      const twin = dishes.find(item.text);
      if (twin) item.existing = twin;
    }
  }

  // Best first: what Google suggests for the bare topic, then by position in
  // the suggestion lists.
  const bySearch = (a: ResearchItem, b: ResearchItem) =>
    Number(Boolean(b.top)) - Number(Boolean(a.top)) || a.rank - b.rank || a.text.localeCompare(b.text);
  // "easy banana pudding" and "banana pudding easy" are one keyword: keep the
  // one Google ranks higher.
  const mine = new DishIndex();
  const recipes = items
    .filter((i) => !isQuestion(i.text))
    .sort(bySearch)
    .filter((i) => {
      if (mine.find(i.text)) return false;
      mine.add(i.text);
      return true;
    });
  // "How to make banana pudding?" and "How do you make banana pudding?" are
  // one blog post: keep the one Google ranks higher.
  const asked = new QuestionIndex([]);
  const questionItems = items
    .filter((i) => isQuestion(i.text))
    .sort(bySearch)
    .filter((i) => {
      if (asked.find(i.text, false)) return false;
      asked.add(i.text);
      return true;
    });
  return {
    seed,
    recipes,
    questions: questionItems
      .map((i) => ({ ...i, text: /\?$/.test(i.text) ? i.text : `${i.text[0]!.toUpperCase()}${i.text.slice(1)}?` }))
      .sort(bySearch),
    notes,
  };
}

/** "banana pudding cups" -> "Banana Pudding Cups" for the keyword list. */
export const titleCase = (text: string): string =>
  text
    .split(' ')
    .map((w, i) =>
      i > 0 && /^(and|or|with|in|on|of|for|the|a|an|to)$/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(' ');

/**
 * Let the model drop what is not a dish or a cooking question: restaurants
 * and brands named after the food ("pasta house"), tools, and words that are
 * not food at all in that search ("can you pasta a tooth"). It may also move
 * an item between recipes and questions. Returns the result unchanged when
 * the model gives nothing usable -- a filter must never empty the page.
 */
export async function filterWithModel(
  result: ResearchResult,
  ask: (vars: { seed: string; items: string }) => Promise<string>,
): Promise<ResearchResult> {
  const all = [...result.recipes, ...result.questions];
  if (all.length === 0) return result;
  let answer = '';
  try {
    answer = await ask({ seed: result.seed, items: all.map((i, n) => `${n + 1}. ${i.text}`).join('\n') });
  } catch (err) {
    return { ...result, notes: [...result.notes, `AI clean-up skipped: ${errorMessage(err)}`] };
  }
  let keep: { n?: unknown; type?: unknown }[] = [];
  try {
    const match = answer.match(/\{[\s\S]*\}/);
    keep = (JSON.parse(match ? match[0] : answer) as { keep?: typeof keep }).keep ?? [];
  } catch {
    keep = [];
  }
  const recipes: ResearchItem[] = [];
  const questions: ResearchItem[] = [];
  for (const k of keep) {
    const item = all[Number(k.n) - 1];
    if (!item) continue;
    // Only searches already asked as a question: "dessert using cream cheese?"
    // is an idea search with a question mark stuck on, not a question.
    if (k.type === 'question') {
      if (QUESTION.test(item.text.trim())) questions.push(item);
    }
    else if (k.type === 'recipe' && !isQuestion(item.text)) recipes.push(item);
  }
  // "How to make banana pudding cheesecake?" is the recipe for banana pudding
  // cheesecake: as a blog post it would compete with that recipe on Google.
  const dishes = new DishIndex(result.recipes.map((r) => r.text));
  for (let i = questions.length - 1; i >= 0; i--) {
    const dish = howToMakeDish(questions[i]!.text);
    if (dish && dishes.find(dish)) questions.splice(i, 1);
  }
  if (recipes.length + questions.length === 0) {
    return { ...result, notes: [...result.notes, 'AI clean-up gave nothing usable; showing everything.'] };
  }
  const dropped = all.length - recipes.length - questions.length;
  const order = (a: ResearchItem, b: ResearchItem) => all.indexOf(a) - all.indexOf(b);
  return {
    ...result,
    recipes: recipes.sort(order),
    questions: questions.sort(order),
    notes: dropped > 0 ? [...result.notes, `AI clean-up removed ${dropped} search(es) that are not a dish or a cooking question.`] : result.notes,
  };
}

export interface TopicIdea {
  topic: string;
  why: string;
  /** The site category the topic belongs under, when the model was shown the site's categories. */
  category?: string;
}

export interface TopicIdeas {
  niche: string;
  topics: TopicIdea[];
  seasonal: TopicIdea[];
  notes: string[];
}

/**
 * What people search around a whole niche ("dessert"), as raw material for
 * the model to name specific topics from: Google's suggestions for the niche
 * and the niche + each letter, plus related searches when Serper is set.
 */
export async function topicCandidates(nicheInput: string, options: ResearchOptions = {}): Promise<{ candidates: string[]; notes: string[] }> {
  const niche = clean(nicheInput).toLowerCase();
  const fetchImpl = options.fetchImpl ?? withTimeout;
  const notes: string[] = [];
  const queries = [niche, ...LETTERS.map((l) => `${niche} ${l}`), ...LETTERS.map((l) => `${l} ${niche}`).slice(0, 12)];
  let failures = 0;
  const lists = await pool(queries, 5, async (q) => {
    try {
      return await autocomplete(q, fetchImpl);
    } catch {
      failures++;
      return [] as string[];
    }
  });
  if (failures === queries.length) notes.push('Google Autocomplete did not answer. Try again in a few minutes.');
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (raw: string) => {
    const text = clean(raw).toLowerCase();
    if (text.length < 4 || text === niche || OFF_TOPIC.test(text) || seen.has(text)) return;
    if (halalOnly() && isHaram(text)) return;
    seen.add(text);
    candidates.push(text);
  };
  lists.forEach((list) => list.forEach(push));
  if (options.serperKey?.trim()) {
    try {
      (await serperRotating(`${niche} recipes`, options, fetchImpl)).related.forEach(push);
    } catch (err) {
      notes.push(`Serper: ${errorMessage(err)}`);
    }
  }
  return { candidates: candidates.slice(0, 300), notes };
}

/** The model's answer to research-topics, read defensively. */
export function parseTopicIdeas(niche: string, answer: string, notes: string[]): TopicIdeas {
  let body: { topics?: unknown; seasonal?: unknown } = {};
  try {
    const match = answer.match(/\{[\s\S]*\}/);
    body = JSON.parse(match ? match[0] : answer);
  } catch {
    notes = [...notes, 'The AI gave no usable topics. Try again.'];
  }
  const read = (list: unknown): TopicIdea[] =>
    (Array.isArray(list) ? list : [])
      .map((t) => {
        const category = clean(String((t as TopicIdea)?.category ?? ''));
        return {
          topic: clean(String((t as TopicIdea)?.topic ?? '')).toLowerCase(),
          why: clean(String((t as TopicIdea)?.why ?? '')),
          ...(category ? { category } : {}),
        };
      })
      .filter((t) => t.topic.length >= 3 && t.topic.length <= 60)
      .filter((t) => !(halalOnly() && isHaram(t.topic)));
  return { niche: clean(niche).toLowerCase(), topics: read(body.topics).slice(0, 40), seasonal: read(body.seasonal).slice(0, 10), notes };
}

/**
 * The model names topics; Google confirms them. Each topic is looked up in
 * Autocomplete: a topic people search has a full list of suggestions that
 * repeat its words. Weak ones are dropped, the rest ranked by how much
 * Google suggests, and the "why" shows what Google suggested.
 */
export async function verifyTopics(ideas: TopicIdeas, fetchImpl: typeof fetch = withTimeout, keep = 20): Promise<TopicIdeas> {
  const check = async (t: TopicIdea): Promise<{ idea: TopicIdea; score: number } | null> => {
    let list: string[] = [];
    try {
      list = await autocomplete(t.topic, fetchImpl);
    } catch {
      return { idea: t, score: -1 }; // Google silent: keep it, unranked
    }
    const words = t.topic.split(' ').filter((w) => w.length > 2);
    const good = list.filter((s) => !OFF_TOPIC.test(s) && words.every((w) => s.toLowerCase().includes(w.replace(/s$/, ''))));
    if (good.length < 3) return null;
    return { idea: { ...t, why: `Google suggests: ${good.slice(0, 3).join(', ')}` }, score: good.length };
  };
  const run = async (list: TopicIdea[]) =>
    (await pool(list, 5, check)).filter((x): x is { idea: TopicIdea; score: number } => x !== null);

  const topics = (await run(ideas.topics)).sort((a, b) => b.score - a.score).slice(0, keep).map((x) => x.idea);
  const seasonal = (await run(ideas.seasonal)).map((x) => x.idea);
  return { ...ideas, topics, seasonal };
}

