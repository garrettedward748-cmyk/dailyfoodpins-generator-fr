import { BufferClient, BufferError, isBufferRateLimit, type BufferChannel } from './buffer.js';
import {
  listBufferAccounts,
  markBufferAccountFull,
  markBufferAccountUsed,
  type BufferAccount,
} from '../db/repos.js';
import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('buffer-pool');

/**
 * A site's Buffer accounts, tried in order.
 *
 * A Buffer queue takes ten posts a day and then refuses everything until it
 * drains. That used to fail the run at its last step — the article written,
 * the images generated, the post published to the site, and only the pin lost.
 *
 * So a full queue is not a failure here. It is a signal to move to the site's
 * next account and carry on, and the run finishes exactly as it would have.
 * Only running out of accounts is a failure.
 *
 * Rotation is reactive, on Buffer's own refusal, rather than on a count kept
 * here: posts scheduled into the same account from anywhere else count against
 * the same ten, so a number maintained locally would drift from the real one.
 *
 * The interface is BufferClient's, so the pipeline steps neither know nor care
 * that there is more than one account behind it.
 */

/** How long a refused account sits out. Long enough to cover the day's runs. */
const FULL_FOR_MS = 6 * 60 * 60 * 1000;

/**
 * How long a token over Buffer's API limit (HTTP 429) sits out. Buffer counts
 * over 30 days and does not say when it frees up, so it is asked once a day:
 * one request, not the three or four of every post and every retry.
 */
const LIMITED_FOR_MS = 24 * 60 * 60 * 1000;

const sitOutFor = (message: string): number => (isBufferRateLimit(message) ? LIMITED_FOR_MS : FULL_FOR_MS);

/** Benched for Buffer's API limit and not due yet: not asked at all. */
const limitedNow = (account: BufferAccount): boolean =>
  !!account.fullUntil && account.fullUntil > new Date() && isBufferRateLimit(account.lastError ?? '');

/**
 * Rejections that mean "not through this account" rather than "not at all".
 *
 * Buffer's wording is not contractual, so this matches broadly on purpose: a
 * missed match costs a failed run, while a false positive costs one rotation
 * to an account that works. Auth failures are here for the same reason a full
 * queue is — the account cannot post, and the next one might.
 */
const ROTATE_ON = [
  'queue',
  'limit',
  'full',
  'maximum',
  'exceeded',
  'too many',
  'quota',
  'throttl',
  'rate',
  'http 429',
  'unauthorized',
  'unauthenticated',
  'forbidden',
  'http 401',
  'http 403',
  'invalid token',
  'expired',
];

/**
 * The marker that says every account is spent.
 *
 * Matched as text rather than caught as a type: the error crosses the step
 * boundary wrapped in StepFailedError and reaches the scheduler as a message,
 * so the message is the only part that survives the journey.
 */
export const BUFFER_EXHAUSTED = 'All Buffer accounts are full';

export const isBufferExhausted = (error: unknown): boolean =>
  errorMessage(error).includes(BUFFER_EXHAUSTED);

/** What pickChannel says when an account names a page Buffer does not have. */
const isPageNameError = (message: string): boolean => /^No \w+ page named "/.test(message);

/**
 * Every account of the pool turned the post down. Mostly that is a full queue,
 * which fixes itself with time (and which the scheduler waits out, and a reel
 * is retried for). A page name that matches nothing on Buffer is the opposite:
 * time fixes nothing, a person has to correct the name. It is reported as
 * exactly that, never as "full", so nothing holds the site back or retries it
 * for hours waiting for a queue that was never the problem.
 */
function refusedEverywhere(
  accounts: number,
  domain: string,
  what: string,
  lastError: string,
  sawFull = true,
): BufferError {
  if (isPageNameError(lastError)) return new BufferError(lastError);
  // No account so much as tried: none has the channel (no TikTok connected, a
  // page that is not there). That is setup, not a full queue -- called "full"
  // before, with an empty Buffer, and retried for a month to no purpose.
  if (!sawFull) {
    return new BufferError(
      `No Buffer account for ${domain} can take the ${what}: ${lastError} ` +
        'Connect that channel in Buffer, or switch this network off for the site.',
    );
  }
  if (isBufferRateLimit(lastError)) {
    // Kept under BUFFER_EXHAUSTED so the reel is retried on its own and the
    // run waits, exactly as for a full queue -- the wait costs no request.
    return new BufferError(
      `${BUFFER_EXHAUSTED}: Buffer's API limit is reached on all ${accounts} Buffer account(s) for ${domain} ` +
        '(HTTP 429, counted over 30 days); each one is asked again once a day. ' +
        `Add a token from another Buffer account to keep posting. Last reason: ${lastError}`,
    );
  }
  return new BufferError(
    `${BUFFER_EXHAUSTED}: all ${accounts} Buffer account(s) for ${domain} refused the ${what}. Last reason: ${lastError}`,
  );
}

