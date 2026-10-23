import type { Step } from '../engine.js';
import type { SeoData } from './content.js';
import type { ArticleImages } from './images.js';
import type { PostedRecipe } from '../../integrations/site-api.js';
import { createLogger, errorMessage } from '../../lib/logger.js';
import { writeReelCaption } from '../../reels/caption.js';
import { markReelCaptionStructure, nextCaptionShape } from '../../core/caption-structures.js';
import {
  createReel,
  getReel,
  pageForSite,
  presenterForPage,
  reelsCreatedRecently,
  reelsElsewhere,
  setReelStage,
  updateReel,
} from '../../db/repos.js';
import {
  buildDidYouKnowPrompt,
  buildReelPrompt,
  isStudioMode,
  reelMode,
  referenceUrls,
  seedFromRun,
  singleReferenceRoles,
} from '../../reels/compose.js';
import { startGeneration } from '../../reels/engine.js';
import { reelCta } from '../../reels/cta.js';
import { markReelStructure, nextReelShape } from '../../core/reel-structures.js';

const log = createLogger('reel-step');

export interface CreateReelInput {
  seo: SeoData;
  posted: PostedRecipe;
  images: ArticleImages;
  title: string;
}

export interface CreateReelOutput {
  reelId: number | null;
  /** Why no reel was made. Not an error: the article is out either way. */
  skipped?: string;
  /** The reel exists but its video could not be queued; Retry on the reels page. */
  error?: string;
}

/**
 * Turn the article just published into a reel on a Facebook page of its site.
 *
 * The one place that decides a run gets a reel, checkpointed like every other
 * step, so a resumed run does not make a second one. It never fails the run:
 * by now the article is live, and a run marked failed after publishing reads
 * as an article that did not go out. What can go wrong is recorded on the
 * reel instead, where the reels page has a Retry for it.
 *
 * From here the reel engine takes over: it writes the storyboard, films the
 * scenes, assembles them, and publishes with the page's own token, and the
 * link goes in as the first comment.
 */
