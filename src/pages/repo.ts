import { all, get, run } from '../db/index.js';
import { PAGE_SLUGS, type PageSlug } from './specs.js';

/** What only the owner knows about a site; the pages are written from this and the site's content. */
export interface PageFacts {
  author: string;
  why: string;
  testing: string;
  extra: string;
}

export type PageStatus = 'empty' | 'working' | 'draft' | 'published' | 'failed';

export interface SitePageRow {
  id: number;
  site_id: number;
  slug: PageSlug;
  status: PageStatus;
  draft_html: string;
  words: number;
  error: string | null;
  written_at: string | null;
  published_at: string | null;
}

/** A page marked "working" for longer than this has lost its writer (a restart); it may be written again. */
export const STUCK_MINUTES = 15;

export function getPageFacts(siteId: number): PageFacts {
  const row = get<PageFacts>('SELECT author, why, testing, extra FROM site_page_facts WHERE site_id = ?', siteId);
  return row ?? { author: '', why: '', testing: '', extra: '' };
}

export function savePageFacts(siteId: number, facts: PageFacts): void {
  const clip = (s: string, n: number) => s.trim().slice(0, n);
  run(
    `INSERT INTO site_page_facts (site_id, author, why, testing, extra, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (site_id) DO UPDATE SET
       author = excluded.author, why = excluded.why, testing = excluded.testing,
       extra = excluded.extra, updated_at = datetime('now')`,
    siteId, clip(facts.author, 120), clip(facts.why, 1500), clip(facts.testing, 1500), clip(facts.extra, 1500),
  );
}

/** The weekly About refresh: whether it is on, what the site looked like at the last check, and when. */
export interface AboutAuto {
  on: boolean;
  seen: string;
  checked_at: string | null;
}

export function getAboutAuto(siteId: number): AboutAuto {
  const row = get<{ auto_about: number; about_seen: string; about_checked_at: string | null }>(
    'SELECT auto_about, about_seen, about_checked_at FROM site_page_facts WHERE site_id = ?',
    siteId,
  );
  return { on: Boolean(row?.auto_about), seen: row?.about_seen ?? '', checked_at: row?.about_checked_at ?? null };
}

function ensureFactsRow(siteId: number): void {
  run('INSERT OR IGNORE INTO site_page_facts (site_id) VALUES (?)', siteId);
}

export function setAboutAuto(siteId: number, on: boolean): void {
  ensureFactsRow(siteId);
  run('UPDATE site_page_facts SET auto_about = ? WHERE site_id = ?', on ? 1 : 0, siteId);
}

/** Record a check: the site's shape now, and the time, so the next one is a week away. */
export function markAboutChecked(siteId: number, seen: string): void {
  ensureFactsRow(siteId);
  run("UPDATE site_page_facts SET about_seen = ?, about_checked_at = datetime('now') WHERE site_id = ?", seen, siteId);
}

/** All five pages of a site, in display order, with a blank row for any not written yet. */
export function listSitePages(siteId: number): SitePageRow[] {
  const rows = all<SitePageRow>('SELECT * FROM site_pages WHERE site_id = ?', siteId);
  return PAGE_SLUGS.map(
    (slug) =>
      rows.find((r) => r.slug === slug) ?? {
        id: 0, site_id: siteId, slug, status: 'empty' as const, draft_html: '', words: 0,
        error: null, written_at: null, published_at: null,
      },
  );
}

export function getSitePage(siteId: number, slug: PageSlug): SitePageRow | undefined {
  return get<SitePageRow>('SELECT * FROM site_pages WHERE site_id = ? AND slug = ?', siteId, slug);
}

function ensureRow(siteId: number, slug: PageSlug): void {
  run('INSERT OR IGNORE INTO site_pages (site_id, slug) VALUES (?, ?)', siteId, slug);
}

/** True when the page can be written now: not already being written (or the writer was lost). */
export function canWrite(row: SitePageRow | undefined): boolean {
  if (!row || row.status !== 'working') return true;
  const since = row.written_at ? Date.parse(`${row.written_at.replace(' ', 'T')}Z`) : 0;
  return Date.now() - since > STUCK_MINUTES * 60_000;
}

export function markWorking(siteId: number, slug: PageSlug): void {
  ensureRow(siteId, slug);
  run(
    "UPDATE site_pages SET status = 'working', error = NULL, written_at = datetime('now') WHERE site_id = ? AND slug = ?",
    siteId, slug,
  );
}

export function saveDraft(siteId: number, slug: PageSlug, html: string, words: number): void {
  ensureRow(siteId, slug);
  run(
    "UPDATE site_pages SET status = 'draft', draft_html = ?, words = ?, error = NULL, written_at = datetime('now') WHERE site_id = ? AND slug = ?",
    html, words, siteId, slug,
  );
}

export function markFailed(siteId: number, slug: PageSlug, error: string): void {
  ensureRow(siteId, slug);
  // A failed rewrite must not cost the page already sent: the status says what
  // happened, the draft that was there stays.
  run("UPDATE site_pages SET status = 'failed', error = ? WHERE site_id = ? AND slug = ?", error.slice(0, 500), siteId, slug);
}

export function markPublished(siteId: number, slug: PageSlug): void {
  run(
    "UPDATE site_pages SET status = 'published', error = NULL, published_at = datetime('now') WHERE site_id = ? AND slug = ?",
    siteId, slug,
  );
}
