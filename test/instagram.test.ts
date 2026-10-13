import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferClient } from '../src/integrations/buffer.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { instagramPostStep } from '../src/pipeline/steps/instagram-post.js';
import { setLogLevel } from '../src/lib/logger.js';

/** Instagram, through Buffer: the article's photo and the reel, the link in the first comment. */

describe('the Buffer mutation for Instagram', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends a reel as a video with the required Instagram fields and the link as the first comment', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(JSON.stringify({ data: { createPost: { post: { id: 'IG1' } } } }), { status: 200 });
    }));
    const id = await new BufferClient('t').createInstagramPost({ channelId: 'c1', text: 'Bars', type: 'reel', videoUrl: 'https://s/v.mp4', firstComment: 'Full recipe: https://s/r' });
    expect(id).toBe('IG1');
    const q = JSON.parse(bodies[0]!).query as string;
    expect(q).toContain('video: { url: "https://s/v.mp4" }');
    expect(q).toMatch(/instagram: \{\s*type: reel\s*shouldShareToFeed: true\s*isAiGenerated: true\s*firstComment: "Full recipe: https:\/\/s\/r"/);
  });

  it('sends a post as an image', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(JSON.stringify({ data: { createPost: { message: 'bad image' } } }), { status: 200 });
    }));
    await expect(new BufferClient('t').createInstagramPost({ channelId: 'c1', text: 'x', type: 'post', imageUrl: 'https://s/i.jpg' })).rejects.toThrow(/bad image/);
    expect(JSON.parse(bodies[0]!).query).toContain('image: { url: "https://s/i.jpg" }');
  });
});

describe('the Instagram post step', () => {
  beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
  afterEach(() => closeDatabase());

  const ctx = (igPosts: number) => {
    const posts: unknown[] = [];
    return {
      posts,
      value: {
        runId: 1,
        site: { domain: 'd.com', ig_posts: igPosts },
        settings: { get: (k: string) => ({ ig_link_mode: 'comment', ig_comment_line: 'Recipe below', ig_comment_text: 'Get it: {url}' } as Record<string, string>)[k] ?? '' },
        images: { download: vi.fn(async () => { throw new Error('no network in tests'); }) },
        siteApi: { uploadImage: vi.fn(), absoluteUrl: (p: string) => `https://d.com${p}` },
        prompt: vi.fn(async () => ({ content: 'Peachy and creamy.\n\nFull recipe: link in bio (also in the first comment)\n\n#peachcobbler' })),
        instagramBuffer: { createInstagramPost: vi.fn(async (i: unknown) => { posts.push(i); return { postId: 'IG2', account: 'A' }; }) },
        async eachAccount(this: { instagramBuffer: unknown }, _p: string, send: (pool: unknown, profile: undefined, first: boolean) => Promise<string>) {
          return { postId: await send(this.instagramBuffer, undefined, true), accounts: 1 };
        },
      } as never,
    };
  };
  const input = { seo: { title: 'Bars' } as never, title: 'Bars', postUrl: 'https://d.com/recipe/bars', heroImageUrl: 'https://d.com/image/recipes/fb.jpg' };

  it('posts the hero photo cut to 4:5 with the caption, the link in the first comment', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ig-'));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=768x1376', '-frames:v', '1', join(dir, 'h.png')]);
    const c = ctx(1);
    const v = c.value as { images: { download: ReturnType<typeof vi.fn> }; siteApi: { uploadImage: ReturnType<typeof vi.fn> } };
    v.images.download.mockResolvedValue({ data: readFileSync(join(dir, 'h.png')), contentType: 'image/png' });
    v.siteApi.uploadImage.mockResolvedValue({ url: '/image/recipes/ig.jpg' });
    const out = await instagramPostStep.run(c.value, input);
    expect(out).toEqual({ postId: 'IG2', imageUrl: 'https://d.com/image/recipes/ig.jpg' });
    expect(c.posts[0]).toMatchObject({ type: 'post', imageUrl: 'https://d.com/image/recipes/ig.jpg', firstComment: 'Get it: https://d.com/recipe/bars' });
  });

  it('does nothing while Instagram posts are off', async () => {
    const c = ctx(0);
    expect(await instagramPostStep.run(c.value, input)).toMatchObject({ skipped: expect.any(String) });
    expect(c.posts).toHaveLength(0);
  });
});

describe('Buffer free plan', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('posts without the first comment when the plan does not allow one', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      const q = JSON.parse(init.body).query as string;
      queries.push(q);
      const body = q.includes('firstComment')
        ? { data: { createPost: { message: 'Invalid post: First comment requires a paid plan. Please upgrade to use this feature.' } } }
        : { data: { createPost: { post: { id: 'IG9' } } } };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const id = await new BufferClient('t').createInstagramPost({ channelId: 'c', text: 'x', type: 'reel', videoUrl: 'https://s/v.mp4', firstComment: 'Full recipe: https://s/r' });
    expect(id).toBe('IG9');
    expect(queries).toHaveLength(2);
    expect(queries[1]).not.toContain('firstComment');
  });
});

describe('where the Instagram link goes', () => {
  it('says link in bio and sends no comment on the free setting, and fills {url} on the paid one', async () => {
    const { instagramLink } = await import('../src/core/instagram-link.js');
    const s = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? '' });
    expect(instagramLink(s({ ig_link_mode: 'bio', ig_bio_line: 'Recipe: link in bio' }), 'https://r')).toEqual({ line: 'Recipe: link in bio' });
    expect(instagramLink(s({ ig_link_mode: 'comment', ig_comment_line: 'Below 👇', ig_comment_text: 'Here: {url}' }), 'https://r'))
      .toEqual({ line: 'Below 👇', firstComment: 'Here: https://r' });
    expect(instagramLink(s({ ig_link_mode: 'comment', ig_comment_text: 'Recipe' }), 'https://r').firstComment).toBe('Recipe https://r');
  });
});

describe('Instagram Buffer accounts', () => {
  beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
  afterEach(() => closeDatabase());

  it('uses its own accounts first, then the Facebook ones, never the Pinterest ones', async () => {
    const { randomBytes } = await import('node:crypto');
    const { upsertSite, upsertBufferAccount } = await import('../src/db/repos.js');
    const { BufferPool } = await import('../src/integrations/buffer-pool.js');
    const key = randomBytes(32);
    const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, key);
    upsertBufferAccount({ siteId, label: 'FB', token: 't1', enabled: true, platform: 'facebook' }, key);
    upsertBufferAccount({ siteId, label: 'PIN', token: 't2', enabled: true, platform: 'pinterest' }, key);
    upsertBufferAccount({ siteId, label: 'IG', token: 't3', enabled: true, platform: 'instagram' }, key);
    const pool = new BufferPool({ id: siteId, domain: 's.com', pinUsername: '', platform: 'instagram' }, key);
    expect((pool as unknown as { accounts: { label: string }[] }).accounts.map((a) => a.label)).toEqual(['IG', 'FB']);
    const fb = new BufferPool({ id: siteId, domain: 's.com', pinUsername: '', platform: 'facebook' }, key);
    expect((fb as unknown as { accounts: { label: string }[] }).accounts.map((a) => a.label)).toEqual(['FB']);
  });
});
