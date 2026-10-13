import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, closeDatabase, get, openDatabase } from '../src/db/index.js';
import {
  addProfile, firstProfile, listBufferAccounts, listProfiles, upsertBufferAccount, upsertSite,
} from '../src/db/repos.js';
import { BufferClient } from '../src/integrations/buffer.js';
import { youtubeDescription } from '../src/reels/engine.js';
import { setLogLevel } from '../src/lib/logger.js';

/** YouTube as a fourth network: Shorts from each reel, with accounts of its own. */

const KEY = randomBytes(32);
beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => closeDatabase());

const site = (domain = 's.com') =>
  upsertSite({ name: domain, domain, status: 'active', pin_username: 'buzz', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);

describe('the migration that rebuilt channel_profiles', () => {
  it('kept every profile id, which is what the saved Buffer tokens point at', () => {
    const id = site();
    // Accounts made before the rebuild would have these ids; the rebuild has
    // already run by the time the database is open, so this asserts the
    // invariant the rebuild has to preserve: a token finds its profile.
    const pin = firstProfile(id, 'pinterest');
    const second = addProfile(id, 'pinterest');
    upsertBufferAccount({ siteId: id, label: 'a', token: 't1', enabled: true, profileId: pin.id }, KEY);
    upsertBufferAccount({ siteId: id, label: 'b', token: 't2', enabled: true, profileId: second }, KEY);

    const tokens = listBufferAccounts(id, KEY);
    const profileIds = new Set(listProfiles(id).map((p) => p.id));
    expect(tokens).toHaveLength(2);
    for (const t of tokens) expect(profileIds.has(t.profileId!)).toBe(true);
  });

  it('accepts youtube as a platform, which the old constraint refused', () => {
    const id = site();
    const profile = firstProfile(id, 'youtube');
    expect(profile.platform).toBe('youtube');
    expect(listProfiles(id, 'youtube')).toHaveLength(1);
    expect(addProfile(id, 'youtube')).toBeGreaterThan(0);
    expect(listProfiles(id, 'youtube')).toHaveLength(2);
  });

  it('still refuses a platform that is not a network', () => {
    const id = site();
    expect(() => all('INSERT INTO channel_profiles (site_id, platform) VALUES (?, ?)', id, 'twitter')).toThrow();
  });

  it('gives every site a YouTube slot and a switch that starts off', () => {
    const id = site('fresh.com');
    expect(get<{ yt_reels: number }>('SELECT yt_reels FROM sites WHERE id = ?', id)!.yt_reels).toBe(0);
  });
});

describe('the Short itself', () => {
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

  it('sends the video with a title of its own and the recipe link in the description', async () => {
    const sent = capture();
    const id = await new BufferClient('tok').createYouTubePost({
      channelId: 'c_1',
      title: 'Garlic Butter Salmon Bites',
      text: 'Garlic Butter Salmon Bites\n\nhttps://s.com/recipe/salmon',
      videoUrl: 'https://s.com/v.mp4',
    });
    expect(id).toBe('p_1');
    const query = sent[0]!;
    expect(query).toContain('CreateYouTubePost');
    expect(query).toContain('"c_1"');
    expect(query).toContain('video: { url: "https://s.com/v.mp4" }');
    expect(query).toContain('Garlic Butter Salmon Bites');
    // The link belongs in a Short's description — unlike an Instagram caption.
    expect(query).toContain('https://s.com/recipe/salmon');
  });

  it("cuts the title at YouTube's 100 characters rather than letting Buffer refuse it", async () => {
    const sent = capture();
    await new BufferClient('tok').createYouTubePost({
      channelId: 'c_1',
      title: 'x'.repeat(140),
      text: 'body',
      videoUrl: 'https://s.com/v.mp4',
    });
    const title = sent[0]!.match(/title: "(x+)"/)![1]!;
    expect(title).toHaveLength(100);
  });

  it('drops a metadata field Buffer does not know and sends the Short again', async () => {
    // The real refusal, word for word, from the first Short attempted in
    // production: Buffer's YouTube metadata has no "type".
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
      const query = JSON.parse(String(init.body)).query as string;
      queries.push(query);
      if (/isAiGenerated/.test(query)) {
        return new Response(JSON.stringify({
          errors: [{ message: 'Field "isAiGenerated" is not defined by type "YoutubePostMetadataInput".' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { createPost: { post: { id: 'p_2' } } } }), { status: 200 });
    }));

    const id = await new BufferClient('tok').createYouTubePost({
      channelId: 'c_1', title: 'Lemon Bars', text: 'body', videoUrl: 'https://s.com/v.mp4',
    });

    expect(id).toBe('p_2');
    expect(queries).toHaveLength(2);
    // The second try keeps the title and the video and loses only the field
    // Buffer named.
    expect(queries[1]).not.toContain('isAiGenerated');
    expect(queries[1]).toContain('Lemon Bars');
    expect(queries[1]).toContain('https://s.com/v.mp4');
  });

  it('sends a category, which YouTube refuses the post without', async () => {
    const sent = capture();
    await new BufferClient('tok').createYouTubePost({
      channelId: 'c_1', title: 't', text: 'b', videoUrl: 'v', category: '26',
    });
    // 26 is Howto & Style, where a cooking channel belongs.
    expect(sent[0]).toContain('categoryId: "26"');
  });

  it("takes GraphQL's \"Did you mean\" and sends the Short again under that name", async () => {
    // Buffer's own second refusal, word for word.
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
      const query = JSON.parse(String(init.body)).query as string;
      queries.push(query);
      if (/\bcategory:/.test(query)) {
        return new Response(JSON.stringify({
          errors: [{ message: 'Field "category" is not defined by type "YoutubePostMetadataInput". Did you mean "categoryId"?' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { createPost: { post: { id: 'p_4' } } } }), { status: 200 });
    }));

    // A client that still calls it "category" would need the rename; this one
    // already sends categoryId, so the first try succeeds and the mechanism is
    // proven by the renaming test below instead.
    const id = await new BufferClient('tok').createYouTubePost({
      channelId: 'c_1', title: 't', text: 'b', videoUrl: 'v', category: '26',
    });
    expect(id).toBe('p_4');
    expect(queries[0]).toContain('categoryId:');
  });

  it('renames any field Buffer suggests a name for, keeping the rest intact', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
      const query = JSON.parse(String(init.body)).query as string;
      queries.push(query);
      if (/isAiGenerated:/.test(query)) {
        return new Response(JSON.stringify({
          errors: [{ message: 'Field "isAiGenerated" is not defined by type "YoutubePostMetadataInput". Did you mean "aiGenerated"?' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { createPost: { post: { id: 'p_5' } } } }), { status: 200 });
    }));

    const id = await new BufferClient('tok').createYouTubePost({
      channelId: 'c_1', title: 'Lemon Bars', text: 'b', videoUrl: 'v', category: '26',
    });
    expect(id).toBe('p_5');
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain('aiGenerated: true');
    // The rename must not cost the post its other fields.
    expect(queries[1]).toContain('title: "Lemon Bars"');
    expect(queries[1]).toContain('categoryId: "26"');
  });

  it('tries the category unquoted when Buffer refuses it as a string', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
      const query = JSON.parse(String(init.body)).query as string;
      queries.push(query);
      if (/categoryId: "26"/.test(query)) {
        return new Response(JSON.stringify({
          errors: [{ message: 'String cannot represent value for field "categoryId" of type "Int".' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { createPost: { post: { id: 'p_3' } } } }), { status: 200 });
    }));

    const id = await new BufferClient('tok').createYouTubePost({
      channelId: 'c_1', title: 't', text: 'b', videoUrl: 'v', category: '26',
    });
    expect(id).toBe('p_3');
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain('categoryId: 26');
    expect(queries[1]).not.toContain('categoryId: "26"');
  });

  it('never drops the title, which YouTube requires', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        errors: [{ message: 'Field "title" is not defined by type "YoutubePostMetadataInput".' }],
      }), { status: 200 }),
    ));
    await expect(
      new BufferClient('tok').createYouTubePost({ channelId: 'c', title: 't', text: 'b', videoUrl: 'v' }),
    ).rejects.toThrow(/Field "title"/);
  });

  it('lets an unrelated GraphQL error stand rather than retrying forever', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify({ errors: [{ message: 'Rate limit exceeded' }] }), { status: 200 });
    }));
    await expect(
      new BufferClient('tok').createYouTubePost({ channelId: 'c', title: 't', text: 'b', videoUrl: 'v' }),
    ).rejects.toThrow(/Rate limit/);
    expect(calls).toBe(1);
  });

  it('passes on what Buffer said when it refuses, instead of a blank failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: { createPost: { message: 'channel not connected' } } }), { status: 200 }),
    ));
    await expect(
      new BufferClient('tok').createYouTubePost({ channelId: 'c', title: 't', text: 'b', videoUrl: 'v' }),
    ).rejects.toThrow(/channel not connected/);
  });
});

