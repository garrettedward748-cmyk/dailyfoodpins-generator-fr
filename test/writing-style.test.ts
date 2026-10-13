import { describe, expect, it } from 'vitest';
import {
  applySpelling, applySpellingToHtml, foreignSpellings, ingredientUnitProblems,
  measureProblems, normaliseStyle, styleBlocks, temperatureProblems,
} from '../src/core/writing-style.js';

/**
 * A site for American cooks came out as "savoury", "colour" and "260°C (500°F)"
 * because the recipe prompts hard-coded British English for every site. These
 * pin the two halves of the fix: spelling is converted in code, units are
 * checked in code, and both follow the site's own setting.
 */

describe('the site setting', () => {
  it('is "fr" (the French edition) unless it is exactly "us" or "uk"', () => {
    expect(normaliseStyle('uk')).toBe('uk');
    expect(normaliseStyle('us')).toBe('us');
    expect(normaliseStyle('fr')).toBe('fr');
    expect(normaliseStyle(undefined)).toBe('fr');
    expect(normaliseStyle(null)).toBe('fr');
    expect(normaliseStyle('UK')).toBe('fr');
    expect(normaliseStyle('british')).toBe('fr');
  });

  it('gives the prompts rules that match the setting, not a fixed country', () => {
    const us = styleBlocks('us');
    const uk = styleBlocks('uk');

    expect(us.spelling).toContain('American spelling');
    expect(us.spelling).not.toContain('British spelling');
    expect(us.units).toContain('°F');
    expect(us.ingredientUnits).toContain('cup');

    expect(uk.spelling).toContain('British spelling');
    expect(uk.spelling).not.toContain('American spelling');
    expect(uk.units).toContain('°C');
    expect(uk.ingredientUnits).toContain('"g"');
  });

  it('writes no rule that contradicts itself (a spelling in its own "not" list)', () => {
    // "center not centre" was once written as "center not center".
    for (const style of ['us', 'uk'] as const) {
      for (const match of styleBlocks(style).spelling.matchAll(/(\w+) not (\w+)/g)) {
        expect(match[1], `"${match[0]}" is not a difference`).not.toBe(match[2]);
      }
    }
  });
});

describe('spelling, converted in code', () => {
  it('turns the British words a recipe uses into American ones', () => {
    const text = 'A savoury, flavoursome dish with colourful peppers. Caramelise the onions in the centre of the pan, then add yoghurt and grey mould-free chillies.';
    const fixed = applySpelling(text, 'us');

    expect(fixed).toContain('savory');
    expect(fixed).toContain('flavorsome');
    expect(fixed).toContain('colorful');
    expect(fixed).toContain('Caramelize');
    expect(fixed).toContain('center');
    expect(fixed).toContain('yogurt');
    expect(fixed).toContain('gray');
    expect(fixed).toContain('chilies');
    expect(foreignSpellings(fixed, 'us')).toEqual([]);
  });

  it('turns the American words into British ones for a British site', () => {
    const fixed = applySpelling('Caramelize the onions in the center, then add color and flavor. Check the fiber.', 'uk');

    expect(fixed).toBe('Caramelise the onions in the centre, then add colour and flavour. Check the fibre.');
    expect(foreignSpellings(fixed, 'uk')).toEqual([]);
  });

  it('keeps the capitals the original had', () => {
    expect(applySpelling('Savoury', 'us')).toBe('Savory');
    expect(applySpelling('COLOUR', 'us')).toBe('COLOR');
    expect(applySpelling('colour', 'us')).toBe('color');
  });

  it('REGRESSION: the exact words the flavorza recipes shipped with', () => {
    // From the live pages: "Savoury Roast", "colour", "fibres", "greyish", "Appetiser" is left to the model.
    expect(applySpelling('Honey Roasted Butternut Squash Stuffed with Chicken: Savoury Roast', 'us')).toContain('Savory Roast');
    expect(applySpelling('a deep brown colour', 'us')).toBe('a deep brown color');
    expect(applySpelling('redistribute through the fibres', 'us')).toBe('redistribute through the fibers');
    expect(applySpelling('a dry, greyish texture', 'us')).toBe('a dry, grayish texture');
  });

  it('does not touch words that only look like them', () => {
    const text = 'Rise, raise and praise the bread; a surprise at the premise of the exercise. Advise the cook to revise the plan.';
    expect(applySpelling(text, 'us')).toBe(text);
    expect(applySpelling(text, 'uk')).toBe(text);
  });

  it('leaves the herb alone: "savory" is also correct, and different, in British English', () => {
    expect(applySpelling('Add a sprig of summer savory.', 'uk')).toBe('Add a sprig of summer savory.');
  });

  it('leaves a tea called Earl Grey alone', () => {
    expect(applySpelling('An Earl Grey cake with grey icing.', 'us')).toBe('An Earl Grey cake with gray icing.');
  });

  it('changes different words for the same food, never an ambiguous one', () => {
    expect(applySpelling('2 courgettes, caster sugar and double cream', 'us')).toBe('2 zucchini, superfine sugar and heavy cream');
    // "cornflour" means two different things, so it is not guessed at.
    expect(applySpelling('1 tbsp cornflour', 'us')).toBe('1 tbsp cornflour');
  });

  it('steps over tags, so a link is never "corrected"', () => {
    const html = '<p>A <a href="/colour-guide" title="colour">colour</a> guide to savoury food.</p>';
    expect(applySpellingToHtml(html, 'us')).toBe('<p>A <a href="/colour-guide" title="colour">color</a> guide to savory food.</p>');
  });

  it('converts the words inside a slug', () => {
    expect(applySpelling('savoury-chicken-colour-bowl', 'us')).toBe('savory-chicken-color-bowl');
  });
});

