import { parseJson } from '../pipeline/json.js';
import type { ReelFormat } from './formats.js';

/**
 * The storyboard for one reel: what the model writes, and what is checked
 * before anything is spent on it.
 */

export type SourceRole = 'hero' | 'stepA' | 'stepB' | 'stepC' | 'pin';

/** The length of one clip Flow produces on the reel path. */
export const CLIP_SECONDS = 10;
const MAX_LINE_WORDS = 22;

export interface PlannedScene {
  seconds: number;
  /** Which of the article's images this scene is filmed from, by role. */
  sources: SourceRole[];
  presenter: boolean;
  /** Fresh-image mode only: what the frame shows. */
  image: string;
  /** What physically happens over the clip. */
  motion: string;
  /** What the presenter says; empty for cooking sound only. */
  line: string;
}

export interface ReelPlan {
  format: string;
  hook: string;
  scenes: PlannedScene[];
  cta: string;
}

/** Clips are ten seconds; a length that does not divide rounds up rather than short. */
export const scenesFor = (targetSeconds: number): number =>
  Math.min(6, Math.max(2, Math.ceil(targetSeconds / CLIP_SECONDS)));

interface Rules {
  sources: SourceRole[];
  hasPresenter: boolean;
  targetSeconds: number;
  format: ReelFormat;
}

/**
 * Check a plan before anything is spent on it.
 *
 * Every rule here is one the model was told; this is what happens when it
 * did not listen. The error is a sentence, because it lands on the reel page.
 */
export function validatePlan(raw: unknown, rules: Rules): ReelPlan {
  const plan = (raw ?? {}) as Partial<ReelPlan>;
  const scenes = Array.isArray(plan.scenes) ? (plan.scenes as Partial<PlannedScene>[]) : [];
  const wanted = scenesFor(rules.targetSeconds);

  if (scenes.length < 2 || scenes.length > 6) {
    throw new Error(`The plan has ${scenes.length} scene(s); a reel has between 2 and 6.`);
  }
  if (Math.abs(scenes.length - wanted) > 1) {
    throw new Error(
      `The plan has ${scenes.length} scenes, but ${rules.targetSeconds} seconds is ${wanted}.`,
    );
  }

  const cta = String(plan.cta ?? '').trim();
  const out: PlannedScene[] = scenes.map((s, i) => {
    const n = i + 1;
    // A name the article has no photo for is dropped, not fatal: the model
    // sometimes reaches for a prompt it saw in the recipe rather than a
    // photograph on the list. A scene left with nothing films from the
    // feature image, which every article has.
    const named = (Array.isArray(s.sources) ? s.sources : []).map(String) as SourceRole[];
    let sources = named.filter((src) => rules.sources.includes(src));
    if (sources.length === 0) {
      const fallback = rules.sources.includes('hero') ? 'hero' : rules.sources[0];
      if (!fallback) throw new Error(`Scene ${n} names no image to film from.`);
      sources = [fallback];
    }

    const line = String(s.line ?? '').trim();
    if (line.split(/\s+/).filter(Boolean).length > MAX_LINE_WORDS) {
      throw new Error(
        `Scene ${n}'s line is longer than ${MAX_LINE_WORDS} words; it cannot be said in ten seconds.`,
      );
    }
    if (!rules.format.speech && line) {
      throw new Error(`The ${rules.format.title} format has no speech, but scene ${n} has a line.`);
    }

    // A presenter in a reel that has none is a flag the model ticked, not a
    // person it can film: cleared, and the scene shows the dish.
    const presenter =
      Boolean(s.presenter) && rules.hasPresenter && rules.format.presenter !== 'never';

    const motion = String(s.motion ?? '').trim();
    if (!motion) throw new Error(`Scene ${n} does not say what happens in it.`);

    return {
      seconds: CLIP_SECONDS,
      sources: sources.slice(0, 3),
      presenter,
      image: String(s.image ?? '').trim(),
      motion,
      line,
    };
  });

  if (rules.hasPresenter && rules.format.presenter !== 'never' && !out.some((s) => s.presenter)) {
    throw new Error('The page has a presenter, but no scene puts them in the reel.');
  }

  const last = out[out.length - 1]!;
  if (rules.format.speech && cta && !last.line.toLowerCase().includes(cta.toLowerCase().slice(0, 12))) {
    throw new Error('The last scene has to carry the call to action.');
  }

  return { format: rules.format.key, hook: String(plan.hook ?? '').trim(), scenes: out, cta };
}

export async function planReel(input: {
  prompt: (name: string, vars: Record<string, unknown>) => Promise<{ content: string }>;
  article: { title: string; recipe: string; imagePrompts: Record<string, string> };
  sources: SourceRole[];
  presenter: { name: string; voice: string } | null;
  targetSeconds: number;
  format: ReelFormat;
  cta?: string;
}): Promise<ReelPlan> {
  const cta = input.cta?.trim() || 'La recette complète sur notre site';
  const vars = {
    article: {
      title: input.article.title,
      recipe: input.article.recipe,
      // Only the photographs that exist. The article writes prompts for
      // more images than it generates, and a name shown here is a name the
      // model will film from.
      imagePrompts: Object.entries(input.article.imagePrompts)
        .filter(([role]) => input.sources.includes(role as SourceRole))
        .map(([role, text]) => `${role}: ${text}`)
        .join('\n'),
    },
    sources: input.sources.join(', '),
    presenter: input.presenter ?? { name: 'nobody', voice: 'there is no presenter in this reel' },
    format: { key: input.format.key, title: input.format.title, shape: input.format.shape },
    scenes: scenesFor(input.targetSeconds),
    targetSeconds: input.targetSeconds,
    cta,
    note: '',
  };
  const rules: Rules = {
    sources: input.sources,
    hasPresenter: input.presenter !== null,
    targetSeconds: input.targetSeconds,
    format: input.format,
  };

  // A plan the rules refuse costs nothing yet, so the model gets one more
  // go with the refusal in front of it before the reel is failed.
  const first = await input.prompt('reel-plan', vars);
  try {
    return validatePlan(parseJson(first.content, 'the reel plan'), rules);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const second = await input.prompt('reel-plan', {
      ...vars,
      note: `Your previous storyboard was refused: ${why} Fix that and answer again with the full JSON.`,
    });
    return validatePlan(parseJson(second.content, 'the reel plan'), rules);
  }
}

