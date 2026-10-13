/**
 * Parsing helpers for LLM output.
 *
 * These consolidate the cleanup logic that was spread across five separate
 * Code nodes in the previous system (SEO Cleaner, Reciper json, Cleaning
 * Json1, Separate ID + name, Code in JavaScript8), each with its own slightly
 * different idea of how to rescue malformed JSON.
 *
 * The guiding rule: a model producing a trailing comma or a smart quote is not
 * a failed run. It is the single most common thing a language model does wrong,
 * it costs a full generation to hit, and the fix is mechanical. So the parser
 * works in escalating passes and only gives up when the text is not recoverable
 * — at which point the caller can still hand it back to the model to rewrite.
 *
 * Every repair here has the same property: it cannot change the meaning of a
 * document that was already valid. That is what makes running them safe.
 */

export class LlmJsonError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'LlmJsonError';
  }
}

/** Strip markdown fences and surrounding prose from a model's reply. */
export function stripFences(text: string): string {
  let out = text.trim();

  // Fences anywhere, not only at the very start: models often open with a
  // sentence, then fence the JSON.
  const fenced = /```(?:json|javascript|js)?\s*\n?([\s\S]*?)```/i.exec(out);
  if (fenced?.[1]) out = fenced[1].trim();

  if (out.startsWith('```')) {
    out = out
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
  }

  // If the model wrapped JSON in commentary, keep the outermost braces.
  if (!out.startsWith('{') && !out.startsWith('[')) {
    const firstBrace = out.indexOf('{');
    const firstBracket = out.indexOf('[');
    const start =
      firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket);

    if (start >= 0) {
      const lastBrace = out.lastIndexOf('}');
      const lastBracket = out.lastIndexOf(']');
      const end = Math.max(lastBrace, lastBracket);
      if (end > start) out = out.slice(start, end + 1);
    }
  }

  return out.trim();
}

/**
 * Walk the text once, tracking whether we are inside a string.
 *
 * Every structural repair needs this. A regex cannot tell a brace in prose
 * ("serve in a { shaped mould") from a brace that closes an object, and the
 * recipe prompts produce a lot of prose.
 */
function scan(
  text: string,
  visit: (char: string, index: number, inString: boolean) => void,
): void {
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (escaped) {
      escaped = false;
      visit(char, i, true);
      continue;
    }
    if (inString && char === '\\') {
      escaped = true;
      visit(char, i, true);
      continue;
    }
    if (char === '"') {
      inString = !inString;
      visit(char, i, inString);
      continue;
    }

    visit(char, i, inString);
  }
}

/**
 * The first balanced JSON value in the text.
 *
 * Models append things: a closing remark, a second example, a stray fence.
 * Taking everything between the first brace and the last one swallows that;
 * counting depth stops at the real end of the document.
 */
export function extractBalanced(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const opener = text[start]!;
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let end = -1;

  scan(text.slice(start), (char, index, inString) => {
    if (inString || end !== -1) return;
    if (char === opener) depth++;
    else if (char === closer) {
      depth--;
      if (depth === 0) end = index;
    }
  });

  return end === -1 ? null : text.slice(start, start + end + 1);
}

/**
 * Anything that is not data: byte order marks, and comments.
 *
 * Runs before everything else. A comment sitting between `{` and the first key
 * hides that key from the bare-key pass, which looks for a name directly after
 * a brace or comma — so stripping late leaves keys after a comment unquoted
 * and the document still fails.
 */
