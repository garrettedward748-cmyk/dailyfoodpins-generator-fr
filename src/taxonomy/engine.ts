import { randomUUID } from 'node:crypto';
import { all, get, run } from '../db/index.js';
import { getSite, insertEvent, listSites, siteSecrets, type SiteRow } from '../db/repos.js';
import { HALAL_RULE, halalOnly } from '../core/halal.js';
import { resolveProjectId } from '../core/project-id.js';
import { askPrompt } from '../llm/ask.js';
import { tryParseJson } from '../pipeline/json.js';
import { render } from '../pipeline/prompts.js';
import { cleanArticleHtml, dedupeLinks } from '../blog/engine.js';
import { ImageClient } from '../integrations/images.js';
import { SiteApiClient, type TaxonomyItem, type TaxonomyTable, type TaxonomyUpdate } from '../integrations/site-api.js';
import { siteApiFor } from '../integrations/site-api-for.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';

/**
 * Taxonomy: the site's category, cuisine and tag pages, filled by the platform.
 *
 * Each term gets what it is missing -- title tag, meta description, intro and
 * long text written by the model (tags have an intro only), and for categories
 * and cuisines a picture made in Flow. Only empty fields are ever sent, and the
 * site refuses to overwrite anyway, so what the owner typed in Admin stays.
 *
 * SEO rules agreed with the owner:
 *  - a tag is written only once it holds 3 published recipes; under that the
 *    site keeps its page out of the index until it grows;
 *  - an unpublished category or cuisine is switched on once it has its text,
 *    its picture and 3 recipes;
 *  - a tag named all in lower case is respelled ("peanut butter" -> "Peanut Butter").
 */

const log = createLogger('taxonomy');

export const MIN_RECIPES = 3;
/** Attempts before a term is left as failed until "Retry failed". */
export const MAX_ATTEMPTS = 3;

export const DEFAULT_IMAGE_PROMPT =
  'A beautiful overhead food photograph for the "{{name}}" {{kind}} page of a home-cooking recipe website. ' +
  'An inviting spread of three or four typical {{name}} dishes on a rustic table, natural soft daylight, warm ' +
  'appetizing colours, shallow depth of field, styled like a food magazine cover. ' +
  'No text, no letters, no logos, no watermark, no people, no hands. ' +
  'Halal food only: no alcohol, no wine, no beer, no pork.';

const KIND: Record<TaxonomyTable, string> = { categories: 'category', cuisines: 'cuisine', tags: 'tag' };

/* ---------- Deciding what a term needs (pure) ---------- */

export interface TermPlan {
  /** Text fields to write. */
  text: string[];
  image: boolean;
  /** The respelled name, when the current one is all lower case. */
  rename?: string;
}

