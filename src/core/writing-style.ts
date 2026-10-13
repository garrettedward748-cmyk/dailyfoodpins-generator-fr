/**
 * How one site spells and measures.
 *
 * Until now this was written into six prompt files as "British spelling,
 * metric first" — for every site, whatever its readers use. A site for
 * American cooks came out with "savoury" and "colour", centimetres and
 * "260°C (500°F)" next to a blog written in American English, because the
 * recipe prompts and the blog prompt disagreed and nothing checked either.
 *
 * Two things follow from that, and both live here:
 *
 *  - The setting is the site's, stored on the site, and handed to the prompts
 *    as variables. A prompt cannot say "British" any more; it says whatever the
 *    site is.
 *  - Spelling is not left to the model. Which letters a word takes is a lookup,
 *    not a judgement, so it is done in code on the finished text and cannot be
 *    forgotten. Units are different — converting 350°F by machine would rewrite
 *    a number — so those are checked, and a draft that breaks them is sent back.
 */

export type WritingStyle = 'fr' | 'us' | 'uk';

export const WRITING_STYLES: readonly WritingStyle[] = ['fr', 'us', 'uk'];

/**
 * This is the French edition of the platform: anything that is not exactly "us"
 * or "uk" is "fr", the default for a site nobody configured. "us" and "uk" are
 * kept so an English site can still be added next to the French ones.
 */
export function normaliseStyle(value: unknown): WritingStyle {
  return value === 'us' || value === 'uk' ? value : 'fr';
}

export const STYLE_LABELS: Record<WritingStyle, string> = {
  fr: 'Français — orthographe française, °C et grammes',
  us: 'American — US spelling, °F and cups',
  uk: 'British — UK spelling, °C and grams',
};

/* -------------------------------------------------------------------------
 * What the prompts are told
 * ---------------------------------------------------------------------- */

export interface StyleBlocks {
  /** "fr", "us" or "uk", for a prompt that wants the bare word. */
  code: WritingStyle;
  /** The spelling rule, written as the lines of a bulleted list. */
  spelling: string;
  /** The units rule, written as the lines of a bulleted list. */
  units: string;
  /** The units an ingredient line may use, for the recipe card's `unit` field. */
  ingredientUnits: string;
  /** One ingredient line as this site writes it, for an example. */
  ingredientExample: string;
  /** One temperature as this site writes it, for an example. */
  temperatureExample: string;
}

const SPELLING_RULE: Record<WritingStyle, string> = {
  fr:
    '- Write in natural, standard French (France), not a translation from English. Use every accent,\n'
    + '  cedilla and ligature French spelling needs (é, è, ê, à, ç, ô, œ in œuf, bœuf, cœur). Use the\n'
    + '  everyday French word, never the English one: courgette not zucchini, aubergine not eggplant,\n'
    + '  crevettes not shrimps, levure chimique not baking powder, sucre glace not powdered sugar,\n'
    + '  crème entière not heavy cream. Check every word before you answer.',
  us:
    '- American spelling throughout, with no British form anywhere: savory not\n'
    + '  savoury, flavor not flavour, color not colour, caramelize not caramelise,\n'
    + '  center not centre, gray not grey, yogurt not yoghurt, zucchini not courgette.\n'
    + '  Check every word before you answer.',
  uk:
    '- British spelling throughout, with no American form anywhere: savoury not\n'
    + '  savory, flavour not flavor, colour not color, caramelise not caramelize,\n'
    + '  centre not center, grey not gray. Check every word before you answer.',
};

