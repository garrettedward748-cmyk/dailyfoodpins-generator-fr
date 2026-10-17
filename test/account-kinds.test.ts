import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, getDb, openDatabase, run } from '../src/db/index.js';
import {
  addProfile, createRun, firstProfile, getKeyword, getProfile, getSite, insertKeyword, pickProfile, runProfile, runTargets,
  setInstagramPublishing, setPostToAll, setProfileKinds, updateProfile, upsertBufferAccount, upsertSite,
} from '../src/db/repos.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { PipelineContext } from '../src/pipeline/context.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Posts and Reels on each Pinterest and Instagram account, as Facebook has:
 * one account can take the article pins while another takes only the video
 * pins. The site's network switch follows the accounts.
 */

const KEY = randomBytes(32);
beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => closeDatabase());

const newSite = () =>
  upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);

/** Two Pinterest accounts with tokens: the first takes posts only, the second reels only. */
function split(siteId: number): { one: number; two: number } {
  const one = firstProfile(siteId, 'pinterest').id;
  const two = addProfile(siteId, 'pinterest');
  for (const id of [one, two]) upsertBufferAccount({ siteId, label: `t${id}`, token: `tok${id}`, enabled: true, profileId: id }, KEY);
  setProfileKinds(one, true, false);
  setProfileKinds(two, false, true);
  return { one, two };
}

const runOf = (siteId: number) => createRun(insertKeyword({ seed_keyword: 'x', spy_title: 'X' }), siteId);

describe('each account its own Posts and Reels', () => {
  it('the turn skips an account that does not take that kind', () => {
    const siteId = newSite();
    const { one, two } = split(siteId);
    for (let i = 0; i < 3; i++) {
      expect(pickProfile(siteId, 'pinterest', 'posts')?.id).toBe(one);
      expect(pickProfile(siteId, 'pinterest', 'reels')?.id).toBe(two);
    }
  });

  it("a run's reel goes to its article's account when that one takes reels, else to one that does, kept on the run", () => {
    const siteId = newSite();
    const { one, two } = split(siteId);
    const runId = runOf(siteId);
    expect(runProfile(runId, siteId, 'pinterest', 'posts')?.id).toBe(one);
    expect(runProfile(runId, siteId, 'pinterest', 'reels')?.id).toBe(two);
    expect(runProfile(runId, siteId, 'pinterest', 'reels')?.id).toBe(two); // same on retry
    expect(runProfile(runId, siteId, 'pinterest')?.id).toBe(one); // the article's stays

    setProfileKinds(one, true, true);
    const next = runOf(siteId);
    const article = runProfile(next, siteId, 'pinterest', 'posts')!;
    expect(runProfile(next, siteId, 'pinterest', 'reels')?.id).toBe(article.id);
  });

  it('posting to all leaves out an account that does not take the kind', () => {
    const siteId = newSite();
    const { one, two } = split(siteId);
    setPostToAll(siteId, 'pinterest', true);
    expect(runTargets(runOf(siteId), siteId, 'pinterest', 'posts').map((p) => p?.id)).toEqual([one]);
    expect(runTargets(runOf(siteId), siteId, 'pinterest', 'reels').map((p) => p?.id)).toEqual([two]);
  });

  it('an article post is not sent through an account with Posts off', async () => {
    const siteId = newSite();
    const only = firstProfile(siteId, 'instagram').id;
    upsertBufferAccount({ siteId, label: 'a', token: 'tok', enabled: true, profileId: only }, KEY);
    setProfileKinds(only, false, true);
    const kw = insertKeyword({ seed_keyword: 'y', spy_title: 'Y' });
    const ctx = new PipelineContext({ runId: createRun(kw, siteId), site: getSite(siteId)!, keyword: getKeyword(kw)!, settings: new Settings(KEY), encryptionKey: KEY });
    const send = vi.fn(async () => 'P');
    expect((await ctx.eachAccount('instagram', send)).postId).toBe('');
    expect(send).not.toHaveBeenCalled();
  });

  it("the site's switch follows its accounts, and an older page's switch sets every account", () => {
    const siteId = newSite();
    const { one, two } = split(siteId);
    let site = getSite(siteId) as unknown as { pin_posts: number; pin_reels: number };
    expect([site.pin_posts, site.pin_reels]).toEqual([1, 1]);
    setProfileKinds(two, false, false);
    site = getSite(siteId) as unknown as { pin_posts: number; pin_reels: number };
    expect([site.pin_posts, site.pin_reels]).toEqual([1, 0]);
    expect(getProfile(one)?.posts).toBe(1);

    const ig = firstProfile(siteId, 'instagram').id;
    setInstagramPublishing(siteId, false, true);
    expect([getProfile(ig)?.posts, getProfile(ig)?.reels]).toEqual([0, 1]);
  });

  it('the migration starts every account where its site switch was', () => {
    const siteId = newSite();
    const p = firstProfile(siteId, 'pinterest').id;
    const i = firstProfile(siteId, 'instagram').id;
    run('UPDATE sites SET pin_posts = 1, pin_reels = 0, ig_posts = 0, ig_reels = 1 WHERE id = ?', siteId);
    run('UPDATE channel_profiles SET posts = 1, reels = 1');
    MIGRATIONS.find((m) => m.id === '061-account-posts-reels')!.up(getDb());
    expect([getProfile(p)?.posts, getProfile(p)?.reels]).toEqual([1, 0]);
    expect([getProfile(i)?.posts, getProfile(i)?.reels]).toEqual([0, 1]);
    updateProfile(p, { enabled: 1 });
  });
});
