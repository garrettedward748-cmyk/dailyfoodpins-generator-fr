import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { firstProfile, getProfile, listBufferAccounts, listProfiles, updateProfile, upsertBufferAccount, upsertSite } from '../src/db/repos.js';
import { BufferPool } from '../src/integrations/buffer-pool.js';
import { BufferClient } from '../src/integrations/buffer.js';
import { runMigrations } from '../src/db/migrations.js';
import { getDb } from '../src/db/index.js';
import { encrypt } from '../src/lib/crypto.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Buffer accounts belong to a network. Pins go through Pinterest accounts,
 * reels through Facebook accounts, and an account marked for both serves
 * either. They are managed on Channels -> Pinterest and Channels -> Facebook;
 * the Sites form no longer carries them.
 */

const KEY = randomBytes(32);

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
});
afterEach(() => closeDatabase());

const site = (): number =>
  upsertSite(
    { name: 'D', domain: 'd.com', status: 'active', pin_username: 'recipesbuzz', project_id: '', daily_target: 1, interval_minutes: 60 },
    KEY,
  );

describe('accounts per network', () => {
  it('files every token under an account of its network; an unmarked one goes to Pinterest 1', () => {
    const id = site();
    upsertBufferAccount({ siteId: id, label: 'Pins', token: 'p', enabled: true, platform: 'pinterest' }, KEY);
    upsertBufferAccount({ siteId: id, label: 'Reels', token: 'f', enabled: true, platform: 'facebook' }, KEY);
    upsertBufferAccount({ siteId: id, label: 'Both', token: 'b', enabled: true }, KEY);

    const pins = new BufferPool({ id, domain: 'd.com', pinUsername: '', platform: 'pinterest' }, KEY);
    const reels = new BufferPool({ id, domain: 'd.com', pinUsername: '', platform: 'facebook' }, KEY);
    expect(pins.size).toBe(2);
    expect(pins.current?.label).toBe('Pins');
    expect(reels.size).toBe(1);
    expect(reels.current?.label).toBe('Reels');
    expect(listBufferAccounts(id, KEY).every((a) => a.profileId !== null)).toBe(true);
  });

  it('keeps the Pinterest username when the site form is saved without it', () => {
    const id = site();
    upsertSite({ name: 'D2', domain: 'd.com', status: 'active', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY, id);
    expect(get<{ pin_username: string }>('SELECT pin_username FROM sites WHERE id = ?', id)?.pin_username).toBe('recipesbuzz');
  });

  it('turns a token typed into the old site form into a shared account', () => {
    run('DELETE FROM schema_migrations WHERE id = ?', '014-buffer-accounts-per-platform');
    const id = site();
    run('UPDATE sites SET buffer_token_encrypted = ? WHERE id = ?', encrypt('legacy', KEY), id);
    runMigrations(getDb());
    const accounts = listBufferAccounts(id, KEY);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ token: 'legacy', platform: 'both' });
  });
});

describe('the channel pages', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterEach(async () => app.close());

  const post = (url: string, fields: Record<string, string>) =>
    app.inject({ method: 'POST', url, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString() });

  it('adds Pinterest 2 with the first account\'s boards, and a Buffer token to it, from Channels -> Accounts', async () => {
    const id = site();
    const first = firstProfile(id, 'pinterest');
    updateProfile(first.id, { channel_name: 'recipesbuzz', default_board: 'Everyday Home Cooking', board_map: 'chicken soup = Chicken Soup Recipes' });

    const add = await post(`/accounts/${id}/pinterest/add`, {});
    expect(add.statusCode).toBe(303);
    const second = listProfiles(id, 'pinterest')[1]!;
    expect(second).toMatchObject({ label: 'Pinterest 2', default_board: 'Everyday Home Cooking', board_map: 'chicken soup = Chicken Soup Recipes', channel_name: '' });

    const r = await post(`/sites/${id}/buffer`, { label: 'Pins 2', token: 't2', profile_id: String(second.id), back: '/accounts', enabled: '1' });
    expect(String(r.headers.location)).toMatch(/^\/accounts\?ok=/);
    expect(listBufferAccounts(id, KEY).find((a) => a.label === 'Pins 2')).toMatchObject({ profileId: second.id, platform: 'pinterest' });

    await post(`/accounts/profile/${second.id}`, { channel_name: 'secondprofile', enabled: '1' });
    expect(getProfile(second.id)?.channel_name).toBe('secondprofile');

    const page = await app.inject({ method: 'GET', url: '/accounts', headers: { cookie } });
    expect(page.body).toContain('Pinterest 2');
    expect(page.body).toContain('Pins 2');
    expect(page.body).toContain('value="secondprofile"');
    expect(page.body).toContain('+ Facebook');
  });

  it('lists the pages on an account\'s own Buffer, for the "Pick from Buffer" button', async () => {
    const id = site();
    const fb = firstProfile(id, 'facebook');
    const get = () => app.inject({ method: 'GET', url: `/accounts/profile/${fb.id}/buffer-channels`, headers: { cookie } });

    // No token yet: told to add one, and Buffer is not asked.
    expect((await get()).statusCode).toBe(409);

    upsertBufferAccount({ siteId: id, label: 'F', token: 'f', enabled: true, profileId: fb.id }, KEY);
    vi.spyOn(BufferClient.prototype, 'getOrganizationId').mockResolvedValue('org');
    vi.spyOn(BufferClient.prototype, 'getChannels').mockResolvedValue([
      { id: 'a', name: 'Kitchen Stories', service: 'facebook', boards: [] },
      { id: 'b', name: 'someinstagram', service: 'instagram', boards: [] },
    ] as never);
    const res = await get();
    expect(res.json()).toEqual({ names: ['Kitchen Stories'] }); // only this network's pages

    const page = await app.inject({ method: 'GET', url: '/accounts', headers: { cookie } });
    expect(page.body).toContain('Pick from Buffer');
    vi.restoreAllMocks();
  });

  it('removes an extra account with its tokens, never the last one of a network', async () => {
    const id = site();
    const first = firstProfile(id, 'facebook');
    await post(`/accounts/${id}/facebook/add`, {});
    const second = listProfiles(id, 'facebook')[1]!;
    upsertBufferAccount({ siteId: id, label: 'F2', token: 'f', enabled: true, profileId: second.id }, KEY);
    await post(`/accounts/profile/${second.id}/delete`, {});
    expect(listProfiles(id, 'facebook').map((p) => p.id)).toEqual([first.id]);
    expect(listBufferAccounts(id, KEY).some((a) => a.label === 'F2')).toBe(false);
    await post(`/accounts/profile/${first.id}/delete`, {});
    expect(listProfiles(id, 'facebook')).toHaveLength(1);
  });

  it('leaves Buffer and Pinterest off the Sites form', async () => {
    const id = site();
    const page = await app.inject({ method: 'GET', url: `/sites/${id}`, headers: { cookie } });
    expect(page.body).not.toContain('name="buffer_token"');
    expect(page.body).not.toContain('name="pin_username"');
    expect(page.body).toContain('name="api_token"');
  });
});

describe('Pinterest posts and reels switches', () => {
  it('turns posts off and reels on for a site, and defaults to posts only', async () => {
    const { setPinterestPublishing, getSite } = await import('../src/db/repos.js');
    const id = site();
    expect(getSite(id)).toMatchObject({ pin_posts: 1, pin_reels: 0 });
    setPinterestPublishing(id, false, true);
    expect(getSite(id)).toMatchObject({ pin_posts: 0, pin_reels: 1 });
  });
});
