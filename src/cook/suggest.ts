import { fetchPageText, research as ollamaResearch } from '../llm/web-search.js';
import { serperRotating, type ResearchOptions } from '../research/keywords.js';
import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('cook-suggest');

/**
 * Notes the cook can approve, taken from other cooks' real experience.
 *
 * Nothing here is the model's own idea. Readers' reviews and comments on the
 * top recipes for the dish are collected; the model may only point at tips
 * that two or more of those pages already report, and only ones that fit the
 * cook's recipe. Code then holds it to that: a tip with fewer than two real
 * sources, a personal story, or a duplicate never reaches the cook, and at
 * most three are shown, strongest first.
 *
 * The cook approves or rejects each one. Approving says "this is true in my
 * kitchen", so a tip is phrased as practical advice, never as a memory.
 */

export const MAX_SUGGESTIONS = 3;
export const MIN_SOURCES = 2;

export interface ExperiencePage {
  title: string;
  url: string;
  /** What readers who made it wrote. */
  experiences: string[];
}

export interface CookSuggestion {
  tip: string;
  /** How many different pages report it. */
  sources: number;
}

const decode = (text: string): string =>
  text
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');

const plain = (html: string): string => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Long enough to say something, short enough to be one person's comment. */
const usable = (text: string): boolean => text.length >= 25 && text.length <= 800;

/**
 * Readers' reviews and comments in one recipe page's HTML.
 *
 * Two places they live: the Recipe structured data (`review[].reviewBody`),
 * and the comment blocks recipe sites render (WordPress, WP Recipe Maker,
 * Tasty, schema `reviewBody`). Anything else on the page is the author, not
 * a reader, and is left alone.
 */
export function experiencesFromHtml(html: string, max = 15): string[] {
  const found: string[] = [];

  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]!.trim());
    } catch {
      continue;
    }
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const obj = node as Record<string, unknown>;
      const reviews = obj.review;
      for (const r of Array.isArray(reviews) ? reviews : reviews ? [reviews] : []) {
        const body = (r as Record<string, unknown>)?.reviewBody ?? (r as Record<string, unknown>)?.description;
        if (typeof body === 'string') found.push(plain(body));
      }
      walk(obj['@graph']);
    };
    walk(data);
  }

  const blocks =
    /<(div|p|section)[^>]*(?:class="[^"]*(?:comment-content|comment-text|comment-body|wprm-comment-content|tasty-recipes-comment)[^"]*"|itemprop="reviewBody")[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of html.matchAll(blocks)) found.push(plain(m[2]!));

  return [...new Set(found.filter(usable))].slice(0, max);
}

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
const NOT_A_PAGE = /(^|\.)(youtube\.com|youtu\.be|pinterest\.[a-z.]+|facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|amazon\.[a-z.]+)$/;

const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};

export interface GatherOptions extends ResearchOptions {
  ollamaKeys: string[];
  skipDomain?: string;
  maxPages?: number;
}

/** Lines that belong to a comment form, not to a reader. */
const FORM_LINE = /^(reply|leave a (reply|comment)|post comment|submit|cancel reply|your email address|required fields|save my name|notify me|rate this recipe|recipe rating|log in|sign up|load more|show more|\d+ (comments?|reviews?|replies))\b/i;

