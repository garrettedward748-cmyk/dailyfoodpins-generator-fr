import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { configureBackups, listBackups } from '../src/backup/index.js';
import { encrypt } from '../src/lib/crypto.js';
import {
  addProfile, createReel, createRun, deleteSite, firstProfile, getSite, getSiteByDomain, insertKeyword, listBufferAccounts,
  listProfiles, markRunFailed, markRunPublished, setLink, siteSecrets, updateProfile, upsertBufferAccount, upsertSite,
} from '../src/db/repos.js';
import {
  buildSiteBackup, encodeSiteBackup, parseSiteBackup, restoreSiteBackup, siteBackupName, type SiteBackupFile,
} from '../src/backup/site.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * A backup of one site, and putting it back.
 *
 * The cases that matter: it works on a platform with a different encryption key
 * and different row numbers (every reference has to be remapped, not copied);
 * restoring over an existing site returns it to the backup without touching any
 * other site; and a file that fails halfway leaves the site as it was.
 */

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
});
afterEach(() => closeDatabase());

interface Seeded { siteId: number; otherId: number; pinterest: number; fb1: number; fb2: number; }

/** One site with a bit of everything, and a second site that must stay out of its backup. */
function seed(key: Buffer): Seeded {
  const siteId = upsertSite({ name: 'A', domain: 'a.com', status: 'active', daily_target: 3, interval_minutes: 90, apiToken: 'api-token-A', bufferToken: 'buffer-token-A' }, key);
  const otherId = upsertSite({ name: 'Other', domain: 'other.com', status: 'active', daily_target: 1, interval_minutes: 60, apiToken: 'api-token-O' }, key);
  run("UPDATE sites SET gsc_property = 'sc-domain:a.com', radar_on = 1, post_to_all = 'facebook' WHERE id = ?", siteId);

  const pinterest = firstProfile(siteId, 'pinterest').id;
  updateProfile(pinterest, { default_board: 'Dinner', board_map: 'chicken = Chicken Dinners' });
  const fb1 = firstProfile(siteId, 'facebook').id;
  const fb2 = addProfile(siteId, 'facebook');
  upsertBufferAccount({ siteId, label: 'pin', token: 'tok-pin', enabled: true, platform: 'pinterest', profileId: pinterest }, key);
  upsertBufferAccount({ siteId, label: 'fb1', token: 'tok-fb1', enabled: true, platform: 'facebook', profileId: fb1 }, key);
  upsertBufferAccount({ siteId, label: 'fb2', token: 'tok-fb2', enabled: true, platform: 'facebook', profileId: fb2 }, key);

  const k1 = insertKeyword({ seed_keyword: 'chicken', spy_title: 'Lemon Chicken' });
  const k2 = insertKeyword({ seed_keyword: 'bread', spy_title: 'Garlic Bread' });
  const shared = insertKeyword({ seed_keyword: 'soup', spy_title: 'Tomato Soup' });
  const otherOnly = insertKeyword({ seed_keyword: 'cake', spy_title: 'Plain Cake' });
  setLink(k1, siteId, 'done');
  setLink(k2, siteId, 'go');
  setLink(shared, siteId, 'go');
  setLink(shared, otherId, 'go');
  setLink(otherOnly, otherId, 'go');
  run("INSERT INTO keyword_images (keyword_id, feature_url, top_shot_url, texture_macro_url, before_after_url, source_site_id) VALUES (?, 'f', 't', 'm', 'b', ?)", k1, siteId);

  run("INSERT INTO blog_questions (site_id, question, status) VALUES (?, 'Can I freeze it?', 'queued')", siteId);
  run("INSERT INTO blog_questions (site_id, question, status) VALUES (?, 'Other question', 'queued')", otherId);
  run("INSERT INTO social_sources (site_id, handle) VALUES (?, 'somepage')", siteId);
  const source = get<{ id: number }>('SELECT id FROM social_sources WHERE site_id = ?', siteId)!.id;
  run("INSERT INTO social_posts (site_id, source_id, post_id, title) VALUES (?, ?, 'p1', 'An idea')", siteId, source);
  run("INSERT INTO gsc_opportunities (site_id, query, kind) VALUES (?, 'best lemon chicken', 'recipe')", siteId);
  run("INSERT INTO taxonomy_jobs (site_id, tbl, term_id, name) VALUES (?, 'tags', 7, 'Lemon')", siteId);

  // History: one published (with the accounts it went to), one failed with its
  // steps, one still running (which must not travel), and one on the other site.
  const published = createRun(k1, siteId);
  markRunPublished(published, 'post-1', 'https://a.com/lemon-chicken', 'Lemon Chicken');
  run('UPDATE runs SET profiles_json = ?, fanout_json = ?, pin_design_id = 4 WHERE id = ?',
    JSON.stringify({ pinterest: pinterest, facebook: fb2 }), JSON.stringify({ facebook: { [fb1]: 'x1', [fb2]: 'x2' } }), published);
  run("INSERT INTO run_steps (run_id, step, status, output_json) VALUES (?, 'write', 'ok', '{\"done\":true}')", published);
  const failed = createRun(k2, siteId);
  markRunFailed(failed, 'boom', 'images');
  run("INSERT INTO run_steps (run_id, step, status, output_json) VALUES (?, 'write', 'ok', '{\"article\":1}')", failed);
  createRun(shared, siteId); // left running
  createRun(otherOnly, otherId);

  const reel = createReel({ runId: published, siteId, keywordId: k1, fbPageId: null, prompt: 'p', caption: 'c', references: [] });
  run('UPDATE reels SET status = ?, output_path = ?, channels_json = ? WHERE id = ?', 'published', '/data/reels/x.mp4',
    JSON.stringify({ [`facebook:${fb1}`]: { ok: 1 }, [`facebook:${fb2}`]: { ok: 2 }, targets: { facebook: [fb1, fb2] } }), reel);
  createReel({ runId: null, siteId, keywordId: k2, fbPageId: null, prompt: 'p', caption: 'c', references: [] }); // a draft: stays behind

  run("INSERT INTO fb_pages (page_id, name, site_id, posts, reels) VALUES ('manual-1', 'Chicken Page', ?, 1, 1)", siteId);
  // The other site's page must not travel.
  run("INSERT INTO fb_pages (page_id, name, site_id, posts, reels) VALUES ('manual-2', 'Other Page', ?, 1, 1)", otherId);
  return { siteId, otherId, pinterest, fb1, fb2 };
}

