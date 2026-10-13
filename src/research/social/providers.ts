import { createLogger, errorMessage } from '../../lib/logger.js';
import { normalizeApify, normalizeBrightData, pageUrl, usable, type SocialPost } from './facebook.js';
import type { Settings } from '../../settings.js';

const log = createLogger('radar-provider');

/**
 * Where the posts come from.
 *
 * Both services read public Facebook pages and both cost money past a free
 * allowance, so which one is in use is a setting rather than a rewrite. The
 * radar only ever sees this interface; everything provider-shaped stops here.
 */
export interface SocialProvider {
  readonly name: ProviderName;
  /** The most recent posts of one page, newest first as the provider returns them. */
  fetchPosts(handle: string, limit: number): Promise<SocialPost[]>;
}

export type ProviderName = 'brightdata' | 'apify';

/** Where the number of the token in use is kept, so the next scan goes on from it. */
export interface TokenState {
  get(): number;
  set(index: number): void;
}

/** Several tokens in one field, separated however they were pasted — as the Serper keys are. */
export const splitTokens = (raw: string | undefined): string[] =>
  (raw ?? '').split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);

/**
 * A refusal that means "this token is spent or not allowed", not "that page
 * does not exist".
 *
 * The distinction is the whole point: rotating on a spent token moves to the
 * next account, while rotating on a missing page would spend every token you
 * own on the same dead handle.
 */
const TOKEN_SPENT = /HTTP (401|402|403|429)|credit|quota|limit|balance|not enough|unauthori[sz]ed|invalid.*(token|key)|insufficient/i;

export const isTokenSpent = (err: unknown): boolean => TOKEN_SPENT.test(errorMessage(err));

const asRecords = (body: unknown): Record<string, unknown>[] => {
  const list = Array.isArray(body) ? body : Array.isArray((body as { items?: unknown })?.items) ? (body as { items: unknown[] }).items : [];
  return list.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
};

async function asJson(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`${what}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
  }
  return response.json();
}

/* -------------------------------------------------------------------------
 * Bright Data
 * ---------------------------------------------------------------------- */

/** Their "Facebook — page posts, discover by username" dataset. */
export const BRIGHTDATA_DATASET = 'gd_lkaxegm826bjpoo9m5';

const BRIGHTDATA_API = 'https://api.brightdata.com/datasets/v3';

/**
 * Bright Data collects asynchronously: a trigger returns a snapshot id, the
 * snapshot becomes ready some minutes later, and only then can it be read.
 *
 * The radar runs once a day on a timer with nobody waiting, so polling to the
 * end here is simpler than a second state machine in the database. The ceiling
 * keeps a stuck snapshot from holding the daily tick open forever.
 */
export class BrightDataProvider implements SocialProvider {
  readonly name = 'brightdata' as const;

  constructor(
    private readonly token: string,
    private readonly options: { pollMs?: number; maxPolls?: number } = {},
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  async fetchPosts(handle: string, limit: number): Promise<SocialPost[]> {
    if (!this.token.trim()) throw new Error('no Bright Data token saved (Setup → Radar)');

    const triggered = (await asJson(
      await fetch(`${BRIGHTDATA_API}/trigger?dataset_id=${BRIGHTDATA_DATASET}&include_errors=true`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ input: [{ user_name: handle }], limit_per_input: limit }),
        signal: AbortSignal.timeout(30_000),
      }),
      'Bright Data trigger',
    )) as { snapshot_id?: string };

    const snapshot = triggered.snapshot_id;
    if (!snapshot) throw new Error('Bright Data returned no snapshot id');

    const pollMs = this.options.pollMs ?? 10_000;
    const maxPolls = this.options.maxPolls ?? 60;

    for (let attempt = 0; attempt < maxPolls; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const progress = (await asJson(
        await fetch(`${BRIGHTDATA_API}/progress/${snapshot}`, { headers: this.headers(), signal: AbortSignal.timeout(20_000) }),
        'Bright Data progress',
      )) as { status?: string; error_message?: string };

      if (progress.status === 'ready') {
        const body = await asJson(
          await fetch(`${BRIGHTDATA_API}/snapshot/${snapshot}?format=json`, { headers: this.headers(), signal: AbortSignal.timeout(60_000) }),
          'Bright Data snapshot',
        );
        return asRecords(body).map(normalizeBrightData).filter(usable);
      }
      if (progress.status === 'failed' || progress.status === 'canceled') {
        throw new Error(`Bright Data ${progress.status}${progress.error_message ? `: ${progress.error_message}` : ''}`);
      }
    }
    throw new Error(`Bright Data snapshot ${snapshot} was still running after ${Math.round((pollMs * maxPolls) / 60_000)} minutes`);
  }
}

/* -------------------------------------------------------------------------
 * Apify
 * ---------------------------------------------------------------------- */

export const APIFY_ACTOR = 'apify~facebook-posts-scraper';

/**
 * Apify runs the actor and hands back the dataset in one call, which is why
 * it is the easier of the two to start with and the one that charges by
 * compute rather than by record.
 */
export class ApifyProvider implements SocialProvider {
  readonly name = 'apify' as const;

  constructor(
    private readonly token: string,
    private readonly actor: string = APIFY_ACTOR,
  ) {}

  async fetchPosts(handle: string, limit: number): Promise<SocialPost[]> {
    if (!this.token.trim()) throw new Error('no Apify token saved (Setup → Radar)');

    const body = await asJson(
      await fetch(`https://api.apify.com/v2/acts/${this.actor}/run-sync-get-dataset-items?token=${encodeURIComponent(this.token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startUrls: [{ url: pageUrl(handle) }], resultsLimit: limit }),
        // The actor runs while the request is open, so this waits as long as
        // one page of posts plausibly takes.
        signal: AbortSignal.timeout(300_000),
      }),
      'Apify run',
    );
    return asRecords(body).map(normalizeApify).filter(usable);
  }
}

