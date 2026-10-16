import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { addProfile, firstProfile, upsertBufferAccount, upsertSite } from '../src/db/repos.js';
import { linkedProfile, pagesLine } from '../src/reels/engine.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * A reel shown as "ArbmomRecipes" went to that page on Facebook, but its
 * Instagram and YouTube copies went to whichever account of those networks had
 * the turn. They now follow the page: the account of the network that shares
 * its Buffer token.
 */

const KEY = randomBytes(32);
beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => closeDatabase());

function site() {
  return upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
}

describe('the account of another network linked to a reel\'s page', () => {
  it('is the one holding the same Buffer token as the page, not the first in the list', () => {
    const siteId = site();
    const page = firstProfile(siteId, 'facebook').id;
    upsertBufferAccount({ siteId, label: 'fb', token: 'tok-arbmom', enabled: true, profileId: page }, KEY);
    const ig1 = firstProfile(siteId, 'instagram').id;
    const ig2 = addProfile(siteId, 'instagram');
    upsertBufferAccount({ siteId, label: 'ig1', token: 'tok-other', enabled: true, profileId: ig1 }, KEY);
    upsertBufferAccount({ siteId, label: 'ig2', token: 'tok-arbmom', enabled: true, profileId: ig2 }, KEY);
    expect(linkedProfile(siteId, 'instagram', page, KEY)?.id).toBe(ig2);
  });

  it('is none when no account of the network shares the token', () => {
    const siteId = site();
    const page = firstProfile(siteId, 'facebook').id;
    upsertBufferAccount({ siteId, label: 'fb', token: 'tok-arbmom', enabled: true, profileId: page }, KEY);
    const yt = firstProfile(siteId, 'youtube').id;
    upsertBufferAccount({ siteId, label: 'yt', token: 'tok-other', enabled: true, profileId: yt }, KEY);
    expect(linkedProfile(siteId, 'youtube', page, KEY)).toBeUndefined();
  });
});

describe('where a reel really went', () => {
  it('names each page Buffer posted to', () => {
    expect(
      pagesLine({
        facebook: { status: 'ok', id: '1', page: 'Amanda Recipes' },
        instagram: { status: 'ok', id: '2', page: 'amanda.recipes' },
        tiktok: { status: 'failed', error: 'full' },
      }),
    ).toBe('facebook → Amanda Recipes · instagram → amanda.recipes');
  });
});
