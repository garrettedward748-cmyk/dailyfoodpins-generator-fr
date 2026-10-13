import { all, get, run } from '../db/index.js';
import { getPromptOverride } from '../db/repos.js';
import { pickInRotation } from './rotation.js';

/**
 * Scene orders for a one-clip reel, rotated like the article, blog and caption
 * shapes.
 *
 * Every one-clip reel used to come out of one fixed template: the same four
 * scenes in the same order with the same kind of line in each. YouTube's July
 * 2026 monetization rules name exactly that — AI or template video "with
 * minimal variation" — as inauthentic content that cannot earn. The articles,
 * the blog and the captions already rotate for the same reason.
 *
 * What a structure decides: the first eight seconds, what happens in each scene
 * and what the voice says there. What it cannot touch, and stays in the
 * template: fidelity to the reference photos, the steam rule, the closing two
 * seconds with the call to action and the site's address, complete-sentence
 * subtitles, the voice, the look, no faces.
 *
 * The bodies are inserted as plain text and are not rendered again, so they
 * say "the dish" and "Voiceover" rather than using placeholders.
 */

export interface ReelStructure {
  id: number;
  name: string;
  body: string;
  enabled: 0 | 1;
  position: number;
}

/**
 * The shapes a fresh install starts with.
 *
 * The first is the template's own scenes as they were, so switching the others
 * off returns every reel to what it was. The rest differ in what the video
 * DOES — where it opens, what it is about — not in how the instruction reads.
 */
export const DEFAULT_REEL_STRUCTURES: { name: string; body: string }[] = [
  {
    name: 'Cut, make, finish',
    body:
      'SCENE 1 — 0–2 sec | HOOK\n'
      + 'Open with an irresistible extreme close-up of the finished dish — a spoon or knife cuts into it, revealing the inside.\n'
      + 'Voiceover: the opening line — a question or a statement that makes a hungry person stop scrolling.\n'
      + 'Subtitle: that sentence in full.\n\n'
      + 'SCENE 2 — 2–5 sec | PREPARATION\n'
      + 'Show the key ingredients of this recipe being combined or assembled, the way this dish is really made.\n'
      + 'Voiceover: one complete sentence saying why this recipe is easy and good.\n'
      + 'Subtitle: a shorter sentence making the same point.\n\n'
      + 'SCENE 3 — 5–8 sec | FINISHING\n'
      + 'Show the dish coming together at its best moment — for a hot dish, cooking until golden; for a cold dish, the final layer, topping or glaze going on. Then a spoon lifts one portion.\n'
      + 'Voiceover: one line naming its three best textures or flavours.\n'
      + 'Subtitle: the three words joined with "+".',
  },
  {
    name: 'First bite, then back',
    body:
      'SCENE 1 — 0–3 sec | THE FIRST BITE\n'
      + 'Open on a fork or spoon lifting the first portion of the finished dish toward the camera — the inside, its crumb or its set texture, in close-up.\n'
      + 'Voiceover: the opening line — what that first bite is like.\n'
      + 'Subtitle: that sentence in full.\n\n'
      + 'SCENE 2 — 3–8 sec | HOW IT GOT HERE\n'
      + 'Cut back in time: the raw ingredients, then the one step that matters most in this recipe, then the dish going in or setting.\n'
      + 'Voiceover: one complete sentence on the step that makes it work.\n'
      + 'Subtitle: that sentence, shortened into a sentence of its own.',
  },
  {
    name: 'The mistake, then the fix',
    body:
      'SCENE 1 — 0–2 sec | THE MISTAKE\n'
      + 'Open close on the step where this dish usually goes wrong — the batter, the dough, the pan, the timing.\n'
      + 'Voiceover: the opening line — the common mistake, stated plainly.\n'
      + 'Subtitle: that sentence in full.\n\n'
      + 'SCENE 2 — 2–5 sec | THE FIX\n'
      + 'Show the same step done the right way, slowly enough to see what is different.\n'
      + 'Voiceover: one complete sentence saying what to do instead.\n'
      + 'Subtitle: a shorter sentence making the same point.\n\n'
      + 'SCENE 3 — 5–8 sec | THE RESULT\n'
      + 'Show what doing it right gives you: cut into the finished dish and show the inside.\n'
      + 'Voiceover: one short sentence on the result.\n'
      + 'Subtitle: that sentence.',
  },
  {
    name: 'Three things',
    body:
      'SCENE 1 — 0–2 sec | THE PROMISE\n'
      + 'Open on the finished dish from above, the camera moving slowly in.\n'
      + 'Voiceover: the opening line — that three things make this recipe work.\n'
      + 'Subtitle: that sentence in full.\n\n'
      + 'SCENE 2 — 2–8 sec | ONE, TWO, THREE\n'
      + 'Three quick shots, two seconds each, one per thing: an ingredient, a technique, a detail of how it is finished or served.\n'
      + 'Voiceover: each one named in a short sentence as it appears.\n'
      + 'Subtitle: "1.", "2.", "3." each followed by a few words naming that thing.',
  },
  {
    name: 'Time is the story',
    body:
      'SCENE 1 — 0–2 sec | THE CLOCK\n'
      + 'Open on the ingredients laid out, untouched, then the first one going into the bowl or pan.\n'
      + 'Voiceover: the opening line — how little time this takes, with the real number of minutes from the recipe.\n'
      + 'Subtitle: that sentence in full.\n\n'
      + 'SCENE 2 — 2–8 sec | FAST FORWARD\n'
      + 'A fast rhythm of short cuts, one step of the method each, in the order the recipe follows — no lingering, every cut on the beat of the music.\n'
      + 'Voiceover: one sentence over the cuts saying it really is that quick.\n'
      + 'Subtitle: that sentence.',
  },
  {
    name: 'Hands only, the viewer cooks',
    body:
      'SCENE 1 — 0–3 sec | YOUR HANDS\n'
      + 'First-person point of view, as if the viewer were the cook: their own hands at the counter, starting the recipe.\n'
      + 'Voiceover: the opening line, spoken to the viewer as "you".\n'
      + 'Subtitle: that sentence in full.\n\n'
      + 'SCENE 2 — 3–8 sec | YOU MAKE IT\n'
      + 'Still from the cook\'s eyes: the key steps of this recipe, done by those same hands, ending as the finished dish is set down.\n'
      + 'Voiceover: one complete sentence telling the viewer the step not to skip.\n'
      + 'Subtitle: a shorter sentence making the same point.',
  },
];