/**
 * Buffer itself down (HTTP 5xx, "Service Unavailable"): not the account's
 * fault, so it is never a reason to rotate or to mark an account full. The
 * body of such a reply is an HTML page, whose words ("fully", "separate"…)
 * used to match the markers below and bench a healthy account for hours.
 */
export const isBufferOutage = (error: unknown): boolean =>
  /http 5\d\d|service (temporarily )?unavailable|bad gateway|gateway time-?out/i.test(errorMessage(error));

/**
 * Buffer refusing the shape of the request (an unknown field, a wrong type):
 * every account would refuse it the same way, so it is never a reason to call
 * an account full. Its text quotes the post back ("isAiGenerated" holds
 * "rate"), which used to match the markers above and bench an empty account.
 */
export const isSchemaError = (error: unknown): boolean =>
  /graphql error: (expected value of type|field "\w+" is not defined|unknown argument|cannot query field|enum "\w+" cannot represent|.* cannot represent)/i
    .test(errorMessage(error));

export const isRotatable = (error: unknown): boolean => {
  if (isBufferOutage(error) || isSchemaError(error)) return false;
  const text = errorMessage(error).toLowerCase();
  return ROTATE_ON.some((marker) => text.includes(marker));
};

/** Seconds between tries while Buffer is down; tests set it to 0. */
export const outageWait = { ms: 20_000 };

/** Try again, twice, when Buffer is briefly down, before giving up. */
async function throughOutage<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!isBufferOutage(err) || attempt >= 2) throw err;
      log.warn(`Buffer is unavailable (${errorMessage(err).slice(0, 80)}), trying again shortly`);
      await new Promise((r) => setTimeout(r, outageWait.ms * (attempt + 1)));
    }
  }
}

export interface BufferPoolSite {
  id: number;
  domain: string;
  /** Picks the right channel when an account exposes more than one. */
  pinUsername: string;
  /**
   * Which network this pool posts to. Accounts marked for the other network
   * are left out; accounts marked 'both' serve either. Unset: every account.
   */
  platform?: 'pinterest' | 'facebook' | 'instagram' | 'youtube' | 'tiktok';
  /**
   * One account of the site (Pinterest 2, Facebook 1...): only its Buffer
   * tokens are used, and `pinUsername` is the channel name to post to on any
   * network. Unset: every account of the platform, as before accounts existed.
   */
  profileId?: number;
  /**
   * `pinUsername` is the name of a page on another network (a reel's Facebook
   * page, while this pool posts its Instagram copy through the same Buffer
   * account): the account's single channel of this network is taken whatever
   * its name. See pickChannel.
   */
  otherNetworkName?: boolean;
}

/**
 * The channel of a network to post to: the one named, else the first.
 *
 * An account that names its page (Channels -> Accounts) means that page. When
 * the name matches none of the account's channels, "else the first" would
 * quietly post to some other page: with Post to all, every account whose name
 * was off by a letter piled onto the same one, as duplicates; and a Buffer
 * account holding a single page sent a reel shown as "ArbmomRecipes" to
 * whatever that page was, with nothing anywhere saying so. Either way it is an
 * error, naming the pages Buffer does have, so the name can be corrected. A
 * site not yet on accounts (`strict` false) never named its page for this
 * network, and a blank name names nothing, so both still take the first.
 *
 * `single`: the name is another network's (a reel's Facebook page, while this
 * is its Instagram), so it cannot be expected to match. The account's only
 * channel of the network is the one; with several, the name must pick one.
 */
