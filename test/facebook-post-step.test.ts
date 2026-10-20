import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { randomBytes } from 'node:crypto';
import {
  addManualFbPage, addProfile, createRun, firstProfile, insertFbToken, insertKeyword,
  runTargets, setPostToAll, updateProfile, upsertBufferAccount, upsertFbPage, upsertFbPageForProfile, upsertSite,
} from '../src/db/repos.js';
import { facebookPostStep } from '../src/pipeline/steps/facebook-post.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * publishPhotoPost/commentOnPost calls, for the direct-Graph tests below.
 * `vi.hoisted` because `vi.mock` factories run before the rest of the file,
 * so they cannot close over an ordinary module-level `let`.
 */
const fbClient = vi.hoisted(() => ({
  publishPhotoPost: [] as unknown[],
  commentOnPost: [] as unknown[],
}));
vi.mock('../src/integrations/facebook.js', () => ({
  // A plain function, not an arrow: `new FacebookClient(...)` only works on
  // something callable with `new`, and a function that returns an object
  // hands that object back as the instance.
  FacebookClient: vi.fn().mockImplementation(function FacebookClient() {
    return {
      publishPhotoPost: vi.fn(async (input: unknown) => {
        fbClient.publishPhotoPost.push(input);
        return { postId: '1000_2000', photoId: '2000' };
      }),
      commentOnPost: vi.fn(async (input: unknown) => {
        fbClient.commentOnPost.push(input);
        return { commentId: 'C1' };
      }),
    };
  }),
  FacebookError: class FacebookError extends Error {},
}));

/** The Facebook post: the pin graphic whole on 4:5 with blurred sides, a short text, the recipe link. */
let SITE = 0;
let KEY = randomBytes(32);
beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  KEY = randomBytes(32);
  SITE = upsertSite({ name: 'D', domain: 'd.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
  fbClient.publishPhotoPost.length = 0;
  fbClient.commentOnPost.length = 0;
});
afterEach(() => closeDatabase());

/**
 * Adds the real Facebook page a token synced, with the same name as the
 * posting page, so resolveFbGraphTarget bridges the card/manual page to it.
 * `realId` is the real page id direct publishing addresses.
 */
function withSyncedPage(name: string, realId = '1000'): void {
  const tokenId = insertFbToken('T', 'secret', KEY);
  upsertFbPage({ pageId: realId, name, tokenId });
}

function tallImage(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'fbimg-'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=768x1376', '-frames:v', '1', join(dir, 'p.png')]);
  return readFileSync(join(dir, 'p.png'));
}

function ctx(settings: Record<string, string>) {
  const uploads: Buffer[] = [];
  const posts: { text: string; imageUrl: string }[] = [];
  return {
    uploads,
    posts,
    value: {
      runId: 1,
      keyword: { seed_keyword: 'dessert' },
      site: { id: SITE, domain: 'd.com' },
      encryptionKey: KEY,
      settings: { getBool: (k: string) => settings[k] === '1', get: (k: string) => settings[k] ?? '' },
      images: { download: vi.fn(async () => ({ data: tallImage(), contentType: 'image/png' })) },
      siteApi: {
        uploadImage: vi.fn(async (d: Buffer) => { uploads.push(d); return { url: '/image/recipes/fb.jpg' }; }),
        absoluteUrl: (p: string) => `https://d.com${p}`,
      },
      prompt: vi.fn(async () => ({ content: 'Tangy, buttery and ready in an hour.' })),
      facebookBuffer: { createFacebookPost: vi.fn(async (i: { text: string; imageUrl: string }) => { posts.push(i); return { postId: 'P1', account: 'A' }; }) },
      // One account, as in rotation: the real context hands the step the run's pool.
      async eachAccount(this: { facebookBuffer: unknown }, _p: string, send: (pool: unknown, profile: undefined, first: boolean) => Promise<string>) {
        return { postId: await send(this.facebookBuffer, undefined, true), accounts: 1 };
      },
    } as never,
  };
}

const input = { seo: { title: 'Lemon Bars' } as never, title: 'Lemon Bars', postUrl: 'https://d.com/recipe/lemon-bars', pinImageUrl: '/image/pins/p.webp' };

