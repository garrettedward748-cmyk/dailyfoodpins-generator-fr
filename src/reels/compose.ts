import { join } from 'node:path';
import type { ArticleImages } from '../pipeline/steps/images.js';
import { getCompletedStep } from '../db/repos.js';
import { loadTemplate } from '../pipeline/prompts.js';
import { reelShape } from '../core/reel-structures.js';
import { resolveDataDir } from '../config.js';
import type { Settings } from '../settings.js';
import type { SourceRole } from './plan.js';

/**
 * The ways a reel can be made. Setup -> Reels picks one.
 *   single: one Flow clip, ten seconds.
 *   hands:  one Flow clip too, but written as one continuous hands-only take --
 *           prep to plate in about twenty seconds, no voice, no text. One clip's
 *           credits, because it is still one generation, just a longer one.
 *   mixed:  the same ten-second clip, then the article's method photos with
 *           their steps written on them and an end card -- about twenty
 *           seconds, one clip's credits.
 *   scenes: a storyboard of clips filmed one by one and joined.
 *   didyouknow: one Flow clip written per recipe in the "Did you know" shape
 *           the most-watched recipe reels share: hands already moving on the
 *           ingredients, a curiosity line, the method, the first bite, no call
 *           to action. The platform writes the voice on screen word by word.
 *   process: hands only, one kitchen, the recipe from raw to done in eight
 *            quick shots, each its own Flow generation filmed from the last
 *            frame of the one before -- eight clips' credits, about half an hour.
 */
export type ReelMode = 'single' | 'hands' | 'mixed' | 'scenes' | 'process' | 'didyouknow';

export function reelMode(settings: Settings): ReelMode {
  const mode = settings.get('reel_mode');
  return mode === 'scenes' || mode === 'mixed' || mode === 'process' || mode === 'hands' || mode === 'didyouknow'
    ? mode
    : 'single';
}

/** Modes made of several clips: planned, filmed scene by scene, then joined. */
export const isStudioMode = (mode: ReelMode): boolean => mode === 'scenes' || mode === 'process';

/** A mixed reel starts as a single clip; what it needs after is kept in plan_json. */
export interface MixedSeed extends ReelSeed {
  mixed: true;
  /** Filled in once the clip is down: where it was saved. */
  clipPath?: string;
}

/** True once the reel's video_url points at its finished copy on the site, not at Flow's raw clip. */
export const isFinishedSeed = (planJson: string | null | undefined): boolean => {
  try {
    return Boolean((JSON.parse(planJson || '{}') as { finished?: boolean }).finished);
  } catch {
    return false;
  }
};

/** True for a "Did you know" reel: its voice is written on screen, word by word, before it goes out. */
export const isDidYouKnowSeed = (planJson: string | null | undefined): boolean => {
  try {
    return Boolean((JSON.parse(planJson || '{}') as { didYouKnow?: boolean }).didYouKnow);
  } catch {
    return false;
  }
};

export const isMixedSeed = (planJson: string | null | undefined): boolean => {
  try {
    return Boolean((JSON.parse(planJson || '{}') as { mixed?: boolean }).mixed);
  } catch {
    return false;
  }
};

/** The article images a single-clip reel is filmed from, in order. */
export const ARTICLE_ROLES = ['hero', 'stepA', 'stepB', 'stepC'] as const;
export type ArticleRole = (typeof ARTICLE_ROLES)[number];

/** Flow takes at most this many photos in one request. */
export const MAX_REFERENCES = 3;

/**
 * How many separate boxes Setup -> Reels offers for music links.
 *
 * One box with everything pasted in worked, but got unwieldy once it held
 * dozens of links from several Pixabay downloading sessions -- several
 * smaller boxes are easier to keep straight and to come back and add to.
 * Each box still takes as many links, one per line, as a person wants to
 * paste into it; a reel draws from all of them pooled together.
 */
export const MUSIC_SLOTS = 6;

/** The setting key for one music box. Slot 1 keeps the original key, so links already saved there are not lost. */
export function musicSlotKey(slot: number): string {
  return slot <= 1 ? 'reel_music_urls' : `reel_music_urls_${slot}`;
}

/** Every link from every box, one per line, for pickMusic to choose from. */
export function allMusicUrls(settings: Settings): string {
  return Array.from({ length: MUSIC_SLOTS }, (_, i) => settings.get(musicSlotKey(i + 1)))
    .filter(Boolean)
    .join('\n');
}

