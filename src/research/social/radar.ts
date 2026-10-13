import { all, run } from '../../db/index.js';
import { addPastedKeywords, getSite, listSites, type SiteRow } from '../../db/repos.js';
import { addBlogQuestions } from '../../blog/repo.js';
import { halalOnly, haramWord } from '../../core/halal.js';
import { localDateKey } from '../../core/selector.js';
import { DishIndex } from '../../core/similar-title.js';
import { parseJson } from '../../pipeline/json.js';
import { createLogger, errorMessage } from '../../lib/logger.js';
import { askPrompt } from '../../llm/ask.js';
import { TelegramClient } from '../../integrations/telegram.js';
import type { Settings } from '../../settings.js';
import { engagementScore, type SocialPost } from './facebook.js';
import { minScoreFrom, postsPerPageFrom, providerFrom } from './providers.js';
import {
  countWaiting, enabledSources, knownPostIds, listPosts, markScanned, markStatus, pickPosts, refreshScores, savePosts,
  type RadarPost,
} from './repo.js';

const log = createLogger('radar');

/**
 * Radar: what the niche is sharing, turned into articles.
 *
 * Search Console says what people type into Google. This says what they pass
 * on to each other, which is a different and complementary thing: a post with
 * four hundred shares is proof the subject moves people, and no search volume
 * tells you that. The pages to watch are chosen per site.
 *
 * What is kept is the *idea*, never the post. The title and topic go to
 * Keywords, the existing pipeline writes the article from scratch and draws
 * its own pictures, and the scraped text is held only so you can see what the
 * idea came from before you accept it.
 */

export interface RadarSiteFields {
  radar_on?: number;
  radar_hour?: number;
  radar_last_day?: string;
  radar_report?: string;
}

export interface RadarReport {
  day: string;
  pages: number;
  posts: number;
  candidates: number;
  found: number;
  /** Already-saved posts whose numbers were brought up to date. */
  refreshed: number;
  error?: string;
}

export interface Candidate {
  sourceId: number;
  post: SocialPost;
  score: number;
}

const norm = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');

/**
 * The posts worth the model's time: loud enough, not seen before, not haram.
 *
 * Pure, so the thresholds can be argued with in a test. The duplicate check is
 * by the provider's post id: a post from an earlier scan is dropped here so
 * the model is never paid to judge it twice. Its numbers are not lost with it —
 * scanSite refreshes those separately, which is the whole reason this function
 * reports what it dropped rather than quietly swallowing it.
 */
export function candidates(found: Candidate[], seen: Set<string>, minScore: number): Candidate[] {
  const halal = halalOnly();
  return found
    .filter((c) => c.score >= minScore && !seen.has(c.post.postId) && !(halal && haramWord(c.post.text)))
    .sort((a, b) => b.score - a.score);
}

const BATCH = 25;

/**
 * The model's verdict, batch by batch.
 *
 * It is asked for an article title in the site's own voice, not for the post
 * back. A post it cannot turn into something the site would publish is left
 * out entirely — most of them are, and that is the filter earning its keep.
 */
export async function classify(
  list: Candidate[],
  ask: (items: string) => Promise<string>,
): Promise<{ candidate: Candidate; kind: 'recipe' | 'question'; title: string; topic: string }[]> {
  const out: { candidate: Candidate; kind: 'recipe' | 'question'; title: string; topic: string }[] = [];
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const items = batch
      .map((c, j) => `${j + 1}. [${c.score} engagement] ${c.post.text.replace(/\s+/g, ' ').slice(0, 600)}`)
      .join('\n\n');
    let parsed: { keep?: { n?: unknown; type?: unknown; title?: unknown; group?: unknown }[] };
    try {
      parsed = parseJson(await ask(items), 'the radar sort') as typeof parsed;
    } catch (err) {
      log.warn(`radar batch ${i / BATCH + 1} unreadable: ${errorMessage(err)}`);
      continue;
    }
    for (const k of parsed.keep ?? []) {
      const candidate = batch[Number(k.n) - 1];
      const kind = k.type === 'recipe' || k.type === 'question' ? k.type : null;
      const title = String(k.title ?? '').trim();
      if (!candidate || !kind || title.length < 3) continue;
      out.push({ candidate, kind, title, topic: String(k.group ?? '').trim().toLowerCase().slice(0, 40) });
    }
  }
  return out;
}

/** Titles this site already has, so the radar does not propose yesterday's article again. */
function existingTitles(siteId: number): DishIndex {
  return new DishIndex([
    ...all<{ t: string }>("SELECT CASE WHEN trim(spy_title) <> '' THEN spy_title ELSE seed_keyword END AS t FROM keywords").map((r) => r.t),
    ...all<{ t: string }>('SELECT question AS t FROM blog_questions WHERE site_id = ?', siteId).map((r) => r.t),
    ...all<{ t: string }>("SELECT title AS t FROM social_posts WHERE site_id = ? AND status <> 'new' AND trim(title) <> ''", siteId).map((r) => r.t),
  ]);
}

export interface RadarDeps {
  fetchPosts(handle: string, limit: number): Promise<SocialPost[]>;
  ask(items: string): Promise<string>;
  notify(text: string): Promise<void>;
}

