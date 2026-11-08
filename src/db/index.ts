import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../lib/logger.js';
import { pendingMigrations, runMigrations } from './migrations.js';

const log = createLogger('db');

export type Db = DatabaseSync;

let instance: Db | null = null;

function schemaPath(): string {
  // Resolves correctly from both src (tsx) and dist (compiled).
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'schema.sql');
}

/* -------------------------------------------------------------------------
 * Safety net before a schema change
 * ---------------------------------------------------------------------- */

/** How many pre-migration copies to keep before the oldest is removed. */
const BACKUPS_KEPT = 5;

/**
 * Copy the database before touching its schema.
 *
 * Migrations here only add things, so in principle there is nothing to undo.
 * In practice "in principle" is not what you want standing between a live
 * deployment and every site credential it holds, and the copy costs a second.
 *
 * VACUUM INTO rather than a file copy: the database runs in WAL mode, so the
 * .db file on disk is missing every write still sitting in the -wal sidecar.
 * Copying it produces a backup that is quietly out of date, and you find that
 * out at the worst possible moment.
 */
function backupBeforeMigrating(db: Db, dbPath: string): string | null {
  // Nothing to protect: an in-memory database is a test, and a file that does
  // not exist yet is a first boot.
  if (dbPath === ':memory:' || !existsSync(dbPath)) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${dbPath}.pre-migration-${stamp}.bak`;

  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    log.info(`backed up to ${basename(target)} before migrating`);
    pruneBackups(dbPath);
    return target;
  } catch (err) {
    // A failed backup is a reason to stop. Migrating anyway would be doing the
    // risky half of the operation having skipped the safe half.
    throw new Error(
      `Could not back up the database before migrating, so nothing was changed: ${String(err)}`,
    );
  }
}

function pruneBackups(dbPath: string): void {
  try {
    const directory = dirname(resolve(dbPath));
    const prefix = `${basename(dbPath)}.pre-migration-`;

    const backups = readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
      .map((name) => {
        const full = join(directory, name);
        return { full, at: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.at - a.at);

    for (const stale of backups.slice(BACKUPS_KEPT)) {
      unlinkSync(stale.full);
      log.debug(`removed old backup ${basename(stale.full)}`);
    }
  } catch {
    // Tidying is not worth failing a boot over.
  }
}

/* -------------------------------------------------------------------------
 * Opening
 * ---------------------------------------------------------------------- */

export function openDatabase(dbPath: string): Db {
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });

  const isNew = dbPath === ':memory:' || !existsSync(dbPath);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  // schema.sql creates anything missing and does nothing to what is there.
  // It deliberately contains no index or constraint that depends on a column
  // a migration adds — getting that ordering right is what migrations are for,
  // and getting it wrong is what stopped the new code booting against the
  // deployed database.
  db.exec(readFileSync(schemaPath(), 'utf8'));

  // Migrations run on every database, new or existing, by the same path.
  //
  // An earlier version marked them applied on a fresh database instead, on the
  // grounds that schema.sql had just created everything they would add. That
  // was true of the columns and false of the indexes: 004 creates two partial
  // indexes that cannot live in schema.sql (they reference columns 003 adds),
  // so marking it skipped left new installations without them. Nothing broke —
  // SQLite just scanned instead — which is exactly why it would have gone
  // unnoticed while the two kinds of deployment drifted apart.
  //
  // Every migration is idempotent, so running them all every time costs a
  // handful of no-ops and buys one code path.
  const pending = pendingMigrations(db);

  if (pending.length > 0) {
    log.info(`${pending.length} migration(s) to apply: ${pending.map((m) => m.id).join(', ')}`);

    // Only an existing database has anything to lose; backupBeforeMigrating
    // returns null for a file that is not there yet.
    if (!isNew) backupBeforeMigrating(db, dbPath);

    const report = runMigrations(db);
    log.info(`${isNew ? 'initialised' : 'migrated'}: ${report.applied.join(', ')}`);
  }

  log.info(`Database ready at ${dbPath}`);
  instance = db;
  return db;
}

export function getDb(): Db {
  if (!instance) throw new Error('Database not opened. Call openDatabase() first.');
  return instance;
}

export function setDb(db: Db): void {
  instance = db;
}

export function closeDatabase(): void {
  instance?.close();
  instance = null;
}

/**
 * Run `fn` inside a transaction. node:sqlite has no transaction helper, so
 * this wraps the statements directly.
 */
export function transaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* rollback of an already-failed transaction */
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------
 * Thin typed helpers over node:sqlite.
 * ---------------------------------------------------------------------- */

type Param = string | number | bigint | null | Uint8Array;

export function all<T>(sql: string, ...params: Param[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
  const result = getDb().prepare(sql).run(...params);
  return {
    changes: Number(result.changes),
    lastInsertRowid: Number(result.lastInsertRowid),
  };
}

/** SQLite has no boolean type; normalise the 0/1 integers it returns. */
export const toBool = (value: unknown): boolean => value === 1 || value === true;
export const fromBool = (value: boolean): number => (value ? 1 : 0);