function pickChannel<T extends { name: string }>(
  channels: T[],
  name: string,
  strict: boolean,
  network: string,
  accountLabel: string,
  single = false,
): T {
  const wanted = name.trim().toLowerCase();
  const named = wanted ? channels.find((c) => c.name.trim().toLowerCase() === wanted) : undefined;
  if (named) return named;
  const theirs = channels.map((c) => `"${c.name}"`).join(', ');
  if (single) {
    if (channels.length === 1) return channels[0]!;
    throw new BufferError(
      `No ${network} page named "${name.trim()}" on Buffer account "${accountLabel}", and it has ${channels.length} ${network} channels: ${theirs}. ` +
        `Add the right one as its own ${network} account in Channels -> Accounts, with the same Buffer token and its name exactly as Buffer shows it.`,
    );
  }
  if (wanted && strict) {
    throw new BufferError(
      `No ${network} page named "${name.trim()}" on Buffer account "${accountLabel}". ` +
        `Its pages: ${theirs}. ` +
        'Set the Buffer page name on this account to one of them, exactly as Buffer shows it.',
    );
  }
  return channels[0]!;
}

/**
 * Which accounts serve a network. Instagram has its own accounts first (a
 * token added under Channels -> Instagram), then the Facebook ones, since
 * many people connect Instagram in the same Buffer as the Page.
 */
function servesPlatform(account: BufferAccount, platform: BufferPoolSite['platform']): boolean {
  if (!platform) return true;
  if (platform === 'instagram') return account.platform !== 'pinterest';
  // YouTube and TikTok, like Instagram, are usually connected in the same
  // Buffer as the Page rather than in one of their own, so any non-Pinterest
  // account is worth trying; one without that channel is skipped at post time.
  if (platform === 'youtube' || platform === 'tiktok') return account.platform !== 'pinterest';
  return account.platform === 'both' || account.platform === platform;
}

/** Where a post is going: resolved per account, since ids do not carry over. */
export interface BufferDestination {
  channelId: string;
  /** The channel's name on Buffer: where the pin really went. */
  channelName?: string;
  boardServiceId: string;
  boardName: string;
}

export class BufferPool {
  private readonly accounts: BufferAccount[];
  private index = 0;

  constructor(
    private readonly site: BufferPoolSite,
    encryptionKey: Buffer,
    /** The site's own column, still the only account for a site with one. */
    legacyToken = '',
    now = new Date(),
  ) {
    const configured = listBufferAccounts(site.id, encryptionKey)
      .filter((a) => a.enabled && a.token.trim() !== '')
      .filter((a) => (site.profileId ? a.profileId === site.profileId : servesPlatform(a, site.platform)))
      // An account that refused recently goes last rather than being dropped:
      // if every account is full, posting through the least recently refused
      // one beats not posting at all, and Buffer decides either way.
      .sort((a, b) => {
        const fullA = a.fullUntil && a.fullUntil > now ? 1 : 0;
        const fullB = b.fullUntil && b.fullUntil > now ? 1 : 0;
        if (fullA !== fullB) return fullA - fullB;
        if (site.platform === 'instagram') {
          const ownA = a.platform === 'instagram' ? 0 : 1;
          const ownB = b.platform === 'instagram' ? 0 : 1;
          if (ownA !== ownB) return ownA - ownB;
        }
        return a.position - b.position;
      });

    this.accounts =
      configured.length > 0
        ? configured
        : legacyToken.trim() !== ''
          ? // No rows yet: a site added before rotation existed, or one whose
            // token was typed into the site form. Its single token still works.
            [
              {
                id: 0,
                siteId: site.id,
                label: 'Site token',
                token: legacyToken,
                position: 1,
                enabled: true,
                fullUntil: null,
                lastUsedAt: null,
                lastError: null,
                platform: 'both',
                profileId: null,
              },
            ]
          : [];
  }

  get size(): number {
    return this.accounts.length;
  }

  /** Which account is in use, for logs and for the run's step detail. */
  get current(): BufferAccount | undefined {
    return this.accounts[this.index];
  }

  private client(): BufferClient {
    const account = this.current;
    if (!account) {
      throw new BufferError(
        `No Buffer account is configured for ${this.site.domain}. Add one under Channels → Pinterest or Facebook.`,
      );
    }
    if (limitedNow(account)) {
      throw new BufferError(
        `${BUFFER_EXHAUSTED}: Buffer account "${account.label}" for ${this.site.domain} is over Buffer's API limit ` +
          `until ${account.fullUntil!.toISOString()}. Last reason: ${account.lastError ?? ''}`,
      );
    }
    return new BufferClient(account.token);
  }

