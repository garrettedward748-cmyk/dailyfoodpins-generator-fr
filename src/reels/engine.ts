import { readLocalMedia } from '../integrations/media-store.js';
import { recipeFileName } from '../lib/file-name.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FacebookClient, FacebookError } from '../integrations/facebook.js';
import { ImageClient } from '../integrations/images.js';
import { SiteApiClient } from '../integrations/site-api.js';
import { isSocialOnly } from '../core/social-only.js';
import { siteApiFor } from '../integrations/site-api-for.js';
import { TelegramClient } from '../integrations/telegram.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { resolveProjectId } from '../core/project-id.js';
import { resolveDataDir } from '../config.js';
import { askPrompt } from '../llm/ask.js';
import type { Settings } from '../settings.js';
import { BufferPool } from '../integrations/buffer-pool.js';
import { get } from '../db/index.js';
import {
  activeReels,
  fbPageToken,
  getFbPage,
  getSite,
  listScenes,
  markFbPageFailed,
  markFbPageUsed,
  presenterForPage,
  recentFormatsForPage,
  replaceScenes,
  setReelStage,
  siteSecrets,
  updateReel,
  updateScene,
  setReelChannels,
  reelsToRetryForFullBuffer,
  markReelAutoRetry,
  reelsAwaitingNativeVideoId,
  fbFeedPostsAwaitingNativeId,
  setFbFeedPostNativeId,
  resolveFbGraphTarget,
  type FbGraphTarget,
  type ReelView,
  runProfile,
  runTargets,
  postsToAll,
  getProfile,
  type ProfilePlatform,
  type SiteRow,
  getRun,
  bufferChannelName,
  listBufferAccounts,
  listProfiles,
  takes,
} from '../db/repos.js';
import { pickFormat } from './formats.js';
import { instagramLink } from '../core/instagram-link.js';
import { parseCaptionNetworks, withSiteOverrides } from '../core/caption-structures.js';
import { reelCta } from './cta.js';
import { planProcess, planReel, PROCESS_SHOTS, type SourceRole } from './plan.js';
import { filmPending } from './film.js';
import { assembleMixedReel, assembleProcessReel, assembleReel, lastFrame, normalizeForSocial, type MixedReelInput } from './assemble.js';
import { allMusicUrls, isLocalMusicLine, isMixedSeed, localMusicPath, type MixedSeed, type ReelSeed } from './compose.js';
import { composeWithRecipe, facebookPost, pickCommentKeyword, parseFacebookLinkMode, parseRecipeInPost, recipeCandidates, recipePostText, type FacebookLinkMode, type RecipeInPost } from './recipe-text.js';

const log = createLogger('reels');

/**
 * Moving a reel from "asked for" to "on Facebook".
 *
 * Deliberately not a pipeline. The article pipeline checkpoints every step
 * because a failure at step twelve would otherwise repay thirteen LLM calls;
 * a reel has three states and one expensive artefact, and the video URL in the
 * row is a better checkpoint than a step table would be.
 *
 * Nothing here blocks. Video generation takes minutes and publishing takes
 * more, and the scheduler tick that drives this also drives article runs — so
 * each pass advances what it can and returns.
 *
 *   draft -> generating -> ready -> publishing -> published
 *                       \-> failed <-/
 *
 * A studio reel spends its `generating` on stages -- planning, imaging,
 * filming, assembling -- one per pass, recorded in `stage`, with one row per
 * scene under it so a scene can fail and be retried on its own.
 */

/** How long a reel refused for a full Buffer queue waits, and how often it is tried again on its own. */
export const AUTO_RETRY_HOURS = 6;
export const AUTO_RETRY_MAX = 4;

export interface ReelTickResult {
  advanced: number;
  failed: number;
}

/** Everything the engine is allowed to reach, so it can be tested with fakes. */
export interface ReelDeps {
  images: ImageClient;
  /**
   * A client for the token this page was found under. Pages from different
   * apps sit side by side, and each publishes with its own token.
   */
  facebookFor(pageRowId: number): Pick<FacebookClient, 'publishReel' | 'commentOnReel'>;
  /**
   * The real page id and token to publish straight to Facebook with, for a
   * page row that may be a Buffer account card (no token, a synthetic id) --
   * bridged to the synced page that carries both. Absent in a bare test
   * context, where the page row's own id is used as-is.
   */
  resolveFbTarget?(pageRowId: number): FbGraphTarget | undefined;
  telegram: TelegramClient;
  /** Download a finished video. Separate so tests need no network. */
  download(url: string): Promise<Buffer>;
  /** Ask the model one named prompt. The plan stage's only call. */
  prompt(name: string, vars: Record<string, unknown>): Promise<{ content: string }>;
  /** Where clips and assembled reels land. */
  clipsDir: string;
  /** Join scene clips into one file. ffmpeg, in production. */
  assemble(clipPaths: string[], outPath: string, ctaText: string): Promise<void>;
  /** Re-encode a raw Flow video for Facebook/Instagram; tests pass a stand-in. */
  normalize?: (video: Buffer) => Promise<Buffer>;
  /**
   * Put a fresh scene image on the site the reel belongs to, and give back
   * its public url. Flow's own urls expire; the site's do not, and the clip
   * is filmed from this one.
   */
  uploadImage(siteId: number, data: Buffer, contentType: string, name?: string): Promise<string>;
  /**
   * Put a finished reel on its site and give back its public url, and
   * schedule it on that site's Buffer account. Only the Buffer route uses
   * these; publishing straight to the Page sends the bytes itself.
   */
  uploadVideo(siteId: number, data: Buffer, name?: string): Promise<string>;
  /** Which route a finished reel takes to Facebook. Setup -> Reels picks it. */
  reelPublisher: 'facebook' | 'buffer';
  scheduleReel(input: {
    siteId: number;
    /** One given account of the network; absent means the run's own. */
    profileId?: number;
    /** The article's run: its reel goes to the same Facebook account as its post. */
    runId?: number | null;
    text: string;
    videoUrl: string;
    firstComment?: string;
    /** The reel's name on Facebook. */
    title?: string;
    /** Told the name of the page Buffer really posted to, for the reel's record. */
    onPage?: (page: string) => void;
    /** null: this account is switched off, nothing was sent. */
  }): Promise<string | null>;
  /**
   * Pin the reel on Pinterest as a video pin, when the site has
   * Channels -> Pinterest -> Reels ticked. Optional: never the reason a reel fails.
   */
  pinReel?(input: { siteId: number; runId: number | null; title: string; linkUrl: string; videoUrl: string; profileId?: number; onPage?: (page: string) => void }): Promise<string | null>;
  /**
   * The same reel on the site's Instagram, when Channels -> Instagram -> Reels
   * is ticked. Optional: never the reason a reel fails. Null when it is off.
   */
  instagramReel?(input: { siteId: number; runId?: number | null; title: string; caption: string; recipes?: string[]; postUrl: string; videoUrl: string; profileId?: number; onPage?: (page: string) => void; pageProfileId?: number }): Promise<string | null>;
  youtubeShort?(input: { siteId: number; runId?: number | null; title: string; caption: string; recipes?: string[]; postUrl: string; videoUrl: string; profileId?: number; onPage?: (page: string) => void; pageProfileId?: number }): Promise<string | null>;
  /** The same reel on the site's TikTok, when Channels -> TikTok -> Videos is ticked. Optional: never the reason a reel fails. */
  tiktokReel?(input: { siteId: number; runId?: number | null; title: string; caption: string; recipes?: string[]; postUrl: string; videoUrl: string; profileId?: number; onPage?: (page: string) => void; pageProfileId?: number }): Promise<string | null>;
  /**
   * The accounts a reel goes to on a network, by profile id, the run's own
   * first: one in rotation, all of the site's when it posts to all (Channels ->
   * Accounts). 0 stands for a site with no accounts yet. Absent means just the
   * run's own, which is how every reel went before.
   */
  targets?(input: { siteId: number; runId: number | null; platform: ProfilePlatform }): number[];
  /** Show the reel on its recipe's page. Optional: never the reason a reel fails. */
  attachVideo?(input: { siteId: number; runId: number | null; videoUrl: string }): Promise<boolean>;
  /**
   * Which networks get the caption written for the reel. Setup -> Caption
   * structures picks them; the rest get the recipe title and the link, which is
   * what all of them got before any caption was written.
   *
   * Absent means all of them, so nothing that builds its own deps -- a test, a
   * script -- loses the caption by not knowing about this.
   */
  captionOn?: ReadonlySet<string>;
  /**
   * What a Facebook reel post carries besides its caption (Setup -> Caption
   * structures): how much of the recipe, and where the link goes. Absent means
   * what every reel did before: no recipe, the link in the text.
   */
  facebookRecipe?: RecipeInPost;
  facebookLink?: FacebookLinkMode;
  /** The comment trigger word, for the 'keyword' link mode. */
  commentKeyword?: string;
  /** The same choice for a Short's description and an Instagram reel's caption. Absent: no recipe. */
  youtubeRecipe?: RecipeInPost;
  instagramRecipe?: RecipeInPost;
  tiktokRecipe?: RecipeInPost;
  /**
   * The same choices as one site has them (Setup -> Caption structures): what it has of its own
   * replaces the shared ones above, field by field.
   */
  captionConfig?(siteId: number): Pick<ReelDeps, 'captionOn' | 'facebookRecipe' | 'facebookLink' | 'youtubeRecipe' | 'instagramRecipe' | 'tiktokRecipe'>;
  /** Wait between fresh images, the same breath the article pipeline takes. */
  pause(ms: number): Promise<void>;
  /** Build a clip + steps reel. ffmpeg, in production; tests pass a fake. */
  mix?(input: MixedReelInput, outPath: string): Promise<void>;
  /** Join process shots. ffmpeg, in production; tests pass a fake. */
  assembleProcess?(clipPaths: string[], outPath: string, music?: string): Promise<void>;
  /** The last frame of a clip, for the next process shot. ffmpeg, in production. */
  lastFrame?(clipPath: string): Promise<Buffer>;
}

