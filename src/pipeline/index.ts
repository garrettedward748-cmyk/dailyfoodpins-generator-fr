import { runStep, StepFailedError } from './engine.js';
import { PipelineContext } from './context.js';
import {
  fetchCategories,
  fetchCuisines,
  generateImagePrompts,
  generateRecipe,
  SpyRejectedError,
  validateSpy,
} from './steps/content.js';
import {
  ARTICLE_IMAGE_STEPS,
  generateArticleImages,
  generatePinImage,
  type ArticleImageUploads,
} from './steps/images.js';
import { generateArticle, postArticle } from './steps/article.js';
import { createReelStep } from './steps/reel.js';
import {
  generatePinDescription,
  notify,
  publishToBuffer,
  resolveBufferTarget,
} from './steps/publish.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import {
  markRunFailed,
  markRunSkipped,
  markRunHeld,
  invalidateStep,
  markRunPublished,
  publishedTitles,
  setKeywordStatus,
  setLink,
  setRunTitle,
  getLinksForKeyword,
} from '../db/repos.js';
import { findDuplicate, type DuplicateMatch } from '../core/similar-title.js';
import { AlreadyOnSiteError, checkNotOnSite, NotHalalError } from './steps/duplicate.js';
import { facebookPostStep } from './steps/facebook-post.js';
import { collagePostStep } from './steps/collage.js';
import { instagramPostStep } from './steps/instagram-post.js';
import { recipeToolsStep } from './steps/recipe-tools.js';
import { researchGoogle } from './steps/research.js';
import { pageForSite } from '../db/repos.js';
import { isSocialOnly, sitePostUrl } from '../core/social-only.js';
import type { Step } from './engine.js';
import type { SeoData } from './steps/content.js';
import type { PostedRecipe } from '../integrations/site-api.js';

const log = createLogger('pipeline');

/** Ordered list of steps, for display in the UI before a run starts. */
export const PIPELINE_STEPS = [
  fetchCategories,
  fetchCuisines,
  validateSpy,
  researchGoogle,
  generateRecipe,
  generateImagePrompts,
  ...ARTICLE_IMAGE_STEPS,
  generateArticleImages,
  generateArticle,
  postArticle,
  generatePinImage,
  generatePinDescription,
  resolveBufferTarget,
  publishToBuffer,
  notify,
  createReelStep,
].map((s) => ({ name: s.name, title: s.title }));

export interface PipelineOutcome {
  status: 'published' | 'failed' | 'spy-rejected' | 'held' | 'duplicate';
  postId?: string;
  postUrl?: string;
  error?: string;
  failedStep?: string;
  /** Why it stopped short of publishing, when it did. */
  hold?: 'awaiting' | 'dry';
}

/**
 * The article's own title, however the model chose to name the field.
 *
 * Used for the near-duplicate check and to give a held run something readable
 * to be listed under. A missing title is not worth failing a run over — the
 * assembled article is already checked for one in generate-article.
 */
export function articleTitle(article: Record<string, unknown>): string {
  const candidate = article.title ?? article.name ?? article.headline;
  return typeof candidate === 'string' ? candidate.trim() : '';
}

/**
 * Execute the full generation and publishing pipeline for one run.
 *
 * Every step is checkpointed, so calling this again with the same runId
 * resumes rather than restarting.
 */
