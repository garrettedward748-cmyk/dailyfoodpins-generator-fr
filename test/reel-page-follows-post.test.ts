import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import {
  addProfile, createRun, firstProfile, insertKeyword, pageForSite, reelPageForRun, setPostToAll,
  upsertFbPageForProfile, upsertSite,
} from '../src/db/repos.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * In rotation, an article's reel goes to the page its photo post went to:
 * the pizza reel and the pizza photo on the same page, never one on each.
 */

const KEY = randomBytes(32);
beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => closeDatabase());

function twoPages() {
  const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
  const one = firstProfile(siteId, 'facebook').id;
  const two = addProfile(siteId, 'facebook');
  run('UPDATE channel_profiles SET enabled = 1 WHERE id IN (?, ?)', one, two);
  upsertFbPageForProfile(one, siteId, 'Page 1', true, true);
  upsertFbPageForProfile(two, siteId, 'Page 2', true, true);
  const runId = createRun(insertKeyword({ seed_keyword: 'pizza', spy_title: 'Pizza' }), siteId);
  const postedTo = (profileId: number) => run('UPDATE runs SET profiles_json = ? WHERE id = ?', JSON.stringify({ facebook: profileId }), runId);
  return { siteId, one, two, runId, postedTo };
}

describe('the reel follows the photo post', () => {
  it('goes to the page of the account the article posted through, whichever page the reel turn holds', () => {
    const { siteId, one, two, runId, postedTo } = twoPages();
    const turn = pageForSite(siteId, 'reels')!;
    const other = turn.profile_id === one ? two : one;
    postedTo(other);
    expect(reelPageForRun(runId, siteId)?.profile_id).toBe(other);
  });

  it('falls back to the reel turn when that page has Reels unticked', () => {
    const { siteId, two, runId, postedTo } = twoPages();
    upsertFbPageForProfile(two, siteId, 'Page 2', true, false);
    postedTo(two);
    expect(reelPageForRun(runId, siteId)?.profile_id).not.toBe(two);
  });

  it('falls back to the reel turn with no article account, or when the site posts to all', () => {
    const { siteId, two, runId, postedTo } = twoPages();
    expect(reelPageForRun(runId, siteId)?.id).toBe(pageForSite(siteId, 'reels')?.id);
    expect(reelPageForRun(null, siteId)?.id).toBe(pageForSite(siteId, 'reels')?.id);
    postedTo(two);
    setPostToAll(siteId, 'facebook', true);
    expect(reelPageForRun(runId, siteId)?.id).toBe(pageForSite(siteId, 'reels')?.id);
  });
});
