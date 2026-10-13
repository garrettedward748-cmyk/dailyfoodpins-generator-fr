import { describe, expect, it } from 'vitest';
import {
  applySpelling, foreignSpellings, ingredientUnitProblems, measureProblems, normaliseStyle,
  styleBlocks, temperatureProblems,
} from '../src/core/writing-style.js';
import {
  bannedList, bannedOpenings, bannedPhrases, checkBlogArticle, checkPart, openingProblems, proseProblems,
  ruleContextFor,
} from '../src/core/article-rules.js';
import { durationsIn, formatMinutes, parseMinutes, timeBlocks } from '../src/core/recipe-times.js';
import { fixProperNouns, fixProperNounsInHtml } from '../src/core/proper-nouns.js';
import { significantWords, titleSimilarity } from '../src/core/similar-title.js';

describe('the French writing style', () => {
  it('is the default, and tells the prompts to write French with metric units', () => {
    expect(normaliseStyle(undefined)).toBe('fr');
    const fr = styleBlocks('fr');
    expect(fr.code).toBe('fr');
    expect(fr.units).toMatch(/°C/);
    expect(fr.units).toMatch(/c\. à soupe/);
    expect(fr.spelling).toMatch(/French/);
    expect(fr.ingredientExample).toBe('225 g de beurre doux, fondu');
  });

  it('never runs the English spelling table over French text', () => {
    // These are correct French that the British→American table would corrupt.
    const text = 'Une courgette, une aubergine et du centre de la fibre, 2 litres, du yaourt gris.';
    expect(applySpelling(text, 'fr')).toBe(text);
    expect(foreignSpellings(text, 'fr')).toEqual([]);
  });
});

describe('French units', () => {
  it('rejects Fahrenheit anywhere, even in brackets', () => {
    expect(temperatureProblems('Cuire à 180 °C.', 'fr', 'step')).toEqual([]);
    expect(temperatureProblems('Cuire à 350°F.', 'fr', 'step')).toHaveLength(1);
    expect(temperatureProblems('Cuire à 180 °C (350°F).', 'fr', 'step')).toHaveLength(1);
  });

  it('rejects cups, ounces, pounds, inches and English spoons', () => {
    expect(measureProblems('Ajouter 250 g de farine et 20 cl de lait.', 'fr', 'step')).toEqual([]);
    expect(measureProblems('Ajouter 2 cups de farine.', 'fr', 'step')).toHaveLength(1);
    expect(measureProblems('Ajouter 8 oz de beurre (230 g).', 'fr', 'step')).toHaveLength(1);
    expect(measureProblems('Ajouter 1 tbsp de sucre.', 'fr', 'step')).toHaveLength(1);
  });

  it('checks the unit of an ingredient line', () => {
    const ok = [{ item: 'farine', unit: 'g' }, { item: 'sucre', unit: 'c. à soupe' }, { item: 'sel', unit: 'pincée' }];
    expect(ingredientUnitProblems(ok, 'fr')).toEqual([]);
    expect(ingredientUnitProblems([{ item: 'beurre', unit: 'cup' }, { item: 'sel', unit: 'tsp' }], 'fr')).toHaveLength(2);
  });
});

describe('French article rules', () => {
  it('uses French banned phrases and openings, not the English ones', () => {
    expect(bannedPhrases('fr')).toContain('délicieux');
    expect(bannedList('fr')).toContain('"délicieux"');
    expect(bannedOpenings('fr')).toContain('quand il s\'agit de');
    expect(proseProblems('Un plat délicieux et incroyable.', 'intro', false, 'fr').join(' ')).toMatch(/délicieux/);
    // Same letters inside a longer word are not the banned word.
    expect(proseProblems('Un plat incroyablement simple.', 'intro', false, 'fr')).toEqual([]);
    expect(proseProblems('A delicious dish.', 'intro', false, 'fr')).toEqual([]);
  });

  it('refuses a narrator in French but allows the reader to speak', () => {
    expect(proseProblems('J\'ai testé cette recette.', 'intro', false, 'fr')).toHaveLength(1);
    expect(proseProblems('Mon conseil : laissez reposer la pâte.', 'intro', false, 'fr')).toHaveLength(1);
    expect(proseProblems('Je peux utiliser du poulet ?', 'question 1', true, 'fr')).toEqual([]);
    // "ma" in maïs, "mes" in mesure and "me" in mélange are not the narrator.
    expect(proseProblems('Le maïs, la mesure et le mélange se préparent à part.', 'intro', false, 'fr')).toEqual([]);
    // "nous" is allowed, like "we".
    expect(proseProblems('Nous cuisons la pâte à feu doux.', 'intro', false, 'fr')).toEqual([]);
  });

  it('refuses a filler opening in French', () => {
    expect(openingProblems('<p>Quand il s\'agit de poulet, la peau compte.</p>', 'fr')).toHaveLength(1);
    expect(openingProblems('<p>Le poulet reste moelleux. Quand il s\'agit de le cuire, patience.</p>', 'fr')).toEqual([]);
  });

  it('holds a French part 1 to the rules, with the French rules', () => {
    const rules = ruleContextFor('fr', {
      raw: 'Préparation 10 minutes, cuisson 20 minutes',
      parsed: { prep_time: '10 minutes', cook_time: '20 minutes', total_time: '30 minutes' },
    });
    const good = {
      title: 'Poulet rôti au citron : tendre et parfumé',
      headline: 'Un poulet doré, citronné et prêt en 30 minutes',
      title_tag: 'Poulet rôti au citron, tendre et doré',
      meta_desc: 'Un poulet rôti au citron, doré dehors et moelleux dedans. Préparation de 10 minutes, cuisson de 20 minutes, et les astuces pour une peau croustillante.',
      intro_html: '<p>Le citron attendrit la chair et parfume la peau pendant la cuisson.</p>',
    };
    expect(checkPart('part-1', good, rules).problems).toEqual([]);

    const bad = {
      ...good,
      title: 'Poulet rôti au citron',
      intro_html: '<p>Quand il s\'agit de poulet, j\'adore ce plat délicieux.</p>',
    };
    const problems = checkPart('part-1', bad, rules).problems.join(' | ');
    expect(problems).toMatch(/colon/);
    expect(problems).toMatch(/délicieux/);
    expect(problems).toMatch(/first person/);
    expect(problems).toMatch(/do not open with/);
  });

  it('flags a title that ends with the word Recette', () => {
    const rules = ruleContextFor('fr', { raw: '', parsed: {} });
    const out = checkPart('part-1', { title: 'Poulet rôti : la recette', headline: 'x', title_tag: 'x', meta_desc: 'x', intro_html: '<p>x</p>' }, rules);
    expect(out.problems.join(' | ')).toMatch(/must not end with the word "Recette"/);
  });

  it('checks a French blog article with the French rules', () => {
    const article = {
      title: 'Pourquoi la pâte à pizza gonfle', slug: 'pate-pizza-gonfle', title_tag: 't', meta_desc: 'x', excerpt: 'x', cover_alt: 'x',
      body_html: '<p>La levure fait gonfler la pâte à 25 °C.</p>',
    };
    expect(checkBlogArticle(article, 'fr').problems).toEqual([]);
    const bad = { ...article, body_html: '<p>Cuire à 400°F. Franchement délicieux.</p>' };
    const problems = checkBlogArticle(bad, 'fr').problems.join(' | ');
    expect(problems).toMatch(/Fahrenheit/);
    expect(problems).toMatch(/franchement/);
  });
});