/**
 * The call to action for one reel: the operator's line with this site's own
 * address in place of `{domain}`. Setup -> Reels writes it once for every site.
 */
function ctaFor(reel: { site_id?: number | null }, settings: Settings): string {
  const domain = reel.site_id ? getSite(reel.site_id)?.domain ?? '' : '';
  return reelCta(settings.get('reel_cta_text'), domain);
}

/** A run's saved step output, or null. */
function runStepOutput<T>(runId: number | null, step: string): T | null {
  if (!runId) return null;
  const row = get<{ output_json: string }>(
    "SELECT output_json FROM run_steps WHERE run_id = ? AND step = ? AND status = 'ok'",
    runId,
    step,
  );
  try { return row ? (JSON.parse(row.output_json) as T) : null; } catch { return null; }
}

/**
 * The board and description for a reel's Pinterest video pin: the board the
 * article's image pin went to, and the description it was given -- written
 * for Pinterest search -- or, when the site does not pin posts, one written
 * now with the same prompt. The title is the last resort.
 */
export async function reelPinDetails(
  runId: number | null,
  title: string,
  domain: string,
  settings: Settings,
  key: Buffer,
): Promise<{ board: string; description: string }> {
  const board = runStepOutput<{ boardName?: string }>(runId, 'resolve-buffer-target')?.boardName ?? '';
  let description = runStepOutput<string>(runId, 'generate-pin-description') ?? '';
  if (!description && runId) {
    try {
      const kw = get<{ spy_title: string; spy_description: string; annotation: string }>(
        'SELECT k.spy_title, k.spy_description, k.annotation FROM runs r JOIN keywords k ON k.id = r.keyword_id WHERE r.id = ?',
        runId,
      );
      const written = await askPrompt(settings, key, 'pin-description', {
        seo: runStepOutput<Record<string, unknown>>(runId, 'validate-spy') ?? { title },
        cta: '',
        site: { domain },
        spy: { title: kw?.spy_title ?? '', description: kw?.spy_description ?? '', annotation: kw?.annotation ?? '' },
      });
      description = written.content.trim();
    } catch (err) {
      log.warn(`reel pin: could not write a Pinterest description, using the title — ${errorMessage(err)}`);
    }
  }
  return { board, description: description || title };
}

/**
 * The account of another network that lives in the same Buffer as a reel's
 * Facebook page: one of the site's accounts on that network holding one of the
 * page account's Buffer tokens. The first such, by its place in the list.
 */
export function linkedProfile(siteId: number, platform: ProfilePlatform, pageProfileId: number, key: Buffer) {
  const accounts = listBufferAccounts(siteId, key).filter((a) => a.enabled && a.token.trim() !== '');
  const tokens = new Set(accounts.filter((a) => a.profileId === pageProfileId).map((a) => a.token.trim()));
  if (tokens.size === 0) return undefined;
  const holders = new Set(accounts.filter((a) => tokens.has(a.token.trim())).map((a) => a.profileId));
  return listProfiles(siteId, platform).find((p) => holders.has(p.id));
}

/**
 * A Buffer pool on the account of a network the reel's article used (or the
 * next in turn), and whether that account is switched off (the toggle on its
 * card). The account is resolved once, here: asking again would pick another,
 * and for a reel with no run each pick moves the turn on. A sender that gets
 * `off` back sends nothing and answers null, which the reel records as "off"
 * for that network.
 */
function profilePool(
  site: SiteRow,
  runId: number | null | undefined,
  platform: ProfilePlatform,
  key: Buffer,
  profileId?: number,
  pageProfileId?: number,
): { pool: BufferPool; off: boolean } {
  const given = profileId ? getProfile(profileId) : undefined;
  // A reel's copy on another network, in rotation: it goes where the reel's
  // page is rather than to whichever account of that network had the turn.
  if (!given && pageProfileId && platform !== 'facebook' && platform !== 'pinterest') {
    const page = getProfile(pageProfileId);
    if (page && page.site_id === site.id) {
      const linked = linkedProfile(site.id, platform, page.id, key);
      if (linked) {
        return {
          pool: new BufferPool(
            { id: site.id, domain: site.domain, pinUsername: bufferChannelName(linked), platform, profileId: linked.id },
            key,
          ),
          off: !linked.enabled || !takes(linked, 'reels'),
        };
      }
      // No account of this network shares the page's Buffer token: the page's
      // own Buffer account, and its one channel of the network.
      return {
        pool: new BufferPool(
          { id: site.id, domain: site.domain, pinUsername: bufferChannelName(page), platform, profileId: page.id, otherNetworkName: true },
          key,
        ),
        off: false,
      };
    }
  }
  // A reel goes to an account that takes reels: its own Reels tick (Pinterest,
  // Instagram) decides, as the page's does on Facebook.
  const profile = given && given.site_id === site.id ? given : runProfile(runId ?? null, site.id, platform, 'reels');
  const pool = new BufferPool(
    {
      id: site.id,
      domain: site.domain,
      pinUsername: profile ? bufferChannelName(profile) : site.pin_username,
      platform,
      profileId: profile?.id,
    },
    key,
    !profile || profile.position === 1 ? siteSecrets(site, key).bufferToken : '',
  );
  return { pool, off: Boolean(profile && (!profile.enabled || !takes(profile, 'reels'))) };
}

