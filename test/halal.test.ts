import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, openDatabase, run } from '../src/db/index.js';
import { addPastedKeywords, upsertSite } from '../src/db/repos.js';
import { addBlogQuestions } from '../src/blog/repo.js';
import { haramWord, haramWords, halalOnly } from '../src/core/halal.js';
import { researchKeywords } from '../src/research/keywords.js';

beforeEach(() => openDatabase(':memory:'));
afterEach(() => closeDatabase());

describe('halal only', () => {
  it('knows alcohol and pork, and leaves look-alikes alone', () => {
    for (const t of ['Rum Cake', 'Bacon Mac and Cheese', 'Chicken Marsala', 'Dessert Martinis', 'Pepperoni Pizza', 'banana pudding alcohol'])
      expect(haramWord(t)).not.toBeNull();
    for (const t of ['Hamburger Buns', 'Gingerbread Cookies', 'Turkey Bacon Wrap', 'Root Beer Float', 'Apple Cider Donuts', 'Graham Cracker Crust', 'Banana Pudding Shooters'])
      expect(haramWord(t)).toBeNull();
  });

  it('lets the halal stand-ins and "instead of" through, in English and French, and still catches the real thing', () => {
    for (const t of ['Use turkey bacon instead of bacon', 'beef prosciutto and figs', 'lardons de dinde', 'sans lardons',
      'au lieu du vin, du jus de raisin', 'remplacez le jambon par de la dinde', 'chorizo de bœuf', 'jambon halal'])
      expect(haramWord(t)).toBeNull();
    for (const t of ['pizza au prosciutto', 'quiche lorraine aux lardons', 'un verre de vin blanc', 'crispy bacon on top'])
      expect(haramWord(t)).not.toBeNull();
  });

  it('names every forbidden word, not just the first', () => {
    expect([...haramWords('des lardons, du prosciutto et du vin; encore des lardons')].sort()).toEqual(['lardons', 'prosciutto', 'vin']);
  });

  it('is on unless switched off', () => {
    expect(halalOnly()).toBe(true);
    run("INSERT INTO settings (key, value) VALUES ('halal_only', 'false')");
    expect(halalOnly()).toBe(false);
  });

  it('refuses such keywords and blog questions', () => {
    const site = upsertSite({ name: 's', domain: 's.com', status: 'active', daily_target: 1, interval_minutes: 60 }, randomBytes(32));
    const r = addPastedKeywords(['Rum Raisin Ice Cream', 'Banana Pudding Cups'], 'dessert', [site]);
    expect(r.added).toBe(1);
    expect(r.similar[0]).toContain('rum');
    const q = addBlogQuestions(site, ['Can you cook bacon in the oven?', 'Can you freeze banana pudding?']);
    expect(q.added).toBe(1);
    expect(all<{ spy_title: string }>('SELECT spy_title FROM keywords').map((k) => k.spy_title)).toEqual(['Banana Pudding Cups']);
  });

  it('drops such searches from keyword research', async () => {
    const fake = (async (u: string | URL | Request) => {
      const q = new URL(String(u)).searchParams.get('q');
      return new Response(JSON.stringify([q, q === 'banana pudding' ? ['banana pudding shots', 'banana pudding with rum', 'banana pudding cups'] : []]));
    }) as typeof fetch;
    const r = await researchKeywords('banana pudding', { fetchImpl: fake });
    expect(r.recipes.map((x) => x.text)).toEqual(['banana pudding cups']);
  });
});

describe('words that say there is no alcohol', () => {
  it('REGRESSION run #1012: a summer drink that says it has none is not refused', () => {
    for (const text of [
      'A refreshing strawberry quencher with zero alcohol.',
      'Completely free of alcohol and kid friendly.',
      'Made without any alcohol.',
      'A non alcoholic summer drink.',
      'Fully alcohol‑free.',
      'Fizzy water instead of alcohol keeps it light.',
    ]) expect(haramWord(text), text).toBeNull();
  });

  it('still refuses alcohol that is in the drink', () => {
    expect(haramWord('Add a splash of alcohol if you like.')).toBe('alcohol');
    expect(haramWord('Top with rum.')).toBe('rum');
  });
});
