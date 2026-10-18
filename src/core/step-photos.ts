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