/** What a platform holds for a site, in a form that does not depend on row numbers. */
function snapshot(siteId: number, key: Buffer) {
  const site = getSite(siteId)!;
  return {
    name: site.name,
    target: site.daily_target,
    secrets: siteSecrets(site, key),
    profiles: listProfiles(siteId).map((p) => `${p.platform}/${p.position}/${p.label}/${p.default_board}/${p.board_map}`),
    tokens: listBufferAccounts(siteId, key).map((a) => `${a.label}=${a.token}`).sort(),
    keywords: all<{ t: string; s: string }>(
      `SELECT k.spy_title AS t, ks.status AS s FROM keyword_sites ks JOIN keywords k ON k.id = ks.keyword_id
        WHERE ks.site_id = ? ORDER BY k.spy_title`, siteId).map((r) => `${r.t}:${r.s}`),
    blog: all<{ question: string }>('SELECT question FROM blog_questions WHERE site_id = ?', siteId).map((r) => r.question),
    runs: all<{ status: string }>('SELECT status FROM runs WHERE site_id = ? ORDER BY id', siteId).map((r) => r.status),
  };
}

/** A run that is running never travels, so a restored site does not have it. */
const withoutRunning = (snap: ReturnType<typeof snapshot>) => ({ ...snap, runs: snap.runs.filter((s) => s !== 'running') });

/** Seed leaves one run running; a restore over the site refuses that, so settle it. */
const settleRuns = () => run("UPDATE runs SET status = 'cancelled' WHERE status = 'running'");

