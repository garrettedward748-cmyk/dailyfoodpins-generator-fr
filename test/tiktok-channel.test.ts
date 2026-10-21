import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, closeDatabase, get, openDatabase } from '../src/db/index.js';
import { addProfile, firstProfile, listProfiles, upsertSite } from '../src/db/repos.js';
import { BufferClient } from '../src/integrations/buffer.js';
import { setLogLevel } from '../src/lib/logger.js';

/** TikTok as a fifth network: the reel's video, with accounts of its own. */

const KEY = randomBytes(32);
beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => closeDatabase());

const site = (domain = 's.com') =>
  upsertSite({ name: domain, domain, status: 'active', pin_username: 'buzz', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);

describe('the migration that added tiktok to channel_profiles', () => {
  it('accepts tiktok as a platform, which the old constraint refused', () => {
    const id = site();
    const profile = firstProfile(id, 'tiktok');
    expect(profile.platform).toBe('tiktok');
    expect(listProfiles(id, 'tiktok')).toHaveLength(1);
    expect(addProfile(id, 'tiktok')).toBeGreaterThan(0);
    expect(listProfiles(id, 'tiktok')).toHaveLength(2);
  });

  it('still refuses a platform that is not a network', () => {
    const id = site();
    expect(() => all('INSERT INTO channel_profiles (site_id, platform) VALUES (?, ?)', id, 'twitter')).toThrow();
  });

  it('gives every site a TikTok slot and a switch that starts off', () => {
    const id = site('fresh.com');
    expect(get<{ tt_reels: number }>('SELECT tt_reels FROM sites WHERE id = ?', id)!.tt_reels).toBe(0);
  });
});

describe('the TikTok video itself', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The client's one HTTP call, captured rather than sent. */
  const capture = (): string[] => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
      sent.push(JSON.parse(String(init.body)).query as string);
      return new Response(JSON.stringify({ data: { createPost: { post: { id: 'p_1' } } } }), { status: 200 });
    }));
    return sent;
  };

  it('sends the video with the caption as its text, as a bare enum privacy level', async () => {
    const sent = capture();
    const id = await new BufferClient('tok').createTikTokPost({
      channelId: 'c_1',
      text: 'Garlic Butter Salmon Bites\n\nQuick, crispy, ten minutes.',
      videoUrl: 'https://s.com/v.mp4',
    });
    expect(id).toBe('p_1');
    const query = sent[0]!;
    expect(query).toContain('CreateTikTokPost');
    expect(query).toContain('"c_1"');
    expect(query).toContain('video: { url: "https://s.com/v.mp4" }');
    expect(query).toContain('Garlic Butter Salmon Bites');
    // Sent unquoted first: it reads as TikTok's own enum constant.
    expect(query).toContain('privacyLevel: PUBLIC_TO_EVERYONE');
  });

  it("stays inside TikTok's 2,200 characters", async () => {
    const sent = capture();
    await new BufferClient('tok').createTikTokPost({
      channelId: 'c_1', text: 'x'.repeat(2300), videoUrl: 'https://s.com/v.mp4',
    });
    const text = sent[0]!.match(/text: "(x+)"/)![1]!;
    expect(text).toHaveLength(2200);
  });

  it('drops a metadata field Buffer does not know and sends the video again', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
      const query = JSON.parse(String(init.body)).query as string;
      queries.push(query);
      if (/isAiGenerated/.test(query)) {
        return new Response(JSON.stringify({
          errors: [{ message: 'Field "isAiGenerated" is not defined by type "TiktokPostMetadataInput".' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { createPost: { post: { id: 'p_2' } } } }), { status: 200 });
    }));

    const id = await new BufferClient('tok').createTikTokPost({
      channelId: 'c_1', text: 'Lemon Bars', videoUrl: 'https://s.com/v.mp4',
    });

    expect(id).toBe('p_2');
    expect(queries).toHaveLength(2);
    expect(queries[1]).not.toContain('isAiGenerated');
    expect(queries[1]).toContain('Lemon Bars');
    expect(queries[1]).toContain('https://s.com/v.mp4');
  });

  it('renames any field Buffer suggests a name for, keeping the rest intact', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
      const query = JSON.parse(String(init.body)).query as string;
      queries.push(query);
      if (/isAiGenerated:/.test(query)) {
        return new Response(JSON.stringify({
          errors: [{ message: 'Field "isAiGenerated" is not defined by type "TiktokPostMetadataInput". Did you mean "aiGenerated"?' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { createPost: { post: { id: 'p_5' } } } }), { status: 200 });
    }));

    const id = await new BufferClient('tok').createTikTokPost({
      channelId: 'c_1', text: 'Lemon Bars', videoUrl: 'v', privacyLevel: 'PUBLIC_TO_EVERYONE',
    });
    expect(id).toBe('p_5');
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain('aiGenerated: true');
    expect(queries[1]).toContain('text: "Lemon Bars"');
    expect(queries[1]).toContain('privacyLevel: PUBLIC_TO_EVERYONE');
  });

  it('quotes privacyLevel when Buffer refuses the bare enum by type, and keeps the rest', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
      const query = JSON.parse(String(init.body)).query as string;
      queries.push(query);
      if (/privacyLevel: PUBLIC_TO_EVERYONE/.test(query)) {
        return new Response(JSON.stringify({
          errors: [{ message: 'String cannot represent value for field "privacyLevel" of type "TiktokPrivacyLevel".' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { createPost: { post: { id: 'p_6' } } } }), { status: 200 });
    }));

    const id = await new BufferClient('tok').createTikTokPost({
      channelId: 'c_1', text: 'Lemon Bars', videoUrl: 'v',
    });
    expect(id).toBe('p_6');
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain('privacyLevel: "PUBLIC_TO_EVERYONE"');
    expect(queries[1]).toContain('text: "Lemon Bars"');
  });

  it('drops privacyLevel when the live schema has no such field, and posts anyway', async () => {
    // The real failure seen in production: Buffer's TikTok input type has no
    // privacyLevel field at all, so it is rejected as unknown (not as a bad
    // value). It must be dropped and the video sent without it -- Buffer sets
    // the privacy from the channel -- rather than failing the post outright.
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
      const query = JSON.parse(String(init.body)).query as string;
      queries.push(query);
      if (/privacyLevel/.test(query)) {
        return new Response(JSON.stringify({
          errors: [{ message: 'Field "privacyLevel" is not defined by type "TikTokPostMetadataInput".' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { createPost: { post: { id: 'p_8' } } } }), { status: 200 });
    }));

    const id = await new BufferClient('tok').createTikTokPost({
      channelId: 'c_1', text: 'Lemon Bars', videoUrl: 'https://s.com/v.mp4',
    });
    expect(id).toBe('p_8');
    expect(queries[queries.length - 1]).not.toContain('privacyLevel');
    expect(queries[queries.length - 1]).toContain('Lemon Bars');
    expect(queries[queries.length - 1]).toContain('https://s.com/v.mp4');
  });

  it('flips privacyLevel back to unquoted when a quoted value is refused instead', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
      const query = JSON.parse(String(init.body)).query as string;
      queries.push(query);
      if (/privacyLevel: "self_only"/.test(query)) {
        return new Response(JSON.stringify({
          errors: [{ message: 'Expected type "TiktokPrivacyLevel", found "self_only" for field "privacyLevel".' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { createPost: { post: { id: 'p_7' } } } }), { status: 200 });
    }));

    // A lower-case value is sent quoted first; this proves the flip runs the
    // other way too, not only quoted->unquoted as YouTube's idQuoted does.
    const id = await new BufferClient('tok').createTikTokPost({
      channelId: 'c_1', text: 'b', videoUrl: 'v', privacyLevel: 'self_only',
    });
    expect(id).toBe('p_7');
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain('privacyLevel: self_only');
  });

  it('lets an unrelated GraphQL error stand rather than retrying forever', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify({ errors: [{ message: 'Rate limit exceeded' }] }), { status: 200 });
    }));
    await expect(
      new BufferClient('tok').createTikTokPost({ channelId: 'c', text: 'b', videoUrl: 'v' }),
    ).rejects.toThrow(/Rate limit/);
    expect(calls).toBe(1);
  });

  it('passes on what Buffer said when it refuses, instead of a blank failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: { createPost: { message: 'channel not connected' } } }), { status: 200 }),
    ));
    await expect(
      new BufferClient('tok').createTikTokPost({ channelId: 'c', text: 'b', videoUrl: 'v' }),
    ).rejects.toThrow(/channel not connected/);
  });
});

describe('Buffer refusing a TikTok field in its newer wording', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('drops privacyLevel and sends the video again', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
      const query = JSON.parse(String(init.body)).query as string;
      queries.push(query);
      if (/privacyLevel:/.test(query)) {
        return new Response(JSON.stringify({
          errors: [{ message: 'Expected value of type "TikTokPostMetadataInput" not to include unknown field "privacyLevel", found: { privacyLevel: PUBLIC_TO_EVERYONE, isAiGenerated: true }.' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { createPost: { post: { id: 'p_9' } } } }), { status: 200 });
    }));

    const id = await new BufferClient('tok').createTikTokPost({ channelId: 'c_1', text: 'Cookies', videoUrl: 'v' });

    expect(id).toBe('p_9');
    expect(queries).toHaveLength(2);
    expect(queries[1]).not.toContain('privacyLevel');
    expect(queries[1]).toContain('isAiGenerated: true');
  });
});
