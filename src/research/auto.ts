import { all, run } from '../db/index.js';
import { addPastedKeywords, getSite, listSites, siteSecrets, type SiteRow } from '../db/repos.js';
import { SiteApiClient } from '../integrations/site-api.js';
import { siteApiFor } from '../integrations/site-api-for.js';
import { addBlogQuestions } from '../blog/repo.js';
import { localDateKey } from '../core/selector.js';
import { TelegramClient } from '../integrations/telegram.js';
import { askPrompt } from '../llm/ask.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import {
  filterWithModel,
  parseTopicIdeas,
  researchKeywords,
  titleCase,
  topicCandidates,
  verifyTopics,
  type ResearchResult,
  type TopicIdeas,
} from './keywords.js';

const log = createLogger('auto-research');

/** The Serper key in use, kept in settings so every search goes on from it. */
export const serperStateIn = (settings: Settings) => ({
  get: () => Number(settings.get('serper_key_index')) || 0,
  set: (i: number) => settings.set('serper_key_index', String(i)),
});

/**
 * Daily keyword research, per site.
 *
 * Once a day, at the site's hour:
 *   1. What it added before and nobody wrote within the time allowed is
 *      removed -- only what it added itself; keywords added by hand stay.
 *   2. It picks today's topic from Google's topics for the site's niche:
 *      what is in season first, then the most searched, never one used in
 *      the last two weeks while another is left.
 *   3. It researches that topic (Google, then the AI clean-up) and adds the
 *      best N recipes to Keywords and the best N questions to Blog.
 * A Telegram message says what happened, and the report stays on the page.
 */

export interface AutoReport {
  day: string;
  topic: string;
  added: number;
  questions: number;
  removedKeywords: number;
  removedQuestions: number;
  error?: string;
}

/** Remove what auto research added to a site that has not been written in time. */
export function expireAutoAdded(siteId: number, ttlHours: number): { keywords: number; questions: number } {
  const age = `-${Math.max(1, Math.floor(ttlHours))} hours`;
  const keywords = run(
    `DELETE FROM keywords
      WHERE auto_added_at IS NOT NULL AND auto_added_at <= datetime('now', ?)
        AND id IN (SELECT keyword_id FROM keyword_sites WHERE site_id = ?)
        AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.keyword_id = keywords.id AND r.status <> 'failed')`,
    age,
    siteId,
  ).changes;
  const questions = run(
    `DELETE FROM blog_questions
      WHERE site_id = ? AND auto_added_at IS NOT NULL AND auto_added_at <= datetime('now', ?)
        AND status IN ('suggested', 'queued', 'failed')`,
    siteId,
    age,
  ).changes;
  return { keywords, questions };
}

/** A category holding more than this share of the site's recipes gets no new topics while others are free. */
export const MAX_CATEGORY_SHARE = 0.35;
/** Below this many recipes in all, shares mean nothing yet and no category is held back. */
const MIN_RECIPES_FOR_BALANCE = 10;

const norm = (s: string) => s.trim().toLowerCase();

/** The categories already holding too much of the site. */
export function crowdedCategories(counts: Record<string, number>): Set<string> {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total < MIN_RECIPES_FOR_BALANCE) return new Set();
  return new Set(Object.entries(counts).filter(([, n]) => n / total > MAX_CATEGORY_SHARE).map(([name]) => norm(name)));
}

/** "- Cheesecakes: 12 recipes" per category, for the topic prompt; empty counts give the "not available" line. */
export function describeSiteMix(counts: Record<string, number>): string {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return rows.length ? rows.map(([name, n]) => `- ${name}: ${n} recipe${n === 1 ? '' : 's'}`).join('\n') : '(not available)';
}

/**
 * Today's topic: in season first, then most searched; not one used in the last 14 days while another is free.
 * Topics filed under a category that already holds over a third of the site wait while any other topic is free.
 */
export function pickTopic(
  ideas: TopicIdeas,
  history: Record<string, string>,
  today: string,
  skip: string[] = [],
  counts: Record<string, number> = {},
): string | null {
  const recent = (topic: string) => {
    const used = history[topic];
    if (!used) return false;
    return (Date.parse(today) - Date.parse(used)) / 86_400_000 < 14;
  };
  const crowded = crowdedCategories(counts);
  const all = [...ideas.seasonal, ...ideas.topics].filter((t) => !skip.includes(t.topic));
  const balanced = all.filter((t) => !t.category || !crowded.has(norm(t.category)));
  const order = (balanced.length ? balanced : all).map((t) => t.topic);
  const fresh = order.find((t) => !recent(t));
  if (fresh) return fresh;
  // Everything used lately: the one used longest ago.
  return [...order].sort((a, b) => (history[a] ?? '').localeCompare(history[b] ?? ''))[0] ?? null;
}

