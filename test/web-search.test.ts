import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatResearch, research } from '../src/llm/web-search.js';
import { setLogLevel } from '../src/lib/logger.js';

/** Blog research: search, read the top pages, skip the site itself, never fail the article. */

setLogLevel('error');
afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (path: string, body: Record<string, unknown>) => unknown) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    const path = url.split('/api/')[1]!;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push(`${path}:${String(body.url ?? body.query)}`);
    const out = handler(path, body);
    if (out instanceof Error) return new Response('no', { status: 500 });
    return new Response(JSON.stringify(out), { status: 200 });
  }));
  return calls;
}

describe('research', () => {
  it('reads the top pages and leaves out the site itself', async () => {
    const calls = stubFetch((path, body) =>
      path === 'web_search'
        ? { results: [
            { title: 'Mine', url: 'https://www.x.com/blog/rice', content: 'own' },
            { title: 'USDA', url: 'https://usda.gov/rice', content: 'snippet' },
            { title: 'Blog', url: 'https://other.com/rice', content: 'snippet2' },
          ] }
        : body.url === 'https://other.com/rice'
          ? new Error('down')
          : { title: 'USDA page', content: 'Cooked rice keeps 3-4 days   in the fridge.' },
    );
    const sources = await research('How long does cooked rice last?', 'key', { skipDomain: 'x.com' });
    expect(calls).not.toContain('web_fetch:https://www.x.com/blog/rice');
    expect(sources.map((s) => s.url)).toEqual(['https://usda.gov/rice', 'https://other.com/rice']);
    expect(sources[0]!.content).toBe('Cooked rice keeps 3-4 days in the fridge.');
    expect(sources[1]!.content).toBe('snippet2'); // unreadable page falls back to its snippet
    expect(formatResearch(sources)).toContain('[Source 1] USDA page (https://usda.gov/rice)');
  });

  it('returns nothing, without throwing, when search fails or there is no key', async () => {
    stubFetch(() => new Error('x'));
    expect(await research('q', 'key')).toEqual([]);
    expect(await research('q', '')).toEqual([]);
    expect(formatResearch([])).toMatch(/No web research/);
  });
});

describe('several keys', () => {
  it('carries on with the next key when one is spent, without searching again', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const k = init.headers.Authorization!.slice(7);
      const path = url.split('/api/')[1]!;
      seen.push(`${path}:${k}`);
      if (k === 'spent' && path === 'web_fetch') return new Response('limit', { status: 429 });
      return new Response(JSON.stringify(path === 'web_search'
        ? { results: [{ title: 'A', url: 'https://a.com/x', content: 's' }] }
        : { title: 'A', content: 'page text' }), { status: 200 });
    }));
    const sources = await research('q', ['spent', 'fresh'], { maxPages: 1 });
    expect(sources[0]!.content).toBe('page text');
    expect(seen.filter((c) => c.startsWith('web_search'))).toHaveLength(1);
    expect(seen.at(-1)).toBe('web_fetch:fresh');
  });
});