export function defaultDeps(settings: Settings, key: Buffer): ReelDeps {
  return {
    images: new ImageClient({
      baseUrl: settings.get('image_base_url'),
      apiKey: settings.get('image_api_key'),
      pollIntervalMs: settings.getNumber('image_poll_interval_seconds') * 1000,
      maxAttempts: settings.getNumber('image_poll_max_attempts'),
    }),
    facebookFor: (pageRowId) =>
      new FacebookClient({
        // The resolved token covers a Buffer account-card page too, whose own
        // token_id is null -- see resolveFbGraphTarget. Falls back to the
        // page's own token so an unbridged page still fails with Graph's own
        // "no token" error rather than silently.
        systemUserToken: resolveFbGraphTarget(pageRowId, key)?.token ?? fbPageToken(pageRowId, key),
      }),
    resolveFbTarget: (pageRowId) => resolveFbGraphTarget(pageRowId, key),
    telegram: new TelegramClient(
      settings.get('telegram_bot_token'),
      settings.get('telegram_chat_id'),
    ),
    async download(url) {
      const local = readLocalMedia(url);
      if (local) return local.data;
      const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
      if (!response.ok) {
        throw new Error(`Downloading the video failed: HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
    prompt: (name, vars) => askPrompt(settings, key, name, vars),
    clipsDir: join(resolveDataDir(), 'reels'),
    assemble: (clips, out, cta) => assembleReel(clips, out, { ctaText: cta }),
    assembleProcess: (clips, out, music) => assembleProcessReel(clips, out, { music }),
    lastFrame: (clip) => lastFrame(clip),
    async uploadImage(siteId, data, contentType, name) {
      const site = getSite(siteId);
      if (!site) throw new Error('The site this reel belongs to no longer exists.');
      const api = siteApiFor(site, siteSecrets(site, key).apiToken);
      const extension = contentType.includes('png') ? 'png' : contentType.includes('jpeg') ? 'jpg' : 'webp';
      const uploaded = await api.uploadImage(data, recipeFileName(name ?? '', 'reel-scene', extension), contentType, 'recipes');
      return api.absoluteUrl(uploaded.url);
    },
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // In rotation, [0]: the sender picks the run's own account exactly as it
    // always did. Asking runTargets here would pick it a second time, and for
    // a reel with no run each pick moves the turn on.
    targets: ({ siteId, runId, platform }) =>
      postsToAll(siteId, platform) ? runTargets(runId, siteId, platform, 'reels').map((p) => p?.id ?? 0) : [0],
    reelPublisher: settings.get('reel_publisher') === 'buffer' ? 'buffer' : 'facebook',
    captionConfig: (siteId) => {
      const own = withSiteOverrides(settings, siteId);
      return {
        captionOn: parseCaptionNetworks(own.get('caption_networks')),
        facebookRecipe: parseRecipeInPost(own.get('caption_fb_recipe')),
        facebookLink: parseFacebookLinkMode(own.get('caption_fb_link')),
        youtubeRecipe: parseRecipeInPost(own.get('caption_yt_recipe')),
        instagramRecipe: parseRecipeInPost(own.get('caption_ig_recipe')),
        tiktokRecipe: parseRecipeInPost(own.get('caption_tt_recipe')),
      };
    },
    captionOn: parseCaptionNetworks(settings.get('caption_networks')),
    facebookRecipe: parseRecipeInPost(settings.get('caption_fb_recipe')),
    facebookLink: parseFacebookLinkMode(settings.get('caption_fb_link')),
    commentKeyword: settings.get('fb_comment_trigger').trim() || 'banana',
    youtubeRecipe: parseRecipeInPost(settings.get('caption_yt_recipe')),
    instagramRecipe: parseRecipeInPost(settings.get('caption_ig_recipe')),
    tiktokRecipe: parseRecipeInPost(settings.get('caption_tt_recipe')),
    async uploadVideo(siteId, data, name) {
      const site = getSite(siteId);
      if (!site) throw new Error('The site this reel belongs to no longer exists.');
      const api = siteApiFor(site, siteSecrets(site, key).apiToken);
      const uploaded = await api.uploadVideo(data, recipeFileName(name ?? '', 'reel', 'mp4'));
      return uploaded.url;
    },
    async scheduleReel(input) {
      const site = getSite(input.siteId);
      if (!site) throw new Error('The site this reel belongs to no longer exists.');

      const { pool, off } = profilePool(site, input.runId, 'facebook', key, input.profileId);
      if (off) return null;
      const scheduled = await pool.createReel(input);
      input.onPage?.(scheduled.page);

      return scheduled.postId;
    },
    async instagramReel(input) {
      const site = getSite(input.siteId);
      if (!site || !(site as { ig_reels?: number }).ig_reels) return null;
      const { pool, off } = profilePool(site, input.runId, 'instagram', key, input.profileId, input.pageProfileId);
      if (off) return null;
      const link = instagramLink(settings, input.postUrl);
      const posted = await pool.createInstagramPost({
        // Instagram allows 2200 characters: a recipe that does not fit gives way
        // to the ingredients alone, then to the caption, never cut in the middle.
        text: composeWithRecipe({
          body: input.caption.trim() || input.title,
          recipes: input.recipes ?? [],
          tail: [link.line],
          limit: 2200,
        }),
        type: 'reel',
        videoUrl: input.videoUrl,
        firstComment: link.firstComment,
      });
      input.onPage?.(posted.page);
      return posted.postId;
    },
    async youtubeShort(input) {
      const site = getSite(input.siteId);
      if (!site || !(site as { yt_reels?: number }).yt_reels) return null;
      const { pool, off } = profilePool(site, input.runId, 'youtube', key, input.profileId, input.pageProfileId);
      if (off) return null;
      const posted = await pool.createYouTubeShort({
        title: input.title,
        text: youtubeDescription(input.title, input.caption, input.postUrl, site.domain, {
          recipe: withSiteOverrides(settings, input.siteId).getBool('caption_yt_link_recipe'),
          site: withSiteOverrides(settings, input.siteId).getBool('caption_yt_link_site'),
        }, input.recipes),
        videoUrl: input.videoUrl,
        category: settings.get('youtube_category'),
      });
      input.onPage?.(posted.page);
      return posted.postId;
    },
    async tiktokReel(input) {
      const site = getSite(input.siteId);
      if (!site || !(site as { tt_reels?: number }).tt_reels) return null;
      const { pool, off } = profilePool(site, input.runId, 'tiktok', key, input.profileId, input.pageProfileId);
      if (off) return null;
      const posted = await pool.createTikTokVideo({
        // TikTok's caption has no clickable link, same as Instagram's, so the
        // recipe rides in the text itself and nothing is appended after it.
        text: composeWithRecipe({
          body: input.caption.trim() || input.title,
          recipes: input.recipes ?? [],
          tail: [],
          limit: 2200,
        }),
        videoUrl: input.videoUrl,
        privacyLevel: settings.get('tiktok_privacy'),
      });
      input.onPage?.(posted.page);
      return posted.postId;
    },
    async attachVideo(input) {
      const site = getSite(input.siteId);
      const recipeId = input.runId ? getRun(input.runId)?.post_id : null;
      if (!site || !recipeId) return false;
      const api = siteApiFor(site, siteSecrets(site, key).apiToken);
      await api.attachRecipeVideo(recipeId, input.videoUrl);
      return true;
    },
    async pinReel(input) {
      const site = getSite(input.siteId);
      if (!site || !(site as { pin_reels?: number }).pin_reels) return null;
      // Resolved first: a switched-off account must not cost a model call.
      const { pool, off } = profilePool(site, input.runId, 'pinterest', key, input.profileId);
      if (off) return null;
      const { board, description } = await reelPinDetails(input.runId, input.title, site.domain, settings, key);

      // Another of the site's accounts has its own boards: the article's board
      // by name if it has one too, else its own general board, else its first.
      const other = input.profileId ? getProfile(input.profileId) : undefined;
      const pinned = await pool.createVideoPin(
        { text: description, title: input.title.slice(0, 100), linkUrl: input.linkUrl, videoUrl: input.videoUrl },
        other ? [board, other.default_board] : board,
      );
      if (pinned.destination.channelName) input.onPage?.(pinned.destination.channelName);
      return pinned.postId;
    },
  };
}

/**
 * Advance every reel that has somewhere to go.
 *
 * One reel per state per tick, on purpose: publishing uploads a video and
 * generating waits on Google, and doing several at once is how a shared image
 * service earns a rate limit.
 */
export async function tickReels(
  settings: Settings,
  deps: ReelDeps,
): Promise<ReelTickResult> {
  if (!settings.getBool('fb_enabled')) return { advanced: 0, failed: 0 };

  const result: ReelTickResult = { advanced: 0, failed: 0 };

  // A full Buffer queue empties as Buffer publishes. Reels refused for that
  // and nothing else go back to "ready" on their own, every few hours, a few
  // times; any other failure waits for a person.
  for (const reel of reelsToRetryForFullBuffer(AUTO_RETRY_HOURS, AUTO_RETRY_MAX)) {
    markReelAutoRetry(reel.id);
    log.info(`reel ${reel.id}: Buffer was full, trying again on its own (${(reel.auto_retries ?? 0) + 1}/${AUTO_RETRY_MAX})`);
  }

  for (const reel of activeReels()) {
    try {
      const moved = await advance(reel, settings, deps);
      if (moved) result.advanced += 1;
    } catch (err) {
      const message = errorMessage(err);
      log.error(`reel ${reel.id} failed`, message);
      updateReel(reel.id, { status: 'failed', error: message });
      result.failed += 1;

      if (reel.fb_page_id) markFbPageFailed(reel.fb_page_id, message);
      await notify(deps, `<b>Reel failed</b>\n${escapeHtml(reel.run_title ?? '')}\n${message}`);
    }
  }

  return result;
}

/**
 * Fill in the real Facebook video id for reels Buffer already published.
 *
 * Buffer queues a post and hands back its own post id, not Facebook's --
 * there is nothing at publish time that can know what Facebook will assign
 * a video that has not gone out yet. This asks each page for its own recent
 * videos and matches them to the reels still waiting, by how close their
 * timestamps are. A match within the window is accepted; nothing close
 * enough is left for the next pass rather than guessed at.
 *
 * This is what lets the comment-keyword webhook work on a reel published
 * through Buffer at all: it looks a video up by Facebook's id, and Buffer's
 * id was never going to be that.
 */
const VIDEO_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function backfillNativeVideoIds(
  settings: Settings,
  key: Buffer,
  facebookFor: (pageRowId: number) => Pick<FacebookClient, 'listRecentVideos'> = (pageRowId) =>
    new FacebookClient({ systemUserToken: resolveFbGraphTarget(pageRowId, key)?.token ?? fbPageToken(pageRowId, key) }),
): Promise<{ matched: number; checked: number }> {
  const pending = reelsAwaitingNativeVideoId();
  if (pending.length === 0) return { matched: 0, checked: 0 };

  const byPage = new Map<number, ReelView[]>();
  for (const reel of pending) {
    if (!reel.fb_page_id) continue;
    const list = byPage.get(reel.fb_page_id) ?? [];
    list.push(reel);
    byPage.set(reel.fb_page_id, list);
  }

  let matched = 0;
  for (const [pageRowId, reels] of byPage) {
    const page = getFbPage(pageRowId);
    // The real page to read videos from, and the token for it. A Buffer
    // account-card page has neither of its own; resolveFbGraphTarget bridges
    // to the synced page that does, which is what lets the webhook find a
    // reel published through Buffer on such a page at all.
    const target = resolveFbGraphTarget(pageRowId, key);
    if (!page || !target) continue; // nothing to read this page's videos with

    let videos: { id: string; description: string; createdTime: string }[];
    try {
      videos = await facebookFor(pageRowId).listRecentVideos(target.pageId);
    } catch (err) {
      log.warn(`video backfill: could not list ${page.name || page.page_id}'s videos — ${errorMessage(err)}`);
      continue;
    }

    const used = new Set<string>();
    for (const reel of reels) {
      const reelTime = Date.parse(`${reel.updated_at.replace(' ', 'T')}Z`);
      if (Number.isNaN(reelTime)) continue;

      let best: { id: string; diff: number } | null = null;
      for (const video of videos) {
        if (used.has(video.id) || !video.createdTime) continue;
        const videoTime = Date.parse(video.createdTime);
        if (Number.isNaN(videoTime)) continue;
        const diff = Math.abs(videoTime - reelTime);
        if (diff > VIDEO_MATCH_WINDOW_MS) continue;
        if (!best || diff < best.diff) best = { id: video.id, diff };
      }

      if (best) {
        used.add(best.id);
        updateReel(reel.id, { fbVideoId: best.id });
        matched++;
        log.info(`video backfill: reel ${reel.id} matched to Facebook video ${best.id}`);
      }
    }
  }

  return { matched, checked: pending.length };
}

/**
 * Fill in the real Facebook post id for feed posts (the article's own image
 * post, the photo collage) Buffer already published.
 *
 * Same reasoning and the same matching strategy as `backfillNativeVideoIds`,
 * one page's `/feed` instead of its `/videos`: Buffer cannot say what
 * Facebook will assign a post it has only queued, so this asks each page for
 * its own recent posts and matches them to the feed posts still waiting, by
 * how close their timestamps are. This is what lets the comment-keyword
 * webhook find an image post or a collage, not only a reel.
 */
const POST_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function backfillNativeFeedPostIds(
  settings: Settings,
  key: Buffer,
  facebookFor: (pageRowId: number) => Pick<FacebookClient, 'listRecentPosts'> = (pageRowId) =>
    new FacebookClient({ systemUserToken: resolveFbGraphTarget(pageRowId, key)?.token ?? fbPageToken(pageRowId, key) }),
): Promise<{ matched: number; checked: number }> {
  const pending = fbFeedPostsAwaitingNativeId();
  if (pending.length === 0) return { matched: 0, checked: 0 };

  const byPage = new Map<number, typeof pending>();
  for (const feedPost of pending) {
    if (!feedPost.fb_page_id) continue;
    const list = byPage.get(feedPost.fb_page_id) ?? [];
    list.push(feedPost);
    byPage.set(feedPost.fb_page_id, list);
  }

  let matched = 0;
  for (const [pageRowId, feedPosts] of byPage) {
    const page = getFbPage(pageRowId);
    // See backfillNativeVideoIds: the real page to read /feed from and the
    // token for it, bridged from the synced page when this is a Buffer card.
    const target = resolveFbGraphTarget(pageRowId, key);
    if (!page || !target) continue; // nothing to read this page's posts with

    let posts: { id: string; message: string; createdTime: string }[];
    try {
      posts = await facebookFor(pageRowId).listRecentPosts(target.pageId);
    } catch (err) {
      log.warn(`post backfill: could not list ${page.name || page.page_id}'s posts — ${errorMessage(err)}`);
      continue;
    }

    const used = new Set<string>();
    for (const feedPost of feedPosts) {
      const postTime = Date.parse(`${feedPost.updated_at.replace(' ', 'T')}Z`);
      if (Number.isNaN(postTime)) continue;

      let best: { id: string; diff: number } | null = null;
      for (const post of posts) {
        if (used.has(post.id) || !post.createdTime) continue;
        const createdTime = Date.parse(post.createdTime);
        if (Number.isNaN(createdTime)) continue;
        const diff = Math.abs(createdTime - postTime);
        if (diff > POST_MATCH_WINDOW_MS) continue;
        if (!best || diff < best.diff) best = { id: post.id, diff };
      }

      if (best) {
        used.add(best.id);
        setFbFeedPostNativeId(feedPost.id, best.id);
        matched++;
        log.info(`post backfill: feed post ${feedPost.id} matched to Facebook post ${best.id}`);
      }
    }
  }

  return { matched, checked: pending.length };
}

async function advance(
  reel: ReelView,
  settings: Settings,
  deps: ReelDeps,
): Promise<boolean> {
  switch (reel.status) {
    case 'generating':
      switch (reel.stage) {
        case 'planning':
          return planStage(reel, settings, deps);
        case 'filming':
          return filmingStage(reel, settings, deps);
        case 'assembling':
          return assemblingStage(reel, settings, deps);
        case 'imaging':
          return imagingStage(reel, settings, deps);
        case 'mixing':
          return mixingStage(reel, settings, deps);
        default:
          // A one-shot reel from before the studio: one video job to poll.
          return pollGeneration(reel, deps);
      }
    case 'ready':
      return publishIfAllowed(reel, settings, deps);
    case 'publishing': {
      // Being published right now, by this process or a moment ago by another:
      // leave it. Publishing a reel takes minutes (re-encode, upload, one post
      // per network), the scheduler ticks every minute, and a tick that took
      // the reel for abandoned put it out a second time on every network.
      const sinceTouched = Date.now() - Date.parse(`${reel.updated_at.replace(' ', 'T')}Z`);
      if (publishingNow.has(reel.id) || sinceTouched < PUBLISHING_ABANDONED_MS) return false;
      // Left behind by a process that died mid-upload. Retried rather than
      // resumed: Facebook's upload session is gone with the process, and the
      // video we already have is the expensive part, not the upload.
      log.warn(`reel ${reel.id} was left publishing; retrying`);
      updateReel(reel.id, { status: 'ready' });
      return true;
    }
    default:
      return false;
  }
}

/**
 * Write the storyboard.
 *
 * One model call, checked before anything is spent. The format comes from
 * the page's rotation, the presenter from the page, the article from what
 * the run stored on the reel when it was created.
 */
async function planStage(reel: ReelView, settings: Settings, deps: ReelDeps): Promise<boolean> {
  const seed = JSON.parse(reel.plan_json || '{}') as Partial<ReelSeed>;
  if (!seed.sources || !seed.article) throw new Error('This reel has no article to plan from.');

  // Process: hands-only shots, no presenter, no storyboard formats.
  if (seed.process) {
    const processPlan = await planProcess({
      prompt: deps.prompt,
      article: seed.article,
      sources: Object.keys(seed.sources) as SourceRole[],
      count: PROCESS_SHOTS,
    });
    replaceScenes(
      reel.id,
      processPlan.shots.map((shot) => ({
        seconds: 8,
        presenter: false,
        sources: shot.sources,
        imagePrompt: '',
        motionPrompt: `${shot.camera}: ${shot.action}`,
        line: '',
      })),
    );
    setReelStage(reel.id, 'filming', { planJson: JSON.stringify({ ...seed, processPlan }), format: 'process' });
    log.info(`reel ${reel.id}: planned as a process reel, ${processPlan.shots.length} shot(s)`);
    return true;
  }

  const page = reel.fb_page_id ? getFbPage(reel.fb_page_id) : undefined;
  const presenter = page ? presenterForPage(page.id) : undefined;

  const allowed = parseFormats(settings.get('reel_formats'));
  const format = pickFormat(allowed, page ? recentFormatsForPage(page.id) : []);
  const plan = await planReel({
    prompt: deps.prompt,
    article: seed.article,
    sources: Object.keys(seed.sources) as SourceRole[],
    presenter:
      presenter && format.presenter !== 'never'
        ? { name: presenter.name, voice: presenter.voice_description }
        : null,
    targetSeconds: settings.getNumber('reel_length_seconds') || 30,
    format,
    cta: ctaFor(reel, settings),
  });

  replaceScenes(
    reel.id,
    plan.scenes.map((s) => ({
      seconds: s.seconds,
      presenter: s.presenter,
      sources: s.sources,
      imagePrompt: s.image,
      motionPrompt: s.motion,
      line: s.line,
    })),
  );
  // Setup -> Reels decides whether scenes are filmed from the article's own
  // images or from a fresh one each. Fresh images cost an image credit per
  // scene and a minute between them; the article's images cost nothing.
  const next = settings.getBool('reel_fresh_images') ? 'imaging' : 'filming';
  setReelStage(reel.id, next, {
    planJson: JSON.stringify({ ...seed, plan }),
    format: format.key,
  });
  log.info(`reel ${reel.id}: planned as ${format.key}, ${plan.scenes.length} scene(s)`);
  return true;
}

/**
 * Make a fresh image for every scene that describes one.
 *
 * The article's feature image rides along as a reference, so every scene is
 * the same dish and not a new one. A scene with no image description keeps
 * its article images, and a scene that already has a fresh image -- from a
 * pass that died halfway -- is not made again. Images land on the site, not
 * in the platform: Flow's urls expire and the clip is filmed from this one.
 */
async function imagingStage(reel: ReelView, settings: Settings, deps: ReelDeps): Promise<boolean> {
  if (!reel.site_id) throw new Error('This reel has no site to keep its images on.');
  const seed = JSON.parse(reel.plan_json || '{}') as Partial<ReelSeed>;
  const feature = seed.sources?.hero;

  const gapMs = Math.max(0, settings.getNumber('image_gap_seconds')) * 1000;
  let made = 0;
  for (const scene of listScenes(reel.id)) {
    if (scene.image_url || !scene.image_prompt) continue;
    if (made > 0 && gapMs > 0) await deps.pause(gapMs);

    const image = await deps.images.generate(scene.image_prompt, 'VERTICAL', {
      referenceUrls: feature ? [feature] : [],
    });
    const url = await deps.uploadImage(reel.site_id, image.data, image.contentType, reel.run_title || reel.seed_keyword || '');
    updateScene(scene.id, { imageUrl: url });
    made += 1;
    log.info(`reel ${reel.id}: fresh image for scene ${scene.position}`);
  }

  setReelStage(reel.id, 'filming');
  return true;
}

/** Every allowed format key; an unset or unreadable setting means all of them. */
function parseFormats(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || '[]') as unknown;
    if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
  } catch {
    // fall through
  }
  return [];
}