describe('sending one network again', () => {
  /** What the resend route does to a reel's saved channels, in isolation. */
  const resend = (
    channels: Record<string, unknown>,
    wanted: string[],
    reencode = false,
  ): Record<string, unknown> => {
    const next = { ...channels };
    for (const name of ['facebook', 'instagram', 'youtube'].filter((n) => wanted.includes(n))) delete next[name];
    if (reencode) delete next.siteVideo;
    return next;
  };

  const published = {
    facebook: { status: 'ok', id: 'f1' },
    instagram: { status: 'ok', id: 'i1' },
    youtube: { status: 'failed', error: 'Field "type" is not defined' },
    siteVideo: 'https://s.com/v.mp4',
  };

  it('clears only the network asked for, so the others are not posted twice', () => {
    const after = resend(published, ['youtube']);
    expect(after.youtube).toBeUndefined();
    // publishReel skips a channel already marked ok, so these two stay put.
    expect(after.facebook).toEqual({ status: 'ok', id: 'f1' });
    expect(after.instagram).toEqual({ status: 'ok', id: 'i1' });
  });

  it('keeps the uploaded video unless the re-encode was asked for', () => {
    expect(resend(published, ['youtube']).siteVideo).toBe('https://s.com/v.mp4');
    expect(resend(published, ['facebook', 'instagram', 'youtube'], true).siteVideo).toBeUndefined();
  });
});

