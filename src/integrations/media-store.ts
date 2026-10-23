import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { resolveDataDir } from '../config.js';
import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('media-store');

/**
 * Images and videos kept on the platform itself, for social-only accounts.
 *
 * Buffer and Facebook take media by url and fetch it themselves, so whatever
 * a post shows has to be somewhere public first. A website's own /api/upload
 * is that somewhere for an ordinary site; an account with no website has
 * none, so the platform serves the files at /media/<file> under its own public
 * address (Setup -> General -> Public address).
 *
 * Nothing here is meant to last. Once a network has published a post it holds
 * its own copy of the picture, so a file is removed by `cleanupMedia` (run
 * every hour) once a network has fetched it and it is older than
 * Setup -> General -> Keep media for; a file never fetched is kept longer,
 * since its post is still waiting in a queue.
 * Images are re-encoded as JPEG at quality 85 on the way in, which roughly
 * halves what Flow hands back.
 */

export interface MediaStoreConfig {
  /** Where the files are written. */
  dir: string;
  /** The platform's public address, read at the moment it is needed. */
  publicUrl: () => string;
  /** Days a file is kept before cleanupMedia removes it. */
  keepDays: () => number;
}

let config: MediaStoreConfig = {
  dir: join(resolveDataDir(), 'media'),
  publicUrl: () => process.env.PUBLIC_URL ?? '',
  keepDays: () => 7,
};

/** Set where media goes and how it is reached. Called once at boot, and by tests. */
export function configureMediaStore(next: Partial<MediaStoreConfig>): void {
  config = { ...config, ...next };
}

/** The folder files are kept in. */
export function mediaDir(): string {
  return config.dir;
}

/** The only names this store writes, and so the only names /media serves. */
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,80}\.(jpg|png|webp|gif|mp4)$/;

export function isMediaName(name: string): boolean {
  return SAFE_NAME.test(name);
}

export const MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
};

/** The platform's public address, or a plain error naming the setting to fill. */
function publicBase(): string {
  const base = config.publicUrl().trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/i.test(base)) {
    throw new Error(
      'This account has no website, so its pictures are served by the platform — ' +
        'set Setup → General → "Public address" to the address this platform is reached at ' +
        '(for example https://platform.example.com).',
    );
  }
  return base;
}

/**
 * A file this store holds, read from disk when a url points at it.
 *
 * The platform fetching its own public address goes out through the server's
 * public IP and back in through the proxy, which many hosts do not allow
 * ("fetch failed"). Anything under /media/ that is here is read directly,
 * whatever host the url names, so a changed public address still finds it.
 */
export function readLocalMedia(url: string): { data: Buffer; contentType: string } | null {
  let name = '';
  try {
    const path = new URL(url).pathname;
    const m = /\/media\/([^/]+)$/.exec(path);
    name = m ? decodeURIComponent(m[1]!) : '';
  } catch {
    return null;
  }
  if (!isMediaName(name)) return null;
  const file = join(config.dir, name);
  if (!existsSync(file)) return null;
  const ext = name.slice(name.lastIndexOf('.') + 1);
  return { data: readFileSync(file), contentType: MEDIA_TYPES[ext] ?? 'application/octet-stream' };
}

/** The public url of a stored file. */
export function mediaUrl(name: string): string {
  return `${publicBase()}/media/${name}`;
}

/**
 * Keep one picture and give back its public url.
 *
 * A picture that sharp cannot read is kept exactly as it came rather than
 * failing the post over a size saving.
 */
export async function saveMediaImage(data: Buffer, contentType: string, prefix = 'img'): Promise<{ name: string; url: string; size: number }> {
  // Checked first, so a missing address fails before anything is written.
  publicBase();
  mkdirSync(config.dir, { recursive: true });

  let bytes = data;
  let extension = contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : contentType.includes('webp') ? 'webp' : 'jpg';
  if (extension !== 'gif') {
    try {
      bytes = await sharp(data).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      extension = 'jpg';
    } catch (err) {
      log.warn(`kept a picture as it came, it could not be re-encoded: ${errorMessage(err)}`);
    }
  }

  const name = `${safePrefix(prefix)}-${randomUUID()}.${extension}`;
  writeFileSync(join(config.dir, name), bytes);
  return { name, url: mediaUrl(name), size: bytes.length };
}

