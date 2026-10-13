import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FacebookClient, FacebookError } from '../src/integrations/facebook.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Publishing a Reel is four steps, and the fourth is the one worth testing.
 *
 * Facebook accepts an upload, returns a video id, and only then transcodes —
 * so a video it is going to reject looks exactly like a video it is going to
 * publish for the first minute or two. Treating the upload as success is how a
 * rejection gets recorded as a publish, and the operator finds out by looking
 * at a page that has nothing on it.
 */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Facebook's surface, as far as this client is concerned. */
function fakeGraph(
  options: {
    /** video_status values returned in order; the last one repeats. */
    statuses?: string[];
    pageToken?: string;
    failAt?: 'token' | 'start' | 'upload' | 'finish';
  } = {},
): { fetch: ReturnType<typeof vi.fn>; calls: Call[] } {
  const calls: Call[] = [];
  const statuses = options.statuses ?? ['ready'];
  let polls = 0;

  const reply = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const graphError = (message: string): Response =>
    reply({ error: { message, type: 'OAuthException', code: 100 } }, 400);

  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });

    if (url.includes('fields=access_token')) {
      if (options.failAt === 'token') return graphError('No role on this page');
      return reply({ access_token: options.pageToken ?? 'PAGE_TOKEN' });
    }

    if (url.includes('/video_reels') && String(init?.body ?? '').includes('start')) {
      if (options.failAt === 'start') return graphError('Cannot start upload');
      return reply({ video_id: 'VID1', upload_url: 'https://rupload.facebook.com/VID1' });
    }

    if (url.includes('rupload.facebook.com')) {
      if (options.failAt === 'upload') return graphError('Upload rejected');
      return reply({ success: true });
    }

    if (url.includes('upload_phase=finish')) {
      if (options.failAt === 'finish') return graphError('Cannot publish');
      return reply({ success: true });
    }

    if (url.includes('fields=status')) {
      const state = statuses[Math.min(polls, statuses.length - 1)]!;
      polls += 1;
      return reply({ status: { video_status: state } });
    }

    if (url.includes('/me/accounts')) {
      return reply({ data: [{ id: '1', name: 'Slow Cooker Suppers' }] });
    }

    return reply({});
  });

  return { fetch, calls };
}

const client = (): FacebookClient =>
  new FacebookClient({ systemUserToken: 'SYSTEM', pollIntervalMs: 0, maxAttempts: 5 });

const publish = (c: FacebookClient) =>
  c.publishReel({
    pageId: '12345',
    video: Buffer.from('not really an mp4'),
    description: 'A slow cooker stew',
  });