describe('the Facebook post', () => {
  it('posts the pin graphic with the text and the link when the page takes posts', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET posts = 1 WHERE id = ?', id);
    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer' });
    const out = await facebookPostStep.run(c.value, input);
    expect(out).toEqual({ postId: 'P1', imageUrl: 'https://d.com/image/recipes/fb.jpg', source: 'pin' });
    expect(c.posts[0]!.text).toBe('La recette complète : https://d.com/recipe/lemon-bars\n\nTangy, buttery and ready in an hour.');
    expect(c.uploads[0]!.subarray(0, 3).toString('hex')).toBe('ffd8ff'); // a jpeg, 1080x1350
  });

  it('posts the pin graphic even when there is a hero photo', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET posts = 1 WHERE id = ?', id);
    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer' });
    await facebookPostStep.run(c.value, { ...input, heroImageUrl: '/image/recipes/hero.webp' });
    expect((c.value as { images: { download: ReturnType<typeof vi.fn> } }).images.download).toHaveBeenCalledWith('https://d.com/image/pins/p.webp');
  });

  it('falls back to the hero photo when there is no pin graphic', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET posts = 1 WHERE id = ?', id);
    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer' });
    const out = await facebookPostStep.run(c.value, { ...input, pinImageUrl: '', heroImageUrl: '/image/recipes/hero.webp' });
    expect(out).toMatchObject({ source: 'hero' });
    expect((c.value as { images: { download: ReturnType<typeof vi.fn> } }).images.download).toHaveBeenCalledWith('https://d.com/image/recipes/hero.webp');
  });

  it('does nothing when the page does not take posts', async () => {
    addManualFbPage({ name: 'Page', siteId: SITE });
    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer' });
    expect(await facebookPostStep.run(c.value, input)).toMatchObject({ skipped: expect.any(String) });
    expect(c.posts).toHaveLength(0);
  });
});

/**
 * The bug: the gate at the top of the step only asks whether *some* Facebook
 * account of this site takes posts, then `eachAccount` sends to whichever
 * account(s) rotation or "post to all" actually picks — which do not have to
 * be the same account. Disabling Posts on one account while another still has
 * it on, or in "post to all" with a mix of on/off accounts, used to post to
 * the disabled account anyway. Each account is now checked against its own
 * page before anything is sent to it.
 */
describe('each account is checked against its own page, not just any page of the site', () => {
  function postToAllAccounts(pool: unknown) {
    return async function (this: void, _platform, send) {
      const targets = runTargets(null, SITE, 'facebook');
      let postId = '';
      for (const [i, profile] of targets.entries()) {
        const id = await send(pool as never, profile, i === 0);
        if (id === null) continue;
        if (i === 0) postId = id;
      }
      return { postId, accounts: targets.length };
    };
  }

  it('posting to all, posts only to the account(s) whose own page has Posts on', async () => {
    const onId = firstProfile(SITE, 'facebook').id;
    upsertBufferAccount({ siteId: SITE, label: 'on', token: 'tok', enabled: true, profileId: onId }, randomBytes(32));
    upsertFbPageForProfile(onId, SITE, 'On Page', true, true, true);

    const offId = addProfile(SITE, 'facebook');
    upsertBufferAccount({ siteId: SITE, label: 'off', token: 'tok', enabled: true, profileId: offId }, randomBytes(32));
    upsertFbPageForProfile(offId, SITE, 'Off Page', false, true, true); // Posts unticked on this one

    setPostToAll(SITE, 'facebook', true);

    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer' });
    c.value.eachAccount = postToAllAccounts(c.value.facebookBuffer);

    const out = await facebookPostStep.run(c.value, input);
    expect(out).toMatchObject({ postId: expect.any(String) });
    expect(c.posts).toHaveLength(1); // only the "on" account was ever posted to
  });

  it('posting to all, skips entirely when every account\'s own page has Posts off', async () => {
    const onId = firstProfile(SITE, 'facebook').id;
    upsertBufferAccount({ siteId: SITE, label: 'a', token: 'tok', enabled: true, profileId: onId }, randomBytes(32));
    // Posts off here, but Collage on -- so the module-level gate used by the
    // outer pipeline (pageForSite) still finds *a* page, just not for posts.
    upsertFbPageForProfile(onId, SITE, 'Page A', false, true, true);

    const offId = addProfile(SITE, 'facebook');
    upsertBufferAccount({ siteId: SITE, label: 'b', token: 'tok', enabled: true, profileId: offId }, randomBytes(32));
    upsertFbPageForProfile(offId, SITE, 'Page B', false, true, true);

    setPostToAll(SITE, 'facebook', true);

    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer' });
    c.value.eachAccount = postToAllAccounts(c.value.facebookBuffer);

    // Neither page takes posts, so the plain gate (pageForSite) already
    // returns nothing and the step skips before ever reaching eachAccount.
    const out = await facebookPostStep.run(c.value, input);
    expect(out).toMatchObject({ skipped: expect.any(String) });
    expect(c.posts).toHaveLength(0);
  });

  /**
   * The site's only Facebook account, switched off ("in turn" unticked,
   * shown as the "off" badge on its card), but Posts is still ticked on its
   * page. With nothing "usable" (switched on + a Buffer token), pickProfile
   * falls back to the site's one account anyway -- it has to return
   * something -- and without this check that lone disabled account would
   * still receive the post.
   */
  it('does not post through the site\'s only Facebook account when that account itself is switched off', async () => {
    const id = firstProfile(SITE, 'facebook').id;
    updateProfile(id, { enabled: 0 });
    upsertBufferAccount({ siteId: SITE, label: 'a', token: 'tok', enabled: true, profileId: id }, randomBytes(32));
    upsertFbPageForProfile(id, SITE, 'Page', true, true, true); // Posts ticked

    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer' });
    c.value.eachAccount = postToAllAccounts(c.value.facebookBuffer); // real runTargets, single account

    const out = await facebookPostStep.run(c.value, input);
    expect(out).toMatchObject({ skipped: expect.any(String) });
    expect(c.posts).toHaveLength(0);
  });

  it('posting to all, skips an account that is switched off even though its page still has Posts ticked', async () => {
    const onId = firstProfile(SITE, 'facebook').id;
    upsertBufferAccount({ siteId: SITE, label: 'on', token: 'tok', enabled: true, profileId: onId }, randomBytes(32));
    upsertFbPageForProfile(onId, SITE, 'On Page', true, true, true);

    // Posts/Reels/Collage all still ticked on this account's page, but the
    // account itself ("in turn") is off -- it must not post regardless.
    const offId = addProfile(SITE, 'facebook');
    updateProfile(offId, { enabled: 0 });
    upsertBufferAccount({ siteId: SITE, label: 'off', token: 'tok', enabled: true, profileId: offId }, randomBytes(32));
    upsertFbPageForProfile(offId, SITE, 'Off Page', true, true, true);

    setPostToAll(SITE, 'facebook', true);

    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer' });
    c.value.eachAccount = postToAllAccounts(c.value.facebookBuffer);

    const out = await facebookPostStep.run(c.value, input);
    expect(out).toMatchObject({ postId: expect.any(String) });
    expect(c.posts).toHaveLength(1); // only the "on" account was ever posted to
  });
});

