import { parseJson } from '../pipeline/json.js';

/**
 * Planning the photo collage: breaking one recipe into N still-photograph
 * prompts, the still-photo cousin of `planProcess` in reels/plan.ts.
 *
 * A reel's shots describe motion a video model films; a collage's shots are
 * one still frame each -- ingredients laid out, a bowl mid-mix, batter
 * poured, the pan going into the oven, the finished dish plated -- so the
 * model is asked for a plain sentence of what the camera sees, not an
 * action that keeps going.
 */

export interface CollageShot {
  /** What the still photograph shows, written as an image-generation prompt. */
  description: string;
}

export interface CollagePlan {
  shots: CollageShot[];
}

/**
 * Check the model's answer before anything is spent generating from it.
 *
 * Only the shape is enforced -- exactly `count` shots, each with real text --
 * same philosophy as validateProcess: catch the model skipping the brief,
 * not second-guess its photography.
 */
export function validateCollagePlan(raw: unknown, count: number): CollagePlan {
  const plan = (raw ?? {}) as { shots?: unknown };
  const shots = Array.isArray(plan.shots) ? (plan.shots as Record<string, unknown>[]) : [];
  if (shots.length !== count) {
    throw new Error(`The plan has ${shots.length} shots; it needs exactly ${count}.`);
  }
  return {
    shots: shots.map((s, i) => {
      const description = String(s.description ?? '').replace(/\s+/g, ' ').trim();
      if (description.split(' ').length < 6) {
        throw new Error(`Shot ${i + 1} does not say what the photograph shows.`);
      }
      return { description };
    }),
  };
}

/**
 * Ask the model for `count` still-photograph prompts covering this recipe
 * from ingredients to finished dish, the way a process collage like the
 * reference image lays itself out.
 *
 * Same two-try shape as planReel/planProcess: a plan the validator refuses
 * costs nothing in image credits, so the model gets one corrected attempt
 * before the collage step gives up on it.
 */
export async function planCollageSteps(input: {
  prompt: (name: string, vars: Record<string, unknown>) => Promise<{ content: string }>;
  title: string;
  recipe: string;
  count: number;
}): Promise<CollagePlan> {
  const vars = {
    title: input.title,
    recipe: input.recipe.slice(0, 8000),
    count: input.count,
    note: '',
  };

  const first = await input.prompt('collage-steps', vars);
  try {
    return validateCollagePlan(parseJson(first.content, 'the collage shots'), input.count);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const second = await input.prompt('collage-steps', {
      ...vars,
      note: `Your previous answer was refused: ${why} Fix that and answer again with the full JSON.`,
    });
    return validateCollagePlan(parseJson(second.content, 'the collage shots'), input.count);
  }
}
