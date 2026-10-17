/**
 * The times of a recipe, worked out once, in code.
 *
 * Three prompts each wrote a time for the same recipe and none of them checked
 * the others. The recipe came with prep, cook and total. The recipe card was
 * written from it and invented a rest time by folding a 20-minute wait before
 * cooking in with the 5-minute rest after it, so the card said "Rest 25 min,
 * Total 47 min". The introduction was written from the same source and said
 * "ready in just 27 minutes", which was the source's own total. One page, two
 * totals.
 *
 * A time is arithmetic, not prose, so it is not asked of a model twice. The
 * recipe's own prep, cook and total are read here; the rest is the difference;
 * and every later part is given those numbers and checked against them.
 */

import type { WritingStyle } from './writing-style.js';

export interface RecipeTimes {
  prep: number;
  cook: number;
  /** Hands-off time: resting, chilling, marinating. Total minus prep minus cook. */
  rest: number;
  total: number;
  /** The source's total was shorter than prep plus cook, so total was raised to match. */
  adjusted: boolean;
}

const VULGAR: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75 };

/** One number as a person writes it: 2, 1.5, 1½, 1 1/2, ½. */
const NUMBER = String.raw`(?:\d+\s+\d\/\d|\d\/\d|\d+\s*[½¼¾]|\d+(?:\.\d+)?|[½¼¾])`;

function toNumber(text: string): number {
  const clean = text.trim();

  const mixed = /^(\d+)\s+(\d)\/(\d)$/.exec(clean);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);

  const simple = /^(\d)\/(\d)$/.exec(clean);
  if (simple) return Number(simple[1]) / Number(simple[2]);

  const vulgar = /^(\d*)\s*([½¼¾])$/.exec(clean);
  if (vulgar) return Number(vulgar[1] || 0) + VULGAR[vulgar[2]!]!;

  return Number(clean);
}

const DURATION = new RegExp(
  // "30-minute" is a duration as much as "30 minutes": the optional hyphen is
  // what lets a title that says "30-Minute Steak" be held to the recipe too.
  // French is read as well: "2 heures", "1 h", "20 à 25 minutes", "45 min".
  `(${NUMBER})(?:\\s*(?:-|–|—|to|à)\\s*(${NUMBER}))?\\s*-?\\s*(hours?|hrs?|heures?|h|minutes?|mins?)(?![\\p{L}])`,
  'giu',
);

/** "1 h 30", "1h30", "1 heure 30", "2 heures 05": hours and minutes written as one figure, the French way. */
const HOUR_MINUTE = /(?<![\d.,/])(\d{1,2})\s?(?:h|heures?)\s?([0-5]\d)(?![\d\p{L}])(?!\s*(?:g|kg|ml|cl|dl|l|cm|mm|°|%|min))/giu;

/**
 * Numbers spelled out, as a recipe often writes its waits: "réfrigérer deux
 * heures, ou jusqu'à six", "chill two hours, or up to six". Read in the source
 * only, so "deux heures" there allows the "2 heures" a later part writes; the
 * parts themselves are checked on digits as before.
 */
const WORD_NUMBERS: Record<string, number> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12, quinze: 15, dix_huit: 18, vingt: 20, 'vingt-quatre': 24, trente: 30, quarante: 40,
  'quarante-cinq': 45, cinquante: 50, soixante: 60, 'quatre-vingt-dix': 90,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, eighteen: 18, twenty: 20, 'twenty-four': 24, thirty: 30, forty: 40, 'forty-five': 45, fifty: 50,
  sixty: 60, ninety: 90,
};
const WORD = `(?:${Object.keys(WORD_NUMBERS).filter((w) => !w.includes('_')).sort((a, b) => b.length - a.length).join('|')})`;
const UNIT = '(heures?|hours?|hrs?|minutes?|mins?)';
const WORD_DURATION = new RegExp(
  `(?<![\\p{L}])(${WORD})(?:\\s*(?:-|–|—|to|à|or|ou|et|and)\\s*(${WORD}))?\\s*-?\\s*${UNIT}(?![\\p{L}])`,
  'giu',
);
// "deux heures, ou jusqu'à six" / "two hours, or up to six": the second number borrows the unit of the first.
const WORD_UP_TO = new RegExp(
  `(?<![\\p{L}])(${WORD})\\s+${UNIT}(?![\\p{L}])[^.;]{0,30}?(?:jusqu['’]à|up to)\\s+(${WORD}|\\d+)(?![\\p{L}\\d])(?!\\s*-?\\s*(?:heures?|hours?|hrs?|h|minutes?|mins?)(?![\\p{L}]))`,
  'giu',
);