/** Where a page's reader section starts, in the page reader's text. */
const COMMENTS_START =
  /(?:^|\n)\s*(?:#{1,4}\s*)?(?:\d+\s+)?(?:comments?|reviews?|responses?|ratings? (?:and|&) reviews?|what (?:readers|people) are saying)\s*(?:\(\d+\))?\s*(?:\n|$)/i;

/**
 * Readers' comments in a page's plain text, from the page reader.
 *
 * Only what comes after the page's comments or reviews heading is taken: the
 * author's own text above it is not a reader's experience. A page with no
 * such heading gives nothing rather than risk passing the author off as one.
 */
export function experiencesFromText(text: string, max = 15): string[] {
  const at = text.search(COMMENTS_START);
  if (at === -1) return [];
  const section = text.slice(at).split(/\n+/).slice(1);
  const found = section
    .map((line) => line.replace(/^[#>*\-\s]+/, '').replace(/\[(.*?)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim())
    .filter((line) => usable(line) && !FORM_LINE.test(line));
  return [...new Set(found)].slice(0, max);
}

/**
 * Find the top recipe pages for the dish and read what their readers wrote.
 *
 * Two searches (the dish, then the dish with "reviews") so more pages are
 * tried. Each page is read as HTML first; when its comments are not in the
 * HTML (blocked, or loaded later by the browser), the page reader gets its
 * text and the comment section is taken from that. Pages with no reader
 * experience are dropped. [] when no search answered.
 */
export async function gatherExperiences(
  query: string,
  options: GatherOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<ExperiencePage[]> {
  const maxPages = options.maxPages ?? 15;
  const skip = (options.skipDomain ?? '').replace(/^www\./, '').toLowerCase();
  const keep = (url: string) => {
    const h = host(url);
    return Boolean(h) && !NOT_A_PAGE.test(h) && !(skip && h.endsWith(skip));
  };

  const readOne = async (url: string, title: string): Promise<ExperiencePage | null> => {
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': BROWSER, Accept: 'text/html' },
        signal: AbortSignal.timeout(12_000),
      });
      if (response.ok) {
        const experiences = experiencesFromHtml(await response.text());
        if (experiences.length) return { title, url, experiences };
      }
    } catch {
      // Blocked or slow: the page reader below may still get it.
    }
    if (options.ollamaKeys.length === 0) return null;
    const page = await fetchPageText(url, options.ollamaKeys).catch(() => null);
    const experiences = page ? experiencesFromText(page.content) : [];
    return experiences.length ? { title: page?.title || title, url, experiences } : null;
  };

  if (options.serperKey?.trim()) {
    const found = new Map<string, string>();
    for (const q of [`${query} recipe`, `${query} recipe reviews`]) {
      try {
        const answer = await serperRotating(q, options, fetchImpl);
        for (const o of answer.organic) {
          const key = o.url.replace(/[#?].*$/, '').replace(/\/$/, '');
          if (keep(o.url) && !found.has(key)) found.set(key, o.title);
        }
      } catch (err) {
        log.warn(`Serper failed for "${q}": ${errorMessage(err)}`);
      }
    }
    const targets = [...found].slice(0, maxPages);
    const pages = (await Promise.all(targets.map(([url, title]) => readOne(url, title)))).filter(
      (p): p is ExperiencePage => p !== null,
    );
    log.info(`"${query}": reader comments on ${pages.length} of ${targets.length} page(s)`);
    if (pages.length > 0) return pages;
  }

  // Without Serper, or when no page gave comments: Ollama's search and reader.
  if (options.ollamaKeys.length > 0) {
    const sources = await ollamaResearch(`${query} recipe reviews`, options.ollamaKeys, {
      skipDomain: options.skipDomain,
      maxPages: Math.min(maxPages, 8),
    });
    return sources
      .filter((s) => keep(s.url))
      .map((s) => ({ title: s.title, url: s.url, experiences: experiencesFromText(s.content) }))
      .filter((p) => p.experiences.length > 0);
  }
  return [];
}

/** The pages as the prompt sees them, numbered [S1], [S2]... */
export function experiencesForPrompt(pages: ExperiencePage[]): string {
  return pages
    .map((p, i) => `[S${i + 1}] ${host(p.url)}\n${p.experiences.map((e) => `- ${e.slice(0, 600)}`).join('\n')}`)
    .join('\n\n');
}

const FIRST_PERSON = /\b(?:I|I'm|I've|I'll|I'd|my|me|mine|we|our|us)\b/i;
const STORY = /\b(?:husband|wife|son|daughter|kids?|children|family|mom|mother|dad|father|grandma|grandmother|friends?|guests?|party|birthday|christmas|thanksgiving)\b/i;

/**
 * Hold the model's answer to the rules, whatever it says.
 *
 * Kept: a tip of reasonable length, reported by at least MIN_SOURCES
 * different real pages, phrased as advice rather than a story. Sorted by how
 * many pages report it; at most MAX_SUGGESTIONS.
 */
/** Why the model's tips were kept or dropped, for the message the cook sees. */
export interface PickReport {
  proposed: number;
  unreadable: boolean;
  oneSource: number;
  personal: number;
  repeated: number;
  badLength: number;
}

export const emptyReport = (): PickReport => ({ proposed: 0, unreadable: false, oneSource: 0, personal: 0, repeated: 0, badLength: 0 });

export function pickSuggestions(
  parsed: unknown,
  pageCount: number,
  existingNotes = '',
  report: PickReport = emptyReport(),
): CookSuggestion[] {
  const list = (parsed as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(list)) {
    report.unreadable = true;
    return [];
  }
  report.proposed = list.length;

  const already = existingNotes.toLowerCase();
  const out: CookSuggestion[] = [];
  for (const item of list) {
    const tip = typeof (item as { tip?: unknown })?.tip === 'string' ? (item as { tip: string }).tip.replace(/\s+/g, ' ').trim() : '';
    if (tip.length < 15 || tip.length > 240) {
      report.badLength++;
      continue;
    }
    if (FIRST_PERSON.test(tip) || STORY.test(tip)) {
      report.personal++;
      continue;
    }
    if (already.includes(tip.toLowerCase())) {
      report.repeated++;
      continue;
    }

    const raw = (item as { sources?: unknown })?.sources;
    const ids = new Set(
      (Array.isArray(raw) ? raw : [])
        .map((s) => Number(String(s).replace(/^S/i, '')))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= pageCount),
    );
    if (ids.size < MIN_SOURCES) {
      report.oneSource++;
      continue;
    }
    if (out.some((o) => o.tip.toLowerCase() === tip.toLowerCase())) {
      report.repeated++;
      continue;
    }
    out.push({ tip, sources: ids.size });
  }
  return out.sort((a, b) => b.sources - a.sources).slice(0, MAX_SUGGESTIONS);
}

/** Stored suggestions, read back safely. */
export function readSuggestions(json: string | null | undefined): CookSuggestion[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v)
      ? v.filter((s): s is CookSuggestion => typeof s?.tip === 'string' && typeof s?.sources === 'number')
      : [];
  } catch {
    return [];
  }
}

/** One line saying what happened, so an empty result is never a mystery. */
export function describeRun(pages: ExperiencePage[], report: PickReport, kept: number): string {
  const comments = pages.reduce((n, p) => n + p.experiences.length, 0);
  const read = `Read ${comments} reader comment(s) on ${pages.length} page(s).`;
  if (report.unreadable) return `${read} The model's answer could not be read; try again.`;
  if (report.proposed === 0) return `${read} The model found no tip that two pages share and that fits this recipe.`;
  const dropped = [
    report.oneSource && `${report.oneSource} reported by only one page`,
    report.personal && `${report.personal} written as a personal story`,
    report.repeated && `${report.repeated} already in the notes`,
    report.badLength && `${report.badLength} too short or too long`,
  ].filter(Boolean);
  return `${read} The model proposed ${report.proposed}; kept ${kept}${dropped.length ? `, dropped ${dropped.join(', ')}` : ''}.`;
}