/** One site: every watched page read, sorted, and the keepers saved. */
export async function scanSite(
  site: SiteRow & RadarSiteFields,
  deps: RadarDeps,
  today: string,
  options: { perPage: number; minScore: number },
): Promise<RadarReport> {
  const report: RadarReport = { day: today, pages: 0, posts: 0, candidates: 0, found: 0, refreshed: 0 };
  try {
    const sources = enabledSources(site.id);
    report.pages = sources.length;
    if (sources.length === 0) throw new Error('no pages to watch yet');

    const fetched: Candidate[] = [];
    const failures: string[] = [];
    for (const source of sources) {
      try {
        const posts = await deps.fetchPosts(source.handle, options.perPage);
        for (const post of posts) fetched.push({ sourceId: source.id, post, score: engagementScore(post) });
        markScanned(source.id);
      } catch (err) {
        // One unreachable page must not cost the other pages their scan.
        const message = errorMessage(err);
        failures.push(`${source.handle}: ${message}`);
        markScanned(source.id, message);
        log.warn(`radar ${site.domain} / ${source.handle} failed: ${message}`);
      }
    }
    report.posts = fetched.length;

    const seen = knownPostIds(site.id);

    // The posts read again today: still waiting, and louder than when they
    // were first found. Their numbers go in before anything else, so the
    // waiting list is ordered by where a post stands now rather than by where
    // it stood on the morning it was discovered.
    report.refreshed = refreshScores(
      site.id,
      fetched
        .filter((c) => seen.has(c.post.postId))
        .map((c) => ({ postId: c.post.postId, likes: c.post.likes, comments: c.post.comments, shares: c.post.shares, score: c.score })),
    );

    const pool = candidates(fetched, seen, options.minScore);
    report.candidates = pool.length;

    // The near-duplicate check runs on the model's titles, not on the posts:
    // two pages posting about the same thing produce two different texts and
    // one article.
    const twins = existingTitles(site.id);
    const kept = (await classify(pool, deps.ask)).filter((k) => {
      if (twins.find(k.title)) return false;
      twins.add(k.title);
      return true;
    });

    report.found = savePosts(
      site.id,
      kept.map((k) => ({ sourceId: k.candidate.sourceId, post: k.candidate.post, score: k.candidate.score, kind: k.kind, title: k.title, topic: k.topic })),
    );
    if (failures.length && report.posts === 0) throw new Error(failures.join('; '));
  } catch (err) {
    report.error = errorMessage(err);
  }
  run('UPDATE sites SET radar_report = ? WHERE id = ?', JSON.stringify(report), site.id);
  log.info(`radar ${site.domain}: ${JSON.stringify(report)}`);
  return report;
}

/** Add the ticked ones: article ideas to Keywords under their topic, questions to Blog. */
export function addToQueue(siteId: number, ids: number[]): { recipes: number; questions: number } {
  const rows = pickPosts(siteId, ids);
  const byTopic = new Map<string, string[]>();
  const questions: string[] = [];
  for (const r of rows) {
    if (r.kind === 'question') questions.push(r.title);
    else byTopic.set(r.topic || 'radar', [...(byTopic.get(r.topic || 'radar') ?? []), r.title]);
  }
  let recipes = 0;
  for (const [topic, lines] of byTopic) recipes += addPastedKeywords(lines, topic, [siteId]).added;
  const q = questions.length ? addBlogQuestions(siteId, questions).added : 0;
  markStatus(siteId, rows.map((r) => r.id), 'added');
  return { recipes, questions: q };
}

export const dismiss = (siteId: number, ids: number[]): number => markStatus(siteId, ids, 'dismissed');

export { listPosts, countWaiting, type RadarPost };

let busy = false;

/** Every ten minutes: each switched-on site once a day, at or after its hour. */
export async function radarTick(
  timezone: string,
  deps: RadarDeps,
  options: { perPage: number; minScore: number },
  now = new Date(),
): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const today = localDateKey(now, timezone);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(now));
    for (const listed of listSites()) {
      const site = getSite(listed.id) as (SiteRow & RadarSiteFields) | undefined;
      if (!site?.radar_on || site.radar_last_day === today) continue;
      if (hour < (site.radar_hour ?? 6)) continue;
      run('UPDATE sites SET radar_last_day = ? WHERE id = ?', today, site.id);
      const r = await scanSite(site, deps, today, options);
      await deps
        .notify(
          r.error
            ? `<b>Radar failed</b> — ${site.domain}\n${r.error}`
            : `<b>Radar</b> — ${site.domain}\n${r.posts} post(s) from ${r.pages} page(s); ${r.found} new idea(s). ` +
                `${countWaiting(site.id)} waiting under Content → Radar.`,
        )
        .catch(() => undefined);
    }
  } catch (err) {
    log.warn(`radar tick failed: ${errorMessage(err)}`);
  } finally {
    busy = false;
  }
}

/* -- Live wiring ----------------------------------------------------------- */

export function liveRadarDeps(settings: Settings, key: Buffer): RadarDeps {
  return {
    fetchPosts: (handle, limit) => providerFrom(settings).fetchPosts(handle, limit),
    ask: async (items) => (await askPrompt(settings, key, 'radar-sort', { items })).content,
    async notify(text) {
      if (!settings.getBool('telegram_enabled')) return;
      await new TelegramClient(settings.get('telegram_bot_token'), settings.get('telegram_chat_id')).sendMessage(text);
    },
  };
}

export const radarOptionsFrom = (settings: Settings): { perPage: number; minScore: number } => ({
  perPage: postsPerPageFrom(settings),
  minScore: minScoreFrom(settings),
});
