import { all, get, run } from '../db/index.js';
import type { Settings } from '../settings.js';
import { pickInRotation } from './rotation.js';

/**
 * Reel caption shapes, rotated like the article and blog ones.
 *
 * A feed is where repetition shows fastest. An article is read alone, but a
 * page's posts are read one under another, and six captions that all open with
 * a hook and close with the same kind of question read as one post with six
 * dishes in it.
 *
 * What does not rotate, and stays in the prompt where a shape cannot reach it:
 * no links anywhere (every network adds its own, its own way), no filler or
 * marketing words, at most two emoji, and the hashtags specific to the dish.
 */

export interface CaptionStructure {
  id: number;
  name: string;
  body: string;
  enabled: 0 | 1;
  position: number;
}

/**
 * The networks the written caption can go to.
 *
 * Pinterest is not one of them: a video pin carries the article's own Pinterest
 * description, which is written for Pinterest's search box rather than for a
 * feed, and a caption would be the wrong text in the wrong place.
 */
export const CAPTION_NETWORKS = ['facebook', 'instagram', 'youtube', 'tiktok'] as const;
export type CaptionNetwork = (typeof CAPTION_NETWORKS)[number];

/** What each network is called on the page, and what the caption lands in there. */
export const CAPTION_NETWORK_LABELS: Record<CaptionNetwork, { name: string; where: string }> = {
  facebook: { name: 'Facebook', where: 'the post text above the video' },
  instagram: { name: 'Instagram', where: 'the caption under the reel' },
  youtube: { name: 'YouTube', where: "the Short's description" },
  tiktok: { name: 'TikTok', where: 'the caption under the video' },
};

/**
 * The value stored when no network is to get a written caption.
 *
 * It cannot be the empty string: `Settings.get` falls back to a setting's
 * default whenever the stored value is empty, so saving "none" as "" would read
 * back as all three and the page would quietly ignore what was unticked.
 */
export const CAPTION_NETWORKS_NONE = 'none';

/** The stored list read back, unknown and misspelt names dropped. */
export function parseCaptionNetworks(value: string): Set<CaptionNetwork> {
  const wanted = new Set(value.split(',').map((part) => part.trim().toLowerCase()));
  return new Set(CAPTION_NETWORKS.filter((network) => wanted.has(network)));
}

/** The ticked boxes as a value to store. */
export function serializeCaptionNetworks(names: readonly string[]): string {
  const chosen = CAPTION_NETWORKS.filter((network) => names.includes(network));
  return chosen.length > 0 ? chosen.join(',') : CAPTION_NETWORKS_NONE;
}

/**
 * The shapes a fresh install starts with.
 *
 * The first is what the caption prompt asked for until now, word for word, so
 * switching the others off returns every reel to where it was. The rest differ
 * in what the caption DOES — ask, promise, confess, count — not in how the
 * instruction is phrased.
 */
export const DEFAULT_CAPTION_STRUCTURES: { name: string; body: string }[] = [
  {
    name: 'Hook, lines, question',
    body:
      '- Open with a hook of at most eight words that makes someone stop scrolling. It is the first line and it stands alone.\n'
      + '- Then two or three short lines about the dish. Warm, plain, spoken — not marketing copy.\n'
      + '- Mention one concrete thing: a texture, a smell, how long it takes.\n'
      + '- Then one short line that invites a comment: a simple question people can answer in a word.\n'
      + '- Then three to five hashtags on one line.',
  },
  {
    name: 'The number first',
    body:
      '- Open with the number that matters, alone on the first line: the minutes, the number of ingredients, the number of bowls. "Douze minutes. Une seule poêle."\n'
      + '- Then two or three lines on what that number buys the cook, and the one step where it could go wrong.\n'
      + '- No question at the end: the number is the hook and a question after it only softens it.\n'
      + '- Then three to five hashtags on one line.',
  },
  {
    name: 'The mistake, confessed',
    body:
      '- Open with what most people get wrong with this dish, in one line, as a plain statement rather than a warning.\n'
      + '- Then two or three lines on what to do instead and what the right result looks like.\n'
      + '- End on a line asking whether this has happened to the reader.\n'
      + '- Then three to five hashtags on one line.',
  },
  {
    name: 'Two lines, nothing else',
    body:
      '- The whole caption is TWO short lines and the hashtags. Nothing else — this one works by saying almost nothing while the video does the talking.\n'
      + '- First line: what it is. Second line: the one thing that makes it worth making.\n'
      + '- No question, no instruction, no invitation.\n'
      + '- Then three to five hashtags on one line.',
  },
  {
    name: 'Who it is for',
    body:
      '- Open by naming the person this is for, in one line: whoever has no oven, no time, no mixer, or a fussy eater at the table.\n'
      + '- Then two or three lines on why it suits them in particular.\n'
      + '- End by asking the reader to tag someone it is for.\n'
      + '- Then three to five hashtags on one line.',
  },
  {
    name: 'Walk the steps',
    body:
      '- The body is three or four very short lines, each one step of the method, in order, as the video shows them. No line longer than eight words.\n'
      + '- Open with a single line naming the dish and its time, before the steps.\n'
      + '- No question at the end.\n'
      + '- Then three to five hashtags on one line.',
  },
];

