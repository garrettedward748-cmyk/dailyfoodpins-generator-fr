import { all, get, run } from '../db/index.js';
import { pickInRotation } from './rotation.js';

/**
 * Photo shoots, rotated so a site's recipes do not all look photographed on
 * the same afternoon.
 *
 * The image prompt already told the model to pick a surface, a palette and a
 * set of props per recipe, and to vary them. It does not: asked freely, it
 * reaches for the same dark ceramic and the same folded linen most times, and
 * a reader scrolling the archive sees one shoot repeated fifty ways. Naming
 * the shoot takes the choice away from the model and gives it to a rotation
 * that can count.
 *
 * A style is a brief, not a prompt. It names the kitchen the photographs were
 * taken in; the model still writes the five prompts from the dish itself, and
 * is told to bend the brief's colours to what the food actually is — a dark
 * slate shoot of a lemon tart keeps the slate and loses the browns.
 */

export interface PhotoStyle {
  id: number;
  name: string;
  body: string;
  enabled: 0 | 1;
  position: number;
}

/**
 * The shoots a fresh install starts with.
 *
 * Chosen to differ in the things a reader notices first — how bright it is,
 * what the food sits on, and where the camera stands — rather than in the
 * wording. Six variations on "natural light, nice plate" would look like one
 * shoot with six captions.
 */
export const DEFAULT_STYLES: { name: string; body: string }[] = [
  {
    name: 'Bright window kitchen',
    body:
      'Pale stoneware and matte ceramic on a light grey-white plaster or painted wood surface, with a crumpled off-white linen cloth. '
      + 'Soft, bright daylight from a window to the left, gentle shadows, nothing harsh. A pale, airy palette. '
      + 'The camera leans overhead or high three-quarter, with plenty of clean surface around the food.',
  },
  {
    name: 'Dark and moody',
    body:
      'Dark slate, blackened cast iron or a deep charcoal surface, with one old spoon and a dark cloth. '
      + 'Low, directional light from the side and slightly behind, so the dish is lit along one edge and falls into shadow on the other. '
      + 'Deep shadows, a near-black background, and the dish as the only bright thing in the frame. The camera sits low, at a three-quarter angle, close to the food.',
  },
  {
    name: 'Warm rustic wood',
    body:
      'Weathered oak or an old wooden board, with brass or hammered copper, a cotton napkin in a warm earth colour, and a small bowl of one raw ingredient. '
      + 'Late-afternoon light, warm and golden, raking across the grain of the wood. An amber and brown palette. '
      + 'The camera is close at about forty-five degrees, the way someone leaning over the table would see it.',
  },
  {
    name: 'Clean white marble',
    body:
      'White or very pale veined marble, bare, with at most one pale plate and one piece of cutlery. No cloth, no clutter. '
      + 'Even, bright, nearly shadowless daylight. A white, cool palette where the only strong colour is the food itself. '
      + 'The camera is straight overhead, square to the surface, the dish centred with wide empty margins.',
  },
  {
    name: 'Lived-in table',
    body:
      'A worn enamel or chipped vintage plate on a painted kitchen table with its paint rubbed through, a creased tea towel, a used spoon set down, a few crumbs left where they fell. '
      + 'Daylight from behind the dish, so the edges glow and the front is softly filled. A muted, slightly faded palette. '
      + 'The camera is at table height, straight on, close enough to see the wear on the plate.',
  },
  {
    name: 'Close and textural',
    body:
      'The surface barely visible — a neutral mid-tone backdrop in a colour taken from the dish — with no props at all. '
      + 'Soft diffused light that rakes just enough to raise the texture: the crumb, the crust, the grain, the sheen of a sauce. '
      + 'The camera is very close with a shallow depth of field, filling the frame with part of the dish rather than all of it, so the picture is about how it feels to touch.',
  },
];

