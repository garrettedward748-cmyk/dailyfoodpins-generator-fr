/**
 * Choosing the next of several interchangeable things, per site.
 *
 * Written once for the Pinterest designs and now shared with the photo
 * shoots, because the rule is the same one and two copies of it would drift:
 * the day someone improves the tie-break for pins, the photographs would
 * quietly keep the old one.
 *
 * The rule, in order:
 *   1. Never one of this site's last few — repetition is visible in a feed
 *      long before an uneven total is.
 *   2. Of what is left, the least used on this site, so the spread evens out
 *      over time without anyone tending it.
 *   3. On a tie, a different starting point per site, so two sites publishing
 *      the same morning do not publish the same look.
 *
 * Pure: the caller does the database work and the filtering, which is what
 * makes the rule itself arguable in a test.
 */
export function pickInRotation<T extends { id: number }>(
  usable: T[],
  recent: number[],
  usesOnSite: Record<number, number>,
  siteId: number,
  avoidLast = 3,
): T | null {
  if (usable.length === 0) return null;

  // Never avoid so many that nothing is left: with two to choose from, only
  // the last one is off the table.
  const avoid = recent.slice(0, Math.min(avoidLast, usable.length - 1));
  const pool = usable.filter((item) => !avoid.includes(item.id));

  const least = Math.min(...pool.map((item) => usesOnSite[item.id] ?? 0));
  const tied = pool.filter((item) => (usesOnSite[item.id] ?? 0) === least);
  return tied[siteId % tied.length]!;
}
