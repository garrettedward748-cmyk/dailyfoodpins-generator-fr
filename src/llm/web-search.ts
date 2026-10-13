import { listEndpoints } from './pool.js';
import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('web-search');

/**
 * Research for a blog article through Ollama's Web Search and Web Fetch APIs.
 *
 * The model alone answers from memory; a question such as "how long does
 * cooked rice last in the fridge" deserves current, checked facts. Before the
 * article is written, the question is searched, the best few pages are read,
 * and their text goes to the writer as notes to paraphrase — never to copy.
 *
 * Research is a bonus, not a requirement: with no ollama.com key, or when the
 * search fails, the article is written without it, as before.
 */

const API = 'https://ollama.com/api';
const PAGE_CHARS = 2_500;
const TOTAL_CHARS = 10_000;
const TIMEOUT_MS = 30_000;

export interface Source {
  title: string;
  url: string;
  content: string;
}

/** Every enabled ollama.com key from Settings -> LLM endpoints. */
export function webSearchKeys(key: Buffer, fallbackBaseUrl = ''): string[] {
  const keys = listEndpoints(key, fallbackBaseUrl)
    .filter((e) => e.enabled && e.apiKey && /(^|\.)ollama\.com$/i.test(safeHost(e.baseUrl)))
    .map((e) => e.apiKey);
  return [...new Set(keys)];
}

/**
 * The keys take turns. Each article starts on the next key, and when a key
 * fails (limit reached, rejected, down) the same step carries on with the
 * following one: nothing already found is searched or read again.
 */
class KeyRing {
  private index: number;
  constructor(private readonly keys: string[]) {
    this.index = keys.length ? KeyRing.turn++ % keys.length : 0;
  }
  static turn = 0;

  async call<T>(path: string, body: unknown): Promise<T> {
    let lastError = 'no key';
    for (let tried = 0; tried < this.keys.length; tried++) {
      const used = this.index;
      try {
        return await call<T>(path, this.keys[used]!, body);
      } catch (e) {
        lastError = errorMessage(e);
        if (e instanceof PageError) throw e; // the page is the problem, not the key
        // Pages are read side by side: move on only if no other read already did.
        if (this.index === used) {
          this.index = (used + 1) % this.keys.length;
          log.warn(`key ${used + 1}/${this.keys.length} failed on ${path} (${lastError}), moving to the next`);
        }
      }
    }
    throw new Error(`every key failed: ${lastError}`);
  }
}

/** A page Ollama could not read: another key would not help. */
class PageError extends Error {}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function call<T>(path: string, apiKey: string, body: unknown): Promise<T> {
  const response = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    // 400/404/422 on a fetch is about the page; 401/402/403/429/5xx are about the key or service.
    if (path === 'web_fetch' && [400, 404, 422].includes(response.status)) {
      throw new PageError(`${path} answered ${response.status}`);
    }
    throw new Error(`${path} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

const tidy = (text: string, max: number): string =>
  text.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Search the question and read the top pages. Pages from `skipDomain` (the
 * site itself) are left out. Returns [] when anything goes wrong.
 */
export async function research(
  question: string,
  apiKeys: string | string[],
  opts: { skipDomain?: string; maxPages?: number } = {},
): Promise<Source[]> {
  const keys = (Array.isArray(apiKeys) ? apiKeys : [apiKeys]).filter(Boolean);
  if (keys.length === 0) return [];
  const ring = new KeyRing(keys);
  const maxPages = opts.maxPages ?? 4;
  const skip = (opts.skipDomain ?? '').replace(/^www\./, '').toLowerCase();
  try {
    const found = await ring.call<{ results?: { title?: string; url?: string; content?: string }[] }>(
      'web_search',
      { query: question, max_results: Math.min(10, maxPages + 3) },
    );
    const results = (found.results ?? []).filter(
      (r) => r.url && !(skip && safeHost(r.url).replace(/^www\./, '').toLowerCase().endsWith(skip)),
    ).slice(0, maxPages);

    const pages = await Promise.all(
      results.map(async (r): Promise<Source | null> => {
        try {
          const page = await ring.call<{ title?: string; content?: string }>('web_fetch', { url: r.url });
          const content = tidy(page.content || r.content || '', PAGE_CHARS);
          return content ? { title: page.title || r.title || r.url!, url: r.url!, content } : null;
        } catch (e) {
          // One unreadable page: fall back to the snippet the search gave.
          const content = tidy(r.content || '', PAGE_CHARS);
          log.warn(`could not read ${r.url}: ${errorMessage(e)}`);
          return content ? { title: r.title || r.url!, url: r.url!, content } : null;
        }
      }),
    );

    const sources: Source[] = [];
    let total = 0;
    for (const p of pages) {
      if (!p || total >= TOTAL_CHARS) continue;
      const content = p.content.slice(0, TOTAL_CHARS - total);
      sources.push({ ...p, content });
      total += content.length;
    }
    log.info(`researched "${question}": ${sources.length} source(s)`);
    return sources;
  } catch (e) {
    log.warn(`web search failed for "${question}", writing without it: ${errorMessage(e)}`);
    return [];
  }
}

/** Read one page's text through Ollama's web_fetch, the keys taking turns. */
export async function fetchPageText(url: string, apiKeys: string[]): Promise<{ title: string; content: string } | null> {
  const keys = apiKeys.filter(Boolean);
  if (keys.length === 0) return null;
  try {
    const page = await new KeyRing(keys).call<{ title?: string; content?: string }>('web_fetch', { url });
    const content = tidy(page.content ?? '', PAGE_CHARS);
    return content ? { title: page.title ?? url, content } : null;
  } catch (e) {
    log.warn(`could not read ${url}: ${errorMessage(e)}`);
    return null;
  }
}

/** The notes block handed to the writer. */
export function formatResearch(sources: Source[]): string {
  if (sources.length === 0) return 'No web research is available for this question. Rely on well-established cooking and food-safety knowledge only.';
  return sources
    .map((s, i) => `[Source ${i + 1}] ${s.title} (${s.url})\n${s.content}`)
    .join('\n\n');
}
