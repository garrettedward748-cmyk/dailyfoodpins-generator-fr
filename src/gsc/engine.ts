import { all, get, run } from '../db/index.js';
import { addPastedKeywords, getSite, listSites, researchRepeats, type SiteRow } from '../db/repos.js';
import { addBlogQuestions } from '../blog/repo.js';
import { halalOnly, haramWord } from '../core/halal.js';
import { localDateKey } from '../core/selector.js';
import { parseJson } from '../pipeline/json.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { GscClient, parseServiceAccount, type GscRow } from './client.js';
import type { Settings } from '../settings.js';
import { askPrompt } from '../llm/ask.js';
import { TelegramClient } from '../integrations/telegram.js';

const log = createLogger('search-console');

/**
 * Search Console -> new articles.
 *
 * Phase one of the plan: the searches a site already appears for in Google
 * with no page of its own. They are Google's own hint of what the site could
 * rank for. Every row is the last 28 days, per query; a query whose top page
 * is already about it is left for phase two (improving that page).
 */

export interface GscSiteFields {
  gsc_property?: string;
  gsc_on?: number;
  gsc_hour?: number;
  gsc_last_day?: string;
  gsc_report?: string;
}

export interface QueryStat {
  query: string;
  impressions: number;
  clicks: number;
  position: number;
  /** The page that appeared most for it; '' when the data has no pages (a CSV). */
  page: string;
}

export interface Opportunity {
  id: number;
  site_id: number;
  query: string;
  kind: 'recipe' | 'question';
  topic: string;
  impressions: number;
  clicks: number;
  position: number;
  page: string;
  status: 'new' | 'added' | 'dismissed';
  updated_at: string;
}

export interface GscReport {
  day: string;
  rows: number;
  queries: number;
  candidates: number;
  found: number;
  error?: string;
}

/** Query + page rows folded into one line per query: totals, impression-weighted position, the main page. */
export function aggregate(rows: GscRow[]): QueryStat[] {
  const map = new Map<string, QueryStat & { posSum: number; pageImp: number }>();
  for (const r of rows) {
    const q = r.query.trim().toLowerCase();
    if (!q) continue;
    const s = map.get(q) ?? { query: q, impressions: 0, clicks: 0, position: 0, page: '', posSum: 0, pageImp: -1 };
    s.impressions += r.impressions;
    s.clicks += r.clicks;
    s.posSum += r.position * r.impressions;
    if (r.page && r.impressions > s.pageImp) {
      s.page = r.page;
      s.pageImp = r.impressions;
    }
    map.set(q, s);
  }
  return [...map.values()]
    .map(({ posSum, pageImp: _p, ...s }) => ({ ...s, position: s.impressions ? Math.round((posSum / s.impressions) * 10) / 10 : 0 }))
    .sort((a, b) => b.impressions - a.impressions);
}

const STOP = new Set(
  'a an and the of for with to in on is are can you i do does how what why when should my your best easy recipe recipes make making homemade simple quick from without'.split(' '),
);
const stem = (w: string) => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
export const words = (text: string): string[] =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !STOP.has(w)).map(stem);

/** Whether the page that appears for a search is already about it: every content word of the search is in its address. */
export function pageCovers(query: string, page: string): boolean {
  if (!page) return false;
  let slug = '';
  try {
    slug = new URL(page).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    slug = page;
  }
  const have = new Set(words(slug.replace(/-/g, ' ')));
  const need = words(query);
  return need.length > 0 && need.every((w) => have.has(w));
}

const norm = (t: string) => words(t).sort().join(' ');

/** The searches worth showing to the model: enough impressions, not the site's name, not haram, not already covered or decided. */
export function candidates(stats: QueryStat[], site: { id: number; domain: string }, minImpressions: number): QueryStat[] {
  const brand = site.domain.replace(/^www\./, '').split('.')[0]!.toLowerCase();
  const halal = halalOnly();
  const known = new Set<string>([
    // What this site has; a keyword only another site has is still free here.
    ...researchRepeats([site.id]).here.map((t) => norm(t)),
    ...all<{ t: string }>('SELECT question AS t FROM blog_questions WHERE site_id = ?', site.id).map((r) => norm(r.t)),
    ...all<{ t: string }>("SELECT query AS t FROM gsc_opportunities WHERE site_id = ? AND status <> 'new'", site.id).map((r) => norm(r.t)),
  ]);
  return stats.filter(
    (s) =>
      s.impressions >= minImpressions &&
      !(brand.length >= 4 && s.query.replace(/\s+/g, '').includes(brand)) &&
      !(halal && haramWord(s.query)) &&
      !pageCovers(s.query, s.page) &&
      !known.has(norm(s.query)),
  );
}

