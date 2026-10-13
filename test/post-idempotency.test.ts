import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteApiClient } from '../src/integrations/site-api.js';

/** Every attempt of one run carries the same key, so the site can refuse to make a second copy. */
afterEach(() => vi.unstubAllGlobals());

describe('posting a recipe', () => {
  it('sends the Idempotency-Key it is given', async () => {
    const seen: (string | null)[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('Idempotency-Key'));
      return new Response(JSON.stringify({ id: 7, href: '/recipe/x' }), { status: 201 });
    }));
    const api = new SiteApiClient('example.com', 'tok');
    await api.postRecipe({ title: 'x' }, 'run-12');
    await api.postRecipe({ title: 'x' });
    expect(seen).toEqual(['run-12', null]);
  });
});