async function filmingStage(reel: ReelView, settings: Settings, deps: ReelDeps): Promise<boolean> {
  const state = await filmPending(reel, deps, settings);
  if (state === 'done') setReelStage(reel.id, 'assembling');
  return true;
}

async function assemblingStage(
  reel: ReelView,
  settings: Settings,
  deps: ReelDeps,
): Promise<boolean> {
  const scenes = listScenes(reel.id);
  const clips = scenes.map((s) => s.clip_path).filter((p): p is string => Boolean(p));
  if (clips.length !== scenes.length) throw new Error('Not every scene has a clip to assemble.');

  const out = join(deps.clipsDir, `${reel.id}.mp4`);
  if ((JSON.parse(reel.plan_json || '{}') as { process?: boolean }).process) {
    let music: string | undefined;
    const musicUrl = pickMusic(allMusicUrls(settings));
    if (musicUrl) {
      try {
        music = join(deps.clipsDir, String(reel.id), 'music.audio');
        mkdirSync(join(deps.clipsDir, String(reel.id)), { recursive: true });
        writeFileSync(music, await loadMusic(musicUrl, deps));
      } catch (err) {
        music = undefined;
        log.warn(`reel ${reel.id}: the music could not be downloaded, going without — ${errorMessage(err)}`);
      }
    }
    await (deps.assembleProcess ?? ((c, o, m) => assembleProcessReel(c, o, { music: m })))(clips, out, music);
  } else {
    await deps.assemble(clips, out, ctaFor(reel, settings));
  }
  setReelStage(reel.id, 'done', { outputPath: out });
  updateReel(reel.id, { status: 'ready', error: null });
  log.info(`reel ${reel.id}: assembled ${clips.length} clip(s)`);
  return true;
}

