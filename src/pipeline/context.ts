import type { GoogleResearch } from './steps/research.js';
import type { Settings } from '../settings.js';
import { withSiteOverrides } from '../core/caption-structures.js';
import { BufferPool } from '../integrations/buffer-pool.js';
import { ImageClient } from '../integrations/images.js';
import { resolveProjectId, type ResolvedProjectId } from '../core/project-id.js';
import { SiteApiClient } from '../integrations/site-api.js';
import { siteApiFor } from '../integrations/site-api-for.js';
import { TelegramClient } from '../integrations/telegram.js';
import type { ChatResult } from '../llm/client.js';
import { askPrompt } from '../llm/ask.js';
import {
  clearSharedImages,
  getSharedImages,
  fanoutPosted,
  markFanoutPosted,
  runProfile,
  runTargets,
  type ChannelProfile,
  type ProfilePlatform,
  saveSharedImages,
  siteSecrets,
  type SharedImageUrls,
  type SiteRow,
  type KeywordRow,
  bufferChannelName,
} from '../db/repos.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('pipeline-context');

/**
 * Where a keyword's already-generated article images are recorded.
 *
 * Behind an interface for the same reason the API clients are: a step should
 * be testable without a database standing behind it.
 */
export interface SharedImageStore {
  get(keywordId: number): SharedImageUrls | undefined;
  save(keywordId: number, sourceSiteId: number, urls: SharedImageUrls): void;
  clear(keywordId: number): void;
}

const databaseImageStore: SharedImageStore = {
  get: getSharedImages,
  save: saveSharedImages,
  clear: clearSharedImages,
};

/**
 * Everything a pipeline step is allowed to touch.
 *
 * Steps receive this rather than importing clients directly, which keeps them
 * individually testable with fakes and makes their dependencies explicit.
 */
export interface StepUsage {
  tokensIn: number;
  tokensOut: number;
  images: number;
}

export class PipelineContext {
  /** What the top Google results say, once the research step has run. */
  research?: GoogleResearch;
  readonly site: SiteRow;
  readonly keyword: KeywordRow;
  readonly runId: number;
  readonly settings: Settings;
  readonly encryptionKey: Buffer;
  readonly allowResume: boolean;

  /**
   * A dry run executes everything and stops before publishing.
   *
   * The point is prompt work: the only way to see what a prompt change does
   * used to be to publish it to a live site.
   */
  readonly mode: 'live' | 'dry';

  /**
   * This run has already been through the gate.
   *
   * Set when a held run is resumed. Without it, resuming an approved article
   * on a site with auto-publish off hits holdReason again — the site setting
   * has not changed — and the article is held a second time, so approval never
   * publishes anything.
   */
  readonly approved: boolean;

  /** Whether this keyword-site link reuses images rather than generating them. */
  readonly shareImages: boolean;
  readonly sharedImages: SharedImageStore;

  /** Which Flow project this run generates into, and how that was decided. */
  readonly projectId: ResolvedProjectId;

  readonly siteApi: SiteApiClient;
  readonly images: ImageClient;

  /**
   * The pause between one image generation and the next, in milliseconds.
   *
   * Kept on the run rather than inside ImageClient because the client only
   * sees one request at a time; the thing being spaced is the sequence of
   * them across steps, and the pin graphic minutes later is part of it.
   * `lastImageGeneratedAt` is when the previous one came back, so the wait is
   * only what remains of the gap -- time spent writing the article counts.
   */
  readonly imageGapMs: number;
  lastImageGeneratedAt: number | null = null;
  now: () => number = () => Date.now();
  pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  /**
   * The site's accounts on each network (Pinterest 1, Pinterest 2...). One of
   * each is chosen for this run, in turn, the first time it is needed -- not
   * before, so a run that never pins does not move Pinterest's turn -- and
   * kept on the run so a resume and its reel go to the same one.
   */
  private readonly profiles = new Map<ProfilePlatform, ChannelProfile | null>();
  private readonly pools = new Map<ProfilePlatform, BufferPool>();
  private readonly legacyBufferToken: string;

  profile(platform: ProfilePlatform): ChannelProfile | null {
    if (!this.profiles.has(platform)) {
      let chosen: ChannelProfile | null = null;
      try {
        chosen = runProfile(this.runId, this.site.id, platform) ?? null;
      } catch {
        chosen = null; // no database behind a test context
      }
      this.profiles.set(platform, chosen);
    }
    return this.profiles.get(platform) ?? null;
  }