describe('French durations', () => {
  it('reads heures, h and ranges with "à"', () => {
    expect(durationsIn('Laisser reposer 2 heures.')[0]!.minutes).toEqual([120]);
    expect(durationsIn('Cuire 20 à 25 minutes.')[0]!.minutes).toEqual([20, 25]);
    expect(durationsIn('Au four 1 h 30.')).toHaveLength(1);
    expect(durationsIn('Au four 1 h 30.')[0]!.minutes).toEqual([90]);
    expect(durationsIn('Au four 1h30.')[0]!.minutes).toEqual([90]);
    expect(durationsIn('1 heure et 15 minutes')[0]!.minutes).toEqual([75]);
  });

  it('does not take a word starting with h for hours', () => {
    expect(durationsIn('Servir avec 2 hamburgers maison.')).toEqual([]);
  });

  it('parses French time fields', () => {
    expect(parseMinutes('45 minutes')).toBe(45);
    expect(parseMinutes('1 heure 30')).toBe(90);
    expect(durationsIn('2 heures 30 g de farine')[0]!.minutes).toEqual([120]);
    expect(parseMinutes('1 h 30')).toBe(90);
    expect(parseMinutes('aucun')).toBe(0);
  });

  it('writes times in French when the site is French', () => {
    expect(formatMinutes(65, 'fr')).toBe('1 heure 5 minutes');
    expect(formatMinutes(120, 'fr')).toBe('2 heures');
    expect(formatMinutes(65)).toBe('1 hour 5 minutes');
    expect(timeBlocks({ prep: 10, cook: 70, rest: 0, total: 80, adjusted: false }, 'fr').summary).toMatch(/Total: 1 heure 20 minutes/);
  });
});

describe('French proper nouns', () => {
  it('capitalises occasions and places, not nationalities', () => {
    expect(fixProperNouns('un gâteau pour ramadan et pâques', 'fr')).toBe('un gâteau pour Ramadan et Pâques');
    expect(fixProperNouns('une tajine marocaine', 'fr')).toBe('une tajine marocaine');
    expect(fixProperNouns('chine d\'agneau', 'fr')).toBe('chine d\'agneau');
    expect(fixProperNounsInHtml('<a href="/halloween">halloween</a>', 'fr')).toBe('<a href="/halloween">Halloween</a>');
  });

  it('keeps the English list for an English style', () => {
    expect(fixProperNouns('a moroccan tagine')).toBe('a Moroccan tagine');
    expect(fixProperNouns('une tajine moroccan', 'fr')).toBe('une tajine moroccan');
  });
});

describe('similar titles in French', () => {
  it('keeps the words of an accented title', () => {
    expect(significantWords('Crème brûlée facile')).toEqual(['creme', 'brulee']);
    expect(significantWords('Œufs mimosa')).toEqual(['oeufs', 'mimosa']);
  });

  it('compares a title with and without accents as the same', () => {
    expect(titleSimilarity('Crème brûlée à la vanille', 'Creme brulee a la vanille')).toBe(1);
  });

  it('tells two different accented dishes apart', () => {
    expect(titleSimilarity('Gâteau au yaourt', 'Gratin dauphinois')).toBeLessThan(0.3);
  });
});
