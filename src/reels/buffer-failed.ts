import { BufferClient, isBufferRateLimit } from '../integrations/buffer.js';
import { getReel, getSite, listBufferAccounts, reelsPublishedSince, setReelChannels, siteSecrets, type ReelView } from '../db/repos.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import { channelKeys, publishReel, readChannels, type ChannelKey, type ReelDeps } from './engine.js';

const log = createLogger('buffer-failed');

/**
 * Reels Buffer accepted and then could not publish, sent again once.
 *
 * A reel is handed to Buffer, which queues it and publishes it later. When
 * Facebook fails it at that moment ("unable to process the media", "an
 * unknown error has occurred") the very same post goes out on a retry, but the
 * platform never heard about the failure: the reel said "published" and the
 * post sat in Buffer under "Not published" until someone pressed Retry Now.
 *
 * This asks each Buffer token for its failed posts, matches them to the reels
 * by the post id Buffer gave back, and sends each one again exactly once
 * through the normal publish path (only the channel that failed; the others
 * stay as they are). The failed copy is then removed from Buffer, so the queue
 * does not keep a dead post next to the live one.
 *
 * Buffer counts every request against a limit over 30 days, so this runs
 * every few hours, asks nothing when no reel went out recently, and skips a
 * token that is already over the limit.
 */

/** How far back a reel's Buffer posts are looked for. Buffer's queue is rarely longer. */
export const FAILED_LOOKBACK_DAYS = 10;

/** Where the reel channels already sent again are remembered: once each, never twice. */
const RETRIED_KEY = 'buffer_failed_retried';
const RETRIED_KEEP = 1000;

export interface FailedRetryResult {
  checked: number;
  failed: number;
  retried: number;
}

function readRetried(settings: Settings): string[] {
  try {
    const list = JSON.parse(settings.get(RETRIED_KEY) || '[]') as unknown;
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}

/** The Buffer tokens the given sites post through, each once, the ones over the API limit left out. */
function tokensFor(siteIds: Set<number>, key: Buffer, now: Date): string[] {
  const tokens = new Set<string>();
  for (const siteId of siteIds) {
    for (const account of listBufferAccounts(siteId, key)) {
      if (!account.enabled || account.token.trim() === '') continue;
      const limited = !!account.fullUntil && account.fullUntil > now && isBufferRateLimit(account.lastError ?? '');
      if (!limited) tokens.add(account.token.trim());
    }
    const site = getSite(siteId);
    if (site) {
      try {
        const legacy = siteSecrets(site, key).bufferToken?.trim() ?? '';
        if (legacy) tokens.add(legacy);
      } catch {
        /* an unreadable site token is simply not asked */
      }
    }
  }
  return [...tokens];
}

export async function retryFailedBufferReels(
  settings: Settings,
  key: Buffer,
  deps: ReelDeps,
  options: { now?: Date; client?: (token: string) => Pick<BufferClient, 'getOrganizationIds' | 'failedPosts' | 'deletePost'> } = {},
): Promise<FailedRetryResult> {
  const result: FailedRetryResult = { checked: 0, failed: 0, retried: 0 };
  if (!settings.getBool('fb_enabled')) return result;

  // Every Buffer post id a recent reel was given, and where it belongs.
  const owners = new Map<string, { reel: ReelView; channel: ChannelKey }>();
  for (const reel of reelsPublishedSince(FAILED_LOOKBACK_DAYS)) {
    const channels = readChannels(reel);
    for (const channel of channelKeys(channels)) {
      const state = channels[channel];
      if (state?.status === 'ok' && state.id) owners.set(state.id, { reel, channel });
    }
  }
  result.checked = owners.size;
  if (owners.size === 0) return result; // nothing went out lately: Buffer is not asked at all

  const retried = readRetried(settings);
  const done = new Set(retried);
  const makeClient = options.client ?? ((token: string) => new BufferClient(token));
  const siteIds = new Set([...owners.values()].map((o) => o.reel.site_id).filter((id): id is number => typeof id === 'number'));

  for (const token of tokensFor(siteIds, key, options.now ?? new Date())) {
    const client = makeClient(token);
    let failed: { id: string; message: string }[] = [];
    try {
      for (const org of await client.getOrganizationIds()) failed.push(...(await client.failedPosts(org)));
    } catch (err) {
      log.warn(`could not read the failed posts of a Buffer token: ${errorMessage(err).slice(0, 200)}`);
      continue;
    }

    for (const post of failed) {
      const owner = owners.get(post.id);
      if (!owner) continue; // not one of ours, or older than the look-back
      result.failed += 1;
      const mark = `${owner.reel.id}:${owner.channel}`;
      if (done.has(mark)) continue; // sent again once already: a person decides now
      done.add(mark);
      retried.push(mark);
      settings.set(RETRIED_KEY, JSON.stringify(retried.slice(-RETRIED_KEEP)));

      const fresh = getReel(owner.reel.id);
      if (!fresh) continue;
      const channels = readChannels(fresh);
      if (channels[owner.channel]?.id !== post.id) continue; // already sent again by hand
      channels[owner.channel] = {
        status: 'failed',
        error: `Buffer could not publish it (${post.message.slice(0, 200)}); sent again automatically.`,
      };
      setReelChannels(fresh.id, JSON.stringify(channels));
      log.info(`reel ${fresh.id}: ${owner.channel} failed on Buffer (${post.message.slice(0, 120)}), sending it again`);

      try {
        await publishReel(getReel(fresh.id)!, deps);
        result.retried += 1;
      } catch (err) {
        log.warn(`reel ${fresh.id}: sending ${owner.channel} again failed — ${errorMessage(err)}`);
        continue;
      }

      // Sent again: the dead copy goes, so Buffer shows only the live one.
      try {
        await client.deletePost(post.id);
      } catch (err) {
        log.warn(`reel ${fresh.id}: the failed Buffer post ${post.id} stays in Buffer — ${errorMessage(err).slice(0, 200)}`);
      }
    }
  }

  if (result.retried > 0) log.info(`sent ${result.retried} reel(s) again that Buffer could not publish`);
  return result;
}
