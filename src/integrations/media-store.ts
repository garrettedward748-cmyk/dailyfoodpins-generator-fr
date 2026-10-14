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
 * its own copy of the picture, so the files are removed after a few days
 * (Setup -> General -> Keep media for) by `cleanupMedia`, run every hour.
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
  return prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'file';
}

/**
 * Remove every stored file older than the keep period.
 *
 * By file age rather than by asking each network whether its post went out:
 * Buffer's API has no simple "was this post sent" question, and a free Buffer
 * queue holds ten posts per channel, which goes out within days. A keep period
 * longer than the longest queue is the same guarantee without the guesswork.
 */
export function cleanupMedia(now = Date.now()): { removed: number; bytes: number } {
  const days = Math.max(1, Number(config.keepDays()) || 7);
  const cutoff = now - days * 86_400_000;
  let removed = 0;
  let bytes = 0;

  let names: string[];
  try {
    names = readdirSync(config.dir);
  } catch {
    return { removed, bytes };
  }

  for (const name of names) {
    if (!isMediaName(name)) continue;
    const path = join(config.dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
      unlinkSync(path);
      removed += 1;
      bytes += stat.size;
    } catch (err) {
      log.warn(`could not remove ${name}: ${errorMessage(err)}`);
    }
  }

  if (removed > 0) {
    log.info(`removed ${removed} media file(s) older than ${days} day(s), ${(bytes / 1_048_576).toFixed(1)} MB freed`);
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