/** Times written in words, in minutes; for reading the source. */
export function wordDurationsIn(text: string): number[] {
  const out: number[] = [];
  const value = (w: string) => WORD_NUMBERS[w.toLowerCase()] ?? Number(w);
  const factor = (unit: string) => (/^h/i.test(unit) ? 60 : 1);
  for (const m of text.matchAll(WORD_DURATION)) {
    out.push(value(m[1]!) * factor(m[3]!));
    if (m[2]) out.push(value(m[2]) * factor(m[3]!));
  }
  for (const m of text.matchAll(WORD_UP_TO)) out.push(value(m[3]!) * factor(m[2]!));
  return out.filter((n) => Number.isFinite(n) && n > 0);
}

/** One time found in a piece of text, in minutes. A range has two ends. */
export interface Duration {
  /** The words as written, for a message. */
  text: string;
  /** One value, or two for a range. */
  minutes: number[];
}

/**
 * Every duration in `text`, in minutes.
 *
 * "1 hour 30 minutes" is one duration of 90, not a 60 and a 30: the hour and
 * the minutes it is followed by belong together. A range keeps both ends,
 * because "20-25 minutes" is a claim about two numbers and each has to be in
 * the source.
 */
export function durationsIn(text: string): Duration[] {
  const found: { start: number; end: number; unit: 'h' | 'm'; values: number[]; raw: string }[] = [];

  // "1 h 30" is read first and its span set aside, so the "1 h" inside it is
  // not counted a second time as a bare hour.
  const taken: [number, number][] = [];
  for (const match of text.matchAll(HOUR_MINUTE)) {
    const start = match.index ?? 0;
    taken.push([start, start + match[0].length]);
    found.push({
      start, end: start + match[0].length, unit: 'm',
      values: [Number(match[1]) * 60 + Number(match[2])], raw: match[0],
    });
  }

  for (const match of text.matchAll(DURATION)) {
    const at = match.index ?? 0;
    if (taken.some(([s, e]) => at >= s && at < e)) continue;
    const unit = /^h/i.test(match[3]!) ? 'h' : 'm';
    const factor = unit === 'h' ? 60 : 1;
    const values = [toNumber(match[1]!), ...(match[2] ? [toNumber(match[2])] : [])].map((v) => v * factor);
    const start = match.index ?? 0;
    found.push({ start, end: start + match[0].length, unit, values, raw: match[0] });
  }
  found.sort((a, b) => a.start - b.start);

  const out: Duration[] = [];

  for (let i = 0; i < found.length; i++) {
    const current = found[i]!;
    const next = found[i + 1];

    // An hours figure followed straight away by a minutes one is one time.
    if (
      current.unit === 'h' && next && next.unit === 'm' && current.values.length === 1
      && /^\s*(?:and|et|,)?\s*$/i.test(text.slice(current.end, next.start))
    ) {
      out.push({
        text: text.slice(current.start, next.end),
        minutes: next.values.map((m) => current.values[0]! + m),
      });
      i++;
      continue;
    }

    out.push({ text: current.raw, minutes: current.values });
  }

  return out;
}

/**
 * One time field of the recipe as a whole number of minutes.
 *
 * The upper end of a range, because a total that is too short is the mistake
 * that matters. Null for anything that is not a time ("overnight", "see
 * notes"): a number that cannot be read is not guessed.
 */
export function parseMinutes(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (text === '' || /^(?:none|n\/?a|not applicable|no(?:\s+cook(?:ing)?)?|aucun(?:e)?|néant|sans(?:\s+cuisson)?|-|—)$/iu.test(text)) return 0;
  if (/^0+(?:\.0+)?$/.test(text)) return 0;

  // A bare number is minutes: the prompt asks for "15 minutes" but a model
  // sometimes answers "15".
  if (/^\d+$/.test(text)) return Number(text);

  const durations = durationsIn(text);
  if (durations.length === 0) return null;

  return Math.round(Math.max(...durations[0]!.minutes));
}