  /**
   * A lookup refused for Buffer's API limit: the token sits out a day, and it
   * counts as the account refusing (sawFull), not as a channel missing.
   */
  private noteLimit(account: BufferAccount, message: string): boolean {
    if (!isBufferRateLimit(message)) return false;
    if (account.id > 0) markBufferAccountFull(account.id, message, new Date(Date.now() + LIMITED_FOR_MS));
    return true;
  }

  async getOrganizationId(): Promise<string> {
    return this.client().getOrganizationId();
  }

  async getChannels(organizationId: string): Promise<BufferChannel[]> {
    return this.client().getChannels(organizationId);
  }

  /**
   * The channel and board to post to on the account now in use.
   *
   * Ids belong to the account that issued them, so a rotation invalidates the
   * channel resolved before it. `preferBoard` carries the board the model
   * chose across by name, which is the only part of that choice that means
   * anything on a different account.
   */
  async resolveDestination(preferBoard: string | string[] = ''): Promise<BufferDestination> {
    const client = this.client();
    const all = await client.getChannels(await client.getOrganizationId());

    if (all.length === 0) {
      throw new BufferError('Buffer returned no channels for this organization');
    }

    // Pinterest only. The account that schedules this site's pins now also
    // holds the Facebook page the reels go to, and picking the first channel
    // of any network found that one and reported it as a Pinterest channel
    // with no boards — which is true, and says nothing about the real fault.
    const channels = all.filter((c) => c.service === '' || c.service === 'pinterest');

    if (channels.length === 0) {
      throw new BufferError(
        `None of this Buffer account's ${all.length} channel(s) is Pinterest. ` +
          'Connect a Pinterest profile, or turn Buffer publishing off.',
      );
    }

    const wanted = this.site.pinUsername.trim().toLowerCase();
    const channel = pickChannel(channels, this.site.pinUsername, this.site.profileId !== undefined, 'Pinterest', 'this account');

    if (channels.length > 1 && !wanted) {
      log.warn(
        `Buffer token for ${this.site.domain} exposes ${channels.length} channels and no ` +
          `Pinterest username is set; using "${channel.name}".`,
      );
    }

    if (channel.boards.length === 0) {
      throw new BufferError(`Buffer channel "${channel.name}" has no Pinterest boards`);
    }

    // Several names may be offered, best first: the first one this account
    // actually has wins, else its first board.
    const boardNames = (Array.isArray(preferBoard) ? preferBoard : [preferBoard])
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    const board =
      boardNames.map((name) => channel.boards.find((b) => b.name.toLowerCase() === name)).find(Boolean) ??
      channel.boards[0]!;

    return {
      channelId: channel.id,
      channelName: channel.name,
      boardServiceId: board.serviceId,
      boardName: board.name,
    };
  }

  /**
   * Schedule a pin, moving down the accounts while Buffer refuses.
   *
   * The caller passes the destination it resolved earlier. Every rotation
   * re-resolves it against the new account, because a channel id from one
   * account means nothing on another.
   */
  async createPost(
    input: {
      text: string;
      channelId: string;
      imageUrl: string;
      altText: string;
      title: string;
      linkUrl: string;
      boardServiceId: string;
    },
    boardName = '',
  ): Promise<{ postId: string; account: string; destination: BufferDestination }> {
    if (this.accounts.length === 0) {
      throw new BufferError(
        `No Buffer account is configured for ${this.site.domain}. Add one under Channels → Pinterest or Facebook.`,
      );
    }

    let destination: BufferDestination = {
      channelId: input.channelId,
      boardServiceId: input.boardServiceId,
      boardName,
    };
    let lastError = '';
    let sawFull = false; // an account turned the post itself down, not just had no channel

    for (; this.index < this.accounts.length; this.index++) {
      const account = this.accounts[this.index]!;
      if (limitedNow(account)) {
        lastError = account.lastError ?? 'Buffer API limit reached (HTTP 429)';
        sawFull = true;
        log.info(`Buffer account "${account.label}" is over Buffer's API limit until ${account.fullUntil!.toISOString()}; not asking it`);
        continue;
      }

      // Every account after the first needs its own channel and board: the
      // ones resolved for the previous account do not exist here.
      if (this.index > 0) {
        try {
          destination = await this.resolveDestination(boardName);
        } catch (err) {
          lastError = errorMessage(err);
          // Not full: it has no matching channel or board. Benching it for six
          // hours stopped it posting to the networks it does have.
          if (this.noteLimit(account, lastError)) sawFull = true;
          log.warn(`Buffer account "${account.label}" has no usable channel`, lastError);
          continue;
        }
      }

      try {
        const postId = await throughOutage(() => new BufferClient(account.token).createPost({
          ...input,
          channelId: destination.channelId,
          boardServiceId: destination.boardServiceId,
        }));

        if (account.id > 0) markBufferAccountUsed(account.id);
        return { postId, account: account.label, destination };
      } catch (err) {
        lastError = errorMessage(err);
        if (!isBufferRateLimit(lastError)) BufferClient.forget(account.token);

        // A rejection this pool cannot fix — a malformed post, an image Buffer
        // will not fetch — fails the same way on every account. Retrying it
        // five times would only spend five accounts saying so.
        if (!isRotatable(err)) throw err;
        sawFull = true;

        log.warn(
          `Buffer account "${account.label}" refused the post, moving to the next: ${lastError}`,
        );
        if (account.id > 0) {
          markBufferAccountFull(account.id, lastError, new Date(Date.now() + sitOutFor(lastError)));
        }
      }
    }

    throw refusedEverywhere(this.accounts.length, this.site.domain, 'post', lastError, sawFull);
  }

