import { brandName } from '../../core/social-only.js';
import { randomUUID } from 'node:crypto';
import type { Step } from '../engine.js';
import type { SeoData } from './content.js';
import { getFbPageByProfile, pageForSite, recordFbFeedPost, recordFbFeedPostResolved, resolveFbGraphTarget } from '../../db/repos.js';
import { FacebookClient } from '../../integrations/facebook.js';
import { composeCollage } from '../../collage/compose.js';
import { planCollageSteps } from '../../collage/plan.js';
import { createLogger, errorMessage } from '../../lib/logger.js';
import { facebookPost, pickCommentKeyword, parseFacebookLinkMode, parseRecipeInPost, recipePostText } from '../../reels/recipe-text.js';

const log = createLogger('collage-post');

/** One photo generation is retried this many times before it is given up on. */
const ATTEMPTS_PER_PHOTO = 3;

/** Too thin a grid is not worth posting — below this, the whole collage is skipped instead. */
const MIN_PHOTOS = 4;

export interface CollagePostInput {
  seo: SeoData;
  title: string;
  postUrl: string;
  /** The recipe text the plan is written from — the same raw text the reel planner uses. */
  recipe: string;
}

export type CollagePostOutput =
  | { postId: string; imageUrl: string }
  | { skipped: string }
  | { error: string };

/**
 * A step-by-step photo collage on the site's Facebook Page, when the page
 * has Collage ticked (Channels -> Facebook).
 *
 * Unlike the hero/stepA/stepB/stepC photos the article already has, this
 * generates its own set of still-photograph images -- the model is asked to
 * break the recipe into N visual beats (Settings -> Collage), each one a
 * fresh generation, then they are laid into a grid and watermarked with the
 * site's own address, the way the reference "process collage" images do.
 *
 * Generation is one simple sequential loop inside this single step, rather
 * than N checkpointed steps the way the four article images are (see
 * images.ts): the step count here is a configurable setting (6/9/12), and a
 * dynamic list of steps does not fit the engine's static step list. The
 * accepted tradeoff: a failure partway through the loop means a resume
 * regenerates every image in the grid, not just the missing ones -- fine for
 * what is, after all, an optional bonus post, not the article itself.
 *
 * A single photo's generation is retried a few times on its own (Flow's
 * automation occasionally throws a transient INJECTION_FAILED / "Failed to
 * fetch" from the Chrome tab, which a second attempt usually clears) rather
 * than bubbling up and losing every photo already made before it. If photos
 * still come up short after retrying, the collage is posted with whatever
 * did succeed -- down to MIN_PHOTOS -- instead of throwing away a run that
 * already spent several minutes and several image credits.
 *
 * Like facebookPostStep, this goes out the way Setup -> Reels -> "Publish
 * reels through" says: straight to the Page over Graph API when that is set
 * to 'facebook' (the real post id comes back in the same response, nothing
 * for the comment-keyword webhook to wait on), or through the site's Buffer
 * account when it is set to 'buffer', the way it always has.
 *
 * Never fails the run: by the time this step runs the article is already
 * published, so every failure here is caught and reported back as
 * `{ error }`, never thrown.
 */
