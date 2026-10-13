import { createHash } from 'node:crypto';

/**
 * Which Google Flow project an image is generated into.
 *
 * This value travels to Google as `clientContext.projectId` on every
 * generation, so it is part of what makes a request look like one the Flow UI
 * would send. Three tiers, most specific first:
 *
 *   1. The site's own project id. Each site has one in the Flow UI, and using
 *      it keeps a site's images in that site's project — which is where
 *      someone looking for them would go.
 *   2. The shared id from Settings. One project for everything is a normal way
 *      to run this, and it is the answer for a site nobody has filled in yet.
 *   3. A stable placeholder derived from the domain. Not a real project, but
 *      generation is refused outright without *something*, and a run that
 *      produces images beats a run that stops.
 *
 * The placeholder is derived rather than random on purpose. A projectId that
 * changed on every request would be a stronger signal to Google than one that
 * is merely unfamiliar, and it would make the same site's requests look like
 * they came from a different client each time.
 */

export type ProjectIdSource = 'site' | 'settings' | 'placeholder';

export interface ResolvedProjectId {
  projectId: string;
  source: ProjectIdSource;
}

export function resolveProjectId(
  siteProjectId: string | null | undefined,
  settingsProjectId: string | null | undefined,
  domain: string,
): ResolvedProjectId {
  const site = (siteProjectId ?? '').trim();
  if (site) return { projectId: site, source: 'site' };

  const shared = (settingsProjectId ?? '').trim();
  if (shared) return { projectId: shared, source: 'settings' };

  return { projectId: placeholderProjectId(domain), source: 'placeholder' };
}

/**
 * A UUID-shaped id derived from the domain.
 *
 * Shaped like a real one because Flow's own project ids are UUIDs, and
 * something obviously not a UUID is a clearer tell than an unknown one.
 * Version and variant nibbles are set so it is a well-formed v4.
 */
export function placeholderProjectId(domain: string): string {
  const hex = createHash('sha256').update(`flow-project:${domain.toLowerCase()}`).digest('hex');

  const version = `4${hex.slice(13, 16)}`;
  const variant = `${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`;

  return [hex.slice(0, 8), hex.slice(8, 12), version, variant, hex.slice(20, 32)].join('-');
}

/** One line for the run log, so which project was used is never a guess. */
export function describeProjectId(resolved: ResolvedProjectId, domain: string): string {
  switch (resolved.source) {
    case 'site':
      return `using ${domain}'s own Flow project ${resolved.projectId}`;
    case 'settings':
      return `using the shared Flow project ${resolved.projectId} (${domain} has none of its own)`;
    case 'placeholder':
      return (
        `no Flow project id for ${domain} and none set in Settings — generating with a ` +
        `placeholder (${resolved.projectId}). Set a real one under Settings or on the site.`
      );
  }
}
