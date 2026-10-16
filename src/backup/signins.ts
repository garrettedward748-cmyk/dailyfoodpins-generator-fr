import { createReadStream, createWriteStream, existsSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

/**
 * The Google sign-ins travel inside every platform backup.
 *
 * They are Chrome profiles on the image service's disk, not in the platform
 * database, so the service packs them (caches left out) and the platform puts
 * the file into the backup beside platform.db. A restore keeps the file aside
 * and hands it to the image service once that is up, which can be a minute or
 * two behind the platform after a restart.
 */

export interface SigninsLink {
  /** Fetch the service's bundle into `dest`; false when there is nothing to fetch. */
  fetchTo(dest: string): Promise<boolean>;
  /** Hand a bundle to the service; true once it took it. */
  push(src: string): Promise<boolean>;
}

export const SIGNINS_IN_BACKUP = 'google-signins.tar.gz';

export function signinsPendingPath(dataDir: string): string {
  return join(dataDir, '.signins-pending.tar.gz');
}

/** The link to the image service, from the platform's settings. */
export function imageServiceLink(read: (key: string) => string): SigninsLink {
  const target = (): { base: string; key: string } => ({
    base: read('image_base_url').replace(/\/+$/, ''),
    key: read('image_api_key'),
  });
  return {
    async fetchTo(dest) {
      const { base, key } = target();
      if (!base) return false;
      const response = await fetch(`${base}/flow/accounts-export`, {
        headers: { 'X-API-Key': key },
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!response.ok || !response.body) throw new Error(`image service answered HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest));
      return true;
    },
    async push(src) {
      const { base, key } = target();
      if (!base) return false;
      const response = await fetch(`${base}/flow/accounts-import`, {
        method: 'POST',
        headers: { 'X-API-Key': key, 'Content-Type': 'application/gzip' },
        body: Readable.toWeb(createReadStream(src)) as never,
        duplex: 'half',
        signal: AbortSignal.timeout(10 * 60_000),
      } as RequestInit);
      return response.ok;
    },
  };
}

/** Hand a kept-aside bundle to the service; removes it once taken. True when nothing is left to do. */
export async function pushPendingSignins(dataDir: string, link: SigninsLink): Promise<boolean> {
  const file = signinsPendingPath(dataDir);
  if (!existsSync(file)) return true;
  try {
    if (!(await link.push(file))) return false;
  } catch {
    return false;
  }
  rmSync(file, { force: true });
  return true;
}