const BATCH = 60;

/** The model's verdict, batch by batch: which are a recipe, which a question, the rest dropped. */
export async function classify(
  list: QueryStat[],
  ask: (items: string) => Promise<string>,
): Promise<{ stat: QueryStat; kind: 'recipe' | 'question'; topic: string }[]> {
  const out: { stat: QueryStat; kind: 'recipe' | 'question'; topic: string }[] = [];
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const items = batch
      .map((s, j) => {
        let path = '';
        try {
          path = s.page ? new URL(s.page).pathname : '';
        } catch {
          path = s.page;
        }
        return `${j + 1}. ${s.query} (${s.impressions} impressions${path ? `; ${path}` : ''})`;
      })
      .join('\n');
    const parsed = parseJson(await ask(items), 'the Search Console sort') as { keep?: { n?: unknown; type?: unknown; group?: unknown }[] };
    for (const k of parsed.keep ?? []) {
      const stat = batch[Number(k.n) - 1];
      const kind = k.type === 'recipe' || k.type === 'question' ? k.type : null;
      if (!stat || !kind) continue;
      out.push({ stat, kind, topic: String(k.group ?? '').trim().toLowerCase().slice(0, 40) });
    }
  }
  return out;
}

/** Save what was found; a search seen again gets fresh numbers, and one already added or dismissed keeps its decision. */
export function saveOpportunities(siteId: number, found: { stat: QueryStat; kind: 'recipe' | 'question'; topic: string }[]): number {
  let n = 0;
  for (const f of found) {
    n += run(
      `INSERT INTO gsc_opportunities (site_id, query, kind, topic, impressions, clicks, position, page)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (site_id, query) DO UPDATE SET
         impressions = excluded.impressions, clicks = excluded.clicks, position = excluded.position,
         page = excluded.page, updated_at = datetime('now')`,
      siteId, f.stat.query, f.kind, f.topic, Math.round(f.stat.impressions), Math.round(f.stat.clicks), f.stat.position, f.stat.page,
    ).changes;
  }
  return n;
}

export function listOpportunities(siteId: number, status: Opportunity['status'] = 'new'): Opportunity[] {
  return all<Opportunity>(
    'SELECT * FROM gsc_opportunities WHERE site_id = ? AND status = ? ORDER BY impressions DESC LIMIT 500',
    siteId,
    status,
  );
}

export const countOpportunities = (siteId: number): number =>
  get<{ n: number }>("SELECT COUNT(*) AS n FROM gsc_opportunities WHERE site_id = ? AND status = 'new'", siteId)?.n ?? 0;

/** Add the ticked ones: recipes to Keywords under their topic, questions to Blog. */
export function addOpportunities(siteId: number, ids: number[]): { recipes: number; questions: number } {
  const rows = ids.length
    ? all<Opportunity>(
        `SELECT * FROM gsc_opportunities WHERE site_id = ? AND status = 'new' AND id IN (${ids.map(() => '?').join(',')})`,
        siteId,
        ...ids,
      )
    : [];
  const byTopic = new Map<string, string[]>();
  const questions: string[] = [];
  for (const r of rows) {
    if (r.kind === 'question') questions.push(r.query);
    else {
      const topic = r.topic || 'search console';
      byTopic.set(topic, [...(byTopic.get(topic) ?? []), r.query.replace(/\b\w/g, (c) => c.toUpperCase())]);
    }
  }
  let recipes = 0;
  for (const [topic, lines] of byTopic) {
    const r = addPastedKeywords(lines, topic, [siteId]);
    recipes += r.added + r.linked;
  }
  const q = questions.length ? addBlogQuestions(siteId, questions).added : 0;
  for (const r of rows) run("UPDATE gsc_opportunities SET status = 'added', updated_at = datetime('now') WHERE id = ?", r.id);
  return { recipes, questions: q };
}

export function dismissOpportunities(siteId: number, ids: number[]): number {
  let n = 0;
  for (const id of ids) n += run("UPDATE gsc_opportunities SET status = 'dismissed', updated_at = datetime('now') WHERE site_id = ? AND id = ?", siteId, id).changes;
  return n;
}

/**
 * A Search Console "Queries.csv" (Performance -> Export -> Download CSV, then
 * the file of that name in the zip). It has no pages, so the page check is
 * skipped and the model decides alone.
 */
