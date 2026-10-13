import { all, get, run } from '../../db/index.js';
import { handleOf } from './facebook.js';

/** A page the radar watches for one site. */
export interface SocialSource {
  id: number;
  site_id: number;
  platform: 'facebook';
  handle: string;
  label: string;
  enabled: number;
  last_scan_at: string | null;
  last_error: string;
}

/** A post the radar kept, waiting for a verdict. */
export interface RadarPost {
  id: number;
  site_id: number;
  source_id: number;
  post_id: string;
  url: string;
  text: string;
  posted_at: string;
  likes: number;
  comments: number;
  shares: number;
  score: number;
  kind: 'recipe' | 'question';
  title: string;
  topic: string;
  status: 'new' | 'added' | 'dismissed';
  updated_at: string;
}

export const listSources = (siteId: number): SocialSource[] =>
  all<SocialSource>('SELECT * FROM social_sources WHERE site_id = ? ORDER BY id', siteId);

export const enabledSources = (siteId: number): SocialSource[] =>
  all<SocialSource>('SELECT * FROM social_sources WHERE site_id = ? AND enabled = 1 ORDER BY id', siteId);

/** Add a page. The handle is taken from whatever was pasted; a repeat is ignored. */
export function addSource(siteId: number, input: string, label = ''): { added: boolean; handle: string } {
  const handle = handleOf(input);
  if (!handle) return { added: false, handle: '' };
  const r = run(
    `INSERT INTO social_sources (site_id, platform, handle, label) VALUES (?, 'facebook', ?, ?)
     ON CONFLICT (site_id, platform, handle) DO NOTHING`,
    siteId,
    handle,
    label.trim(),
  );
  return { added: r.changes > 0, handle };
}

export const removeSource = (siteId: number, id: number): number =>
  run('DELETE FROM social_sources WHERE site_id = ? AND id = ?', siteId, id).changes;

export const toggleSource = (siteId: number, id: number, on: boolean): number =>
  run('UPDATE social_sources SET enabled = ? WHERE site_id = ? AND id = ?', on ? 1 : 0, siteId, id).changes;

export const markScanned = (id: number, error = ''): void => {
  run("UPDATE social_sources SET last_scan_at = datetime('now'), last_error = ? WHERE id = ?", error.slice(0, 300), id);
};

/**
 * Save what the model kept.
 *
 * The ON CONFLICT clause is a safety net for the same post arriving twice
 * inside one scan — two watched pages sharing each other, say. A post from an
 * earlier scan never reaches here at all: the engine filters it out before the
 * model is paid to look at it, and refreshes its numbers through
 * refreshScores below instead.
 */
export function savePosts(
  siteId: number,
  found: { sourceId: number; post: { postId: string; url: string; text: string; postedAt: string; likes: number; comments: number; shares: number }; score: number; kind: 'recipe' | 'question'; title: string; topic: string }[],
): number {
  let n = 0;
  for (const f of found) {
    n += run(
      `INSERT INTO social_posts (site_id, source_id, post_id, url, text, posted_at, likes, comments, shares, score, kind, title, topic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (site_id, post_id) DO UPDATE SET
         likes = excluded.likes, comments = excluded.comments, shares = excluded.shares,
         score = excluded.score, updated_at = datetime('now')`,
      siteId, f.sourceId, f.post.postId, f.post.url, f.post.text.slice(0, 5000), f.post.postedAt,
      f.post.likes, f.post.comments, f.post.shares, f.score, f.kind, f.title.slice(0, 300), f.topic,
    ).changes;
  }
  return n;
}

/**
 * Fresh numbers for posts already saved, without a fresh verdict.
 *
 * Engagement keeps climbing for days after a post goes up, so the figures from
 * the scan that first found it are the weakest ones it will ever have — and
 * they are what the waiting list is ordered by. Only rows still waiting are
 * touched: one already added or dismissed keeps its decision and its numbers,
 * exactly as the Search Console opportunities do.
 */
export function refreshScores(
  siteId: number,
  updates: { postId: string; likes: number; comments: number; shares: number; score: number }[],
): number {
  let n = 0;
  for (const u of updates) {
    n += run(
      `UPDATE social_posts SET likes = ?, comments = ?, shares = ?, score = ?, updated_at = datetime('now')
       WHERE site_id = ? AND post_id = ? AND status = 'new'`,
      u.likes, u.comments, u.shares, u.score, siteId, u.postId,
    ).changes;
  }
  return n;
}

export const listPosts = (siteId: number, status: RadarPost['status'] = 'new'): RadarPost[] =>
  all<RadarPost>('SELECT * FROM social_posts WHERE site_id = ? AND status = ? ORDER BY score DESC LIMIT 500', siteId, status);

export const countWaiting = (siteId: number): number =>
  get<{ n: number }>("SELECT COUNT(*) AS n FROM social_posts WHERE site_id = ? AND status = 'new'", siteId)?.n ?? 0;

/** Every post id this site has already seen, whatever was decided about it. */
export const knownPostIds = (siteId: number): Set<string> =>
  new Set(all<{ post_id: string }>('SELECT post_id FROM social_posts WHERE site_id = ?', siteId).map((r) => r.post_id));

export const markStatus = (siteId: number, ids: number[], status: 'added' | 'dismissed'): number => {
  let n = 0;
  for (const id of ids) {
    n += run("UPDATE social_posts SET status = ?, updated_at = datetime('now') WHERE site_id = ? AND id = ? AND status = 'new'", status, siteId, id).changes;
  }
  return n;
};

export const pickPosts = (siteId: number, ids: number[]): RadarPost[] =>
  ids.length
    ? all<RadarPost>(
        `SELECT * FROM social_posts WHERE site_id = ? AND status = 'new' AND id IN (${ids.map(() => '?').join(',')})`,
        siteId,
        ...ids,
      )
    : [];
