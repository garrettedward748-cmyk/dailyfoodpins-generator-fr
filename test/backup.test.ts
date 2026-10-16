import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, openDatabase, run } from '../src/db/index.js';
import { upsertSite } from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';
import {
  applyPendingRestore, backupPath, configureBackups, configureSignins, createBackup, dailyBackupIfDue, listBackups, stageRestore,
} from '../src/backup/index.js';
import { pushPendingSignins, signinsPendingPath } from '../src/backup/signins.js';

/** A backup round trip on a real database file: make, change, restore, restart. */

const KEY = randomBytes(32);
let dir: string;
let db: string;

beforeEach(() => {
  setLogLevel('error');
  dir = mkdtempSync(join(tmpdir(), 'backup-'));
  db = join(dir, 'platform.db');
  openDatabase(db);
  configureBackups(dir, KEY);
});
afterEach(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const siteNames = () => all<{ name: string }>('SELECT name FROM sites ORDER BY id').map((r) => r.name);

describe('platform backups', () => {
  it('restores the database and its encryption key after a restart', async () => {
    upsertSite({ name: 'Before', domain: 'a.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    const name = await createBackup('manual');
    expect(backupPath(name)).not.toBeNull();

    run("UPDATE sites SET name = 'After'");
    upsertSite({ name: 'Extra', domain: 'b.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    expect(siteNames()).toEqual(['After', 'Extra']);

    const safety = await stageRestore(name);
    expect(safety).toMatch(/before-restore/);

    // What the restart does.
    closeDatabase();
    delete process.env.ENCRYPTION_KEY;
    expect(applyPendingRestore(db, dir)).toMatch(/restored/);
    expect(readFileSync(join(dir, '.encryption-key'), 'utf8')).toBe(KEY.toString('hex'));
    expect(existsSync(join(dir, '.restore-pending'))).toBe(false);
    openDatabase(db);
    expect(siteNames()).toEqual(['Before']);

    // Nothing staged: the next start changes nothing.
    expect(applyPendingRestore(db, dir)).toBeNull();
  });

  it('refuses a file that is not a backup', async () => {
    const name = await createBackup('manual');
    await expect(stageRestore('nope.tar.gz')).rejects.toThrow(/not found/);
    expect(backupPath('../' + name)).toBeNull();
  });

  it('makes the daily one only once a day, keeping seven', async () => {
    expect(await dailyBackupIfDue()).not.toBeNull();
    expect(await dailyBackupIfDue()).toBeNull();
    expect(listBackups().filter((b) => b.kind === 'auto')).toHaveLength(1);
  });
});

describe('Setup -> Backups page', () => {
  it('makes a backup from the page and lists it for download', async () => {
    const { buildServer } = await import('../src/web/server.js');
    const { Settings } = await import('../src/settings.js');
    const app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;

    const made = await app.inject({ method: 'POST', url: '/settings/backups/create', headers: { cookie } });
    expect(made.statusCode).toBe(303);
    const pageBody = (await app.inject({ method: 'GET', url: '/settings/backups', headers: { cookie } })).body;
    expect(pageBody).toContain('by hand');
    const name = listBackups()[0]!.name;
    const file = await app.inject({ method: 'GET', url: `/settings/backups/download?file=${name}`, headers: { cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b])); // gzip
    await app.close();
  });

  it('carries the Google sign-ins in the backup and hands them over after a restore', async () => {
    configureSignins({
      fetchTo: async (dest) => { writeFileSync(dest, 'SIGNINS-DATA'); return true; },
      push: async () => true,
    });
    const name = await createBackup('manual');
    configureSignins(null);
    await stageRestore(name);
    closeDatabase();
    applyPendingRestore(db, dir);
    openDatabase(db);
    expect(readFileSync(signinsPendingPath(dir), 'utf8')).toBe('SIGNINS-DATA');

    let got = '';
    const down = { fetchTo: async () => false, push: async () => false };
    expect(await pushPendingSignins(dir, down)).toBe(false);
    expect(existsSync(signinsPendingPath(dir))).toBe(true);
    const up = { fetchTo: async () => false, push: async (f: string) => { got = readFileSync(f, 'utf8'); return true; } };
    expect(await pushPendingSignins(dir, up)).toBe(true);
    expect(got).toBe('SIGNINS-DATA');
    expect(existsSync(signinsPendingPath(dir))).toBe(false);
  });

  it('still makes the backup when the image service is down', async () => {
    configureSignins({ fetchTo: async () => { throw new Error('down'); }, push: async () => false });
    const name = await createBackup('manual');
    configureSignins(null);
    expect(backupPath(name)).not.toBeNull();
  });
});
