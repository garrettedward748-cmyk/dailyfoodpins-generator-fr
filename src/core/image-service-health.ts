/**
 * What the image service's status means for the person reading Home.
 *
 * `connected` alone used to be read as "signed in to Google". It is not: it
 * says whether the Flow extension has a socket open, and Chrome is stopped
 * whenever nothing is queued, so most of the day it is false for a reason
 * that needs nobody. A signed-out browser is a different thing, and the
 * image service's watchdog is the one that knows it: it reads the failed
 * jobs, sees the sign-in wall, and raises `needs_human`.
 */

export interface FlowStatus {
  connected?: boolean;
  chrome?: { wanted_running?: boolean; always_on?: boolean };
}

export interface ServiceHealth {
  watchdog?: { needs_human?: boolean; reason?: string | null };
}

export const SIGNED_OUT =
  'The image service browser is signed out of Google. Open Browser to sign in.';

export const EXTENSION_MISSING =
  'The image service has Chrome up but its extension has not connected. Check the Browser page.';

/**
 * The problem to show, or null when there is none.
 *
 * `extensionMissingPolls` is how many polls in a row have found Chrome up and
 * the extension absent; Chrome takes most of a minute to come up, so the
 * first such poll is not a problem yet.
 */
export function imageServiceProblemFrom(
  status: FlowStatus,
  health: ServiceHealth | null,
  extensionMissingPolls: number,
): string | null {
  if (health?.watchdog?.needs_human) return SIGNED_OUT;
  if (status.connected) return null;

  const chromeUp = status.chrome?.wanted_running ?? status.chrome?.always_on ?? true;
  if (!chromeUp) return null;

  return extensionMissingPolls >= 2 ? EXTENSION_MISSING : null;
}
