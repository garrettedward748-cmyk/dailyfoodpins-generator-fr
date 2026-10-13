import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { setPromptOverride } from '../src/db/repos.js';
import { invalidatePromptCache } from '../src/pipeline/prompts.js';
import {
  DEFAULT_REEL_STRUCTURES, listReelStructures, nextReelShape, pickReelStructure,
  reelShape, saveReelStructure, templateIgnoresStructures,
} from '../src/core/reel-structures.js';
import { buildReelPrompt } from '../src/reels/compose.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * The scenes of a one-clip reel, rotated.
 *
 * Every one-clip reel came out of one fixed template, and YouTube's rules name
 * template video with minimal variation as content that cannot earn. What
 * rotates is the first eight seconds; what must not move is the closing shot
 * with the call to action, which carries the site's address.
 */

const KEY = randomBytes(32);

beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); invalidatePromptCache(); });
afterEach(() => { closeDatabase(); invalidatePromptCache(); });

describe('the shipped structures', () => {
  it('starts with the scenes the template always had', () => {
    const first = DEFAULT_REEL_STRUCTURES[0]!.body;
    expect(first).toContain('a spoon or knife cuts into it');
    expect(first).toContain('SCENE 3 — 5–8 sec | FINISHING');
    expect(first).toContain('the three words joined with "+"');
    expect(listReelStructures()).toHaveLength(6);
  });

  it('carries no placeholders, because a shape is not rendered a second time', () => {
    for (const s of DEFAULT_REEL_STRUCTURES) expect(s.body).not.toMatch(/\{\{/);
  });

  it('leaves the closing two seconds to the template', () => {
    // The call to action and the address live in the template, after the
    // scenes. A structure that claimed the last seconds would fight it.
    for (const s of DEFAULT_REEL_STRUCTURES) {
      expect(s.body).not.toMatch(/8–10 sec|9–10 sec|call to action/i);
    }
  });
});

describe('the prompt a clip is filmed from', () => {
  const build = (shape?: string) =>
    buildReelPrompt({ title: 'Apple Crumble Tart', presenter: null, cta: 'La recette complète : arbmom.com', shape });

  it('puts the chosen scenes in, and keeps the closing line whatever they say', () => {
    const shape = DEFAULT_REEL_STRUCTURES[2]!.body;
    const prompt = build(shape);
    expect(prompt).toContain('SCENE 1 — 0–2 sec | THE MISTAKE');
    expect(prompt).toContain('word for word: "La recette complète : arbmom.com"');
    expect(prompt).toContain('Subtitle: "La recette complète : arbmom.com"');
    expect(prompt).not.toMatch(/\{\{/);
  });

  it('falls back to the template’s own scenes when given none', () => {
    expect(build()).toContain(reelShape(null));
    expect(build('   ')).toContain('a spoon or knife cuts into it');
  });

  it('keeps the opening-line rule for every structure, not only the first', () => {
    // It used to sit inside scene 1 of the one template; moved out so a
    // structure that opens differently still cannot splice the title.
    const prompt = build(DEFAULT_REEL_STRUCTURES[4]!.body);
    expect(prompt).toContain('do NOT copy, splice or rearrange words from the recipe title');
  });
});

describe('rotation', () => {
  it('never takes one of the site’s last three', () => {
    const all = listReelStructures();
    const recent = all.slice(0, 3).map((s) => s.id);
    for (let site = 1; site <= 6; site++) {
      const chosen = pickReelStructure(all, recent, {}, site)!;
      expect(recent).not.toContain(chosen.id);
    }
  });

  it('falls back to the shipped scenes when every structure is off', () => {
    for (const s of listReelStructures()) saveReelStructure(s.id, { name: s.name, body: s.body, enabled: false });
    const next = nextReelShape(1);
    expect(next.id).toBeNull();
    expect(next.shape).toBe(DEFAULT_REEL_STRUCTURES[0]!.body.trim());
  });
});

describe('a template edited before it had a place for the scenes', () => {
  it('is noticed, because an edit wins over the shipped file', () => {
    expect(templateIgnoresStructures()).toBe(false);
    setPromptOverride('reel-video.template.txt', 'An old edit with SCENE 1 written out by hand.');
    expect(templateIgnoresStructures()).toBe(true);
    setPromptOverride('reel-video.template.txt', 'An edit that kept it: {{reelShape}}');
    expect(templateIgnoresStructures()).toBe(false);
  });
});

describe('the page', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({
      method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterEach(async () => { await app.close(); });

  it('lists the six and saves them with one button, each switch with its own row', async () => {
    const page = await app.inject({ method: 'GET', url: '/settings/reel-structures', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('First bite, then back');
    expect(page.body).toContain('Save all structures');

    const rows = listReelStructures().slice(0, 3);
    const payload = [
      ...rows.flatMap((r) => [`id=${r.id}`, `name=${encodeURIComponent(`R ${r.id}`)}`, `body=${encodeURIComponent(r.body)}`]),
      `enabled=${rows[0]!.id}`,
      `enabled=${rows[2]!.id}`,
    ].join('&');
    const saved = await app.inject({
      method: 'POST', url: '/settings/reel-structures/save', payload,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(saved.statusCode).toBe(303);

    const after = listReelStructures();
    expect(after.find((r) => r.id === rows[1]!.id)).toMatchObject({ name: `R ${rows[1]!.id}`, enabled: 0 });
    expect(after.find((r) => r.id === rows[2]!.id)!.enabled).toBe(1);
  });
});
