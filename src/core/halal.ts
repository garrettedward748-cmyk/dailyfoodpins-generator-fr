import { get } from '../db/index.js';

/**
 * Halal only: no alcohol and no pork, anywhere the platform writes or plans.
 *
 * Used in four places: keyword research (such searches are dropped), adding
 * keywords and blog questions (refused), a run whose keyword names one
 * (skipped before anything is spent), and the writing prompts (the rule
 * below, so a recipe never adds wine or bacon on its own).
 */

/** Alcohol: drinks, spirits, and dishes named for them. */
const ALCOHOL = [
  'alcohol', 'alcoholic', 'boozy', 'booze', 'spiked', 'tipsy', 'drunken', 'liquor', 'liqueur', 'cocktails?',
  'wine', 'wines', 'beer', 'beers', 'ale', 'lager', 'stout', 'hard cider', 'sake', 'soju', 'mead',
  'rum', 'vodka', 'whiskey', 'whisky', 'bourbon', 'scotch', 'tequila', 'gin', 'brandy', 'cognac', 'mezcal',
  'champagne', 'prosecco', 'sangria', 'mimosas?', 'margaritas?', 'martinis?', 'mojitos?', 'daiquiris?', 'pina colada',
  'eggnog', 'moonshine', 'jello shots?', 'pudding shots?', 'kahlua', 'baileys', 'amaretto', 'limoncello',
  'marsala', 'sherry', 'port wine', 'grand marnier', 'triple sec', 'cointreau', 'schnapps', 'irish cream', 'hard seltzer',
  // Wines and grapes-as-drink, spirits and liqueurs the first list missed.
  'rose wine', 'merlot', 'chardonnay', 'cabernet', 'pinot noir', 'pinot grigio', 'sauvignon blanc', 'riesling', 'malbec',
  'sparkling wine', 'mulled wine', 'gluhwein', 'glühwein', 'cooking wine', 'rice wine', 'shaoxing', 'mirin', 'vermouth', 'madeira',
  'bellini', 'aperol', 'campari', 'negroni', 'hot toddy', 'toddy',
  'irish coffee', 'ipa', 'pilsner', 'hard cider', 'kirsch', 'kirschwasser', 'absinthe', 'ouzo', 'arak', 'raki',
  'cachaca', 'calvados', 'frangelico', 'chambord', 'disaronno', 'creme de menthe', 'crème de menthe', 'creme de cacao', 'crème de cacao',
  'cherry brandy', 'rum extract', 'rum raisin', 'jager', 'jagermeister', 'fireball', 'everclear',
  // More spirits, liqueurs and wines by name.
  'ethanol', 'alcool', 'grain alcohol', 'eau de vie', 'armagnac', 'sambuca', 'chartreuse', 'benedictine', 'drambuie', 'galliano',
  'midori', 'malibu', 'pimms?', 'aquavit', 'akvavit', 'genever', 'pisco', 'grappa', 'slivovitz', 'palinka', 'baijiu', 'shochu',
  'makgeolli', 'zinfandel', 'shiraz', 'syrah', 'moscato', 'sauternes', 'chianti', 'beaujolais', 'tempranillo', 'rioja', 'lambrusco',
  'spumante', 'vin santo', 'retsina', 'vino', 'red wine', 'white wine', 'dessert wine', 'fortified wine', 'wine sauce', 'wine reduction',
  // Beer and brewers' names.
  'pale ale', 'kolsch', 'hefeweizen', 'weissbier', 'witbier', 'guinness', 'heineken', 'budweiser', 'beer batter', 'beer-battered',
  // Cocktails by name.
  'mai tai', 'sazerac', 'gimlet', 'caipirinha', 'tom collins', 'whiskey sour', 'mint julep', 'cuba libre', 'long island iced tea',
  'sidecar', 'bloody mary', 'white russian', 'black russian', 'tequila sunrise', 'amaretto sour', 'sex on the beach', 'espresso martini',
  'liqueurs?', 'spirits-soaked', 'rum-soaked', 'wine-soaked', 'boozy',
];

