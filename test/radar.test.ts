import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, all, get, openDatabase } from '../src/db/index.js';
import { addPastedKeywords, upsertSite } from '../src/db/repos.js';
import {
  engagementScore, handleOf, normalizeApify, normalizeBrightData, usable, type SocialPost,
} from '../src/research/social/facebook.js';
import {
  ApifyProvider, BrightDataProvider, RotatingProvider, isTokenSpent, splitTokens,
  type SocialProvider,
} from '../src/research/social/providers.js';
import { addSource, listPosts, listSources, removeSource, toggleSource } from '../src/research/social/repo.js';
import { addToQueue, candidates, dismiss, scanSite, type Candidate } from '../src/research/social/radar.js';
import { setLogLevel } from '../src/lib/logger.js';

const KEY = randomBytes(32);

const post = (over: Partial<SocialPost> = {}): SocialPost => ({
  postId: 'p1', url: 'https://www.facebook.com/x/posts/1', text: 'a post with quite enough words in it',
  postedAt: '2026-10-01T00:00:00.000Z', likes: 0, comments: 0, shares: 0, ...over,
});

describe('Radar: reading a page', () => {
  it('finds the handle in a handle, a URL, a profile link and a people link', () => {
    expect(handleOf('cookingarab')).toBe('cookingarab');
    expect(handleOf('@cookingarab')).toBe('cookingarab');
    expect(handleOf('https://www.facebook.com/cookingarab/')).toBe('cookingarab');
    expect(handleOf('facebook.com/cookingarab/posts/123')).toBe('cookingarab');
    expect(handleOf('https://facebook.com/profile.php?id=100083')).toBe('100083');
    expect(handleOf('https://facebook.com/people/Some-Page/100084/')).toBe('100084');
    expect(handleOf('   ')).toBe('');
  });

  it("reads Bright Data's record, nested likes and all", () => {
    expect(normalizeBrightData({
      post_id: '9', url: 'https://f.com/9', content: 'Garlic butter salmon, every time.',
      date_posted: '2026-09-30T10:00:00.000Z', num_likes_type: { num: 420, type: 'Like' },
      num_comments: 31, num_shares: 12,
    })).toEqual({
      postId: '9', url: 'https://f.com/9', text: 'Garlic butter salmon, every time.',
      postedAt: '2026-09-30T10:00:00.000Z', likes: 420, comments: 31, shares: 12,
    });
  });

  it("reads Apify's record whichever names the actor used, and counts like 1.2K", () => {
    expect(normalizeApify({ postId: '7', postUrl: 'https://f.com/7', message: 'Hi there everyone', time: '2026-09-29', likes: '1.2K', commentsCount: '3,405', shares: 8 }))
      .toEqual({ postId: '7', url: 'https://f.com/7', text: 'Hi there everyone', postedAt: '2026-09-29T00:00:00.000Z', likes: 1200, comments: 3405, shares: 8 });
  });

  it('weighs a share above a comment above a like, and drops the unusable', () => {
    expect(engagementScore(post({ likes: 100 }))).toBe(100);
    expect(engagementScore(post({ likes: 40, shares: 30 }))).toBeGreaterThan(engagementScore(post({ likes: 200 })));
    expect(usable(post())).toBe(true);
    expect(usable(post({ text: 'too short' }))).toBe(false);
    expect(usable(post({ postId: '' }))).toBe(false);
  });
});

describe('Radar: the providers', () => {
  it('Bright Data triggers, waits for the snapshot, then downloads it', async () => {
    const calls: string[] = [];
    const responses = [
      new Response(JSON.stringify({ snapshot_id: 's_1' }), { status: 200 }),
      new Response(JSON.stringify({ status: 'running' }), { status: 200 }),
      new Response(JSON.stringify({ status: 'ready' }), { status: 200 }),
      new Response(JSON.stringify([{ post_id: '1', content: 'one post with plenty of words here', num_likes_type: { num: 5 } }]), { status: 200 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return responses.shift()!; }));
    const posts = await new BrightDataProvider('tok', { pollMs: 1, maxPolls: 5 }).fetchPosts('cookingarab', 25);
    expect(posts).toHaveLength(1);
    expect(calls[0]).toContain('/trigger?dataset_id=');
    expect(calls[1]).toContain('/progress/s_1');
    expect(calls[3]).toContain('/snapshot/s_1?format=json');
    vi.unstubAllGlobals();
  });

  it('Bright Data says so when the snapshot fails, and when there is no token', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('trigger')
        ? new Response(JSON.stringify({ snapshot_id: 's_2' }), { status: 200 })
        : new Response(JSON.stringify({ status: 'failed', error_message: 'page not found' }), { status: 200 })));
    await expect(new BrightDataProvider('tok', { pollMs: 1, maxPolls: 3 }).fetchPosts('nope', 25)).rejects.toThrow(/failed: page not found/);
    await expect(new BrightDataProvider('').fetchPosts('x', 25)).rejects.toThrow(/no Bright Data token/);
    vi.unstubAllGlobals();
  });

  it('Apify runs the actor and reads the dataset back in one call', async () => {
    let seen = { url: '', body: '' };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      seen = { url, body: init.body };
      return new Response(JSON.stringify([{ postId: '3', text: 'another post with enough words', likes: 9 }]), { status: 200 });
    }));
    const posts = await new ApifyProvider('tok').fetchPosts('cookingarab', 10);
    expect(posts[0]).toMatchObject({ postId: '3', likes: 9 });
    expect(seen.url).toContain('apify~facebook-posts-scraper/run-sync-get-dataset-items?token=tok');
    expect(JSON.parse(seen.body)).toEqual({ startUrls: [{ url: 'https://www.facebook.com/cookingarab/' }], resultsLimit: 10 });
    vi.unstubAllGlobals();
  });

  it('passes an HTTP failure on in words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad token', { status: 401 })));
    await expect(new ApifyProvider('tok').fetchPosts('x', 10)).rejects.toThrow(/HTTP 401 — bad token/);
    vi.unstubAllGlobals();
  });
});