export function parseQueriesCsv(text: string): QueryStat[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const split = (l: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i]!;
      if (c === '"') {
        if (quoted && l[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
      } else if (c === ',' && !quoted) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  };
  const head = split(lines[0]!).map((h) => h.toLowerCase());
  const qi = head.findIndex((h) => h.includes('quer'));
  const ii = head.findIndex((h) => h.includes('impression'));
  const ci = head.findIndex((h) => h.includes('click'));
  const pi = head.findIndex((h) => h.includes('position'));
  if (qi < 0 || ii < 0) throw new Error('This is not the Queries file: it needs a "Top queries" and an "Impressions" column.');
  const num = (v: string | undefined) => Number(String(v ?? '').replace(/[%\s,]/g, '')) || 0;
  return lines.slice(1).map((l) => {
    const c = split(l);
    return { query: (c[qi] ?? '').toLowerCase(), impressions: num(c[ii]), clicks: num(c[ci]), position: num(c[pi]), page: '' };
  }).filter((s) => s.query);
}

export interface GscDeps {
  fetchRows(property: string, start: string, end: string): Promise<GscRow[]>;
  ask(items: string): Promise<string>;
  notify(text: string): Promise<void>;
}

const dayMinus = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** One site: the last 28 days (Search Console runs about three days behind), sorted and saved. */
export async function refreshSite(site: SiteRow & GscSiteFields, deps: GscDeps, today: string, minImpressions: number, stats?: QueryStat[]): Promise<GscReport> {
  const report: GscReport = { day: today, rows: 0, queries: 0, candidates: 0, found: 0 };
  try {
    let list = stats;
    if (!list) {
      if (!site.gsc_property) throw new Error('no Search Console property chosen for this site');
      const rows = await deps.fetchRows(site.gsc_property, dayMinus(today, 30), dayMinus(today, 3));
      report.rows = rows.length;
      list = aggregate(rows);
    }
    report.queries = list.length;
    const pool = candidates(list, site, minImpressions);
    report.candidates = pool.length;
    report.found = saveOpportunities(site.id, await classify(pool, deps.ask));
  } catch (err) {
    report.error = errorMessage(err);
  }
  run('UPDATE sites SET gsc_report = ? WHERE id = ?', JSON.stringify(report), site.id);
  log.info(`search console ${site.domain}: ${JSON.stringify(report)}`);
  return report;
}

let busy = false;

/** Every few minutes: each switched-on site once a day, at or after its hour. */
export async function gscTick(timezone: string, deps: GscDeps, minImpressions: number, now = new Date()): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const today = localDateKey(now, timezone);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(now));
    for (const listed of listSites()) {
      const site = getSite(listed.id) as (SiteRow & GscSiteFields) | undefined;
      if (!site?.gsc_on || !site.gsc_property || site.gsc_last_day === today) continue;
      if (hour < (site.gsc_hour ?? 7)) continue;
      run('UPDATE sites SET gsc_last_day = ? WHERE id = ?', today, site.id);
      const r = await refreshSite(site, deps, today, minImpressions);
      await deps
        .notify(
          r.error
            ? `<b>Search Console failed</b> — ${site.domain}\n${r.error}`
            : `<b>Search Console</b> — ${site.domain}\n${r.queries} searches in 28 days; ${r.found} new or updated article idea(s). ` +
                `${countOpportunities(site.id)} waiting under Search Console → Opportunities.`,
        )
        .catch(() => undefined);
    }
  } catch (err) {
    log.warn(`search console tick failed: ${errorMessage(err)}`);
  } finally {
    busy = false;
  }
}

/* -- Live wiring ----------------------------------------------------------- */


/** The client for the saved key, or null when there is none yet. */
export function gscClientFrom(settings: Settings): GscClient | null {
  const json = settings.get('gsc_service_account').trim();
  return json ? new GscClient(parseServiceAccount(json)) : null;
}

export function liveGscDeps(settings: Settings, key: Buffer): GscDeps {
  return {
    async fetchRows(property, start, end) {
      const client = gscClientFrom(settings);
      if (!client) throw new Error('no Search Console key saved (Search Console → Setup)');
      return client.searchAnalytics(property, start, end);
    },
    ask: async (items) => (await askPrompt(settings, key, 'gsc-classify', { items })).content,
    async notify(text) {
      if (!settings.getBool('telegram_enabled')) return;
      await new TelegramClient(settings.get('telegram_bot_token'), settings.get('telegram_chat_id')).sendMessage(text);
    },
  };
}

export const minImpressionsFrom = (settings: Settings): number => Math.max(1, Number(settings.get('gsc_min_impressions')) || 20);