const readHistory = (json: string | undefined): Record<string, string> => {
  try {
    const parsed = JSON.parse(json || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export interface AutoDeps {
  /** Recipes per category on the site; left out, or empty, the topics are not balanced. */
  categoryCounts?(site: SiteRow): Promise<Record<string, number>>;
  topicIdeas(niche: string, siteMix?: string): Promise<TopicIdeas>;
  research(topic: string): Promise<ResearchResult>;
  notify(text: string): Promise<void>;
}

export function liveDeps(settings: Settings, key: Buffer): AutoDeps {
  const serperKey = settings.get('serper_api_key');
  const serperState = serperStateIn(settings);
  return {
    async categoryCounts(site) {
      const api = siteApiFor(site, siteSecrets(site, key).apiToken);
      const counts: Record<string, number> = {};
      for (const item of await api.getContent('recipe')) {
        const name = (item.category ?? '').trim();
        if (name) counts[name] = (counts[name] ?? 0) + 1;
      }
      // Categories with no recipe yet are the ones to fill: they count as zero.
      try {
        for (const c of await api.getCategories()) if (c.title && !(c.title in counts)) counts[c.title] = 0;
      } catch { /* the counts above are enough */ }
      return counts;
    },
    async topicIdeas(niche, siteMix = '(not available)') {
      const { candidates, notes } = await topicCandidates(niche, { serperKey, serperState });
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: settings.get('timezone') });
      const answer = await askPrompt(settings, key, 'research-topics', {
        niche,
        today,
        candidates: candidates.map((c) => `- ${c}`).join('\n') || '(none)',
        siteMix,
      });
      return verifyTopics(parseTopicIdeas(niche, answer.content, notes));
    },
    async research(topic) {
      const existingTitles = all<{ t: string }>(
        "SELECT CASE WHEN trim(spy_title) <> '' THEN spy_title ELSE seed_keyword END AS t FROM keywords",
      ).map((r) => r.t);
      return filterWithModel(await researchKeywords(topic, { serperKey, serperState, existingTitles }), async (vars) =>
        (await askPrompt(settings, key, 'research-filter', vars)).content,
      );
    },
    async notify(text) {
      if (!settings.getBool('telegram_enabled')) return;
      await new TelegramClient(settings.get('telegram_bot_token'), settings.get('telegram_chat_id')).sendMessage(text);
    },
  };
}

/** One site's daily run. */
export async function runAutoResearch(site: SiteRow, deps: AutoDeps, today: string): Promise<AutoReport> {
  const report: AutoReport = { day: today, topic: '', added: 0, questions: 0, removedKeywords: 0, removedQuestions: 0 };
  const removed = expireAutoAdded(site.id, site.auto_research_ttl_hours ?? 24);
  report.removedKeywords = removed.keywords;
  report.removedQuestions = removed.questions;

  try {
    const niche = (site.auto_research_niche ?? '').trim();
    if (!niche) throw new Error('no niche set');
    // A site that cannot be read is not a reason to stop: topics are then chosen as before.
    const counts = await deps.categoryCounts?.(site).catch(() => ({} as Record<string, number>)) ?? {};
    const ideas = await deps.topicIdeas(niche, describeSiteMix(counts));
    const history = readHistory(site.auto_research_history);
    const wantRecipes = Math.max(0, site.auto_research_recipes ?? 5);
    const wantQuestions = Math.max(0, site.auto_research_questions ?? 3);
    const topics: string[] = [];

    // A broad topic ("halloween treats") can yield only a few single dishes:
    // top up from the next topics, up to three a day.
    for (let round = 0; round < 3; round++) {
      if (report.added >= wantRecipes && report.questions >= wantQuestions) break;
      const topic = pickTopic(ideas, history, today, topics, counts);
      if (!topic) break;
      topics.push(topic);
      history[topic] = today;

      const result = await deps.research(topic);
      const recipes = result.recipes
        .filter((r) => !r.existing && !r.broad)
        .slice(0, wantRecipes - report.added)
        .map((r) => titleCase(r.text));
      const questions = result.questions.slice(0, Math.max(0, wantQuestions - report.questions)).map((q) => q.text);
      if (recipes.length) report.added += addPastedKeywords(recipes, topic, [site.id], { auto: true }).added;
      if (questions.length) report.questions += addBlogQuestions(site.id, questions, 'manual', 'queued', true).added;
    }
    if (topics.length === 0) throw new Error(`Google gave no topics for "${niche}"${ideas.notes.length ? ` (${ideas.notes.join('; ')})` : ''}`);
    report.topic = topics.join(', ');
    run('UPDATE sites SET auto_research_history = ? WHERE id = ?', JSON.stringify(history), site.id);
  } catch (err) {
    report.error = errorMessage(err);
  }

  run('UPDATE sites SET auto_research_last_day = ?, auto_research_report = ? WHERE id = ?', today, JSON.stringify(report), site.id);
  log.info(`auto research ${site.domain}: ${JSON.stringify(report)}`);
  await deps
    .notify(
      report.error
        ? `<b>Daily research failed</b> — ${site.domain}\n${report.error}`
        : `<b>Daily research</b> — ${site.domain}\nTopic: ${report.topic}\n` +
            `Added ${report.added} recipe keyword(s) and ${report.questions} blog question(s).\n` +
            `Removed unwritten: ${report.removedKeywords} keyword(s), ${report.removedQuestions} question(s).`,
    )
    .catch(() => undefined);
  return report;
}

let busy = false;

/** Called every few minutes: runs each switched-on site once a day, at or after its hour. */
export async function autoResearchTick(settings: Settings, key: Buffer, now = new Date(), deps = liveDeps(settings, key)): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const timezone = settings.get('timezone');
    const today = localDateKey(now, timezone);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(now));
    for (const listed of listSites()) {
      const site = getSite(listed.id);
      if (!site?.auto_research_on || site.auto_research_last_day === today) continue;
      if (hour < (site.auto_research_hour ?? 6)) continue;
      await runAutoResearch(site, deps, today);
    }
  } catch (err) {
    log.warn(`auto research tick failed: ${errorMessage(err)}`);
  } finally {
    busy = false;
  }
}