/** Keep one video and give back its public url. */
export function saveMediaVideo(data: Buffer, prefix = 'video'): { name: string; url: string; size: number } {
  publicBase();
  mkdirSync(config.dir, { recursive: true });
  const name = `${safePrefix(prefix)}-${randomUUID()}.mp4`;
  writeFileSync(join(config.dir, name), data);
  return { name, url: mediaUrl(name), size: data.length };
}

function safePrefix(prefix: string): string {
  return prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'file';
}

/**
 * The networks' own fetchers: the request that comes when a post is actually
 * published, as opposed to Buffer looking at the file when it is queued.
 * Meta (Facebook, Instagram), Pinterest, TikTok, X and Google.
 */
const PUBLISHER_AGENT = /facebookexternalhit|facebookexternalua|facebookcatalog|meta-external|instagram|pinterest|tiktok|bytespider|twitterbot|googlebot|google-youtube/i;

/** Whether a request for a file comes from a network publishing it. */
export function isPublisherFetch(userAgent: string | undefined): boolean {
  return PUBLISHER_AGENT.test(String(userAgent ?? ''));
}

/** Where the "a network has fetched this file" times are kept, beside the files. */
const DELIVERED_FILE = 'delivered.json';

function readDelivered(): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(join(config.dir, DELIVERED_FILE), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeDelivered(map: Record<string, number>): void {
  try {
    mkdirSync(config.dir, { recursive: true });
    writeFileSync(join(config.dir, DELIVERED_FILE), JSON.stringify(map));
  } catch (err) {
    log.warn(`could not record delivered media: ${errorMessage(err)}`);
  }
}

/** Record that a network has fetched this file, i.e. its post went out. */
export function markDelivered(name: string, at = Date.now()): void {
  if (!isMediaName(name)) return;
  const map = readDelivered();
  if (map[name]) return; // the first fetch is the one that counts
  map[name] = at;
  writeDelivered(map);
}

/**
 * Days a file no network has fetched yet is kept, whatever the keep period:
 * its post is most likely still waiting in a Buffer queue, and removing the
 * picture under it is what makes Buffer fail with "update the media URL to be
 * publicly accessible". Past this it is taken as abandoned.
 */
export const UNDELIVERED_MAX_DAYS = 60;

/**
 * Remove stored files that are no longer needed.
 *
 * Buffer's API has no simple "was this post sent" question, so the files say
 * it themselves: the network fetches the picture or reel when the post is
 * published (`markDelivered`, from the /media route). A file is removed once
 * it is older than the keep period AND a network has fetched it; one that was
 * never fetched waits up to UNDELIVERED_MAX_DAYS, so a long Buffer queue no
 * longer loses its pictures after a week.
 */
export function cleanupMedia(now = Date.now()): { removed: number; bytes: number } {
  const days = Math.max(1, Number(config.keepDays()) || 7);
  const cutoff = now - days * 86_400_000;
  const abandoned = now - Math.max(days, UNDELIVERED_MAX_DAYS) * 86_400_000;
  let removed = 0;
  let bytes = 0;

  let names: string[];
  try {
    names = readdirSync(config.dir);
  } catch {
    return { removed, bytes };
  }

  const delivered = readDelivered();
  const present = new Set<string>();

  for (const name of names) {
    if (!isMediaName(name)) continue;
    const path = join(config.dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      const done = Boolean(delivered[name]);
      const due = done ? stat.mtimeMs <= cutoff : stat.mtimeMs <= abandoned;
      if (!due) {
        present.add(name);
        continue;
      }
      unlinkSync(path);
      removed += 1;
      bytes += stat.size;
    } catch (err) {
      present.add(name);
      log.warn(`could not remove ${name}: ${errorMessage(err)}`);
    }
  }

  // Forget the files that are gone, so the record does not grow forever.
  const kept = Object.fromEntries(Object.entries(delivered).filter(([name]) => present.has(name)));
  if (Object.keys(kept).length !== Object.keys(delivered).length) writeDelivered(kept);

  if (removed > 0) {
    log.info(`removed ${removed} media file(s) no longer needed, ${(bytes / 1_048_576).toFixed(1)} MB freed`);
  }
  return { removed, bytes };
}

/** What the store holds right now, for the Setup page. */
export function mediaUsage(): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  try {
    for (const name of readdirSync(config.dir)) {
      if (!isMediaName(name)) continue;
      try {
        bytes += statSync(join(config.dir, name)).size;
        files += 1;
      } catch {
        // removed between the listing and the stat
      }
    }
  } catch {
    // no folder yet: nothing stored
  }
  return { files, bytes };
}
