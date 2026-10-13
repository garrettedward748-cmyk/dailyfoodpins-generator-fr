import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import {
  addManualFbPage, addProfile, firstProfile, insertFbToken, runTargets, setPostToAll,
  updateProfile, upsertBufferAccount, upsertFbPage, upsertFbPageForProfile, upsertSite,
} from '../src/db/repos.js';
import { collagePostStep } from '../src/pipeline/steps/collage.js';
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

/** The photo collage: N fresh step photographs laid into a grid and posted to Facebook. */
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
 */
function withSyncedPage(name: string, realId = '1000'): void {
  const tokenId = insertFbToken('T', 'secret', KEY);
  upsertFbPage({ pageId: realId, name, tokenId });
}

async function swatch(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 120, b: 50 } } })
    .jpeg()
    .toBuffer();
}

function planJson(count: number): string {
  return JSON.stringify({
    shots: Array.from({ length: count }, (_, i) => ({ description: `shot number ${i + 1} of the recipe in detail` })),
  });
}

function ctx(settings: Record<string, string>, count = 6) {
  const posts: { text: string; imageUrl: string }[] = [];
  const uploads: Buffer[] = [];
  const prompt = vi.fn(async (name: string) => {
    if (name === 'collage-steps') return { content: planJson(count) };
    return { content: 'Watch it come together, step by step. Save this one for later!' };
  });
  return {
    posts,
    uploads,
    value: {
      runId: 1,
      keyword: { seed_keyword: 'dessert' },
      site: { id: SITE, domain: 'd.com' },
      encryptionKey: KEY,
      settings: {
        getBool: (k: string) => settings[k] === '1',
        get: (k: string) => settings[k] ?? '',
        getNumber: (k: string) => Number(settings[k] ?? 0),
      },
      images: {
        submit: vi.fn(async () => 'job-1'),
        waitForCompletion: vi.fn(async () => 'https://image.example/one.jpg'),
        download: vi.fn(async () => ({ data: await swatch(), contentType: 'image/jpeg' })),
      },
      siteApi: {
        uploadImage: vi.fn(async (d: Buffer) => { uploads.push(d); return { url: '/image/recipes/collage.jpg' }; }),
        absoluteUrl: (p: string) => `https://d.com${p}`,
      },
      prompt,
      countImages: vi.fn(),
      facebookBuffer: { createFacebookPost: vi.fn(async (i: { text: string; imageUrl: string }) => { posts.push(i); return { postId: 'C1', account: 'A' }; }) },
      async eachAccount(this: { facebookBuffer: unknown }, _p: string, send: (pool: unknown, profile: undefined, first: boolean) => Promise<string>) {
        return { postId: await send(this.facebookBuffer, undefined, true), accounts: 1 };
      },
    } as never,
  };
}

const input = { seo: { title: 'Lemon Bars', description: 'Tangy bars' } as never, title: 'Lemon Bars', postUrl: 'https://d.com/recipe/lemon-bars', recipe: '{"ingredients":[]}' };