/** The caption settings a site can have of its own; everything else stays shared. */
export const CAPTION_KEYS: ReadonlySet<string> = new Set([
  'caption_networks', 'caption_fb_link', 'caption_fb_recipe', 'caption_fb_post_recipe', 'caption_fb_post_link',
  'caption_ig_post_recipe', 'caption_pin_recipe', 'caption_yt_recipe', 'caption_ig_recipe', 'caption_tt_recipe',
  'caption_yt_link_recipe', 'caption_yt_link_site', 'caption_extra_link',
]);

const CUSTOM = '_custom';

/** True when the site has shapes and caption settings of its own. */
export function isCaptionCustom(siteId: number | null | undefined): boolean {
  if (!siteId) return false;
  try {
    return Boolean(get('SELECT 1 AS x FROM site_caption_settings WHERE site_id = ? AND key = ?', siteId, CUSTOM));
  } catch {
    return false;
  }
}

/** The site's own value for a caption setting, or undefined when it follows the default. */
export function siteCaptionSetting(siteId: number, key: string): string | undefined {
  if (!CAPTION_KEYS.has(key) || !isCaptionCustom(siteId)) return undefined;
  return get<{ value: string }>('SELECT value FROM site_caption_settings WHERE site_id = ? AND key = ?', siteId, key)?.value;
}

export function setSiteCaptionSetting(siteId: number, key: string, value: string): void {
  if (!CAPTION_KEYS.has(key)) return;
  run('INSERT INTO site_caption_settings (site_id, key, value) VALUES (?, ?, ?) ON CONFLICT (site_id, key) DO UPDATE SET value = excluded.value', siteId, key, value);
}

/**
 * The settings as one site sees them: its own caption values where it has them, the shared ones otherwise.
 * Everything that is not a caption setting passes straight through.
 */
export function withSiteOverrides(base: Settings, siteId: number | null | undefined): Settings {
  if (!siteId) return base;
  const view = Object.create(base) as Settings;
  view.get = (key: string): string => siteCaptionSetting(siteId, key) ?? base.get(key);
  return view;
}

/** Start the site from a copy of the default: every shape and every caption setting as they are now. */
export function customizeCaption(siteId: number, settings: Settings): void {
  if (isCaptionCustom(siteId)) return;
  for (const s of listCaptionStructures()) {
    run('INSERT INTO caption_structures (name, body, enabled, position, site_id) VALUES (?, ?, ?, ?, ?)', s.name, s.body, s.enabled, s.position, siteId);
  }
  for (const key of CAPTION_KEYS) setSiteCaptionSetting(siteId, key, settings.get(key));
  run('INSERT OR REPLACE INTO site_caption_settings (site_id, key, value) VALUES (?, ?, ?)', siteId, CUSTOM, '1');
}

/** Back to the default: the site's shapes and settings are removed. */
export function resetCaption(siteId: number): void {
  run('DELETE FROM caption_structures WHERE site_id = ?', siteId);
  run('DELETE FROM site_caption_settings WHERE site_id = ?', siteId);
}

