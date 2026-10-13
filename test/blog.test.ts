import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { setLogLevel } from '../src/lib/logger.js';
import {
  addBlogQuestions,
  blogPublishedToday,
  countBlogQuestions,
  listBlogSites,
  nextBlogQuestion,
  normaliseQuestion,
  requeueStuckBlogQuestions,
  setBlogQuestionStatus,
  setBlogSettings,
} from '../src/blog/repo.js';
import { chooseLinks, cleanArticleHtml, dedupeLinks, ensureLinks } from '../src/blog/engine.js';
import type { SiteContentItem } from '../src/integrations/site-api.js';

/**
 * Blog articles: the question queue, the per-site clock, the links an article
 * carries, and the HTML the model is allowed to put on a page.
 */

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  run("INSERT INTO sites (name, domain, status) VALUES ('Daily', 'dailyfoodpins.com', 'active')");
});
afterEach(() => closeDatabase());

const recipe = (slug: string, title: string, keyword = ''): SiteContentItem => ({
  type: 'recipe', slug, title, summary: '', keyword, url: `https://x.com/recipe/${slug}`,
});
const post = (slug: string, title: string): SiteContentItem => ({
  type: 'post', slug, title, summary: '', url: `https://x.com/blog/${slug}`,
});

describe('the question queue', () => {
  it('tidies pasted lines into questions', () => {
    expect(normaliseQuestion('  - can you freeze cheesecake  ')).toBe('Can you freeze cheesecake?');
    expect(normaliseQuestion('1. Why did my cake sink.')).toBe('Why did my cake sink?');
  });

  it('adds many at once and skips duplicates and blanks', () => {
    const first = addBlogQuestions(1, ['Can you freeze cheesecake?', '', 'hi', 'How long does banana pudding last?']);
    expect(first).toMatchObject({ added: 2, skipped: 1 });
    const again = addBlogQuestions(1, ['can you freeze cheesecake']);
    expect(again).toMatchObject({ added: 0, skipped: 1 });
    expect(countBlogQuestions(1, 'queued')).toBe(2);
  });

  it('keeps suggestions out of the queue until approved', () => {
    addBlogQuestions(1, ['Why does cheesecake crack in the oven?'], 'ai', 'suggested');
    expect(nextBlogQuestion(1)).toBeUndefined();
    run("UPDATE blog_questions SET status = 'queued'"); // approved
    expect(nextBlogQuestion(1)?.question).toBe('Why does cheesecake crack in the oven?');
  });

  it('counts what was published today and puts stuck work back in line', () => {
    addBlogQuestions(1, ['Can you freeze cheesecake?', 'Is banana pudding better the next day?']);
    const a = nextBlogQuestion(1)!;
    setBlogQuestionStatus(a.id, 'done', { postUrl: 'https://x.com/blog/a' });
    expect(blogPublishedToday(1)).toBe(1);

    const next = nextBlogQuestion(1)!;
    setBlogQuestionStatus(next.id, 'working', { attempt: true });
    run("UPDATE blog_questions SET updated_at = datetime('now', '-2 hours') WHERE id = ?", next.id);
    expect(requeueStuckBlogQuestions()).toBe(1);
    expect(nextBlogQuestion(1)?.id).toBe(next.id);
  });

  it('stores each site its own schedule, within sane bounds', () => {
    setBlogSettings(1, { enabled: true, dailyTarget: 99, intervalMinutes: 5 });
    expect(listBlogSites()[0]).toMatchObject({ blog_enabled: 1, blog_daily_target: 24, blog_interval_minutes: 30 });
  });
});

describe('links', () => {
  const content = [
    recipe('lemon-bars', 'Lemon Bars with Shortbread Crust', 'lemon bars'),
    recipe('mini-blueberry-cheesecakes', 'Mini Blueberry Cheesecakes', 'blueberry cheesecake'),
    post('freeze-desserts', 'How to Freeze Desserts Without Losing Texture'),
    post('cheesecake-cracks', 'Why Cheesecake Cracks and How to Stop It'),
    post('pasta-water', 'Should You Salt Pasta Water?'),
  ];

  it('picks the closest recipe and related posts', () => {
    const { recipe: r, posts } = chooseLinks('Can you freeze cheesecake?', content);
    expect(r?.slug).toBe('mini-blueberry-cheesecakes');
    expect(posts.map((p) => p.slug)).toEqual(expect.arrayContaining(['cheesecake-cracks', 'freeze-desserts']));
    expect(posts.length).toBeLessThanOrEqual(2);
  });

  it('always has a recipe, but links no unrelated post', () => {
    const { recipe: r, posts } = chooseLinks('What is umami?', content);
    expect(r).not.toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('links each url once', () => {
    const out = dedupeLinks('<a href="https://x.com/r/a">one</a> and <a href="https://x.com/r/a/">two</a> <a href="https://x.com/b">b</a>');
    expect(out).toBe('<a href="https://x.com/r/a">one</a> and two <a href="https://x.com/b">b</a>');
  });

  it('adds any link the model left out, before the FAQ', () => {
    const html = '<p>Answer.</p><h2>Questions fréquentes</h2><h3>Q?</h3><p>A.</p>';
    const out = ensureLinks(html, [content[0]!]);
    expect(out.indexOf('À lire aussi')).toBeLessThan(out.indexOf('Questions fréquentes'));
    expect(out).toContain('https://x.com/recipe/lemon-bars');
  });
});

describe('article HTML', () => {
  it('keeps formatting and links, drops scripts, styles and handlers', () => {
    const out = cleanArticleHtml(
      '<h1>T</h1><p style="x" onclick="y()">Hi <a href="https://x.com/a" target="_blank">a</a> <a href="javascript:alert(1)">b</a></p><script>bad()</script><img src="x">',
    );
    expect(out).toBe('<h2>T</h2><p>Hi <a href="https://x.com/a">a</a> b</p>');
  });
});