/** The three step captions and the hook, from the model; empty when it cannot say. */
export async function stepWords(
  seed: Partial<ReelSeed>,
  deps: Pick<ReelDeps, 'prompt'>,
): Promise<{ hook: string; steps: string[] }> {
  const prompts = seed.article?.imagePrompts ?? {};
  const title = seed.article?.title ?? '';
  try {
    const answer = await deps.prompt('reel-steps', {
      title,
      stepA: prompts.step_a || 'the first step of the method',
      stepB: prompts.step_b || 'the second step of the method',
      stepC: prompts.step_c || 'the third step of the method',
      recipe: (seed.article?.recipe ?? '').slice(0, 6000),
    });
    const json = answer.content.slice(answer.content.indexOf('{'), answer.content.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as { hook?: unknown; steps?: unknown };
    const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) : '');
    return {
      hook: clean(parsed.hook) || title,
      steps: Array.isArray(parsed.steps) ? parsed.steps.slice(0, 3).map(clean) : [],
    };
  } catch (err) {
    log.warn(`reel step captions could not be written, going without — ${errorMessage(err)}`);
    return { hook: title, steps: [] };
  }
}

/** One music link or uploaded file from Setup -> Reels, at random; null when there are none. */
export function pickMusic(raw: string, random: () => number = Math.random): string | null {
  const urls = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//i.test(l) || isLocalMusicLine(l));
  return urls.length ? urls[Math.min(urls.length - 1, Math.floor(random() * urls.length))]! : null;
}

/** The chosen music's bytes, whether it is a link to fetch or a file uploaded earlier. */
async function loadMusic(picked: string, deps: Pick<ReelDeps, 'download'>): Promise<Buffer> {
  return isLocalMusicLine(picked) ? readFile(localMusicPath(picked)) : deps.download(picked);
}

/**
 * Clip + steps: the clip, then the article's method photos with their steps,
 * then the call to action. The photos are the site's own, so nothing here
 * spends a credit; the only model call is for the few words on screen.
 */
async function mixingStage(reel: ReelView, settings: Settings, deps: ReelDeps): Promise<boolean> {
  const seed = JSON.parse(reel.plan_json || '{}') as Partial<MixedSeed>;
  if (!seed.clipPath || !existsSync(seed.clipPath)) {
    // Back to the start, so Retry films the clip again.
    setReelStage(reel.id, 'done');
    throw new Error('The clip for this reel is missing. Press Retry to make it again.');
  }
  const sources = seed.sources ?? {};
  const dir = join(deps.clipsDir, String(reel.id));
  mkdirSync(dir, { recursive: true });

  const save = async (url: string, name: string): Promise<string> => {
    const path = join(dir, name);
    writeFileSync(path, await deps.download(url));
    return path;
  };

  const words = await stepWords(seed, deps);
  const steps: MixedReelInput['steps'] = [];
  for (const [i, role] of (['stepA', 'stepB', 'stepC'] as const).entries()) {
    const url = sources[role];
    if (!url) continue;
    steps.push({ image: await save(url, `${role}.img`), caption: words.steps[i] ?? '' });
  }
  const endUrl = sources.hero ?? sources.stepC;
  if (!endUrl) throw new Error('This reel has no article photos to add after the clip.');
  const endImage = await save(endUrl, 'end.img');

  let music: string | undefined;
  const musicUrl = pickMusic(allMusicUrls(settings));
  if (musicUrl) {
    try {
      const path = join(dir, 'music.audio');
      writeFileSync(path, await loadMusic(musicUrl, deps));
      music = path;
    } catch (err) {
      log.warn(`reel ${reel.id}: the music could not be downloaded, going without — ${errorMessage(err)}`);
    }
  }

  const out = join(deps.clipsDir, `${reel.id}.mp4`);
  await (deps.mix ?? assembleMixedReel)(
    {
      clip: seed.clipPath,
      hook: words.hook,
      steps,
      endImage,
      cta: ctaFor(reel, settings),
      music,
      workDir: join(dir, 'text'),
    },
    out,
  );
  setReelStage(reel.id, 'done', { outputPath: out });
  updateReel(reel.id, { status: 'ready', error: null });
  log.info(`reel ${reel.id}: clip + ${steps.length} step(s) assembled`);
  return true;
}

