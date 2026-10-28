import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { listBufferAccounts, upsertBufferAccount, upsertSite } from '../src/db/repos.js';
import { BufferClient } from '../src/integrations/buffer.js';
import { BufferPool, isBufferExhausted } from '../src/integrations/buffer-pool.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Buffer's API limit (HTTP 429, RATE_LIMIT_EXCEEDED, counted over 30 days).
 *
 * Every post used to ask Buffer for the organization and the channels first,
 * three or four requests before the one that posts, and a token over the
 * limit was reported as "No Buffer account can take the video pin ... Connect
 * that channel in Buffer" -- never benched, so every retry spent more.
 */

const KEY = randomBytes(32);
const LIMIT = JSON.stringify({ errors: [{ message: 'Too many requests from this client.', extensions: { code: 'RATE_LIMIT_EXCEEDED', window: '30d' } }] });

const seedSite = () =>
  upsertSite({ name: 'd', domain: 'd.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);

function buffer(limited: Set<string>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).Authorization).replace('Bearer ', '');
    const query = String(init.body);
    calls.push(`${token} ${query.includes('GetOrganizations') ? 'orgs' : query.includes('GetChannelsWithBoards') ? 'channels' : 'post'}`);
    if (limited.has(token)) return new Response(LIMIT, { status: 429 });
    const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (query.includes('GetOrganizations')) return json({ account: { organizations: [{ id: `org-${token}`, name: token }] } });
    if (query.includes('GetChannelsWithBoards')) {
      return json({ channels: [{ id: `ch-${token}`, name: 'pin', service: 'pinterest', metadata: { boards: [{ serviceId: `b-${token}`, name: 'Desserts' }] } }] });
    }
    return json({ createPost: { post: { id: `post-${token}` } } });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return calls;
}

const pin = { text: 't', title: 'T', linkUrl: 'https://d.com/r', videoUrl: 'https://d.com/v.mp4' };
let originalFetch: typeof fetch;

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  originalFetch = globalThis.fetch;
  BufferClient.caching = true;
  BufferClient.forget();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  BufferClient.caching = false;
  BufferClient.forget();
  closeDatabase();
});

describe("Buffer's API limit", () => {
  it('reads a token\'s organizations and channels once, not before every post', async () => {
    const siteId = seedSite();
    upsertBufferAccount({ siteId, label: 'A', token: 'tok-a', enabled: true }, KEY);
    const calls = buffer(new Set());
    for (let i = 0; i < 3; i++) await new BufferPool({ id: siteId, domain: 'd.com', pinUsername: '' }, KEY).createVideoPin(pin, 'Desserts');
    expect(calls.filter((c) => c.endsWith('post'))).toHaveLength(3);
    expect(calls.filter((c) => !c.endsWith('post')).length).toBeLessThanOrEqual(2);
  });

  it('a token over the limit sits out a day, the next token posts, and it is not asked again', async () => {
    const siteId = seedSite();
    upsertBufferAccount({ siteId, label: 'A', token: 'tok-a', enabled: true }, KEY);
    upsertBufferAccount({ siteId, label: 'B', token: 'tok-b', enabled: true }, KEY);
    const calls = buffer(new Set(['tok-a']));

    const first = await new BufferPool({ id: siteId, domain: 'd.com', pinUsername: '' }, KEY).createVideoPin(pin, 'Desserts');
    expect(first.account).toBe('B');
    const a = listBufferAccounts(siteId, KEY).find((x) => x.label === 'A')!;
    expect(a.fullUntil!.getTime()).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1000);

    const before = calls.filter((c) => c.startsWith('tok-a')).length;
    await new BufferPool({ id: siteId, domain: 'd.com', pinUsername: '' }, KEY).createVideoPin(pin, 'Desserts');
    expect(calls.filter((c) => c.startsWith('tok-a')).length).toBe(before);
  });

  it('every token over the limit: a wait the reel retries on its own, not "connect that channel"', async () => {
    const siteId = seedSite();
    upsertBufferAccount({ siteId, label: 'A', token: 'tok-a', enabled: true }, KEY);
    buffer(new Set(['tok-a']));
    const err = await new BufferPool({ id: siteId, domain: 'd.com', pinUsername: '' }, KEY).createVideoPin(pin, 'Desserts').catch((e) => e);
    expect(isBufferExhausted(err)).toBe(true);
    expect(String(err.message)).toMatch(/API limit/);
    expect(String(err.message)).not.toMatch(/Connect that channel/);

    const again = await new BufferPool({ id: siteId, domain: 'd.com', pinUsername: '' }, KEY).createVideoPin(pin, 'Desserts').catch((e) => e);
    expect(isBufferExhausted(again)).toBe(true);
  });
});