describe('Radar: several tokens, used in turn', () => {
  /** A token that answers, or fails with whatever it was given. */
  const worker = (behaviour: 'ok' | string, log: string[], label: string): SocialProvider => ({
    name: 'apify',
    async fetchPosts() {
      log.push(label);
      if (behaviour !== 'ok') throw new Error(behaviour);
      return [post({ postId: label })];
    },
  });

  it('reads the tokens however they were pasted', () => {
    expect(splitTokens('a, b\nc  d;e')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(splitTokens('')).toEqual([]);
    expect(splitTokens(undefined)).toEqual([]);
  });

  it('knows a spent token from a page that does not exist', () => {
    expect(isTokenSpent(new Error('Apify run: HTTP 402 — not enough credit'))).toBe(true);
    expect(isTokenSpent(new Error('Apify run: HTTP 429 — rate limit'))).toBe(true);
    expect(isTokenSpent(new Error('Bright Data failed: monthly quota reached'))).toBe(true);
    expect(isTokenSpent(new Error('Bright Data failed: page not found'))).toBe(false);
    expect(isTokenSpent(new Error('Apify run: HTTP 500'))).toBe(false);
  });

  it('moves to the next token when one is spent, and remembers it', async () => {
    const used: string[] = [];
    let index = 0;
    const provider = new RotatingProvider('apify',
      [worker('HTTP 402 — no credit', used, 't1'), worker('ok', used, 't2'), worker('ok', used, 't3')],
      { get: () => index, set: (i) => { index = i; } });

    expect((await provider.fetchPosts('x', 25))[0]!.postId).toBe('t2');
    expect(used).toEqual(['t1', 't2']);
    expect(index).toBe(1);

    // The next scan starts from the token that worked, not from the spent one.
    used.length = 0;
    expect((await provider.fetchPosts('x', 25))[0]!.postId).toBe('t2');
    expect(used).toEqual(['t2']);
  });

  it('wraps around to the tokens before it', async () => {
    const used: string[] = [];
    const provider = new RotatingProvider('apify',
      [worker('ok', used, 't1'), worker('HTTP 402', used, 't2')],
      { get: () => 1, set: () => {} });
    expect((await provider.fetchPosts('x', 25))[0]!.postId).toBe('t1');
    expect(used).toEqual(['t2', 't1']);
  });

  it('does not burn every token on a page that does not exist', async () => {
    const used: string[] = [];
    const provider = new RotatingProvider('apify',
      [worker('Bright Data failed: page not found', used, 't1'), worker('ok', used, 't2')]);
    await expect(provider.fetchPosts('nope', 25)).rejects.toThrow(/page not found/);
    expect(used).toEqual(['t1']);
  });

  it('says so when every token is spent, and when there are none', async () => {
    const used: string[] = [];
    const provider = new RotatingProvider('apify', [worker('HTTP 402 — no credit', used, 't1'), worker('HTTP 429', used, 't2')]);
    await expect(provider.fetchPosts('x', 25)).rejects.toThrow(/all 2 apify token\(s\) are spent or refused/);
    expect(used).toEqual(['t1', 't2']);
    await expect(new RotatingProvider('brightdata', []).fetchPosts('x', 25)).rejects.toThrow(/no Bright Data token saved/);
  });

  it('a saved index past the end of a shorter list still starts somewhere real', async () => {
    const used: string[] = [];
    const provider = new RotatingProvider('apify', [worker('ok', used, 't1')], { get: () => 7, set: () => {} });
    expect((await provider.fetchPosts('x', 25))[0]!.postId).toBe('t1');
  });
});

describe('Radar: finding ideas', () => {
  beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
  afterEach(() => closeDatabase());

  const site = () => upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);

  it('keeps the loud, the new and the halal', () => {
    const found: Candidate[] = [
      { sourceId: 1, post: post({ postId: 'a', text: 'a quiet post nobody shared at all' }), score: 5 },
      { sourceId: 1, post: post({ postId: 'b', text: 'a loud post everybody shared today' }), score: 500 },
      { sourceId: 1, post: post({ postId: 'c', text: 'slow cooker pulled pork for the win' }), score: 900 },
      { sourceId: 1, post: post({ postId: 'd', text: 'we have already seen this one before' }), score: 800 },
    ];
    expect(candidates(found, new Set(['d']), 20).map((c) => c.post.postId)).toEqual(['b']);
  });

  it('scans each watched page, sorts with the model, and sends the ticked ones to Keywords and Blog', async () => {
    const siteId = site();
    addSource(siteId, 'https://www.facebook.com/pageone/');
    addSource(siteId, 'pagetwo');

    const deps = {
      fetchPosts: vi.fn(async (handle: string) =>
        handle === 'pageone'
          ? [post({ postId: '1', text: 'this salmon takes twelve minutes and everyone asks for it', shares: 40 })]
          : [post({ postId: '2', text: 'nobody tells you cheesecake can be frozen whole', shares: 30 })]),
      ask: vi.fn(async (items: string) => {
        const n = (needle: string) => items.split('\n\n').findIndex((l) => l.includes(needle)) + 1;
        return JSON.stringify({ keep: [
          { n: n('salmon'), type: 'recipe', title: 'Garlic Butter Salmon Bites', group: 'salmon' },
          { n: n('cheesecake'), type: 'question', title: 'Can you freeze cheesecake?' },
        ] });
      }),
      notify: vi.fn(async () => {}),
    };

    const row = get('SELECT * FROM sites WHERE id = ?', siteId) as never;
    const report = await scanSite(row, deps, '2026-10-04', { perPage: 25, minScore: 0 });
    expect(report).toMatchObject({ pages: 2, posts: 2, candidates: 2, found: 2 });
    expect(deps.fetchPosts).toHaveBeenCalledWith('pageone', 25);

    const ideas = listPosts(siteId);
    expect(ideas.map((i) => i.title).sort()).toEqual(['Can you freeze cheesecake?', 'Garlic Butter Salmon Bites']);
    // Sorted loudest first: 40 shares beats 30.
    expect(ideas[0]!.title).toBe('Garlic Butter Salmon Bites');

    expect(addToQueue(siteId, ideas.map((i) => i.id))).toEqual({ recipes: 1, questions: 1 });
    expect(get<{ seed_keyword: string }>("SELECT seed_keyword FROM keywords WHERE spy_title = 'Garlic Butter Salmon Bites'")!.seed_keyword).toBe('salmon');
    expect(listPosts(siteId)).toHaveLength(0);
    expect(listPosts(siteId, 'added')).toHaveLength(2);

    // Scanned again: the numbers move, the verdict does not.
    await scanSite(row, deps, '2026-10-05', { perPage: 25, minScore: 0 });
    expect(listPosts(siteId)).toHaveLength(0);
  });

  it('brings a waiting idea up to date without paying the model again', async () => {
    const siteId = site();
    addSource(siteId, 'pageone');
    let shares = 10;
    const ask = vi.fn(async () => JSON.stringify({ keep: [{ n: 1, type: 'recipe', title: 'Garlic Butter Salmon Bites', group: 'salmon' }] }));
    const deps = {
      fetchPosts: async () => [post({ postId: '1', text: 'this salmon takes twelve minutes and everyone asks for it', likes: 100, shares })],
      ask,
      notify: async () => {},
    };
    const row = get('SELECT * FROM sites WHERE id = ?', siteId) as never;

    await scanSite(row, deps, '2026-10-04', { perPage: 25, minScore: 0 });
    expect(listPosts(siteId)[0]!.score).toBe(200); // 100 likes + 10 shares x 10
    expect(ask).toHaveBeenCalledTimes(1);

    // The post keeps climbing for days after it went up.
    shares = 50;
    const again = await scanSite(row, deps, '2026-10-05', { perPage: 25, minScore: 0 });
    expect(again).toMatchObject({ refreshed: 1, candidates: 0, found: 0 });
    expect(listPosts(siteId)[0]!.score).toBe(600);
    expect(listPosts(siteId)[0]!.shares).toBe(50);
    // Judged once, not once a day.
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('a decided idea keeps its numbers along with its verdict', async () => {
    const siteId = site();
    addSource(siteId, 'pageone');
    let shares = 10;
    const deps = {
      fetchPosts: async () => [post({ postId: '1', text: 'this salmon takes twelve minutes and everyone asks for it', likes: 100, shares })],
      ask: async () => JSON.stringify({ keep: [{ n: 1, type: 'recipe', title: 'Garlic Butter Salmon Bites', group: 'salmon' }] }),
      notify: async () => {},
    };
    const row = get('SELECT * FROM sites WHERE id = ?', siteId) as never;
    await scanSite(row, deps, '2026-10-04', { perPage: 25, minScore: 0 });
    dismiss(siteId, [listPosts(siteId)[0]!.id]);

    shares = 50;
    const again = await scanSite(row, deps, '2026-10-05', { perPage: 25, minScore: 0 });
    expect(again.refreshed).toBe(0);
    expect(listPosts(siteId, 'dismissed')[0]!.score).toBe(200);
  });

  it('leaves out an idea the site already has', async () => {
    const siteId = site();
    addSource(siteId, 'pageone');
    addPastedKeywords(['Garlic Butter Salmon Bites'], 'salmon', [siteId]);
    const deps = {
      fetchPosts: async () => [post({ postId: '1', text: 'this salmon takes twelve minutes and everyone asks for it' })],
      ask: async () => JSON.stringify({ keep: [{ n: 1, type: 'recipe', title: 'Easy Garlic Butter Salmon Bites', group: 'salmon' }] }),
      notify: async () => {},
    };
    const report = await scanSite(get('SELECT * FROM sites WHERE id = ?', siteId) as never, deps, '2026-10-04', { perPage: 25, minScore: 0 });
    expect(report.found).toBe(0);
  });

  it('one unreachable page does not cost the others their scan', async () => {
    const siteId = site();
    addSource(siteId, 'broken');
    addSource(siteId, 'working');
    const deps = {
      fetchPosts: async (handle: string) => {
        if (handle === 'broken') throw new Error('page not found');
        return [post({ postId: '1', text: 'this salmon takes twelve minutes and everyone asks for it' })];
      },
      ask: async () => JSON.stringify({ keep: [{ n: 1, type: 'recipe', title: 'Garlic Butter Salmon Bites', group: 'salmon' }] }),
      notify: async () => {},
    };
    const report = await scanSite(get('SELECT * FROM sites WHERE id = ?', siteId) as never, deps, '2026-10-04', { perPage: 25, minScore: 0 });
    expect(report).toMatchObject({ posts: 1, found: 1 });
    expect(report.error).toBeUndefined();
    expect(listSources(siteId).find((s) => s.handle === 'broken')!.last_error).toBe('page not found');
  });

  it('says so when a model answer cannot be read, rather than losing the scan', async () => {
    const siteId = site();
    addSource(siteId, 'pageone');
    const deps = {
      fetchPosts: async () => [post({ postId: '1', text: 'this salmon takes twelve minutes and everyone asks for it' })],
      ask: async () => 'not json at all',
      notify: async () => {},
    };
    const report = await scanSite(get('SELECT * FROM sites WHERE id = ?', siteId) as never, deps, '2026-10-04', { perPage: 25, minScore: 0 });
    expect(report).toMatchObject({ posts: 1, candidates: 1, found: 0 });
    expect(report.error).toBeUndefined();
  });

  it('keeps the watched pages: added once, paused, removed with its ideas', () => {
    const siteId = site();
    expect(addSource(siteId, 'https://www.facebook.com/pageone/')).toEqual({ added: true, handle: 'pageone' });
    expect(addSource(siteId, 'pageone')).toEqual({ added: false, handle: 'pageone' });
    const source = listSources(siteId)[0]!;
    toggleSource(siteId, source.id, false);
    expect(listSources(siteId)[0]!.enabled).toBe(0);
    removeSource(siteId, source.id);
    expect(listSources(siteId)).toHaveLength(0);
  });

  it('dismissing is final and counted', async () => {
    const siteId = site();
    addSource(siteId, 'pageone');
    const deps = {
      fetchPosts: async () => [post({ postId: '1', text: 'this salmon takes twelve minutes and everyone asks for it' })],
      ask: async () => JSON.stringify({ keep: [{ n: 1, type: 'recipe', title: 'Garlic Butter Salmon Bites', group: 'salmon' }] }),
      notify: async () => {},
    };
    await scanSite(get('SELECT * FROM sites WHERE id = ?', siteId) as never, deps, '2026-10-04', { perPage: 25, minScore: 0 });
    const idea = listPosts(siteId)[0]!;
    expect(dismiss(siteId, [idea.id])).toBe(1);
    expect(dismiss(siteId, [idea.id])).toBe(0);
    expect(all('SELECT * FROM social_posts WHERE status = ?', 'dismissed')).toHaveLength(1);
  });
});