export const createReelStep: Step<CreateReelInput, CreateReelOutput> = {
  name: 'create-reel',
  title: 'Make the Facebook reel',
  async run(ctx, input) {
    if (!ctx.settings.getBool('fb_enabled')) {
      return { reelId: null, skipped: 'Facebook reels are off' };
    }

    // A batch of articles (an import, a catch-up) must not become a batch of
    // reels: each one costs Flow credits and a slot in every Buffer queue.
    // Checked before the caption, so a skipped reel costs no model call.
    const dailyMax = Math.floor(ctx.settings.getNumber('reel_daily_max'));
    if (dailyMax > 0) {
      const made = reelsCreatedRecently(ctx.site.id, 24);
      if (made >= dailyMax) {
        const skipped = `${ctx.site.domain} already has ${made} reel(s) in the last 24 hours (limit ${dailyMax})`;
        log.info(`run ${ctx.runId}: no reel — ${skipped}`);
        return { reelId: null, skipped };
      }
    }

    // The Facebook page the reel is for, when one takes reels. With none, the
    // reel is still made when another network takes it (Pinterest, Instagram,
    // YouTube, TikTok) -- those go out through Buffer, so only on that route.
    const page = pageForSite(ctx.site.id, 'reels') ?? null;
    if (!page) {
      const elsewhere = reelsElsewhere(ctx.site as Parameters<typeof reelsElsewhere>[0]);
      const viaBuffer = ctx.settings.get('reel_publisher') === 'buffer';
      if (!elsewhere || !viaBuffer) {
        const skipped = !elsewhere
          ? `no Facebook page of ${ctx.site.domain} takes reels, and no other network does`
          : `no Facebook page of ${ctx.site.domain} takes reels, and the other networks need Publish reels through Buffer`;
        log.info(`run ${ctx.runId}: no reel — ${skipped}`);
        return { reelId: null, skipped };
      }
    }
    const where = page ? page.name || page.page_id : 'the other networks (no Facebook page takes reels)';

    const title = input.title || input.seo.title;
    const host = ctx.site.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

    // The words under the reel, written for it. This used to be the title, so
    // every automatic reel went out as its own headline repeated — and the
    // caption rules were being applied on a path almost nothing took, since
    // nearly every reel is made here rather than by hand.
    // Setup -> Caption structures: the next shape for this site, so a page's
    // posts do not read as one post with different dishes in it.
    const shape = nextCaptionShape(ctx.site.id);
    const caption = await writeReelCaption(
      {
        title,
        group: ctx.keyword.seed_keyword,
        description: ctx.keyword.spy_description ?? '',
        annotation: ctx.keyword.annotation ?? '',
      },
      ctx.settings,
      ctx.encryptionKey,
      shape.shape,
    );

    // Setup -> Reels: one clip from one prompt, or a storyboard of scenes.
    const mode = reelMode(ctx.settings);
    if (!isStudioMode(mode)) {
      const presenter = page ? presenterForPage(page.id) : undefined;
      const scenes = nextReelShape(ctx.site.id);
      const templatePrompt = () =>
        buildReelPrompt({
          title,
          presenter: presenter ? { name: presenter.name, voice: presenter.voice_description } : null,
          cta: reelCta(ctx.settings.get('reel_cta_text'), ctx.site.domain),
          shape: scenes.shape,
        });
      // "Did you know": the model writes this recipe's own prompt. When it
      // cannot, the reel is still made, from the usual template.
      let videoPrompt = '';
      let didYouKnow = false;
      if (mode === 'didyouknow') {
        try {
          const recipe = seedFromRun(ctx.runId, host, input.images, title).article.recipe;
          videoPrompt = await buildDidYouKnowPrompt({ title, recipe }, (name, vars) => ctx.prompt(name, vars));
          didYouKnow = Boolean(videoPrompt);
        } catch (err) {
          log.warn(`run ${ctx.runId}: the "Did you know" prompt could not be written, using the usual one — ${errorMessage(err)}`);
        }
      }
      const reelId = createReel({
        runId: ctx.runId,
        siteId: ctx.site.id,
        keywordId: ctx.keyword.id,
        fbPageId: page?.id ?? null,
        prompt: videoPrompt || templatePrompt(),
        caption,
        references: referenceUrls(host, input.images, singleReferenceRoles(ctx.settings)),
      });
      if (shape.id) markReelCaptionStructure(reelId, shape.id);
      if (scenes.id && !didYouKnow) markReelStructure(reelId, scenes.id);
      // Clip + steps: the clip is made the same way; what comes after it needs the article.
      if (mode === 'mixed') {
        setReelStage(reelId, 'done', {
          planJson: JSON.stringify({ ...seedFromRun(ctx.runId, host, input.images, title), mixed: true }),
        });
      }
      if (didYouKnow) {
        setReelStage(reelId, 'done', {
          planJson: JSON.stringify({ ...seedFromRun(ctx.runId, host, input.images, title), didYouKnow: true }),
        });
      }

      try {
        await startGeneration(getReel(reelId)!, ctx.settings, ctx.images);
      } catch (err) {
        const error = errorMessage(err);
        updateReel(reelId, { status: 'failed', error });
        log.warn(`run ${ctx.runId}: reel ${reelId} could not start: ${error}`);
        return { reelId, error };
      }
      log.info(`run ${ctx.runId}: reel ${reelId} queued as one clip for ${where}`);
      return { reelId };
    }

    const reelId = createReel({
      runId: ctx.runId,
      siteId: ctx.site.id,
      keywordId: ctx.keyword.id,
      fbPageId: page?.id ?? null,
      prompt: '',
      caption,
      references: [],
      stage: 'planning',
    });
    if (shape.id) markReelCaptionStructure(reelId, shape.id);
    setReelStage(reelId, 'planning', {
      planJson: JSON.stringify({ ...seedFromRun(ctx.runId, host, input.images, title), process: mode === 'process' }),
    });

    log.info(`run ${ctx.runId}: reel ${reelId} queued for planning for ${where}`);
    return { reelId };
  },
};