export async function executePipeline(ctx: PipelineContext): Promise<PipelineOutcome> {

  try {
    await runStep(ctx, checkNotOnSite, undefined);
    // A social-only account has no site to file an article under: no
    // categories, no cuisines, no SEO description. It goes straight to the
    // recipe, titled from the keyword.
    const seo = isSocialOnly(ctx.site)
      ? await runStep(ctx, socialSeoStep, undefined)
      : await runStep(ctx, validateSpy, {
          categories: await runStep(ctx, fetchCategories, undefined),
          cuisines: await runStep(ctx, fetchCuisines, undefined),
        });
    ctx.research = await runStep(ctx, researchGoogle, seo);
    const recipe = await runStep(ctx, generateRecipe, seo);
    const imagePrompts = await runStep(ctx, generateImagePrompts, { seo, recipe });
    // One step per image, so a resume owes only the ones that are missing.
    const uploads = {} as ArticleImageUploads;
    for (const step of ARTICLE_IMAGE_STEPS) {
      uploads[step.slot] = await runStep(ctx, step, imagePrompts[step.slot]);
    }
    const images = await runStep(ctx, generateArticleImages, {
      uploads,
      stepNumbers: imagePrompts.stepNumbers,
    });

    // A social-only account has no website to publish an article on: the
    // recipe is written (the posts carry it) but the article is not.
    const social = isSocialOnly(ctx.site);
    const article = social ? {} : await runStep(ctx, generateArticle, { seo, recipe, images });
    const title = social ? seo.title : articleTitle(article);

    // Recorded before publishing, so a run held for approval is listed under
    // its title and a run that fails at the post still says what it wrote.
    if (title) setRunTitle(ctx.runId, title);

    const duplicate = warnOnNearDuplicate(ctx, title);

    // -- The gate before anything reaches a live site. ---------------------
    const hold = holdReason(ctx, duplicate);
    if (hold) {
      markRunHeld(ctx.runId, hold, title);
      log.info(
        `run ${ctx.runId}: stopping before publish (${hold}` +
          (duplicate && isSameTitle(duplicate) ? ', identical title already on the site' : '') +
          ') — resume it to publish, every completed step is reused',
      );
      return { status: 'held', hold, postUrl: undefined };
    }

    const posted = social
      ? await runStep(ctx, skipArticleStep, { seo })
      : await postOrRewrite(ctx, article, { seo, recipe, images });

    // -- Published. Everything after this point is distribution. -----------
    // Empty for a social-only account, and every post then goes out without a link.
    const postUrl = sitePostUrl(ctx.site, posted.href);

    // The "Tools I used" box (Amazon links on the site). Never fails the run.
    if (!social) {
      try {
        await runStep(ctx, recipeToolsStep, { title: title || seo.title, recipe, posted });
      } catch (err) {
        const cause = err instanceof StepFailedError ? err.cause : err;
        log.warn(`run ${ctx.runId}: published, but the tools list was not sent — ${errorMessage(cause)}`);
      }
    }
    markRunPublished(ctx.runId, String(posted.id), postUrl, title);
    markPairDone(ctx);

    // The pin graphic is made when Pinterest takes posts, and also for the
    // Facebook post, which shows the same graphic. Channels -> Pinterest ->
    // Posts off only stops it going to Pinterest.
    const pinPosts = (ctx.site as { pin_posts?: number }).pin_posts !== 0;
    const fbPage = ctx.settings.getBool('fb_enabled') ? pageForSite(ctx.site.id, 'posts') : undefined;
    const fbPosts = Boolean(fbPage?.posts);
    let pinImageUrl = '';
    if (!pinPosts && !fbPosts) {
      log.info(`run ${ctx.runId}: Pinterest and Facebook posts are off for ${ctx.site.domain}, no pin`);
    } else {
      const pinImage = await runStep(ctx, generatePinImage, { seo, prompts: imagePrompts });
      const pin = { seo, posted, pinImageUrl: pinImage.url, cta: pinImage.cta };
      pinImageUrl = pinImage.url;

      // The Pinterest block is skipped wholesale when Buffer is off. Resolving
      // a channel and board calls the Buffer API, so checking the flag only at
      // the final publish step would still hit a service the operator disabled.
      //
      // And it never fails the run. The article is already on the site and the
      // run is already marked published; throwing here overwrote that with
      // "failed", so a site with no Buffer account — which is a setting nobody
      // has filled in, not a broken run — reported every published article as a
      // failure and skipped the notification and the reel behind it.
      if (!pinPosts) {
        log.info(`run ${ctx.runId}: Pinterest posts are off for ${ctx.site.domain}, the pin is made for Facebook only`);
      } else if (ctx.settings.getBool('buffer_enabled')) {
        try {
          const description = await runStep(ctx, generatePinDescription, pin);
          const target = await runStep(ctx, resolveBufferTarget, seo);
          await runStep(ctx, publishToBuffer, { pin, description, target });
        } catch (err) {
          const cause = err instanceof StepFailedError ? err.cause : err;
          log.warn(
            `run ${ctx.runId}: published, but the Pinterest pin was not scheduled — ` +
              errorMessage(cause),
          );
        }
      } else {
        log.info(`run ${ctx.runId}: Buffer disabled, skipping Pinterest distribution`);
      }
    }

    if (fbPosts) {
      try {
        await runStep(ctx, facebookPostStep, { seo, title: title || seo.title, postUrl, pinImageUrl, heroImageUrl: images.hero });
      } catch (err) {
        const cause = err instanceof StepFailedError ? err.cause : err;
        log.warn(`run ${ctx.runId}: published, but the Facebook post was not scheduled — ${errorMessage(cause)}`);
      }
    }

    // Bonus distribution, same as the plain Facebook post: never the reason
    // a run fails, and gated on its own settings and its own page flag so an
    // operator who has not turned it on pays nothing extra for it.
    try {
      await runStep(ctx, collagePostStep, { seo, title: title || seo.title, postUrl, recipe: recipe.raw });
    } catch (err) {
      const cause = err instanceof StepFailedError ? err.cause : err;
      log.warn(`run ${ctx.runId}: published, but the photo collage was not posted — ${errorMessage(cause)}`);
    }

    if ((ctx.site as { ig_posts?: number }).ig_posts) {
      try {
        await runStep(ctx, instagramPostStep, { seo, title: title || seo.title, postUrl, heroImageUrl: images.hero });
      } catch (err) {
        const cause = err instanceof StepFailedError ? err.cause : err;
        log.warn(`run ${ctx.runId}: published, but the Instagram post was not scheduled — ${errorMessage(cause)}`);
      }
    }

    await runStep(ctx, notify, { seo, posted, pinImageUrl });

    // Last, and never the reason a run fails: the article is out by now.
    await runStep(ctx, createReelStep, { seo, posted, images, title });

    log.info(`run ${ctx.runId}: complete — ${postUrl || `${ctx.site.domain} (social only, posts without a link)`}`);
    return { status: 'published', postId: String(posted.id), postUrl };
  } catch (err) {
    const cause = err instanceof StepFailedError ? err.cause : err;
    const failedStep = err instanceof StepFailedError ? err.step : 'unknown';

    // A rejected spy source is a data verdict, not a system failure. Mark the
    // keyword unusable so the selector stops offering it, and end cleanly.
    // The dish is already on this site: not a failure to retry. This site
    // is done with the keyword; other sites it is linked to still get it.
    if (cause instanceof NotHalalError) {
      const detail = `Skipped: ${cause.message}`;
      log.info(`run ${ctx.runId}: ${detail}`);
      setKeywordStatus(ctx.keyword.id, 'no');
      markRunSkipped(ctx.runId, detail, failedStep);
      return { status: 'duplicate', error: detail, failedStep };
    }

    if (cause instanceof AlreadyOnSiteError) {
      const detail = `Skipped: ${cause.message}${cause.existingUrl ? ` — ${cause.existingUrl}` : ''}`;
      log.info(`run ${ctx.runId}: ${detail}`);
      setLink(ctx.keyword.id, ctx.site.id, 'no');
      markRunSkipped(ctx.runId, detail, failedStep);
      return { status: 'duplicate', error: detail, failedStep };
    }

    if (cause instanceof SpyRejectedError) {
      log.info(`run ${ctx.runId}: spy source rejected, marking keyword 'no'`);
      setKeywordStatus(ctx.keyword.id, 'no');
      // Not a failure of the platform: the keyword names a topic, not one
      // dish, and is set to 'no' so it never comes back. Shown as skipped so
      // the failed count stays about things that need a hand.
      markRunSkipped(ctx.runId, `Skipped: not one dish to write a recipe for — ${cause.detail}`, failedStep);
      return { status: 'spy-rejected', error: cause.detail, failedStep };
    }

    const message = errorMessage(cause);
    markRunFailed(ctx.runId, message, failedStep);
    log.error(`run ${ctx.runId}: failed at "${failedStep}"`, message);

    return { status: 'failed', error: message, failedStep };
  }
}

