import { isSocialOnly } from '../core/social-only.js';
import { halalOnly, haramIn, HALAL_RULE } from '../core/halal.js';
import { styleBlocks } from '../core/writing-style.js';
import { getSite, listSites, siteSecrets } from '../db/repos.js';
import { SiteApiClient, type SiteContentItem } from '../integrations/site-api.js';
import { siteApiFor } from '../integrations/site-api-for.js';
import { askPrompt } from '../llm/ask.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { tryParseJson } from '../pipeline/json.js';
import { SITE_PAGE_PLACEHOLDERS } from '../pipeline/prompt-contexts.js';
import type { Settings } from '../settings.js';
import {
  canWrite,
  getAboutAuto,
  markAboutChecked,
  getPageFacts,
  getSitePage,
  markFailed,
  markPublished,
  markWorking,
  saveDraft,
  savePageFacts,
  type PageFacts,
} from './repo.js';
import {
  cleanPageHtml,
  countWords,
  missingFromPage,
  PAGE_SLUGS,
  PAGE_SPECS,
  PAGE_TITLE,
  type PageSlug,
} from './specs.js';

const log = createLogger('site-pages');

/** Times the model is asked for one page: the first answer plus rewrites that name what was wrong. */
const ATTEMPTS = 3;

/** The owner's facts as the prompt reads them; what is blank is said to be blank, never filled in. */
export function describeFacts(facts: PageFacts): string {
  const lines = [
    facts.author && `- Run by: ${facts.author}`,
    facts.why && `- Why the site exists: ${facts.why}`,
    facts.testing && `- How the recipes are developed and tested: ${facts.testing}`,
    facts.extra && `- Also worth saying: ${facts.extra}`,
  ].filter(Boolean);
  return lines.length > 0
    ? lines.join('\n')
    : '(The owner gave no personal facts. Write only in general, true terms about a recipe website. Name no person, place, year or number.)';
}