/**
 * Setup -> Reels -> "Publish reels through" also governs the article's own
 * Facebook post now: 'facebook' publishes straight to the Page over Graph
 * API instead of going through Buffer, and the real post id is in hand the
 * moment it returns -- nothing for the webhook's backfill to do.
 */
describe('publishing directly through Graph API', () => {
  it('publishes to the real synced page (bridged from the card) and never touches Buffer', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET posts = 1 WHERE id = ?', id);
    withSyncedPage('Page'); // the token-synced page the card bridges to

    const c = ctx({ fb_enabled: '1', reel_publisher: 'facebook' });
    const out = await facebookPostStep.run(c.value, input);

    expect(out).toEqual({ postId: '1000_2000', imageUrl: 'https://d.com/image/recipes/fb.jpg', source: 'pin' });
    expect(fbClient.publishPhotoPost).toHaveLength(1);
    expect((fbClient.publishPhotoPost[0] as { pageId: string }).pageId).toBe('1000'); // the real id, not profile:/manual:
    expect(c.posts).toHaveLength(0); // Buffer was never called
  });

  it('leaves the link as the first comment on the real page when that is the chosen link mode', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET posts = 1 WHERE id = ?', id);
    withSyncedPage('Page');

    const c = ctx({ fb_enabled: '1', reel_publisher: 'facebook', caption_fb_post_link: 'comment' });
    await facebookPostStep.run(c.value, input);

    expect(fbClient.commentOnPost).toEqual([
      { pageId: '1000', postId: '1000_2000', message: 'La recette complète : https://d.com/recipe/lemon-bars' },
    ]);
  });

  it('skips an account with no token and no synced page to bridge to, instead of throwing', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET posts = 1 WHERE id = ?', id); // no withSyncedPage() this time

    const c = ctx({ fb_enabled: '1', reel_publisher: 'facebook' });
    const out = await facebookPostStep.run(c.value, input);

    expect(out).toMatchObject({ skipped: expect.any(String) });
    expect(fbClient.publishPhotoPost).toHaveLength(0);
  });
});
