import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  clearStoredPassword,
  hashPassword,
  rejectionReason,
  storePassword,
  storedPasswordHash,
  verifyPassword,
} from '../src/web/password.js';
import { passwordAccepted, type AuthOptions } from '../src/web/auth.js';

const KEY = randomBytes(32);

const options = (password: string): AuthOptions => ({
  password,
  secret: KEY,
  generated: true,
  encryptionKey: KEY,
});

describe('password hashing', () => {
  it('accepts the password it was made from', () => {
    const stored = hashPassword('correct horse battery');
    expect(verifyPassword('correct horse battery', stored)).toBe(true);
  });

  it('rejects anything else', () => {
    const stored = hashPassword('correct horse battery');
    expect(verifyPassword('correct horse batter', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('salts, so the same password hashes differently each time', () => {
    expect(hashPassword('same password')).not.toBe(hashPassword('same password'));
  });

  it('never stores the password itself', () => {
    expect(hashPassword('literal-secret-here')).not.toContain('literal-secret-here');
  });

  it('fails closed on a malformed stored value rather than throwing', () => {
    // A 500 at the login form would lock everyone out of the platform.
    for (const broken of ['', 'garbage', 'scrypt$notanumber$aa$bb', 'bcrypt$1$2$3', '$$$']) {
      expect(verifyPassword('anything', broken)).toBe(false);
    }
  });
});

describe('what makes a password unacceptable', () => {
  it('requires the confirmation to match', () => {
    expect(rejectionReason('a-good-long-one', 'a-good-long-two')).toContain('do not match');
  });

  it('requires some length', () => {
    expect(rejectionReason('short', 'short')).toContain('10 characters');
  });

  it('rejects surrounding whitespace, which is invisible and mistyped later', () => {
    expect(rejectionReason(' padded-password ', ' padded-password ')).toContain('spaces');
  });

  it('accepts a reasonable one', () => {
    expect(rejectionReason('a-reasonable-password', 'a-reasonable-password')).toBeNull();
  });
});

describe('which password is in force', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('uses the generated fallback until one is chosen', () => {
    expect(storedPasswordHash(KEY)).toBe('');
    expect(passwordAccepted('generated-one', options('generated-one'))).toBe(true);
  });

  it('uses the chosen password once it is set', () => {
    storePassword('my-own-password', KEY);

    expect(passwordAccepted('my-own-password', options('generated-one'))).toBe(true);
  });

  it('stops accepting the generated one after a password is chosen', () => {
    storePassword('my-own-password', KEY);

    // The generated password is printed in the container logs on every start.
    // Leaving it live would mean the weaker of the two decides who gets in.
    expect(passwordAccepted('generated-one', options('generated-one'))).toBe(false);
  });

  it('falls back again if the chosen password is cleared', () => {
    storePassword('my-own-password', KEY);
    clearStoredPassword(KEY);

    expect(passwordAccepted('generated-one', options('generated-one'))).toBe(true);
  });

  it('survives a round trip through storage', () => {
    storePassword('round-trip-password', KEY);
    const stored = storedPasswordHash(KEY);

    expect(stored).toMatch(/^scrypt\$/);
    expect(verifyPassword('round-trip-password', stored)).toBe(true);
  });
});