export function listReelStructures(): ReelStructure[] {
  const rows = all<ReelStructure>('SELECT id, name, body, enabled, position FROM reel_structures ORDER BY position, id');
  if (rows.length > 0) return rows;
  DEFAULT_REEL_STRUCTURES.forEach((s, i) => {
    run('INSERT INTO reel_structures (name, body, enabled, position) VALUES (?, ?, 1, ?)', s.name, s.body, i);
  });
  return all<ReelStructure>('SELECT id, name, body, enabled, position FROM reel_structures ORDER BY position, id');
}

export function addReelStructure(name: string, body: string): number {
  const next = get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM reel_structures')?.p ?? 0;
  run('INSERT INTO reel_structures (name, body, enabled, position) VALUES (?, ?, 1, ?)', name, body, next);
  return get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0;
}

export function saveReelStructure(id: number, fields: { name: string; body: string; enabled: boolean }): void {
  run('UPDATE reel_structures SET name = ?, body = ?, enabled = ? WHERE id = ?', fields.name, fields.body, fields.enabled ? 1 : 0, id);
}

export function deleteReelStructure(id: number): void {
  run('DELETE FROM reel_structures WHERE id = ?', id);
}

export const reelStructureName = (id: number | null | undefined): string | null =>
  id ? get<{ name: string }>('SELECT name FROM reel_structures WHERE id = ?', id)?.name ?? null : null;

/** How many reels each shape has filmed, for the page. */
export function reelStructureUses(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of all<{ id: number; n: number }>('SELECT reel_structure_id AS id, COUNT(*) AS n FROM reels WHERE reel_structure_id IS NOT NULL GROUP BY reel_structure_id')) {
    out[r.id] = r.n;
  }
  return out;
}

export function pickReelStructure(
  structures: ReelStructure[],
  recent: number[],
  usesOnSite: Record<number, number>,
  siteId: number,
): ReelStructure | null {
  return pickInRotation(structures.filter((s) => s.enabled && s.body.trim().length > 0), recent, usesOnSite, siteId);
}

/** What one site filmed lately (newest first) and how often each shape was used there. */
export function siteReelHistory(siteId: number): { recent: number[]; uses: Record<number, number> } {
  const recent = all<{ id: number }>(
    'SELECT reel_structure_id AS id FROM reels WHERE site_id = ? AND reel_structure_id IS NOT NULL ORDER BY id DESC LIMIT 3',
    siteId,
  ).map((r) => r.id);
  const uses: Record<number, number> = {};
  for (const r of all<{ id: number; n: number }>(
    'SELECT reel_structure_id AS id, COUNT(*) AS n FROM reels WHERE site_id = ? AND reel_structure_id IS NOT NULL GROUP BY reel_structure_id',
    siteId,
  )) {
    uses[r.id] = r.n;
  }
  return { recent, uses };
}

export function markReelStructure(reelId: number, structureId: number): void {
  run('UPDATE reels SET reel_structure_id = ? WHERE id = ?', structureId, reelId);
}

/** The shape as the template reads it, falling back to the scenes it always had. */
export const reelShape = (structure: ReelStructure | null): string =>
  (structure?.body ?? DEFAULT_REEL_STRUCTURES[0]!.body).trim();

/** The shape for the next reel on a site; id is null when every one is off. */
export function nextReelShape(siteId: number): { shape: string; id: number | null } {
  try {
    const history = siteReelHistory(siteId);
    const chosen = pickReelStructure(listReelStructures(), history.recent, history.uses, siteId);
    return { shape: reelShape(chosen), id: chosen?.id ?? null };
  } catch {
    return { shape: reelShape(null), id: null };
  }
}

/**
 * True when the video template was edited under Setup -> Prompts before it
 * had a place for the scenes. An edit wins over the shipped file, so such a
 * template renders every reel the same however many structures are on, and
 * nothing else would say so.
 */
export function templateIgnoresStructures(): boolean {
  try {
    const edited = getPromptOverride('reel-video.template.txt');
    return edited !== null && edited !== undefined && !/\{\{\s*reelShape\s*\}\}/.test(edited);
  } catch {
    return false;
  }
}