/** Pork and what is made from it. */
const PORK = [
  'pork', 'pig', 'pigs', 'bacon', 'ham', 'hams', 'prosciutto', 'pancetta', 'guanciale', 'lard', 'chorizo',
  'pepperoni', 'salami', 'bratwurst', 'kielbasa', 'carnitas', 'char siu', 'lechon', 'porchetta', 'pulled pork',
  'baby back ribs', 'spare ribs', 'pork belly', 'crackling', 'chicharron', 'chicharrones',
  'hog', 'hogs', 'gammon', 'lardons?', 'speck', 'jamon', 'capicola', 'coppa', 'mortadella', 'bologna', 'andouille',
  'tasso', 'spam', 'hot dogs?', 'pork rinds?', 'pork sausage', 'italian sausage', 'breakfast sausage', 'pork gelatin', 'suckling pig',
  // More cuts, cured meats and dishes made from pig.
  'swine', 'boar', 'wild boar', 'piglets?', 'pigs? feet', 'pig[’\']s feet', 'trotters', 'pork fat', 'bacon fat', 'bacon grease', 'bacon bits?',
  'fatback', 'salt pork', 'side pork', 'cracklings?', 'pork scratchings', 'jowl', 'nduja', 'soppressata', 'sopressata', 'cotechino',
  'mettwurst', 'blutwurst', 'weisswurst', 'knockwurst', 'liverwurst', 'braunschweiger', 'head cheese', 'scrapple', 'luncheon meat',
  'sobrasada', 'longaniza', 'longganisa', 'sisig', 'tonkotsu', 'lap cheong', 'bak kut teh', 'samgyeopsal', 'tocino', 'cochinita',
  'al pastor', 'chitterlings', 'chitlins', 'rillettes', 'ham hocks?', 'pork chops?', 'pork loin', 'pork shoulder', 'pork butt',
  'tenderloin of pork', 'pork ribs', 'pork mince', 'ground pork', 'minced pork', 'gelatin from pork',
];

/**
 * French alcohol, for the French edition. Kept apart from the English list
 * because the boundaries differ: \\b does not see accents ("bière", "saké",
 * "xérès"), and several English entries are ordinary French words — "saison"
 * (season) was taken out of the English list for that reason.
 */
const ALCOHOL_FR = [
  'alcool', 'alcools', 'alcoolisée?s?', 'vin', 'vins', 'bière', 'bières', 'rhum', 'whisky', 'whiskey', 'vodka', 'gin',
  'tequila', 'cognac', 'armagnac', 'calvados', 'brandy', 'champagne', 'prosecco', 'crémant', 'liqueurs?', 'amaretto',
  'kirsch', 'kirsch', 'grand marnier', 'cointreau', 'limoncello', 'porto', 'xérès', 'madère', 'marsala', 'cidre', 'cidres',
  'pastis', 'anisette', 'absinthe', 'saké', 'mirin', 'sangria', 'mojitos?', 'eau-de-vie', 'eaux-de-vie', 
  'bourbon', 'vermouth', 'martini', 'baileys', '(?:du|un|le|de|verre de) rosé', 'vin cuit', 'vin chaud', 'vin blanc', 'vin rouge',
  'merlot', 'chardonnay', 'cabernet', 'sauvignon', 'pinot', 'cacha[cç]a', 'spiritueux', 'vinasse',
  // Not listed, though they can name a drink: « amer » (bitter), « digestif »
  // (as in biscuits digestifs), « muscat » (a table grape), « rosé » alone (poivre
  // rosé) -- each is far more often an ordinary word in a recipe. « vin muscat »
  // and « vin rosé » are still caught by « vin ».
];

/** French pork and what is made from it. Words that are also "halal" in a halal version are freed by ALLOWED_FR. */
const PORK_FR = [
  'porc', 'porcs', 'cochon', 'cochons', 'cochonnailles?', 'lard', 'lardons?', 'bacon', 'jambons?', 'jambonneau',
  'saucissons?', 'saindoux', 'couennes?', 'rillettes', 'andouilles?', 'andouillettes?', 'boudin noir', 'chorizo',
  'pancetta', 'prosciutto', 'mortadelle', 'sanglier', 'marcassin', 'poitrine fumée', 'poitrine de porc',
  'travers de porc', 'échine de porc', 'palette de porc', 'filet mignon de porc', 'jarret de porc', 'pieds? de porc',
  'queue de cochon', 'gélatine de porc', 'graisse de porc', 'saucisses? de porc', 'saucisses? de toulouse',
  'saucisses? italiennes?', 'pâté de campagne', 'terrine de campagne', 'hot-dogs?', 'jamón', 'pepperoni', 'salami',
];

