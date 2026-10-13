import { halalOnly, haramWord } from '../core/halal.js';
import { all, get, run } from '../db/index.js';
import { QuestionIndex } from '../core/similar-title.js';

/** One People-Also-Ask question waiting to become (or already) a blog article. */
export interface BlogQuestionRow {
  id: number;
  site_id: number;
  question: string;
  status: 'suggested' | 'queued' | 'working' | 'done' | 'failed' | 'skipped';
  source: 'manual' | 'ai';
  attempts: number;
  post_url: string | null;
  recipe_slug: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** A site's blog clock, read off the sites table. */
export interface BlogSiteRow {
  id: number;
  name: string;
  domain: string;
  status: 'active' | 'paused';
  blog_enabled: number;
  blog_daily_target: number;
  blog_interval_minutes: number;
  blog_last_at: string | null;
}

/** Tidy a pasted line into a question: trimmed, one space, capital first, ends with "?". */
export function normaliseQuestion(line: string): string {
  let q = line.replace(/^[\s\-*•\d.)]+/, '').replace(/\s+/g, ' ').trim();
  if (q === '') return '';
  q = q.charAt(0).toUpperCase() + q.slice(1);
  if (!/[?]$/.test(q)) q = q.replace(/[.!]+$/, '') + '?';
  return q.slice(0, 300);
}

/**
 * Add many questions at once, one per line. Duplicates for the same site are
 * skipped rather than refused, so pasting the same list twice is harmless.
 */
export function addBlogQuestions(
  siteId: number,
  lines: string[],
  source: 'manual' | 'ai' = 'manual',
  status: 'queued' | 'suggested' = 'queued',
  auto = false,
): { added: number; skipped: number; similar: string[] } {
  let added = 0;
  let skipped = 0;
  const similar: string[] = [];
  // The same question in other words -- "Can you freeze cheesecake?" and
  // "Can cheesecake be frozen?" style repeats -- is left out, as keywords are.
  const index = new QuestionIndex(
    all<{ question: string }>('SELECT question FROM blog_questions WHERE site_id = ?', siteId).map((r) => r.question),
  );
  for (const line of lines) {
    const q = normaliseQuestion(line);
    if (q.length < 8) {
      if (line.trim() !== '') skipped++;
      continue;
    }
    const haram = halalOnly() ? haramWord(q) : null;
    if (haram) {
      skipped++;
      similar.push(`“${q}” refused: ${haram} (Halal only)`);
      continue;
    }
    const twin = index.find(q, true);
    if (twin) {
      skipped++;
      similar.push(`“${q}” ≈ “${twin}”`);
      continue;
    }
    index.add(q);
    const result = run(
      'INSERT OR IGNORE INTO blog_questions (site_id, question, source, status) VALUES (?, ?, ?, ?)',
      siteId,
      q,
      source,
      status,
    );
    if (result.changes > 0) {
      added++;
      if (auto) run("UPDATE blog_questions SET auto_added_at = datetime('now') WHERE id = ?", result.lastInsertRowid);
    } else skipped++;
  }
  return { added, skipped, similar };
}

export const listBlogQuestions = (siteId?: number): (BlogQuestionRow & { site_domain: string })[] =>
  siteId
    ? all(
        `SELECT q.*, s.domain AS site_domain FROM blog_questions q JOIN sites s ON s.id = q.site_id
         WHERE q.site_id = ? ORDER BY CASE q.status WHEN 'working' THEN 0 WHEN 'suggested' THEN 1 WHEN 'queued' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END, q.id DESC LIMIT 500`,
        siteId,
      )
    : all(
        `SELECT q.*, s.domain AS site_domain FROM blog_questions q JOIN sites s ON s.id = q.site_id
         ORDER BY CASE q.status WHEN 'working' THEN 0 WHEN 'suggested' THEN 1 WHEN 'queued' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END, q.id DESC LIMIT 500`,
      );

export const countBlogQuestions = (siteId: number, status: BlogQuestionRow['status']): number =>
  get<{ n: number }>('SELECT COUNT(*) AS n FROM blog_questions WHERE site_id = ? AND status = ?', siteId, status)?.n ?? 0;

export const getBlogQuestion = (id: number): BlogQuestionRow | undefined =>
  get('SELECT * FROM blog_questions WHERE id = ?', id);

/** The next question to write for a site: oldest queued first. */
export const nextBlogQuestion = (siteId: number): BlogQuestionRow | undefined =>
  get("SELECT * FROM blog_questions WHERE site_id = ? AND status = 'queued' ORDER BY id LIMIT 1", siteId);

/** Every question this site has already answered or is about to, for spotting near-duplicates. */
export const answeredQuestions = (siteId: number): string[] =>
  all<{ question: string }>(
    "SELECT question FROM blog_questions WHERE site_id = ? AND status IN ('done', 'working', 'queued', 'suggested')",
    siteId,
  ).map((r) => r.question);

export function setBlogQuestionStatus(
  id: number,
  status: BlogQuestionRow['status'],
  extra: { error?: string | null; postUrl?: string | null; recipeSlug?: string | null; attempt?: boolean } = {},
): void {
  run(
    `UPDATE blog_questions SET status = ?, error = ?,
       post_url = COALESCE(?, post_url), recipe_slug = COALESCE(?, recipe_slug),
       attempts = attempts + ?, updated_at = datetime('now')
     WHERE id = ?`,
    status,
    extra.error ?? null,
    extra.postUrl ?? null,
    extra.recipeSlug ?? null,
    extra.attempt ? 1 : 0,
    id,
  );
}

export const deleteBlogQuestion = (id: number): void => {
  run('DELETE FROM blog_questions WHERE id = ?', id);
};

/** A run that died mid-article leaves its question 'working'; put it back in line. */
export const requeueStuckBlogQuestions = (olderThanMinutes = 30): number =>
  run(
    `UPDATE blog_questions SET status = 'queued', updated_at = datetime('now')
     WHERE status = 'working' AND updated_at < datetime('now', ?)`,
    `-${olderThanMinutes} minutes`,
  ).changes;

/* ---------- Site blog settings ---------- */

export const listBlogSites = (): BlogSiteRow[] =>
  all(
    `SELECT id, name, domain, status, blog_enabled, blog_daily_target, blog_interval_minutes, blog_last_at
     FROM sites ORDER BY name`,
  );

export function setBlogSettings(
  siteId: number,
  input: { enabled: boolean; dailyTarget: number; intervalMinutes: number },
): void {
  run(
    'UPDATE sites SET blog_enabled = ?, blog_daily_target = ?, blog_interval_minutes = ? WHERE id = ?',
    input.enabled ? 1 : 0,
    Math.max(1, Math.min(24, Math.round(input.dailyTarget))),
    Math.max(30, Math.min(1440, Math.round(input.intervalMinutes))),
    siteId,
  );
}

export const markBlogRun = (siteId: number): void => {
  run("UPDATE sites SET blog_last_at = datetime('now') WHERE id = ?", siteId);
};

/** Articles written for this site since midnight UTC. */
export const blogPublishedToday = (siteId: number): number =>
  get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM blog_questions WHERE site_id = ? AND status = 'done' AND updated_at >= date('now')",
    siteId,
  )?.n ?? 0;
