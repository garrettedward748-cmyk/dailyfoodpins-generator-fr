import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  candidatesFor,
  listEndpoints,
  listEndpointRows,
  markFailure,
  markSuccess,
  resetEndpointHealth,
  upsertEndpoint,
} from '../src/llm/pool.js';
import { chat, NoEndpointAvailableError } from '../src/llm/client.js';

const KEY = randomBytes(32);

function addEndpoint(name: string, models: string[], baseUrl = `http://${name}:11434`): void {
  upsertEndpoint({ name, baseUrl, apiKey: 'k', models, enabled: true }, KEY);
}

/** Build a fetch stub whose behaviour is decided per endpoint host. */
function stubFetch(handler: (host: string) => Response | Promise<Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const host = new URL(url).hostname;
    return handler(host);
  });
}

const okResponse = (content: string): Response =>
  new Response(JSON.stringify({ message: { content } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('LLM endpoint pool', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });

  describe('selection', () => {
    it('offers only endpoints that serve the requested model', () => {
      addEndpoint('a', ['gemma4:31b']);
      addEndpoint('b', ['gpt-oss:120b']);

      expect(candidatesFor('gemma4:31b', KEY).map((e) => e.name)).toEqual(['a']);
      expect(candidatesFor('gpt-oss:120b', KEY).map((e) => e.name)).toEqual(['b']);
    });

    it('treats an endpoint with no declared models as serving everything', () => {
      addEndpoint('catch-all', []);
      expect(candidatesFor('anything:latest', KEY).map((e) => e.name)).toEqual(['catch-all']);
    });

    it('excludes disabled endpoints', () => {
      upsertEndpoint(
        { name: 'off', baseUrl: 'http://off:11434', apiKey: '', models: [], enabled: false },
        KEY,
      );
      expect(candidatesFor('gemma4:31b', KEY)).toHaveLength(0);
    });

    it('prefers the least recently used endpoint', () => {
      addEndpoint('a', ['m']);
      addEndpoint('b', ['m']);

      const first = candidatesFor('m', KEY)[0]!;
      markSuccess(first.id); // stamps last_used_at

      expect(candidatesFor('m', KEY)[0]?.name).not.toBe(first.name);
    });

    it('excludes an endpoint that is cooling down', () => {
      addEndpoint('a', ['m']);
      const id = listEndpoints(KEY)[0]!.id;

      markFailure(id, 'rate limited', 60_000);
      expect(candidatesFor('m', KEY)).toHaveLength(0);
    });

    it('marks an endpoint unhealthy after three consecutive failures', () => {
      addEndpoint('a', ['m']);
      const id = listEndpoints(KEY)[0]!.id;

      markFailure(id, 'boom');
      markFailure(id, 'boom');
      expect(listEndpoints(KEY)[0]?.healthy).toBe(true);

      markFailure(id, 'boom');
      expect(listEndpoints(KEY)[0]?.healthy).toBe(false);
    });

    it('a success clears the failure streak', () => {
      addEndpoint('a', ['m']);
      const id = listEndpoints(KEY)[0]!.id;

      markFailure(id, 'boom');
      markFailure(id, 'boom');
      markSuccess(id);

      const endpoint = listEndpoints(KEY)[0]!;
      expect(endpoint.consecutiveFails).toBe(0);
      expect(endpoint.healthy).toBe(true);
    });

    it('health can be reset by hand from the UI', () => {
      addEndpoint('a', ['m']);
      const id = listEndpoints(KEY)[0]!.id;
      for (let i = 0; i < 3; i++) markFailure(id, 'boom');

      resetEndpointHealth(id);
      expect(listEndpoints(KEY)[0]?.healthy).toBe(true);
    });
  });

  describe('failover', () => {
    it('THE REQUIREMENT: moves to the next endpoint when one fails', async () => {
      addEndpoint('a', ['m']);
      addEndpoint('b', ['m']);

      vi.stubGlobal(
        'fetch',
        stubFetch((host) =>
          host === 'a' ? new Response('down', { status: 500 }) : okResponse('generated'),
        ),
      );

      const result = await chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, KEY);

      expect(result.content).toBe('generated');
      expect(result.endpoint).toBe('b');
      expect(result.attempts).toBe(2);
    });

    it('honours a 429 by cooling that endpoint down and using another', async () => {
      addEndpoint('a', ['m']);
      addEndpoint('b', ['m']);

      vi.stubGlobal(
        'fetch',
        stubFetch((host) =>
          host === 'a'
            ? new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })
            : okResponse('ok'),
        ),
      );

      const result = await chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, KEY);
      expect(result.endpoint).toBe('b');

      const a = listEndpoints(KEY).find((e) => e.name === 'a')!;
      expect(a.cooldownUntil).not.toBeNull();
      expect(a.lastError).toContain('Rate limited');
    });

    it('walks the whole pool before giving up', async () => {
      addEndpoint('a', ['m']);
      addEndpoint('b', ['m']);
      addEndpoint('c', ['m']);

      const fetchStub = stubFetch(() => new Response('nope', { status: 500 }));
      vi.stubGlobal('fetch', fetchStub);

      await expect(
        chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, KEY),
      ).rejects.toThrow(NoEndpointAvailableError);

      expect(fetchStub).toHaveBeenCalledTimes(3);
    });

    it('names every endpoint it tried in the failure message', async () => {
      addEndpoint('alpha', ['m']);
      addEndpoint('beta', ['m']);
      vi.stubGlobal('fetch', stubFetch(() => new Response('nope', { status: 500 })));

      await expect(
        chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, KEY),
      ).rejects.toThrow(/alpha, beta/);
    });

    it('explains clearly when no endpoint serves the model at all', async () => {
      addEndpoint('a', ['other-model']);

      await expect(
        chat({ model: 'missing:1b', messages: [{ role: 'user', content: 'x' }] }, KEY),
      ).rejects.toThrow(/no enabled endpoint serves model "missing:1b"/);
    });

    it('retries unhealthy endpoints rather than refusing to run', async () => {
      // A stale health flag must never be the sole reason nothing can publish.
      addEndpoint('a', ['m']);
      const id = listEndpoints(KEY)[0]!.id;
      for (let i = 0; i < 3; i++) markFailure(id, 'boom');
      expect(candidatesFor('m', KEY)).toHaveLength(0);

      vi.stubGlobal('fetch', stubFetch(() => okResponse('recovered')));

      const result = await chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, KEY);
      expect(result.content).toBe('recovered');
      expect(listEndpoints(KEY)[0]?.healthy).toBe(true);
    });

    it('treats an empty completion as a failure and fails over', async () => {
      addEndpoint('a', ['m']);
      addEndpoint('b', ['m']);

      vi.stubGlobal(
        'fetch',
        stubFetch((host) => (host === 'a' ? okResponse('   ') : okResponse('real content'))),
      );

      const result = await chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, KEY);
      expect(result.endpoint).toBe('b');
    });

    it('records which endpoint served the request', async () => {
      addEndpoint('only', ['m']);
      vi.stubGlobal('fetch', stubFetch(() => okResponse('x')));

      const result = await chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, KEY);
      expect(result.endpoint).toBe('only');
      expect(result.model).toBe('m');
    });
  });

  describe('credential storage', () => {
    it('never stores an API key in plaintext', () => {
      upsertEndpoint(
        {
          name: 'a',
          baseUrl: 'http://a:11434',
          apiKey: 'sk-super-secret-value',
          models: ['m'],
          enabled: true,
        },
        KEY,
      );

      // Decrypted when read through the pool...
      expect(listEndpoints(KEY)[0]?.apiKey).toBe('sk-super-secret-value');

      // ...but the column itself is ciphertext.
      const stored = listEndpointRows()[0]!.api_key_encrypted;
      expect(stored).not.toContain('sk-super-secret-value');
      expect(stored.startsWith('v1.')).toBe(true);
    });

    it('keeps the existing key when updated with a blank one', () => {
      addEndpoint('a', ['m']);
      upsertEndpoint(
        { name: 'a', baseUrl: 'http://new:11434', apiKey: '', models: ['m'], enabled: true },
        KEY,
      );

      const endpoint = listEndpoints(KEY)[0]!;
      expect(endpoint.baseUrl).toBe('http://new:11434');
      expect(endpoint.apiKey).toBe('k');
    });
  });
});
