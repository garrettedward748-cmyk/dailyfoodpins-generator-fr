import { brandName, siteAssetUrl, sitePostUrl } from '../../core/social-only.js';
import type { Step } from '../engine.js';
import { parseBoardMap } from '../../db/repos.js';
import { createLogger, errorMessage } from '../../lib/logger.js';
import { parseJson } from '../json.js';
import type { PostedRecipe } from '../../integrations/site-api.js';
import type { SeoData } from './content.js';
import { composeWithRecipe, parseRecipeInPost, recipeCandidates } from '../../reels/recipe-text.js';

const log = createLogger('publish');

/** Stages 10-13: Pinterest description, board selection, Buffer, notification. */

export interface PinContext {
  seo: SeoData;
  posted: PostedRecipe;
  pinImageUrl: string;
  cta: string;
}

export const generatePinDescription: Step<PinContext, string> = {
  name: 'generate-pin-description',
  title: 'Write Pinterest description',
  async run(ctx, input) {
    const result = await ctx.prompt('pin-description', {
      seo: input.seo,
      cta: input.cta,
      site: { domain: brandName(ctx.site) },
      spy: {
        title: ctx.keyword.spy_title,
        description: ctx.keyword.spy_description,
        annotation: ctx.keyword.annotation,
      },
    });

    const text = result.content.trim();
    if (!text) throw new Error('Pin description came back empty');

    return { value: text, endpoint: result.endpoint, model: result.model };
  },
};

export interface BufferTarget {
  channelId: string;
  boardServiceId: string;
  boardName: string;
}

/**
 * Resolve which Buffer channel and Pinterest board to post to.
 *
 * The site's configured channel id is preferred; the model only picks the
 * board, which is what it was doing in the original.
 */
export const resolveBufferTarget: Step<SeoData, BufferTarget> = {
  name: 'resolve-buffer-target',
  title: 'Select Buffer channel and board',
  async run(ctx, seo) {
    // The run's Pinterest account is switched off: nothing will be pinned, so
    // there is no point asking Buffer for channels (which would also fail the
    // run when that account has no token). publishToBuffer skips on its own.
    const own = ctx.profile?.('pinterest');
    if (own && !own.enabled) {
      return { value: { channelId: '', boardServiceId: '', boardName: '' } };
    }

    const orgId = await ctx.buffer.getOrganizationId();
    const all = await ctx.buffer.getChannels(orgId);

    if (all.length === 0) {
      throw new Error('Buffer returned no channels for this organization');
    }

    // Pinterest only. Once the same Buffer account also held the Facebook
    // page the reels publish to, picking the first channel of any network
    // found that one and failed with "has no Pinterest boards" — a true
    // sentence about the wrong channel.
    const channels = all.filter((c) => c.service === '' || c.service === 'pinterest');

    if (channels.length === 0) {
      throw new Error(
        `None of this Buffer account's ${all.length} channel(s) is Pinterest. ` +
          'Connect a Pinterest profile, or turn Buffer publishing off in Setup.',
      );
    }

    // The Buffer token is this site's own, so its channel list belongs to this
    // site. Match the Pinterest username when there is more than one.
    const site = ctx.site as { pin_username: string; pin_board_map?: string; pin_default_board?: string };
    const boards = ctx.pinBoards ?? {
      username: site.pin_username,
      defaultBoard: site.pin_default_board ?? '',
      boardMap: site.pin_board_map ?? '',
    };
    const byPinUsername = boards.username.trim().toLowerCase();
    const channel =
      (byPinUsername
        ? channels.find((c) => c.name.toLowerCase() === byPinUsername)
        : undefined) ?? channels[0]!;

    if (channels.length > 1 && !byPinUsername) {
      log.warn(
        `Buffer token for ${ctx.site.domain} exposes ${channels.length} channels and no ` +
          `Pinterest username is set; using "${channel.name}".`,
      );
    }

    if (channel.boards.length === 0) {
      throw new Error(`Buffer channel "${channel.name}" has no Pinterest boards`);
    }

    const byName = (name: string) =>
      channel.boards.find((b) => b.name.trim().toLowerCase() === name.trim().toLowerCase());
    const target = (board: { serviceId: string; name: string }) => ({
      channelId: channel.id,
      boardServiceId: board.serviceId,
      boardName: board.name,
    });

    // 1. The topic group's own board, when one is set: certain, no model.
    const topic = ctx.keyword.seed_keyword.trim();
    const mapped = parseBoardMap(boards.boardMap).get(topic.toLowerCase());
    if (mapped) {
      const board = byName(mapped);
      if (board) return target(board);
      log.warn(`board "${mapped}" set for "${topic}" is not on "${channel.name}"; choosing another`);
    }

    // 2. The model picks from the account's real boards -- or says none fits.
    const result = await ctx.prompt('pick-board', {
      seo,
      topic: topic || '(none)',
      boardsJson: JSON.stringify({ boards: channel.boards }),
    });

    let boardServiceId = '';
    let boardName = '';
    try {
      const picked = parseJson<{ id?: string; name?: string; serviceId?: string }>(result.content, 'Board selection');
      boardServiceId = picked.serviceId ?? picked.id ?? '';
      boardName = picked.name ?? '';
    } catch (err) {
      log.warn('Board selection returned unparseable JSON, falling back', errorMessage(err));
    }

    // Trust the board list over the model: only accept a board that exists.
    const chosen =
      channel.boards.find((b) => b.serviceId === boardServiceId) ??
      (boardName ? byName(boardName) : undefined);

    // 3. Nothing fits: the site's general board, else the first one.
    const fallback = (boards.defaultBoard ? byName(boards.defaultBoard) : undefined) ?? channel.boards[0]!;
    if (!chosen) {
      log.info(`no board fits "${seo.title}"; using "${fallback.name}"`);
    }

    return { value: target(chosen ?? fallback), endpoint: result.endpoint, model: result.model };
  },
};