/** "peanut butter" -> "Peanut Butter"; a name with any capital stays as written. */
export function displayName(name: string): string {
  if (name !== name.toLowerCase()) return name;
  return name.replace(/(^|[\s\-/(])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

export function planFor(item: TaxonomyItem): TermPlan {
  const plan: TermPlan = { text: [], image: false };
  if (item.table === 'tags') {
    if (item.recipes >= MIN_RECIPES) plan.text = item.empty.filter((f) => f === 'intro_html');
    const better = displayName(item.name);
    if (better !== item.name) plan.rename = better;
  } else {
    plan.text = [...item.empty];
    plan.image = !item.image;
  }
  return plan;
}

/** Needs a model or Flow (rename alone is a cheap call, done in bulk). */
export function needsWriting(plan: TermPlan): boolean {
  return plan.text.length > 0 || plan.image;
}

/** Categories, then cuisines, then tags with the most recipes first. */
export function workOrder(items: TaxonomyItem[]): TaxonomyItem[] {
  const rank: Record<TaxonomyTable, number> = { categories: 0, cuisines: 1, tags: 2 };
  return [...items].sort((a, b) => rank[a.table] - rank[b.table] || b.recipes - a.recipes || a.id - b.id);
}

/** Publish an unpublished category or cuisine once nothing is missing and it has enough recipes. */
export function shouldPublish(item: TaxonomyItem, stillEmpty: string[], hasImage: boolean): boolean {
  return item.table !== 'tags' && !item.published && item.recipes >= MIN_RECIPES && stillEmpty.length === 0 && hasImage;
}

/** Keep the requested fields, trimmed to the site's limits, html cleaned. */
export function pickFields(answer: Record<string, unknown>, wanted: string[]): Partial<TaxonomyUpdate> {
  const out: Record<string, string> = {};
  for (const field of wanted) {
    const value = answer[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (field === 'title_tag') out[field] = value.replace(/<[^>]+>/g, '').trim().slice(0, 70);
    else if (field === 'meta_desc') out[field] = value.replace(/<[^>]+>/g, '').trim().slice(0, 170);
    else {
      let html = dedupeLinks(cleanArticleHtml(value));
      if (!/<p\b/i.test(html)) html = `<p>${html}</p>`;
      out[field] = html;
    }
  }
  return out;
}

/* ---------- Doing one term ---------- */

export interface TaxonomyDeps {
  api: Pick<SiteApiClient, 'getTaxonomy' | 'getTaxonomyRecipes' | 'updateTaxonomy' | 'uploadImage'>;
  ask: (vars: Record<string, unknown>) => Promise<string>;
  image: (prompt: string) => Promise<{ data: Buffer; contentType: string }>;
  imagePrompt: string;
}

export interface FillResult {
  updated: string[];
  error?: string;
}

/** Write what one term is missing and send it. Text and picture are tried apart: one failing keeps the other. */
export async function fillTerm(site: { name: string; domain: string }, item: TaxonomyItem, deps: TaxonomyDeps): Promise<FillResult> {
  const plan = planFor(item);
  const update: TaxonomyUpdate = { table: item.table, id: item.id };
  const problems: string[] = [];

  if (plan.text.length) {
    try {
      const recipes = await deps.api.getTaxonomyRecipes(item.table, item.id);
      const content = await deps.ask({
        site,
        kind: KIND[item.table],
        name: displayName(item.name),
        url: item.url,
        count: item.recipes,
        fields: plan.text.join(', '),
        recipes: recipes.length ? recipes.map((r) => `- ${r.title} — ${r.url}`).join('\n') : '(none yet: do not link any recipe)',
        halal: halalOnly() ? HALAL_RULE : '',
      });
      const parsed = tryParseJson<Record<string, unknown>>(content);
      if (!parsed) throw new Error('the model did not answer with JSON');
      const fields = pickFields(parsed.value, plan.text);
      if (!Object.keys(fields).length) throw new Error('the model answered without the requested fields');
      Object.assign(update, fields);
    } catch (err) {
      problems.push(`text: ${errorMessage(err)}`);
    }
  }

  let newImage = '';
  if (plan.image) {
    try {
      const prompt = render(deps.imagePrompt || DEFAULT_IMAGE_PROMPT, { name: displayName(item.name), kind: KIND[item.table] });
      const made = await deps.image(prompt);
      const extension = made.contentType.includes('png') ? 'png' : made.contentType.includes('jpeg') ? 'jpg' : 'webp';
      const uploaded = await deps.api.uploadImage(made.data, `${randomUUID()}.${extension}`, made.contentType, 'taxonomy');
      newImage = uploaded.url;
      update.image = uploaded.url;
    } catch (err) {
      problems.push(`image: ${errorMessage(err)}`);
    }
  }

  if (plan.rename) update.name = plan.rename;

  const stillEmpty = item.empty.filter((f) => !(f in update) && (item.table !== 'tags' || f === 'intro_html'));
  if (shouldPublish(item, stillEmpty, Boolean(item.image || newImage))) update.published = true;

  const updated = Object.keys(update).length > 2 ? await deps.api.updateTaxonomy(update) : [];
  return problems.length ? { updated, error: problems.join('; ') } : { updated };
}

/* ---------- Records ---------- */

export interface TaxonomyJobRow {
  site_id: number;
  tbl: TaxonomyTable;
  term_id: number;
  name: string;
  status: 'done' | 'failed';
  attempts: number;
  filled: string;
  error: string;
  updated_at: string;
}

export function listJobs(siteId: number): TaxonomyJobRow[] {
  return all<TaxonomyJobRow>('SELECT * FROM taxonomy_jobs WHERE site_id = ? ORDER BY updated_at DESC, id DESC LIMIT 200', siteId);
}

function jobFor(siteId: number, item: TaxonomyItem): TaxonomyJobRow | undefined {
  return get<TaxonomyJobRow>('SELECT * FROM taxonomy_jobs WHERE site_id = ? AND tbl = ? AND term_id = ?', siteId, item.table, item.id);
}

function recordJob(siteId: number, item: TaxonomyItem, result: FillResult): void {
  const failed = Boolean(result.error);
  run(
    `INSERT INTO taxonomy_jobs (site_id, tbl, term_id, name, status, attempts, filled, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (site_id, tbl, term_id) DO UPDATE SET
       name = excluded.name, status = excluded.status,
       attempts = CASE WHEN excluded.status = 'failed' THEN taxonomy_jobs.attempts + 1 ELSE 0 END,
       filled = CASE WHEN excluded.filled = '' THEN taxonomy_jobs.filled ELSE excluded.filled END,
       error = excluded.error, updated_at = excluded.updated_at`,
    siteId, item.table, item.id, item.name, failed ? 'failed' : 'done', failed ? 1 : 0,
    result.updated.join(', '), result.error ?? '',
  );
}

export function retryFailed(siteId: number): number {
  return Number(run("UPDATE taxonomy_jobs SET attempts = 0, status = 'done', error = '' WHERE site_id = ? AND status = 'failed'", siteId).changes);
}

/** Given up on for now: failed MAX_ATTEMPTS times in a row. */
function givenUp(siteId: number, item: TaxonomyItem): boolean {
  const job = jobFor(siteId, item);
  return Boolean(job && job.status === 'failed' && job.attempts >= MAX_ATTEMPTS);
}

export interface TaxonomyReport {
  at: string;
  total: number;
  /** Terms still needing text or a picture (tags under 3 recipes are not counted). */
  pending: number;
  missingImages: number;
  thinTags: number;
  error?: string;
}

function saveReport(siteId: number, report: TaxonomyReport): void {
  run('UPDATE sites SET taxo_report = ? WHERE id = ?', JSON.stringify(report), siteId);
}

export function readReport(site: { taxo_report?: string }): TaxonomyReport | null {
  try {
    return site.taxo_report ? (JSON.parse(site.taxo_report) as TaxonomyReport) : null;
  } catch {
    return null;
  }
}

/* ---------- Running ---------- */

export interface TaxonomySiteFields {
  taxo_on: number;
  taxo_report: string;
}

export interface RunOptions {
  /** How many terms to write before stopping (renames do not count). */
  max: number;
  tryLock: () => boolean;
  unlock: () => void;
  heartbeat?: () => void;
  /** "Fill now": wait for a recipe run to finish instead of stopping. */
  waitForLock?: boolean;
  pause?: (ms: number) => Promise<void>;
}

/**
 * Scan one site, respell lower-case tags, then write up to `max` terms.
 * Writing takes the run lock (Flow is shared with recipe runs); when a run
 * holds it, the rest waits for the next tick.
 */
export async function runSite(site: SiteRow, deps: TaxonomyDeps, opts: RunOptions): Promise<{ written: number; renamed: number }> {
  const items = await deps.api.getTaxonomy();
  let renamed = 0;
  for (const item of items) {
    const plan = planFor(item);
    if (plan.rename && !needsWriting(plan)) {
      try {
        await deps.api.updateTaxonomy({ table: item.table, id: item.id, name: plan.rename });
        renamed++;
      } catch (err) {
        log.warn(`${site.domain}: could not respell "${item.name}": ${errorMessage(err)}`);
      }
    }
  }

  const todo = workOrder(items).filter((i) => needsWriting(planFor(i)) && !givenUp(site.id, i));
  const report = (pending: number): TaxonomyReport => ({
    at: new Date().toISOString(),
    total: items.length,
    pending,
    missingImages: items.filter((i) => i.table !== 'tags' && !i.image).length,
    thinTags: items.filter((i) => i.table === 'tags' && i.recipes < MIN_RECIPES).length,
  });
  saveReport(site.id, report(todo.length));

  let written = 0;
  for (const item of todo) {
    if (written >= opts.max) break;
    let locked = opts.tryLock();
    for (let waited = 0; !locked && opts.waitForLock && waited < 120; waited++) {
      await (opts.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(30_000);
      locked = opts.tryLock();
    }
    if (!locked) break;
    try {
      const result = await fillTerm({ name: site.name, domain: site.domain }, item, deps);
      recordJob(site.id, item, result);
      written++;
      if (result.error) {
        insertEvent('warn', 'taxonomy', `${site.domain}: ${KIND[item.table]} "${item.name}" not fully filled`, result.error);
      } else {
        log.info(`${site.domain}: ${KIND[item.table]} "${item.name}" filled (${result.updated.join(', ')})`);
      }
    } catch (err) {
      recordJob(site.id, item, { updated: [], error: errorMessage(err) });
      insertEvent('error', 'taxonomy', `${site.domain}: ${KIND[item.table]} "${item.name}" failed`, errorMessage(err));
    } finally {
      opts.unlock();
      opts.heartbeat?.();
    }
  }
  if (written) saveReport(site.id, report(Math.max(0, todo.length - written)));
  return { written, renamed };
}

export function liveTaxonomyDeps(settings: Settings, key: Buffer, site: SiteRow): TaxonomyDeps {
  const project = resolveProjectId(site.project_id, settings.get('flow_project_id'), site.domain);
  const images = new ImageClient({
    baseUrl: settings.get('image_base_url'),
    apiKey: settings.get('image_api_key'),
    pollIntervalMs: settings.getNumber('image_poll_interval_seconds') * 1000,
    maxAttempts: settings.getNumber('image_poll_max_attempts'),
    projectId: project.projectId,
    imageModel: settings.get('image_model'),
  });
  return {
    api: siteApiFor(site, siteSecrets(site, key).apiToken),
    ask: async (vars) => (await askPrompt(settings, key, 'taxonomy-fill', vars)).content,
    image: async (prompt) => {
      const made = await images.generate(prompt, 'HORIZONTAL');
      return { data: made.data, contentType: made.contentType };
    },
    imagePrompt: settings.get('taxo_image_prompt').trim() || DEFAULT_IMAGE_PROMPT,
  };
}

const running = new Set<number>();

export function isRunning(siteId: number): boolean {
  return running.has(siteId);
}

/** One site in the background, guarded so two never overlap ("Fill now" and the clock). */
export async function runSiteGuarded(siteId: number, settings: Settings, key: Buffer, opts: RunOptions): Promise<void> {
  if (running.has(siteId)) return;
  const site = getSite(siteId);
  if (!site) return;
  running.add(siteId);
  try {
    await runSite(site, liveTaxonomyDeps(settings, key, site), opts);
  } catch (err) {
    const message = errorMessage(err);
    log.warn(`${site.domain}: taxonomy scan failed: ${message}`);
    const old = readReport(site as SiteRow & TaxonomySiteFields);
    saveReport(siteId, { ...(old ?? { total: 0, pending: 0, missingImages: 0, thinTags: 0 }), at: new Date().toISOString(), error: message });
  } finally {
    running.delete(siteId);
  }
}

/** The clock: each switched-on site, one term per tick. */
export async function tickTaxonomy(settings: Settings, key: Buffer, lock: Omit<RunOptions, 'max'>): Promise<void> {
  if (!settings.getBool('automation_enabled')) return;
  for (const s of listSites()) {
    const site = getSite(s.id) as (SiteRow & TaxonomySiteFields) | undefined;
    if (!site || site.status !== 'active' || !site.taxo_on) continue;
    await runSiteGuarded(site.id, settings, key, { ...lock, max: 1 });
  }
}