export function stripNoise(text: string): string {
  let out = text.replace(/﻿/g, '');

  // Only outside strings, or every URL's // becomes a comment.
  out = stripOutsideStrings(out, /\/\/[^\n\r]*/g);
  out = stripOutsideStrings(out, /\/\*[\s\S]*?\*\//g);
  return out;
}

/** Repairs that are safe because they cannot change a valid document. */
export function repairCommonIssues(text: string): string {
  let out = stripNoise(text);

  // Word-shaped values from other languages and from models improvising.
  out = replaceOutsideStrings(out, /\bNaN\b|\bInfinity\b|\b-Infinity\b|\bundefined\b/g, 'null');
  out = replaceOutsideStrings(out, /\bTrue\b/g, 'true');
  out = replaceOutsideStrings(out, /\bFalse\b/g, 'false');
  out = replaceOutsideStrings(out, /\bNone\b/g, 'null');

  // Trailing commas before a close. The most common single defect.
  out = replaceOutsideStrings(out, /,(\s*[}\]])/g, '$1');

  // A missing comma between two members: `"a": 1 "b": 2` or `} {`.
  out = replaceOutsideStrings(out, /("\s*)\n(\s*")/g, '$1,\n$2');
  out = replaceOutsideStrings(out, /([}\]])(\s*)\n(\s*[{["])/g, '$1,$2\n$3');

  return out.trim();
}

/** Apply a regex only to the parts of `text` that sit outside JSON strings. */
function mapOutsideStrings(text: string, transform: (chunk: string) => string): string {
  const parts: string[] = [];
  let buffer = '';
  let insideRun = false;

  scan(text, (char, _index, inString) => {
    if (inString !== insideRun) {
      parts.push(insideRun ? buffer : transform(buffer));
      buffer = '';
      insideRun = inString;
    }
    buffer += char;
  });

  parts.push(insideRun ? buffer : transform(buffer));
  return parts.join('');
}

const stripOutsideStrings = (text: string, pattern: RegExp): string =>
  mapOutsideStrings(text, (chunk) => chunk.replace(pattern, ''));

const replaceOutsideStrings = (text: string, pattern: RegExp, replacement: string): string =>
  mapOutsideStrings(text, (chunk) => chunk.replace(pattern, replacement));

/**
 * Quote characters a model reaches for that JSON does not accept.
 *
 * Curly quotes come from prose training data; single quotes come from Python
 * and JavaScript. Both are applied before the string-aware passes, because
 * until they are fixed the parser cannot tell where a string begins.
 */
export function normaliseQuotes(text: string): string {
  return text
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    // 'key': and 'value' -> "key": and "value", when the content has no
    // double quote of its own to be confused by.
    .replace(/'([^'"\n]*)'(\s*:)/g, '"$1"$2')
    .replace(/([:[,]\s*)'([^'"\n]*)'/g, '$1"$2"');
}

/** Bare object keys: `{name: "x"}` -> `{"name": "x"}`. */
export function quoteBareKeys(text: string): string {
  return replaceOutsideStrings(text, /([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
}

/**
 * Literal newlines and tabs inside a string.
 *
 * A model writing a multi-line instruction step often presses enter inside the
 * quotes. JSON forbids that, and it is the defect most likely to survive every
 * other pass, because the text either side is perfectly well formed.
 */
export function escapeControlCharacters(text: string): string {
  let out = '';

  scan(text, (char, _index, inString) => {
    if (inString && (char === '\n' || char === '\r' || char === '\t')) {
      out += char === '\n' ? '\\n' : char === '\r' ? '\\r' : '\\t';
      return;
    }
    out += char;
  });

  return out;
}

/**
 * Every repair pass, cheapest and safest first.
 *
 * Order within a pass matters as much as the order of the passes. Noise is
 * removed first so keys are adjacent to their braces, quotes are normalised
 * next so the string scanner can tell where strings start, then bare keys are
 * quoted, and only then are commas and literals fixed.
 */
const full = (text: string): string =>
  repairCommonIssues(quoteBareKeys(normaliseQuotes(stripNoise(text))));

const PASSES: { name: string; apply: (text: string) => string }[] = [
  { name: 'as written', apply: (t) => t },
  { name: 'common issues', apply: repairCommonIssues },
  { name: 'quotes', apply: (t) => repairCommonIssues(normaliseQuotes(stripNoise(t))) },
  { name: 'bare keys', apply: full },
  { name: 'control characters', apply: (t) => escapeControlCharacters(full(t)) },
  {
    name: 'balanced extract',
    apply: (t) => escapeControlCharacters(full(extractBalanced(t) ?? t)),
  },
];

export interface ParseAttempt<T> {
  value: T;
  /** Which pass succeeded. 'as written' means nothing had to be repaired. */
  repairedBy: string;
}

/** Parse, repairing as needed, and report which pass got there. */
export function tryParseJson<T = Record<string, unknown>>(raw: string): ParseAttempt<T> | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  const cleaned = stripFences(raw);

  for (const pass of PASSES) {
    try {
      const candidate = pass.apply(cleaned);
      if (candidate.trim() === '') continue;
      return { value: JSON.parse(candidate) as T, repairedBy: pass.name };
    } catch {
      // Try the next, more aggressive pass.
    }
  }

  return null;
}

export function parseJson<T = Record<string, unknown>>(raw: string, what = 'LLM output'): T {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new LlmJsonError(`${what} was empty`, String(raw));
  }

  const parsed = tryParseJson<T>(raw);
  if (parsed) return parsed.value;

  // Report what the parser actually choked on, so the run page shows something
  // more useful than "position 392".
  const cleaned = stripFences(raw);
  let detail = 'unknown';
  try {
    JSON.parse(cleaned);
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }

  throw new LlmJsonError(
    `${what} is not valid JSON and could not be repaired: ${detail}`,
    cleaned.slice(0, 2000),
  );
}

/** Require named fields to be present and non-empty. */
export function requireFields<T extends Record<string, unknown>>(
  obj: T,
  fields: string[],
  what: string,
): void {
  const missing = fields.filter((f) => {
    const value = obj[f];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    throw new LlmJsonError(`${what} is missing: ${missing.join(', ')}`, JSON.stringify(obj).slice(0, 500));
  }
}
