import { afterEach, describe, expect, it, vi } from 'vitest';
import { FacebookClient } from '../src/integrations/facebook.js';

/**
 * A comment on a reel names the post, not the video the reel is recorded
 * under; videoIdOfPost is how the keyword handler gets from one to the other.
 */
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('videoIdOfPost', () => {
  it('returns the video an attachment points at', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'PAGE_TOKEN' }))
      .mockResolvedValueOnce(json({ attachments: { data: [{ target: { id: '1042829955471244' } }] } }));
    vi.stubGlobal('fetch', fetchMock);

    const id = await new FacebookClient({ systemUserToken: 'SYS' }).videoIdOfPost('253', '253_1222');

    expect(id).toBe('1042829955471244');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/253_1222?');
  });

  it('returns nothing when the post has no attachment', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ access_token: 'P' })).mockResolvedValueOnce(json({})));
    expect(await new FacebookClient({ systemUserToken: 'SYS' }).videoIdOfPost('253', '253_1222')).toBeUndefined();
  });
});
