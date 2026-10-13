import { all, get, run } from '../db/index.js';
import { pickInRotation } from './rotation.js';

/**
 * Article shapes, rotated so the site is not the same page fifty times.
 *
 * What makes a site read as machine-written is rarely the sentences. It is
 * that every article opens the same way, carries the same number of sections
 * in the same order, and ends with the same number of questions. A reader
 * notices the skeleton long before the prose.
 *
 * So the shape rotates and the voice does not. The house voice in the system
 * prompts — second person, British spelling, no anecdotes, no marketing — is
 * one site's voice and stays fixed; a site that writes in five voices reads
 * like five strangers, which is a worse problem than the one being solved.
 *
 * Part 2, the recipe card, is deliberately untouched by any of this. It is
 * structured data for Google: the ingredients, the quantities, the times.
 * Varying its shape would cost rich results and buy nothing.
 */

export interface ArticleStructure {
  id: number;
  name: string;
  /** What part 1 is told about the introduction. */
  intro: string;
  /** What part 3 is told about the sections after the recipe and the questions. */
  sections: string;
  enabled: 0 | 1;
  position: number;
}

/** The headings a section may take, offered to every structure that chooses freely. */
const HEADING_POOL =
  '"Avec quoi servir ce plat", "À préparer à l\'avance", "Conservation et réchauffage", '
  + '"Sucré ou salé", "Réussir la texture", "Bien choisir la pièce"';

/**
 * The shapes a fresh install starts with.
 *
 * The first is the shape the platform wrote until now, word for word, so
 * switching every other one off returns the site exactly to where it was.
 * The rest differ in what they ASK THE ARTICLE TO CONTAIN — a mistake, a
 * comparison, a substitution — not in how the instruction is worded. Six
 * rewordings of one brief would produce six flavours of the same article.
 */
export const DEFAULT_STRUCTURES: { name: string; intro: string; sections: string }[] = [
  {
    name: 'Deux paragraphes, deux notes',
    intro:
      '- EXACTLY TWO <p> paragraphs. Not one, not three. 120 to 180 words in total.\n'
      + '- First paragraph: what the dish is, where it sits in the kitchen it comes\n'
      + '  from, and what it tastes and feels like. Concrete, not atmospheric.\n'
      + '- Second paragraph: the one thing that decides whether it works — the rest,\n'
      + '  the heat, the order the ingredients go in — and what goes wrong without it.\n'
      + '  If two things matter, put both in this paragraph rather than opening a third.',
    sections:
      `- EXACTLY TWO sections in notes_html. Choose the two that actually matter for\n`
      + `  this dish, from: ${HEADING_POOL}.\n`
      + '- EXACTLY THREE questions in faqs.',
  },
  {
    name: 'Ouvrir sur l’erreur',
    intro:
      '- EXACTLY THREE <p> paragraphs. 150 to 200 words in total.\n'
      + '- First paragraph: the mistake most cooks make with this dish, and what it\n'
      + '  produces — the tough one, the flat one, the one that split. Name the result,\n'
      + '  not the feeling.\n'
      + '- Second paragraph: what the dish is and what it is like when it is right.\n'
      + '- Third paragraph: the step that decides between the two.',
    sections:
      '- EXACTLY THREE sections in notes_html. The FIRST must be\n'
      + '  <h2>Ce qui tourne mal et pourquoi</h2>: the failure named in the introduction, the\n'
      + '  reason it happens, and how a cook spots it early enough to fix it.\n'
      + `- Choose the other two from: ${HEADING_POOL}.\n`
      + '- EXACTLY THREE questions in faqs.',
  },
  {
    name: 'Ouvrir sur le choix',
    intro:
      '- EXACTLY TWO <p> paragraphs. 110 to 160 words in total.\n'
      + '- First paragraph: open on the choice the cook is weighing before they start —\n'
      + '  which cut, which flour, pan or oven, overnight or same day — and answer it\n'
      + '  plainly in the same paragraph. Do not leave the question hanging.\n'
      + '- Second paragraph: what the dish is and what the result is like.',
    sections:
      `- EXACTLY TWO sections in notes_html, chosen from: ${HEADING_POOL}.\n`
      + '- EXACTLY FOUR questions in faqs. Take them from "google_questions" in the\n'
      + '  recipe where it has them, worded as people actually ask them.',
  },
  {
    name: 'Face à la méthode traditionnelle',
    intro:
      '- EXACTLY TWO <p> paragraphs. 130 to 180 words in total.\n'
      + '- First paragraph: how the dish is traditionally made, and where this version\n'
      + '  departs from it — a shortcut, a different fat, a modern pan — and why that\n'
      + '  departure is worth making. Never claim the traditional way is wrong.\n'
      + '- Second paragraph: what the result is like, and the step that decides it.',
    sections:
      '- EXACTLY TWO sections in notes_html. The FIRST must be\n'
      + '  <h2>Ce qui change par rapport à la méthode traditionnelle</h2>: what changes in the\n'
      + '  result, and when the traditional way is still the better choice.\n'
      + `- Choose the second from: ${HEADING_POOL}.\n`
      + '- EXACTLY THREE questions in faqs.',
  },
  {
    name: 'L’ingrédient qui décide de tout',
    intro:
      '- EXACTLY TWO <p> paragraphs. 120 to 170 words in total.\n'
      + '- First paragraph: the single ingredient this dish stands or falls on. What to\n'
      + '  look for when buying it, and what to put back on the shelf.\n'
      + '- Second paragraph: what the dish is and what the result is like.',
    sections:
      '- EXACTLY THREE sections in notes_html. The FIRST must be an <h2> naming that\n'
      + '  ingredient and what to use when it cannot be found — what the substitute\n'
      + '  changes about the result, honestly, including when the answer is "do not\n'
      + '  make this without it".\n'
      + `- Choose the other two from: ${HEADING_POOL}.\n`
      + '- EXACTLY THREE questions in faqs.',
  },
  {
    name: 'Court en haut, long en bas',
    intro:
      '- EXACTLY ONE <p> paragraph. 60 to 90 words.\n'
      + '- What the dish is, and the one thing that decides whether it works. Nothing\n'
      + '  else: this shape puts the reader at the recipe within a few seconds, and\n'
      + '  everything that would have padded the opening belongs after the card.',
    sections:
      `- EXACTLY FOUR sections in notes_html, chosen from: ${HEADING_POOL}.\n`
      + '- EXACTLY THREE questions in faqs.',
  },
];