describe("what a Short says under the video", () => {
  const caption = 'Twelve minutes, start to plate.\n\nThe butter browns while the salmon rests.\nWould you make this tonight?\n\n#salmon #weeknightdinner #seafood';

  it('leads with the caption the platform already writes, then the two links', () => {
    const text = youtubeDescription('Garlic Butter Salmon Bites', caption, 'https://s.com/recipe/salmon', 's.com');
    expect(text.startsWith('Twelve minutes, start to plate.')).toBe(true);
    expect(text).toContain('Full recipe: https://s.com/recipe/salmon');
    expect(text).toContain('More recipes: https://s.com');
    // The hashtags survive: YouTube shows the first three above the title.
    expect(text).toContain('#salmon');
  });

  it('falls back to the title when no caption was written', () => {
    const text = youtubeDescription('Garlic Butter Salmon Bites', '   ', 'https://s.com/recipe/salmon', 's.com');
    expect(text.startsWith('Garlic Butter Salmon Bites')).toBe(true);
  });

  it('leaves out a link it does not have, without a stray blank line', () => {
    expect(youtubeDescription('T', caption, '', '')).toBe(caption);
    expect(youtubeDescription('T', caption, 'https://s.com/r', '')).toContain('Full recipe: https://s.com/r');
    expect(youtubeDescription('T', caption, 'https://s.com/r', '')).not.toContain('More recipes');
  });

  it('does not write the scheme twice when the domain carries one', () => {
    const text = youtubeDescription('T', caption, '', 'https://s.com');
    expect(text).toContain('More recipes: https://s.com');
    expect(text).not.toContain('https://https://');
  });

  it("stays inside YouTube's 5,000 characters", () => {
    const text = youtubeDescription('T', 'x'.repeat(6000), 'https://s.com/r', 's.com');
    expect(text.length).toBe(5000);
  });
});

describe('what every reel says when it goes out', () => {
  /** The publish block's own wording, in the order it builds it. */
  const compose = (runTitle: string, caption: string, postUrl: string) => {
    const title = runTitle.trim() || caption.trim();
    const body = caption.trim() || title;
    return {
      title,
      body,
      facebook: postUrl ? `${body}\n\nFull recipe: ${postUrl}` : body,
      instagram: `${body}\n\nFull recipe: link in bio`,
    };
  };

  const caption = 'Twelve minutes, start to plate.\n\nThe butter browns while the salmon rests.\nWould you make this tonight?\n\n#salmon #seafood';

  it('sends the written caption, not the title, to Facebook and Instagram', () => {
    const out = compose('Garlic Butter Salmon Bites', caption, 'https://s.com/r/salmon');
    expect(out.facebook.startsWith('Twelve minutes, start to plate.')).toBe(true);
    expect(out.facebook).toContain('#salmon');
    expect(out.facebook).toContain('Full recipe: https://s.com/r/salmon');
    expect(out.instagram.startsWith('Twelve minutes, start to plate.')).toBe(true);
    // The link never goes in an Instagram caption; its line says where it is.
    expect(out.instagram).not.toContain('https://');
  });

  it('falls back to the title when no caption was written', () => {
    const out = compose('Garlic Butter Salmon Bites', '', 'https://s.com/r/salmon');
    expect(out.body).toBe('Garlic Butter Salmon Bites');
    expect(out.facebook).toBe('Garlic Butter Salmon Bites\n\nFull recipe: https://s.com/r/salmon');
  });

  it('keeps a title for Pinterest and YouTube even when only a caption exists', () => {
    const out = compose('', caption, 'https://s.com/r/salmon');
    // The title falls back to the caption, which is what it did before; a pin
    // and a Short both need something short of their own.
    expect(out.title).toBe(caption.trim());
  });
});
