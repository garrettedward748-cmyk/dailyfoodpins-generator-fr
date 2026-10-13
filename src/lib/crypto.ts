import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for credentials stored in the database.
 *
 * Format: v1.<iv-base64>.<authTag-base64>.<ciphertext-base64>
 *
 * The version prefix means the format can change later without guessing
 * at what an old value was encrypted with.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const PREFIX = 'v1';

export function encrypt(plaintext: string, key: Buffer): string {
  if (plaintext === '') return '';

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    PREFIX,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

export function decrypt(payload: string, key: Buffer): string {
  if (payload === '') return '';

  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('Cannot decrypt value: unrecognised format.');
  }

  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(
      'Cannot decrypt stored credential. This usually means ENCRYPTION_KEY ' +
        'changed since the value was saved. Re-enter the credential in Settings.',
    );
  }
}

/** Show only enough of a secret to recognise it, never enough to use it. */
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}${'•'.repeat(12)}${value.slice(-4)}`;
}