/** The structures, oldest first by position; the defaults are put in the first time this is asked. */
export function listArticleStructures(): ArticleStructure[] {
  const rows = all<ArticleStructure>('SELECT id, name, intro, sections, enabled, position FROM article_structures ORDER BY position, id');
  if (rows.length > 0) return rows;
  DEFAULT_STRUCTURES.forEach((s, i) => {
    run('INSERT INTO article_structures (name, intro, sections, enabled, position) VALUES (?, ?, ?, 1, ?)', s.name, s.intro, s.sections, i);
  });
  return all<ArticleStructure>('SELECT id, name, intro, sections, enabled, position FROM article_structures ORDER BY position, id');
}

export function addArticleStructure(name: string, intro: string, sections: string): number {
  const next = get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM article_structures')?.p ?? 0;
  run('INSERT INTO article_structures (name, intro, sections, enabled, position) VALUES (?, ?, ?, 1, ?)', name, intro, sections, next);
  return get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0;
}

export function saveArticleStructure(id: number, fields: { name: string; intro: string; sections: string; enabled: boolean }): void {
  run('UPDATE article_structures SET name = ?, intro = ?, sections = ?, enabled = ? WHERE id = ?',
    fields.name, fields.intro, fields.sections, fields.enabled ? 1 : 0, id);
}

export function deleteArticleStructure(id: number): void {
  run('DELETE FROM article_structures WHERE id = ?', id);
}

/** How many articles each shape has written, for the page. */
export function articleStructureUses(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of all<{ id: number; n: number }>('SELECT article_structure_id AS id, COUNT(*) AS n FROM runs WHERE article_structure_id IS NOT NULL GROUP BY article_structure_id')) {
    out[r.id] = r.n;
  }
  return out;
}

/**
 * The shape for the next article on a site.
 *
 * A structure missing either half is not a candidate: half a shape would
 * leave one part of the article following the template and the other
 * following nothing, which is worse than either.
 */
export function pickArticleStructure(
  structures: ArticleStructure[],
  recent: number[],
  usesOnSite: Record<number, number>,
  siteId: number,
): ArticleStructure | null {
  return pickInRotation(
    structures.filter((s) => s.enabled && s.intro.trim().length > 0 && s.sections.trim().length > 0),
    recent,
    usesOnSite,
    siteId,
  );
}

/** What one site wrote lately (newest first) and how often each shape was used there. */
export function siteStructureHistory(siteId: number): { recent: number[]; uses: Record<number, number> } {
  const recent = all<{ id: number }>(
    'SELECT article_structure_id AS id FROM runs WHERE site_id = ? AND article_structure_id IS NOT NULL ORDER BY runs.id DESC LIMIT 3',
    siteId,
  ).map((r) => r.id);
  const uses: Record<number, number> = {};
  for (const r of all<{ id: number; n: number }>(
    'SELECT article_structure_id AS id, COUNT(*) AS n FROM runs WHERE site_id = ? AND article_structure_id IS NOT NULL GROUP BY article_structure_id',
    siteId,
  )) {
    uses[r.id] = r.n;
  }
  return { recent, uses };
}

export function markRunArticleStructure(runId: number, structureId: number): void {
  run('UPDATE runs SET article_structure_id = ? WHERE id = ?', structureId, runId);
}

/**
 * The two blocks the prompts read.
 *
 * With no structure chosen both fall back to the shape the platform has
 * always written, spelled out here rather than left in the prompt files: the
 * prompts now have one place where the shape is stated, and leaving a second
 * copy in them is how the two would drift apart.
 */
export function structureBlocks(structure: ArticleStructure | null): { structureIntro: string; structureSections: string } {
  const shape = structure ?? { intro: DEFAULT_STRUCTURES[0]!.intro, sections: DEFAULT_STRUCTURES[0]!.sections };
  return { structureIntro: shape.intro.trim(), structureSections: shape.sections.trim() };
}
