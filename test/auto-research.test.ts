import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { addPastedKeywords, getSite, upsertSite } from '../src/db/repos.js';
import { addBlogQuestions } from '../src/blog/repo.js';
import { autoResearchTick, crowdedCategories, expireAutoAdded, pickTopic, runAutoResearch, type AutoDeps } from '../src/research/auto.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

const KEY = randomBytes(32);
let site: number;

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  site = upsertSite({ name: 's', domain: 's.com', status: 'active', daily_target: 3, interval_minutes: 60 }, KEY);
  run("UPDATE sites SET auto_research_on = 1, auto_research_niche = 'dessert', auto_research_recipes = 2, auto_research_questions = 1 WHERE id = ?", site);
});
afterEach(() => closeDatabase());

const item = (text: string, extra = {}) => ({ text, source: 'autocomplete' as const, rank: 0, broad: false, ...extra });

const deps = (over: Partial<AutoDeps> = {}): AutoDeps => ({
  topicIdeas: async () => ({ niche: 'dessert', notes: [], seasonal: [{ topic: 'pumpkin desserts', why: '' }], topics: [{ topic: 'cheesecake', why: '' }] }),
  research: async (topic) => ({
    seed: topic,
    notes: [],
    recipes: [item(`${topic} bars`), item(`${topic} recipes`, { broad: true }), item(`${topic} cups`), item(`${topic} pie`)],
    questions: [item(`Can you freeze ${topic}?`), item(`How long does ${topic} last?`)],
  }),
  notify: async () => undefined,
  ...over,
});