export const collagePostStep: Step<CollagePostInput, CollagePostOutput> = {
  name: 'collage-post',
  title: 'Post the step-by-step photo collage',
  async run(ctx, input) {
    if (!ctx.settings.getBool('fb_enabled')) return { skipped: 'Facebook is off' };
    if (!ctx.settings.getBool('collage_enabled')) return { skipped: 'the photo collage is off' };
    const page = pageForSite(ctx.site.id, 'collage');
    if (!page) return { skipped: 'no Facebook page of this site takes the collage' };

    const count = [6, 9, 12].includes(ctx.settings.getNumber('collage_steps'))
      ? ctx.settings.getNumber('collage_steps')
      : 9;

    try {
      const plan = await planCollageSteps({
        prompt: (name, vars) => ctx.prompt(name, vars),
        title: input.title || input.seo.title,
        recipe: input.recipe,
        count,
      });

      // Sequential, not parallel -- the image service is shared across every
      // site, and a burst of up to twelve requests at once is exactly the
      // kind of load the rate-limit gap in images.ts exists to avoid.
      const buffers: Buffer[] = [];
      for (const [i, shot] of plan.shots.entries()) {
        let lastError = '';
        for (let attempt = 1; attempt <= ATTEMPTS_PER_PHOTO; attempt++) {
          try {
            log.debug(`run ${ctx.runId}: generating collage photo ${i + 1}/${plan.shots.length} (attempt ${attempt})`);
            const jobId = await ctx.images.submit(shot.description, 'VERTICAL');
            const imageUrl = await ctx.images.waitForCompletion(jobId);
            const { data } = await ctx.images.download(imageUrl);
            buffers.push(data);
            ctx.countImages(1);
            lastError = '';
            break;
          } catch (err) {
            lastError = errorMessage(err);
            log.warn(
              `run ${ctx.runId}: collage photo ${i + 1}/${plan.shots.length} failed ` +
                `(attempt ${attempt}/${ATTEMPTS_PER_PHOTO}) — ${lastError}`,
            );
          }
        }
        if (lastError) {
          log.warn(`run ${ctx.runId}: giving up on collage photo ${i + 1}/${plan.shots.length}, continuing without it`);
        }
      }

      if (buffers.length < Math.min(MIN_PHOTOS, plan.shots.length)) {
        return { error: `only ${buffers.length} of ${plan.shots.length} photos came out; too thin a grid to post` };
      }

      const watermark = ctx.settings.getBool('collage_watermark')
        ? brandName(ctx.site)
        : undefined;
      const composed = await composeCollage(buffers, { watermark });

      const uploaded = await ctx.siteApi.uploadImage(composed, `${randomUUID()}.jpg`, 'image/jpeg', 'recipes');
      const imageUrl = ctx.siteApi.absoluteUrl(uploaded.url);

      let text = '';
      try {
        text = (await ctx.prompt('collage-caption', { seo: input.seo })).content.trim();
      } catch (err) {
        log.warn(`run ${ctx.runId}: could not write the collage text, using the title — ${errorMessage(err)}`);
      }
      // Each post asks for its own word, taken from the dish.
      const keyword = await pickCommentKeyword(
        input.title,
        async (title) => (await ctx.prompt('comment-keyword', { title })).content,
        ctx.settings.get('fb_comment_trigger').trim() || 'banana',
      );
      const post = facebookPost({
        body: text || input.title,
        recipe: recipePostText(ctx.runId, parseRecipeInPost(ctx.settings.get('caption_fb_post_recipe'))),
        postUrl: input.postUrl,
        link: parseFacebookLinkMode(ctx.settings.get('caption_fb_post_link')),
        keyword,
      });

      // Its own purpose, distinct from the plain 'facebook' key the article
      // post uses — the same run posts both to the same account, and without
      // separate keys this would see the article post already recorded and
      // skip ever actually sending the collage.
      //
      // Posting to all can still land on an account whose own card has
      // Collage switched off, so each account is checked against its own
      // page here rather than trusting the gate above, which only asks
      // whether *some* page of this site takes the collage.
      const direct = ctx.settings.get('reel_publisher') !== 'buffer';
      const { postId } = await ctx.eachAccount('facebook', async (pool, profile) => {
        // See facebook-post.ts: the account's own "in turn" switch is
        // separate from the page's Posts/Reels/Collage checkboxes, and a
        // disabled account must not post even when Collage is still ticked.
        if (profile && !profile.enabled) {
          log.info(`run ${ctx.runId}: skipping the collage on "${profile.label}" — the account is off`);
          return null;
        }
        const target = profile ? getFbPageByProfile(profile.id) : page;
        if (!target || target.collage !== 1) {
          log.info(`run ${ctx.runId}: skipping the collage on "${profile?.label ?? page.name}" — Collage is off for that account`);
          return null;
        }

        if (direct) {
          const resolved = resolveFbGraphTarget(target.id, ctx.encryptionKey);
          if (!resolved) {
            log.warn(`run ${ctx.runId}: "${target.name}" has no Facebook token (its own or a synced page's), skipping the direct collage post`);
            return null;
          }
          const client = new FacebookClient({ systemUserToken: resolved.token });
          const posted = await client.publishPhotoPost({ pageId: resolved.pageId, imageUrl, caption: post.text });
          log.info(`run ${ctx.runId}: collage published directly as ${posted.postId}`);
          if (post.firstComment) {
            try {
              await client.commentOnPost({ pageId: resolved.pageId, postId: posted.postId, message: post.firstComment });
            } catch (err) {
              log.warn(`run ${ctx.runId}: collage published, but the link comment failed — ${errorMessage(err)}`);
            }
          }
          recordFbFeedPostResolved({ runId: ctx.runId, fbPageId: target.id, purpose: 'facebook-collage', fbPostId: posted.postId, triggerKeyword: keyword });
          return posted.postId;
        }

        const posted = await pool.createFacebookPost({ text: post.text, imageUrl, firstComment: post.firstComment });
        log.info(`run ${ctx.runId}: collage scheduled as ${posted.postId} via "${posted.account}"`);
        // See facebook-post.ts: recorded now so the comment-keyword webhook
        // can find this post even if a later account in the fan-out fails.
        recordFbFeedPost({ runId: ctx.runId, fbPageId: target.id, purpose: 'facebook-collage', bufferPostId: posted.postId, triggerKeyword: keyword });
        return posted.postId;
      }, 'facebook-collage');
      if (!postId) return { skipped: 'Collage is off on every Facebook account this run would reach' };
      return { postId, imageUrl };
    } catch (err) {
      const message = errorMessage(err);
      log.warn(`run ${ctx.runId}: the collage was not posted — ${message}`);
      return { error: message };
    }
  },
};