/** The styles, oldest first by position; the defaults are put in the first time this is asked. */
export function listPhotoStyles(): PhotoStyle[] {
  const rows = all<PhotoStyle>('SELECT id, name, body, enabled, position FROM photo_styles ORDER BY position, id');
  if (rows.length > 0) return rows;
  DEFAULT_STYLES.forEach((s, i) => {
    run('INSERT INTO photo_styles (name, body, enabled, position) VALUES (?, ?, 1, ?)', s.name, s.body, i);
  });
  return all<PhotoStyle>('SELECT id, name, body, enabled, position FROM photo_styles ORDER BY position, id');
}

export function addPhotoStyle(name: string, body: string): number {
  const next = get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM photo_styles')?.p ?? 0;
  run('INSERT INTO photo_styles (name, body, enabled, position) VALUES (?, ?, 1, ?)', name, body, next);
  return get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0;
}

export function savePhotoStyle(id: number, fields: { name: string; body: string; enabled: boolean }): void {
  run('UPDATE photo_styles SET name = ?, body = ?, enabled = ? WHERE id = ?', fields.name, fields.body, fields.enabled ? 1 : 0, id);
}

export function deletePhotoStyle(id: number): void {
  run('DELETE FROM photo_styles WHERE id = ?', id);
}

/** How many recipes each shoot has photographed, for the page. */
export function photoStyleUses(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of all<{ id: number; n: number }>('SELECT photo_style_id AS id, COUNT(*) AS n FROM runs WHERE photo_style_id IS NOT NULL GROUP BY photo_style_id')) {
    out[r.id] = r.n;
  }
  return out;
}

/** The shoot for the next recipe on a site; null when every style is switched off. */
export function pickPhotoStyle(
  styles: PhotoStyle[],
  recent: number[],
  usesOnSite: Record<number, number>,
  siteId: number,
): PhotoStyle | null {
  return pickInRotation(styles.filter((s) => s.enabled && s.body.trim().length > 0), recent, usesOnSite, siteId);
}

/** What one site shot lately (newest first) and how often each shoot was used there. */
export function sitePhotoHistory(siteId: number): { recent: number[]; uses: Record<number, number> } {
  const recent = all<{ id: number }>(
    'SELECT photo_style_id AS id FROM runs WHERE site_id = ? AND photo_style_id IS NOT NULL ORDER BY runs.id DESC LIMIT 3',
    siteId,
  ).map((r) => r.id);
  const uses: Record<number, number> = {};
  for (const r of all<{ id: number; n: number }>(
    'SELECT photo_style_id AS id, COUNT(*) AS n FROM runs WHERE site_id = ? AND photo_style_id IS NOT NULL GROUP BY photo_style_id',
    siteId,
  )) {
    uses[r.id] = r.n;
  }
  return { recent, uses };
}

export function markRunPhotoStyle(runId: number, styleId: number): void {
  run('UPDATE runs SET photo_style_id = ? WHERE id = ?', styleId, runId);
}

/**
 * The shoot as the image prompt reads it.
 *
 * The whole block lives in the one variable, so a site with every style
 * switched off renders nothing at all rather than an empty heading — and the
 * model goes back to choosing for itself, exactly as it did before any of
 * this existed.
 */
export function shootBlock(style: PhotoStyle | null): string {
  if (!style) return '';
  return [
    '═══════════════════════════════════════════════════════════════',
    'THE SHOOT FOR THIS RECIPE — ALREADY CHOSEN',
    '═══════════════════════════════════════════════════════════════',
    '',
    'Do not choose a surface, a palette or props of your own. This recipe was',
    'photographed on the shoot below, and all five prompts share it:',
    '',
    style.body.trim(),
    '',
    'Bend its colours to the dish where they would fight — a shoot described in',
    'browns photographing something pale keeps its surface, its light and its',
    'camera, and takes its accent colours from the food. Never change the',
    'surface, the light or where the camera stands.',
  ].join('\n');
}