describe('the photo collage post', () => {
  it('skips when the collage setting is off', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET collage = 1 WHERE id = ?', id);
    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer', collage_enabled: '0' });
    const out = await collagePostStep.run(c.value, input);
    expect(out).toMatchObject({ skipped: expect.any(String) });
    expect(c.posts).toHaveLength(0);
  });

  it('skips when no page takes the collage', async () => {
    addManualFbPage({ name: 'Page', siteId: SITE }); // collage not ticked
    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer', collage_enabled: '1', collage_steps: '6' });
    const out = await collagePostStep.run(c.value, input);
    expect(out).toMatchObject({ skipped: expect.any(String) });
  });

  it('generates the set, composes a grid and posts it once, through one account', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET collage = 1 WHERE id = ?', id);
    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer', collage_enabled: '1', collage_steps: '6', collage_watermark: '1' }, 6);

    const out = await collagePostStep.run(c.value, input);

    expect(out).toEqual({ postId: 'C1', imageUrl: 'https://d.com/image/recipes/collage.jpg' });
    expect((c.value as { images: { submit: ReturnType<typeof vi.fn> } }).images.submit).toHaveBeenCalledTimes(6);
    expect(c.posts).toHaveLength(1);
    expect(c.posts[0]!.imageUrl).toBe('https://d.com/image/recipes/collage.jpg');
    expect(c.uploads[0]!.subarray(0, 3).toString('hex')).toBe('ffd8ff'); // a jpeg
  });

  it('retries a photo that fails once, and still posts the full grid', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET collage = 1 WHERE id = ?', id);
    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer', collage_enabled: '1', collage_steps: '6' }, 6);
    const submit = (c.value as { images: { submit: ReturnType<typeof vi.fn> } }).images.submit;
    submit.mockRejectedValueOnce(new Error('INJECTION_FAILED: Failed to fetch'));

    const out = await collagePostStep.run(c.value, input);
    expect(out).toEqual({ postId: 'C1', imageUrl: 'https://d.com/image/recipes/collage.jpg' });
    expect(submit).toHaveBeenCalledTimes(7); // 6 photos, one retried once
    expect(c.posts).toHaveLength(1);
  });

  it('posts with whatever photos survive, when enough of them do', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET collage = 1 WHERE id = ?', id);
    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer', collage_enabled: '1', collage_steps: '6' }, 6);
    const submit = (c.value as { images: { submit: ReturnType<typeof vi.fn> } }).images.submit;
    // Two photos fail on every attempt; the other four come through fine.
    submit.mockImplementation(async () => {
      throw new Error('nope');
    });
    submit.mockImplementationOnce(async () => 'job-1');
    submit.mockImplementationOnce(async () => 'job-1');
    submit.mockImplementationOnce(async () => 'job-1');
    submit.mockImplementationOnce(async () => 'job-1');

    const out = await collagePostStep.run(c.value, input);
    expect(out).toEqual({ postId: 'C1', imageUrl: 'https://d.com/image/recipes/collage.jpg' });
    expect(c.posts).toHaveLength(1);
  });

  it('gives up without posting when too few photos survive', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET collage = 1 WHERE id = ?', id);
    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer', collage_enabled: '1', collage_steps: '6' }, 6);
    const submit = (c.value as { images: { submit: ReturnType<typeof vi.fn> } }).images.submit;
    // Only two of six photos ever succeed — below the floor of four.
    submit.mockImplementation(async () => {
      throw new Error('nope');
    });
    submit.mockImplementationOnce(async () => 'job-1');
    submit.mockImplementationOnce(async () => 'job-1');

    const out = await collagePostStep.run(c.value, input);
    expect(out).toMatchObject({ error: expect.stringContaining('2 of 6') });
    expect(c.posts).toHaveLength(0);
  });

  it('reports a failure elsewhere in the step as an error, never a throw', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET collage = 1 WHERE id = ?', id);
    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer', collage_enabled: '1', collage_steps: '6' }, 6);
    (c.value as { siteApi: { uploadImage: ReturnType<typeof vi.fn> } }).siteApi.uploadImage.mockRejectedValueOnce(
      new Error('upload service down'),
    );

    const out = await collagePostStep.run(c.value, input);
    expect(out).toEqual({ error: 'upload service down' });
    expect(c.posts).toHaveLength(0);
  });

  /**
   * The site's only Facebook account, switched off ("in turn" unticked), but
   * Collage still ticked on its page. With nothing "usable", pickProfile
   * falls back to the site's one account anyway -- it has to return
   * something -- and without this check that lone disabled account would
   * still receive the collage.
   */
  it('does not post the collage through the site\'s only Facebook account when that account itself is switched off', async () => {
    const id = firstProfile(SITE, 'facebook').id;
    updateProfile(id, { enabled: 0 });
    upsertBufferAccount({ siteId: SITE, label: 'a', token: 'tok', enabled: true, profileId: id }, randomBytes(32));
    upsertFbPageForProfile(id, SITE, 'Page', true, true, true); // Collage ticked

    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer', collage_enabled: '1', collage_steps: '6' }, 6);
    c.value.eachAccount = async function (this: { facebookBuffer: unknown }, _p, send) {
      const targets = runTargets(null, SITE, 'facebook'); // real lookup, single account
      let postId = '';
      for (const [i, profile] of targets.entries()) {
        const pid = await send(this.facebookBuffer as never, profile, i === 0);
        if (pid === null) continue;
        if (i === 0) postId = pid;
      }
      return { postId, accounts: targets.length };
    };

    const out = await collagePostStep.run(c.value, input);
    expect(out).toMatchObject({ skipped: expect.any(String) });
    expect(c.posts).toHaveLength(0);
  });

  it('posting to all, skips an account that is switched off even though its page still has Collage ticked', async () => {
    const onId = firstProfile(SITE, 'facebook').id;
    upsertBufferAccount({ siteId: SITE, label: 'on', token: 'tok', enabled: true, profileId: onId }, randomBytes(32));
    upsertFbPageForProfile(onId, SITE, 'On Page', true, true, true);

    // Collage still ticked on this account's own page, but the account
    // itself ("in turn") is off -- it must not post regardless.
    const offId = addProfile(SITE, 'facebook');
    updateProfile(offId, { enabled: 0 });
    upsertBufferAccount({ siteId: SITE, label: 'off', token: 'tok', enabled: true, profileId: offId }, randomBytes(32));
    upsertFbPageForProfile(offId, SITE, 'Off Page', true, true, true);

    setPostToAll(SITE, 'facebook', true);

    const c = ctx({ fb_enabled: '1', reel_publisher: 'buffer', collage_enabled: '1', collage_steps: '6' }, 6);
    c.value.eachAccount = async function (this: { facebookBuffer: unknown }, _p, send) {
      const targets = runTargets(null, SITE, 'facebook');
      let postId = '';
      for (const [i, profile] of targets.entries()) {
        const id = await send(this.facebookBuffer as never, profile, i === 0);
        if (id === null) continue;
        if (i === 0) postId = id;
      }
      return { postId, accounts: targets.length };
    };

    const out = await collagePostStep.run(c.value, input);
    expect(out).toMatchObject({ postId: expect.any(String) });
    expect(c.posts).toHaveLength(1); // only the "on" account was ever posted to
  });
});

