import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, openDatabase } from '../src/db/index.js';
import { upsertSite } from '../src/db/repos.js';
import { addBlogQuestions } from '../src/blog/repo.js';
import {
  addBlogStructure, blogShape, blogStructureUses, DEFAULT_BLOG_STRUCTURES, listBlogStructures,
  markQuestionBlogStructure, pickBlogStructure, saveBlogStructure, siteBlogHistory, type BlogStructure,
} from '../src/core/blog-structures.js';
import { render } from '../src/pipeline/prompts.js';

const KEY = randomBytes(32);
const s = (id: number, enabled = 1): BlogStructure => ({ id, name: `s${id}`, body: `shape ${id}`, enabled: enabled as 0 | 1, position: id });

describe('blog structures', () => {
  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  it('starts with six shapes, each naming a length and an ending', () => {
    const structures = listBlogStructures();
    expect(structures).toHaveLength(6);
    expect(listBlogStructures()).toHaveLength(6); // not seeded twice
    expect(structures.every((x) => /words in total/.test(x.body))).toBe(true);
    expect(structures.every((x) => /Finish with/.test(x.body))).toBe(true);
  });

  it('never aims under the 600-word floor the engine enforces', () => {
    for (const shape of DEFAULT_BLOG_STRUCTURES) {
      const low = Number(shape.body.match(/([\d,]+)\s*-\s*[\d,]+ words/)![1]!.replace(/,/g, ''));
      expect(low).toBeGreaterThanOrEqual(700);
    }
  });

  it('asks for genuinely different articles, not six wordings of one', () => {
    const endings = DEFAULT_BLOG_STRUCTURES.map((x) => x.body.match(/Finish with <h2>([^<]+)<\/h2>/)?.[1]);
    // Not every article ends with the same question block any more.
    expect(new Set(endings).size).toBeGreaterThan(1);
    expect(endings).toContain('Common mistakes');
    expect(endings).toContain('The short version');
    expect(DEFAULT_BLOG_STRUCTURES.some((x) => /<table>/.test(x.body))).toBe(true);
    expect(DEFAULT_BLOG_STRUCTURES.some((x) => /troubleshooting/i.test(x.body))).toBe(true);
  });

  it('rotates like the others and skips the off or empty', () => {
    expect(pickBlogStructure([s(1), s(2), s(3), s(4)], [1, 2, 3], {}, 0)!.id).toBe(4);
    expect(pickBlogStructure([s(1, 0), { ...s(2), body: ' ' }, s(3)], [], {}, 0)!.id).toBe(3);
    expect(pickBlogStructure([s(1, 0)], [], {}, 0)).toBeNull();
  });

  it("reads a site's history from its questions", () => {
    const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    addBlogQuestions(siteId, ['Can you freeze cheesecake?', 'How long does bread dough rise?', 'What temperature is salmon done at?']);
    const questions = all<{ id: number }>('SELECT id FROM blog_questions WHERE site_id = ? ORDER BY id', siteId).map((r) => r.id);
    const ids = listBlogStructures().map((x) => x.id);
    markQuestionBlogStructure(questions[0]!, ids[0]!);
    markQuestionBlogStructure(questions[1]!, ids[1]!);
    markQuestionBlogStructure(questions[2]!, ids[1]!);
    const h = siteBlogHistory(siteId);
    expect(h.uses[ids[1]!]).toBe(2);
    expect(h.recent).toContain(ids[1]);
    expect(blogStructureUses()[ids[1]!]).toBe(2);
  });

  it('adds and edits a structure', () => {
    listBlogStructures();
    const id = addBlogStructure('Mine', '- 900-1,100 words. - Finish with <h2>X</h2>');
    saveBlogStructure(id, { name: 'Mine 2', body: 'x', enabled: false });
    expect(listBlogStructures().find((x) => x.id === id)).toMatchObject({ name: 'Mine 2', enabled: 0 });
  });
});

describe('the shape as the blog prompt reads it', () => {
  it('falls back to the shape the blog has always written', () => {
    expect(blogShape(null)).toBe(DEFAULT_BLOG_STRUCTURES[0]!.body.trim());
  });

  it('puts the shape in and leaves the four fixed things alone', () => {
    const template = readFileSync('prompts/blog-article.system.txt', 'utf8');
    expect(template).toContain('{{blogShape}}');
    const rendered = render(template, {
      site: { name: 'n', domain: 'd' },
      recipe: { title: 't' },
      links: '- x',
      blogShape: blogShape(s(5)),
    });
    expect(rendered).toContain('shape 5');
    expect(rendered).not.toContain('{{');
    expect(rendered).toContain('answers the question directly and completely in 40-60 words');
    expect(rendered).toContain('EXACTLY ONCE in the whole article');
    expect(rendered).toContain('printable recipe card');
    expect(rendered).toContain('Allowed tags only');
  });

  it('no longer hard-codes the question block it used to end with', () => {
    const template = readFileSync('prompts/blog-article.system.txt', 'utf8');
    expect(template).not.toContain('Finish with <h2>Frequently asked questions</h2>');
  });
});
