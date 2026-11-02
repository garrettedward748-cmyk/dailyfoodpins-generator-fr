import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { listBufferAccounts, upsertBufferAccount, upsertSite } from '../src/db/repos.js';
import { BufferClient } from '../src/integrations/buffer.js';
import { BUFFER_API_LIMIT, BufferPool, isBufferExhausted } from '../src/integrations/buffer-pool.js';
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

  it('a token over the limit is never marked full: the next token posts, and it is asked again next time', async () => {
    const siteId = seedSite();
    upsertBufferAccount({ siteId, label: 'A', token: 'tok-a', enabled: true }, KEY);
    upsertBufferAccount({ siteId, label: 'B', token: 'tok-b', enabled: true }, KEY);
    const limited = new Set(['tok-a']);
    buffer(limited);

    const first = await new BufferPool({ id: siteId, domain: 'd.com', pinUsername: '' }, KEY).createVideoPin(pin, 'Desserts');
    expect(first.account).toBe('B');
    const a = listBufferAccounts(siteId, KEY).find((x) => x.label === 'A')!;
    expect(a.fullUntil).toBeNull();
    expect(a.lastError).toBeNull();

    limited.clear();
    const second = await new BufferPool({ id: siteId, domain: 'd.com', pinUsername: '' }, KEY).createVideoPin(pin, 'Desserts');
    expect(second.account).toBe('A');
  });

  it('the lookups a run starts with move to the next token too, with its own organization', async () => {
    const siteId = seedSite();
    upsertBufferAccount({ siteId, label: 'A', token: 'tok-a', enabled: true }, KEY);
    upsertBufferAccount({ siteId, label: 'B', token: 'tok-b', enabled: true }, KEY);
    buffer(new Set(['tok-a']));
    const pool = new BufferPool({ id: siteId, domain: 'd.com', pinUsername: '' }, KEY);
    const org = await pool.getOrganizationId();
    expect(org).toBe('org-tok-b');
    expect((await pool.getChannels(org))[0]!.id).toBe('ch-tok-b');
    const dest = await new BufferPool({ id: siteId, domain: 'd.com', pinUsername: '' }, KEY).resolveDestination('Desserts');
    expect(dest.channelId).toBe('ch-tok-b');
  });

  it('every token over the limit: says so, is not "full" and not "connect that channel"', async () => {
    const siteId = seedSite();
    upsertBufferAccount({ siteId, label: 'A', token: 'tok-a', enabled: true }, KEY);
    buffer(new Set(['tok-a']));
    const err = await new BufferPool({ id: siteId, domain: 'd.com', pinUsername: '' }, KEY).createVideoPin(pin, 'Desserts').catch((e) => e);
    expect(String(err.message)).toContain(BUFFER_API_LIMIT);
    expect(isBufferExhausted(err)).toBe(false);
    expect(String(err.message)).not.toMatch(/Connect that channel/);
    expect(listBufferAccounts(siteId, KEY)[0]!.fullUntil).toBeNull();
    const lookup = await new BufferPool({ id: siteId, domain: 'd.com', pinUsername: '' }, KEY).getOrganizationId().catch((e) => e);
    expect(String(lookup.message)).toContain(BUFFER_API_LIMIT);
  });

  describe('several names on Buffer', () => {
    function channels(fail: Set<string>) {
      const posted: string[] = [];
      globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
        const query = String(init.body);
        const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
        if (query.includes('GetOrganizations')) return json({ account: { organizations: [{ id: 'org', name: 'o' }] } });
        if (query.includes('GetChannelsWithBoards')) {
          return json({ channels: ['one', 'two', 'three'].map((n) => ({ id: n, name: n, service: 'pinterest', metadata: { boards: [{ serviceId: `b-${n}`, name: 'Desserts' }] } })) });
        }
        const on = (JSON.parse(query).query as string).match(/channelId: "(\w+)"/)?.[1] ?? '';
        posted.push(on);
        if (fail.has(on)) return json({ createPost: { message: 'Scheduled posts limit reached' } });
        return json({ createPost: { post: { id: `post-${on}` } } });
      }) as unknown as typeof fetch;
      return posted;
    }
    const names = (siteId: number) => new BufferPool({ id: siteId, domain: 'd.com', pinUsername: 'one', moreNames: ['two', 'three'], profileId: undefined }, KEY);

    it('stops at the first name that publishes', async () => {
      const siteId = seedSite();
      upsertBufferAccount({ siteId, label: 'A', token: 'tok-a', enabled: true }, KEY);
      const posted = channels(new Set());
      const r = await names(siteId).createVideoPin(pin, 'Desserts');
      expect(r.postId).toBe('post-one');
      expect(posted).toEqual(['one']);
    });

    it('moves on when a name does not publish', async () => {
      const siteId = seedSite();
      upsertBufferAccount({ siteId, label: 'A', token: 'tok-a', enabled: true }, KEY);
      const posted = channels(new Set(['one']));
      const r = await names(siteId).createVideoPin(pin, 'Desserts');
      expect(r.postId).toBe('post-two');
      expect(posted).toEqual(['one', 'two']);
    });

    it('says so when none publishes, in the wording the scheduler waits on', async () => {
      const siteId = seedSite();
      upsertBufferAccount({ siteId, label: 'A', token: 'tok-a', enabled: true }, KEY);
      const posted = channels(new Set(['one', 'two', 'three']));
      const err = await names(siteId).createVideoPin(pin, 'Desserts').catch((e) => e);
      expect(posted).toEqual(['one', 'two', 'three']);
      expect(String(err.message)).toContain('Not published on Buffer');
      expect(String(err.message)).toContain('"three"');
      expect(isBufferExhausted(err)).toBe(true);
    });
  });
});