/** What the site publishes, in a few lines: counts, categories and a handful of real titles. */
export function describeContent(items: SiteContentItem[]): string {
  const recipes = items.filter((i) => i.type === 'recipe');
  const posts = items.filter((i) => i.type === 'post');
  if (items.length === 0) return '(The site content could not be read; do not describe particular dishes.)';

  const categories = new Map<string, number>();
  for (const r of recipes) {
    const name = (r.category ?? '').trim();
    if (name) categories.set(name, (categories.get(name) ?? 0) + 1);
  }
  const top = [...categories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([name, n]) => `${name} (${n})`);

  // An even spread through the list rather than the first dozen, which are all the newest dish.
  const step = Math.max(1, Math.floor(recipes.length / 12));
  const sample = recipes.filter((_, i) => i % step === 0).slice(0, 12).map((r) => `- ${r.title}`);

  return [
    `${recipes.length} recipes and ${posts.length} blog articles are published.`,
    top.length > 0 ? `Recipe categories: ${top.join(', ')}.` : '',
    sample.length > 0 ? `Some recipes:\n${sample.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Fill the facts the owner left blank with a draft to read and correct.
 *
 * What the owner already typed is never touched. The draft is written from the
 * kinds of dishes the site really publishes, in general words: it carries no
 * site name, address, person, year or number, so the same button suits any site.
 * The author, if blank, becomes "The <site name> Team".
 */
export async function draftSiteFacts(
  siteId: number,
  settings: Settings,
  key: Buffer,
): Promise<{ filled: string[] }> {
  const site = getSite(siteId);
  if (!site) throw new Error('Site not found');

  const current = getPageFacts(siteId);
  const blank = {
    author: current.author.trim() === '',
    why: current.why.trim() === '',
    testing: current.testing.trim() === '',
    extra: current.extra.trim() === '',
  };
  const needsModel = blank.why || blank.testing || blank.extra;

  let drafted = { why: '', testing: '', extra: '' };
  if (needsModel) {
    let items: SiteContentItem[] = [];
    try {
      items = await siteApiFor(site, siteSecrets(site, key).apiToken).getContent();
    } catch (err) {
      log.warn(`${site.domain}: could not read the site's content for the facts draft: ${errorMessage(err)}`);
    }
    const content = describeContent(items);
    const bareDomain = site.domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();

    let problems: string[] = [];
    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      const notes = [
        halalOnly() ? HALAL_RULE : '',
        problems.length > 0 ? `YOUR LAST DRAFT WAS REJECTED. Write all three fields again and fix this: ${problems.join('; ')}.` : '',
      ].filter(Boolean).join('\n\n');

      const result = await askPrompt(settings, key, 'site-page-facts', {
        site: { name: site.name },
        content,
        notes,
        style: styleBlocks(site.writing_style),
      });
      const parsed = tryParseJson<Record<string, unknown>>(result.content)?.value;
      const text = (k: string): string => (typeof parsed?.[k] === 'string' ? (parsed[k] as string).trim() : '');
      const candidate = { why: text('why'), testing: text('testing'), extra: text('extra') };

      problems = [];
      for (const [field, value] of Object.entries(candidate)) {
        if (value === '') problems.push(`"${field}" is empty`);
      }
      const all = Object.values(candidate).join(' ').toLowerCase();
      if (all.includes(bareDomain) || /https?:\/\/|www\./.test(all)) problems.push('it contains a web address');
      if (/\b(19|20)\d{2}\b/.test(all)) problems.push('it contains a year');
      const haram = haramIn(all);
      if (haram) problems.push(`it names "${haram}", which is not allowed`);

      if (problems.length === 0) {
        drafted = candidate;
        ok = true;
      } else {
        log.warn(`${site.domain}: facts draft attempt ${attempt} rejected: ${problems.join('; ')}`);
      }
    }
    if (!ok) throw new Error(`The model could not write a usable draft: ${problems.join('; ')}. Try again.`);
  }

  const filled: string[] = [];
  const next: PageFacts = { ...current };
  if (blank.author) { next.author = `The ${site.name} Team`; filled.push('author'); }
  if (blank.why) { next.why = drafted.why; filled.push('why'); }
  if (blank.testing) { next.testing = drafted.testing; filled.push('testing'); }
  if (blank.extra) { next.extra = drafted.extra; filled.push('extra'); }
  savePageFacts(siteId, next);
  return { filled };
}

/** The answer's html, or null when it is not the JSON asked for. */
function htmlFrom(answer: string): string | null {
  const parsed = tryParseJson<{ html?: unknown }>(answer);
  const value = parsed?.value.html;
  return typeof value === 'string' ? value : null;
}

/**
 * Write one page and keep it as a draft for the owner to read.
 *
 * A draft that lacks a required point, is too short, carries a placeholder
 * nobody can fill, or names alcohol or pork on a Halal-only platform is sent
 * back to the model with exactly what was wrong; after the last attempt the
 * page is marked failed and nothing replaces the draft already there.
 */