/**
 * Prep, cook, rest and total, from the recipe the model wrote.
 *
 * Null when prep or cook cannot be read, because then nothing downstream can
 * be pinned to them and the honest answer is "unknown", not a guess.
 */
export function canonicalTimes(recipe: Record<string, unknown>): RecipeTimes | null {
  const prep = parseMinutes(recipe.prep_time);
  const cook = parseMinutes(recipe.cook_time);
  if (prep === null || cook === null) return null;

  const stated = parseMinutes(recipe.total_time);
  const active = prep + cook;

  if (stated === null || stated === 0) {
    return { prep, cook, rest: 0, total: active, adjusted: stated === 0 && active > 0 };
  }
  if (stated < active) {
    return { prep, cook, rest: 0, total: active, adjusted: true };
  }
  return { prep, cook, rest: stated - active, total: stated, adjusted: false };
}

/**
 * 47 -> "47 minutes", 65 -> "1 hour 5 minutes", 120 -> "2 hours".
 * In French ("fr"): "47 minutes", "1 heure 5 minutes", "2 heures".
 */
export function formatMinutes(minutes: number, style: WritingStyle = 'us'): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const fr = style === 'fr';
  const parts: string[] = [];
  if (h > 0) parts.push(fr ? `${h} ${h === 1 ? 'heure' : 'heures'}` : `${h} ${h === 1 ? 'hour' : 'hours'}`);
  if (m > 0 || h === 0) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`);
  return parts.join(' ');
}

/** What the prompts are given. Every field is a string, so an empty one leaves no trace. */
export interface TimeBlocks {
  prep: string;
  cook: string;
  rest: string;
  total: string;
  /** The times, one per line, for part 1. */
  summary: string;
  /** The instruction for the three minute fields in part 2. */
  card: string;
}

export function timeBlocks(times: RecipeTimes | null, style: WritingStyle = 'us'): TimeBlocks {
  if (!times) {
    return {
      prep: '', cook: '', rest: '', total: '',
      summary:
        'The recipe gives no readable prep, cook or total time. State NO duration of\n'
        + 'any kind in the title, headline, meta description or introduction.',
      card:
        'from the source. Use 0 where there is none. Do not output a total.',
    };
  }

  const f = (m: number): string => formatMinutes(m, style);
  const lines = [
    `- Prep: ${f(times.prep)}`,
    `- Cook: ${f(times.cook)}`,
    ...(times.rest > 0 ? [`- Resting, chilling or marinating: ${f(times.rest)}`] : []),
    `- Total: ${f(times.total)}`,
  ];

  return {
    prep: String(times.prep),
    cook: String(times.cook),
    rest: String(times.rest),
    total: String(times.total),
    summary:
      `${lines.join('\n')}\n`
      + 'These are fixed. If you state how long the dish takes, it is the Total above,\n'
      + 'worded as written — never a different figure, never a sum of your own.',
    card:
      `exactly prep_minutes ${times.prep}, cook_minutes ${times.cook}, rest_minutes ${times.rest}. `
      + 'They are worked out already and add up to the recipe\'s own total; do not change them.',
  };
}

/**
 * Every time the source itself mentions, in minutes.
 *
 * What a part is allowed to repeat. A time that is not in here was invented,
 * or was added up from two that are, and either way the cook is being told
 * something the recipe never said.
 */
export function allowedMinutes(source: string, times: RecipeTimes | null): Set<number> {
  const allowed = new Set<number>();
  for (const d of durationsIn(source)) for (const m of d.minutes) allowed.add(m);
  for (const m of wordDurationsIn(source)) allowed.add(m);
  if (times) {
    for (const m of [times.prep, times.cook, times.total]) allowed.add(m);
    if (times.rest > 0) allowed.add(times.rest);
  }
  return allowed;
}

export interface TimeProblem {
  where: string;
  detail: string;
}

/** Durations in `text` that the recipe never gave. */
export function timeProblems(text: string, allowed: Set<number>, where: string): TimeProblem[] {
  const problems: TimeProblem[] = [];

  for (const d of durationsIn(text)) {
    if (d.minutes.every((m) => allowed.has(m))) continue;
    problems.push({
      where,
      detail: `"${d.text.trim()}" is not a time in the recipe — use only times the recipe gives`,
    });
  }
  return problems;
}
