import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Process-level configuration.
 *
 * Designed for zero-touch deployment: dropped onto a Docker platform with no
 * environment variables at all, the app generates and persists what it needs
 * into the data volume on first boot. Nothing to SSH in and create.
 *
 * Everything an operator would tune day to day lives in the database behind
 * the Settings UI, not here.
 */

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  dataDir: string;
  encryptionKey: Buffer;
  /** Password guarding the UI. Always set; generated if not supplied. */
  authPassword: string;
  /** True when the password was generated rather than configured. */
  authPasswordGenerated: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  promptsDir: string;
}

/** Persist a generated secret beside the database, readable only by us. */
function persistSecret(path: string, value: string): void {
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and some bind mounts do not support chmod; not fatal.
  }
}

function readOrCreateSecret(path: string, generate: () => string): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  }
  const created = generate();
  persistSecret(path, created);
  return created;
}

function resolveEncryptionKey(dataDir: string): Buffer {
  const fromEnv = process.env.ENCRYPTION_KEY?.trim();

  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
      throw new Error(
        'ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).\n' +
          'Generate one with:\n' +
          "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
          'Or remove the variable entirely and let the app generate one for you.',
      );
    }
    return Buffer.from(fromEnv, 'hex');
  }

  // No variable supplied: generate once and keep it in the data volume, so
  // credentials survive restarts and redeploys without any manual setup.
  const keyPath = resolve(dataDir, '.encryption-key');
  const hex = readOrCreateSecret(keyPath, () => randomBytes(32).toString('hex'));

  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `The stored encryption key at ${keyPath} is corrupt.\n` +
        'Delete it to generate a new one — every stored credential will then ' +
        'need re-entering in Settings.',
    );
  }

  return Buffer.from(hex, 'hex');
}

/** A readable generated password: four words plus digits beats base64 here. */
function generatePassword(): string {
  const words = [
    'amber', 'basil', 'cedar', 'delta', 'ember', 'flint', 'grove', 'harbor',
    'indigo', 'juniper', 'kelp', 'lumen', 'maple', 'nectar', 'onyx', 'pepper',
    'quartz', 'rowan', 'saffron', 'thistle', 'umber', 'violet', 'willow', 'zephyr',
  ];
  const pick = (): string => words[randomBytes(1)[0]! % words.length]!;
  const digits = String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, '0');
  return `${pick()}-${pick()}-${pick()}-${digits}`;
}

function resolveAuthPassword(dataDir: string): { password: string; generated: boolean } {
  const fromEnv = process.env.AUTH_PASSWORD?.trim();
  if (fromEnv) return { password: fromEnv, generated: false };

  const path = resolve(dataDir, '.admin-password');
  return { password: readOrCreateSecret(path, generatePassword), generated: true };
}

/** Where the database lives, and with it everything the platform stores as files. */
export function resolveDataDir(): string {
  return dirname(resolve(process.env.DB_PATH ?? './data/platform.db'));
}

export function loadConfig(): AppConfig {
  const dbPath = process.env.DB_PATH ?? './data/platform.db';
  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });

  const level = (process.env.LOG_LEVEL ?? 'info') as AppConfig['logLevel'];
  const auth = resolveAuthPassword(dataDir);

  return {
    port: Number(process.env.PORT ?? 8080),
    // Containers must bind 0.0.0.0 for the platform's proxy to reach them.
    // The UI is password-protected, which is what makes that safe.
    host: process.env.HOST ?? '0.0.0.0',
    dbPath,
    dataDir,
    encryptionKey: resolveEncryptionKey(dataDir),
    authPassword: auth.password,
    authPasswordGenerated: auth.generated,
    logLevel: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
    promptsDir: process.env.PROMPTS_DIR ?? './prompts',
  };
}
