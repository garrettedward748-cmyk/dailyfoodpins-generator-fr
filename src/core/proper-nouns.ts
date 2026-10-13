/**
 * Proper nouns the model keeps writing in lower case.
 *
 * "these halloween rice krispie treats" shipped twice in five articles. It is
 * not a judgement call — Halloween is a proper noun every time, in every
 * sentence — so it does not belong in a prompt, where a rule is obeyed most of
 * the time. Here it is obeyed always, whatever model wrote the text.
 *
 * Only words that are ALWAYS capitalised go in. A word that is a proper noun
 * in one sense and a common one in another (french in "french fries", turkey
 * the bird, chile the pepper) would do more damage than it repairs, so the
 * list stays narrow on purpose.
 */

import type { WritingStyle } from './writing-style.js';

/**
 * French: only occasions and places. French does not capitalise nationalities
 * or cuisines ("une tajine marocaine", "des pâtes italiennes"), so the English
 * list below must never run over French text. Accents are part of the name:
 * "noel" is left alone rather than guessed at.
 */
const NAMES_FR = [
  'Noël', 'Pâques', 'Halloween', 'Thanksgiving', 'Ramadan', 'Aïd', 'Aïd el-Fitr',
  'Aïd el-Kébir', 'Mawlid', 'Achoura', 'Yennayer', 'Diwali', 'Hanouka', 'Pessah',
  'Nouvel An', 'Saint-Valentin', 'Chandeleur', 'Épiphanie', 'Toussaint',
  'Maghreb', 'Maroc', 'Algérie', 'Tunisie', 'Libye', 'Égypte', 'Liban', 'Syrie',
  'Turquie', 'Italie', 'Espagne', 'Portugal', 'Grèce', 'Mexique', 'Japon',
  'Corée', 'Thaïlande', 'Vietnam', 'Inde', 'France', 'Provence',
  'Bretagne', 'Normandie', 'Alsace',
];
// Left out on purpose: "chine" (a cut of lamb), "paris" (bets), "lyon" and other
// words that are also everyday nouns or are usually written in a longer name.

/** Written exactly like this wherever they appear as a whole word. */
const NAMES = [
  // Occasions. The ones a recipe site writes about all year.
  'Halloween', 'Christmas', 'Thanksgiving', 'Easter', 'Hanukkah', 'Passover',
  'Ramadan', 'Eid', 'Diwali', 'Mardi Gras', 'Lunar New Year', 'New Year',
  // Cuisines and origins. Left out: French, Turkey, Chile, Swiss, Danish and
  // any other word that is also an everyday noun or adjective in a kitchen.
  'Moroccan', 'Algerian', 'Tunisian', 'Libyan', 'Egyptian', 'Lebanese',
  'Syrian', 'Turkish', 'Persian', 'Iranian', 'Iraqi', 'Palestinian',
  'Jordanian', 'Yemeni', 'Saudi', 'Emirati', 'Maghrebi', 'Levantine',
  'Italian', 'Spanish', 'Portuguese', 'Greek', 'Mexican', 'Peruvian',
  'Brazilian', 'Argentinian', 'Japanese', 'Korean', 'Chinese', 'Thai',
  'Vietnamese', 'Indian', 'Pakistani', 'Indonesian', 'Malaysian', 'Filipino',
  'American', 'British', 'Irish', 'Scottish', 'Australian', 'Canadian',
  'German', 'Dutch', 'Belgian', 'Swedish', 'Norwegian', 'Polish', 'Russian',
  'Ethiopian', 'Nigerian', 'Senegalese', 'Mediterranean', 'Cajun', 'Creole',
  'Sicilian', 'Tuscan', 'Provencal', 'Andalusian', 'Bavarian',
];

/**
 * The expression that finds them.
 *
 * Built once. Word boundaries on both sides so "american" inside a longer word
 * is left alone, and the longer names are listed first so "Lunar New Year"
 * wins over the "New Year" inside it. French names carry accents, so the
 * boundary is "no letter next to it" rather than the ASCII-only \\b.
 */
function compile(names: readonly string[]): { pattern: RegExp; correct: Map<string, string> } {
  const escaped = [...names]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return {
    pattern: new RegExp(`(?<![\\p{L}\\p{N}])(${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'giu'),
    correct: new Map(names.map((n) => [n.toLowerCase(), n])),
  };
}

const ENGLISH = compile(NAMES);
const FRENCH = compile(NAMES_FR);

/**
 * Capitalise the names in plain text.
 *
 * Only the ones in the list, and only their own letters: everything else in
 * the string is returned byte for byte, so this can run over text that has
 * already been checked without changing anything else about it.
 *
 * `style` picks the list: French for "fr", the English one otherwise. Left out
 * it is English, as it always was.
 */
export function fixProperNouns(text: string, style: WritingStyle = 'us'): string {
  const { pattern, correct } = style === 'fr' ? FRENCH : ENGLISH;
  return text.replace(pattern, (match) => correct.get(match.toLowerCase()) ?? match);
}

/**
 * The same, over HTML, leaving the markup alone.
 *
 * Tags are stepped over rather than parsed: a name inside an attribute — a
 * URL, an alt text, a class — must not be touched, because a link whose href
 * has been "corrected" is a broken link. Splitting on tags is enough for that
 * and cannot itself corrupt the markup, which a replace across the whole
 * string could.
 */
export function fixProperNounsInHtml(html: string, style: WritingStyle = 'us'): string {
  return html
    .split(/(<[^>]*>)/)
    .map((part) => (part.startsWith('<') ? part : fixProperNouns(part, style)))
    .join('');
}

/** The names, for a test or a settings page to show. */
export const PROPER_NOUNS: readonly string[] = NAMES;
export const PROPER_NOUNS_FR: readonly string[] = NAMES_FR;