  /**
   * Schedule a reel as a Pinterest video pin, moving down the accounts while
   * Buffer refuses. The board is resolved on each account, preferring the one
   * the article's image pin went to.
   */
  async createVideoPin(
    input: { text: string; title: string; linkUrl: string; videoUrl: string },
    preferBoard: string | string[] = '',
  ): Promise<{ postId: string; account: string; destination: BufferDestination }> {
    if (this.accounts.length === 0) {
      throw new BufferError(`No Buffer account is configured for ${this.site.domain}. Add one under Channels → Pinterest.`);
    }
    let lastError = '';
    let sawFull = false; // an account turned the post itself down, not just had no channel
    for (; this.index < this.accounts.length; this.index++) {
      const account = this.accounts[this.index]!;
      if (limitedNow(account)) {
        lastError = account.lastError ?? 'Buffer API limit reached (HTTP 429)';
        sawFull = true;
        log.info(`Buffer account "${account.label}" is over Buffer's API limit until ${account.fullUntil!.toISOString()}; not asking it`);
        continue;
      }
      let destination: BufferDestination;
      try {
        destination = await this.resolveDestination(preferBoard);
      } catch (err) {
        lastError = errorMessage(err);
        if (this.noteLimit(account, lastError)) sawFull = true;
        log.warn(`Buffer account "${account.label}" has no usable Pinterest channel`, lastError);
        continue;
      }
      try {
        const postId = await throughOutage(() => new BufferClient(account.token).createVideoPin({
          ...input,
          channelId: destination.channelId,
          boardServiceId: destination.boardServiceId,
        }));
        if (account.id > 0) markBufferAccountUsed(account.id);
        return { postId, account: account.label, destination };
      } catch (err) {
        lastError = errorMessage(err);
        if (!isBufferRateLimit(lastError)) BufferClient.forget(account.token);
        if (!isRotatable(err)) throw err;
        sawFull = true;
        log.warn(`Buffer account "${account.label}" refused the video pin, moving to the next: ${lastError}`);
        if (account.id > 0) markBufferAccountFull(account.id, lastError, new Date(Date.now() + sitOutFor(lastError)));
      }
    }
    throw refusedEverywhere(this.accounts.length, this.site.domain, 'video pin', lastError, sawFull);
  }

