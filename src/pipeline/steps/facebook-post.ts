import { recipeFileName } from '../../lib/file-name.js';
import type { Step } from '../engine.js';
import type { SeoData } from './content.js';
import { getFbPageByProfile, pageForSite, recordFbFeedPost, recordFbFeedPostResolved, resolveFbGraphTarget } from '../../db/repos.js';
import { FacebookClient } from '../../integrations/facebook.js';
import { cropForFacebookFeed, fitForFacebookFeed } from '../../lib/crop.js';
import { createLogger, errorMessage } from '../../lib/logger.js';
import { facebookPost, pickCommentKeyword, parseFacebookLinkMode, type FacebookLinkMode, parseRecipeInPost, recipePostText } from '../../reels/recipe-text.js';

const log = createLogger('facebook-post');

export interface FacebookPostInput {
  seo: SeoData;
  title: string;
  postUrl: string;
  /** The Pinterest graphic's path on the site: the post's picture. */
  pinImageUrl: string;
  /** The article's hero photo on the site: used only when there is no pin graphic. */
  heroImageUrl?: string;
  /** Text written for this post already (More posts); left out, the Facebook prompt writes it. */
  text?: string;
  /** More posts: this site's own choice about the link, over the one in Setup. */
  linkMode?: FacebookLinkMode;
}

/** `source` tells the Instagram post whether the picture is the plain photo it can reuse. */
export type FacebookPostOutput = { postId: string; imageUrl: string; source: 'pin' | 'hero' } | { skipped: string };

/**
 * An image post on the site's Facebook Page for the article, when the page
 * has Posts ticked (Channels -> Facebook).
 *
 * The picture is the same Pinterest graphic, shown whole on Facebook's 4:5
 * feed shape with blurred sides (cut to 4:5 it lost its title or half the
 * dish). Without a graphic, the hero photo cut to 4:5 around its middle.
 * The text is a short post written for a Facebook feed, then the recipe link.
 *
 * Goes out the way Setup -> Reels -> "Publish reels through" says a reel
 * does: 'facebook' publishes straight to the Page over Graph API, with the
 * real post id back in the same response -- nothing for the comment-keyword
 * webhook to wait on. 'buffer' schedules through the site's Buffer account
 * instead, the way it always has, and the post's real id only shows up later
 * through the backfill.
 */
export const facebookPostStep: Step<FacebookPostInput, FacebookPostOutput> = {
  name: 'facebook-post',
  title: 'Schedule the Facebook post',
  async run(ctx, input) {
    if (!ctx.settings.getBool('fb_enabled')) return { skipped: 'Facebook is off' };
    const page = pageForSite(ctx.site.id, 'posts');
    if (!page) return { skipped: 'no Facebook page of this site takes posts' };
    const source = input.pinImageUrl ? 'pin' : 'hero';
    const picture = input.pinImageUrl || input.heroImageUrl;
    if (!picture) return { skipped: 'no picture to post' };

    const host = ctx.site.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const absolute = /^https?:\/\//.test(picture) ? picture : `https://${host}${picture}`;
    const file = await ctx.images.download(absolute);
    const cropped = source === 'pin' ? await fitForFacebookFeed(file.data) : await cropForFacebookFeed(file.data, 'center');
    const uploaded = await ctx.siteApi.uploadImage(cropped, recipeFileName(ctx.keyword?.seed_keyword ?? '', 'facebook', 'jpg'), 'image/jpeg', 'recipes');
    const imageUrl = ctx.siteApi.absoluteUrl(uploaded.url);

    let text = (input.text ?? '').trim();
    try {
      if (!text) text = (await ctx.prompt('facebook-post', { seo: input.seo })).content.trim();
    } catch (err) {
      log.warn(`run ${ctx.runId}: could not write the Facebook text, using the title — ${errorMessage(err)}`);
    }
    // The recipe and where the link goes are Setup -> Caption structures; the
    // defaults put the recipe under the text, the link last.
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
      link: input.linkMode ?? parseFacebookLinkMode(ctx.settings.get('caption_fb_post_link')),
      keyword,
    });

    // One account in rotation, every one when the site posts to all — the
    // same text and the same picture on each. Posting to all can still land
    // on an account whose own card has Posts switched off, so each account
    // is checked against its own page here rather than trusting the gate
    // above, which only asks whether *some* page of this site takes posts.
    const direct = ctx.settings.get('reel_publisher') !== 'buffer';
    const { postId } = await ctx.eachAccount('facebook', async (pool, profile) => {
      // The account's own "in turn" switch (Channels -> Accounts, shown as
      // the "off" badge) is a separate flag from the page's Posts/Reels/
      // Collage checkboxes -- a disabled account must not post even when
      // those boxes are still ticked.
      if (profile && !profile.enabled) {
        log.info(`run ${ctx.runId}: skipping the Facebook post on "${profile.label}" — the account is off`);
        return null;
      }
      const target = profile ? getFbPageByProfile(profile.id) : page;
      if (!target || target.posts !== 1) {
        log.info(`run ${ctx.runId}: skipping the Facebook post on "${profile?.label ?? page.name}" — Posts is off for that account`);
        return null;
      }

      if (direct) {
        const resolved = resolveFbGraphTarget(target.id, ctx.encryptionKey);
        if (!resolved) {
          log.warn(`run ${ctx.runId}: "${target.name}" has no Facebook token (its own or a synced page's), skipping the direct post`);
          return null;
        }
        const client = new FacebookClient({ systemUserToken: resolved.token });
        const posted = await client.publishPhotoPost({ pageId: resolved.pageId, imageUrl, caption: post.text });
        log.info(`run ${ctx.runId}: Facebook post published directly as ${posted.postId}`);
        if (post.firstComment) {
          try {
            await client.commentOnPost({ pageId: resolved.pageId, postId: posted.postId, message: post.firstComment });
          } catch (err) {
            log.warn(`run ${ctx.runId}: Facebook post published, but the link comment failed — ${errorMessage(err)}`);
          }
        }
        // The real post id is already in hand -- nothing for the backfill
        // to do, unlike the Buffer path below.
        recordFbFeedPostResolved({ runId: ctx.runId, fbPageId: target.id, purpose: 'facebook', fbPostId: posted.postId, triggerKeyword: keyword });
        return posted.postId;
      }

      const posted = await pool.createFacebookPost({ text: post.text, imageUrl, firstComment: post.firstComment });
      log.info(`run ${ctx.runId}: Facebook post scheduled as ${posted.postId} via "${posted.account}"`);
      // Recorded now, not after the step returns -- the comment-keyword
      // webhook ("banana") needs this row to find its way from a native post
      // id back to this run, and it must survive even if a later account in
      // the fan-out fails.
      recordFbFeedPost({ runId: ctx.runId, fbPageId: target.id, purpose: 'facebook', bufferPostId: posted.postId, triggerKeyword: keyword });
      return posted.postId;
    });
    if (!postId) return { skipped: 'Posts is off on every Facebook account this run would reach' };
    return { postId, imageUrl, source };
  },
};