describe('temperatures', () => {
  it('REGRESSION: "260°C (500°F)" is Celsius first, which an American site must not publish', () => {
    const problems = temperatureProblems('Place the skillet into an oven preheated to 260°C (500°F).', 'us', 'step 4');
    expect(problems).toHaveLength(1);
    expect(problems[0]!.detail).toContain('260°C');
    expect(problems[0]!.detail).toContain('°F first');
  });

  it('accepts Fahrenheit first with Celsius in brackets after it', () => {
    expect(temperatureProblems('Bake at 400°F (200°C) until golden.', 'us', 'x')).toEqual([]);
    expect(temperatureProblems('Reach 140-145°F (60-63°C) for medium-rare.', 'us', 'x')).toEqual([]);
    expect(temperatureProblems('Preheat to 350 °F.', 'us', 'x')).toEqual([]);
  });

  it('refuses a Celsius temperature with no Fahrenheit figure at all', () => {
    expect(temperatureProblems('Reach 49°C in the thickest part.', 'us', 'x')).toHaveLength(1);
  });

  it('catches a bracket that is further away than it looks', () => {
    // The bracket belongs to something else; this Celsius figure is still first.
    expect(temperatureProblems('Bake at 200°C and then rest (500°F).', 'us', 'x')).toHaveLength(1);
  });

  it('does the mirror image for a British site', () => {
    expect(temperatureProblems('Bake at 200°C (400°F).', 'uk', 'x')).toEqual([]);
    expect(temperatureProblems('Bake at 400°F (200°C).', 'uk', 'x')).toHaveLength(1);
  });

  it('reads every temperature in a text, not only the first', () => {
    const text = 'Sear at 450°F (230°C), then finish at 260°C and rest at 120°C.';
    expect(temperatureProblems(text, 'us', 'x')).toHaveLength(2);
  });
});

describe('weights, volumes and lengths', () => {
  it('refuses metric amounts on an American site, unless in brackets after the US one', () => {
    expect(measureProblems('Add 250 g flour and 100ml milk.', 'us', 'x')).toHaveLength(2);
    expect(measureProblems('Slice it 1-inch (2.5 cm) thick, about 8 oz (225 g) each.', 'us', 'x')).toEqual([]);
    expect(measureProblems('Cut into 1.3 cm strips.', 'us', 'x')).toHaveLength(1);
  });

  it('refuses imperial amounts on a British site', () => {
    expect(measureProblems('Add 2 cups of flour and 8 oz butter.', 'uk', 'x')).toHaveLength(2);
    expect(measureProblems('Add 250 g flour (about 2 cups).', 'uk', 'x')).toEqual([]);
  });

  it('is not fooled by words that merely start with a unit letter', () => {
    expect(measureProblems('Use 1 lemon, 2 large eggs and 3 limes.', 'us', 'x')).toEqual([]);
    expect(measureProblems('Use 1 lb of beef and 2 lbs of potatoes.', 'us', 'x')).toEqual([]);
  });

  it('checks the unit of every ingredient line', () => {
    const lines = [
      { amount: '2', unit: 'cup', item: 'flour' },
      { amount: '250', unit: 'g', item: 'butter' },
      { amount: '3', unit: '', item: 'eggs' },
      { amount: '1', unit: 'tbsp', item: 'oil' },
    ];
    const us = ingredientUnitProblems(lines, 'us');
    expect(us).toHaveLength(1);
    expect(us[0]!.where).toBe('ingredients line 2');
    expect(ingredientUnitProblems(lines, 'uk').map((p) => p.where)).toEqual(['ingredients line 1']);
    expect(ingredientUnitProblems('not a list', 'us')).toEqual([]);
  });
});
