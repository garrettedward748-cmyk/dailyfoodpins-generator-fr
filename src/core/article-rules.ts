import { fixProperNouns, fixProperNounsInHtml } from './proper-nouns.js';
import {
  allowedMinutes, canonicalTimes, timeProblems, type RecipeTimes,
} from './recipe-times.js';
import {
  applySpelling, applySpellingToHtml, ingredientUnitProblems, measureProblems,
  temperatureProblems, type WritingStyle,
} from './writing-style.js';

/**
 * What an article part has to satisfy before it is accepted.
 *
 * The prompts have always said all of this. A prompt is obeyed most of the
 * time, and "most" is how a site ends up with a title past its own length
 * limit, a total time that disagrees with the card beside it, and a Celsius
 * oven temperature on an American site. So each rule is split in two:
 *
 *  - what has exactly one right answer is FIXED here, in code: the spelling,
 *    the capital on a proper noun, the three minute fields of the card;
 *  - what needs a judgement is CHECKED here, and a draft that fails is sent
 *    back to the model with the rule it broke named, once, then to the simpler
 *    prompt, then the run stops. A run that stops can be resumed; an article
 *    that goes live wrong cannot be taken back from Google.
 */

export type PartName = 'part-1' | 'part-2' | 'part-3';

/** What a part is checked against. Built once per article. */
export interface RuleContext {
  style: WritingStyle;
  times: RecipeTimes | null;
  /** Every time the recipe itself mentions, in minutes. */
  sourceMinutes: Set<number>;
}

/** Everything the rules need to know about the recipe, from the recipe. */
export function ruleContextFor(
  style: WritingStyle,
  recipe: { raw: string; parsed: Record<string, unknown> },
): RuleContext {
  const times = canonicalTimes(recipe.parsed);
  return { style, times, sourceMinutes: allowedMinutes(recipe.raw, times) };
}

export interface CheckedPart {
  data: Record<string, unknown>;
  /** Plain-English problems, one per line, written for the model that has to fix them. */
  problems: string[];
}

/* -------------------------------------------------------------------------
 * Words and openings no article on any site may use
 * ---------------------------------------------------------------------- */

/**
 * Phrases that make a page read as machine-written, or that the prompts forbid
 * outright. Matched as whole words, case-insensitively.
 *
 * Kept short on purpose: every entry is a retry when it fires, so a word that
 * is merely overused does not belong here. These are the ones the prompts
 * already name, plus the handful that mark a page as generated.
 */
export const BANNED_PHRASES: readonly string[] = [
  'delicious', 'mouthwatering', 'mouth-watering', 'game-changer', 'game changer',
  'elevate', 'delve', 'tapestry', 'testament to', 'symphony of', 'nestled',
  'in today\'s world', 'look no further', 'trust me', 'you\'ll love', 'you will love',
  'honestly', 'oops', 'dang', 'i mean',
];

/**
 * Ways to begin that read as filler.
 *
 * Checked against the first sentence only. "You must decide between…" is the
 * one that shipped: a shape that asks the introduction to open on a choice
 * produced a sentence that announces a choice instead of naming one.
 */
export const BANNED_OPENINGS: readonly string[] = [
  'you must decide', 'you need to decide', 'you have to decide', 'you must choose',
  'when it comes to', 'whether you', 'if you are looking for', 'if you\'re looking for',
  'are you looking', 'welcome to', 'in this recipe', 'in this article', 'this recipe is',
  'there is nothing quite like', 'there\'s nothing quite like',
];

/**
 * The French lists. The same two jobs: what marks a page as machine-written or
 * as marketing, and the openings that are filler. Matched on straightened,
 * lower-cased text, so accents must be written as French writes them.
 */
export const BANNED_PHRASES_FR: readonly string[] = [
  'délicieux', 'délicieuse', 'délicieuses', 'délicieusement', 'succulent', 'succulente',
  'succulents', 'succulentes', 'alléchant', 'alléchante', 'à se damner', 'à tomber par terre',
  'symphonie de saveurs', 'explosion de saveurs', 'festival de saveurs', 'voyage gustatif',
  'révolutionnaire', 'incroyable', 'inratable', 'ne cherchez plus', 'dans le monde d\'aujourd\'hui',
  'vous allez adorer', 'vous allez en raison', 'faites-moi confiance', 'croyez-moi',
  'franchement', 'oups', 'je veux dire',
];