/** A listed word also matches its plural ("rums", "hogs"): plain words get an optional "s". */
const withPlural = (word: string): string => (/[?|()\[\\]/.test(word) || word.endsWith('s') ? word : `${word}s?`);

/**
 * Whole words only, where "whole" counts accented letters as letters. With \\b,
 * "idéale" and "céréales" held the English "ale" and "pigé" held "pig", because
 * \\b treats é as a break -- and French recipes failed Halal only over beer
 * they never mentioned.
 */
const PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}_])(${[...ALCOHOL, ...PORK].map(withPlural).join('|')})(?![\\p{L}\\p{N}_])`,
  'iu',
);

/** Safe words that contain a listed one ("hamburger", "ginger", "rumble" are fine; \b handles most). */
const ALLOWED = /\b(turkey bacon|beef bacon|chicken bacon|halal bacon|turkey ham|beef ham|halal pepperoni|beef pepperoni|turkey pepperoni|beef salami|halal salami|beef chorizo|chicken chorizo|root beer|ginger ale|ginger beer|butterbeer|hamburgers?|gingerbread|gingers?|graham|hamantaschen|piggyback|apple cider vinegar|cider vinegar|wine vinegar|bourbon vanilla|madagascar bourbon|vanilla bourbon|sparkling (?:apple )?cider|non[\s\-‑–]?alcoholic|alcohol[\s\-‑–]?free|(?:no|zero|0%|without(?: (?:the use of|any|adding|added))?|free (?:of|from)(?: any)?|minus(?: the)?|skip(?:s|ping)? (?:the )?|instead of|in place of|never any|not a drop of|no added|nothing) alcohol|alcohol(?: is)? not (?:needed|required|used)|virgin (?:mojito|colada|margarita|daiquiri|mary)|for (?:the |your |its |their |our )?sake|\w+['’]s? sake|shot glass(?:es)?|espresso shots?|a shot of espresso|pork-free|no pork)\b/gi;

/**
 * French pattern: "no letter next to it" instead of \\b, so accented words are
 * matched whole ("bière" is not found inside "bières-cadeaux" nor "vin" inside
 * "vinaigre"), and the unicode flag so "œ" and "Œ" are the same letter.
 */
const PATTERN_FR = new RegExp(
  `(?<![\\p{L}\\p{N}_])(${[...ALCOHOL_FR, ...PORK_FR].map(withPlural).join('|')})(?![\\p{L}\\p{N}_])`,
  'iu',
);

/** French safe phrases: no-alcohol drinks, vinegars, halal versions of pork products, œufs mimosa. */
const ALLOWED_FR = new RegExp(
  '(?<![\\p{L}\\p{N}_])(?:'
  + 'sans (?:aucune? |une goutte d\'|ajout d\')?(?:alcool|porc|vin|bière)|non[\\s\\-‑–]?alcoolisée?s?|boissons? sans alcool|bières? sans alcool|pas (?:de|d\'|une goutte d\')\\s?(?:porc|alcool)|'
  + 'z[ée]ro (?:%\\s)?(?:d\'\\s?)?alcool|0\\s?% d\'\\s?alcool|aucun alcool|(?:sans|aucune) trace d\'\\s?alcool|au lieu (?:de l\'|d\')\\s?alcool|à la place (?:de l\'|d\')\\s?alcool|(?:libre|exempte?s?) d\'\\s?alcool|'
  + 'vinaigres? de (?:vin(?: blanc| rouge)?|cidre|xérès|riz)|vinaigre balsamique|vanille(?: de madagascar)? bourbon|bourbon vanille|'
  + 'bacon (?:de |d\'|halal)(?:dinde|bœuf|boeuf|poulet|veau)?|jambon (?:de |d\'|halal)(?:dinde|volaille|poulet|bœuf|boeuf)?|'
  + 'lardons? (?:de |d\'|halal)(?:dinde|volaille|poulet|bœuf|boeuf)?|saucissons? (?:de |d\'|halal)(?:dinde|volaille|bœuf|boeuf)?|'
  + 'chorizo (?:de |halal)(?:bœuf|boeuf|poulet|dinde)?|pepperoni (?:de |halal)(?:bœuf|boeuf)?|'
  + '(?:œufs?|oeufs?|salade|gâteau|entremets)\\s+mimosa'
  + ')(?![\\p{L}\\p{N}_])',
  'giu',
);

/**
 * The halal stand-ins the rule itself asks for, in any spelling: "turkey bacon",
 * "turkey-bacon", "beef prosciutto", "chicken sausage", "halal beef pepperoni".
 * Only "turkey bacon"-style pairs written with a space used to pass, so a recipe
 * that did exactly what it was told failed the check.
 */
const ALT_MEAT = '(?:halal|beef|turkey|chicken|veal|lamb|duck|vegan|veggie|vegetarian|plant[\\s\\-‑–]?based|meatless|mushroom|coconut|eggplant|tempeh|smoked turkey|smoked beef|smoked chicken)';
const ALT_PRODUCT = '(?:bacon(?: bits?| strips?| slices?)?|hams?|pepperonis?|salamis?|chorizos?|prosciutto|pancetta|lardons?|sausages?|breakfast sausages?|italian sausages?|hot dogs?|bologna|mortadella|bratwursts?|kielbasa|andouille|jerky|pastrami|ribs)';
const ALTERNATIVE = new RegExp(`\\b(?:halal\\s+)?${ALT_MEAT}(?:[\\s\\-‑–]+${ALT_MEAT})?[\\s\\-‑–]+${ALT_PRODUCT}\\b`, 'gi');

/**
 * A forbidden word named only to say it is not there or is replaced: "no bacon",
 * "without ham", "instead of wine", "in place of the pancetta", "pork-free".
 * The rule tells the model to write "beef bacon instead of bacon", and the old
 * check then refused the recipe for the second word.
 */
const LISTED = [...ALCOHOL, ...PORK].map(withPlural).join('|');
const NAMED_TO_REFUSE = new RegExp(
  `\\b(?:(?:no|without(?: any)?|instead of(?: the| any)?|in place of(?: the)?|rather than(?: the)?|skip(?:s|ping)? the|swap(?:s|ped)? (?:out )?the|replac(?:e|es|ed|ing) the|free (?:of|from)(?: any)?|never)\\s+(?:pork\\s+|regular\\s+|traditional\\s+|classic\\s+|real\\s+|cured\\s+)?(?:${LISTED})|(?:${LISTED})[\\s\\-‑–]free)\\b`,
  'gi',
);

/** French stand-ins: « bacon de dinde », « lardons de volaille », « jambon halal », « chorizo de bœuf ». */
const ALTERNATIVE_FR = new RegExp(
  '(?<![\\p{L}\\p{N}_])(?:bacon|jambons?|lardons?|saucissons?|saucisses?|chorizos?|pepperonis?|salamis?|mortadelle|hot-dogs?|poitrine fumée|pancetta|prosciutto)'
  + '(?:\\s+fum[ée]e?s?)?\\s+(?:halal|(?:de |d\'|à la |au )\\s*(?:dinde|volaille|poulet|bœuf|boeuf|veau|agneau|canard)(?:\\s+halal)?)(?![\\p{L}\\p{N}_])',
  'giu',
);

const LISTED_FR = [...ALCOHOL_FR, ...PORK_FR].map(withPlural).join('|');
/** « sans lardons », « au lieu du vin », « à la place de la pancetta », « remplacez le jambon ». */
const NAMED_TO_REFUSE_FR = new RegExp(
  '(?<![\\p{L}\\p{N}_])(?:sans|pas de|pas d\'|aucune? |au lieu (?:du|de la|des|de l\'|de|d\')|à la place (?:du|de la|des|de l\'|de|d\')|'
  + 'plutôt que (?:du |de la |des |le |la |les |l\')?|rempla[cç](?:ez|er|é|ée|és|ées|ant) (?:le |la |les |l\'))\\s*(?:' + LISTED_FR + ')(?![\\p{L}\\p{N}_])',
  'giu',
);

const clean = (text: string): string =>
  (text ?? '')
    // The known safe phrases first: « bière sans alcool » is one whole phrase,
    // and taking « sans alcool » out of it first would leave « bière » behind.
    .replace(ALLOWED, ' ').replace(ALLOWED_FR, ' ')
    .replace(ALTERNATIVE, ' ').replace(NAMED_TO_REFUSE, ' ')
    .replace(ALTERNATIVE_FR, ' ').replace(NAMED_TO_REFUSE_FR, ' ');

/** The first alcohol or pork word in the text, or null. */
export function haramWord(text: string): string | null {
  const cleaned = clean(text);
  const m = PATTERN.exec(cleaned) ?? PATTERN_FR.exec(cleaned);
  return m ? m[1]!.toLowerCase() : null;
}

/** Every alcohol or pork word in the text, each once, in order of first use. */
export function haramWords(text: string): string[] {
  const cleaned = clean(text);
  const en = [...cleaned.matchAll(new RegExp(PATTERN.source, 'giu'))].map((m) => m[1]!.toLowerCase());
  const fr = [...cleaned.matchAll(new RegExp(PATTERN_FR.source, 'giu'))].map((m) => m[1]!.toLowerCase());
  return [...new Set([...en, ...fr])];
}

/**
 * The first alcohol or pork word anywhere in a written recipe or article (any
 * text, or an object holding text), or null. This is the check on what the
 * model wrote: the rule in the prompt asks, this verifies.
 */
export function haramIn(content: unknown): string | null {
  if (!halalOnly()) return null;
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  // Tags and entities carry no words of their own.
  return haramWord(text.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' '));
}

/** Every alcohol or pork word in a written recipe or article (see haramIn). */
export function haramAllIn(content: unknown): string[] {
  if (!halalOnly()) return [];
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  return haramWords(text.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' '));
}

/**
 * Where each word sits in the text, a few words either side: a rewrite told
 * only "you used bacon" kept missing the one in a FAQ answer or a tip.
 */
export function haramContexts(content: unknown, words: string[], max = 6): string[] {
  const text = (typeof content === 'string' ? content : JSON.stringify(content ?? ''))
    .replace(/<[^>]+>/g, ' ').replace(/\\[nrt"]/g, ' ').replace(/\s+/g, ' ');
  const out: string[] = [];
  for (const word of words) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'giu');
    for (const m of text.matchAll(re)) {
      if (out.length >= max) return out;
      const i = m.index ?? 0;
      out.push(`…${text.slice(Math.max(0, i - 50), i + word.length + 50).trim()}…`);
    }
  }
  return out;
}

export const isHaram = (text: string): boolean => haramWord(text) !== null;

/** Added to every writing prompt when the setting is on. */
export const HALAL_RULE =
  'HALAL ONLY: never use or mention alcohol (no wine, beer, spirits, liqueur, rum, bourbon, cooking wine, mirin or sake) ' +
  'and never pork or pork products (no bacon, ham, lard, pepperoni, gelatin from pork). Use halal alternatives: grape or apple ' +
  'juice or broth instead of wine, beef or turkey bacon instead of bacon, butter or oil instead of lard, halal beef or agar-agar gelatin. ' +
  'In French the same applies: no vin, bière, rhum, cidre, alcool, porc, lard, lardons, bacon, jambon, saucisson or gélatine de porc ' +
  '(« vinaigre de vin » and « sans alcool » are fine).';

/** Setup -> General -> Halal only (on unless switched off). Read live, so a change applies at once. */
export function halalOnly(): boolean {
  try {
    const v = get<{ value: string }>("SELECT value FROM settings WHERE key = 'halal_only'")?.value;
    return v === undefined ? true : v !== 'false';
  } catch {
    return true;
  }
}

/** Split lines into the ones allowed and the ones refused (with the word that refused them). */
export function halalFilter(lines: string[]): { ok: string[]; refused: string[] } {
  if (!halalOnly()) return { ok: lines, refused: [] };
  const ok: string[] = [];
  const refused: string[] = [];
  for (const l of lines) {
    const w = haramWord(l);
    if (w) refused.push(`“${l.trim()}” (${w})`);
    else ok.push(l);
  }
  return { ok, refused };
}
