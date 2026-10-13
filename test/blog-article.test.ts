import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { setLogLevel } from '../src/lib/logger.js';
import { encrypt } from '../src/lib/crypto.js';

/**
 * One blog article from question to published post, with the model, the
 * image service and the site standing in. What matters: the right links go
 * in, the recipe card is asked for, the cover is uploaded as a cover, and the
 * question ends up done with the post's url.
 */

const published: Record<string, unknown>[] = [];
const uploads: string[] = [];
const extraPosts: Record<string, unknown>[] = [];
let capOn = true;

vi.mock('../src/llm/ask.js', () => ({
  askPrompt: vi.fn(async (_s: unknown, _k: unknown, name: string, vars: { links?: string }) => {
    if (name !== 'blog-article') throw new Error('unexpected prompt ' + name);
    const words = Array.from({ length: 700 }, () => 'word').join(' ');
    return {
      content: JSON.stringify({
        title: 'Can You Freeze Cheesecake? Yes — Here Is How',
        slug: 'can-you-freeze-cheesecake',
        title_tag: 'Can You Freeze Cheesecake? A Complete Guide',
        meta_desc: 'Yes, cheesecake freezes well for up to 2 months.',
        excerpt: 'Yes, and here is how.',
        cover_alt: 'A cheesecake on a plate',
        image_prompt: 'Overhead photo of a cheesecake. Editorial food blog photography, 16:9.',
        // The model links the recipe but forgets the blog post.
        body_html: `<p>Yes. ${words}</p><p>Try <a href="https://x.com/recipe/mini-blueberry-cheesecakes">these</a>.</p><script>x()</script>`,
      }),
    };
  }),
}));

vi.mock('../src/integrations/images.js', () => ({
  ImageClient: class {
    async generate(_prompt: string, orientation: string) {
      uploads.push(`orientation:${orientation}`);
      return { jobId: 'j', imageUrl: 'u', data: Buffer.from('img'), contentType: 'image/webp' };
    }
  },
}));

vi.mock('../src/integrations/site-api.js', () => ({
  SiteApiClient: class {
    async getContent() {
      return [
        { type: 'recipe', slug: 'mini-blueberry-cheesecakes', title: 'Mini Blueberry Cheesecakes', summary: '', keyword: 'cheesecake', url: 'https://x.com/recipe/mini-blueberry-cheesecakes' },
        { type: 'recipe', slug: 'lemon-bars', title: 'Lemon Bars', summary: '', url: 'https://x.com/recipe/lemon-bars' },
        { type: 'post', slug: 'freezing-desserts', title: 'Freezing Desserts the Right Way', summary: '', url: 'https://x.com/blog/freezing-desserts' },
        ...extraPosts,
      ] as never[];
    }
    async uploadImage(_d: Buffer, _n: string, _t: string, category: string) {
      uploads.push(`category:${category}`);
      return { url: '/image/covers/c.webp' };
    }
    async publishPost(p: Record<string, unknown>) {
      published.push(p);
      return { id: 7, slug: 'can-you-freeze-cheesecake', url: 'https://x.com/blog/can-you-freeze-cheesecake' };
    }
  },
}));

const { writeBlogArticle, runOneBlogQuestion, articleCounts } = await import('../src/blog/engine.js');
const { addBlogQuestions, getBlogQuestion, nextBlogQuestion } = await import('../src/blog/repo.js');

const KEY = randomBytes(32);
const settings = {
  get: (k: string) => ({ image_base_url: 'http://img', image_api_key: 'k', flow_project_id: '', image_model: 'auto' } as Record<string, string>)[k] ?? '',
  getNumber: () => 2,
  getBool: (k: string) => (k === 'blog_cluster_cap_enabled' ? capOn : true),
} as never;

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  published.length = 0;
  uploads.length = 0;
  extraPosts.length = 0;
  capOn = true;
  run(
    "INSERT INTO sites (name, domain, status, api_token_encrypted) VALUES ('Daily', 'x.com', 'active', ?)",
    encrypt('tok', KEY),
  );
});
afterEach(() => closeDatabase());

describe('writing one blog article', () => {
  it('publishes with the cover, the recipe card and every chosen link', async () => {
    addBlogQuestions(1, ['Can you freeze cheesecake?']);
    const q = nextBlogQuestion(1)!;

    const url = await writeBlogArticle(q.id, settings, KEY);

    expect(url).toBe('https://x.com/blog/can-you-freeze-cheesecake');
    expect(uploads).toEqual(['orientation:HORIZONTAL', 'category:covers']);
    const post = published[0]!;
    expect(post.recipe_card).toBe('mini-blueberry-cheesecakes');
    expect(post.cover).toBe('/image/covers/c.webp');
    const body = String(post.body_html);
    expect(body).not.toContain('<script');
    expect(body).toContain('https://x.com/recipe/mini-blueberry-cheesecakes');
    expect(body).toContain('https://x.com/blog/freezing-desserts'); // added because the model forgot it
    expect(getBlogQuestion(q.id)).toMatchObject({ status: 'done', post_url: url, recipe_slug: 'mini-blueberry-cheesecakes' });
  });

  it('skips a question the site has already answered', async () => {
    addBlogQuestions(1, ['Freezing desserts the right way?']);
    const q = nextBlogQuestion(1)!;
    const result = await runOneBlogQuestion(q, settings, KEY);
    expect(result.ok).toBe(false);
    expect(getBlogQuestion(q.id)?.status).toBe('skipped');
    expect(published).toHaveLength(0);
  });

  const crowd = () =>
    extraPosts.push(
      { type: 'post', slug: 'a', title: 'Can You Freeze Mini Blueberry Cheesecakes?', summary: '', url: 'https://x.com/blog/a' },
      { type: 'post', slug: 'b', title: 'Mini Blueberry Cheesecakes Storage Tips', summary: '', url: 'https://x.com/blog/b' },
    );

  it('skips a question about a dish that already has its share of articles', async () => {
    crowd();
    addBlogQuestions(1, ['How long do cheesecakes last in the fridge?']);
    const q = nextBlogQuestion(1)!;
    const result = await runOneBlogQuestion(q, settings, KEY);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already has 2 articles/);
    expect(getBlogQuestion(q.id)?.status).toBe('skipped');
    expect(published).toHaveLength(0);
  });

  it('writes it anyway when the limit is switched off', async () => {
    crowd();
    capOn = false;
    addBlogQuestions(1, ['How long do cheesecakes last in the fridge?']);
    const q = nextBlogQuestion(1)!;
    expect((await runOneBlogQuestion(q, settings, KEY)).ok).toBe(true);
    expect(published).toHaveLength(1);
  });

  it('counts the articles each recipe already has', () => {
    const counts = articleCounts([
      { type: 'recipe', slug: 'mini-blueberry-cheesecakes', title: 'Mini Blueberry Cheesecakes', summary: '', url: 'u' },
      { type: 'recipe', slug: 'lemon-bars', title: 'Lemon Bars', summary: '', url: 'u' },
      { type: 'post', slug: 'a', title: 'Can You Freeze Mini Blueberry Cheesecakes?', summary: '', url: 'u' },
      { type: 'post', slug: 'b', title: 'Mini Blueberry Cheesecakes Storage Tips', summary: '', url: 'u' },
    ] as never[]);
    expect(counts.get('mini-blueberry-cheesecakes')).toBe(2);
    expect(counts.get('lemon-bars')).toBe(0);
  });
});
