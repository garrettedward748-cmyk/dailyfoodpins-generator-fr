import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { createRun, insertKeyword, upsertSite } from '../src/db/repos.js';
import {
  addArticleStructure, articleStructureUses, DEFAULT_STRUCTURES, listArticleStructures,
  markRunArticleStructure, pickArticleStructure, saveArticleStructure, siteStructureHistory,
  structureBlocks, type ArticleStructure,
} from '../src/core/article-structures.js';
import { render } from '../src/pipeline/prompts.js';

const KEY = randomBytes(32);
const s = (id: number, enabled = 1): ArticleStructure =>
  ({ id, name: `s${id}`, intro: `intro ${id}`, sections: `sections ${id}`, enabled: enabled as 0 | 1, position: id });

describe('article structures', () => {
  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  it('starts with six shapes, each with both halves and exact counts', () => {
    const structures = listArticleStructures();
    expect(structures).toHaveLength(6);
    expect(listArticleStructures()).toHaveLength(6); // not seeded twice
    expect(structures.every((x) => x.intro.trim() && x.sections.trim())).toBe(true);
    // A shape with no number in it is a suggestion, not a structure.
    expect(structures.every((x) => /EXACTLY (ONE|TWO|THREE|FOUR)/.test(x.intro))).toBe(true);
    expect(structures.every((x) => /EXACTLY (ONE|TWO|THREE|FOUR)/.test(x.sections))).toBe(true);
  });

  it('asks for genuinely different articles, not six wordings of one', () => {
    const [, mistake, decision, traditional, ingredient, short] = DEFAULT_STRUCTURES;
    expect(mistake!.sections).toContain('What goes wrong and why');
    expect(decision!.sections).toContain('FOUR questions');
    expect(traditional!.sections).toContain('How it differs from the traditional method');
    expect(ingredient!.sections).toMatch(/cannot be found/);
    expect(short!.intro).toContain('EXACTLY ONE <p>');
    // The intros do not all ask for the same number of paragraphs.
    const counts = new Set(DEFAULT_STRUCTURES.map((x) => x.intro.match(/EXACTLY (ONE|TWO|THREE)/)?.[1]));
    expect(counts.size).toBeGreaterThan(1);
  });

  it('rotates like the other two, and skips the off or half-written', () => {
    expect(pickArticleStructure([s(1), s(2), s(3), s(4)], [1, 2, 3], {}, 0)!.id).toBe(4);
    expect(pickArticleStructure([s(1, 0), { ...s(2), sections: '  ' }, { ...s(3), intro: '' }, s(4)], [], {}, 0)!.id).toBe(4);
    expect(pickArticleStructure([s(1, 0)], [], {}, 0)).toBeNull();
  });

  it("reads a site's history from its runs", () => {
    const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    const k = insertKeyword({ seed_keyword: 'x', spy_title: 'X' });
    const ids = listArticleStructures().map((x) => x.id);
    for (const id of [ids[0]!, ids[1]!, ids[1]!, ids[2]!]) markRunArticleStructure(createRun(k, siteId), id);
    const h = siteStructureHistory(siteId);
    expect(h.recent).toEqual([ids[2], ids[1], ids[1]]);
    expect(h.uses[ids[1]!]).toBe(2);
    expect(articleStructureUses()[ids[1]!]).toBe(2);
  });

  it('adds and edits a structure', () => {
    listArticleStructures();
    const id = addArticleStructure('Mine', '- EXACTLY ONE <p>', '- EXACTLY TWO sections');
    saveArticleStructure(id, { name: 'Mine 2', intro: 'a', sections: 'b', enabled: false });
    expect(listArticleStructures().find((x) => x.id === id)).toMatchObject({ name: 'Mine 2', enabled: 0 });
  });
});

describe('the shape as the prompts read it', () => {
  it('falls back to the shape the site has always written', () => {
    const blocks = structureBlocks(null);
    expect(blocks.structureIntro).toBe(DEFAULT_STRUCTURES[0]!.intro.trim());
    expect(blocks.structureSections).toBe(DEFAULT_STRUCTURES[0]!.sections.trim());
  });

  it('reaches part 1 and part 3, and leaves part 2 alone', () => {
    const part1 = readFileSync('prompts/part-1.user.txt', 'utf8');
    const part2 = readFileSync('prompts/part-2.user.txt', 'utf8');
    const part3 = readFileSync('prompts/part-3.user.txt', 'utf8');
    expect(part1).toContain('{{structureIntro}}');
    expect(part3).toContain('{{structureSections}}');
    // The recipe card is structured data for Google; nothing here varies it.
    expect(part2).not.toContain('{{structure');
  });

  it('puts the chosen shape in, and leaves no placeholder behind', () => {
    const vars = { seo: {}, recipe: {}, ...structureBlocks(s(9)) };
    const part1 = render(readFileSync('prompts/part-1.user.txt', 'utf8'), vars);
    const part3 = render(readFileSync('prompts/part-3.user.txt', 'utf8'), vars);
    expect(part1).toContain('intro 9');
    expect(part3).toContain('sections 9');
    expect(part1).not.toContain('{{');
    expect(part3).not.toContain('{{');
    // The house rules the structures must not be able to overrule are still there.
    expect(part1).toContain('No anecdote. No history lesson. No promise.');
    expect(part3).toContain('Say no when the answer is no.');
  });

  it('leaves the fallback prompts on the fixed shape', () => {
    for (const file of ['part-1.fallback.user.txt', 'part-3.fallback.user.txt']) {
      expect(readFileSync(`prompts/${file}`, 'utf8')).not.toContain('{{structure');
    }
  });
});