/** Ask the image service whether the video is done yet. */
async function pollGeneration(reel: ReelView, deps: ReelDeps): Promise<boolean> {
  if (!reel.job_id) {
    throw new Error('This reel is generating but has no job id to poll.');
  }

  const job = await deps.images.poll(reel.job_id);
  const status = (job.status ?? '').toUpperCase();

  if (status === 'COMPLETED') {
    const url = job.image_url;
    if (!url) throw new Error('The video job completed but returned no URL.');

    // Clip + steps: keep the clip on disk now (Google's link expires) and
    // build the rest of the reel around it on the next pass.
    if (isMixedSeed(reel.plan_json)) {
      const dir = join(deps.clipsDir, String(reel.id));
      mkdirSync(dir, { recursive: true });
      const clipPath = join(dir, 'clip.mp4');
      writeFileSync(clipPath, await deps.download(url));
      const seed = JSON.parse(reel.plan_json) as MixedSeed;
      setReelStage(reel.id, 'mixing', { planJson: JSON.stringify({ ...seed, clipPath }) });
      log.info(`reel ${reel.id}: clip ready, adding the steps`);
      return true;
    }

    updateReel(reel.id, { status: 'ready', videoUrl: url, error: null });
    log.info(`reel ${reel.id}: video ready`);
    return true;
  }

  if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(status)) {
    throw new Error(`Video generation failed: ${job.error ?? 'no detail given'}`);
  }

  // Still working. Not an advance, and not worth a log line every tick.
  return false;
}

/**
 * Publish, if this reel's page says it may.
 *
 * The gate is per page rather than per site: a niche page that has earned
 * trust can publish unattended while a newer one still waits to be read. A
 * reel with no page waits indefinitely, which is the intended behaviour —
 * guessing a page posts a recipe to the wrong audience.
 */
async function publishIfAllowed(
  reel: ReelView,
  settings: Settings,
  deps: ReelDeps,
): Promise<boolean> {
  // A reel made for the other networks only (no Facebook page took reels)
  // has no page to ask: it goes out through Buffer as soon as it is ready.
  if (!reel.fb_page_id) {
    if (deps.reelPublisher !== 'buffer') return false;
  } else {
    const page = getFbPage(reel.fb_page_id);
    if (!page || page.enabled !== 1) return false;
    if (page.auto_publish !== 1) return false;
  }
  try {
    await publishReel(reel, deps);
  } catch (err) {
    // An account switched off is not a failure: the reel waits, ready, and is
    // tried again on a later tick once the account is on.
    if (err instanceof AccountOffError) {
      log.info(`reel ${reel.id} waits: ${err.message}`);
      return false;
    }
    throw err;
  }
  return true;
}

/**
 * Publish one reel now, regardless of the page's auto-publish setting.
 *
 * Shared by the scheduler and the Publish button, so a reel released by hand
 * goes out the same way an automatic one does.
 */
/** Reels this process is publishing at the moment; a second call for one does nothing. */
const publishingNow = new Set<number>();

/** A reel left 'publishing' longer than this was abandoned by a process that died. */
const PUBLISHING_ABANDONED_MS = 10 * 60_000;

/**
 * The account a reel would go out under is switched off (the toggle on its
 * card). Not a failure: nothing was sent, the reel stays ready, and the person
 * is told why — by hand and by the scheduler alike.
 */
export class AccountOffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountOffError';
  }
}

export async function publishReel(reel: ReelView, deps: ReelDeps): Promise<void> {
  if (publishingNow.has(reel.id)) {
    log.info(`reel ${reel.id} is already being published; not publishing it again`);
    return;
  }
  publishingNow.add(reel.id);
  try {
    await publishReelOnce(reel, deps);
  } catch (err) {
    // Put back as it was found, so it can be published once the account is on.
    if (err instanceof AccountOffError) updateReel(reel.id, { status: 'ready', error: null });
    throw err;
  } finally {
    publishingNow.delete(reel.id);
  }
}

async function publishReelOnce(reel: ReelView, deps: ReelDeps): Promise<void> {
  // No page: a reel for the other networks only, which go through Buffer.
  if (!reel.fb_page_id && deps.reelPublisher !== 'buffer') {
    throw new Error('This reel has no Facebook page, and the other networks only take reels through Buffer (Setup → Reels → Publish reels through).');
  }
  if (!reel.output_path && !reel.video_url) throw new Error('This reel has no video to publish.');

  const page = reel.fb_page_id ? getFbPage(reel.fb_page_id) ?? null : null;
  if (reel.fb_page_id && !page) throw new Error('The Facebook page for this reel no longer exists.');

  // Straight to the Page, the account behind it is the only thing the reel
  // goes through. (Through Buffer each network checks its own account, so one
  // account off does not hold the others back; see the end of that route.)
  if (deps.reelPublisher !== 'buffer' && page?.profile_id) {
    const account = getProfile(page.profile_id);
    if (account && !account.enabled) {
      throw new AccountOffError(
        `"${account.label}" is switched off, so this reel was not published. ` +
          'Switch it on in Channels → Accounts, then publish again.',
      );
    }
  }

  updateReel(reel.id, { status: 'publishing', error: null });

  // A studio reel is a file the platform assembled; a one-shot reel is a url
  // the image service handed back.
  let video: Buffer;
  try {
    video = reel.output_path ? await readFile(reel.output_path) : await deps.download(reel.video_url!);
  } catch (err) {
    // Google's video links expire. A dead link is not something a retry of
    // the publish can fix: forget it, so Retry makes the video again.
    if (!reel.output_path && /HTTP (403|404|410)/.test(errorMessage(err))) {
      updateReel(reel.id, { videoUrl: null });
      throw new Error('The video link has expired. Press Retry to make the video again.');
    }
    throw err;
  }

  // A one-shot reel is Flow's file as it came: re-encoded to the Reels shape
  // before anyone else sees it (see normalizeForSocial). A file that cannot be
  // re-encoded still goes out as it is.
  if (!reel.output_path) {
    try {
      video = await (deps.normalize ?? normalizeForSocial)(video);
    } catch (err) {
      log.warn(`reel ${reel.id}: could not re-encode the video, sending it as it came — ${errorMessage(err)}`);
    }
  }

  // Before the Facebook client is built, not after. Building one asks the
  // page for its access token and throws when there is none — which is
  // exactly the state a page added by hand for this route is in, so the
  // Buffer path died on a token it was never going to use.
  if (deps.reelPublisher === 'buffer') {
    await publishThroughBuffer(reel, page, video, deps);
    return;
  }
  if (!page) throw new Error('This reel has no Facebook page to publish to.');

  // A card (profile:<id>, manual:<slug>) holds no token: it is bridged to the
  // token's own page by name. When no page of that name is synced, say so
  // plainly, rather than the bare "no Facebook token" that gave no way out.
  if (deps.resolveFbTarget && !deps.resolveFbTarget(page.id) && /^(profile|manual):/.test(page.page_id)) {
    throw new Error(
      `No page managed by your Facebook token is named "${page.name}". ` +
        'Rename this account card to the page\'s exact name on Facebook (Accounts), ' +
        'or check that the page was added to the token\'s system user and the token was refreshed.',
    );
  }

  const facebook = deps.facebookFor(page.id);
  // The real page id to address: a Buffer account-card page (profile:<id>)
  // publishes to the synced page bridged to it, not to its synthetic id.
  const realPageId = deps.resolveFbTarget?.(page.id)?.pageId ?? page.page_id;

  // What the post says follows Setup -> Caption structures, as it does on the
  // Buffer route: the caption, the recipe when asked, and the link where the
  // setting puts it (in the text, in the first comment, as an invitation to
  // comment the keyword, or nowhere). The direct route used to ignore all of
  // that: bare caption, and the link in a first comment every time.
  const cfg = {
    captionOn: deps.captionOn,
    facebookRecipe: deps.facebookRecipe,
    facebookLink: deps.facebookLink,
    ...(reel.site_id ? deps.captionConfig?.(reel.site_id) ?? {} : {}),
  };
  const written = reel.caption.trim();
  const title = (reel.run_title ?? '').trim() || written;
  // The word this reel asks readers to comment is taken from the dish, and
  // kept on the reel: the webhook looks it up there.
  // Facebook unticked under Caption structures means the plain post of before
  // those settings existed: the title and the link, no recipe, no keyword.
  const shaped = !cfg.captionOn || cfg.captionOn.has('facebook');
  const keyword = shaped
    ? await pickCommentKeyword(title, async (t) => (await deps.prompt('comment-keyword', { title: t })).content, deps.commentKeyword)
    : '';
  updateReel(reel.id, { triggerKeyword: keyword || null });
  const post = facebookPost({
    body: (shaped ? written : '') || title,
    recipe: shaped ? recipePostText((reel as { run_id?: number | null }).run_id ?? null, cfg.facebookRecipe ?? 'none') : '',
    postUrl: reel.post_url,
    // No choice made at all (a bare ReelDeps): what this route always did.
    link: shaped ? cfg.facebookLink ?? 'comment' : 'text',
    keyword,
  });

  const published = await facebook.publishReel({
    pageId: realPageId,
    video,
    description: post.text,
    title,
  });

  updateReel(reel.id, {
    status: 'published',
    fbVideoId: published.videoId,
    error: null,
  });
  markFbPageUsed(page.id);

  log.info(`reel ${reel.id} published to ${page.name || page.page_id}: ${published.permalink}`);

  // The article link goes in the first comment, and only there. Recorded as
  // published before this runs, on purpose: the reel is live on the page
  // whether or not the comment lands, and a failure here must read as "the
  // link is missing" -- something a person can fix in ten seconds -- rather
  // than as a failed publish that the scheduler then tries to post again.
  let linkNote = '';
  if (post.firstComment && reel.post_url) {
    try {
      await facebook.commentOnReel({
        pageId: realPageId,
        videoId: published.videoId,
        message: reel.post_url,
      });
      log.info(`reel ${reel.id}: article link posted as the first comment`);
    } catch (err) {
      const why = errorMessage(err);
      log.warn(`reel ${reel.id}: published, but the link comment failed: ${why}`);
      linkNote =
        `\n\n<b>The link comment did not post.</b> Add it by hand:\n${escapeHtml(reel.post_url)}\n` +
        `<i>${escapeHtml(why)}</i>`;
    }
  }

  await notify(
    deps,
    `<b>Reel published</b>\n${escapeHtml(reel.run_title ?? '')}\n\n` +
      `Page: ${escapeHtml(page.name || page.page_id)}\n${published.permalink}${linkNote}`,
  );
}

