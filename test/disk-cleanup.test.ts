import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { compactIfBloated, pruneDecisions } from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';
import { backupsDir, configureBackups, createBackup, listBackups, removeAutomaticBackups } from '../src/backup/index.js';
import { SETTING_SPECS } from '../src/settings.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { getDb } from '../src/db/index.js';

/** What keeps the server disk from filling: short logs, a database that shrinks back, no automatic backups. */

let dir: string;
let db: string;

beforeEach(() => {
  setLogLevel('error');
  dir = mkdtempSync(join(tmpdir(), 'cleanup-'));
  db = join(dir, 'platform.db');
  openDatabase(db);
  configureBackups(dir, randomBytes(32));
});
afterEach(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

describe('disk cleanup', () => {
  it('keeps logs 3 days by default', () => {
    expect(SETTING_SPECS.find((s) => s.key === 'retention_days')?.default).toBe('3');
  });

  it('gives the disk back after old decisions are pruned', () => {
    const reason = 'x'.repeat(2000);
    run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150000)
         INSERT INTO decisions (cycle_id, subject_type, subject_id, subject_label, decision, reason, created_at)
         SELECT 'c' || i, 'keyword', i, 'k', 'skipped', ?, datetime('now', '-40 days') FROM n`, reason);
    run('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = statSync(db).size;
    expect(before).toBeGreaterThan(250 * 1024 * 1024);

    expect(pruneDecisions(3)).toBe(150000);
    expect(compactIfBloated()).toBeGreaterThan(200 * 1024 * 1024);
    run('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(statSync(db).size).toBeLessThan(before / 10);
    expect(get<{ n: number }>('SELECT COUNT(*) AS n FROM decisions')?.n).toBe(0);
  }, 120_000);

  it('a saved retention longer than 3 days is reset to the new default', () => {
    run("INSERT INTO settings (key, value, is_secret) VALUES ('retention_days', '30', 0)");
    MIGRATIONS.find((m) => m.id === '068-short-log-retention')!.up(getDb());
    expect(get('SELECT value FROM settings WHERE key = ?', 'retention_days')).toBeUndefined();

    run("INSERT INTO settings (key, value, is_secret) VALUES ('retention_days', '2', 0)");
    MIGRATIONS.find((m) => m.id === '068-short-log-retention')!.up(getDb());
    expect(get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'retention_days')?.value).toBe('2');
  });

  it('does nothing to a database without much empty space', () => {
    expect(compactIfBloated()).toBe(0);
  });

  it('removes automatic backups and keeps the ones made by hand', async () => {
    const manual = await createBackup('manual');
    writeFileSync(join(backupsDir(), 'platform-20261101-080000-auto.tar.gz'), 'old');
    writeFileSync(join(backupsDir(), 'platform-20261102-080000-auto.tar.gz'), 'old');

    expect(removeAutomaticBackups()).toBe(2);
    expect(listBackups().map((b) => b.name)).toEqual([manual]);
    expect(readdirSync(backupsDir()).filter((n) => n.includes('-auto'))).toEqual([]);
  });
});