  /**
   * Schedule a Facebook reel, moving down the accounts while Buffer refuses.
   *
   * The Facebook channel is resolved per account for the same reason a
   * Pinterest board is: a channel id belongs to the account that issued it.
   */
  /** Schedule an image post on the site's Facebook Page, moving down the accounts while Buffer refuses. */
  async createFacebookPost(input: { text: string; imageUrl: string; firstComment?: string }): Promise<{ postId: string; account: string; page: string }> {
    if (this.accounts.length === 0) {
      throw new BufferError(`No Buffer account is configured for ${this.site.domain}. Add one under Channels → Facebook.`);
    }
    let lastError = '';
    let sawFull = false; // an account turned the post itself down, not just had no channel
    for (; this.index < this.accounts.length; this.index++) {
      const account = this.accounts[this.index]!;
      if (limitedNow(account)) {
        lastError = account.lastError ?? 'Buffer API limit reached (HTTP 429)';
        sawFull = true;
        log.info(`Buffer account "${account.label}" is over Buffer's API limit until ${account.fullUntil!.toISOString()}; not asking it`);
        continue;
      }
      const client = new BufferClient(account.token);
      let channelId = '';
      let page = '';
      try {
        const channels = await client.getChannels(await client.getOrganizationId());
        const facebook = channels.filter((c) => c.service === 'facebook');
        if (facebook.length === 0) throw new BufferError(`Buffer account "${account.label}" has no Facebook channel (it has: ${[...new Set(channels.map((c) => c.service))].join(', ') || 'none'}).`);
        const picked = pickChannel(facebook, this.site.pinUsername, this.site.profileId !== undefined, 'Facebook', account.label, this.site.otherNetworkName);
        channelId = picked.id;
        page = picked.name;
      } catch (err) {
        lastError = errorMessage(err);
        if (this.noteLimit(account, lastError)) sawFull = true;
        log.warn(`Buffer account "${account.label}" has no usable Facebook channel`, lastError);
        continue;
      }
      try {
        const postId = await throughOutage(() => client.createFacebookImagePost({ ...input, channelId }));
        if (account.id > 0) markBufferAccountUsed(account.id);
        return { postId, account: account.label, page };
      } catch (err) {
        lastError = errorMessage(err);
        if (!isBufferRateLimit(lastError)) BufferClient.forget(account.token);
        if (!isRotatable(err)) throw err;
        sawFull = true;
        log.warn(`Buffer account "${account.label}" refused the Facebook post, moving to the next: ${lastError}`);
        if (account.id > 0) markBufferAccountFull(account.id, lastError, new Date(Date.now() + sitOutFor(lastError)));
      }
    }
    throw refusedEverywhere(this.accounts.length, this.site.domain, 'Facebook post', lastError, sawFull);
  }

  /** Schedule an Instagram post or reel, moving down the accounts while Buffer refuses. */
  async createInstagramPost(input: {
    text: string;
    type: 'post' | 'reel';
    imageUrl?: string;
    videoUrl?: string;
    firstComment?: string;
  }): Promise<{ postId: string; account: string; page: string }> {
    if (this.accounts.length === 0) {
      throw new BufferError(`No Buffer account is configured for ${this.site.domain}. Add one under Channels → Facebook.`);
    }
    let lastError = '';
    let sawFull = false; // an account turned the post itself down, not just had no channel
    for (; this.index < this.accounts.length; this.index++) {
      const account = this.accounts[this.index]!;
      if (limitedNow(account)) {
        lastError = account.lastError ?? 'Buffer API limit reached (HTTP 429)';
        sawFull = true;
        log.info(`Buffer account "${account.label}" is over Buffer's API limit until ${account.fullUntil!.toISOString()}; not asking it`);
        continue;
      }
      const client = new BufferClient(account.token);
      let channelId = '';
      let page = '';
      try {
        const channels = await client.getChannels(await client.getOrganizationId());
        const instagram = channels.filter((c) => c.service === 'instagram');
        if (instagram.length === 0) throw new BufferError(`Buffer account "${account.label}" has no Instagram channel (it has: ${[...new Set(channels.map((c) => c.service))].join(', ') || 'none'}).`);
        const picked = pickChannel(instagram, this.site.pinUsername, this.site.profileId !== undefined, 'Instagram', account.label, this.site.otherNetworkName);
        channelId = picked.id;
        page = picked.name;
      } catch (err) {
        lastError = errorMessage(err);
        if (this.noteLimit(account, lastError)) sawFull = true;
        log.warn(`Buffer account "${account.label}" has no usable Instagram channel`, lastError);
        continue;
      }
      try {
        const postId = await throughOutage(() => client.createInstagramPost({ ...input, channelId }));
        if (account.id > 0) markBufferAccountUsed(account.id);
        return { postId, account: account.label, page };
      } catch (err) {
        lastError = errorMessage(err);
        if (!isBufferRateLimit(lastError)) BufferClient.forget(account.token);
        if (!isRotatable(err)) throw err;
        sawFull = true;
        log.warn(`Buffer account "${account.label}" refused the Instagram ${input.type}, moving to the next: ${lastError}`);
        if (account.id > 0) markBufferAccountFull(account.id, lastError, new Date(Date.now() + sitOutFor(lastError)));
      }
    }
    throw refusedEverywhere(this.accounts.length, this.site.domain, `Instagram ${input.type}`, lastError, sawFull);
  }

