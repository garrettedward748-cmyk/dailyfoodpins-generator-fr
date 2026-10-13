/**
 * The shapes a reel can take.
 *
 * What keeps reels from all looking the same. Each format is a shape the plan
 * prompt is told to follow, and a page rotates through them: the last four it
 * used are avoided, so every shape comes round before any comes back.
 */
export interface ReelFormat {
  key: string;
  title: string;
  /** Handed to the plan prompt verbatim. */
  shape: string;
  presenter: 'optional' | 'never' | 'required';
  /** False for a format with no spoken line at all. */
  speech: boolean;
}

export const FORMATS: ReelFormat[] = [
  { key: 'reveal', title: 'Reveal', shape: 'close on the ingredients, one motion, then the finished dish', presenter: 'optional', speech: true },
  { key: 'taste-test', title: 'Taste test', shape: 'the presenter tastes, reacts, and shows the dish', presenter: 'required', speech: true },
  { key: 'three-things', title: 'Three things', shape: '"three things that make this work", one per scene', presenter: 'optional', speech: true },
  { key: 'mistake', title: 'The mistake', shape: 'the common mistake, then the fix, then the result', presenter: 'optional', speech: true },
  { key: 'pov', title: 'POV', shape: 'first-person hands only, the viewer is the cook', presenter: 'never', speech: true },
  { key: 'before-after', title: 'Before and after', shape: 'raw, then cooked, side by side', presenter: 'optional', speech: true },
  { key: 'secret', title: 'The secret', shape: '"the secret to this one is..." -- tease, the thing, the result', presenter: 'optional', speech: true },
  { key: 'countdown', title: 'Countdown', shape: '3-2-1 over steps or ingredients, one per scene', presenter: 'optional', speech: true },
  { key: 'myth', title: 'The myth', shape: '"people think... but actually..." -- a belief, then the truth', presenter: 'optional', speech: true },
  { key: 'asmr', title: 'ASMR', shape: 'no speech at all: cooking sound only, the call to action as text', presenter: 'never', speech: false },
  { key: 'time-trap', title: 'Time trap', shape: '"ready in 20 minutes" -- time as the subject, fast rhythm', presenter: 'optional', speech: true },
  { key: 'first-bite', title: 'First bite', shape: 'opens on the first bite, then back to how it was made', presenter: 'optional', speech: true },
  { key: 'story', title: 'Story', shape: 'the presenter says why this recipe is theirs, in the first person', presenter: 'required', speech: true },
];

export const formatByKey = (key: string): ReelFormat | undefined =>
  FORMATS.find((f) => f.key === key);

/**
 * One format for the next reel on a page.
 *
 * Avoids the formats the page used most recently; when every allowed format
 * is recent (a short allow-list), any allowed one will do. `random` is
 * injectable so the choice is testable.
 */
export function pickFormat(
  allowed: string[],
  recent: string[],
  random: () => number = Math.random,
): ReelFormat {
  const pool = FORMATS.filter((f) => allowed.includes(f.key));
  if (pool.length === 0) {
    throw new Error('No format is allowed. Turn at least one on under Setup → Reels.');
  }
  const fresh = pool.filter((f) => !recent.includes(f.key));
  const from = fresh.length ? fresh : pool;
  return from[Math.min(from.length - 1, Math.floor(random() * from.length))]!;
}