const UNITS_RULE: Record<WritingStyle, string> = {
  fr:
    '- Metric units only, written the French way: temperatures in °C with a space (180 °C), weights in g and\n'
    + '  kg, volumes in ml, cl and l, lengths in cm. Spoons are « c. à soupe » and « c. à café », a small\n'
    + '  amount is « une pincée ». Never use °F, cups, ounces, pounds, inches or sticks, and do not put them\n'
    + '  in brackets either. A French oven setting may follow the Celsius figure in brackets: « 180 °C\n'
    + '  (thermostat 6) ». The ingredient list uses metric units, c. à soupe and c. à café only.',
  us:
    '- US units first: temperatures in °F, volumes in cups, tablespoons and teaspoons,\n'
    + '  weights in ounces and pounds, lengths in inches. Put the metric figure in\n'
    + '  brackets AFTER the US one, and only for temperatures and for lengths: "400°F\n'
    + '  (200°C)", "1-inch (2.5 cm) thick". Never write a Celsius temperature first,\n'
    + '  never write one without its Fahrenheit figure, and never mix the two orders\n'
    + '  in one article. The ingredient list uses US units only.',
  uk:
    '- Metric units first: temperatures in °C, volumes in millilitres, weights in\n'
    + '  grams and kilograms, lengths in centimetres. Put the imperial figure in\n'
    + '  brackets AFTER the metric one where a reader would want it: "200°C (400°F)".\n'
    + '  Never write a Fahrenheit temperature first, and never mix the two orders in\n'
    + '  one article. The ingredient list uses metric units only, apart from\n'
    + '  teaspoons and tablespoons.',
};

const INGREDIENT_UNITS: Record<WritingStyle, string> = {
  fr: '"g", "kg", "ml", "cl", "l", "c. à soupe", "c. à café", "pincée" — never "cup", "oz", "lb", "tbsp" or "tsp"',
  us: '"cup", "tbsp", "tsp", "oz", "lb", "pinch" — never "g", "kg", "ml" or "l"',
  uk: '"g", "kg", "ml", "l", "tbsp", "tsp" — never "cup", "oz" or "lb"',
};

const INGREDIENT_EXAMPLE: Record<WritingStyle, string> = {
  fr: '225 g de beurre doux, fondu',
  us: '1 cup unsalted butter, melted',
  uk: '225 g unsalted butter, melted',
};

const TEMPERATURE_EXAMPLE: Record<WritingStyle, string> = {
  fr: '74 °C',
  us: '165°F (74°C)',
  uk: '74°C (165°F)',
};

/** What every prompt that mentions spelling or units interpolates. */
export function styleBlocks(style: WritingStyle | string | null | undefined): StyleBlocks {
  const code = normaliseStyle(style);
  return {
    code,
    spelling: SPELLING_RULE[code],
    units: UNITS_RULE[code],
    ingredientUnits: INGREDIENT_UNITS[code],
    ingredientExample: INGREDIENT_EXAMPLE[code],
    temperatureExample: TEMPERATURE_EXAMPLE[code],
  };
}

/* -------------------------------------------------------------------------
 * Spelling
 * ---------------------------------------------------------------------- */

/**
 * [British, American] pairs, and whether the American form may be turned back
 * into the British one.
 *
 * `oneWay` marks the pairs where the American spelling is also correct British
 * (yogurt) or is a different word in British English (savory the herb), so
 * converting in reverse would corrupt text that was right.
 */
interface Pair {
  uk: string;
  us: string;
  oneWay?: boolean;
}

/** A stem that takes the same suffixes in both spellings. */
function family(ukStem: string, usStem: string, suffixes: string[], oneWay = false): Pair[] {
  return suffixes.map((s) => ({ uk: ukStem + s, us: usStem + s, oneWay }));
}

/** -ise / -ize verbs: the forms a recipe actually uses. */
const ISE_STEMS = [
  'caramel', 'crystal', 'emphas', 'organ', 'recogn', 'minim', 'maxim', 'steril',
  'pasteur', 'homogen', 'custom', 'personal', 'priorit', 'real', 'stabil', 'oxid',
  'sanit', 'neutral', 'familiar', 'visual', 'util', 'apolog', 'summar', 'character',
  'special', 'standard', 'tender', 'pulver', 'vapor', 'final', 'normal', 'optim',
  'general', 'local', 'formal', 'author', 'critic', 'memor', 'harmon', 'mineral',
];

const ISE_SUFFIXES: [string, string][] = [
  ['ise', 'ize'], ['ised', 'ized'], ['ises', 'izes'], ['ising', 'izing'],
  ['isation', 'ization'], ['iser', 'izer'], ['isers', 'izers'],
];

function iseFamilies(): Pair[] {
  const out: Pair[] = [];
  for (const stem of ISE_STEMS) {
    for (const [uk, us] of ISE_SUFFIXES) {
      out.push({ uk: stem + uk, us: stem + us });
    }
  }
  // analyse / analyze and friends take -yse / -yze.
  for (const stem of ['anal', 'catal', 'paral']) {
    for (const [uk, us] of [['yse', 'yze'], ['ysed', 'yzed'], ['yses', 'yzes'], ['ysing', 'yzing']]) {
      out.push({ uk: stem + uk, us: stem + us });
    }
  }
  return out;
}

