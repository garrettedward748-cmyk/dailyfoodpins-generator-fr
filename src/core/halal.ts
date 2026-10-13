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
  'pale ale', 'kolsch', 'hefeweizen', 'weissbier', 'witbier', 'saison', 'guinness', 'heineken', 'budweiser', 'beer batter', 'beer-battered',
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

/** A listed word also matches its plural ("rums", "hogs"): plain words get an optional "s". */
const withPlural = (word: string): string => (/[?|()\[\\]/.test(word) || word.endsWith('s') ? word : `${word}s?`);

const PATTERN = new RegExp(`\\b(${[...ALCOHOL, ...PORK].map(withPlural).join('|')})\\b`, 'i');

/** Safe words that contain a listed one ("hamburger", "ginger", "rumble" are fine; \b handles most). */
const ALLOWED = /\b(turkey bacon|beef bacon|chicken bacon|halal bacon|turkey ham|beef ham|halal pepperoni|beef pepperoni|turkey pepperoni|beef salami|halal salami|beef chorizo|chicken chorizo|root beer|ginger ale|ginger beer|butterbeer|hamburgers?|gingerbread|gingers?|graham|hamantaschen|piggyback|apple cider vinegar|cider vinegar|wine vinegar|bourbon vanilla|madagascar bourbon|vanilla bourbon|sparkling (?:apple )?cider|non-alcoholic|alcohol-free|without (?:the use of )?alcohol|no alcohol|alcohol free|virgin (?:mojito|colada|margarita|daiquiri|mary)|for (?:the |your |its |their |our )?sake|\w+['’]s? sake|shot glass(?:es)?|espresso shots?|a shot of espresso|pork-free|no pork)\b/gi;

/** The first alcohol or pork word in the text, or null. */
export function haramWord(text: string): string | null {
  const cleaned = (text ?? '').replace(ALLOWED, ' ');
  const m = PATTERN.exec(cleaned);
  return m ? m[1]!.toLowerCase() : null;
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

export const isHaram = (text: string): boolean => haramWord(text) !== null;

/** Added to every writing prompt when the setting is on. */
export const HALAL_RULE =
  'HALAL ONLY: never use or mention alcohol (no wine, beer, spirits, liqueur, rum, bourbon, cooking wine, mirin or sake) ' +
  'and never pork or pork products (no bacon, ham, lard, pepperoni, gelatin from pork). Use halal alternatives: grape or apple ' +
  'juice or broth instead of wine, beef or turkey bacon instead of bacon, butter or oil instead of lard, halal beef or agar-agar gelatin.';

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