/**
 * Where a song uploaded from someone's own computer is kept.
 *
 * A music box takes a pasted link just as well as an uploaded file, so an
 * upload is recorded as one more line in the box -- `local:<name>` instead
 * of `https://...` -- pointing at a file in this folder rather than out on
 * the web. pickMusic and the reel engine both know the `local:` form.
 */
export function musicUploadsDir(): string {
  return join(resolveDataDir(), 'music');
}

/** The on-disk path for a line already known to be a `local:` reference. */
export function localMusicPath(line: string): string {
  return join(musicUploadsDir(), line.slice('local:'.length));
}

/** True for a music-box line that points at an uploaded file rather than a URL. */
export function isLocalMusicLine(line: string): boolean {
  return line.startsWith('local:');
}

/**
 * Which article photos a single-clip reel sends, as set on Setup -> Reels.
 * Unknown names are dropped; an empty or unreadable setting means the
 * first three, which is what the template was written against.
 */
export function singleReferenceRoles(settings: Settings): ArticleRole[] {
  let roles: ArticleRole[] = [];
  try {
    const parsed = JSON.parse(settings.get('reel_single_references') || '[]') as unknown;
    if (Array.isArray(parsed)) {
      roles = parsed.filter((r): r is ArticleRole => ARTICLE_ROLES.includes(r as ArticleRole));
    }
  } catch {
    roles = [];
  }
  if (roles.length === 0) roles = ['hero', 'stepA', 'stepB'];
  return roles.slice(0, MAX_REFERENCES);
}

/** The chosen article photos as absolute urls, in the order given. */
export function referenceUrls(host: string, images: ArticleImages, roles: readonly ArticleRole[]): string[] {
  return roles.map((role) => (/^https?:\/\//i.test(images[role]) ? images[role] : `https://${host}${images[role]}`));
}

/**
 * The single-clip video prompt.
 *
 * A template rather than a model call: on the composer a person edits it
 * before anything is generated, and the pipeline sends it as it is. The
 * presenter's name and voice go in when the page has one, so the clip is
 * spoken by the same person every reel.
 */
export function buildReelPrompt(c: {
  title: string;
  presenter: { name: string; voice: string } | null;
  cta: string;
  /** The scenes, from Setup -> Reel structures. Absent means the ones the template always had. */
  shape?: string;
}): string {
  return loadTemplate('reel-video.template.txt', {
    reelShape: c.shape?.trim() || reelShape(null),
    seo: { title: c.title },
    presenter: c.presenter ?? {
      name: 'A warm adult female food-creator voice',
      voice: 'friendly, unhurried, enthusiastic',
    },
    cta: c.cta || 'La recette complète sur notre site',
  });
}

/** How many ingredients the recipe lists, or null when it cannot be told. */
export function ingredientCount(recipe: string): number | null {
  let data: unknown;
  try {
    data = JSON.parse(recipe);
  } catch {
    return null;
  }
  const seen = new Set<unknown>();
  const find = (node: unknown): number | null => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.ingredients)) {
      return o.ingredients.filter((x) => x && (typeof x !== 'object' || !Array.isArray((x as { items?: unknown }).items))).length
        + o.ingredients.reduce<number>((n, x) => n + (x && typeof x === 'object' && Array.isArray((x as { items?: unknown[] }).items) ? (x as { items: unknown[] }).items.length : 0), 0);
    }
    const numbered = Object.keys(o).filter((k) => /^ingredient_\d+$/.test(k) && String(o[k] ?? '').trim() !== '');
    if (numbered.length > 0) return numbered.length;
    for (const v of Object.values(o)) {
      const n = find(v);
      if (n !== null) return n;
    }
    return null;
  };
  const n = find(data);
  return n && n > 0 ? n : null;
}

const NUMBER_WORDS: Record<string, number> = {
  deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12,
};

export interface DidYouKnowPlan {
  dish: string;
  shots: [string, string, string];
  voiceover: string;
}

/**
 * Check what the model planned. Every rule here is one the prompt states;
 * the error is the sentence the model is shown when it asks again.
 */
