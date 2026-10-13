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
 *   process: hands only, one kitchen, the recipe from raw to done in eight
 *            quick shots, each its own Flow generation filmed from the last
 *            frame of the one before -- eight clips' credits, about half an hour.
 */
export type ReelMode = 'single' | 'hands' | 'mixed' | 'scenes' | 'process';

export function reelMode(settings: Settings): ReelMode {
  const mode = settings.get('reel_mode');
  return mode === 'scenes' || mode === 'mixed' || mode === 'process' || mode === 'hands'
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