describe('publishing a reel', () => {
  beforeEach(() => setLogLevel('error'));
  afterEach(() => vi.unstubAllGlobals());

  it('walks start, upload, finish, then waits for Facebook', async () => {
    const graph = fakeGraph();
    vi.stubGlobal('fetch', graph.fetch);

    const result = await publish(client());

    expect(result.videoId).toBe('VID1');
    expect(result.permalink).toContain('VID1');

    const urls = graph.calls.map((c) => c.url);
    expect(urls[0]).toContain('fields=access_token');
    expect(urls[1]).toContain('/video_reels');
    expect(urls[2]).toContain('rupload.facebook.com');
    expect(urls[3]).toContain('upload_phase=finish');
    expect(urls[4]).toContain('fields=status');
  });

  it('sends the bytes with the page token in an OAuth header', async () => {
    // The one endpoint in this API that wants the token in a header rather
    // than a query parameter. Getting it wrong is a 400 with no explanation.
    const graph = fakeGraph();
    vi.stubGlobal('fetch', graph.fetch);

    await publish(client());

    const upload = graph.calls.find((c) => c.url.includes('rupload'))!;
    expect(upload.headers.Authorization).toBe('OAuth PAGE_TOKEN');
    expect(upload.headers.offset).toBe('0');
    expect(upload.headers.file_size).toBe('17');
  });

  it('mints a fresh page token rather than using the system token', async () => {
    const graph = fakeGraph();
    vi.stubGlobal('fetch', graph.fetch);

    await publish(client());

    const finish = graph.calls.find((c) => c.url.includes('upload_phase=finish'))!;
    expect(finish.url).toContain('access_token=PAGE_TOKEN');
    expect(finish.url).not.toContain('SYSTEM');
  });

  it('names the reel, so Facebook does not list it as "Untitled Video"', async () => {
    const graph = fakeGraph();
    vi.stubGlobal('fetch', graph.fetch);

    await client().publishReel({
      pageId: '12345',
      video: Buffer.from('not really an mp4'),
      description: 'A slow cooker stew',
      title: '  Slow Cooker   Beef Stew ',
    });

    const finish = new URL(graph.calls.find((c) => c.url.includes('upload_phase=finish'))!.url);
    expect(finish.searchParams.get('title')).toBe('Slow Cooker Beef Stew');
  });

  it('sends no title when there is none', async () => {
    const graph = fakeGraph();
    vi.stubGlobal('fetch', graph.fetch);

    await publish(client());

    const finish = new URL(graph.calls.find((c) => c.url.includes('upload_phase=finish'))!.url);
    expect(finish.searchParams.has('title')).toBe(false);
  });

  it('fails when Facebook rejects the video during processing', async () => {
    // The case that matters: everything succeeded and the reel is not live.
    const graph = fakeGraph({ statuses: ['processing', 'error'] });
    vi.stubGlobal('fetch', graph.fetch);

    await expect(publish(client())).rejects.toThrow(/rejected/i);
  });

  it('keeps polling while the video is still processing', async () => {
    const graph = fakeGraph({ statuses: ['processing', 'processing', 'ready'] });
    vi.stubGlobal('fetch', graph.fetch);

    await expect(publish(client())).resolves.toBeDefined();
    expect(graph.calls.filter((c) => c.url.includes('fields=status'))).toHaveLength(3);
  });

  it('gives up rather than hanging when processing never finishes', async () => {
    const graph = fakeGraph({ statuses: ['processing'] });
    vi.stubGlobal('fetch', graph.fetch);

    await expect(publish(client())).rejects.toThrow(/still processing/i);
  });

  it('reports a Graph error envelope returned with HTTP 200', async () => {
    // Graph answers 200 with an error object often enough that checking the
    // status alone lets failures through as success.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Session expired' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(publish(client())).rejects.toThrow(/Session expired/);
  });

  it('says so plainly when the system user has no role on the page', async () => {
    const graph = fakeGraph({ failAt: 'token' });
    vi.stubGlobal('fetch', graph.fetch);

    await expect(publish(client())).rejects.toThrow(/No role on this page/);
  });

  it('stops at the failing phase instead of carrying on', async () => {
    const graph = fakeGraph({ failAt: 'start' });
    vi.stubGlobal('fetch', graph.fetch);

    await expect(publish(client())).rejects.toThrow(/Cannot start upload/);
    expect(graph.calls.some((c) => c.url.includes('rupload'))).toBe(false);
  });

  it('refuses to publish with no token rather than calling Facebook', async () => {
    const graph = fakeGraph();
    vi.stubGlobal('fetch', graph.fetch);

    const bare = new FacebookClient({ systemUserToken: '   ' });
    expect(bare.configured).toBe(false);

    await expect(publish(bare)).rejects.toThrow(FacebookError);
    expect(graph.fetch).not.toHaveBeenCalled();
  });

  it('verifies a token by listing pages, publishing nothing', async () => {
    const graph = fakeGraph();
    vi.stubGlobal('fetch', graph.fetch);

    const check = await client().healthCheck();

    expect(check).toEqual({ ok: true, pages: 1 });
    expect(graph.calls.every((c) => !c.url.includes('video_reels'))).toBe(true);
  });

  it('reports a bad token from the health check instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Invalid OAuth token' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const check = await client().healthCheck();

    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/Invalid OAuth token/);
  });
});

/**
 * The article link goes in the first comment, never the caption. A link in
 * the description is what Facebook's ranking reads as an exit and what makes
 * a post look like an ad; a comment carries it fine and still gets tapped.
 */
describe('commenting the link on a reel', () => {
  beforeEach(() => setLogLevel('error'));
  afterEach(() => vi.unstubAllGlobals());

  it('posts the message to the video as the page', async () => {
    const graph = fakeGraph();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.endsWith('/VID1/comments')) {
          graph.calls.push({
            url,
            method: init?.method ?? 'GET',
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: init?.body,
          });
          return new Response(JSON.stringify({ id: 'VID1_C1' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return graph.fetch(input, init);
      }),
    );

    const result = await client().commentOnReel({
      pageId: '12345',
      videoId: 'VID1',
      message: 'https://example.com/recipes/stew',
    });

    expect(result.commentId).toBe('VID1_C1');
    const comment = graph.calls.find((c) => c.url.endsWith('/VID1/comments'))!;
    expect(comment.method).toBe('POST');
    const body = JSON.parse(String(comment.body)) as { message: string; access_token: string };
    expect(body.message).toBe('https://example.com/recipes/stew');
    // As the page, with the page token -- not the system user token.
    expect(body.access_token).toBe('PAGE_TOKEN');
  });

  it('surfaces a missing permission as an error rather than a silent absence', async () => {
    const graph = fakeGraph();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.endsWith('/comments')) {
          return new Response(
            JSON.stringify({ error: { message: '(#200) Requires pages_manage_engagement' } }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return graph.fetch(input, init);
      }),
    );

    await expect(
      client().commentOnReel({ pageId: '12345', videoId: 'VID1', message: 'x' }),
    ).rejects.toThrow(FacebookError);
  });
});