/** The default shapes, or a customized site's own. */
export function listCaptionStructures(siteId?: number | null): CaptionStructure[] {
  if (siteId && isCaptionCustom(siteId)) {
    return all<CaptionStructure>('SELECT id, name, body, enabled, position FROM caption_structures WHERE site_id = ? ORDER BY position, id', siteId);
  }
  const rows = all<CaptionStructure>('SELECT id, name, body, enabled, position FROM caption_structures WHERE site_id IS NULL ORDER BY position, id');
  if (rows.length > 0) return rows;
  DEFAULT_CAPTION_STRUCTURES.forEach((s, i) => {
    run('INSERT INTO caption_structures (name, body, enabled, position) VALUES (?, ?, 1, ?)', s.name, s.body, i);
  });
  return all<CaptionStructure>('SELECT id, name, body, enabled, position FROM caption_structures WHERE site_id IS NULL ORDER BY position, id');
}

export function addCaptionStructure(name: string, body: string, siteId?: number | null): number {
  const scope = siteId ? 'site_id = ?' : 'site_id IS NULL';
  const next = get<{ p: number }>(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM caption_structures WHERE ${scope}`, ...(siteId ? [siteId] : []))?.p ?? 0;
  run('INSERT INTO caption_structures (name, body, enabled, position, site_id) VALUES (?, ?, 1, ?, ?)', name, body, next, siteId ?? null);
  return get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0;
}

export function saveCaptionStructure(id: number, fields: { name: string; body: string; enabled: boolean }): void {
  run('UPDATE caption_structures SET name = ?, body = ?, enabled = ? WHERE id = ?', fields.name, fields.body, fields.enabled ? 1 : 0, id);
}

export function deleteCaptionStructure(id: number): void {
  run('DELETE FROM caption_structures WHERE id = ?', id);
}

/** How many reels each shape has captioned, for the page. */
export function captionStructureUses(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of all<{ id: number; n: number }>('SELECT caption_structure_id AS id, COUNT(*) AS n FROM reels WHERE caption_structure_id IS NOT NULL GROUP BY caption_structure_id')) {
    out[r.id] = r.n;
  }
  return out;
}

export function pickCaptionStructure(
  structures: CaptionStructure[],
  recent: number[],
  usesOnSite: Record<number, number>,
  siteId: number,
): CaptionStructure | null {
  return pickInRotation(structures.filter((s) => s.enabled && s.body.trim().length > 0), recent, usesOnSite, siteId);
}

/** What one site posted lately (newest first) and how often each shape was used there. */
export function siteCaptionHistory(siteId: number): { recent: number[]; uses: Record<number, number> } {
  const recent = all<{ id: number }>(
    'SELECT caption_structure_id AS id FROM reels WHERE site_id = ? AND caption_structure_id IS NOT NULL ORDER BY id DESC LIMIT 3',
    siteId,
  ).map((r) => r.id);
  const uses: Record<number, number> = {};
  for (const r of all<{ id: number; n: number }>(
    'SELECT caption_structure_id AS id, COUNT(*) AS n FROM reels WHERE site_id = ? AND caption_structure_id IS NOT NULL GROUP BY caption_structure_id',
    siteId,
  )) {
    uses[r.id] = r.n;
  }
  return { recent, uses };
}

export function markReelCaptionStructure(reelId: number, structureId: number): void {
  run('UPDATE reels SET caption_structure_id = ? WHERE id = ?', structureId, reelId);
}

/**
 * The shape as the caption prompt reads it, falling back to the one the
 * platform has always asked for.
 */
export const captionShape = (structure: CaptionStructure | null): string =>
  (structure?.body ?? DEFAULT_CAPTION_STRUCTURES[0]!.body).trim();

/** The shape for the next reel on a site, or null when every one is off. */
export function nextCaptionShape(siteId: number): { shape: string; id: number | null } {
  try {
    const history = siteCaptionHistory(siteId);
    const chosen = pickCaptionStructure(listCaptionStructures(siteId), history.recent, history.uses, siteId);
    return { shape: captionShape(chosen), id: chosen?.id ?? null };
  } catch {
    return { shape: captionShape(null), id: null };
  }
}