  /** A YouTube Short, through whichever account still has room for one. */
  async createYouTubeShort(input: {
    title: string;
    text: string;
    videoUrl: string;
    category?: string;
  }): Promise<{ postId: string; account: string; page: string }> {
    if (this.accounts.length === 0) {
      throw new BufferError(`No Buffer account is configured for ${this.site.domain}. Add one under Channels → Accounts.`);
    }
    let lastError = '';
    let sawFull = false; // an account turned the post itself down, not just had no channel
    for (; this.index < this.accounts.length; this.index++) {
      const account = this.accounts[this.index]!;
      if (limitedNow(account)) {
        lastError = account.lastError ?? 'Buffer API limit reached (HTTP 429)';
        sawFull = true;
        log.info(`Buffer account "${account.label}" is over Buffer's API limit until ${account.fullUntil!.toISOString()}; not asking it`);
        continue;
      }
      const client = new BufferClient(account.token);
      let channelId = '';
      let page = '';
      try {
        const channels = await client.getChannels(await client.getOrganizationId());
        const youtube = channels.filter((c) => c.service === 'youtube');
        if (youtube.length === 0) throw new BufferError(`Buffer account "${account.label}" has no YouTube channel (it has: ${[...new Set(channels.map((c) => c.service))].join(', ') || 'none'}).`);
        const picked = pickChannel(youtube, this.site.pinUsername, this.site.profileId !== undefined, 'YouTube', account.label, this.site.otherNetworkName);
        channelId = picked.id;
        page = picked.name;
      } catch (err) {
        lastError = errorMessage(err);
        if (this.noteLimit(account, lastError)) sawFull = true;
        log.warn(`Buffer account "${account.label}" has no usable YouTube channel`, lastError);
        continue;
      }
      try {
        const postId = await throughOutage(() => client.createYouTubePost({ ...input, channelId }));
        if (account.id > 0) markBufferAccountUsed(account.id);
        return { postId, account: account.label, page };
      } catch (err) {
        lastError = errorMessage(err);
        if (!isBufferRateLimit(lastError)) BufferClient.forget(account.token);
        if (!isRotatable(err)) throw err;
        sawFull = true;
        log.warn(`Buffer account "${account.label}" refused the YouTube Short, moving to the next: ${lastError}`);
        if (account.id > 0) markBufferAccountFull(account.id, lastError, new Date(Date.now() + sitOutFor(lastError)));
      }
    }
    throw refusedEverywhere(this.accounts.length, this.site.domain, 'YouTube Short', lastError, sawFull);
  }

  /** A TikTok video, through whichever account still has room for one. */
  async createTikTokVideo(input: {
    text: string;
    videoUrl: string;
    privacyLevel?: string;
  }): Promise<{ postId: string; account: string; page: string }> {
    if (this.accounts.length === 0) {
      throw new BufferError(`No Buffer account is configured for ${this.site.domain}. Add one under Channels → Accounts.`);
    }
    let lastError = '';
    let sawFull = false; // an account turned the post itself down, not just had no channel
    for (; this.index < this.accounts.length; this.index++) {
      const account = this.accounts[this.index]!;
      if (limitedNow(account)) {
        lastError = account.lastError ?? 'Buffer API limit reached (HTTP 429)';
        sawFull = true;
        log.info(`Buffer account "${account.label}" is over Buffer's API limit until ${account.fullUntil!.toISOString()}; not asking it`);
        continue;
      }
      const client = new BufferClient(account.token);
      let channelId = '';
      let page = '';
      try {
        const channels = await client.getChannels(await client.getOrganizationId());
        const tiktok = channels.filter((c) => c.service === 'tiktok');
        if (tiktok.length === 0) throw new BufferError(`Buffer account "${account.label}" has no TikTok channel (it has: ${[...new Set(channels.map((c) => c.service))].join(', ') || 'none'}).`);
        const picked = pickChannel(tiktok, this.site.pinUsername, this.site.profileId !== undefined, 'TikTok', account.label, this.site.otherNetworkName);
        channelId = picked.id;
        page = picked.name;
      } catch (err) {
        lastError = errorMessage(err);
        if (this.noteLimit(account, lastError)) sawFull = true;
        log.warn(`Buffer account "${account.label}" has no usable TikTok channel`, lastError);
        continue;
      }
      try {
        const postId = await throughOutage(() => client.createTikTokPost({ ...input, channelId }));
        if (account.id > 0) markBufferAccountUsed(account.id);
        return { postId, account: account.label, page };
      } catch (err) {
        lastError = errorMessage(err);
        if (!isBufferRateLimit(lastError)) BufferClient.forget(account.token);
        if (!isRotatable(err)) throw err;
        sawFull = true;
        log.warn(`Buffer account "${account.label}" refused the TikTok video, moving to the next: ${lastError}`);
        if (account.id > 0) markBufferAccountFull(account.id, lastError, new Date(Date.now() + sitOutFor(lastError)));
      }
    }
    throw refusedEverywhere(this.accounts.length, this.site.domain, 'TikTok video', lastError, sawFull);
  }