export const publishToBuffer: Step<
  { pin: PinContext; description: string; target: BufferTarget },
  { postId: string } | { skipped: true }
> = {
  name: 'publish-to-buffer',
  title: 'Schedule Pinterest pin',
  async run(ctx, input) {
    if (!ctx.settings.getBool('buffer_enabled')) {
      log.info('Buffer publishing is disabled in settings; skipping');
      return { skipped: true as const };
    }

    const href = String(input.pin.posted.href ?? '');

    // The pool may move to another of this site's Buffer accounts partway
    // through — a full queue is not a reason to lose a finished article — so
    // the board it actually posted to is whatever comes back, not what was
    // resolved earlier.
    // Setup -> Caption structures: the recipe after the description, when it
    // fits Pinterest's limit. The stored description is untouched, so a video
    // pin made later from it is not given a recipe it was not asked for.
    const recipes = recipeCandidates(ctx.runId, parseRecipeInPost(ctx.settings.get('caption_pin_recipe')));
    const text = recipes.length > 0
      ? composeWithRecipe({ body: input.description, recipes, tail: [], limit: 500 })
      : input.description;
    const pin = {
      text,
      imageUrl: siteAssetUrl(ctx.site, input.pin.pinImageUrl),
      altText: String(input.pin.posted.featuredText ?? input.pin.seo.title),
      title: String(input.pin.posted.title ?? input.pin.seo.title),
      // Empty for a social-only account: the pin goes out with no link.
      linkUrl: sitePostUrl(ctx.site, href),
    };
    const topic = ctx.keyword.seed_keyword.trim().toLowerCase();

    // One account in rotation, every one when the site posts to all. The
    // run's own account takes the board resolved for it. Each other account
    // has its own boards, so its board is found by name on that account: its
    // own board for this topic, else the board the first account chose, else
    // its general board, else its first.
    const { postId } = await ctx.eachAccount('pinterest', async (pool, profile, first) => {
      const result = first
        ? await pool.createPost(
            { ...pin, channelId: input.target.channelId, boardServiceId: input.target.boardServiceId },
            input.target.boardName,
          )
        : await (async () => {
            const preferred = [
              profile ? parseBoardMap(profile.board_map).get(topic) ?? '' : '',
              input.target.boardName,
              profile?.default_board ?? '',
            ];
            const destination = await pool.resolveDestination(preferred);
            return pool.createPost(
              { ...pin, channelId: destination.channelId, boardServiceId: destination.boardServiceId },
              destination.boardName,
            );
          })();
      log.info(
        `scheduled Pinterest pin ${result.postId} on board "${result.destination.boardName}" ` +
          `via Buffer account "${result.account}"`,
      );
      return result.postId;
    });
    // Every account this run reaches was switched off: nothing was pinned.
    if (!postId) {
      log.info('every Pinterest account this run reaches is switched off; nothing pinned');
      return { skipped: true as const };
    }
    return { postId };
  },
};

/**
 * Notify. Deliberately never throws: a delivered article whose notification
 * failed is still a delivered article, and failing the run here would
 * misreport success as failure.
 */
export const notify: Step<
  { seo: SeoData; posted: PostedRecipe; pinImageUrl: string },
  { sent: boolean }
> = {
  name: 'notify',
  title: 'Send notification',
  async run(ctx, input) {
    if (!ctx.settings.getBool('telegram_enabled')) return { sent: false };

    const url = sitePostUrl(ctx.site, input.posted.href);

    const caption =
      `<b>Published</b>\n` +
      `${escapeHtml(input.seo.title)}\n\n` +
      `Site: ${escapeHtml(ctx.site.domain)}\n` +
      `Keyword: ${escapeHtml(ctx.keyword.seed_keyword)}\n` +
      `${url || '(social only — no article, posts without a link)'}`;

    const sent = input.pinImageUrl
      ? await ctx.telegram.sendPhoto(siteAssetUrl(ctx.site, input.pinImageUrl), caption)
      : await ctx.telegram.sendMessage(caption);

    return { sent };
  },
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