describe('building a site backup', () => {
  it('holds this site and nothing of another, with its tokens readable', () => {
    const ids = seed(KEY_A);
    const { file, warnings } = buildSiteBackup(ids.siteId, KEY_A);
    expect(warnings).toEqual([]);
    expect(file.domain).toBe('a.com');
    expect(file.site.api_token).toBe('api-token-A');
    expect(file.site.buffer_token).toBe('buffer-token-A');
    expect(file.site).not.toHaveProperty('api_token_encrypted');
    expect(file.bufferAccounts.map((a) => a.token).sort()).toEqual(['tok-fb1', 'tok-fb2', 'tok-pin']);

    const titles = file.keywords.map((k) => k.row.spy_title).sort();
    expect(titles).toEqual(['Garlic Bread', 'Lemon Chicken', 'Tomato Soup']); // not "Plain Cake"
    expect(file.blogQuestions.map((q) => q.question)).toEqual(['Can I freeze it?']);

    // History: the running run and the draft reel stay behind; steps travel only for the failed run.
    expect(file.runs.map((r) => r.status).sort()).toEqual(['failed', 'published']);
    expect(file.runSteps).toHaveLength(1);
    expect(file.reels).toHaveLength(1);
    expect(file.fbPages.map((p) => p.name)).toEqual(['Chicken Page']);
  });

  it('says so when a token cannot be read, rather than writing nonsense', () => {
    const ids = seed(KEY_A);
    const { file, warnings } = buildSiteBackup(ids.siteId, KEY_B); // the wrong key
    expect(warnings[0]).toMatch(/could not be read/);
    expect(file.site.api_token).toBe('');
  });

  it('names the file after the site', () => {
    expect(siteBackupName('my-site.com', new Date('2026-10-05T19:30:00Z'))).toBe('site-my-site.com-20261005-1930.json.gz');
  });
});