  async createReel(input: {
    text: string;
    videoUrl: string;
    firstComment?: string;
    title?: string;
  }): Promise<{ postId: string; account: string; channelId: string; page: string }> {
    if (this.accounts.length === 0) {
      throw new BufferError(
        `No Buffer account is configured for ${this.site.domain}. Add one under Channels → Pinterest or Facebook.`,
      );
    }

    let lastError = '';
    let sawFull = false; // an account turned the post itself down, not just had no channel

    for (; this.index < this.accounts.length; this.index++) {
      const account = this.accounts[this.index]!;
      if (limitedNow(account)) {
        lastError = account.lastError ?? 'Buffer API limit reached (HTTP 429)';
        sawFull = true;
        log.info(`Buffer account "${account.label}" is over Buffer's API limit until ${account.fullUntil!.toISOString()}; not asking it`);
        continue;
      }
      const client = new BufferClient(account.token);

      let channelId = '';
      let pageName = '';

      try {
        const organizationId = await client.getOrganizationId();
        const channels = await client.getChannels(organizationId);
        const facebook = channels.filter((c) => c.service === 'facebook');

        if (facebook.length === 0) {
          throw new BufferError(
            `Buffer account "${account.label}" has no Facebook channel. ` +
              'Connect the Page to Buffer first.',
          );
        }

        const page = pickChannel(facebook, this.site.pinUsername, this.site.profileId !== undefined, 'Facebook', account.label, this.site.otherNetworkName);
        channelId = page.id;
        pageName = page.name;

        if (facebook.length > 1 && !this.site.pinUsername.trim()) {
          log.warn(
            `Buffer account "${account.label}" has ${facebook.length} Facebook channels; ` +
              `using "${page.name}". Name the page on the account to choose another.`,
          );
        }
      } catch (err) {
        lastError = errorMessage(err);
        if (this.noteLimit(account, lastError)) sawFull = true;
        log.warn(`Buffer account "${account.label}" has no usable Facebook channel`, lastError);
        continue;
      }

      try {
        const postId = await throughOutage(() => client.createReel({ ...input, channelId }));

        if (account.id > 0) markBufferAccountUsed(account.id);
        return { postId, account: account.label, channelId, page: pageName };
      } catch (err) {
        lastError = errorMessage(err);
        if (!isBufferRateLimit(lastError)) BufferClient.forget(account.token);

        // A video Buffer will not fetch, or a reel over its length limit,
        // fails identically on every account. Spending five accounts to hear
        // the same refusal five times helps nobody.
        if (!isRotatable(err)) throw err;
        sawFull = true;

        log.warn(
          `Buffer account "${account.label}" refused the reel, moving to the next: ${lastError}`,
        );
        if (account.id > 0) {
          markBufferAccountFull(account.id, lastError, new Date(Date.now() + sitOutFor(lastError)));
        }
      }
    }

    throw refusedEverywhere(this.accounts.length, this.site.domain, 'reel', lastError, sawFull);
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    if (this.accounts.length === 0) return { ok: false, error: 'No Buffer account configured' };
    return this.client().healthCheck();
  }
}