export const BANNED_OPENINGS_FR: readonly string[] = [
  'vous devez décider', 'vous devez choisir', 'vous devez trancher', 'vous avez le choix',
  'quand il s\'agit de', 'lorsqu\'il s\'agit de', 'que vous soyez', 'si vous cherchez',
  'vous cherchez', 'bienvenue', 'dans cette recette', 'dans cet article', 'cette recette est',
  'il n\'y a rien de tel', 'rien de tel que',
];

/** The banned phrases for a site's style: French for "fr", the English list otherwise. */
export function bannedPhrases(style: WritingStyle = 'us'): readonly string[] {
  return style === 'fr' ? BANNED_PHRASES_FR : BANNED_PHRASES;
}

export function bannedOpenings(style: WritingStyle = 'us'): readonly string[] {
  return style === 'fr' ? BANNED_OPENINGS_FR : BANNED_OPENINGS;
}

/** The banned phrases as one list, for a prompt to print. */
export function bannedList(style: WritingStyle = 'us'): string {
  return bannedPhrases(style).map((p) => `"${p}"`).join(', ');
}

/** Markup removed, entities and whitespace tidied: the words a reader sees. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&lsquo;/g, '\'')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Straighten typographic apostrophes so "you’ll" is matched like "you'll". */
function straighten(text: string): string {
  return text.replace(/[‘’]/g, '\'');
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const FIRST_PERSON = /\b(?:I|I'm|I've|I'll|I'd|my|myself)\b/;

/**
 * French narrator: je, j'ai, moi, me, m'a, mon, ma, mes. "nous" is allowed, as
 * "we" is. Letters on either side are checked with \\p{L}, because \\b does not
 * see accents: "ma" inside "maïs" or "mes" inside "mesure" must not match.
 */
const FIRST_PERSON_FR = /(?<![\p{L}\p{N}])(?:j['’]|m['’]|(?:je|moi|mon|ma|mes|me)(?![\p{L}\p{N}'’]))/iu;

/**
 * Problems with the voice of one piece of prose.
 *
 * `reader` marks text that is the READER speaking — a question below the recipe
 * ("Can I use boneless thighs?") — where "I" is correct and the narrator rule
 * does not apply. The answer to it is the site speaking, and is checked in full.
 */
export function proseProblems(
  text: string,
  where: string,
  reader = false,
  style: WritingStyle = 'us',
): string[] {
  const problems: string[] = [];
  const clean = straighten(text);
  const fr = style === 'fr';

  for (const phrase of bannedPhrases(style)) {
    // Letters, digits and hyphens on either side keep "incroyablement" apart
    // from "incroyable"; \\p{L} sees accents where \\w does not.
    if (new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}_-])`, 'iu').test(clean)) {
      problems.push(`${where}: never write "${phrase}"`);
    }
  }
  if (clean.includes('!')) problems.push(`${where}: no exclamation marks`);
  if (EMOJI.test(clean)) problems.push(`${where}: no emoji`);
  if (!reader && (fr ? FIRST_PERSON_FR : FIRST_PERSON).test(clean)) {
    problems.push(
      fr
        ? `${where}: no first person ("je", "j'", "mon", "ma", "mes") — the cook is "vous", and there is no narrator`
        : `${where}: no first person ("I", "my") — the cook is "you", and there is no narrator`,
    );
  }
  return problems;
}

/** The first sentence of a piece of HTML, as plain text. */
export function firstSentence(html: string): string {
  const text = plainText(html);
  const end = text.search(/[.!?](?:\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

/** Does the introduction open with a banned way in? */
export function openingProblems(introHtml: string, style: WritingStyle = 'us'): string[] {
  const opening = straighten(firstSentence(introHtml)).toLowerCase();
  const hit = bannedOpenings(style).find((phrase) => opening.startsWith(phrase) || opening.includes(`. ${phrase}`));
  return hit
    ? [`intro_html: do not open with "${hit}" — start with the dish or the one fact that decides it`]
    : [];
}

/* -------------------------------------------------------------------------
 * Walking an article's text
 * ---------------------------------------------------------------------- */

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Every piece of prose in a part, with where it is, so a problem can say. */
function proseOf(part: PartName, data: Record<string, unknown>): { where: string; text: string; html: boolean }[] {
  const out: { where: string; text: string; html: boolean }[] = [];
  const add = (where: string, value: unknown, html = false): void => {
    const text = str(value);
    if (text.trim() !== '') out.push({ where, text, html });
  };

  if (part === 'part-1') {
    add('headline', data.headline);
    add('meta_desc', data.meta_desc);
    add('intro_html', data.intro_html, true);
  }

  if (part === 'part-2') {
    add('tips_html', data.tips_html, true);
    if (Array.isArray(data.steps)) {
      data.steps.forEach((step, i) => {
        const s = (step ?? {}) as Record<string, unknown>;
        add(`step ${i + 1} heading`, s.heading);
        add(`step ${i + 1}`, s.body);
      });
    }
  }

  if (part === 'part-3') {
    add('notes_html', data.notes_html, true);
    if (Array.isArray(data.faqs)) {
      data.faqs.forEach((faq, i) => {
        const f = (faq ?? {}) as Record<string, unknown>;
        add(`question ${i + 1}`, f.question);
        add(`answer ${i + 1}`, f.answer_html, true);
      });
    }
  }

  return out;
}

/* -------------------------------------------------------------------------
 * Fixing: what has one right answer
 * ---------------------------------------------------------------------- */

const PLAIN_KEYS = ['title', 'headline', 'title_tag', 'meta_desc', 'yield_text', 'servings_unit'];
const HTML_KEYS = ['intro_html', 'tips_html', 'notes_html'];

/**
 * Spelling and capitals, over every text field of a part.
 *
 * `slug` is converted too, as its words: a title that now says "savory" with a
 * slug that still says "savoury" is two spellings of one page. `focus_keyword`
 * is converted for the same reason — the phrase the page targets has to be the
 * phrase the page uses. Image paths and numbers are never touched.
 */
export function fixText(data: Record<string, unknown>, style: WritingStyle): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  const fix = (s: string): string => fixProperNouns(applySpelling(s, style), style);
  const fixHtml = (s: string): string => fixProperNounsInHtml(applySpellingToHtml(s, style), style);

  for (const key of PLAIN_KEYS) if (typeof out[key] === 'string') out[key] = fix(out[key] as string);
  for (const key of HTML_KEYS) if (typeof out[key] === 'string') out[key] = fixHtml(out[key] as string);

  // Lower case by design, so only the spelling is changed, never the capitals.
  if (typeof out.slug === 'string') out.slug = applySpelling(out.slug, style);
  if (typeof out.focus_keyword === 'string') out.focus_keyword = applySpelling(out.focus_keyword, style);

  if (Array.isArray(out.steps)) {
    out.steps = out.steps.map((step) => {
      if (step === null || typeof step !== 'object') return step;
      const s = step as Record<string, unknown>;
      return {
        ...s,
        heading: typeof s.heading === 'string' ? fix(s.heading) : s.heading,
        body: typeof s.body === 'string' ? fix(s.body) : s.body,
      };
    });
  }

  if (Array.isArray(out.faqs)) {
    out.faqs = out.faqs.map((faq) => {
      if (faq === null || typeof faq !== 'object') return faq;
      const f = faq as Record<string, unknown>;
      return {
        ...f,
        question: typeof f.question === 'string' ? fix(f.question) : f.question,
        answer_html: typeof f.answer_html === 'string' ? fixHtml(f.answer_html) : f.answer_html,
      };
    });
  }

  if (Array.isArray(out.ingredients)) {
    out.ingredients = out.ingredients.map((line) => {
      if (line === null || typeof line !== 'object') return line;
      const l = line as Record<string, unknown>;
      return {
        ...l,
        item: typeof l.item === 'string' ? applySpelling(l.item, style) : l.item,
        note: typeof l.note === 'string' ? applySpelling(l.note, style) : l.note,
      };
    });
  }

  if (Array.isArray(out.tags)) {
    out.tags = out.tags.map((tag) => (typeof tag === 'string' ? applySpelling(tag, style) : tag));
  }

  return out;
}

/**
 * The three minute fields of the recipe card, set from the recipe.
 *
 * Whatever the model wrote is replaced, because there is exactly one right
 * answer and it is arithmetic. When the recipe's times cannot be read the
 * model's own are kept and left to the checks below.
 */
export function pinTimes(data: Record<string, unknown>, times: RecipeTimes | null): Record<string, unknown> {
  if (!times) return data;
  return { ...data, prep_minutes: times.prep, cook_minutes: times.cook, rest_minutes: times.rest };
}

/* -------------------------------------------------------------------------
 * Checking: what needs a judgement
 * ---------------------------------------------------------------------- */

const TITLE_MAX = 65;
const TITLE_TAG_MAX = 60;
const META_MIN = 120;
const META_MAX = 160;

function part1Problems(data: Record<string, unknown>, rules: RuleContext): string[] {
  const problems: string[] = [];
  const title = str(data.title).trim();
  const headline = str(data.headline).trim();
  const titleTag = str(data.title_tag).trim();
  const meta = str(data.meta_desc).trim();

  if (title === '') problems.push('title is empty');
  else {
    if (!title.includes(':')) problems.push('title: must be the dish name, a colon, then a plain description');
    if (rules.style === 'fr' ? /(?<![\p{L}])recettes?\s*$/iu.test(title) : /\brecipe\s*$/i.test(title)) {
      problems.push(`title: must not end with the word "${rules.style === 'fr' ? 'Recette' : 'Recipe'}"`);
    }
    if (title.length > TITLE_MAX) {
      problems.push(`title: ${title.length} characters, the limit is ${TITLE_MAX} — shorten the description after the colon`);
    }
  }

  if (headline === '') problems.push('headline is empty');
  else if (headline.includes(':')) problems.push('headline: must not contain a colon');
  else if (/[.!?]$/.test(headline)) problems.push('headline: no full stop at the end');

  if (titleTag === '') problems.push('title_tag is empty');
  else if (titleTag.length > TITLE_TAG_MAX) problems.push(`title_tag: ${titleTag.length} characters, the limit is ${TITLE_TAG_MAX}`);

  if (meta === '') problems.push('meta_desc is empty');
  else if (meta.length < META_MIN || meta.length > META_MAX) {
    problems.push(`meta_desc: ${meta.length} characters, it must be ${META_MIN} to ${META_MAX}`);
  }

  if (str(data.intro_html).trim() === '') problems.push('intro_html is empty');
  else problems.push(...openingProblems(str(data.intro_html), rules.style));

  // Every duration the reader meets before the card has to be one the recipe gave.
  const timed: [string, string][] = [
    ['title', title], ['headline', headline], ['title_tag', titleTag], ['meta_desc', meta],
    ['intro_html', plainText(str(data.intro_html))],
  ];
  for (const [where, text] of timed) {
    for (const p of timeProblems(text, rules.sourceMinutes, where)) problems.push(`${p.where}: ${p.detail}`);
  }

  return problems;
}

function part2Problems(data: Record<string, unknown>, rules: RuleContext): string[] {
  const problems: string[] = [];

  const ingredients = Array.isArray(data.ingredients) ? data.ingredients : [];
  if (ingredients.length < 8 || ingredients.length > 14) {
    problems.push(`ingredients: ${ingredients.length} lines, it must be 8 to 14`);
  }
  ingredients.forEach((line, i) => {
    const l = (line ?? {}) as Record<string, unknown>;
    if (str(l.item).trim() === '') problems.push(`ingredients line ${i + 1}: no item`);
  });

  const steps = Array.isArray(data.steps) ? data.steps : [];
  if (steps.length < 6 || steps.length > 8) problems.push(`steps: ${steps.length} steps, it must be 6 to 8`);
  steps.forEach((step, i) => {
    const s = (step ?? {}) as Record<string, unknown>;
    if (str(s.heading).trim() === '') problems.push(`step ${i + 1}: no heading`);
    if (str(s.body).trim() === '') problems.push(`step ${i + 1}: no body`);
  });

  const difficulty = str(data.difficulty).trim().toLowerCase();
  if (!['easy', 'medium', 'hard'].includes(difficulty)) problems.push('difficulty: must be exactly easy, medium or hard');

  const servings = Number(data.servings);
  if (!Number.isInteger(servings) || servings < 1) problems.push('servings: must be a whole number of 1 or more');

  for (const p of ingredientUnitProblems(ingredients, rules.style)) problems.push(`${p.where}: ${p.detail}`);

  // Times a cook is told while cooking. Only ones the recipe gave.
  const timed = proseOf('part-2', data);
  for (const { where, text, html } of timed) {
    const plain = html ? plainText(text) : text;
    for (const p of timeProblems(plain, rules.sourceMinutes, where)) problems.push(`${p.where}: ${p.detail}`);
  }

  return problems;
}

function part3Problems(data: Record<string, unknown>): string[] {
  const problems: string[] = [];

  if (str(data.notes_html).trim() === '') problems.push('notes_html is empty');
  const faqs = Array.isArray(data.faqs) ? data.faqs : [];
  if (faqs.length === 0) problems.push('faqs: there are none');
  faqs.forEach((faq, i) => {
    const f = (faq ?? {}) as Record<string, unknown>;
    if (str(f.question).trim() === '' || str(f.answer_html).trim() === '') problems.push(`question ${i + 1}: missing its question or its answer`);
  });

  const tags = Array.isArray(data.tags) ? data.tags : [];
  if (tags.length < 4 || tags.length > 7) problems.push(`tags: ${tags.length}, it must be 4 to 7`);

  return problems;
}

/**
 * Fix one part, then check it.
 *
 * Fixing first means the checks never fire on something the code has already
 * put right — a British "savoury" does not cost a retry.
 */
export function checkPart(
  part: PartName,
  data: Record<string, unknown>,
  rules: RuleContext,
): CheckedPart {
  let fixed = fixText(data, rules.style);
  if (part === 'part-2') fixed = pinTimes(fixed, rules.times);

  const problems: string[] = [];

  if (part === 'part-1') problems.push(...part1Problems(fixed, rules));
  if (part === 'part-2') problems.push(...part2Problems(fixed, rules));
  if (part === 'part-3') problems.push(...part3Problems(fixed));

  for (const { where, text, html } of proseOf(part, fixed)) {
    const plain = html ? plainText(text) : text;
    problems.push(...proseProblems(plain, where, /^question \d+$/.test(where), rules.style));
    for (const p of temperatureProblems(plain, rules.style, where)) problems.push(`${p.where}: ${p.detail}`);
    for (const p of measureProblems(plain, rules.style, where)) problems.push(`${p.where}: ${p.detail}`);
  }

  // The title and the tag can carry a temperature too ("Roast at 220°C").
  if (part === 'part-1') {
    for (const key of ['title', 'title_tag']) {
      for (const p of temperatureProblems(str(fixed[key]), rules.style, key)) problems.push(`${p.where}: ${p.detail}`);
    }
  }

  return { data: fixed, problems: [...new Set(problems)] };
}

/** The note a retry carries: what the last draft got wrong, in the model's terms. */
export function feedbackFor(problems: string[]): string {
  if (problems.length === 0) return '';
  return (
    'YOUR LAST DRAFT BROKE THESE RULES. Write the whole JSON object again, fix every\n'
    + 'one of them, and change nothing else that was right:\n'
    + problems.slice(0, 12).map((p) => `- ${p}`).join('\n')
  );
}

/** A part that still breaks the rules after every attempt. The run stops here. */
export class ArticleRulesError extends Error {
  constructor(readonly part: PartName, readonly problems: string[], cause?: unknown) {
    super(
      `${part} still breaks the article rules after every attempt, so nothing was published: `
      + (problems.length > 0 ? problems.slice(0, 6).join('; ') : 'no usable answer from the model')
      + '. Resume the run to try again, or fix the prompt.',
    );
    this.name = 'ArticleRulesError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/* -------------------------------------------------------------------------
 * Blog articles
 * ---------------------------------------------------------------------- */

export interface BlogFields {
  title: string;
  slug: string;
  title_tag: string;
  meta_desc: string;
  excerpt: string;
  cover_alt: string;
  body_html: string;
}

/**
 * A blog article put into the site's spelling, and what is still wrong with it.
 *
 * The blog prompt used to say "American English, °F" unconditionally while the
 * recipe prompts said "British, metric" — two voices on one site. Both read the
 * same site setting now, and this does for the blog what checkPart does for the
 * recipe: spelling fixed in code, units and voice checked, a failing draft sent
 * back once.
 */
export function checkBlogArticle<T extends BlogFields>(
  article: T,
  style: WritingStyle,
): { article: T; problems: string[] } {
  const fix = (s: string): string => fixProperNouns(applySpelling(s, style), style);
  const fixed: T = {
    ...article,
    title: fix(article.title ?? ''),
    title_tag: fix(article.title_tag ?? ''),
    meta_desc: fix(article.meta_desc ?? ''),
    excerpt: fix(article.excerpt ?? ''),
    cover_alt: fix(article.cover_alt ?? ''),
    slug: applySpelling(article.slug ?? '', style),
    body_html: fixProperNounsInHtml(applySpellingToHtml(article.body_html ?? '', style), style),
  };

  const problems: string[] = [];
  const prose: [string, string][] = [
    ['meta_desc', fixed.meta_desc],
    ['excerpt', fixed.excerpt],
    ['body', plainText(fixed.body_html)],
  ];

  for (const [where, text] of prose) {
    problems.push(...proseProblems(text, where, false, style));
    for (const p of temperatureProblems(text, style, where)) problems.push(`${p.where}: ${p.detail}`);
    for (const p of measureProblems(text, style, where)) problems.push(`${p.where}: ${p.detail}`);
  }
  for (const [where, text] of [['title', fixed.title], ['title_tag', fixed.title_tag]] as [string, string][]) {
    for (const p of temperatureProblems(text, style, where)) problems.push(`${p.where}: ${p.detail}`);
  }
  problems.push(...openingProblems(fixed.body_html, style));

  return { article: fixed, problems: [...new Set(problems)] };
}