export async function writeSitePage(
  siteId: number,
  slug: PageSlug,
  settings: Settings,
  key: Buffer,
): Promise<{ words: number }> {
  const site = getSite(siteId);
  if (!site) throw new Error('Site not found');

  markWorking(siteId, slug);
  try {
    const api = siteApiFor(site, siteSecrets(site, key).apiToken);
    let items: SiteContentItem[] = [];
    try {
      items = await api.getContent();
    } catch (err) {
      // The page can still be written from the facts; it just cannot name real dishes.
      log.warn(`${site.domain}: could not read the site's content for the ${slug} page: ${errorMessage(err)}`);
    }

    const facts = describeFacts(getPageFacts(siteId));
    const content = describeContent(items);
    let problems: string[] = [];

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const notes = [
        halalOnly() ? HALAL_RULE : '',
        problems.length > 0
          ? `YOUR LAST DRAFT WAS REJECTED. Write the whole page again and fix this: ${problems.join('; ')}.`
          : '',
      ].filter(Boolean).join('\n\n');

      const result = await askPrompt(settings, key, 'site-page', {
        site: { name: site.name, domain: site.domain },
        page: { title: PAGE_TITLE[slug], spec: PAGE_SPECS[slug] },
        ph: SITE_PAGE_PLACEHOLDERS,
        facts,
        content,
        notes,
        style: styleBlocks(site.writing_style),
      });

      const raw = htmlFrom(result.content);
      if (raw === null) {
        problems = ['the answer was not the JSON object {"html": "..."}'];
        log.warn(`${site.domain} ${slug}: attempt ${attempt} was not usable JSON`);
        continue;
      }

      const html = cleanPageHtml(raw);
      problems = missingFromPage(slug, html).map((m) => `it needs ${m}`);
      const haram = haramIn(html);
      if (haram) problems.push(`it names "${haram}", which is not allowed: remove it and use no alcohol or pork even as an example`);

      if (problems.length === 0) {
        const words = countWords(html);
        saveDraft(siteId, slug, html, words);
        log.info(`${site.domain}: ${slug} page written (${words} words, attempt ${attempt})`);
        return { words };
      }
      log.warn(`${site.domain} ${slug}: attempt ${attempt} rejected: ${problems.join('; ')}`);
    }

    throw new Error(`The model could not write a page that passes: ${problems.join('; ')}. Try again, or edit the prompt under Setup → Prompts.`);
  } catch (err) {
    markFailed(siteId, slug, errorMessage(err));
    throw err;
  }
}

/**
 * Write and publish every page, one after the other.
 *
 * A page that fails (the model never passes the checks, or the site refuses it)
 * is marked failed with the reason on its own row and the rest carry on. A page
 * already being written is left alone. Each page's draft stays in the list, so
 * what went live can still be read afterwards.
 */
export async function writeAndPublishAll(
  siteId: number,
  settings: Settings,
  key: Buffer,
): Promise<{ published: PageSlug[]; failed: PageSlug[]; skipped: PageSlug[] }> {
  const published: PageSlug[] = [];
  const failed: PageSlug[] = [];
  const skipped: PageSlug[] = [];
  for (const slug of PAGE_SLUGS) {
    if (!canWrite(getSitePage(siteId, slug))) {
      skipped.push(slug);
      continue;
    }
    try {
      await writeSitePage(siteId, slug, settings, key);
      await publishSitePage(siteId, slug, key);
      published.push(slug);
    } catch (err) {
      log.warn(`site ${siteId}: ${slug} page not published: ${errorMessage(err)}`);
      failed.push(slug);
    }
  }
  return { published, failed, skipped };
}

/** Days between checks of the About page. */
export const ABOUT_REFRESH_DAYS = 7;
/** The site must have changed by at least this share of its recipes and articles (and at least MIN_CHANGE items). */
const CHANGE_SHARE = 0.1;
const MIN_CHANGE = 5;

/** The shape of a site as "recipes|posts|categories", compared from one check to the next. */
export function siteSignature(items: SiteContentItem[]): string {
  const recipes = items.filter((i) => i.type === 'recipe');
  const posts = items.filter((i) => i.type === 'post').length;
  const categories = new Set(recipes.map((r) => (r.category ?? '').trim().toLowerCase()).filter(Boolean)).size;
  return `${recipes.length}|${posts}|${categories}`;
}

/** Has the site grown enough, or gained or lost a category, since `before`? A blank `before` is never a change. */
export function siteChanged(before: string, now: string): boolean {
  if (before === '') return false;
  const [r0, p0, c0] = before.split('|').map(Number);
  const [r1, p1, c1] = now.split('|').map(Number);
  if ([r0, p0, c0, r1, p1, c1].some((n) => !Number.isFinite(n))) return false;
  if (c0 !== c1) return true;
  const moved = Math.abs(r1! - r0!) + Math.abs(p1! - p0!);
  return moved >= Math.max(MIN_CHANGE, Math.ceil((r0! + p0!) * CHANGE_SHARE));
}