/**
 * Record that this keyword has now been used on this site, and close the
 * keyword globally once no site is still waiting for it.
 */
function markPairDone(ctx: PipelineContext): void {
  setLink(ctx.keyword.id, ctx.site.id, 'done');

  const remaining = getLinksForKeyword(ctx.keyword.id).filter((l) => l.status === 'go');
  if (remaining.length === 0) {
    setKeywordStatus(ctx.keyword.id, 'done');
    log.info(`keyword ${ctx.keyword.id} complete on every linked site`);
  }
}

export { PipelineContext };

/**
 * The SEO step of a social-only account: no model and no site taxonomy. The
 * keyword's own title is the recipe's title. Recorded under the same name as
 * the real step, so every later tool that reads a run's SEO (the pin, the
 * collage, More posts, reels) finds it.
 */
export const socialSeoStep: Step<void, SeoData> = {
  name: 'validate-spy',
  title: 'No website: title taken from the keyword',
  async run(ctx) {
    const title = ctx.keyword.spy_title.trim();
    if (!title) {
      throw new SpyRejectedError(
        'This keyword has no spy title, so there is nothing to say which dish it is. ' +
          'The seed keyword is a topic group, not a recipe.',
      );
    }
    return {
      keyword: title.toLowerCase(),
      title,
      // What the posts' "About it" line reads; the keyword's own note when it has one.
      description: (ctx.keyword.spy_description ?? '').trim() || title,
      category: '',
      cuisine: '',
    };
  },
};