describe('daily auto research', () => {
  it('adds the best N recipes and questions, marked as added automatically', async () => {
    const report = await runAutoResearch(getSite(site)!, deps(), '2026-10-01');
    expect(report).toMatchObject({ topic: 'pumpkin desserts', added: 2, questions: 1 });
    const kws = all<{ spy_title: string; seed_keyword: string; auto_added_at: string | null }>('SELECT spy_title, seed_keyword, auto_added_at FROM keywords');
    expect(kws.map((k) => k.spy_title)).toEqual(['Pumpkin Desserts Bars', 'Pumpkin Desserts Cups']);
    expect(kws.every((k) => k.seed_keyword === 'pumpkin desserts' && k.auto_added_at)).toBe(true);
    expect(get<{ n: number }>('SELECT COUNT(*) AS n FROM blog_questions WHERE auto_added_at IS NOT NULL')!.n).toBe(1);
    expect(getSite(site)!.auto_research_last_day).toBe('2026-10-01');
  });

  it('tops up from the next topic when one gives too few recipes', async () => {
    run('UPDATE sites SET auto_research_recipes = 5 WHERE id = ?', site);
    const report = await runAutoResearch(getSite(site)!, deps(), '2026-10-01');
    expect(report.topic).toBe('pumpkin desserts, cheesecake');
    expect(report.added).toBe(5);
    expect(all<{ seed_keyword: string }>('SELECT DISTINCT seed_keyword FROM keywords').map((k) => k.seed_keyword)).toEqual(['pumpkin desserts', 'cheesecake']);
  });

  it('removes only unwritten automatic entries past their time', () => {
    addPastedKeywords(['Old Auto One', 'Old Auto Written'], 'x', [site], { auto: true });
    addPastedKeywords(['Hand Added'], 'x', [site]);
    addBlogQuestions(site, ['Can you freeze old auto?'], 'manual', 'queued', true);
    run("UPDATE keywords SET auto_added_at = datetime('now', '-30 hours') WHERE auto_added_at IS NOT NULL");
    run("UPDATE keyword_sites SET auto_added_at = datetime('now', '-30 hours') WHERE auto_added_at IS NOT NULL");
    run("UPDATE blog_questions SET auto_added_at = datetime('now', '-30 hours')");
    const written = get<{ id: number }>("SELECT id FROM keywords WHERE spy_title = 'Old Auto Written'")!.id;
    run("INSERT INTO runs (keyword_id, site_id, status) VALUES (?, ?, 'published')", written, site);

    expect(expireAutoAdded(site, 24)).toEqual({ keywords: 1, questions: 1 });
    expect(all<{ spy_title: string }>('SELECT spy_title FROM keywords ORDER BY id').map((k) => k.spy_title)).toEqual(['Old Auto Written', 'Hand Added']);
  });

  it('keeps entries still within their time', () => {
    addPastedKeywords(['Fresh Auto'], 'x', [site], { auto: true });
    expect(expireAutoAdded(site, 24).keywords).toBe(0);
  });

  it('does not repeat a topic used in the last two weeks while another is free', () => {
    const ideas = { niche: 'd', notes: [], seasonal: [{ topic: 'a', why: '' }], topics: [{ topic: 'b', why: '' }] };
    expect(pickTopic(ideas, { a: '2026-09-25' }, '2026-10-01')).toBe('b');
    expect(pickTopic(ideas, { a: '2026-09-01' }, '2026-10-01')).toBe('a');
    expect(pickTopic(ideas, { a: '2026-09-30', b: '2026-09-29' }, '2026-10-01')).toBe('b');
  });

  it('holds back topics from a category that already fills over a third of the site', () => {
    const ideas = {
      niche: 'd',
      notes: [],
      seasonal: [{ topic: 'cheesecake bars', why: '', category: 'Cheesecakes' }],
      topics: [{ topic: 'cheesecake', why: '', category: 'cheesecakes' }, { topic: 'meatballs', why: '', category: 'Dinner' }],
    };
    const counts = { Cheesecakes: 20, Dinner: 2, Breakfast: 0 };
    expect([...crowdedCategories(counts)]).toEqual(['cheesecakes']);
    expect(pickTopic(ideas, {}, '2026-10-01', [], counts)).toBe('meatballs');
    // Nothing else free: the crowded category is better than no topic.
    expect(pickTopic({ ...ideas, topics: [] }, {}, '2026-10-01', [], counts)).toBe('cheesecake bars');
    // A young site has no shares to speak of.
    expect(pickTopic(ideas, {}, '2026-10-01', [], { Cheesecakes: 3, Dinner: 0 })).toBe('cheesecake bars');
  });

  it('asks the model for topics with the site mix and balances by it', async () => {
    const topicIdeas = vi.fn(async () => ({
      niche: 'dessert',
      notes: [],
      seasonal: [{ topic: 'cheesecake bars', why: '', category: 'Cheesecakes' }],
      topics: [{ topic: 'pumpkin', why: '', category: 'Seasonal' }],
    }));
    const d = deps({ topicIdeas, categoryCounts: async () => ({ Cheesecakes: 30, Seasonal: 1 }) });
    const report = await runAutoResearch(getSite(site)!, d, '2026-10-01');
    expect(topicIdeas).toHaveBeenCalledWith('dessert', expect.stringContaining('- Cheesecakes: 30 recipes'));
    expect(report.topic.startsWith('pumpkin')).toBe(true);
  });

  it('runs once a day, not before the hour set', async () => {
    const settings = new Settings(KEY);
    settings.set('timezone', 'UTC');
    run('UPDATE sites SET auto_research_hour = 6 WHERE id = ?', site);
    const research = vi.fn(deps().research);
    const d = deps({ research });
    await autoResearchTick(settings, KEY, new Date('2026-10-01T05:00:00Z'), d);
    expect(research).not.toHaveBeenCalled();
    await autoResearchTick(settings, KEY, new Date('2026-10-01T07:00:00Z'), d);
    await autoResearchTick(settings, KEY, new Date('2026-10-01T09:00:00Z'), d);
    expect(research).toHaveBeenCalledTimes(1);
    await autoResearchTick(settings, KEY, new Date('2026-10-02T07:00:00Z'), d);
    expect(research).toHaveBeenCalledTimes(2);
  });
});