export function validateDidYouKnow(raw: unknown, ingredients: number | null): DidYouKnowPlan {
  const o = (raw ?? {}) as Record<string, unknown>;
  const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const words = (t: string) => t.split(' ').filter(Boolean).length;

  const dish = clean(o.dish).replace(/[."]+$/, '');
  if (!dish || words(dish) > 6) throw new Error('"dish" must be the everyday name in 2 to 5 words.');

  const shots = Array.isArray(o.shots) ? o.shots.map(clean).filter(Boolean) : [];
  if (shots.length !== 3) throw new Error(`There must be exactly three shots; there were ${shots.length}.`);
  shots.forEach((shot, i) => {
    if (words(shot) > 30) throw new Error(`Shot ${i + 1} is ${words(shot)} words; at most 25, one action.`);
  });

  const voiceover = clean(o.voiceover).replace(/^["“«]\s*|\s*["”»]$/g, '');
  if (!/^vous saviez que\b/i.test(voiceover)) throw new Error('The voiceover must start with « Vous saviez que ».');
  const n = words(voiceover);
  if (n < 14 || n > 30) throw new Error(`The voiceover is ${n} words; it must be 16 to 26.`);

  // "only three ingredients" when the recipe has eight is the one claim a
  // viewer checks -- and the reel loses them when it is wrong.
  const said = /(?:^|[^\p{L}])(\d+|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze)[ -]ingrédients?(?![\p{L}])/iu.exec(voiceover);
  if (said) {
    const claimed = /^\d+$/.test(said[1]!) ? Number(said[1]) : NUMBER_WORDS[said[1]!.toLowerCase()]!;
    if (ingredients === null || claimed !== ingredients) {
      throw new Error(
        ingredients === null
          ? 'Do not say a number of ingredients.'
          : `The voiceover says ${claimed} ingredients; the recipe has ${ingredients}. Say ${ingredients} or leave the number out.`,
      );
    }
  }
  return { dish, shots: shots as [string, string, string], voiceover };
}

/** The prompt sent to Flow, in the shape that came out right: three timed shots and a named voice. */
export function didYouKnowVideoPrompt(plan: DidYouKnowPlan): string {
  const end = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
  return [
    `Ultra-realistic vertical 9:16 food video, 10 seconds, of ${plan.dish}, exactly the dish in the reference photos.`,
    `0–3 s: the action is already happening in the very first frame — ${end(plan.shots[0])}`,
    `3–6 s: ${end(plan.shots[1])}`,
    `6–10 s: ${end(plan.shots[2])}`,
    'Hands and forearms only, never a face. Warm natural kitchen light, close-ups.',
    'Voiceover in French (France), a warm natural native French female voice, fast and friendly, no English accent, starting in the very first second and speaking until the end, word for word:',
    `« ${plan.voiceover} »`,
    'No text, no captions, no subtitles, no titles and no logos anywhere in the video. Natural cooking sounds under the voice, no music. No steam on baked or cold food.',
  ].join(' ');
}

/**
 * The "Did you know" video prompt for this recipe: the model plans the dish's
 * name, three shots and the voice; the code checks the plan and writes the
 * prompt. A plan the checks refuse is asked for once more with the reason,
 * then given up on (the usual template is used).
 */
export async function buildDidYouKnowPrompt(
  c: { title: string; recipe: string },
  prompt: (name: string, vars: Record<string, unknown>) => Promise<{ content: string }>,
): Promise<string> {
  const ingredients = ingredientCount(c.recipe);
  const vars = {
    title: c.title,
    recipe: c.recipe.slice(0, 8000),
    ingredientCount: ingredients ?? 'an unknown number of',
  };
  let note = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = (await prompt('reel-didyouknow', { ...vars, recipe: vars.recipe + note })).content;
    try {
      const json = answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1);
      return didYouKnowVideoPrompt(validateDidYouKnow(JSON.parse(json), ingredients));
    } catch (err) {
      note = `\n\nYour previous answer was refused: ${err instanceof Error ? err.message : String(err)} Fix that and answer again with the full JSON.`;
    }
  }
  throw new Error(`The "Did you know" plan was refused twice.${note.replace(/\n+/g, ' ')}`);
}

/**
 * The hands-only video prompt: one model call, not a template.
 *
 * Unlike the single-clip prompt above, this one has no fixed shape to fill
 * in -- it has to name this recipe's own ingredients, equipment and steps in
 * the order they really happen, which only the model reading the recipe can
 * write. The composer shows it the same way: editable before anything is
 * generated, sent to Flow exactly as it stands once the reel is made.
 */