/**
 * The article step of a social-only account: nothing is published, and what
 * comes back stands in for a published recipe with no link. Recorded under the
 * same name as the real one, so every later tool that reads a run's article
 * (Retry the pin, the collage, More posts) finds it and builds no link.
 */
export const skipArticleStep: Step<{ seo: SeoData }, PostedRecipe> = {
  name: 'post-article',
  title: 'No website: article skipped',
  async run(_ctx, { seo }) {
    return { id: '', title: seo.title, href: '', categoryId: '' };
  },
};

/**
 * The site's API refusing the document itself, as opposed to refusing us.
 *
 * A 400 or 422 with the site's wording is a complaint about what was sent:
 * a field the model filled in a way the site's validation does not accept.
 * A 401 or 403 is about the token, a 5xx is about the site, and a timeout is
 * about the network -- none of which a different article would change.
 *
 * One 5xx is the exception: a site answering 500 with `"error":"insert_failed"`
 * is its database refusing the row, not the site being down. In every case
 * seen so far that is a unique-constraint collision -- this run's slug or
 * title already belongs to another recipe on the site -- and the model picks
 * both from the title it is given, so three repair attempts keep proposing
 * the same one. A different article gets a different title and slug, same as
 * a 400 does, so it is treated the same way. A bare 500 with no such body
 * (the site actually down, or mid-deploy) is left alone: a different article
 * would not help it come back.
 */
export function isPayloadRejection(error: string): boolean {
  if (/rejected by [^:]+: HTTP (400|422)(?!\d)/.test(error)) return true;
  if (/rejected by [^:]+: HTTP 500\b.*"error"\s*:\s*"insert_failed"/.test(error)) return true;
  return false;
}

/**
 * Publish, and if the site will not take the article, write it again.
 *
 * The post step already asks the model to repair the document against the
 * site's complaint and tries three times. When that is not enough -- the
 * model kept the value the site objects to, or fixed one thing and broke
 * another -- the article itself is the problem, and every later attempt at
 * posting it is the same attempt. Resuming the run reused the stored article
 * and walked into the same wall, and nothing a person could do from the page
 * changed that.
 *
 * So the article is written once more, from the same recipe and images, and
 * posted. The first checkpoint is retired before that, or the resume logic
 * would hand back the rejected document as "already completed". If the
 * rewrite is refused as well, the checkpoint is retired again on the way out,
 * so a person who resumes gets a third article rather than the second one
 * re-sent.
 *
 * Only a payload rejection earns a rewrite. A bad token or a site that is
 * down fails the same way for any article, and rewriting one would spend the
 * model on a problem it cannot touch.
 */