/**
 * Put the reel on its site, then schedule it on that site's Buffer account.
 *
 * Buffer holds the Facebook connection, so there is no Page token here to
 * mint, renew or have expire — which is the whole reason for this route. The
 * cost is honesty about what "published" means: Buffer queues the post, so
 * nothing here can say Facebook accepted the video. The reel is recorded as
 * published with Buffer's post id in place of a Facebook video id, and the
 * notification says where to look.
 */
async function publishThroughBuffer(
  reel: ReelView,
  page: { id: number; page_id: string; name: string; profile_id?: number | null } | null,
  video: Buffer,
  deps: ReelDeps,
): Promise<void> {
  if (!reel.site_id) throw new Error('This reel has no site to host its video on.');
  // The reel's page is picked by its own rotation (pageForSite), the run's
  // Facebook account by another (the account turn). On the rotation route the
  // reel goes through its page's own account, so the page the reel says it is
  // for is the page it lands on -- before this, a reel shown for RecipeCorner2
  // went out through whichever account the run's turn held, Recipesbuzz.
  const pageProfile = page?.profile_id ?? undefined;
  const siteId = reel.site_id;
  const runId = (reel as { run_id?: number | null }).run_id ?? null;
  const channels = readChannels(reel);
  const save = () => setReelChannels(reel.id, JSON.stringify(channels));

  // Once on the site, then reused: a retry of one channel does not upload it again.
  let videoUrl = channels.siteVideo ?? '';
  if (!videoUrl) {
    videoUrl = await deps.uploadVideo(siteId, video, reel.run_title || reel.seed_keyword || '');
    channels.siteVideo = videoUrl;
    save();
    log.info(`reel ${reel.id}: video published at ${videoUrl}`);
    // Keep the site's copy as the reel's video: it does not expire like Google's link.
    if (!reel.output_path) updateReel(reel.id, { videoUrl });
  }

  // The same video on the recipe page, for readers and for Google.
  if (deps.attachVideo && !channels.recipePage) {
    try {
      if (await deps.attachVideo({ siteId, runId, videoUrl })) {
        channels.recipePage = true;
        save();
        log.info(`reel ${reel.id}: video added to the recipe page`);
      }
    } catch (err) {
      log.warn(`reel ${reel.id}: could not add the video to the recipe page — ${errorMessage(err)}`);
    }
  }

  const title = (reel.run_title ?? '').trim() || reel.caption.trim();

  // What the post says: the caption written for this reel, then the link.
  //
  // It used to be the title and the link, nothing else, and the caption — a
  // hook, a few lines about the dish, a question, hashtags — was generated for
  // every reel and read by nothing unless the article had no title at all. Its
  // prompt forbids links precisely because the platform adds them, which is
  // what happens here.
  //
  // Setup -> Caption structures says which networks get those words. A network
  // left off gets an empty caption, and every branch below already falls back
  // to the title when the caption is empty — so unticking a box returns that
  // network to the title and the link it carried before, rather than to
  // something new.
  const cfg = {
    captionOn: deps.captionOn,
    facebookRecipe: deps.facebookRecipe,
    facebookLink: deps.facebookLink,
    youtubeRecipe: deps.youtubeRecipe,
    instagramRecipe: deps.instagramRecipe,
    tiktokRecipe: deps.tiktokRecipe,
    ...(deps.captionConfig?.(siteId) ?? {}),
  };
  const written = reel.caption.trim();
  const captionFor = (name: ChannelName): string =>
    !cfg.captionOn || cfg.captionOn.has(name) ? written : '';

  const fbBody = captionFor('facebook') || title;
  // The caption, then the recipe when asked, and the link where the setting
  // says: in the text (what every reel did), in the first comment, or nowhere.
  // Facebook unticked: the title and the link as before, no recipe or keyword.
  const fbShaped = !cfg.captionOn || cfg.captionOn.has('facebook');
  const fbKeyword = fbShaped
    ? await pickCommentKeyword(title, async (t) => (await deps.prompt('comment-keyword', { title: t })).content, deps.commentKeyword)
    : '';
  updateReel(reel.id, { triggerKeyword: fbKeyword || null });
  const facebook = facebookPost({
    body: fbBody,
    recipe: fbShaped ? recipePostText(runId, cfg.facebookRecipe ?? 'none') : '',
    postUrl: reel.post_url,
    link: fbShaped ? cfg.facebookLink ?? 'text' : 'text',
    keyword: fbKeyword,
  });
  const text = facebook.text;

  // Each channel on its own: one refusing (a full Buffer queue, say) does not
  // keep the reel off the others, and a retry only tries the ones that failed.
  const attempt = async (name: ChannelKey, send: (onPage: (page: string) => void) => Promise<string | null>): Promise<void> => {
    if (channels[name]?.status === 'ok') return;
    let page = '';
    try {
      const id = await send((p) => { page = p.trim(); });
      channels[name] = id ? { status: 'ok', id, ...(page ? { page } : {}) } : { status: 'off' };
      if (id) log.info(`reel ${reel.id}: ${name} scheduled as ${id}${page ? ` on "${page}"` : ''}`);
    } catch (err) {
      channels[name] = { status: 'failed', error: errorMessage(err).slice(0, 400) };
      log.warn(`reel ${reel.id}: ${name} failed — ${errorMessage(err)}`);
    }
    save();
  };

  // Every account the reel goes to on a network: the run's own in rotation,
  // all of the site's when it posts to all (Channels -> Accounts). The run's
  // own keeps the network's plain name, as every reel before this had; each
  // other is "network:profile id", so a retry knows which ones still need it.
  // A network switched off for the site answers its first account with null,
  // and the others are not asked.
  //
  // The accounts are decided once, at the reel's first publish, and kept on
  // it. Worked out afresh on a retry they could differ: a reel with no run
  // moves the turn each time it asks, so the account that was first comes
  // back under another key and is posted to twice — and a network switched
  // back to rotation would never retry the account that failed.
  const network = async (
    platform: ChannelName,
    send: (profileId: number | undefined, onPage: (page: string) => void) => Promise<string | null>,
  ) => {
    let ids = channels.targets?.[platform];
    if (!ids) {
      const asked = deps.targets?.({ siteId, runId, platform }) ?? [0];
      ids = asked.length ? asked : [0];
      channels.targets = { ...(channels.targets ?? {}), [platform]: ids };
      save();
    }
    for (const [i, id] of ids.entries()) {
      const key = channelKey(platform, i === 0 ? null : id);
      await attempt(key, (onPage) => send(id > 0 ? id : undefined, onPage));
      if (i === 0 && channels[key]?.status === 'off') return;
    }
  };

  await network('facebook', async (profileId, onPage) => {
    // No Facebook page takes this site's reels: it is made for the others only.
    if (!page) return null;
    const id = await deps.scheduleReel({ siteId, runId, text, videoUrl, profileId: profileId ?? pageProfile, firstComment: facebook.firstComment, title, onPage });
    if (id) markFbPageUsed(page.id); // null: the account is switched off, nothing was sent
    return id;
  });
  await network('pinterest', async (profileId, onPage) =>
    // A run with no link is a social-only account's: its video pin goes out without one.
    deps.pinReel && (reel.post_url || isSocialOnly({ domain: getSite(siteId)?.domain ?? 'x.x' }))
      ? deps.pinReel({ siteId, runId, title, linkUrl: reel.post_url ?? '', videoUrl, profileId, onPage })
      : null,
  );
  // Instagram captions cannot carry a link: Channels -> Instagram says where it goes.
  await network('instagram', async (profileId, onPage) =>
    deps.instagramReel
      ? deps.instagramReel({ siteId, runId, title, caption: captionFor('instagram'), recipes: recipeCandidates(runId, cfg.instagramRecipe ?? 'none'), postUrl: reel.post_url ?? '', videoUrl, profileId, onPage, pageProfileId: pageProfile })
      : null,
  );

  // The same caption, plus the site's own address: YouTube's description is
  // indexed and takes as many links as it is given, which none of the others
  // do.
  await network('youtube', async (profileId, onPage) =>
    deps.youtubeShort
      ? deps.youtubeShort({ siteId, runId, title, caption: captionFor('youtube'), recipes: recipeCandidates(runId, cfg.youtubeRecipe ?? 'none'), postUrl: reel.post_url ?? '', videoUrl, profileId, onPage, pageProfileId: pageProfile })
      : null,
  );

  // TikTok captions have no clickable link, same as Instagram's.
  await network('tiktok', async (profileId, onPage) =>
    deps.tiktokReel
      ? deps.tiktokReel({ siteId, runId, title, caption: captionFor('tiktok'), recipes: recipeCandidates(runId, cfg.tiktokRecipe ?? 'none'), postUrl: reel.post_url ?? '', videoUrl, profileId, onPage, pageProfileId: pageProfile })
      : null,
  );

  const names = channelKeys(channels);
  const ok = names.filter((n) => channels[n]?.status === 'ok');
  const failed = names.filter((n) => channels[n]?.status === 'failed');
  const failures = failed.map((n) => `${n}: ${channels[n]!.error}`).join('\n');

  if (ok.length === 0 && failed.length > 0) {
    // Nothing went anywhere: a failed reel, retried later as a whole.
    throw new Error(failures);
  }
  if (ok.length === 0) {
    // Nothing failed and nothing went: every account it would use is switched
    // off (or its network is off for the site). Not "published" with nothing
    // on it — left ready, and said so.
    throw new AccountOffError(
      'Every account this reel goes to is switched off, so nothing was sent. ' +
        'Switch one on in Channels → Accounts, then publish again.',
    );
  }

  updateReel(reel.id, {
    status: 'published',
    fbVideoId: channels.facebook?.id ?? channels[ok[0]!]?.id ?? null,
    error: failed.length ? `Published on ${ok.join(', ')}. Not on:\n${failures}` : null,
  });

  await notify(
    deps,
    `<b>Reel scheduled</b>\n${escapeHtml(reel.run_title ?? '')}\n\n` +
      (page ? `Page: ${escapeHtml(page.name || page.page_id)}\n` : '') +
      `On: ${ok.map((n) => `${n}${channels[n]!.page ? ` → ${escapeHtml(channels[n]!.page!)}` : ''} (${escapeHtml(channels[n]!.id ?? '')})`).join(', ') || 'nothing'}` +
      (failed.length ? `\n<b>Not on:</b> ${failed.join(', ')} — press Retry on the reel.` : '') +
      `\nBuffer publishes on its own schedule, so check the Buffer queue for the result.`,
  );
}