  private pool(platform: ProfilePlatform): BufferPool {
    let pool = this.pools.get(platform);
    if (!pool) {
      pool = this.poolFor(platform, this.profile(platform) ?? undefined);
      this.pools.set(platform, pool);
    }
    return pool;
  }

  /** A Buffer pool on one given account of a network. */
  private poolFor(platform: ProfilePlatform, profile: ChannelProfile | undefined): BufferPool {
    return new BufferPool(
      {
        id: this.site.id,
        domain: this.site.domain,
        pinUsername: profile ? bufferChannelName(profile) : this.site.pin_username,
        platform,
        profileId: profile?.id,
      },
      this.encryptionKey,
      !profile || profile.position === 1 ? this.legacyBufferToken : '',
    );
  }

  /**
   * Send one post on a network to every account this run targets there: the
   * run's own account in rotation, all of the site's when it posts to all
   * (Channels -> Accounts).
   *
   * Each post is recorded the moment it is scheduled, and an account already
   * recorded for the same `purpose` is skipped — so when the third of three
   * refuses and the step is tried again, the first two are not posted a
   * second time. The others are still tried when one fails; the failures are
   * thrown together at the end.
   *
   * `purpose` separates this record from any other step that posts to the
   * same platform in the same run (the article post and the photo collage
   * both post to `'facebook'`, on the same account) — without it, the second
   * step would see the first step's post already recorded and skip actually
   * sending anything, handing back the first step's post id as if it were
   * its own. Defaults to `platform` for callers with only one such step.
   *
   * Returns the run's own account's post id, which is what the step returned
   * before there was more than one account to post to.
   *
   * `send` may return `null` instead of a post id to say this particular
   * account was deliberately skipped (its own page settings say not to post
   * there) -- not a failure, not recorded as posted, and not counted toward
   * the returned `postId`. Without this, a step that gates on "does any
   * account of this site take this kind of post" and then fans out to every
   * account in rotation could land on an account whose own page has that
   * kind of post switched off.
   */
  async eachAccount(
    platform: ProfilePlatform,
    send: (pool: BufferPool, profile: ChannelProfile | undefined, first: boolean) => Promise<string | null>,
    purpose: string = platform,
  ): Promise<{ postId: string; accounts: number }> {
    let targets: (ChannelProfile | undefined)[];
    try {
      targets = runTargets(this.runId, this.site.id, platform);
    } catch {
      targets = [this.profile(platform) ?? undefined]; // no database behind a test context
    }
    let done: Record<string, string> = {};
    try {
      done = fanoutPosted(this.runId, purpose);
    } catch {
      done = {};
    }

    let postId = '';
    const failures: string[] = [];
    for (const [i, profile] of targets.entries()) {
      const key = String(profile?.id ?? 0);
      if (done[key]) {
        if (i === 0) postId = done[key]!;
        continue;
      }
      // An account switched off (the toggle on its card) never posts, on any
      // network. The run's own account can be one: with nothing usable in
      // rotation, pickProfile still hands back the site's only account so the
      // run has something to carry. A site with no accounts at all (profile
      // undefined) is the legacy single-account case and still posts.
      if (profile && !profile.enabled) {
        log.info(`run ${this.runId}: skipping ${platform} account "${profile.label}" — it is switched off`);
        continue;
      }
      try {
        const id = await send(i === 0 ? this.pool(platform) : this.poolFor(platform, profile), profile, i === 0);
        if (id === null) continue; // this account's own settings say to skip it -- not a failure, nothing to record
        try {
          markFanoutPosted(this.runId, purpose, profile?.id ?? 0, id);
        } catch {
          // no database behind a test context
        }
        if (i === 0) postId = id;
      } catch (err) {
        if (targets.length === 1) throw err;
        failures.push(`${profile?.label ?? platform}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length) {
      throw new Error(`Posted on ${targets.length - failures.length} of ${targets.length} ${platform} accounts. Not on:\n${failures.join('\n')}`);
    }
    return { postId, accounts: targets.length };
  }

  /** Pinterest, through this run's Pinterest account. */
  get buffer(): BufferPool {
    return this.pool('pinterest');
  }

  /** The Facebook Page, through this run's Facebook account. */
  get facebookBuffer(): BufferPool {
    return this.pool('facebook');
  }

  get instagramBuffer(): BufferPool {
    return this.pool('instagram');
  }

  /** The Pinterest username and boards of this run's Pinterest account (the site's own before accounts existed). */
  get pinBoards(): { username: string; defaultBoard: string; boardMap: string } {
    const profile = this.profile('pinterest');
    const site = this.site as { pin_username: string; pin_default_board?: string; pin_board_map?: string };
    return profile
      ? { username: bufferChannelName(profile), defaultBoard: profile.default_board, boardMap: profile.board_map }
      : { username: site.pin_username, defaultBoard: site.pin_default_board ?? '', boardMap: site.pin_board_map ?? '' };
  }
  readonly telegram: TelegramClient;

  constructor(init: {
    runId: number;
    site: SiteRow;
    keyword: KeywordRow;
    settings: Settings;
    encryptionKey: Buffer;
    allowResume?: boolean;
    shareImages?: boolean;
    sharedImages?: SharedImageStore;
    mode?: 'live' | 'dry';
    approved?: boolean;
  }) {
    this.runId = init.runId;
    this.site = init.site;
    this.keyword = init.keyword;
    // Caption settings are per site where a site has its own (Setup -> Caption structures).
    this.settings = withSiteOverrides(init.settings, init.site.id);
    this.encryptionKey = init.encryptionKey;
    this.allowResume = init.allowResume ?? true;
    this.mode = init.mode ?? 'live';
    this.approved = init.approved ?? false;
    this.shareImages = init.shareImages ?? false;
    this.sharedImages = init.sharedImages ?? databaseImageStore;

    // Credentials are per site: each domain has its own publishing token and
    // its own Buffer account.
    const secrets = siteSecrets(init.site, init.encryptionKey);
    this.siteApi = siteApiFor(init.site, secrets.apiToken);

    // Resolved here, once per run, so every image in an article goes into the
    // same project and the run log can say which one and why.
    this.projectId = resolveProjectId(
      init.site.project_id,
      init.settings.get('flow_project_id'),
      init.site.domain,
    );

    this.imageGapMs = Math.max(0, init.settings.getNumber('image_gap_seconds')) * 1000;

    this.images = new ImageClient({
      baseUrl: init.settings.get('image_base_url'),
      apiKey: init.settings.get('image_api_key'),
      pollIntervalMs: init.settings.getNumber('image_poll_interval_seconds') * 1000,
      maxAttempts: init.settings.getNumber('image_poll_max_attempts'),
      projectId: this.projectId.projectId,
      imageModel: init.settings.get('image_model'),
    });

    // Pools are made per account when first needed (see pool()); a full
    // queue moves to the account's next Buffer token instead of failing.
    this.legacyBufferToken = secrets.bufferToken;

    this.telegram = new TelegramClient(
      init.settings.get('telegram_bot_token'),
      init.settings.get('telegram_chat_id'),
    );
  }

  /* -- What the current step has cost so far --------------------------- */

  /**
   * Tokens and images spent since the engine last reset this.
   *
   * Accumulated on the context rather than returned from each call because a
   * step makes several — generate-article alone makes three, sometimes six
   * with the fallbacks — and threading a running total back out through every
   * helper would put accounting into code that should only be about articles.
   */
  private usage: StepUsage = { tokensIn: 0, tokensOut: 0, images: 0 };

  resetUsage(): void {
    this.usage = { tokensIn: 0, tokensOut: 0, images: 0 };
  }

  /** Read the accumulated usage and start a fresh count. */
  takeUsage(): StepUsage {
    const spent = this.usage;
    this.resetUsage();
    return spent;
  }

  /** Record images generated by this step, for the run's usage summary. */
  countImages(n: number): void {
    this.usage.images += Math.max(0, n);
  }

  /**
   * Run a named prompt through the LLM pool.
   *
   * `promptName` matches the extracted prompt files. The format comes from
   * PROMPT_MODELS so the call matches what the prompt was authored for; the
   * model comes from modelFor, which is that default unless overridden.
   */
  async prompt(
    promptName: string,
    variables: Record<string, unknown>,
    overrides: { model?: string; format?: 'json' | null } = {},
  ): Promise<ChatResult> {
    const result = await askPrompt(this.settings, this.encryptionKey, promptName, variables, overrides);

    this.usage.tokensIn += result.tokensIn;
    this.usage.tokensOut += result.tokensOut;

    return result;
  }
}
