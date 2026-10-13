import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, get, getDb, openDatabase, run } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import {
  addManualFbPage,
  createReel,
  deleteFbToken,
  facebookForSite,
  firstProfile,
  getFbPageByProfile,
  insertKeyword,
  fbPageToken,
  fbTokenSecret,
  insertFbToken,
  listFbPages,
  listFbTokens,
  pageForSite,
  resolveFbGraphTarget,
  setFbPageOptions,
  syncFbPages,
  upsertFbPage,
  upsertFbPageForProfile,
  upsertSite,
} from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * One page, one niche. Pages exist only because a token said so, and the
 * three things a person sets on a page -- niche, auto-publish, enabled --
 * survive every sync.
 */

const KEY = randomBytes(32);

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
});
afterEach(() => closeDatabase());

const site = (domain = 'a.com') =>
  upsertSite({ name: domain, domain, status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);

const sorted = () => [...listFbPages()].sort((a, b) => a.page_id.localeCompare(b.page_id));

describe('a profile:<id> row with a null profile_id still reads back', () => {
  // The production bug: the row the Posts/Reels/Collage boxes save to
  // (page_id = "profile:<id>") had profile_id = NULL, so the by-profile_id
  // lookups the view and the posting gate use found nothing and every box
  // read back empty. upsertFbPageForProfile's ON CONFLICT must repair the
  // profile_id, not leave it null.
  it('saving over a null-profile_id row sets its profile_id and persists the boxes', () => {
    const siteId = site();
    const profile = firstProfile(siteId, 'facebook');
    // The broken row exactly as seen on disk: page_id "profile:<id>", profile_id null.
    run(
      `INSERT INTO fb_pages (page_id, name, profile_id, site_id, posts, reels, collage, auto_publish, enabled)
       VALUES (?, ?, NULL, ?, 0, 1, 0, 1, 1)`,
      `profile:${profile.id}`, 'ArbmomRecipes', siteId,
    );

    upsertFbPageForProfile(profile.id, siteId, 'ArbmomRecipes', true, true, true);

    const page = getFbPageByProfile(profile.id);
    expect(page?.page_id).toBe(`profile:${profile.id}`);
    expect(page?.profile_id).toBe(profile.id);
    expect(page?.posts).toBe(1);
    expect(page?.collage).toBe(1);
  });
});

describe("a card's own page wins over a stale row on the same profile", () => {
  // A profile can end up with two fb_pages rows: the card's own
  // "profile:<id>" row that the Posts/Reels/Collage boxes save to, and a real
  // page a Graph sync or old migration linked to the same profile. The stale
  // one carries boxes = 0; if it is read instead of the card's row, the boxes
  // show empty right after being saved and posting is gated off for a page
  // whose box is ticked. getFbPageByProfile (and the Accounts view) must
  // prefer the card's row regardless of row order.
  for (const [where, pageId, name] of [
    ['its name sorts after the card name', '999', 'Zzz Page'],
    ['its page_id sorts after "profile:"', 'zzz_id', 'Same Name'],
    ['its page_id sorts before "profile:"', '000111', 'Same Name'],
  ] as const) {
    it(`prefers the card row when a stale row shares the profile (${where})`, () => {
      const siteId = site();
      const profile = firstProfile(siteId, 'facebook');
      run(
        `INSERT INTO fb_pages (page_id, name, profile_id, site_id, posts, reels, collage, auto_publish, enabled)
         VALUES (?, ?, ?, ?, 0, 0, 0, 1, 1)`,
        pageId, name, profile.id, siteId,
      );

      // The user ticks all three boxes on the card and saves.
      upsertFbPageForProfile(profile.id, siteId, 'ArbmomRecipes', true, true, true);

      const page = getFbPageByProfile(profile.id);
      expect(page?.page_id).toBe(`profile:${profile.id}`);
      expect(page?.posts).toBe(1);
      expect(page?.reels).toBe(1);
      expect(page?.collage).toBe(1);
    });
  }
});

describe('tokens and their pages', () => {
  it('stores a token encrypted and reads it back', () => {
    const id = insertFbToken('App 1', 'EAAB-secret', KEY);

    expect(listFbTokens()[0]).toMatchObject({ id, name: 'App 1', page_count: 0 });
    expect(listFbTokens()[0]!.token_encrypted).not.toContain('EAAB');
    expect(fbTokenSecret(id, KEY)).toBe('EAAB-secret');
  });

  it('names an unnamed token and refuses an empty one', () => {
    insertFbToken('  ', 'x', KEY);
    expect(listFbTokens()[0]!.name).toBe('Token 1');
    expect(() => insertFbToken('B', '  ', KEY)).toThrow(/token/i);
  });

  it('sync adds, renames, and disables pages that left the token', () => {
    const t = insertFbToken('App 1', 'x', KEY);
    expect(
      syncFbPages(t, [
        { id: '1', name: 'One' },
        { id: '2', name: 'Two' },
      ]),
    ).toEqual({ added: 2, renamed: 0, dropped: 0 });
    setFbPageOptions(sorted()[0]!.id, { siteId: site(), autoPublish: false, enabled: true });

    expect(syncFbPages(t, [{ id: '1', name: 'One renamed' }])).toEqual({
      added: 0,
      renamed: 1,
      dropped: 1,
    });

    const [one, two] = sorted();
    expect(one).toMatchObject({ name: 'One renamed', site_id: expect.any(Number), auto_publish: 0, enabled: 1 });
    expect(two).toMatchObject({ enabled: 0, last_error: 'No longer under this token' });
    expect(listFbTokens()[0]!.page_count).toBe(2);
  });

  it('a new page arrives with auto-publish on', () => {
    const t = insertFbToken('A', 'x', KEY);
    syncFbPages(t, [{ id: '1', name: 'One' }]);
    expect(listFbPages()[0]).toMatchObject({ auto_publish: 1, enabled: 1, site_id: null });
  });

  it('deleting a token deletes its pages', () => {
    const t = insertFbToken('App 1', 'x', KEY);
    syncFbPages(t, [{ id: '1', name: 'One' }]);
    deleteFbToken(t);
    expect(listFbPages()).toEqual([]);
    expect(listFbTokens()).toEqual([]);
  });

  it('the page token is the token of the page', () => {
    const a = insertFbToken('A', 'tok-a', KEY);
    const b = insertFbToken('B', 'tok-b', KEY);
    syncFbPages(a, [{ id: '1', name: 'One' }]);
    syncFbPages(b, [{ id: '2', name: 'Two' }]);

    const two = listFbPages().find((p) => p.page_id === '2')!;
    expect(fbPageToken(two.id, KEY)).toBe('tok-b');
  });
});

describe('a site and its pages', () => {
  const twoPages = () => {
    const t = insertFbToken('A', 'x', KEY);
    syncFbPages(t, [
      { id: '1', name: 'One' },
      { id: '2', name: 'Two' },
    ]);
    const [one, two] = sorted();
    return { one: one!, two: two! };
  };
  const on = (id: number, siteId: number, extra: { posts?: boolean; reels?: boolean } = {}) =>
    setFbPageOptions(id, { siteId, autoPublish: true, enabled: true, posts: extra.posts ?? true, reels: extra.reels ?? true });

  it('finds the enabled page of a site, and none for a site without one', () => {
    const a = site('a.com');
    const b = site('b.com');
    const { one } = twoPages();
    on(one.id, a);

    expect(pageForSite(a)?.id).toBe(one.id);
    expect(pageForSite(b)).toBeUndefined();
  });

  it('a disabled page, or one with no site, is not found', () => {
    const a = site();
    const { one, two } = twoPages();
    setFbPageOptions(one.id, { siteId: a, autoPublish: true, enabled: false });
    setFbPageOptions(two.id, { siteId: null, autoPublish: true, enabled: true });
    expect(pageForSite(a)).toBeUndefined();
  });

  it('two sites each have their own page, even with the same topics', () => {
    const a = site('a.com');
    const b = site('b.com');
    const { one, two } = twoPages();
    on(one.id, a);
    on(two.id, b);
    expect(pageForSite(a)?.id).toBe(one.id);
    expect(pageForSite(b)?.id).toBe(two.id);
    expect(facebookForSite(a).pages.map((p) => p.id)).toEqual([one.id]);
  });

  it('a site with several pages rotates through them', () => {
    const a = site();
    const { one, two } = twoPages();
    on(one.id, a);
    on(two.id, a);
    const kw = insertKeyword({ seed_keyword: 'soup' });
    const next = () => {
      const page = pageForSite(a, 'reels')!;
      createReel({ runId: null, siteId: a, keywordId: kw, fbPageId: page.id, prompt: '', caption: '', references: [] });
      return page.id;
    };
    expect([next(), next(), next(), next()]).toEqual([one.id, two.id, one.id, two.id]);
  });

  it('asks only for pages that take posts, or reels', () => {
    const a = site();
    const { one, two } = twoPages();
    on(one.id, a, { posts: true, reels: false });
    on(two.id, a, { posts: false, reels: true });
    expect(pageForSite(a, 'posts')?.id).toBe(one.id);
    expect(pageForSite(a, 'reels')?.id).toBe(two.id);
    expect(facebookForSite(a)).toMatchObject({ posts: true, reels: true });
  });

  it('giving a page its site adopts that site\'s reels that had nowhere to go', () => {
    const a = site();
    const { one } = twoPages();
    const kw = insertKeyword({ seed_keyword: 'soup' });
    const reel = createReel({ runId: null, siteId: a, keywordId: kw, fbPageId: null, prompt: '', caption: '', references: [] });
    on(one.id, a);
    expect(get<{ fb_page_id: number }>('SELECT fb_page_id FROM reels WHERE id = ?', reel)!.fb_page_id).toBe(one.id);
  });
});

describe('a page added by hand, for the Buffer route', () => {
  it('needs no token, and belongs to the site it was added to', () => {
    const a = site();
    const id = addManualFbPage({ name: 'Daily Food Pins', siteId: a });

    expect(fbPageToken(id, KEY)).toBe('');
    expect(pageForSite(a)?.id).toBe(id);
  });

  it('leaves an imported page with no site alone: nothing goes to it', () => {
    const t = insertFbToken('A', 'x', KEY);
    syncFbPages(t, [{ id: '1', name: 'Imported' }]);
    expect(pageForSite(site())).toBeUndefined();
  });

  it('refuses a second page under the same name rather than silently reusing it', () => {
    addManualFbPage({ name: 'Daily Food Pins' });

    expect(() => addManualFbPage({ name: 'daily food pins' })).toThrow(/already here/);
  });
});

describe('moving pages from niches to sites (migration 039)', () => {
  it('assigns what is certain and leaves the rest to a person', () => {
    const a = site('a.com');
    const b = site('b.com');
    insertKeyword({ seed_keyword: 'dessert' });
    insertKeyword({ seed_keyword: 'chicken' });
    insertKeyword({ seed_keyword: 'both' });
    run("INSERT INTO keyword_sites (keyword_id, site_id, status) SELECT id, ?, 'go' FROM keywords WHERE seed_keyword = 'dessert'", a);
    run("INSERT INTO keyword_sites (keyword_id, site_id, status) SELECT id, ?, 'go' FROM keywords WHERE seed_keyword = 'chicken'", b);
    run("INSERT INTO keyword_sites (keyword_id, site_id, status) SELECT id, ?, 'go' FROM keywords WHERE seed_keyword = 'both'", a);
    run("INSERT INTO keyword_sites (keyword_id, site_id, status) SELECT id, ?, 'go' FROM keywords WHERE seed_keyword = 'both'", b);
    const page = (pid: string, niche: string | null) => {
      run('INSERT INTO fb_pages (page_id, name, niche) VALUES (?, ?, ?)', pid, pid, niche);
      return get<{ id: number }>('SELECT id FROM fb_pages WHERE page_id = ?', pid)!.id;
    };
    const pDessert = page('p1', 'Dessert');
    const pChicken = page('p2', 'chicken');
    const pBoth = page('p3', 'both');
    const pStar = page('p4', '*');
    const pNone = page('p5', null);

    MIGRATIONS.find((m) => m.id === '039-fb-page-site')!.up(getDb());

    const site_of = (id: number) => get<{ site_id: number | null }>('SELECT site_id FROM fb_pages WHERE id = ?', id)!.site_id;
    expect(site_of(pDessert)).toBe(a);
    expect(site_of(pChicken)).toBe(b);
    expect(site_of(pBoth)).toBeNull(); // either site: a person chooses
    expect(site_of(pStar)).toBeNull(); // every keyword, two sites: a person chooses
    expect(site_of(pNone)).toBeNull();
  });
});

describe('one page per Facebook account (migration 040)', () => {
  it('pairs a site\'s existing pages with its accounts, and makes an account for a page left over', () => {
    const a = site('a.com');
    const first = get<{ id: number }>("SELECT id FROM channel_profiles WHERE site_id = ? AND platform = 'facebook'", a);
    const profileId = first?.id ?? (run("INSERT INTO channel_profiles (site_id, platform, position, label) VALUES (?, 'facebook', 1, 'Facebook 1')", a), get<{ id: number }>("SELECT id FROM channel_profiles WHERE site_id = ? AND platform = 'facebook'", a)!.id);
    run("INSERT INTO fb_pages (page_id, name, site_id) VALUES ('manual:one', 'One', ?), ('manual:two', 'Two', ?)", a, a);

    MIGRATIONS.find((m) => m.id === '040-fb-page-per-account')!.up(getDb());

    const pages = listFbPages().sort((x, y) => x.name.localeCompare(y.name));
    expect(pages[0]!.profile_id).toBe(profileId);
    expect(pages[1]!.profile_id).not.toBeNull();
    expect(pages[1]!.profile_id).not.toBe(profileId);
    // The existing account takes the page's name as its Buffer channel, since it had none.
    expect(get<{ channel_name: string }>('SELECT channel_name FROM channel_profiles WHERE id = ?', profileId)!.channel_name).toBe('One');
  });

  it('does not overwrite a channel name typed on the account', () => {
    const a = site('a.com');
    run("INSERT INTO channel_profiles (site_id, platform, position, label, channel_name) VALUES (?, 'facebook', 1, 'Facebook 1', 'Typed Name')", a);
    run("INSERT INTO fb_pages (page_id, name, site_id) VALUES ('manual:one', 'One', ?)", a);

    MIGRATIONS.find((m) => m.id === '040-fb-page-per-account')!.up(getDb());

    expect(get<{ channel_name: string }>("SELECT channel_name FROM channel_profiles WHERE site_id = ? AND platform = 'facebook'", a)!.channel_name).toBe('Typed Name');
  });
});

/**
 * resolveFbGraphTarget bridges the two kinds of fb_pages row that describe
 * the same real page: a Buffer account-card page (no token, a synthetic
 * "profile:<id>"/"manual:<slug>" id) and the row a token sync brought in
 * (the real numeric id and a token). This is what lets a direct publish, the
 * backfill and the "banana" private reply reach a page set up through Buffer.
 */
describe('resolveFbGraphTarget bridges a card page to its synced page', () => {
  it('returns a synced page as-is when it carries its own token and a real id', () => {
    const tokenId = insertFbToken('T', 'secret', KEY);
    const id = upsertFbPage({ pageId: '12345', name: 'Real Page', tokenId });
    const target = resolveFbGraphTarget(id, KEY);
    expect(target).toEqual({ pageId: '12345', token: 'secret' });
  });

  it('bridges a manual card page to the synced page of the same name', () => {
    const siteId = site();
    const tokenId = insertFbToken('T', 'secret', KEY);
    upsertFbPage({ pageId: '777', name: 'ArbmomRecipes', tokenId }); // the synced, tokened page
    const cardId = addManualFbPage({ name: 'ArbmomRecipes', siteId }); // the Buffer card, no token

    const target = resolveFbGraphTarget(cardId, KEY);
    expect(target).toEqual({ pageId: '777', token: 'secret' });
  });

  it('bridges by site when the names differ and the site has exactly one synced page', () => {
    const siteId = site();
    const tokenId = insertFbToken('T', 'secret', KEY);
    const syncedId = upsertFbPage({ pageId: '888', name: 'Different Name', tokenId });
    run('UPDATE fb_pages SET site_id = ? WHERE id = ?', siteId, syncedId);
    const cardId = addManualFbPage({ name: 'Card Name', siteId });

    const target = resolveFbGraphTarget(cardId, KEY);
    expect(target).toEqual({ pageId: '888', token: 'secret' });
  });

  it('returns undefined when no synced page can be matched, so the caller skips Graph', () => {
    const siteId = site();
    const cardId = addManualFbPage({ name: 'Lonely', siteId }); // no token synced at all
    expect(resolveFbGraphTarget(cardId, KEY)).toBeUndefined();
  });

  it('does not guess between two same-site synced pages when the name does not match', () => {
    const siteId = site();
    const tokenId = insertFbToken('T', 'secret', KEY);
    const a = upsertFbPage({ pageId: 'a1', name: 'Alpha', tokenId });
    const b = upsertFbPage({ pageId: 'b2', name: 'Beta', tokenId });
    run('UPDATE fb_pages SET site_id = ? WHERE id IN (?, ?)', siteId, a, b);
    const cardId = addManualFbPage({ name: 'Unrelated', siteId });

    // Two candidates for the site, neither matching by name -> no safe guess.
    expect(resolveFbGraphTarget(cardId, KEY)).toBeUndefined();
  });
});