/**
 * What a Short says under the video.
 *
 * The caption is the one the platform writes for every reel and which, until
 * now, nothing read: its prompt forbids links precisely because the platform
 * adds them, so the recipe's address goes after it rather than inside it.
 *
 * The title leads only when there is no caption, so the description is never
 * just the title repeated under it.
 */
export function youtubeDescription(
  title: string,
  caption: string,
  postUrl: string,
  domain: string,
  /** Setup -> Caption structures: either line can be left off. Both by default. */
  links: { recipe: boolean; site: boolean } = { recipe: true, site: true },
  /** The recipe texts to try under the caption, best first (see recipeCandidates). */
  recipes: readonly string[] = [],
): string {
  const body = caption.trim() || title.trim();
  const link = links.recipe && postUrl.trim() ? `La recette complète : ${postUrl.trim()}` : '';
  const site = links.site && domain.trim().includes('.') ? `Plus de recettes : https://${domain.trim().replace(/^https?:\/\//, '')}` : '';

  return composeWithRecipe({ body, recipes, tail: [[link, site].filter(Boolean).join('\n')], limit: 5000 });
}

export const CHANNEL_NAMES = ['facebook', 'pinterest', 'instagram', 'youtube', 'tiktok'] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];
/** A network, or one more account on it: "youtube" is the run's own account, "youtube:12" profile 12. */
export type ChannelKey = ChannelName | `${ChannelName}:${number}`;
export type ChannelState = {
  status: 'ok' | 'failed' | 'off';
  id?: string;
  error?: string;
  /** The page or channel Buffer really posted to, by its name on Buffer. */
  page?: string;
};
export type ReelChannels = Partial<Record<ChannelKey, ChannelState>> & {
  siteVideo?: string;
  recipePage?: boolean;
  /** The accounts each network goes to, by profile id (0: the run's own), fixed at the first publish. */
  targets?: Partial<Record<ChannelName, number[]>>;
};

export const channelKey = (name: ChannelName, profileId: number | null): ChannelKey =>
  profileId ? `${name}:${profileId}` : name;

/** The network a key belongs to. */
export const channelOf = (key: ChannelKey): ChannelName => key.split(':')[0] as ChannelName;

/** Every channel key recorded on a reel, network by network in the usual order. */
export function channelKeys(channels: ReelChannels): ChannelKey[] {
  const keys = Object.keys(channels).filter((k) => CHANNEL_NAMES.includes(k.split(':')[0] as ChannelName)) as ChannelKey[];
  return keys.sort((a, b) =>
    CHANNEL_NAMES.indexOf(channelOf(a)) - CHANNEL_NAMES.indexOf(channelOf(b)) || (a.includes(':') ? 1 : 0) - (b.includes(':') ? 1 : 0) || a.localeCompare(b));
}

/** Where a reel really went, "facebook → Amanda Recipes · instagram → amanda.recipes", from what Buffer said. */
export function pagesLine(channels: ReelChannels): string {
  return channelKeys(channels)
    .filter((k) => channels[k]?.status === 'ok' && channels[k]?.page)
    .map((k) => `${channelOf(k)} → ${channels[k]!.page}`)
    .join(' · ');
}

/** Where a reel went, channel by channel, as recorded on it. */
export function readChannels(reel: { channels_json?: string | null }): ReelChannels {
  try {
    const parsed = JSON.parse(reel.channels_json || '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as ReelChannels) : {};
  } catch {
    return {};
  }
}

/**
 * Queue the video for a draft reel.
 *
 * The Flow project comes from the site, exactly as it does for article images,
 * so a reel generates into the same project as the images it is built from.
 */
export async function startGeneration(
  reel: ReelView,
  settings: Settings,
  images: Pick<ImageClient, 'submitVideo'>,
): Promise<void> {
  const references = JSON.parse(reel.reference_json) as string[];
  if (references.length === 0) {
    throw new Error('A reel needs at least one reference image.');
  }

  const site = reel.site_id ? getSite(reel.site_id) : undefined;
  const project = resolveProjectId(
    site?.project_id ?? '',
    settings.get('flow_project_id'),
    site?.domain ?? '',
  );

  // The page's presenter is in the clip when the page has one: character on
  // screen, voice on the line. Same ids every reel, so it is the same person.
  const presenter = reel.fb_page_id ? presenterForPage(reel.fb_page_id) : undefined;
  const jobId = await images.submitVideo({
    prompt: reel.prompt,
    referenceUrls: references,
    characterMediaId: presenter?.flow_character_id || undefined,
    voiceMediaId: presenter?.flow_voice_id || undefined,
    projectId: project.projectId,
  });

  updateReel(reel.id, { status: 'generating', jobId, error: null });
  log.info(`reel ${reel.id}: queued video job ${jobId} from ${references.length} image(s)`);
}

/** Never throws: a published reel whose notification failed is still published. */
async function notify(deps: ReelDeps, message: string): Promise<void> {
  try {
    await deps.telegram.sendMessage(message);
  } catch (err) {
    log.warn(`could not send a reel notification: ${errorMessage(err)}`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export { FacebookError };
