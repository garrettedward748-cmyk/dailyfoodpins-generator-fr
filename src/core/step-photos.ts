/**
 * How many steps of the method get their own photograph
 * (Setup -> Rotation -> Photo styles, one setting for every site).
 *
 * The image-prompts step always chooses three moments (stepA, stepB, stepC).
 * Anything above three is "extra": chosen here, in code, from the steps the
 * three left without a picture, then given prompts by a second, small model
 * call. Keeping the original three untouched means a site's edited
 * image-prompts prompt, the reels, the collage and the shared-image cache all
 * keep working exactly as before.
 */

export type StepPhotoMode = '3' | '5' | 'all';

export const STEP_PHOTO_MODES: readonly StepPhotoMode[] = ['3', '5', 'all'];

/** The recipe JSON never has more than ten steps; this caps "all" anyway. */
export const MAX_METHOD_PHOTOS = 10;

export function parseStepPhotoMode(value: string | undefined | null): StepPhotoMode {
  const v = String(value ?? '').trim().toLowerCase();
  return (STEP_PHOTO_MODES as readonly string[]).includes(v) ? (v as StepPhotoMode) : '3';
}

/**
 * Number of steps in the recipe JSON: `step_1` … `step_10`, where the unused
 * ones are empty strings. A `steps` array (an edited recipe prompt) counts too.
 */
export function recipeStepCount(recipe: Record<string, unknown>): number {
  if (Array.isArray(recipe.steps)) {
    return recipe.steps.filter((s) => s !== null && s !== undefined && String(typeof s === 'object' ? JSON.stringify(s) : s).trim() !== '').length;
  }
  let last = 0;
  for (const [key, value] of Object.entries(recipe)) {
    const match = /^step_(\d+)$/.exec(key);
    if (match && typeof value === 'string' && value.trim() !== '') last = Math.max(last, Number(match[1]));
  }
  return last;
}

/** The step text the extra prompt is written from (1-based), or ''. */
export function recipeStepText(recipe: Record<string, unknown>, step: number): string {
  if (Array.isArray(recipe.steps)) {
    const s = recipe.steps[step - 1];
    if (s && typeof s === 'object') {
      const o = s as Record<string, unknown>;
      return String(o.body ?? o.text ?? o.heading ?? '').trim();
    }
    return typeof s === 'string' ? s.trim() : '';
  }
  const value = recipe[`step_${step}`];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Which further steps get a photograph, on top of the three the model chose.
 *
 *  - '3'   nothing.
 *  - '5'   two more (fewer on a short recipe), spread as far as possible from
 *          the photographed steps. The last step is left out while there is
 *          any other choice: it is the serving step, which the hero shows.
 *  - 'all' every step without one, the last included.
 *
 * Returned ascending, 1-based.
 */
export function extraStepNumbers(mode: StepPhotoMode, stepCount: number, chosen: number[]): number[] {
  if (mode === '3' || stepCount <= 0) return [];

  const taken = new Set(
    chosen.map((n) => Math.trunc(Number(n))).filter((n) => Number.isInteger(n) && n >= 1 && n <= stepCount),
  );
  const free = Array.from({ length: stepCount }, (_, i) => i + 1).filter((n) => !taken.has(n));

  if (mode === 'all') return free.slice(0, Math.max(0, MAX_METHOD_PHOTOS - taken.size));

  const wanted = Math.max(0, Math.min(5, stepCount) - taken.size);
  const picked: number[] = [];
  const preferred = free.filter((n) => n !== stepCount);

  for (const pool of [preferred, free]) {
    while (picked.length < wanted) {
      const options = pool.filter((n) => !picked.includes(n));
      if (options.length === 0) break;
      const anchors = [...taken, ...picked];
      let best = options[0]!;
      let bestGap = -1;
      for (const n of options) {
        const gap = anchors.length === 0 ? 0 : Math.min(...anchors.map((a) => Math.abs(a - n)));
        if (gap > bestGap) { best = n; bestGap = gap; }
      }
      picked.push(best);
    }
  }

  return picked.sort((a, b) => a - b);
}

/** Every non-empty step of the recipe JSON, in order (`step_1` … or a `steps` array). */
export function recipeStepTexts(recipe: Record<string, unknown>): string[] {
  const count = recipeStepCount(recipe);
  return Array.from({ length: count }, (_, i) => recipeStepText(recipe, i + 1));
}

// Words that say nothing about which step a sentence belongs to, in the two
// languages the generators write in.
const STOP_WORDS = new Set((
  'the and for with into onto from until each your you then this that them they its are was over under '
  + 'about minutes minute min hour hours when while add les des une pour avec dans sur puis '
  + 'votre vous pendant jusqu minutes heure heures ajoutez ajouter bien tout tous toute toutes est sont'
).split(' '));

function stem(word: string): string {
  // Crude on purpose: enough for "slices"/"sliced"/"slice" to meet.
  return word.replace(/(ing|ed|es|s|e)$/, '');
}

function words(text: string): Set<string> {
  const plain = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const out = new Set<string>();
  for (const w of plain.split(/[^a-z]+/)) {
    if (w.length < 3 || STOP_WORDS.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

/** How much two step texts share, 0 … 1. */
export function stepSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.sqrt(wa.size * wb.size);
}

/**
 * For each recipe step, the article step that tells the same moment
 * (both 0-based).
 *
 * The article is written from the recipe but not always step for step: it
 * may merge "heat the grill" and "grill the steak" into one, or split one in
 * two. The photographs are drawn for recipe steps, so putting them on the
 * article step with the same number shifts every photograph after such a
 * merge one step late. This keeps the order (a later recipe step never maps
 * to an earlier article step) and picks the mapping whose texts agree most,
 * with a slight preference for the same relative position to settle ties.
 */
export function alignRecipeToArticle(recipe: string[], article: string[]): number[] {
  const r = recipe.length;
  const a = article.length;
  if (r === 0 || a === 0) return [];

  const score = (i: number, j: number) =>
    stepSimilarity(recipe[i]!, article[j]!)
    - 0.05 * Math.abs((r === 1 ? 0 : i / (r - 1)) - (a === 1 ? 0 : j / (a - 1)));

  // best[i][j]: the best total for recipe steps 0..i with step i on article j.
  const best: number[][] = Array.from({ length: r }, () => new Array<number>(a).fill(-Infinity));
  const from: number[][] = Array.from({ length: r }, () => new Array<number>(a).fill(-1));
  for (let j = 0; j < a; j++) best[0]![j] = score(0, j);
  for (let i = 1; i < r; i++) {
    let runMax = -Infinity;
    let runArg = -1;
    for (let j = 0; j < a; j++) {
      if (best[i - 1]![j]! > runMax) { runMax = best[i - 1]![j]!; runArg = j; }
      best[i]![j] = runMax + score(i, j);
      from[i]![j] = runArg;
    }
  }

  let j = 0;
  for (let k = 1; k < a; k++) if (best[r - 1]![k]! > best[r - 1]![j]!) j = k;
  const map = new Array<number>(r);
  for (let i = r - 1; i >= 0; i--) {
    map[i] = j;
    j = from[i]![j]!;
  }
  return map;
}
