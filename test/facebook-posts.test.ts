import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { addManualFbPage, firstProfile, getFbPage, getFbPageByProfile, insertFbToken, insertKeyword, syncFbPages, upsertSite } from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Channels -> Accounts -> Facebook: each account is the one page it posts as,
 * and Posts and Reels live on that same card, saved with its name and token.
 */
const KEY = randomBytes(32);
let app: FastifyInstance;
let cookie: string;
beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
let SITE = 0;
beforeEach(() => { SITE = upsertSite({ name: 'a', domain: 'a.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY); });
afterEach(async () => { await app.close(); closeDatabase(); });

const saveProfile = (id: number, fields: Record<string, string>) =>
  app.inject({ method: 'POST', url: `/accounts/profile/${id}`, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ channel_name: 'Recipesbuzz', enabled: '1', ...fields }).toString() });

describe('a Facebook account is the page it posts as', () => {
  it('shows Posts, Reels and Collage on the account card, saves them, and turns the page off when none is ticked', async () => {
    insertKeyword({ seed_keyword: 'dessert' });
    const profile = firstProfile(SITE, 'facebook');
    const page = await app.inject({ method: 'GET', url: '/accounts', headers: { cookie } });
    expect(page.body).toContain('name="posts"');
    expect(page.body).toContain('name="reels"');
    expect(page.body).toContain('name="collage"');

    await saveProfile(profile.id, { posts: '1', reels: '1' });
    expect(getFbPageByProfile(profile.id)).toMatchObject({ name: 'Recipesbuzz', posts: 1, reels: 1, collage: 0, enabled: 1, site_id: SITE });

    await saveProfile(profile.id, { posts: '1' });
    expect(getFbPageByProfile(profile.id)).toMatchObject({ posts: 1, reels: 0, enabled: 1 });

    // Collage alone still turns the page on, same as Posts or Reels alone.
    await saveProfile(profile.id, { collage: '1' });
    expect(getFbPageByProfile(profile.id)).toMatchObject({ posts: 0, reels: 0, collage: 1, enabled: 1 });

    await saveProfile(profile.id, {});
    expect(getFbPageByProfile(profile.id)).toMatchObject({ posts: 0, reels: 0, collage: 0, enabled: 0 });
  });

  it('keeps the same page across a rename, rather than making a second one', async () => {
    const profile = firstProfile(SITE, 'facebook');
    await saveProfile(profile.id, { posts: '1' });
    const firstId = getFbPageByProfile(profile.id)!.id;

    await saveProfile(profile.id, { channel_name: 'New Name', posts: '1' });
    const page = getFbPageByProfile(profile.id)!;
    expect(page.id).toBe(firstId);
    expect(page.name).toBe('New Name');
  });

  it('removing the account removes the page it carried', async () => {
    const profile = firstProfile(SITE, 'facebook');
    const second = (await app.inject({ method: 'POST', url: `/accounts/${SITE}/facebook/add`, headers: { cookie } })).headers.location;
    expect(second).toBeDefined();
    await saveProfile(profile.id, { posts: '1' });
    const pageId = getFbPageByProfile(profile.id)!.id;

    await app.inject({ method: 'POST', url: `/accounts/profile/${profile.id}/delete`, headers: { cookie } });

    expect(getFbPage(pageId)).toBeUndefined();
  });
});

describe('each site sees only its own Facebook accounts', () => {
  it('shows a site its own page, never another site\'s', async () => {
    const other = upsertSite({ name: 'b', domain: 'b.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    const mine = firstProfile(SITE, 'facebook');
    const theirs = firstProfile(other, 'facebook');
    await saveProfile(mine.id, { channel_name: 'Mine Page', posts: '1' });
    await saveProfile(theirs.id, { channel_name: 'Theirs Page', posts: '1' });

    const mineBody = (await app.inject({ method: 'GET', url: `/accounts/${SITE}`, headers: { cookie } })).body;
    expect(mineBody).toContain('Mine Page');
    expect(mineBody).not.toContain('Theirs Page');

    const theirsBody = (await app.inject({ method: 'GET', url: `/accounts/${other}`, headers: { cookie } })).body;
    expect(theirsBody).toContain('Theirs Page');
    expect(theirsBody).not.toContain('Mine Page');
  });

  it('a page synced from a token stays visible to every site until claimed, in the leftover table', async () => {
    const other = upsertSite({ name: 'b', domain: 'b.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
    const token = insertFbToken('App 1', 'x', KEY);
    syncFbPages(token, [{ id: '1', name: 'Unclaimed Page' }]);

    const mineBody = (await app.inject({ method: 'GET', url: `/accounts/${SITE}`, headers: { cookie } })).body;
    const theirsBody = (await app.inject({ method: 'GET', url: `/accounts/${other}`, headers: { cookie } })).body;
    expect(mineBody).toContain('Unclaimed Page');
    expect(theirsBody).toContain('Unclaimed Page');
  });

  it('a page added by hand, with no token and no account, is on neither site\'s screen', async () => {
    // addManualFbPage is kept as a repo helper (other code and tests build
    // fixtures with it), but it has no page on /accounts any more: that page
    // now only exists once an account's own card is saved.
    addManualFbPage({ name: 'Orphan Page', siteId: SITE });

    const mineBody = (await app.inject({ method: 'GET', url: `/accounts/${SITE}`, headers: { cookie } })).body;
    expect(mineBody).not.toContain('Orphan Page');
  });
});
