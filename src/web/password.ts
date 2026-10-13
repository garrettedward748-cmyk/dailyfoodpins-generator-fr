import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getSetting, setSetting } from '../db/repos.js';

/**
 * The admin password, once someone has chosen their own.
 *
 * Until then the platform runs on a password generated into the data volume on
 * first boot, which is fine for getting in and poor for everything after: it
 * cannot be changed without recreating the volume, and it is printed in the
 * container logs where anyone with log access can read it.
 *
 * A chosen password is stored here as a scrypt hash instead of encrypted.
 * Encryption would be reversible, and nothing needs to read this value back —
 * only compare against it. The stored form carries its own salt and
 * parameters, so the cost can be raised later without invalidating what is
 * already stored.
 */

const SETTING_KEY = 'admin_password_hash';

/** scrypt cost. 2^15 is roughly 100ms here — slow for a guesser, fine once per login. */
const COST = 2 ** 15;
const KEY_LENGTH = 64;

/**
 * scrypt needs about `128 * N * r` bytes — 33MB at these parameters, just over
 * Node's 32MB default. Left at the default it throws "memory limit exceeded",
 * and it would do so at the moment someone first tries to set a password.
 */
const MAX_MEMORY = 96 * 1024 * 1024;

export const MIN_LENGTH = 10;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(plain, salt, KEY_LENGTH, {
    N: COST,
    r: 8,
    p: 1,
    maxmem: MAX_MEMORY,
  });
  return `scrypt$${COST}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const [, costText, saltHex, expectedHex] = parts as [string, string, string, string];
  const cost = Number(costText);
  if (!Number.isInteger(cost) || cost < 2) return false;

  try {
    const derived = scryptSync(plain, Buffer.from(saltHex, 'hex'), KEY_LENGTH, {
      N: cost,
      r: 8,
      p: 1,
      maxmem: MAX_MEMORY,
    });
    const expected = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    // A malformed stored value must fail closed, not throw a 500 at the login
    // form and lock everyone out.
    return false;
  }
}

/** The stored hash, or '' when nobody has set a password yet. */
export function storedPasswordHash(encryptionKey: Buffer): string {
  return getSetting(SETTING_KEY, encryptionKey);
}

export function storePassword(plain: string, encryptionKey: Buffer): void {
  // Not marked secret: a scrypt hash is already not the password, and
  // encrypting it would tie every login to the encryption key as well.
  setSetting(SETTING_KEY, hashPassword(plain), false, encryptionKey);
}

export function clearStoredPassword(encryptionKey: Buffer): void {
  setSetting(SETTING_KEY, '', false, encryptionKey);
}

/** Why a candidate password is unacceptable, or null when it is fine. */
export function rejectionReason(plain: string, confirmation: string): string | null {
  if (plain !== confirmation) return 'The two passwords do not match.';
  if (plain.length < MIN_LENGTH) {
    return `Use at least ${MIN_LENGTH} characters. This is the only thing between the internet and every credential the platform holds.`;
  }
  if (/^\s|\s$/.test(plain)) {
    return 'Leading or trailing spaces are too easy to mistype later. Trim them.';
  }
  return null;
}