/** True once a week has passed since the About page was sent or last checked, whichever is later. */
export function aboutCheckDue(publishedAt: string | null, checkedAt: string | null, now = Date.now()): boolean {
  if (!publishedAt) return false;
  const at = (s: string | null): number => (s ? Date.parse(`${s.replace(' ', 'T')}Z`) : 0);
  return now - Math.max(at(publishedAt), at(checkedAt)) >= ABOUT_REFRESH_DAYS * 86_400_000;
}

/**
 * The weekly About check for one site: when a week has passed and the site has
 * grown, write the page again and send it. The first check only records what the
 * site looks like. Only a page already sent is refreshed, so the owner has read it once.
 */
export async function refreshAboutIfDue(
  siteId: number,
  settings: Settings,
  key: Buffer,
  lock: { tryLock: () => boolean; unlock: () => void },
): Promise<'off' | 'not due' | 'baseline' | 'unchanged' | 'busy' | 'refreshed' | 'failed'> {
  const site = getSite(siteId);
  const auto = getAboutAuto(siteId);
  const about = getSitePage(siteId, 'about');
  if (!site || !auto.on) return 'off';
  if (!aboutCheckDue(about?.published_at ?? null, auto.checked_at)) return 'not due';
  if (!canWrite(about)) return 'busy';

  const items = await siteApiFor(site, siteSecrets(site, key).apiToken).getContent();
  const now = siteSignature(items);
  if (auto.seen === '') {
    markAboutChecked(siteId, now);
    return 'baseline';
  }
  if (!siteChanged(auto.seen, now)) {
    markAboutChecked(siteId, auto.seen);
    return 'unchanged';
  }

  // The model shares its host with recipe runs; wait for the next tick if one is going.
  if (!lock.tryLock()) return 'busy';
  try {
    await writeSitePage(siteId, 'about', settings, key);
    await publishSitePage(siteId, 'about', key);
    markAboutChecked(siteId, now);
    log.info(`${site.domain}: About page refreshed (${auto.seen} -> ${now})`);
    return 'refreshed';
  } catch (err) {
    // The page row carries the reason; the old About stays live. Try again in a week.
    markAboutChecked(siteId, auto.seen);
    log.warn(`${site.domain}: About refresh failed: ${errorMessage(err)}`);
    return 'failed';
  } finally {
    lock.unlock();
  }
}

/** The clock: each active site with the weekly About refresh switched on. */
export async function tickAboutRefresh(
  settings: Settings,
  key: Buffer,
  lock: { tryLock: () => boolean; unlock: () => void },
): Promise<void> {
  if (!settings.getBool('automation_enabled')) return;
  for (const s of listSites()) {
    // A social-only account has no website to keep an About page on.
    if (s.status !== 'active' || isSocialOnly(s)) continue;
    try {
      await refreshAboutIfDue(s.id, settings, key, lock);
    } catch (err) {
      log.warn(`${s.domain}: About check failed: ${errorMessage(err)}`);
    }
  }
}

/** Send the draft to the site. The site checks it again and says what is missing if it refuses. */
export async function publishSitePage(siteId: number, slug: PageSlug, key: Buffer): Promise<{ words: number }> {
  const site = getSite(siteId);
  if (!site) throw new Error('Site not found');
  const page = getSitePage(siteId, slug);
  if (!page || page.draft_html.trim() === '') throw new Error('There is no draft to publish. Write the page first.');

  // A draft saved before a rule changed, or edited in the database, is checked again.
  const missing = missingFromPage(slug, page.draft_html);
  if (missing.length > 0) throw new Error(`The draft is not complete: it needs ${missing.join('; ')}. Write it again.`);

  const api = siteApiFor(site, siteSecrets(site, key).apiToken);
  try {
    const sent = await api.savePage(slug, page.draft_html);
    markPublished(siteId, slug);
    log.info(`${site.domain}: ${slug} page published`);
    return sent;
  } catch (err) {
    markFailed(siteId, slug, errorMessage(err));
    throw err;
  }
}