/* -------------------------------------------------------------------------
 * Several tokens, used in turn
 * ---------------------------------------------------------------------- */

/**
 * One provider per token, tried in turn until one answers.
 *
 * Built exactly as the Serper keys are, and for the same reason: a free
 * allowance is per account, so several accounts are several allowances. It
 * starts from the token that last worked rather than from the first, so a
 * spent token is not retried at the top of every scan for the rest of the
 * month.
 *
 * Only a spent-or-refused token moves to the next. Anything else — a page that
 * does not exist, a provider outage, a timeout — is raised at once, because
 * trying the same dead handle with every token you own is how a free
 * allowance disappears in one morning.
 *
 * For Bright Data this retries from the trigger: its snapshot belongs to the
 * account that asked for it, so a second token could not read the first one's
 * collection even if it were handed the id.
 */
export class RotatingProvider implements SocialProvider {
  constructor(
    readonly name: ProviderName,
    private readonly workers: SocialProvider[],
    private readonly state?: TokenState,
  ) {}

  async fetchPosts(handle: string, limit: number): Promise<SocialPost[]> {
    if (this.workers.length === 0) throw new Error(`no ${this.name === 'apify' ? 'Apify' : 'Bright Data'} token saved (Radar → Setup)`);
    const start = Math.max(0, this.state?.get() ?? 0) % this.workers.length;
    let lastError: unknown;
    for (let step = 0; step < this.workers.length; step++) {
      const index = (start + step) % this.workers.length;
      try {
        const posts = await this.workers[index]!.fetchPosts(handle, limit);
        if (index !== start) {
          this.state?.set(index);
          log.info(`${this.name}: token ${start + 1} spent, now using token ${index + 1} of ${this.workers.length}`);
        }
        return posts;
      } catch (err) {
        lastError = err;
        if (!isTokenSpent(err)) throw err;
      }
    }
    throw new Error(`all ${this.workers.length} ${this.name} token(s) are spent or refused — last: ${errorMessage(lastError)}`);
  }
}

/* -------------------------------------------------------------------------
 * Which one is in use
 * ---------------------------------------------------------------------- */

/** The number of the token in use, kept in settings so the next scan goes on from it. */
export const tokenStateIn = (settings: Settings, provider: ProviderName): TokenState => ({
  get: () => Number(settings.get(`${provider}_token_index`)) || 0,
  set: (index: number) => settings.set(`${provider}_token_index`, String(index)),
});

export function providerFrom(settings: Settings): SocialProvider {
  const chosen = settings.get('radar_provider').trim().toLowerCase();
  if (chosen && chosen !== 'brightdata' && chosen !== 'apify') log.warn(`unknown radar provider "${chosen}", using Bright Data`);
  const name: ProviderName = chosen === 'apify' ? 'apify' : 'brightdata';
  const tokens = splitTokens(settings.get(`${name}_token`));
  const workers = tokens.map((token) => (name === 'apify' ? new ApifyProvider(token) : new BrightDataProvider(token)));
  return new RotatingProvider(name, workers, tokenStateIn(settings, name));
}

/** How many tokens are saved for each service, for the setup page to show. */
export const tokenCounts = (settings: Settings): { brightdata: number; apify: number } => ({
  brightdata: splitTokens(settings.get('brightdata_token')).length,
  apify: splitTokens(settings.get('apify_token')).length,
});

export const postsPerPageFrom = (settings: Settings): number =>
  Math.min(100, Math.max(5, Number(settings.get('radar_posts_per_page')) || 25));

export const minScoreFrom = (settings: Settings): number => Math.max(0, Number(settings.get('radar_min_score')) || 0);
