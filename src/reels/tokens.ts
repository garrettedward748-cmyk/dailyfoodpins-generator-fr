import { FacebookClient } from '../integrations/facebook.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { fbTokenSecret, markFbTokenSynced, syncFbPages } from '../db/repos.js';

const log = createLogger('fb-tokens');

export type SyncResult =
  | { ok: true; added: number; renamed: number; dropped: number; total: number }
  | { ok: false; error: string };

/**
 * Make the pages under one token match what Graph lists for it.
 *
 * Nothing is typed by hand: the token is the source of pages. A failing
 * token is kept, with Graph's words beside it, so the person sees what to
 * fix rather than an empty table. Never throws; the page shows the result.
 */
export async function syncToken(
  tokenId: number,
  key: Buffer,
  makeClient: (token: string) => Pick<FacebookClient, 'listPages'> = (token) =>
    new FacebookClient({ systemUserToken: token }),
): Promise<SyncResult> {
  const token = fbTokenSecret(tokenId, key);
  if (!token) {
    const error = 'The token could not be read. Remove it and add it again.';
    markFbTokenSynced(tokenId, error);
    return { ok: false, error };
  }

  try {
    const pages = await makeClient(token).listPages();
    const counts = syncFbPages(tokenId, pages);
    markFbTokenSynced(tokenId, null);
    log.info(
      `token ${tokenId}: ${pages.length} page(s), ${counts.added} new, ${counts.dropped} gone`,
    );
    return { ok: true, ...counts, total: pages.length };
  } catch (err) {
    const error = errorMessage(err);
    markFbTokenSynced(tokenId, error);
    log.warn(`token ${tokenId}: sync failed: ${error}`);
    return { ok: false, error };
  }
}
