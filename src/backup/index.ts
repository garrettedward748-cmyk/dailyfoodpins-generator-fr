import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getDb } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { SIGNINS_IN_BACKUP, signinsPendingPath, type SigninsLink } from './signins.js';

const run = promisify(execFile);
const log = createLogger('backup');

/**
 * Platform backups: one .tar.gz holding
 *
 *   platform.db      a consistent copy of the database (VACUUM INTO, safe while running)
 *   encryption-key   the key the stored tokens are encrypted with — without it a
 *                    restored database's API tokens and Buffer tokens are unreadable
 *   backup.json      when and what
 *
 * Kept in <data>/backups. A restore cannot swap the database under a running
 * process, so it is staged in <data>/.restore-pending and the process exits;
 * the container restarts and applyPendingRestore() swaps it in before the
 * database is opened.
 */

export type BackupKind = 'auto' | 'manual' | 'before-restore' | 'uploaded';
export const KEEP: Record<BackupKind, number> = { auto: 7, manual: 10, 'before-restore': 2, uploaded: 3 };

export interface BackupFile {
  name: string;
  kind: BackupKind;
  size: number;
  time: number;
}

let dataDir = resolve('./data');
let keyHex = '';
let signinsLink: SigninsLink | null = null;

/** Where the Google sign-ins come from, so every backup carries them; set once at start-up. */
export function configureSignins(link: SigninsLink | null): void {
  signinsLink = link;
}

/** Where backups go and the key they carry; set once at start-up. */
export function configureBackups(dir: string, encryptionKey: Buffer): void {
  dataDir = dir;
  keyHex = encryptionKey.toString('hex');
}

export function backupsDir(): string {
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function listBackups(): BackupFile[] {
  return readdirSync(backupsDir())
    .filter((n) => n.endsWith('.tar.gz'))
    .map((name) => {
      const st = statSync(join(backupsDir(), name));
      const kind = (/-(auto|manual|before-restore|uploaded)\.tar\.gz$/.exec(name)?.[1] ?? 'manual') as BackupKind;
      return { name, kind, size: st.size, time: st.mtimeMs };
    })
    .sort((a, b) => b.time - a.time);
}

/** A backup by name, or null: plain names inside the backups folder only. */
export function backupPath(name: string): string | null {
  if (!/^[A-Za-z0-9._-]+\.tar\.gz$/.test(name)) return null;
  const path = join(backupsDir(), name);
  return existsSync(path) ? path : null;
}

const stamp = (d = new Date()): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export async function createBackup(kind: BackupKind = 'manual'): Promise<string> {
  const name = `platform-${stamp()}-${kind}.tar.gz`;
  const final = join(backupsDir(), name);
  const work = join(backupsDir(), `.work-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    getDb().exec(`VACUUM INTO '${join(work, 'platform.db').replace(/'/g, "''")}'`);
    writeFileSync(join(work, 'encryption-key'), keyHex, { mode: 0o600 });
    // The Google sign-ins ride along when the image service answers. A service
    // that is down must not stop the backup of everything else.
    let signins = false;
    if (signinsLink) {
      try {
        signins = await signinsLink.fetchTo(join(work, SIGNINS_IN_BACKUP));
      } catch (err) {
        log.warn(`backup made without the Google sign-ins: ${errorMessage(err)}`);
      }
    }
    writeFileSync(join(work, 'backup.json'), JSON.stringify({ created: new Date().toISOString(), kind, format: 1, signins }));
    await run('tar', ['-czf', `${final}.part`, '-C', work, 'platform.db', 'encryption-key', 'backup.json', ...(signins ? [SIGNINS_IN_BACKUP] : [])]);
    renameSync(`${final}.part`, final);
  } finally {
    rmSync(`${final}.part`, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
  pruneBackups();
  log.info(`backup made: ${name}`);
  return name;
}

export function pruneBackups(): void {
  const seen: Partial<Record<BackupKind, number>> = {};
  for (const b of listBackups()) {
    seen[b.kind] = (seen[b.kind] ?? 0) + 1;
    if (seen[b.kind]! > KEEP[b.kind]) rmSync(join(backupsDir(), b.name), { force: true });
  }
}

/** Make the daily backup when the last one is a day old. */
export async function dailyBackupIfDue(now = Date.now()): Promise<string | null> {
  const last = listBackups().find((b) => b.kind === 'auto');
  if (last && now - last.time < 23 * 3_600_000) return null;
  try {
    return await createBackup('auto');
  } catch (err) {
    log.warn(`daily backup failed: ${errorMessage(err)}`);
    return null;
  }
}

const pendingDir = (): string => join(dataDir, '.restore-pending');

/**
 * Check a backup, save the current state, and stage the backup for the next
 * start. The caller then ends the process.
 */
export async function stageRestore(name: string): Promise<string> {
  const path = backupPath(name);
  if (!path) throw new Error('Backup file not found.');

  rmSync(pendingDir(), { recursive: true, force: true });
  mkdirSync(pendingDir(), { recursive: true });
  try {
    await run('tar', ['-xzf', path, '-C', pendingDir()]);
  } catch (err) {
    rmSync(pendingDir(), { recursive: true, force: true });
    throw new Error(`Not a readable backup: ${errorMessage(err)}`);
  }
  if (!existsSync(join(pendingDir(), 'platform.db'))) {
    rmSync(pendingDir(), { recursive: true, force: true });
    throw new Error('This file is not a platform backup (no platform.db inside).');
  }
  return createBackup('before-restore');
}

/**
 * At start-up, before the database is opened: swap in a staged restore.
 * Returns a line for the log, or null when nothing was staged.
 */
export function applyPendingRestore(dbPath: string, dir: string): string | null {
  const pending = join(dir, '.restore-pending');
  const db = join(pending, 'platform.db');
  if (!existsSync(db)) return null;

  const target = resolve(dbPath);
  for (const suffix of ['-wal', '-shm']) rmSync(target + suffix, { force: true });
  copyFileSync(db, target);

  let note = 'database restored from backup';
  const key = join(pending, 'encryption-key');
  if (existsSync(key)) {
    const hex = readFileSync(key, 'utf8').trim();
    const fromEnv = process.env.ENCRYPTION_KEY?.trim();
    if (fromEnv && fromEnv.toLowerCase() !== hex.toLowerCase()) {
      note += '; WARNING: ENCRYPTION_KEY in the environment differs from the backup\'s key, so stored tokens cannot be read — remove the variable or set it to the backup\'s key';
    } else if (!fromEnv) {
      writeFileSync(join(dir, '.encryption-key'), hex, { mode: 0o600 });
      note += ' (with its encryption key)';
    }
  }
  // The Google sign-ins wait for the image service, which may not be up yet.
  const signins = join(pending, SIGNINS_IN_BACKUP);
  if (existsSync(signins)) {
    copyFileSync(signins, signinsPendingPath(dir));
    note += '; Google sign-ins will go to the image service';
  }
  rmSync(pending, { recursive: true, force: true });
  return note;
}

/** Used by tests: tar must exist where this runs. */
export function tarAvailable(): boolean {
  try {
    execFileSync('tar', ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let restartRequested = false;

/**
 * End the process so the container restarts into the staged restore. Exits
 * non-zero so a restart policy of "on-failure" also brings it back.
 */
export function requestRestart(): void {
  restartRequested = true;
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500).unref();
}

export const restartExitCode = (): number => (restartRequested ? 75 : 0);