/**
 * Setup -> Reels -> "Publish reels through" also governs the collage now:
 * 'facebook' publishes straight to the Page over Graph API instead of going
 * through Buffer, and the real post id is in hand the moment it returns --
 * nothing for the webhook's backfill to do.
 */
describe('publishing the collage directly through Graph API', () => {
  it('publishes to the real synced page (bridged from the card) and never touches Buffer', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET collage = 1 WHERE id = ?', id);
    withSyncedPage('Page'); // the token-synced page the card bridges to

    const c = ctx({ fb_enabled: '1', reel_publisher: 'facebook', collage_enabled: '1', collage_steps: '6' }, 6);
    const out = await collagePostStep.run(c.value, input);

    expect(out).toEqual({ postId: '1000_2000', imageUrl: 'https://d.com/image/recipes/collage.jpg' });
    expect(fbClient.publishPhotoPost).toHaveLength(1);
    expect((fbClient.publishPhotoPost[0] as { pageId: string }).pageId).toBe('1000'); // the real id
    expect(c.posts).toHaveLength(0); // Buffer was never called
  });

  it('skips an account with no token and no synced page to bridge to, instead of throwing', async () => {
    const id = addManualFbPage({ name: 'Page', siteId: SITE });
    run('UPDATE fb_pages SET collage = 1 WHERE id = ?', id); // no withSyncedPage() this time

    const c = ctx({ fb_enabled: '1', reel_publisher: 'facebook', collage_enabled: '1', collage_steps: '6' }, 6);
    const out = await collagePostStep.run(c.value, input);

    expect(out).toMatchObject({ skipped: expect.any(String) });
    expect(fbClient.publishPhotoPost).toHaveLength(0);
  });
});