export async function buildHandsPrompt(
  c: {
    title: string;
    recipe: string;
  },
  prompt: (name: string, vars: Record<string, unknown>) => Promise<{ content: string }>,
): Promise<string> {
  const answer = await prompt('reel-hands', {
    title: c.title,
    recipe: c.recipe.slice(0, 8000),
  });
  return answer.content.trim();
}

/**
 * What every studio reel is built from, whoever asks for it -- the pipeline
 * after a publish, or a person on the reels page. One copy, so the two
 * cannot drift apart.
 */

/** The article's images by role, as public urls; the pin only when there is one. */
export function sourceUrls(
  host: string,
  images: ArticleImages,
  pin: string | null,
): Partial<Record<SourceRole, string>> {
  // A social-only account's images are full urls on the platform already.
  const abs = (path: string) => (/^https?:\/\//i.test(path) ? path : `https://${host}${path}`);
  const out: Partial<Record<SourceRole, string>> = {
    hero: abs(images.hero),
    stepA: abs(images.stepA),
    stepB: abs(images.stepB),
    stepC: abs(images.stepC),
  };
  if (pin) out.pin = abs(pin);
  return out;
}

/**
 * The prompt one clip is filmed from.
 *
 * The scene's own direction first, then what must hold in every clip: the
 * dish is the one in the photographs, named, and the pace is real time.
 * Then the line -- as the presenter speaking on screen, or as their
 * voiceover when they are not in the shot -- and how the delivery should
 * sound, in the same words every scene. That repetition, and the same voice
 * asset riding along with every spoken line, is what keeps the voice the
 * same clip to clip.
 */
export function clipPrompt(
  scene: { motion: string; line: string; onScreen?: boolean },
  presenter: { name: string; voice: string } | null,
  dish = '',
): string {
  const parts = [scene.motion.trim()];
  if (dish.trim()) {
    parts.push(
      `The dish is ${dish.trim()}, exactly the food in the reference photograph: ` +
        'same plate, same colours, same portion; nothing added or swapped.',
    );
  }
  parts.push('Natural real-time speed, no slow motion.');

  const line = scene.line.trim();
  if (presenter && line) {
    parts.push(
      scene.onScreen === false
        ? `${presenter.name} is not on screen; her voiceover says: "${line}"`
        : `${presenter.name} says: "${line}"`,
    );
    if (presenter.voice.trim()) parts.push(`Voice: ${presenter.voice.trim()}.`);
  } else if (line) {
    parts.push(`A voice says: "${line}"`);
  }
  return parts.join(' ');
}

/** What a reel keeps about its article before and after planning. */
export interface ReelSeed {
  article: { title: string; recipe: string; imagePrompts: Record<string, string> };
  sources: Partial<Record<SourceRole, string>>;
  /** A process reel: planned as hands-only shots rather than a storyboard. */
  process?: boolean;
}

/**
 * Everything the planner needs, read off the run's checkpoints.
 *
 * The recipe and the image prompts are what the article was written from;
 * they are what makes a storyboard specific to this dish rather than to
 * "a recipe". The pin graphic joins the sources when the run made one.
 */
export function seedFromRun(
  runId: number,
  host: string,
  images: ArticleImages,
  title: string,
): ReelSeed {
  const output = (step: string): unknown => {
    const row = getCompletedStep(runId, step);
    if (!row?.output_json) return null;
    try {
      return JSON.parse(row.output_json);
    } catch {
      return null;
    }
  };

  const pin = output('generate-pin-image') as { url?: string } | null;
  const recipe = output('generate-recipe');
  const prompts = output('generate-image-prompts') as Record<string, unknown> | null;

  const imagePrompts: Record<string, string> = {};
  for (const [key, value] of Object.entries(prompts ?? {})) {
    if (typeof value === 'string') imagePrompts[key] = value;
  }

  return {
    article: {
      title,
      recipe: typeof recipe === 'string' ? recipe : recipe ? JSON.stringify(recipe) : '',
      imagePrompts,
    },
    sources: sourceUrls(host, images, pin?.url ?? null),
  };
}

/**
 * The caption with the one thing it must never carry removed.
 *
 * Belt to the prompt's braces. The model is told not to link; if it does
 * anyway, the link comes out here rather than going on the post. The article
 * url is posted as the first comment and only there.
 */
export function withoutLinks(caption: string): string {
  return caption
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