/* -------------------------------------------------------------------------
 * Process reels: hands only, one kitchen, the recipe in quick shots
 * ---------------------------------------------------------------------- */

/** Shots in a process reel: one hook, then the method. */
export const PROCESS_SHOTS = 8;
const CAMERAS = ['overhead', 'close-up at 45 degrees', 'side close-up at table level'];

export interface ProcessShot {
  camera: string;
  action: string;
  sources: SourceRole[];
}

export interface ProcessPlan {
  /** The set, word for word in every clip: what keeps eight clips -- and any account -- one video. */
  style: string;
  shots: ProcessShot[];
}

export function validateProcess(raw: unknown, sources: SourceRole[], count = PROCESS_SHOTS): ProcessPlan {
  const plan = (raw ?? {}) as { style?: unknown; shots?: unknown };
  const style = String(plan.style ?? '').replace(/\s+/g, ' ').trim();
  if (style.split(' ').length < 20) throw new Error('The plan has no description of the kitchen to keep every shot the same.');
  const shots = Array.isArray(plan.shots) ? (plan.shots as Record<string, unknown>[]) : [];
  if (shots.length !== count) throw new Error(`The plan has ${shots.length} shots; it needs exactly ${count}.`);
  const method = sources.filter((s) => s !== 'hero' && s !== 'pin');
  return {
    style,
    shots: shots.map((s, i) => {
      const action = String(s.action ?? '').replace(/\s+/g, ' ').trim();
      if (action.split(' ').length < 6) throw new Error(`Shot ${i + 1} does not say what the hands do.`);
      const camera = CAMERAS.includes(String(s.camera)) ? String(s.camera) : CAMERAS[i % CAMERAS.length]!;
      let named = (Array.isArray(s.sources) ? s.sources.map(String) : []).filter((r) => sources.includes(r as SourceRole)) as SourceRole[];
      if (named.length === 0) {
        // The hook is the finished dish; the method spreads over the method photos in order.
        const guess = i === 0 || method.length === 0 ? 'hero' : method[Math.min(method.length - 1, Math.floor(((i - 1) * method.length) / (count - 1)))]!;
        named = sources.includes(guess) ? [guess] : [sources[0]!];
      }
      return { camera, action, sources: named.slice(0, 2) };
    }),
  };
}

/**
 * The prompt one process clip is filmed from. Everything that makes it
 * match the others is in the words -- the same set description every time --
 * so a clip made on another Google account still fits.
 */
export function processClipPrompt(plan: ProcessPlan, index: number, dish: string, chained: boolean): string {
  const shot = plan.shots[index]!;
  return [
    chained
      ? 'The clip opens exactly on the reference image, frame for frame: the same bowl or pan, the same food in it, the same hands, the same countertop, the same light and camera position. Nothing in the scene changes or is replaced; the action simply continues from that moment.'
      : '',
    `${plan.style}`,
    `${shot.camera[0]!.toUpperCase()}${shot.camera.slice(1)} shot of ${dish}. ${shot.action}`,
    'The action is already happening in the first second and continues at natural real-time speed. Only the hands and forearms are visible, never a face.',
    'Vertical 9:16, sharp focus, natural colours. No text, no captions, no speech, no music: only natural cooking sounds.',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function planProcess(input: {
  prompt: (name: string, vars: Record<string, unknown>) => Promise<{ content: string }>;
  article: { title: string; recipe: string; imagePrompts: Record<string, string> };
  sources: SourceRole[];
  count?: number;
}): Promise<ProcessPlan> {
  const count = input.count ?? PROCESS_SHOTS;
  const roleKey: Record<string, string> = { hero: 'hero', stepA: 'step_a', stepB: 'step_b', stepC: 'step_c' };
  const vars = {
    title: input.article.title,
    recipe: input.article.recipe.slice(0, 8000),
    photos: input.sources
      .filter((r) => r !== 'pin')
      .map((r) => `${r}: ${input.article.imagePrompts[roleKey[r] ?? r] ?? input.article.imagePrompts[r] ?? ''}`)
      .join('\n'),
    sources: input.sources.filter((r) => r !== 'pin').join(', '),
    count,
    note: '',
  };
  const first = await input.prompt('reel-process', vars);
  try {
    return validateProcess(parseJson(first.content, 'the reel shots'), input.sources, count);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const second = await input.prompt('reel-process', {
      ...vars,
      note: `Your previous answer was refused: ${why} Fix that and answer again with the full JSON.`,
    });
    return validateProcess(parseJson(second.content, 'the reel shots'), input.sources, count);
  }
}