async function postOrRewrite(
  ctx: PipelineContext,
  article: Record<string, unknown>,
  inputs: Parameters<typeof generateArticle.run>[1],
) {
  try {
    return await runStep(ctx, postArticle, article);
  } catch (err) {
    const reason = errorMessage(err);
    if (!isPayloadRejection(reason)) throw err;

    log.warn(
      `run ${ctx.runId}: ${ctx.site.domain} rejected the article and repair did not fix it — ` +
        'writing it again from scratch',
    );
    invalidateStep(ctx.runId, generateArticle.name, `Rejected by the site; rewritten. ${reason}`);
    invalidateStep(ctx.runId, postArticle.name, reason);

    const rewritten = await runStep(ctx, generateArticle, inputs);
    const title = articleTitle(rewritten);
    if (title) setRunTitle(ctx.runId, title);

    try {
      return await runStep(ctx, postArticle, rewritten);
    } catch (again) {
      // Leave no 'ok' article behind: a resume must write a third one rather
      // than re-post the second.
      invalidateStep(
        ctx.runId,
        generateArticle.name,
        `Rejected by the site twice; a resume writes it again. ${errorMessage(again)}`,
      );
      throw again;
    }
  }
}

/**
 * Whether this run stops before publishing, and why.
 *
 * Two different requests with one mechanism: a dry run was never going to
 * publish, and a site with auto-publish off wants a person to read the article
 * first. Both stop at the same place and both are released the same way — by
 * resuming the run, which reuses every completed step, so releasing an article
 * costs one HTTP post rather than a second pipeline.
 */
/**
 * Not a near-duplicate: the same title.
 *
 * The similarity is Jaccard over the words that name the dish, so 1.0 means
 * the two titles differ in nothing but punctuation and filler. That is no
 * longer a heuristic that might be wrong about two dishes; it is one dish,
 * twice.
 */
export const isSameTitle = (match: DuplicateMatch): boolean => match.similarity >= 1;

function holdReason(
  ctx: PipelineContext,
  duplicate: DuplicateMatch | null,
): 'awaiting' | 'dry' | null {
  // Approving is a resume, and the site's setting has not changed by then —
  // so without this the article is held again and approval publishes nothing.
  if (ctx.approved) return null;

  if (ctx.mode === 'dry') return 'dry';
  if (ctx.site.auto_publish === 0) return 'awaiting';

  // An identical title stops here, whatever the site's publishing setting.
  //
  // Three runs of one keyword went through in half an hour while the panel
  // was unreachable, each one warned that the title was already on the site
  // at 100%, and each one published. Four copies of "Creamy Garlic Chicken
  // Thighs" on the front page. The warning below is right that a similarity
  // score must not bin finished work on its own -- so this does not bin it.
  // It holds it, on the same page a site with auto-publish off already uses,
  // with the existing article linked beside Approve and Discard. The work is
  // kept; a person decides; the default is that it does not go out twice.
  if (duplicate && isSameTitle(duplicate)) return 'awaiting';

  return null;
}

/**
 * Say so when this site already has an article with almost this title.
 *
 * A warning, never a failure. The article exists and the images are paid for
 * by the time this runs, so throwing it away over a similarity score would
 * cost more than the duplicate does — and the score is a heuristic, which is
 * not something that should be able to bin finished work on its own.
 *
 * It goes into the run's step log and, on a held run, onto the page where the
 * article is read before release. The match is returned so that one case --
 * an identical title, which is not a heuristic -- can hold the run instead.
 */
function warnOnNearDuplicate(ctx: PipelineContext, title: string): DuplicateMatch | null {
  if (!title) return null;

  try {
    const match = findDuplicate(title, publishedTitles(ctx.site.id));
    if (!match) return null;

    log.warn(
      `run ${ctx.runId}: "${title}" looks like "${match.title}" already on ` +
        `${ctx.site.domain} (${Math.round(match.similarity * 100)}% overlap)` +
        (match.url ? ` — ${match.url}` : ''),
    );
    return match;
  } catch (err) {
    // A duplicate check must never be the reason a finished article is lost.
    log.warn(`could not check for a duplicate title: ${errorMessage(err)}`);
    return null;
  }
}
