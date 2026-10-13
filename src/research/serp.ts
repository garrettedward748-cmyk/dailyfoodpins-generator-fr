import { research as ollamaResearch, fetchPageText, type Source } from '../llm/web-search.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { serperRotating, type ResearchOptions } from './keywords.js';

const log = createLogger('serp');

/**
 * What Google shows for a keyword, read before writing.
 *
 * Two ways to find the pages, tried in order:
 *   1. Serper (several keys, taking over from each other): organic results
 *      and "People also ask".
 *   2. Ollama web search (several keys): results only.
 * Each top page is then read: its HTML first, for the Recipe data recipe
 * sites put in their code (ingredients, times, yield -- facts, not prose),
 * and Ollama's page reader when the HTML cannot be had.
 *
 * `ok: false` means neither way answered; the caller decides whether to
 * wait or write without it.
 */

export interface CompetitorPage {
  title: string;
  url: string;
  /** From the page's Recipe structured data, when it has any. */
  recipe?: {
    ingredients: string[];
    prepTime?: string;
    cookTime?: string;
    totalTime?: string;
    yield?: string;
    steps?: string;
  };
  /** Readable text when there is no structured data. */
  text?: string;
}

export interface SerpFindings {
  ok: boolean;
  provider: 'serper' | 'ollama' | 'none';
  query: string;
  questions: string[];
  pages: CompetitorPage[];
  error?: string;
}

export interface SerpOptions extends ResearchOptions {
  ollamaKeys: string[];
  /** The site itself: its own pages are not competitors. */
  skipDomain?: string;
  maxPages?: number;
}

const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};

/** Social and video results carry no recipe to read. */
const NOT_A_PAGE = /(^|\.)(youtube\.com|youtu\.be|pinterest\.[a-z.]+|facebook\.com|instagram\.com|tiktok\.com|reddit\.com|x\.com|twitter\.com|amazon\.[a-z.]+)$/;

const asText = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(asText).join(' ') : '');

/** The Recipe object in a page's JSON-LD, wherever it sits (@graph, arrays). */
export function recipeFromHtml(html: string): CompetitorPage['recipe'] | undefined {
  const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!);
  const find = (node: unknown): Record<string, unknown> | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      for (const n of node) {
        const hit = find(n);
        if (hit) return hit;
      }
      return undefined;
    }
    const obj = node as Record<string, unknown>;
    const type = obj['@type'];
    if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) return obj;
    return find(obj['@graph']);
  };
  for (const block of blocks) {
    let data: unknown;
    try {
      data = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const r = find(data);
    if (!r) continue;
    const ingredients = (Array.isArray(r.recipeIngredient) ? r.recipeIngredient : []).map(asText).filter(Boolean).slice(0, 30);
    if (ingredients.length === 0) continue;
    const steps = (Array.isArray(r.recipeInstructions) ? r.recipeInstructions : [])
      .map((s) => (typeof s === 'string' ? s : asText((s as Record<string, unknown>)?.text)))
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 900);
    return {
      ingredients,
      prepTime: asText(r.prepTime) || undefined,
      cookTime: asText(r.cookTime) || undefined,
      totalTime: asText(r.totalTime) || undefined,
      yield: asText(r.recipeYield) || undefined,
      steps: steps || undefined,
    };
  }
  return undefined;
}

async function readPage(url: string, title: string, ollamaKeys: string[], fetchImpl: typeof fetch): Promise<CompetitorPage | null> {
  try {
    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok) {
      const recipe = recipeFromHtml(await response.text());
      if (recipe) return { title, url, recipe };
    }
  } catch {
    // Blocked or slow: the page reader below may still get it.
  }
  const page = await fetchPageText(url, ollamaKeys);
  return page ? { title: page.title || title, url, text: page.content } : null;
}

export async function findOnGoogle(query: string, options: SerpOptions, fetchImpl: typeof fetch = fetch): Promise<SerpFindings> {
  const maxPages = options.maxPages ?? 5;
  const skip = (options.skipDomain ?? '').replace(/^www\./, '').toLowerCase();
  const usable = (url: string) => {
    const h = host(url);
    return h && !NOT_A_PAGE.test(h) && !(skip && h.endsWith(skip));
  };
  const errors: string[] = [];

  // 1. Serper.
  if (options.serperKey?.trim()) {
    try {
      const answer = await serperRotating(query, options, fetchImpl);
      const results = answer.organic.filter((o) => usable(o.url)).slice(0, maxPages);
      const pages = (await Promise.all(results.map((r) => readPage(r.url, r.title, options.ollamaKeys, fetchImpl)))).filter(
        (p): p is CompetitorPage => p !== null,
      );
      // Pages Serper found but nobody could read: their snippets still say something.
      for (const r of results) if (!pages.some((p) => p.url === r.url) && r.snippet) pages.push({ title: r.title, url: r.url, text: r.snippet });
      if (pages.length > 0 || answer.questions.length > 0) {
        return { ok: true, provider: 'serper', query, questions: answer.questions.slice(0, 8), pages };
      }
      errors.push('Serper returned no results');
    } catch (err) {
      errors.push(`Serper: ${errorMessage(err)}`);
    }
  }

  // 2. Ollama web search.
  if (options.ollamaKeys.length > 0) {
    const sources: Source[] = await ollamaResearch(query, options.ollamaKeys, { skipDomain: options.skipDomain, maxPages });
    if (sources.length > 0) {
      return {
        ok: true,
        provider: 'ollama',
        query,
        questions: [],
        pages: sources.map((s) => ({ title: s.title, url: s.url, text: s.content })),
      };
    }
    errors.push('Ollama web search found nothing or failed');
  } else {
    errors.push('no ollama.com key for web search');
  }

  log.warn(`no Google research for "${query}": ${errors.join('; ')}`);
  return { ok: false, provider: 'none', query, questions: [], pages: [], error: errors.join('; ') };
}

/** The findings as notes for the model that writes the brief. */
export function findingsForPrompt(f: SerpFindings): string {
  return f.pages
    .map((p, i) => {
      const head = `[Page ${i + 1}] ${p.title} (${host(p.url)})`;
      if (p.recipe) {
        const r = p.recipe;
        return [
          head,
          `Ingredients: ${r.ingredients.join('; ')}`,
          [r.prepTime && `prep ${r.prepTime}`, r.cookTime && `cook ${r.cookTime}`, r.totalTime && `total ${r.totalTime}`, r.yield && `yield ${r.yield}`]
            .filter(Boolean)
            .join(', '),
          r.steps ? `Method: ${r.steps}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      }
      return `${head}\n${(p.text ?? '').slice(0, 1800)}`;
    })
    .join('\n\n');
}