const PAIRS: Pair[] = [
  ...iseFamilies(),
  // -our / -or
  ...family('flavour', 'flavor', ['', 's', 'ed', 'ing', 'ings', 'ful', 'less', 'some']),
  ...family('colour', 'color', ['', 's', 'ed', 'ing', 'ings', 'ful', 'less']),
  ...family('discolour', 'discolor', ['', 's', 'ed', 'ing']),
  ...family('favour', 'favor', ['', 's', 'ed', 'ing', 'ite', 'ites']),
  ...family('honour', 'honor', ['', 's', 'ed', 'ing']),
  ...family('neighbour', 'neighbor', ['', 's', 'ing']),
  ...family('vapour', 'vapor', ['', 's']),
  ...family('odour', 'odor', ['', 's']),
  // -re / -er
  ...family('centre', 'center', ['', 's', 'd', 'piece', 'pieces']),
  { uk: 'centring', us: 'centering' },
  ...family('litre', 'liter', ['', 's']),
  ...family('millilitre', 'milliliter', ['', 's']),
  ...family('centilitre', 'centiliter', ['', 's']),
  ...family('fibre', 'fiber', ['', 's']),
  // doubled consonants
  ...family('labell', 'label', ['ed', 'ing']),
  ...family('levell', 'level', ['ed', 'ing']),
  ...family('modell', 'model', ['ed', 'ing']),
  ...family('cancell', 'cancel', ['ed', 'ing']),
  ...family('travell', 'travel', ['ed', 'ing', 'er', 'ers']),
  // the rest
  { uk: 'mould', us: 'mold' },
  { uk: 'moulds', us: 'molds' },
  { uk: 'moulded', us: 'molded' },
  { uk: 'moulding', us: 'molding' },
  { uk: 'aluminium', us: 'aluminum' },
  { uk: 'ageing', us: 'aging' },
  { uk: 'judgement', us: 'judgment' },
  // One way: the American form is also right in British English, or it is a
  // different word there (savory the herb), so it must not be turned back.
  { uk: 'savoury', us: 'savory', oneWay: true },
  { uk: 'savouries', us: 'savories', oneWay: true },
  { uk: 'yoghurt', us: 'yogurt', oneWay: true },
  { uk: 'yoghurts', us: 'yogurts', oneWay: true },
  { uk: 'grey', us: 'gray', oneWay: true },
  { uk: 'greyish', us: 'grayish', oneWay: true },
  { uk: 'chilli', us: 'chili', oneWay: true },
  { uk: 'chillies', us: 'chilies', oneWay: true },
  // Different words for the same thing. Only the ones that mean exactly one
  // thing — "cornflour" is left alone because it is two things on two sides of
  // the Atlantic, and guessing wrong would change the recipe.
  { uk: 'courgette', us: 'zucchini', oneWay: true },
  { uk: 'courgettes', us: 'zucchini', oneWay: true },
  { uk: 'aubergine', us: 'eggplant', oneWay: true },
  { uk: 'aubergines', us: 'eggplants', oneWay: true },
  { uk: 'caster sugar', us: 'superfine sugar', oneWay: true },
  { uk: 'icing sugar', us: 'powdered sugar', oneWay: true },
  { uk: 'bicarbonate of soda', us: 'baking soda', oneWay: true },
  { uk: 'double cream', us: 'heavy cream', oneWay: true },
  { uk: 'single cream', us: 'light cream', oneWay: true },
  { uk: 'plain flour', us: 'all-purpose flour', oneWay: true },
  { uk: 'self-raising flour', us: 'self-rising flour', oneWay: true },
  { uk: 'prawn', us: 'shrimp', oneWay: true },
  { uk: 'prawns', us: 'shrimp', oneWay: true },
];

/** The lookup table and expression for one direction, built once. */
interface Converter {
  map: Map<string, string>;
  pattern: RegExp;
}