describe('restoring onto another platform', () => {
  /** Make the backup on platform A, then open a platform B that numbers everything differently. */
  function moveToNewPlatform(): { file: SiteBackupFile; before: ReturnType<typeof snapshot> } {
    const ids = seed(KEY_A);
    const before = snapshot(ids.siteId, KEY_A);
    const bytes = encodeSiteBackup(buildSiteBackup(ids.siteId, KEY_A).file);
    closeDatabase();

    openDatabase(':memory:');
    // Rows that shift every id: another site with accounts and keywords of its own.
    const filler = upsertSite({ name: 'F', domain: 'filler.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY_B);
    for (let i = 0; i < 4; i++) addProfile(filler, 'facebook');
    for (let i = 0; i < 5; i++) insertKeyword({ seed_keyword: `f${i}`, spy_title: `Filler ${i}` });
    return { file: parseSiteBackup(bytes), before };
  }

  it('creates the site with everything, tokens sealed with the new key', () => {
    const { file, before } = moveToNewPlatform();
    const report = restoreSiteBackup(file, KEY_B);
    expect(report.created).toBe(true);

    const site = getSiteByDomain('a.com')!;
    expect(snapshot(site.id, KEY_B)).toEqual(withoutRunning(before));
    expect(report.counts).toMatchObject({ accounts: 3, bufferTokens: 3, keywords: 3, runs: 2, reels: 1 });
    expect(get('SELECT 1 FROM sites WHERE domain = ?', 'other.com')).toBeUndefined();
    expect(site.status).toBe('active');
    expect(get<{ g: string }>('SELECT gsc_property AS g FROM sites WHERE id = ?', site.id)!.g).toBe('sc-domain:a.com');
    expect(get<{ p: string }>('SELECT post_to_all AS p FROM sites WHERE id = ?', site.id)!.p).toBe('facebook');
  });

  it('points every reference at the new rows, not the old numbers', () => {
    const { file } = moveToNewPlatform();
    restoreSiteBackup(file, KEY_B);
    const site = getSiteByDomain('a.com')!;
    const fb = listProfiles(site.id, 'facebook').map((p) => p.id);
    const pin = listProfiles(site.id, 'pinterest')[0]!.id;

    // Buffer tokens follow their own account.
    const accounts = all<{ label: string; profile_id: number }>('SELECT label, profile_id FROM buffer_accounts WHERE site_id = ?', site.id);
    expect(accounts.find((a) => a.label === 'pin')!.profile_id).toBe(pin);
    expect(fb).toContain(accounts.find((a) => a.label === 'fb1')!.profile_id);

    // A run remembers which accounts it used; those must be this site's accounts now.
    const published = get<{ profiles_json: string; fanout_json: string; keyword_id: number; pin_design_id: number }>(
      "SELECT * FROM runs WHERE site_id = ? AND status = 'published'", site.id)!;
    const chosen = JSON.parse(published.profiles_json) as Record<string, number>;
    expect(chosen.pinterest).toBe(pin);
    expect(fb).toContain(chosen.facebook);
    const fanned = Object.keys((JSON.parse(published.fanout_json) as { facebook: Record<string, string> }).facebook).map(Number);
    expect(fanned.sort()).toEqual([...fb].sort());
    expect(published.pin_design_id).toBe(4); // rotation history survives

    // The reel's record of where it went, and the run and keyword it belongs to.
    const reel = get<{ channels_json: string; run_id: number; keyword_id: number; output_path: string }>('SELECT * FROM reels WHERE site_id = ?', site.id)!;
    const channels = JSON.parse(reel.channels_json) as { targets: { facebook: number[] } } & Record<string, unknown>;
    expect(Object.keys(channels).filter((k) => k.startsWith('facebook:')).map((k) => Number(k.split(':')[1])).sort()).toEqual([...fb].sort());
    expect(channels.targets.facebook.sort()).toEqual([...fb].sort());
    expect(reel.run_id).toBe(published.id);
    expect(get<{ spy_title: string }>('SELECT spy_title FROM keywords WHERE id = ?', reel.keyword_id)!.spy_title).toBe('Lemon Chicken');
    expect(reel.output_path).toBe('');

    // Steps came only for the run that can resume, onto that run.
    const steps = all<{ step: string; run_id: number }>('SELECT s.step, s.run_id FROM run_steps s JOIN runs r ON r.id = s.run_id WHERE r.site_id = ?', site.id);
    expect(steps).toHaveLength(1);
    expect(get<{ status: string }>('SELECT status FROM runs WHERE id = ?', steps[0]!.run_id)!.status).toBe('failed');

    // Radar posts follow their source; images keep the keyword and name this site as the source.
    expect(all('SELECT 1 FROM social_posts p JOIN social_sources s ON s.id = p.source_id WHERE p.site_id = ? AND s.site_id = ?', site.id, site.id)).toHaveLength(1);
    expect(get<{ source_site_id: number }>('SELECT source_site_id FROM keyword_images')!.source_site_id).toBe(site.id);
  });

  it('brings the Facebook pages of the site, given to its new id, once', () => {
    const { file } = moveToNewPlatform();
    restoreSiteBackup(file, KEY_B);
    const site = getSiteByDomain('a.com')!;
    expect(all<{ name: string }>('SELECT name FROM fb_pages WHERE site_id = ?', site.id)).toEqual([{ name: 'Chicken Page' }]);
    expect(all("SELECT 1 FROM fb_pages WHERE name = 'Other Page'")).toHaveLength(0);
    restoreSiteBackup(file, KEY_B); // a second time: the page is there, so nothing is added
    expect(all("SELECT 1 FROM fb_pages WHERE name = 'Chicken Page'")).toHaveLength(1);
  });

  it('a page this platform already has for another site stays there, with a warning', () => {
    const { file } = moveToNewPlatform();
    const filler = getSiteByDomain('filler.com')!;
    run("INSERT INTO fb_pages (page_id, name, site_id, posts, reels, enabled) VALUES ('manual-1', 'Chicken Page', ?, 1, 1, 1)", filler.id);
    const report = restoreSiteBackup(file, KEY_B);
    expect(get<{ site_id: number }>("SELECT site_id FROM fb_pages WHERE page_id = 'manual-1'")!.site_id).toBe(filler.id);
    expect(report.warnings.join(' ')).toContain('Chicken Page');
  });
});

describe('restoring over a site that exists', () => {
  it('returns the site to the backup and leaves every other site alone', () => {
    const ids = seed(KEY_A);
    const before = snapshot(ids.siteId, KEY_A);
    const { file } = buildSiteBackup(ids.siteId, KEY_A);
    settleRuns();
    const otherBefore = snapshot(ids.otherId, KEY_A);

    // Damage it: rename, change a token, drop a keyword, add an account, a question and a run.
    run("UPDATE sites SET name = 'Broken', daily_target = 0 WHERE id = ?", ids.siteId);
    upsertSite({ name: 'Broken', domain: 'a.com', status: 'active', daily_target: 0, interval_minutes: 90, apiToken: 'wrong' }, KEY_A);
    run('DELETE FROM keyword_sites WHERE site_id = ? AND keyword_id = (SELECT id FROM keywords WHERE spy_title = ?)', ids.siteId, 'Lemon Chicken');
    addProfile(ids.siteId, 'instagram');
    run("INSERT INTO blog_questions (site_id, question) VALUES (?, 'Added later')", ids.siteId);
    markRunFailed(createRun(insertKeyword({ seed_keyword: 'z', spy_title: 'Zed' }), ids.siteId), 'x', 'y');

    const keywordsBefore = all('SELECT 1 FROM keywords').length;
    const report = restoreSiteBackup(parseSiteBackup(encodeSiteBackup(file)), KEY_A);

    expect(report.created).toBe(false);
    const restored = snapshot(ids.siteId, KEY_A);
    expect(restored).toEqual(withoutRunning(before));
    expect(getSite(ids.siteId)!.id).toBe(ids.siteId); // same site, not a new one
    expect(snapshot(ids.otherId, KEY_A)).toEqual(otherBefore);
    // Keywords already here (including the one shared with another site) are linked, not duplicated.
    expect(all('SELECT 1 FROM keywords')).toHaveLength(keywordsBefore);
    expect(report.warnings.join(' ')).toMatch(/already on this platform/);
  });

  it('leaves the site as it was when the file turns out to be broken', () => {
    const ids = seed(KEY_A);
    const { file } = buildSiteBackup(ids.siteId, KEY_A);
    settleRuns();
    run("UPDATE sites SET name = 'Keep me' WHERE id = ?", ids.siteId);
    const damaged = snapshot(ids.siteId, KEY_A);

    // Two questions with the same text: the second insert fails, deep inside the restore.
    file.blogQuestions.push({ ...file.blogQuestions[0]! });
    expect(() => restoreSiteBackup(file, KEY_A)).toThrow(/UNIQUE|constraint/i);
    expect(snapshot(ids.siteId, KEY_A)).toEqual(damaged);
  });

  it('will not replace a site while an article is being made for it', () => {
    const ids = seed(KEY_A); // seed leaves one run running on the site
    const { file } = buildSiteBackup(ids.siteId, KEY_A);
    expect(() => restoreSiteBackup(file, KEY_A)).toThrow(/being made/);
  });
});

describe('reading a file', () => {
  it('reads both compressed and plain JSON', () => {
    const ids = seed(KEY_A);
    const { file } = buildSiteBackup(ids.siteId, KEY_A);
    expect(parseSiteBackup(encodeSiteBackup(file)).domain).toBe('a.com');
    expect(parseSiteBackup(Buffer.from(JSON.stringify(file))).domain).toBe('a.com');
  });

  it('refuses what is not a site backup, in words', () => {
    expect(() => parseSiteBackup(Buffer.from('not json at all'))).toThrow(/not a site backup/);
    expect(() => parseSiteBackup(Buffer.from('{"hello":1}'))).toThrow(/not a site backup/);
    expect(() => parseSiteBackup(Buffer.from('{"kind":"site-backup","format":99,"domain":"a.com","site":{}}'))).toThrow(/newer version/);
    expect(() => parseSiteBackup(Buffer.from('{"kind":"site-backup","format":1,"site":{}}'))).toThrow(/incomplete/);
  });

  it('ignores columns this platform does not have, and fills the ones the file lacks', () => {
    const ids = seed(KEY_A);
    const { file } = buildSiteBackup(ids.siteId, KEY_A);
    closeDatabase();
    openDatabase(':memory:');
    (file.site as Record<string, unknown>).a_column_from_the_future = 'x';
    delete (file.site as Record<string, unknown>).radar_hour; // as if written before that column existed
    restoreSiteBackup(file, KEY_B);
    const site = getSiteByDomain('a.com')!;
    expect(get<{ h: number }>('SELECT radar_hour AS h FROM sites WHERE id = ?', site.id)!.h).toBe(6); // the default
  });
});

describe('Sites page: Back up and Restore', () => {
  let dir: string;
  beforeEach(() => {
    // The restore route saves a full platform backup first, which needs a real file.
    closeDatabase();
    dir = mkdtempSync(join(tmpdir(), 'site-backup-'));
    openDatabase(join(dir, 'platform.db'));
    configureBackups(dir, KEY_A);
  });
  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  async function login() {
    const { buildServer } = await import('../src/web/server.js');
    const { Settings } = await import('../src/settings.js');
    const app = buildServer(new Settings(KEY_A), KEY_A, { password: 'correct-horse-battery-staple', secret: KEY_A, generated: false });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return { app, cookie: String(res.headers['set-cookie']).split(';')[0]! };
  }

  const upload = (filename: string, content: Buffer) => {
    const boundary = '----sitebackuptest';
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/gzip\r\n\r\n`);
    return {
      payload: Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  };
  const flash = (location: unknown) => decodeURIComponent(String(location).split(/[?&](?:ok|error|warn)=/)[1] ?? '');

  it('offers the file, and it can be read back', async () => {
    const ids = seed(KEY_A);
    const { app, cookie } = await login();
    const page = (await app.inject({ method: 'GET', url: '/sites', headers: { cookie } })).body;
    expect(page).toContain(`/sites/${ids.siteId}/backup`);
    expect(page).toContain('Restore a site');

    const res = await app.inject({ method: 'GET', url: `/sites/${ids.siteId}/backup`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="site-a\.com-\d{8}-\d{4}\.json\.gz"/);
    expect(res.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(parseSiteBackup(res.rawPayload).domain).toBe('a.com');
    await app.close();
  });

  it('sends a stale link for a site that is gone back to the list, not to a bare 404', async () => {
    const { app, cookie } = await login();
    const res = await app.inject({ method: 'GET', url: '/sites/9999/backup', headers: { cookie } });
    expect(res.statusCode).toBe(303);
    expect(flash(res.headers.location)).toBe('Site not found');
    await app.close();
  });

  it('refuses to hand over a file that would lack a token, and says which', async () => {
    const ids = seed(KEY_A);
    run('UPDATE sites SET api_token_encrypted = ? WHERE id = ?', encrypt('old', randomBytes(32)), ids.siteId); // saved under another key
    const { app, cookie } = await login();
    const res = await app.inject({ method: 'GET', url: `/sites/${ids.siteId}/backup`, headers: { cookie } });
    expect(res.statusCode).toBe(303);
    expect(flash(res.headers.location)).toMatch(/Not backed up: 1 token could not be read/);
    await app.close();
  });

  it('brings a deleted site back from the file, after saving a full backup', async () => {
    const ids = seed(KEY_A);
    const before = snapshot(ids.siteId, KEY_A);
    const { app, cookie } = await login();
    const file = (await app.inject({ method: 'GET', url: `/sites/${ids.siteId}/backup`, headers: { cookie } })).rawPayload;

    deleteSite(ids.siteId);
    expect(getSiteByDomain('a.com')).toBeUndefined();

    const res = await app.inject({ method: 'POST', url: '/sites/restore', headers: { cookie, ...upload('site-a.com.json.gz', file).headers }, payload: upload('site-a.com.json.gz', file).payload });
    expect(res.statusCode).toBe(303);
    expect(flash(res.headers.location)).toMatch(/a\.com created from the backup: 3 accounts, 3 keywords, 2 runs, 1 reel/);
    expect(snapshot(getSiteByDomain('a.com')!.id, KEY_A)).toEqual(withoutRunning(before));
    expect(listBackups().some((b) => b.kind === 'before-restore')).toBe(true);
    await app.close();
  });

  it('says what is wrong with a file that is not a site backup, and changes nothing', async () => {
    const ids = seed(KEY_A);
    const { app, cookie } = await login();
    const bad = upload('notes.json.gz', Buffer.from('hello'));
    const res = await app.inject({ method: 'POST', url: '/sites/restore', headers: { cookie, ...bad.headers }, payload: bad.payload });
    expect(res.statusCode).toBe(303);
    expect(flash(res.headers.location)).toMatch(/Restore failed, nothing was changed: This file cannot be read/);
    expect(getSite(ids.siteId)!.name).toBe('A');

    const wrongName = upload('photo.png', Buffer.from('x'));
    const res2 = await app.inject({ method: 'POST', url: '/sites/restore', headers: { cookie, ...wrongName.headers }, payload: wrongName.payload });
    expect(flash(res2.headers.location)).toMatch(/Choose a site backup file/);
    await app.close();
  });
});
