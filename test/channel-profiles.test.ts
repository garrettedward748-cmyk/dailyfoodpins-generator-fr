import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDb, openDatabase, run } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrations.js';
import {
  addProfile, createRun, firstProfile, insertKeyword, listBufferAccounts, listProfiles, pickProfile, runProfile,
  updateProfile, upsertBufferAccount, upsertSite,
} from '../src/db/repos.js';
import { encrypt } from '../src/lib/crypto.js';
import { setLogLevel } from '../src/lib/logger.js';

/** Several accounts per network per site, used in turn; the old settings became account 1. */

const KEY = randomBytes(32);
beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => closeDatabase());

const site = (domain = 's.com') =>
  upsertSite({ name: domain, domain, status: 'active', pin_username: 'buzz', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);

describe('turns', () => {
  it('sends a site\'s articles to its accounts in turn, skipping one with no Buffer token', () => {
    const id = site();
    const p1 = firstProfile(id, 'pinterest');
    const p2 = (addProfile(id, 'pinterest'));
    const p3 = (addProfile(id, 'pinterest'));
    upsertBufferAccount({ siteId: id, label: 'a', token: 't1', enabled: true, profileId: p1.id }, KEY);
    upsertBufferAccount({ siteId: id, label: 'b', token: 't2', enabled: true, profileId: p2 }, KEY);
    // p3 has no token: never chosen while the others can post
    const order = [1, 2, 3, 4].map(() => pickProfile(id, 'pinterest')!.id);
    expect(order).toEqual([p1.id, p2, p1.id, p2]);
    expect(order).not.toContain(p3);
  });

  it('keeps each site to its own accounts', () => {
    const a = site('a.com');
    const b = site('b.com');
    const pa = firstProfile(a, 'facebook');
    const pb = firstProfile(b, 'facebook');
    upsertBufferAccount({ siteId: a, label: 'a', token: 't', enabled: true, profileId: pa.id }, KEY);
    upsertBufferAccount({ siteId: b, label: 'b', token: 't', enabled: true, profileId: pb.id }, KEY);
    expect(pickProfile(a, 'facebook')!.site_id).toBe(a);
    expect(pickProfile(b, 'facebook')!.site_id).toBe(b);
  });

  it('keeps a run on the account it was given, for a resume and its reel', () => {
    const id = site();
    const p1 = firstProfile(id, 'pinterest');
    const p2 = (addProfile(id, 'pinterest'));
    for (const p of [p1.id, p2]) upsertBufferAccount({ siteId: id, label: String(p), token: 't', enabled: true, profileId: p }, KEY);
    const kw = insertKeyword({ seed_keyword: 'dessert', spy_title: 'Lemon Bars' });
    const runA = createRun(kw, id, 'live');
    const runB = createRun(kw, id, 'live');
    const a = runProfile(runA, id, 'pinterest')!.id;
    const b = runProfile(runB, id, 'pinterest')!.id;
    expect(a).not.toBe(b);
    expect(runProfile(runA, id, 'pinterest')!.id).toBe(a);
    expect(runProfile(runB, id, 'pinterest')!.id).toBe(b);
  });

  it('skips an account switched off', () => {
    const id = site();
    const p1 = firstProfile(id, 'instagram');
    const p2 = (addProfile(id, 'instagram'));
    for (const p of [p1.id, p2]) upsertBufferAccount({ siteId: id, label: String(p), token: 't', enabled: true, profileId: p }, KEY);
    updateProfile(p1.id, { enabled: 0 });
    expect([pickProfile(id, 'instagram')!.id, pickProfile(id, 'instagram')!.id]).toEqual([p2, p2]);
  });
});

describe('moving the old settings over', () => {
  it('makes account 1 of each network from the site\'s settings and tokens', () => {
    const id = site();
    run("UPDATE sites SET pin_default_board = 'Easy', pin_board_map = 'soup = Soups', ig_posts = 1 WHERE id = ?", id);
    run('DELETE FROM channel_profiles');
    run('DELETE FROM buffer_accounts');
    const insert = (label: string, platform: string) =>
      run('INSERT INTO buffer_accounts (site_id, label, token_encrypted, position, platform) VALUES (?, ?, ?, 1, ?)', id, label, encrypt('tok', KEY), platform);
    insert('Pins', 'pinterest');
    insert('Shared', 'both');
    run("DELETE FROM schema_migrations WHERE id = '029-channel-profiles'");
    runMigrations(getDb());

    const pin = listProfiles(id, 'pinterest');
    expect(pin).toHaveLength(1);
    expect(pin[0]).toMatchObject({ channel_name: 'buzz', default_board: 'Easy', board_map: 'soup = Soups', label: 'Pinterest 1' });
    const fb = listProfiles(id, 'facebook')[0]!;
    const ig = listProfiles(id, 'instagram')[0]!;
    const tokens = listBufferAccounts(id, KEY);
    expect(tokens.filter((t) => t.profileId === pin[0]!.id).map((t) => t.label).sort()).toEqual(['Pins', 'Shared']);
    expect(tokens.filter((t) => t.profileId === fb.id).map((t) => t.label)).toEqual(['Shared']);
    // Instagram borrowed the Facebook tokens before it had its own
    expect(tokens.filter((t) => t.profileId === ig.id).map((t) => t.label)).toEqual(['Shared']);
  });
});

describe('what the cards say each network gets', () => {
  it('shows Facebook posts + reels from the site\'s page, and why a switch does nothing', async () => {
    const { buildServer } = await import('../src/web/server.js');
    const { Settings } = await import('../src/settings.js');
    const { addManualFbPage, setInstagramPublishing } = await import('../src/db/repos.js');
    const id = site();
    const pageId = addManualFbPage({ name: 'Sandra', siteId: id });
    run('UPDATE fb_pages SET posts = 1, reels = 1 WHERE id = ?', pageId);
    setInstagramPublishing(id, true, true);
    const settings = new Settings(KEY);
    settings.set('fb_enabled', 'true');
    settings.set('reel_publisher', 'buffer');
    const app = buildServer(settings, KEY, { password: 'pw-1234567890', secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=pw-1234567890', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const header = (body: string, net: string) => body.slice(body.indexOf(`id="net-${net}"`), body.indexOf('</summary>', body.indexOf(`id="net-${net}"`)));

    let body = (await app.inject({ method: 'GET', url: `/accounts/${id}`, headers: { cookie } })).body;
    expect(header(body, 'facebook')).toContain('posts + reels');
    expect(header(body, 'instagram')).toContain('posts + reels');

    settings.set('reel_publisher', 'facebook');
    body = (await app.inject({ method: 'GET', url: `/accounts/${id}`, headers: { cookie } })).body;
    expect(header(body, 'facebook')).toContain('posts: set Publish reels through Buffer');
    expect(header(body, 'instagram')).toContain('>posts<');
    expect(header(body, 'instagram')).toContain('reels: set Publish reels through Buffer');

    settings.set('fb_enabled', 'false');
    body = (await app.inject({ method: 'GET', url: `/accounts/${id}`, headers: { cookie } })).body;
    expect(header(body, 'facebook')).toContain('>nothing<');
    expect(header(body, 'pinterest')).toContain('>posts<');
    await app.close();
  });
});