function build(from: 'uk' | 'us'): Converter {
  const to = from === 'uk' ? 'us' : 'uk';
  const map = new Map<string, string>();

  for (const pair of PAIRS) {
    // Turning American into British is allowed only for the two-way pairs.
    if (from === 'us' && pair.oneWay) continue;
    map.set(pair[from], pair[to]);
  }

  const escaped = [...map.keys()]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));

  return { map, pattern: new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi') };
}

const FROM_UK = build('uk');
const FROM_US = build('us');

/** Give the replacement the capitals the original had. */
function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && /[A-Z]{2}/.test(original)) return replacement.toUpperCase();
  if (original[0] === original[0]!.toUpperCase() && original[0] !== original[0]!.toLowerCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * The converter that moves text TOWARD `style`, or null for French, which has
 * no British/American pairs: running the English table over French text would
 * turn "courgette" into "zucchini" and "centre" into "center".
 */
function towards(style: WritingStyle): Converter | null {
  if (style === 'fr') return null;
  return style === 'us' ? FROM_UK : FROM_US;
}

/** Put plain text into the site's spelling. Anything not in the table is returned untouched. */
export function applySpelling(text: string, style: WritingStyle): string {
  const converter = towards(style);
  if (converter === null) return text;
  const { map, pattern } = converter;
  return text.replace(pattern, (match: string, offset: number) => {
    // Earl Grey is a name, not a colour.
    if (/^grey/i.test(match) && /earl\s+$/i.test(text.slice(0, offset))) return match;

    const replacement = map.get(match.toLowerCase().replace(/\s+/g, ' '));
    return replacement === undefined ? match : matchCase(match, replacement);
  });
}

/**
 * The same over HTML, stepping over the tags.
 *
 * A word inside an attribute — a link, an alt text — is left exactly as it was:
 * "correcting" an href breaks the link.
 */
export function applySpellingToHtml(html: string, style: WritingStyle): string {
  return html
    .split(/(<[^>]*>)/)
    .map((part) => (part.startsWith('<') ? part : applySpelling(part, style)))
    .join('');
}

/** Words in `text` that are in the other spelling. Empty once applySpelling has run. */
export function foreignSpellings(text: string, style: WritingStyle): string[] {
  const converter = towards(style);
  if (converter === null) return [];
  const { pattern } = converter;
  const found = new Set<string>();

  for (const match of text.matchAll(pattern)) {
    const word = match[0];
    if (/^grey/i.test(word) && /earl\s+$/i.test(text.slice(0, match.index ?? 0))) continue;
    found.add(word.toLowerCase());
  }
  return [...found];
}

/* -------------------------------------------------------------------------
 * Units
 * ---------------------------------------------------------------------- */

export interface UnitProblem {
  where: string;
  detail: string;
}

/** A temperature as written: 350°F, 200 °C, 140-145°F, 60–63°C. */
const TEMPERATURE = /(\d{2,3}(?:\s?[-–]\s?\d{2,3})?)\s?°\s?([CF])\b/g;

/**
 * Is the text immediately before this match an opening bracket?
 *
 * "(200°C)" is the second figure and is fine; "to 200°C" is the first and, on
 * an American site, is the mistake. Only a bracket directly in front counts, so
 * "bake at 200°C and then (400°F)" is not let through by a bracket further on.
 */
function bracketed(text: string, index: number): boolean {
  // "(about 2 cups)" and "(roughly 8 oz)" are still the second figure.
  return /[([]\s*(?:(?:about|around|roughly|approx\.?|approximately|or|~|≈)\s*)?$/i.test(text.slice(Math.max(0, index - 20), index));
}

/** Temperatures in the wrong scale that are not in brackets. */
export function temperatureProblems(text: string, style: WritingStyle, where: string): UnitProblem[] {
  const wrong = style === 'us' ? 'C' : 'F';
  const primary = style === 'us' ? '°F' : '°C';
  const celsiusOnly = style === 'fr';
  const problems: UnitProblem[] = [];

  for (const match of text.matchAll(TEMPERATURE)) {
    if (match[2] !== wrong) continue;
    // A French site never prints Fahrenheit, so a bracket is no excuse there.
    if (!celsiusOnly && bracketed(text, match.index ?? 0)) continue;
    problems.push({
      where,
      detail: celsiusOnly
        ? `"${match[0].trim()}" is Fahrenheit — this site uses °C only (for example 180 °C), never °F, not even in brackets`
        : `"${match[0].trim()}" is written before any ${primary} figure — this site gives ${primary} first, with the other scale only in brackets after it`,
    });
  }
  return problems;
}

/**
 * An amount in the other system's weight, volume or length.
 *
 * "250 g flour" on an American site, "2 cups" on a British one. Written the
 * wrong way round it is the same mistake as a Celsius oven temperature: the
 * reader has to convert. In brackets after the right figure it is a courtesy,
 * and is left alone.
 */
const FOREIGN_AMOUNT: Record<WritingStyle, RegExp> = {
  fr: /(\d+(?:[.,/]\d+)?(?:\s*[-–]\s*\d+(?:[.,/]\d+)?)?)\s?-?\s?(cups?|oz|ounces?|lbs?|pounds?|inch(?:es)?|sticks?|tbsp|tsp|tablespoons?|teaspoons?)\b/gi,
  us: /(\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?)\s?(g|kg|ml|l|cm|mm)\b(?![\w°])/gi,
  uk: /(\d+(?:[.,/]\d+)?(?:\s*[-–]\s*\d+(?:[.,/]\d+)?)?)\s?-?\s?(cups?|oz|ounces?|lbs?|pounds?|inch(?:es)?)\b/gi,
};

/** Weights, volumes and lengths in the wrong system that are not in brackets. */
export function measureProblems(text: string, style: WritingStyle, where: string): UnitProblem[] {
  const problems: UnitProblem[] = [];

  for (const match of text.matchAll(FOREIGN_AMOUNT[style])) {
    // No bracket exemption in French: US and imperial measures are not used at all.
    if (style !== 'fr' && bracketed(text, match.index ?? 0)) continue;
    problems.push({
      where,
      detail: style === 'fr'
        ? `"${match[0].trim()}" is not a French measure — write metric (g, kg, ml, cl, l, cm) or « c. à soupe » / « c. à café », and no US or imperial figure, not even in brackets`
        : `"${match[0].trim()}" is the wrong system for this site — write ${style === 'us' ? 'US measures (cups, ounces, pounds, inches)' : 'metric measures (grams, millilitres, centimetres)'}, with the other only in brackets after`,
    });
  }
  return problems;
}

/** Ingredient units that belong to the other system. */
const FOREIGN_UNITS: Record<WritingStyle, Set<string>> = {
  fr: new Set(['cup', 'cups', 'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds', 'fl oz', 'stick', 'sticks', 'tbsp', 'tsp', 'tablespoon', 'tablespoons', 'teaspoon', 'teaspoons']),
  us: new Set(['g', 'kg', 'ml', 'l', 'gram', 'grams', 'kilogram', 'kilograms', 'millilitre', 'millilitres', 'milliliter', 'milliliters', 'litre', 'litres', 'liter', 'liters']),
  uk: new Set(['cup', 'cups', 'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds', 'fl oz', 'stick', 'sticks']),
};

/** Ingredient lines whose unit is not the site's. */
export function ingredientUnitProblems(ingredients: unknown, style: WritingStyle): UnitProblem[] {
  if (!Array.isArray(ingredients)) return [];
  const foreign = FOREIGN_UNITS[style];
  const problems: UnitProblem[] = [];

  ingredients.forEach((line, index) => {
    if (line === null || typeof line !== 'object') return;
    const unit = (line as Record<string, unknown>).unit;
    if (typeof unit !== 'string') return;
    if (foreign.has(unit.trim().toLowerCase())) {
      const item = String((line as Record<string, unknown>).item ?? '').trim();
      problems.push({
        where: `ingredients line ${index + 1}`,
        detail: style === 'fr'
          ? `"${unit.trim()}" is not a French unit${item ? ` (${item})` : ''} — this site's ingredient list uses g, kg, ml, cl, l, « c. à soupe », « c. à café » and « pincée »`
          : `"${unit.trim()}" is not a ${style === 'us' ? 'US' : 'metric'} unit${item ? ` (${item})` : ''} — this site's ingredient list uses ${style === 'us' ? 'cups, tablespoons, teaspoons, ounces and pounds' : 'grams, millilitres, teaspoons and tablespoons'}`,
      });
    }
  });
  return problems;
}
