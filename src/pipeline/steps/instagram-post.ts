import { randomUUID } from 'node:crypto';
import type { Step } from '../engine.js';
import type { SeoData } from './content.js';
import { getCompletedStep } from '../../db/repos.js';
import { cropForFacebookFeed } from '../../lib/crop.js';
import { createLogger, errorMessage } from '../../lib/logger.js';
import { instagramLink } from '../../core/instagram-link.js';
import { composeWithRecipe, parseRecipeInPost, recipeCandidates } from '../../reels/recipe-text.js';

const log = createLogger('instagram-post');

export interface InstagramPostInput {
  seo: SeoData;
  title: string;
  postUrl: string;
  /** The article's hero photo on the site. */
  heroImageUrl: string;
  /** Caption written for this post already (More posts); left out, the Instagram prompt writes it. */
  caption?: string;
  /** More posts: this site's own choice about the link, over the one in Setup. */
  link?: 'yes' | 'no';
}

export type InstagramPostOutput = { postId: string; imageUrl: string } | { skipped: string };

/**
 * An Instagram post for the article, when the site has Channels -> Instagram
 * -> Posts ticked: the hero photo at 4:5 (the same one the Facebook post
 * uses, when there is one), a caption written for Instagram, and the recipe
 * link in the first comment -- Instagram captions cannot carry a link.
 * Scheduled through the site's Buffer account, on its Instagram channel.
 */
export const instagramPostStep: Step<InstagramPostInput, InstagramPostOutput> = {
  name: 'instagram-post',
  title: 'Schedule the Instagram post',
  async run(ctx, input) {
    if (!(ctx.site as { ig_posts?: number }).ig_posts) return { skipped: 'Instagram posts are off for this site' };
    if (!input.heroImageUrl) return { skipped: 'no picture to post' };

    // The Facebook post may already have cut and uploaded this photo; use that
    // copy -- only when it is the photo, not the pin graphic Facebook now shows.
    let imageUrl = '';
    const fb = getCompletedStep(ctx.runId, 'facebook-post');
    try {
      const out = JSON.parse(fb?.output_json ?? '{}') as { imageUrl?: string; source?: string };
      imageUrl = out.source === 'hero' ? out.imageUrl ?? '' : '';
    } catch {
      imageUrl = '';
    }
    if (!imageUrl) {
      const host = ctx.site.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      const source = await ctx.images.download(/^https?:\/\//.test(input.heroImageUrl) ? input.heroImageUrl : `https://${host}${input.heroImageUrl}`);
      const uploaded = await ctx.siteApi.uploadImage(await cropForFacebookFeed(source.data, 'center'), `${randomUUID()}.jpg`, 'image/jpeg', 'recipes');
      imageUrl = ctx.siteApi.absoluteUrl(uploaded.url);
    }

    const link: { line: string; firstComment?: string } =
      input.link === 'no'
        ? { line: '' }
        : instagramLink(
            input.link === 'yes' ? { get: (k: string) => (k === 'ig_link_mode' ? 'comment' : ctx.settings.get(k as never)) } : ctx.settings,
            input.postUrl,
          );
    let text = (input.caption ?? '').trim();
    try {
      if (!text) text = (await ctx.prompt('instagram-post', { seo: input.seo, linkLine: link.line })).content.trim();
    } catch (err) {
      log.warn(`run ${ctx.runId}: could not write the Instagram caption, using the title — ${errorMessage(err)}`);
    }
    let caption = text || [input.title, link.line].filter(Boolean).join('\n\n');

    // With a recipe the link line moves under it, and the hashtags last. A
    // recipe that does not fit in 2200 characters gives way to the ingredients,
    // then to the caption as written.
    const recipes = recipeCandidates(ctx.runId, parseRecipeInPost(ctx.settings.get('caption_ig_post_recipe')));
    if (recipes.length > 0) {
      const words = text
        ? text.split(/\r?\n/).filter((line) => !link.line || line.trim() !== link.line.trim()).join('\n')
        : input.title;
      caption = composeWithRecipe({ body: words, recipes, tail: link.line ? [link.line] : [], limit: 2200 });
    }

    // One account in rotation, every one when the site posts to all.
    const { postId } = await ctx.eachAccount('instagram', async (pool) => {
      const posted = await pool.createInstagramPost({
        text: caption,
        type: 'post',
        imageUrl,
        firstComment: link.firstComment,
      });
      log.info(`run ${ctx.runId}: Instagram post scheduled as ${posted.postId} via "${posted.account}"`);
      return posted.postId;
    });
    if (!postId) return { skipped: 'every Instagram account this run reaches is switched off' };
    return { postId, imageUrl };
  },
};
