import { all, get, run } from '../db/index.js';
import { pickInRotation } from './rotation.js';

/**
 * Blog article shapes, rotated for the same reason the recipe shapes are.
 *
 * Every blog article opened with a direct answer, ran under four to seven
 * headings, and closed with the same "Frequently asked questions" block every
 * single time. The middle and the ending are what repeat; they rotate here.
 *
 * What does not rotate, and why, since the temptation will come back:
 *   - The direct answer in the first paragraph. That is the featured-snippet
 *     play, and giving it up is a straight loss.
 *   - The internal links, once each. They are the reason the blog exists.
 *   - The line pointing at the printable recipe card, which is what turns a
 *     blog reader into a recipe reader.
 *   - The allowed tags and the house voice.
 * All of those stay in the prompt, where a shape cannot reach them.
 *
 * The blog's FAQ block carries no schema — the site builds FAQPage from the
 * recipe pages' own structured field, not from blog HTML — so a shape that
 * ends another way costs no rich result. That was checked before this existed.
 */

export interface BlogStructure {
  id: number;
  name: string;
  body: string;
  enabled: 0 | 1;
  position: number;
}

/**
 * The shapes a fresh install starts with.
 *
 * The first is what the blog wrote until now, word for word. The rest differ
 * in what the article has to DO — compare, walk through, correct, troubleshoot
 * — not in how the instruction reads.
 *
 * None goes below 700 words: the engine refuses an article under 600 and a
 * shape that aims at the floor would fail runs rather than vary them.
 */
export const DEFAULT_BLOG_STRUCTURES: { name: string; body: string }[] = [
  {
    name: 'Headings and a question block',
    body:
      '- 1,000-1,500 words in total, organised under 4-7 <h2> headings (with <h3> where useful).\n'
      + '- Short paragraphs, <ul>/<ol> lists for steps, options and comparisons. A small <table> is welcome when it truly compares things.\n'
      + '- Finish with <h2>Questions fréquentes</h2> and 3-4 related questions as <h3>, each answered in 2-4 sentences.',
  },
  {
    name: 'Comparison first',
    body:
      '- 1,000-1,400 words in total, under 4-6 <h2> headings.\n'
      + '- The FIRST heading after the opening answer sets the options side by side in a <table>: what each one costs the cook in time, effort or result, and who each suits. Then the headings that follow explain the table rather than repeat it.\n'
      + '- Finish with <h2>Questions fréquentes</h2> and 3-4 related questions as <h3>, each answered in 2-4 sentences.',
  },
  {
    name: 'Walk it through',
    body:
      '- 1,000-1,400 words in total, under 4-6 <h2> headings.\n'
      + '- The spine of the article is an ordered walk-through: an <ol> of the actual steps, each step saying what it should look or feel like when it is right. The headings around it cover what to have ready and what to do afterwards.\n'
      + '- Finish with <h2>Erreurs courantes</h2>: 3-4 named mistakes as <h3>, each with what it produces and how to avoid it. No question block in this shape.',
  },
  {
    name: 'Correct the belief',
    body:
      '- 1,100-1,500 words in total, under 4-6 <h2> headings.\n'
      + '- One heading must take the belief most cooks hold about this question and say plainly how much of it is true and how much is not. Give the reason, not just the verdict. Never mock the belief or invent a study.\n'
      + '- Finish with <h2>Questions fréquentes</h2> and 3-4 related questions as <h3>, each answered in 2-4 sentences.',
  },
  {
    name: 'Short and dense',
    body:
      '- 700-1,000 words in total, under 3-4 <h2> headings. Nothing in this article is there to fill space.\n'
      + '- Prefer lists and one small <table> over paragraphs wherever the content is a set of facts rather than an explanation.\n'
      + '- Finish with <h2>L’essentiel en bref</h2>: a <ul> of 4-6 single-line takeaways a reader could screenshot. No question block in this shape.',
  },
  {
    name: 'The long answer',
    body:
      '- 1,500-2,000 words in total, under 6-8 <h2> headings. Use this length on the detail a shorter article leaves out, never on restating.\n'
      + '- One heading must be troubleshooting: what goes wrong, what it looks like when it does, and what to do about it, as an <h3> each.\n'
      + '- Finish with <h2>Questions fréquentes</h2> and 4-5 related questions as <h3>, each answered in 2-4 sentences.',
  },
];

/** The shapes, oldest first by position; the defaults are put in the first time this is asked. */
export function listBlogStructures(): BlogStructure[] {
  const rows = all<BlogStructure>('SELECT id, name, body, enabled, position FROM blog_structures ORDER BY position, id');
  if (rows.length > 0) return rows;
  DEFAULT_BLOG_STRUCTURES.forEach((s, i) => {
    run('INSERT INTO blog_structures (name, body, enabled, position) VALUES (?, ?, 1, ?)', s.name, s.body, i);
  });
  return all<BlogStructure>('SELECT id, name, body, enabled, position FROM blog_structures ORDER BY position, id');
}

export function addBlogStructure(name: string, body: string): number {
  const next = get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM blog_structures')?.p ?? 0;
  run('INSERT INTO blog_structures (name, body, enabled, position) VALUES (?, ?, 1, ?)', name, body, next);
  return get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0;
}

export function saveBlogStructure(id: number, fields: { name: string; body: string; enabled: boolean }): void {
  run('UPDATE blog_structures SET name = ?, body = ?, enabled = ? WHERE id = ?', fields.name, fields.body, fields.enabled ? 1 : 0, id);
}

export function deleteBlogStructure(id: number): void {
  run('DELETE FROM blog_structures WHERE id = ?', id);
}

/** How many articles each shape has written, for the page. */
export function blogStructureUses(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of all<{ id: number; n: number }>('SELECT blog_structure_id AS id, COUNT(*) AS n FROM blog_questions WHERE blog_structure_id IS NOT NULL GROUP BY blog_structure_id')) {
    out[r.id] = r.n;
  }
  return out;
}

export function pickBlogStructure(
  structures: BlogStructure[],
  recent: number[],
  usesOnSite: Record<number, number>,
  siteId: number,
): BlogStructure | null {
  return pickInRotation(structures.filter((s) => s.enabled && s.body.trim().length > 0), recent, usesOnSite, siteId);
}

/** What one site wrote lately (newest first) and how often each shape was used there. */
export function siteBlogHistory(siteId: number): { recent: number[]; uses: Record<number, number> } {
  const recent = all<{ id: number }>(
    'SELECT blog_structure_id AS id FROM blog_questions WHERE site_id = ? AND blog_structure_id IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT 3',
    siteId,
  ).map((r) => r.id);
  const uses: Record<number, number> = {};
  for (const r of all<{ id: number; n: number }>(
    'SELECT blog_structure_id AS id, COUNT(*) AS n FROM blog_questions WHERE site_id = ? AND blog_structure_id IS NOT NULL GROUP BY blog_structure_id',
    siteId,
  )) {
    uses[r.id] = r.n;
  }
  return { recent, uses };
}

export function markQuestionBlogStructure(questionId: number, structureId: number): void {
  run('UPDATE blog_questions SET blog_structure_id = ? WHERE id = ?', structureId, questionId);
}

/**
 * The block the blog prompt reads.
 *
 * With nothing chosen it is the shape the blog has always written, spelled
 * out here rather than left behind in the prompt file, so there is one place
 * the shape is stated and no second copy to drift from it.
 */
export const blogShape = (structure: BlogStructure | null): string =>
  (structure?.body ?? DEFAULT_BLOG_STRUCTURES[0]!.body).trim();
