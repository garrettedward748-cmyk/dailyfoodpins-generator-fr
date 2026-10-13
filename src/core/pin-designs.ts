import { all, get, run } from '../db/index.js';
import { getPromptOverride } from '../db/repos.js';
import { readShippedPrompt } from '../pipeline/prompts.js';
import { pickInRotation } from './rotation.js';

/**
 * Pinterest graphic designs, rotated so a site's pins do not all look alike.
 *
 * Kept apart from Setup -> Prompts on purpose: those prompts depend on each
 * other, and a design is a standalone picture brief a person should be able to
 * edit without touching anything else. Each design is rendered with the same
 * three fields the old single template had: {{imagePrompts.pin}} (the photo,
 * written for this dish), {{pinTitle}} and {{site.domain}}.
 */

export interface PinDesign {
  id: number;
  name: string;
  body: string;
  enabled: 0 | 1;
  position: number;
}

const NO_EXTRA =
  'Spell the words exactly as written, once each, with no other text, no logo, no watermark, no badge and no border anywhere in the image.';

/** The designs a fresh install starts with. The first is the template the platform used until now. */
export const DEFAULT_DESIGNS: { name: string; body: string }[] = [
  {
    name: 'Serif title at the top',
    body: '', // filled from the old template (or its edit) when seeding
  },
  {
    name: 'Colour band across the middle',
    body:
      '{{imagePrompts.pin}}\n\nCompose the photo so the dish fills the top and bottom of the tall frame. Across the middle third runs a solid horizontal band in a soft colour taken from the dish, ' +
      'and on it the words "{{pinTitle}}" in a bold, clean sans-serif, centred, in white or very dark brown, whichever reads best. Under the title, smaller, "{{site.domain}}". ' +
      NO_EXTRA,
  },
  {
    name: 'White strip at the bottom',
    body:
      '{{imagePrompts.pin}}\n\nThe dish fills the upper three quarters of the tall frame, close and appetising. The bottom quarter is a clean off-white strip, ' +
      'and on it "{{pinTitle}}" in an elegant dark serif, centred on one or two lines, with "{{site.domain}}" much smaller beneath it in the same colour. ' +
      NO_EXTRA,
  },
  {
    name: 'Big bold words',
    body:
      '{{imagePrompts.pin}}\n\nShot from directly overhead, with plenty of plain surface around the food in the upper half. Across that upper half, "{{pinTitle}}" in a very large, heavy, modern sans-serif, ' +
      'tightly stacked on two or three lines, in a strong colour that contrasts with the surface. "{{site.domain}}" small underneath, same colour. ' +
      NO_EXTRA,
  },
  {
    name: 'Ingredients above, dish below',
    body:
      '{{imagePrompts.pin}}\n\nSplit the tall frame into two photographs of the same kitchen: the top half shows the raw ingredients of this dish neatly laid out, the bottom half shows the finished dish. ' +
      'Between them, a slim cream band with "{{pinTitle}}" in a warm dark serif and "{{site.domain}}" small beneath it. ' +
      NO_EXTRA,
  },
  {
    name: 'Close-up with a corner label',
    body:
      '{{imagePrompts.pin}}\n\nA tight, full-bleed close-up of the dish that fills the whole tall frame, showing its texture. In the top left corner, a small rounded cream label ' +
      'with "{{pinTitle}}" in a dark serif on two or three short lines and "{{site.domain}}" tiny beneath it. The label covers no more than a fifth of the image. ' +
      NO_EXTRA,
  },
];

/** The designs, oldest first by position; the defaults are put in the first time this is asked. */
export function listPinDesigns(): PinDesign[] {
  const rows = all<PinDesign>('SELECT id, name, body, enabled, position FROM pin_designs ORDER BY position, id');
  if (rows.length > 0) return rows;
  const old = getPromptOverride('pin-graphic.template.txt') ?? readShippedPrompt('pin-graphic.template.txt');
  DEFAULT_DESIGNS.forEach((d, i) => {
    run('INSERT INTO pin_designs (name, body, enabled, position) VALUES (?, ?, 1, ?)', d.name, i === 0 ? old.trim() : d.body, i);
  });
  return all<PinDesign>('SELECT id, name, body, enabled, position FROM pin_designs ORDER BY position, id');
}

export function addPinDesign(name: string, body: string): number {
  const next = (get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM pin_designs')?.p ?? 0);
  run('INSERT INTO pin_designs (name, body, enabled, position) VALUES (?, ?, 1, ?)', name, body, next);
  return get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0;
}

export function savePinDesign(id: number, fields: { name: string; body: string; enabled: boolean }): void {
  run('UPDATE pin_designs SET name = ?, body = ?, enabled = ? WHERE id = ?', fields.name, fields.body, fields.enabled ? 1 : 0, id);
}

export function deletePinDesign(id: number): void {
  run('DELETE FROM pin_designs WHERE id = ?', id);
}

/** How many pins each design made, for the page. */
export function pinDesignUses(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of all<{ id: number; n: number }>('SELECT pin_design_id AS id, COUNT(*) AS n FROM runs WHERE pin_design_id IS NOT NULL GROUP BY pin_design_id')) {
    out[r.id] = r.n;
  }
  return out;
}

/** A design has to carry the three fields, or the pin loses its photo, title or domain. */
export function designProblems(body: string): string[] {
  const need = ['{{imagePrompts.pin}}', '{{pinTitle}}', '{{site.domain}}'];
  return need.filter((n) => !body.includes(n));
}

/**
 * The design for the next pin on a site.
 *
 * A design switched off, or missing one of the three fields, is not a
 * candidate: the rule itself lives in core/rotation.ts, shared with the photo
 * shoots.
 */
export function pickPinDesign(
  designs: PinDesign[],
  recent: number[],
  usesOnSite: Record<number, number>,
  siteId: number,
): PinDesign | null {
  return pickInRotation(
    designs.filter((d) => d.enabled && designProblems(d.body).length === 0),
    recent,
    usesOnSite,
    siteId,
  );
}

/** What one site used lately (newest first) and how often each design was used there. */
export function siteDesignHistory(siteId: number): { recent: number[]; uses: Record<number, number> } {
  const recent = all<{ id: number }>(
    'SELECT pin_design_id AS id FROM runs WHERE site_id = ? AND pin_design_id IS NOT NULL ORDER BY runs.id DESC LIMIT 3',
    siteId,
  ).map((r) => r.id);
  const uses: Record<number, number> = {};
  for (const r of all<{ id: number; n: number }>(
    'SELECT pin_design_id AS id, COUNT(*) AS n FROM runs WHERE site_id = ? AND pin_design_id IS NOT NULL GROUP BY pin_design_id',
    siteId,
  )) {
    uses[r.id] = r.n;
  }
  return { recent, uses };
}

export function markRunPinDesign(runId: number, designId: number): void {
  run('UPDATE runs SET pin_design_id = ? WHERE id = ?', designId, runId);
}
