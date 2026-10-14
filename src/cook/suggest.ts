import { research as ollamaResearch } from '../llm/web-search.js';
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

/**
 * Find the top recipe pages for the dish and read what their readers wrote.
 * Pages with no reader experience are dropped. [] when no search answered.
 */
export async function gatherExperiences(
  query: string,
  options: GatherOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<ExperiencePage[]> {
  const maxPages = options.maxPages ?? 8;
  const skip = (options.skipDomain ?? '').replace(/^www\./, '').toLowerCase();
  const keep = (url: string) => {
    const h = host(url);
    return Boolean(h) && !NOT_A_PAGE.test(h) && !(skip && h.endsWith(skip));
  };

  if (options.serperKey?.trim()) {
    try {
      const answer = await serperRotating(`${query} recipe`, options, fetchImpl);
      const results = answer.organic.filter((o) => keep(o.url)).slice(0, maxPages);
      const pages = await Promise.all(
        results.map(async (r): Promise<ExperiencePage | null> => {
          try {
            const response = await fetchImpl(r.url, {
              headers: { 'User-Agent': BROWSER, Accept: 'text/html' },
              signal: AbortSignal.timeout(12_000),
            });
            if (!response.ok) return null;
            const experiences = experiencesFromHtml(await response.text());
            return experiences.length ? { title: r.title, url: r.url, experiences } : null;
          } catch {
            return null;
          }
        }),
      );
      const read = pages.filter((p): p is ExperiencePage => p !== null);
      if (read.length > 0) return read;
    } catch (err) {
      log.warn(`Serper failed for "${query}": ${errorMessage(err)}`);
    }
  }

  // Without Serper, or when no page could be read: the page reader's text,
  // which keeps the comments on many sites. The model is told to use only
  // what readers wrote in it.
  if (options.ollamaKeys.length > 0) {
    const sources = await ollamaResearch(`${query} recipe reviews`, options.ollamaKeys, {
      skipDomain: options.skipDomain,
      maxPages: Math.min(maxPages, 6),
    });
    return sources
      .filter((s) => keep(s.url))
      .map((s) => ({ title: s.title, url: s.url, experiences: [s.content.slice(0, 3000)] }));
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
export function pickSuggestions(parsed: unknown, pageCount: number, existingNotes = ''): CookSuggestion[] {
  const list = (parsed as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(list)) return [];

  const already = existingNotes.toLowerCase();
  const out: CookSuggestion[] = [];
  for (const item of list) {
    const tip = typeof (item as { tip?: unknown })?.tip === 'string' ? (item as { tip: string }).tip.replace(/\s+/g, ' ').trim() : '';
    if (tip.length < 15 || tip.length > 240) continue;
    if (FIRST_PERSON.test(tip) || STORY.test(tip)) continue;
    if (already.includes(tip.toLowerCase())) continue;

    const raw = (item as { sources?: unknown })?.sources;
    const ids = new Set(
      (Array.isArray(raw) ? raw : [])
        .map((s) => Number(String(s).replace(/^S/i, '')))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= pageCount),
    );
    if (ids.size < MIN_SOURCES) continue;
    if (out.some((o) => o.tip.toLowerCase() === tip.toLowerCase())) continue;
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
