import { halalOnly, haramWord } from '../core/halal.js';
import { all, fromBool, get, run, toBool, transaction } from './index.js';
import type { Decision, KeywordView, LinkView, SiteView } from '../core/types.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { DishIndex } from '../core/similar-title.js';

/* =========================================================================
 * Sites
 * ====================================================================== */

export interface SiteRow {
  id: number;
  name: string;
  domain: string;
  status: 'active' | 'paused';
  pin_username: string;
  /** Pin each published article (the image pin). */
  pin_posts: number;
  /** Pin each reel as a Pinterest video pin. */
  pin_reels: number;
  /** Channels -> Instagram: post each article's photo / each reel. */
  ig_posts?: number;
  ig_reels?: number;
  /** The board a pin goes to when no board fits it. */
  pin_default_board: string;
  /** Topic group -> board, one "group = Board" per line. */
  pin_board_map: string;
  /** JSON of the last Suggest boards answer, shown on the Pinterest page. */
  pin_board_suggestions: string;
  auto_research_on?: number;
  auto_research_niche?: string;
  auto_research_recipes?: number;
  auto_research_questions?: number;
  auto_research_ttl_hours?: number;
  auto_research_hour?: number;
  auto_research_last_day?: string;
  auto_research_history?: string;
  auto_research_report?: string;
  project_id: string;
  /** Why it is paused, written down so it is still knowable next week. */
  paused_reason: string;
  /** When the pause lifts by itself. Null means "until someone says". */
  paused_until: string | null;
  /** 0 holds every article for a person to read before it is published. */
  auto_publish: number;
  /** "us" or "uk": the spelling and units this site is written in. */
  writing_style?: string;
  api_token_encrypted: string;
  buffer_token_encrypted: string;
  daily_target: number;
  interval_minutes: number;
  /** Upper end of the gap range; 0 or not above interval_minutes = a fixed gap. */
  interval_max_minutes?: number;
  created_at: string;
  updated_at: string;
}

/** A site's credentials, decrypted for use. Never logged, never rendered. */
export interface SiteSecrets {
  apiToken: string;
  bufferToken: string;
}

export function siteSecrets(site: SiteRow, key: Buffer): SiteSecrets {
  const safely = (value: string): string => {
    try {
      return decrypt(value, key);
    } catch {
      // A credential encrypted under a different key should surface as a
      // clear auth failure at call time, not crash page rendering.
      return '';
    }
  };
  return {
    apiToken: safely(site.api_token_encrypted),
    bufferToken: safely(site.buffer_token_encrypted),
  };
}

/**
 * Mark the running pipeline as still alive.
 *
 * Lives here rather than in the scheduler so the pipeline can call it without
 * importing the scheduler that runs it. See the stall watchdog in
 * src/scheduler/index.ts for what reads it.
 */
export function touchSchedulerLock(): void {
  run("UPDATE scheduler_lock SET heartbeat_at = datetime('now') WHERE id = 1");
}

/* -- Buffer accounts ------------------------------------------------------ */

/**
 * The Buffer accounts a site may post through, in the order they are tried.
 *
 * One site, several Buffer accounts: a Buffer queue takes ten posts a day and
 * then refuses, and a site publishing more than that needs somewhere else to
 * put them. Position decides the order; the pipeline moves down the list when
 * Buffer refuses and keeps the run going. See src/integrations/buffer-pool.ts.
 */
export interface BufferAccountRow {
  id: number;
  site_id: number;
  label: string;
  token_encrypted: string;
  position: number;
  enabled: number;
  full_until: string | null;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
  /** Which network this account posts to: 'pinterest', 'facebook', or 'both'. */
  platform: BufferPlatform;
  /** The channel account (Pinterest 1, Facebook 2...) this Buffer token belongs to. */
  profile_id: number | null;
}

export type BufferPlatform = 'pinterest' | 'facebook' | 'instagram' | 'youtube' | 'tiktok' | 'both';

export interface BufferAccount {
  id: number;
  siteId: number;
  label: string;
  token: string;
  position: number;
  enabled: boolean;
  fullUntil: Date | null;
  lastUsedAt: string | null;
  lastError: string | null;
  platform: BufferPlatform;
  profileId: number | null;
}

/** How many Buffer tokens one site may hold, across all its accounts. */
export const BUFFER_ACCOUNT_LIMIT = 40;

/* -- Channel accounts (Pinterest 1, Pinterest 2, Facebook 1...) ---------- */

export type ProfilePlatform = 'pinterest' | 'facebook' | 'instagram' | 'youtube' | 'tiktok';

export interface ChannelProfile {
  id: number;
  site_id: number;
  platform: ProfilePlatform;
  position: number;
  label: string;
  channel_name: string;
  /** The channel's name on Buffer, when it differs from `channel_name`. Blank: `channel_name`. */
  buffer_channel: string;
  default_board: string;
  board_map: string;
  board_suggestions: string;
  enabled: number;
  last_used_at: string | null;
  turn: number;
  /** Pinterest and Instagram: this account takes the article posts / the reels. 1 unless unticked on its card. */
  posts?: number;
  reels?: number;
}

/** What an account is asked to carry: an article's post, or a reel. */
export type ProfileKind = 'posts' | 'reels';

/**
 * Whether an account takes this kind of post. Facebook keeps the choice on its
 * page (fb_pages), YouTube and TikTok only ever take reels, so for those the
 * account's own switch is all there is.
 */
export const takes = (profile: Pick<ChannelProfile, 'platform' | 'posts' | 'reels'>, kind: ProfileKind): boolean =>
  profile.platform === 'facebook' || profile.platform === 'youtube' || profile.platform === 'tiktok'
    ? true
    : (profile[kind] ?? 1) !== 0;

/** The SQL twin of takes(), on alias p. */
const takesSql = (platform: ProfilePlatform, kind?: ProfileKind): string =>
  kind && (platform === 'pinterest' || platform === 'instagram') ? ` AND p.${kind} = 1` : '';

/**
 * Set an account's own Posts and Reels ticks, then the site's network switch
 * to match: on while any account of the network takes that kind. Every check
 * that reads the site's switch keeps working, and the accounts decide.
 */
export function setProfileKinds(id: number, posts: boolean, reels: boolean): void {
  const profile = getProfile(id);
  if (!profile || (profile.platform !== 'pinterest' && profile.platform !== 'instagram')) return;
  run('UPDATE channel_profiles SET posts = ?, reels = ? WHERE id = ?', posts ? 1 : 0, reels ? 1 : 0, id);
  syncSiteKinds(profile.site_id, profile.platform);
}

function syncSiteKinds(siteId: number, platform: 'pinterest' | 'instagram'): void {
  const any = (kind: ProfileKind) =>
    // Only an account that is switched on counts: one turned off with its
    // ticks still set used to leave the site's switch on, so the site kept
    // making pin graphics and reels for an account that publishes nothing.
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM channel_profiles WHERE site_id = ? AND platform = ? AND enabled = 1 AND ${kind} = 1`, siteId, platform)?.n ? 1 : 0;
  const [postsCol, reelsCol] = platform === 'pinterest' ? ['pin_posts', 'pin_reels'] : ['ig_posts', 'ig_reels'];
  run(`UPDATE sites SET ${postsCol} = ?, ${reelsCol} = ?, updated_at = datetime('now') WHERE id = ?`, any('posts'), any('reels'), siteId);
}

/** The name to look for among Buffer's channels: its own field when filled, else the account's name. */
export const bufferChannelName = (profile: Pick<ChannelProfile, 'channel_name' | 'buffer_channel'>): string =>
  (profile.buffer_channel ?? '').trim() || profile.channel_name;

export const listProfiles = (siteId: number, platform?: ProfilePlatform): ChannelProfile[] =>
  platform
    ? all<ChannelProfile>('SELECT * FROM channel_profiles WHERE site_id = ? AND platform = ? ORDER BY position, id', siteId, platform)
    : all<ChannelProfile>('SELECT * FROM channel_profiles WHERE site_id = ? ORDER BY platform, position, id', siteId);

export const getProfile = (id: number): ChannelProfile | undefined =>
  get<ChannelProfile>('SELECT * FROM channel_profiles WHERE id = ?', id);

const PLATFORM_NAME: Record<ProfilePlatform, string> = { pinterest: 'Pinterest', facebook: 'Facebook', instagram: 'Instagram', youtube: 'Youtube', tiktok: 'TikTok' };

/**
 * Add the next account of a network to a site. A new Pinterest account starts
 * with the first one's boards (same general board, same group -> board lines),
 * so only its username and Buffer token are left to fill.
 */
export function addProfile(siteId: number, platform: ProfilePlatform, options: { off?: boolean } = {}): number {
  const existing = listProfiles(siteId, platform);
  const position = (existing.at(-1)?.position ?? 0) + 1;
  const first = existing[0];
  // `off`: what a person adding an account from the interface gets -- switched
  // off with Posts and Reels unticked, so it publishes nothing (and spends no
  // image generations on pins) until its owner turns it on.
  const on = options.off ? 0 : 1;
  run(
    `INSERT INTO channel_profiles (site_id, platform, position, label, default_board, board_map, enabled, posts, reels)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    siteId, platform, position, `${PLATFORM_NAME[platform]} ${position}`,
    platform === 'pinterest' ? first?.default_board ?? '' : '',
    platform === 'pinterest' ? first?.board_map ?? '' : '',
    on, on, on,
  );
  return get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0;
}

/**
 * A site just added from the interface: every network off. Pinterest and
 * Instagram posts and reels unticked on the site too (a new site row starts
 * with Pinterest posts on), and account 1 of each network made switched off.
 */
export function startSiteOff(siteId: number): void {
  run(
    "UPDATE sites SET pin_posts = 0, pin_reels = 0, ig_posts = 0, ig_reels = 0, updated_at = datetime('now') WHERE id = ?",
    siteId,
  );
  for (const platform of ['pinterest', 'facebook', 'instagram', 'youtube', 'tiktok'] as const) {
    firstProfile(siteId, platform, { off: true });
  }
}

/** The first account of a network, made when a site has none yet. */
export function firstProfile(siteId: number, platform: ProfilePlatform, options: { off?: boolean } = {}): ChannelProfile {
  const found = listProfiles(siteId, platform)[0];
  if (found) return found;
  return getProfile(addProfile(siteId, platform, options))!;
}

export function updateProfile(
  id: number,
  fields: Partial<Pick<ChannelProfile, 'label' | 'channel_name' | 'buffer_channel' | 'default_board' | 'board_map' | 'board_suggestions' | 'enabled'>>,
): void {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (!keys.length) return;
  run(
    `UPDATE channel_profiles SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    ...keys.map((k) => fields[k] as string | number), id,
  );
  // Turning an account on or off changes what its site makes.
  if ('enabled' in fields) {
    const profile = getProfile(id);
    if (profile && (profile.platform === 'pinterest' || profile.platform === 'instagram')) {
      syncSiteKinds(profile.site_id, profile.platform);
    }
  }
}

/** Remove an account and its Buffer tokens. The last one of a network stays (its settings are the site's). */
export function deleteProfile(id: number): boolean {
  const profile = getProfile(id);
  if (!profile || listProfiles(profile.site_id, profile.platform).length <= 1) return false;
  run('DELETE FROM buffer_accounts WHERE profile_id = ?', id);
  run('DELETE FROM channel_profiles WHERE id = ?', id);
  return true;
}

/**
 * The next account of a network for this site, in turn: the one used longest
 * ago (never used first), among those switched on that have a Buffer token.
 * Marked used now, so the next article goes to the one after.
 */
export function pickProfile(siteId: number, platform: ProfilePlatform, kind?: ProfileKind): ChannelProfile | undefined {
  const usable = all<ChannelProfile>(
    `SELECT p.* FROM channel_profiles p
      WHERE p.site_id = ? AND p.platform = ? AND p.enabled = 1${takesSql(platform, kind)}
        AND EXISTS (SELECT 1 FROM buffer_accounts b WHERE b.profile_id = p.id AND b.enabled = 1 AND b.token_encrypted <> '')
      ORDER BY p.turn, p.position, p.id`,
    siteId, platform,
  );
  // Nothing usable: the account that takes this kind, else the first, so the
  // run has something to carry -- every route then checks it before sending.
  const chosen = usable[0] ?? listProfiles(siteId, platform).find((p) => !kind || takes(p, kind)) ?? listProfiles(siteId, platform)[0];
  if (chosen) takeTurn(chosen);
  return chosen;
}

/** An account has had its turn: it goes to the back of the queue. */
function takeTurn(profile: ChannelProfile): void {
  run(
    `UPDATE channel_profiles SET last_used_at = datetime('now'),
       turn = (SELECT COALESCE(MAX(turn), 0) + 1 FROM channel_profiles WHERE site_id = ? AND platform = ?)
     WHERE id = ?`,
    profile.site_id, profile.platform, profile.id,
  );
}

/**
 * The Pinterest account a run's keyword asks for (it came from that account's
 * Pinterest ideas), when that account can take this kind of post now:
 * switched on, the kind ticked, a Buffer token in use. Otherwise none, and
 * the run takes the turn like any other.
 */
function preferredPinterest(runId: number, siteId: number, kind: ProfileKind): ChannelProfile | undefined {
  const wanted = get<{ id: number | null }>(
    `SELECT ks.pin_profile_id AS id FROM runs r
       JOIN keyword_sites ks ON ks.keyword_id = r.keyword_id AND ks.site_id = r.site_id
      WHERE r.id = ?`,
    runId,
  )?.id;
  if (!wanted) return undefined;
  return usableProfiles(siteId, 'pinterest', kind).find((p) => p.id === wanted);
}

/* -- Rotate, or post to every account ------------------------------------ */

/**
 * Whether a site sends each post on a network to every one of its accounts
 * there, rather than to one in turn. Off, the rotation every site had: one
 * account per article. Channels -> Accounts sets it per network.
 */
export function postsToAll(siteId: number, platform: ProfilePlatform): boolean {
  const value = get<{ v: string }>('SELECT post_to_all AS v FROM sites WHERE id = ?', siteId)?.v ?? '';
  return value.split(',').map((x) => x.trim()).includes(platform);
}

export function setPostToAll(siteId: number, platform: ProfilePlatform, on: boolean): void {
  const value = get<{ v: string }>('SELECT post_to_all AS v FROM sites WHERE id = ?', siteId)?.v ?? '';
  const set = new Set(value.split(',').map((x) => x.trim()).filter(Boolean));
  if (on) set.add(platform);
  else set.delete(platform);
  run('UPDATE sites SET post_to_all = ? WHERE id = ?', [...set].sort().join(','), siteId);
}

/** A site's accounts on a network that can post: switched on, with a Buffer token switched on. */
export const usableProfiles = (siteId: number, platform: ProfilePlatform, kind?: ProfileKind): ChannelProfile[] =>
  all<ChannelProfile>(
    `SELECT p.* FROM channel_profiles p
      WHERE p.site_id = ? AND p.platform = ? AND p.enabled = 1${takesSql(platform, kind)}
        AND EXISTS (SELECT 1 FROM buffer_accounts b WHERE b.profile_id = p.id AND b.enabled = 1 AND b.token_encrypted <> '')
      ORDER BY p.position, p.id`,
    siteId, platform,
  );

/**
 * Every account one run posts to on a network, the run's own first.
 *
 * In rotation that is the one account chosen for the run — exactly what
 * runProfile always returned. Posting to all, the others follow it. The
 * run's own stays first and keeps its place in the turn, so switching the
 * mode back and forth never moves an article to a different account.
 * `undefined` stands for a site with no accounts yet, which posts through its
 * own Buffer token as before accounts existed.
 */
export function runTargets(runId: number | null, siteId: number, platform: ProfilePlatform, kind: ProfileKind = 'posts'): (ChannelProfile | undefined)[] {
  const own = runProfile(runId, siteId, platform, kind);
  if (!postsToAll(siteId, platform)) return [own];
  const others = usableProfiles(siteId, platform, kind).filter((p) => p.id !== own?.id);
  return [own, ...others];
}

/**
 * What a run already posted under one purpose, by account (0 for a site with
 * no accounts). `purpose` is usually a platform ('pinterest', 'instagram'),
 * but 'facebook' covers two different steps (the article post and the photo
 * collage) that must not be mistaken for one another, so each uses its own
 * purpose key instead of the bare platform name.
 */
export function fanoutPosted(runId: number | null, purpose: string): Record<string, string> {
  if (!runId) return {};
  try {
    const all = JSON.parse(get<{ f: string | null }>('SELECT fanout_json AS f FROM runs WHERE id = ?', runId)?.f || '{}') as Record<string, Record<string, string>>;
    return all[purpose] ?? {};
  } catch {
    return {};
  }
}

/**
 * Record one post the moment it is scheduled — not at the end of the step — so
 * a failure on the third account leaves the first two recorded, and the retry
 * posts only to the third.
 */
export function markFanoutPosted(runId: number | null, purpose: string, profileId: number, postId: string): void {
  if (!runId) return;
  let all: Record<string, Record<string, string>> = {};
  try {
    all = JSON.parse(get<{ f: string | null }>('SELECT fanout_json AS f FROM runs WHERE id = ?', runId)?.f || '{}');
  } catch {
    all = {};
  }
  all[purpose] = { ...(all[purpose] ?? {}), [String(profileId)]: postId };
  run('UPDATE runs SET fanout_json = ? WHERE id = ?', JSON.stringify(all), runId);
}

/** The account of a network a run uses: chosen once, then the same on resume and for its reel. */
export function runProfile(runId: number | null, siteId: number, platform: ProfilePlatform, kind: ProfileKind = 'posts'): ChannelProfile | undefined {
  if (!runId) return pickProfile(siteId, platform, kind);
  let chosen: Record<string, number> = {};
  try {
    chosen = JSON.parse(get<{ p: string }>('SELECT profiles_json AS p FROM runs WHERE id = ?', runId)?.p || '{}');
  } catch {
    chosen = {};
  }
  const own = (key: string) => {
    const saved = chosen[key] ? getProfile(chosen[key]!) : undefined;
    return saved && saved.site_id === siteId ? saved : undefined;
  };
  // The article's account carries the reel too when it takes reels, as every
  // run did before accounts had their own ticks; otherwise the reel gets one
  // of its own, chosen once and kept under "<network>:reels".
  const article = own(platform);
  if (article && takes(article, kind)) return article;
  const key = kind === 'posts' ? platform : `${platform}:reels`;
  const saved = key === platform ? undefined : own(key);
  if (saved) return saved;
  // A keyword from Pinterest ideas pins to the account the idea came from,
  // which counts as that account's turn so the others keep their share.
  const preferred = platform === 'pinterest' ? preferredPinterest(runId, siteId, kind) : undefined;
  if (preferred) takeTurn(preferred);
  const picked = preferred ?? pickProfile(siteId, platform, kind);
  if (picked) {
    chosen[key] = picked.id;
    run('UPDATE runs SET profiles_json = ? WHERE id = ?', JSON.stringify(chosen), runId);
  }
  return picked;
}

export const listBufferAccountRows = (siteId: number): BufferAccountRow[] =>
  all<BufferAccountRow>(
    'SELECT * FROM buffer_accounts WHERE site_id = ? ORDER BY position, id',
    siteId,
  );

export function listBufferAccounts(siteId: number, key: Buffer): BufferAccount[] {
  return listBufferAccountRows(siteId).map((row) => {
    let token = '';
    try {
      token = decrypt(row.token_encrypted, key);
    } catch {
      // Same reasoning as siteSecrets: an unreadable credential should fail at
      // call time as an auth error, not while rendering a page.
    }
    return {
      id: row.id,
      siteId: row.site_id,
      label: row.label,
      token,
      position: row.position,
      enabled: row.enabled === 1,
      fullUntil: row.full_until ? new Date(row.full_until) : null,
      lastUsedAt: row.last_used_at,
      lastError: row.last_error,
      platform: (row.platform ?? 'both') as BufferPlatform,
      profileId: row.profile_id ?? null,
    };
  });
}

/**
 * Add or update one account.
 *
 * A blank token on update means "keep the stored one", matching how every
 * other credential field in this app behaves.
 */
export function upsertBufferAccount(
  input: { siteId: number; label: string; token: string; enabled: boolean; platform?: BufferPlatform; profileId?: number },
  key: Buffer,
  id?: number,
): number {
  const existing = id
    ? get<BufferAccountRow>('SELECT * FROM buffer_accounts WHERE id = ?', id)
    : undefined;

  if (existing) {
    const encrypted =
      input.token.trim() !== '' ? encrypt(input.token.trim(), key) : existing.token_encrypted;
    run(
      'UPDATE buffer_accounts SET label = ?, token_encrypted = ?, enabled = ?, platform = ? WHERE id = ?',
      input.label.trim() || existing.label,
      encrypted,
      input.enabled ? 1 : 0,
      input.platform ?? existing.platform ?? 'both',
      existing.id,
    );
    return existing.id;
  }

  const count = listBufferAccountRows(input.siteId).length;
  if (count >= BUFFER_ACCOUNT_LIMIT) {
    throw new Error(`A site can hold at most ${BUFFER_ACCOUNT_LIMIT} Buffer accounts.`);
  }
  if (input.token.trim() === '') {
    throw new Error('A new Buffer account needs a token.');
  }

  const next =
    (get<{ n: number }>(
      'SELECT COALESCE(MAX(position), 0) AS n FROM buffer_accounts WHERE site_id = ?',
      input.siteId,
    )?.n ?? 0) + 1;

  // Every token belongs to an account of the site: the one named, else the
  // first account of its network (made if the site has none yet).
  const profile = input.profileId
    ? getProfile(input.profileId)
    : firstProfile(input.siteId, input.platform && input.platform !== 'both' ? input.platform : 'pinterest');
  run(
    `INSERT INTO buffer_accounts (site_id, label, token_encrypted, position, enabled, platform, profile_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.siteId,
    input.label.trim() || `Account ${next}`,
    encrypt(input.token.trim(), key),
    next,
    input.enabled ? 1 : 0,
    profile?.platform ?? input.platform ?? 'both',
    profile?.id ?? null,
  );

  return get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0;
}

/** The Pinterest profile a site's pins go to, set on Channels -> Pinterest. */
export interface BoardPlan {
  boards: { group: string; name: string; description: string; exists?: boolean }[];
  general: { name: string; description: string; exists?: boolean } | null;
}

/** Topic groups of the keywords that publish on a site, most used first, with example titles. */
export const siteTopicGroups = (siteId: number, limit = 15): { group: string; examples: string[] }[] =>
  all<{ seed_keyword: string; n: number; examples: string }>(
    `SELECT k.seed_keyword, COUNT(*) AS n,
            GROUP_CONCAT(CASE WHEN trim(k.spy_title) <> '' THEN k.spy_title END, ' | ') AS examples
       FROM keywords k JOIN keyword_sites ks ON ks.keyword_id = k.id
      WHERE ks.site_id = ? AND trim(k.seed_keyword) <> ''
      GROUP BY lower(k.seed_keyword) ORDER BY n DESC LIMIT ?`,
    siteId,
    limit,
  ).map((r) => ({ group: r.seed_keyword, examples: (r.examples ?? '').split(' | ').filter(Boolean).slice(0, 4) }));

export interface AccountName { display: string; username: string; tagline: string; bio: string }

/** The names last suggested for a new Pinterest account of a site ('' = none shown). */
export const getAccountNameSuggestions = (siteId: number): AccountName[] => {
  const row = get<{ pin_name_suggestions: string }>('SELECT pin_name_suggestions FROM sites WHERE id = ?', siteId);
  try { return row?.pin_name_suggestions ? (JSON.parse(row.pin_name_suggestions) as AccountName[]) : []; } catch { return []; }
};

export const setAccountNameSuggestions = (siteId: number, names: AccountName[]): void => {
  run('UPDATE sites SET pin_name_suggestions = ? WHERE id = ?', names.length ? JSON.stringify(names) : '', siteId);
};

export const setBoardSuggestions = (siteId: number, plan: BoardPlan | null): void => {
  run('UPDATE sites SET pin_board_suggestions = ? WHERE id = ?', plan ? JSON.stringify(plan) : '', siteId);
};

export const setPinterestBoards = (siteId: number, defaultBoard: string, map: string): void => {
  run("UPDATE sites SET pin_default_board = ?, pin_board_map = ?, updated_at = datetime('now') WHERE id = ?",
    defaultBoard.trim(), map.trim(), siteId);
};

/** "dessert = Desserts" lines, as a lower-cased group -> board name map. */
export function parseBoardMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of (text ?? '').split(/\r?\n/)) {
    const i = line.search(/[=→>]/);
    if (i < 1) continue;
    const group = line.slice(0, i).trim().toLowerCase();
    const board = line.slice(i + 1).replace(/^[=>\s]+/, '').trim();
    if (group && board) map.set(group, board);
  }
  return map;
}

export const setPinterestPublishing = (siteId: number, posts: boolean, reels: boolean): void => {
  run("UPDATE sites SET pin_posts = ?, pin_reels = ?, updated_at = datetime('now') WHERE id = ?",
    posts ? 1 : 0, reels ? 1 : 0, siteId);
  // The network's switch from an older page: every account follows it.
  run("UPDATE channel_profiles SET posts = ?, reels = ? WHERE site_id = ? AND platform = 'pinterest'", posts ? 1 : 0, reels ? 1 : 0, siteId);
};

export const setInstagramPublishing = (siteId: number, posts: boolean, reels: boolean): void => {
  run("UPDATE sites SET ig_posts = ?, ig_reels = ?, updated_at = datetime('now') WHERE id = ?",
    posts ? 1 : 0, reels ? 1 : 0, siteId);
  // The network's switch from an older page: every account follows it.
  run("UPDATE channel_profiles SET posts = ?, reels = ? WHERE site_id = ? AND platform = 'instagram'", posts ? 1 : 0, reels ? 1 : 0, siteId);
};

export const setPinUsername = (siteId: number, username: string): void => {
  run("UPDATE sites SET pin_username = ?, updated_at = datetime('now') WHERE id = ?", username.trim(), siteId);
};

export const deleteBufferAccount = (id: number): void => {
  run('DELETE FROM buffer_accounts WHERE id = ?', id);
};

/**
 * Take an account out of rotation until `until`.
 *
 * Buffer does not say when a queue empties, so the caller picks the horizon —
 * see FULL_FOR_MS in the pool. Recorded rather than inferred so the site page
 * can say which account is full and why, instead of a run failing silently.
 */
export function markBufferAccountFull(id: number, error: string, until: Date): void {
  run(
    `UPDATE buffer_accounts SET full_until = ?, last_error = ?, last_used_at = datetime('now')
     WHERE id = ?`,
    until.toISOString(),
    error.slice(0, 500),
    id,
  );
}

export function markBufferAccountUsed(id: number): void {
  run(
    `UPDATE buffer_accounts SET full_until = NULL, last_error = NULL,
       last_used_at = datetime('now')
     WHERE id = ?`,
    id,
  );
}

/** True when a secret column holds something, without decrypting it. */
export const hasSecret = (value: string): boolean => value.trim() !== '';

export const listSites = (): SiteRow[] =>
  all<SiteRow>('SELECT * FROM sites ORDER BY name');

export const getSite = (id: number): SiteRow | undefined =>
  get<SiteRow>('SELECT * FROM sites WHERE id = ?', id);

export const getSiteByDomain = (domain: string): SiteRow | undefined =>
  get<SiteRow>('SELECT * FROM sites WHERE domain = ?', domain);

export interface SiteInput {
  name: string;
  domain: string;
  status: 'active' | 'paused';
  /** Left undefined, the stored value is kept: it is set on Channels -> Pinterest now. */
  pin_username?: string;
  /** Left undefined, the stored value is kept: Flow projects belong to Google accounts now. */
  project_id?: string;
  daily_target: number;
  interval_minutes: number;
  /** Upper end of the gap range. Left undefined, the stored value is kept; 0 = fixed gap. */
  interval_max_minutes?: number;
  /** Left undefined, the stored value is kept — these are not on every form. */
  paused_reason?: string;
  paused_until?: string | null;
  auto_publish?: boolean;
  /** Left undefined, the stored value is kept; a new site starts as "fr". */
  writing_style?: 'fr' | 'us' | 'uk';
  /** Plaintext. Blank on update means "keep the stored one". */
  apiToken?: string;
  bufferToken?: string;
}

/**
 * Create or update a site.
 *
 * `id` identifies the row when supplied, so the domain can be renamed. Without
 * it the domain is the key, which is what CSV import needs.
 */
export function upsertSite(input: SiteInput, key: Buffer, id?: number): number {
  const existing = id ? getSite(id) : getSiteByDomain(input.domain);

  const encryptOrKeep = (plain: string | undefined, stored: string): string =>
    plain && plain.trim() !== '' ? encrypt(plain.trim(), key) : stored;

  if (existing) {
    run(
      `UPDATE sites SET name = ?, domain = ?, status = ?, pin_username = ?,
         project_id = ?, daily_target = ?, interval_minutes = ?, interval_max_minutes = ?,
         paused_reason = ?, paused_until = ?, auto_publish = ?, writing_style = ?,
         api_token_encrypted = ?, buffer_token_encrypted = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
      input.name,
      input.domain,
      input.status,
      input.pin_username ?? existing.pin_username,
      input.project_id ?? existing.project_id,
      input.daily_target,
      input.interval_minutes,
      input.interval_max_minutes ?? existing.interval_max_minutes ?? 0,
      // An active site holds no pause reason. Leaving one behind means the
      // Sites page explains a pause that is not in effect.
      input.status === 'active' ? '' : (input.paused_reason ?? existing.paused_reason),
      input.status === 'active' ? null : (input.paused_until ?? existing.paused_until),
      input.auto_publish === undefined
        ? existing.auto_publish
        : fromBool(input.auto_publish),
      input.writing_style ?? existing.writing_style ?? 'fr',
      encryptOrKeep(input.apiToken, existing.api_token_encrypted),
      encryptOrKeep(input.bufferToken, existing.buffer_token_encrypted),
      existing.id,
    );
    return existing.id;
  }

  return run(
    `INSERT INTO sites (name, domain, status, pin_username, project_id,
       daily_target, interval_minutes, interval_max_minutes, paused_reason, paused_until, auto_publish,
       writing_style, api_token_encrypted, buffer_token_encrypted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.domain,
    input.status,
    input.pin_username ?? '',
    input.project_id ?? '',
    input.daily_target,
    input.interval_minutes,
    input.interval_max_minutes ?? 0,
    input.status === 'active' ? '' : (input.paused_reason ?? ''),
    input.status === 'active' ? null : (input.paused_until ?? null),
    fromBool(input.auto_publish ?? true),
    // French edition: a site added from here on is written in French (metric)
    // unless it is told otherwise.
    input.writing_style ?? 'fr',
    encryptOrKeep(input.apiToken, ''),
    encryptOrKeep(input.bufferToken, ''),
  ).lastInsertRowid;
}

/** Delete several sites at once; returns how many were removed. */
export const bulkDeleteSites = (ids: number[]): number => {
  if (ids.length === 0) return 0;
  return transaction(() => {
    let removed = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      removed += run(`DELETE FROM sites WHERE id IN (${placeholders(chunk)})`, ...chunk).changes;
    }
    return removed;
  });
};

export const deleteSite = (id: number): void => {
  run('DELETE FROM sites WHERE id = ?', id);
};

/**
 * Build the selector's view of every site.
 *
 * publishedToday and lastPublishAt are computed here rather than stored.
 * That is the structural reason the counter bugs of the previous system
 * (string arithmetic, lost updates, midnight reset drift) cannot recur.
 * `dayKey` is the local calendar day, supplied by the caller.
 */
export function loadSiteViews(dayKey: string, timezone: string): SiteView[] {
  interface Row extends SiteRow {
    published_today: number;
    last_publish_at: string | null;
    last_attempt_at: string | null;
  }

  const rows = all<Row>(
    `SELECT s.*,
            (SELECT COUNT(*) FROM runs r
              WHERE r.site_id = s.id
                AND r.status = 'published'
                AND date(r.published_at, ?) = ?)          AS published_today,
            (SELECT MAX(r2.published_at) FROM runs r2
              WHERE r2.site_id = s.id
                AND r2.status = 'published')              AS last_publish_at,
            -- Every run, not just the successful ones: this is what makes the
            -- sites take turns even when one of them keeps failing.
            (SELECT MAX(r3.started_at) FROM runs r3
              WHERE r3.site_id = s.id)                    AS last_attempt_at
       FROM sites s
      ORDER BY s.name`,
    tzModifier(timezone),
    dayKey,
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    domain: r.domain,
    status: r.status,
    dailyTarget: r.daily_target,
    intervalMinutes: r.interval_minutes,
    intervalMaxMinutes: r.interval_max_minutes ?? 0,
    publishedToday: Number(r.published_today ?? 0),
    lastPublishAt: r.last_publish_at,
    lastAttemptAt: r.last_attempt_at,
  }));
}

/**
 * SQLite cannot resolve IANA timezones, so we pass a fixed offset modifier
 * computed in JS for the current instant. This is accurate for deciding
 * which calendar day a timestamp belongs to.
 */
export function tzModifier(timezone: string, at: Date = new Date()): string {
  const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  const local = new Date(at.toLocaleString('en-US', { timeZone: timezone }));
  const minutes = Math.round((local.getTime() - utc.getTime()) / 60_000);
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/* =========================================================================
 * Keywords and the keyword x site matrix
 * ====================================================================== */

export interface KeywordRow {
  id: number;
  seed_keyword: string;
  spy_title: string;
  spy_description: string;
  spy_image_url: string;
  spy_article_url: string;
  spy_pin_image: string;
  annotation: string;
  /** The cook's own recipe for this dish, pasted as written. Blank: none given. */
  cook_recipe: string;
  /** A few lines from the cook: what went wrong, what they swapped, who liked it. */
  cook_notes: string;
  /** Readers' tips waiting for the cook, as JSON; '' when none. */
  cook_suggestions?: string;
  status: 'go' | 'done' | 'no';
  created_at: string;
  updated_at: string;
}

export const listKeywords = (limit = 500, offset = 0): KeywordRow[] =>
  all<KeywordRow>('SELECT * FROM keywords ORDER BY id LIMIT ? OFFSET ?', limit, offset);

export const countKeywords = (): number =>
  get<{ n: number }>('SELECT COUNT(*) AS n FROM keywords')?.n ?? 0;

export const getKeyword = (id: number): KeywordRow | undefined =>
  get<KeywordRow>('SELECT * FROM keywords WHERE id = ?', id);

export function insertKeyword(k: Partial<KeywordRow> & { seed_keyword: string }): number {
  return run(
    `INSERT INTO keywords (seed_keyword, spy_title, spy_description, spy_image_url,
       spy_article_url, spy_pin_image, annotation, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    k.seed_keyword,
    k.spy_title ?? '',
    k.spy_description ?? '',
    k.spy_image_url ?? '',
    k.spy_article_url ?? '',
    k.spy_pin_image ?? '',
    k.annotation ?? '',
    k.status ?? 'go',
  ).lastInsertRowid;
}

/**
 * Keywords pasted one per line: each line is the recipe the article will be
 * about, filed under one topic group, switched on and set to publish on the
 * chosen sites. A title already present (any case) is skipped, so pasting the
 * same list twice adds nothing.
 */
/** Every keyword's title and keyword-level status, with the sites it is on (go or done). */
function keywordTitlesWithSites(): { id: number; title: string; status: string; sites: Set<number> }[] {
  const rows = all<{ id: number; t: string; status: string }>(
    "SELECT id, CASE WHEN trim(spy_title) <> '' THEN spy_title ELSE seed_keyword END AS t, status FROM keywords",
  );
  const sites = new Map<number, Set<number>>();
  for (const l of all<{ keyword_id: number; site_id: number }>(
    "SELECT keyword_id, site_id FROM keyword_sites WHERE status IN ('go', 'done')",
  )) {
    const set = sites.get(l.keyword_id) ?? new Set<number>();
    set.add(l.site_id);
    sites.set(l.keyword_id, set);
  }
  return rows.map((r) => ({ id: r.id, title: r.t, status: r.status, sites: sites.get(r.id) ?? new Set() }));
}

/**
 * What keyword research should treat as a repeat for these sites.
 *
 * `here`: on every one of the sites already (or turned down for all sites), so
 * there is nothing left to add. `elsewhere`: on other sites only -- still free
 * for these, shown with where it already runs. With no sites given, every
 * keyword counts as here.
 */
export function researchRepeats(siteIds: number[]): { here: string[]; elsewhere: { title: string; where: string }[] } {
  const domains = new Map(all<{ id: number; domain: string }>('SELECT id, domain FROM sites').map((s) => [s.id, s.domain]));
  const here: string[] = [];
  const elsewhere: { title: string; where: string }[] = [];
  for (const k of keywordTitlesWithSites()) {
    if (siteIds.length === 0 || k.status === 'no' || siteIds.every((s) => k.sites.has(s))) {
      here.push(k.title);
      continue;
    }
    const where = [...k.sites].filter((s) => !siteIds.includes(s)).map((s) => domains.get(s)).filter(Boolean);
    if (where.length) elsewhere.push({ title: k.title, where: where.join(', ') });
  }
  return { here, elsewhere };
}

/**
 * Add keywords one per line to the ticked sites.
 *
 * A repeat is judged per site: a keyword (or the same dish) already on other
 * sites only is linked to the ticked ones that lack it -- one keyword, one
 * article per site, each with its own images -- instead of being skipped.
 * It is skipped only when every ticked site has it already.
 */
export function addPastedKeywords(
  lines: string[],
  seedKeyword: string,
  siteIds: number[],
  options: { auto?: boolean; pinProfileId?: number } = {},
): { added: number; linked: number; skipped: number; similar: string[] } {
  const seed = seedKeyword.trim().toLowerCase();
  const known = keywordTitlesWithSites();
  const byTitle = new Map(known.map((k) => [k.title.trim().toLowerCase(), k]));
  const dishes = new DishIndex(known.map((k) => k.title));
  const similar: string[] = [];
  let added = 0;
  let linked = 0;
  let skipped = 0;
  const link = (keywordId: number, siteId: number) => {
    setLink(keywordId, siteId, 'go');
    // From a Pinterest idea: its pin goes to the account the idea came from.
    if (options.pinProfileId) {
      run('UPDATE keyword_sites SET pin_profile_id = ? WHERE keyword_id = ? AND site_id = ?', options.pinProfileId, keywordId, siteId);
    }
    if (options.auto) {
      run("UPDATE keyword_sites SET auto_added_at = datetime('now') WHERE keyword_id = ? AND site_id = ?", keywordId, siteId);
    }
  };
  transaction(() => {
    for (const raw of lines) {
      const title = raw.replace(/^[\s\-*•\d.)]+/, '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (title.length < 3) {
        if (raw.trim() !== '') skipped++;
        continue;
      }
      const twin = byTitle.has(title.toLowerCase()) ? null : dishes.find(title);
      const match = byTitle.get(title.toLowerCase()) ?? (twin ? byTitle.get(twin.trim().toLowerCase()) : undefined);
      if (match) {
        const missing = match.status === 'no' ? [] : siteIds.filter((s) => !match.sites.has(s));
        if (missing.length === 0) {
          skipped++;
          if (twin) similar.push(`“${title}” ≈ “${twin}”`);
          continue;
        }
        for (const siteId of missing) {
          link(match.id, siteId);
          match.sites.add(siteId);
        }
        // Finished on its other sites: open it again for the new ones.
        if (match.status === 'done') {
          setKeywordStatus(match.id, 'go');
          match.status = 'go';
        }
        linked++;
        continue;
      }
      const haram = halalOnly() ? haramWord(`${title} ${seed}`) : null;
      if (haram) {
        skipped++;
        similar.push(`“${title}” refused: ${haram} (Halal only)`);
        continue;
      }
      const id = insertKeyword({ seed_keyword: seed, spy_title: title, status: 'go' });
      if (options.auto) run("UPDATE keywords SET auto_added_at = datetime('now') WHERE id = ?", id);
      for (const siteId of siteIds) link(id, siteId);
      const entry = { id, title, status: 'go', sites: new Set(siteIds) };
      byTitle.set(title.toLowerCase(), entry);
      dishes.add(title);
      added++;
    }
  });
  return { added, linked, skipped, similar };
}

export const setKeywordStatus = (id: number, status: 'go' | 'done' | 'no'): void => {
  run("UPDATE keywords SET status = ?, updated_at = datetime('now') WHERE id = ?", status, id);
};

/** Save what the cook wrote for a keyword. Imports never touch these two fields. */
export const setKeywordCook = (id: number, recipe: string, notes: string): void => {
  run(
    "UPDATE keywords SET cook_recipe = ?, cook_notes = ?, updated_at = datetime('now') WHERE id = ?",
    recipe.trim(),
    notes.trim(),
    id,
  );
};

/** Replace the tips waiting for the cook. */
export const setKeywordCookSuggestions = (id: number, json: string): void => {
  run("UPDATE keywords SET cook_suggestions = ?, updated_at = datetime('now') WHERE id = ?", json, id);
};

/** Add one approved tip to the cook's notes, on its own line. */
export const appendKeywordCookNote = (id: number, line: string): void => {
  run(
    `UPDATE keywords SET cook_notes = CASE WHEN TRIM(cook_notes) = '' THEN ? ELSE cook_notes || char(10) || ? END,
       updated_at = datetime('now') WHERE id = ?`,
    line.trim(),
    line.trim(),
    id,
  );
};

export const deleteKeyword = (id: number): void => {
  run('DELETE FROM keywords WHERE id = ?', id);
};

export const loadKeywordViews = (): KeywordView[] =>
  all<KeywordRow>('SELECT * FROM keywords ORDER BY id').map((r) => ({
    id: r.id,
    seedKeyword: r.seed_keyword,
    spyTitle: r.spy_title,
    status: r.status,
  }));

/** When each topic group last ran on each site (any outcome), for the selector's turn-taking. */
export function loadGroupLastUsed(): Map<string, number> {
  const rows = all<{ site_id: number; grp: string; last: string }>(
    `SELECT r.site_id, lower(trim(k.seed_keyword)) AS grp, MAX(r.started_at) AS last
       FROM runs r JOIN keywords k ON k.id = r.keyword_id
      WHERE r.site_id IS NOT NULL
      GROUP BY r.site_id, lower(trim(k.seed_keyword))`,
  );
  const map = new Map<string, number>();
  for (const r of rows) {
    const ms = Date.parse(r.last.includes('T') ? r.last : r.last.replace(' ', 'T') + 'Z');
    if (!Number.isNaN(ms)) map.set(`${r.site_id}|${r.grp}`, ms);
  }
  return map;
}

export const loadLinkViews = (): LinkView[] =>
  all<{
    keyword_id: number;
    site_id: number;
    status: 'go' | 'done' | 'no';
    blocked_at: string | null;
  }>('SELECT keyword_id, site_id, status, blocked_at FROM keyword_sites').map((r) => ({
    keywordId: r.keyword_id,
    siteId: r.site_id,
    status: r.status,
    blocked: r.blocked_at !== null,
  }));

/* -- Pairs that keep failing ---------------------------------------------- */

/**
 * How many times this pair has failed since it last got anywhere.
 *
 * Derived from the runs table rather than kept in a counter: a counter has to
 * be incremented in every failure path and reset in every success path, and
 * the first one anybody forgets makes it lie. The runs are the record, so the
 * count is a question asked of them.
 *
 * "Got anywhere" is deliberately wider than published: a run held for approval
 * proves the pair can produce an article, which is the thing being doubted.
 */
export const consecutiveFailuresForPair = (keywordId: number, siteId: number): number =>
  get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM runs
      WHERE keyword_id = ? AND site_id = ? AND status = 'failed'
        AND id > COALESCE(
              (SELECT MAX(id) FROM runs
                WHERE keyword_id = ? AND site_id = ? AND status <> 'failed'),
              0)`,
    keywordId,
    siteId,
    keywordId,
    siteId,
  )?.n ?? 0;

/** Take a pair out of the running, with the reason on the record. */
export const blockLink = (keywordId: number, siteId: number, reason: string): void => {
  run(
    `UPDATE keyword_sites
        SET blocked_at = datetime('now'), blocked_reason = ?, updated_at = datetime('now')
      WHERE keyword_id = ? AND site_id = ?`,
    reason.slice(0, 500),
    keywordId,
    siteId,
  );
};

export const unblockLink = (keywordId: number, siteId: number): void => {
  run(
    `UPDATE keyword_sites
        SET blocked_at = NULL, blocked_reason = NULL, updated_at = datetime('now')
      WHERE keyword_id = ? AND site_id = ?`,
    keywordId,
    siteId,
  );
};

/** Put every held-back pair back in the running. Returns how many. */
export const unblockAllLinks = (): number =>
  run(
    `UPDATE keyword_sites
        SET blocked_at = NULL, blocked_reason = NULL, updated_at = datetime('now')
      WHERE blocked_at IS NOT NULL`,
  ).changes;

export interface BlockedPair {
  keywordId: number;
  siteId: number;
  seedKeyword: string;
  domain: string;
  blockedAt: string;
  blockedReason: string;
}

/** Everything currently held back, for the page that has to show it. */
export const listBlockedPairs = (): BlockedPair[] =>
  all<{
    keyword_id: number;
    site_id: number;
    seed_keyword: string;
    domain: string;
    blocked_at: string;
    blocked_reason: string;
  }>(
    `SELECT ks.keyword_id, ks.site_id, k.seed_keyword, s.domain,
            ks.blocked_at, ks.blocked_reason
       FROM keyword_sites ks
       JOIN keywords k ON k.id = ks.keyword_id
       JOIN sites    s ON s.id = ks.site_id
      WHERE ks.blocked_at IS NOT NULL
      ORDER BY ks.blocked_at DESC`,
  ).map((r) => ({
    keywordId: r.keyword_id,
    siteId: r.site_id,
    seedKeyword: r.seed_keyword,
    domain: r.domain,
    blockedAt: r.blocked_at,
    blockedReason: r.blocked_reason ?? '',
  }));

export const setLink = (
  keywordId: number,
  siteId: number,
  status: 'go' | 'done' | 'no',
): void => {
  run(
    // Image sharing is off unless turned on for the link: each article makes its own.
    `INSERT INTO keyword_sites (keyword_id, site_id, status, share_images)
     VALUES (?, ?, ?, 0)
     ON CONFLICT (keyword_id, site_id)
       DO UPDATE SET status = excluded.status, updated_at = datetime('now')`,
    keywordId,
    siteId,
    status,
  );
};

export const getLinksForKeyword = (keywordId: number) =>
  all<{
    site_id: number;
    status: string;
    domain: string;
    blocked_at: string | null;
    blocked_reason: string | null;
  }>(
    `SELECT ks.site_id, ks.status, s.domain, ks.blocked_at, ks.blocked_reason
       FROM keyword_sites ks JOIN sites s ON s.id = ks.site_id
      WHERE ks.keyword_id = ? ORDER BY s.name`,
    keywordId,
  );

/**
 * The grid the keywords page renders: status and image sharing for every pair.
 *
 * Separate from loadLinkViews on purpose. That one feeds selectTask, whose
 * input type stays as small as the decision it makes — sharing has no bearing
 * on whether a keyword may run.
 */
export const loadLinkGrid = (): {
  keywordId: number;
  siteId: number;
  status: 'go' | 'done' | 'no';
  shareImages: boolean;
}[] =>
  all<{ keyword_id: number; site_id: number; status: 'go' | 'done' | 'no'; share_images: number }>(
    'SELECT keyword_id, site_id, status, share_images FROM keyword_sites',
  ).map((r) => ({
    keywordId: r.keyword_id,
    siteId: r.site_id,
    status: r.status,
    shareImages: r.share_images === 1,
  }));

export const getLinkShare = (keywordId: number, siteId: number): boolean =>
  get<{ share_images: number }>(
    'SELECT share_images FROM keyword_sites WHERE keyword_id = ? AND site_id = ?',
    keywordId,
    siteId,
  )?.share_images === 1;

export const setLinkShareImages = (keywordId: number, siteId: number, share: boolean): void => {
  run(
    `INSERT INTO keyword_sites (keyword_id, site_id, status, share_images)
     VALUES (?, ?, 'no', ?)
     ON CONFLICT (keyword_id, site_id)
       DO UPDATE SET share_images = excluded.share_images, updated_at = datetime('now')`,
    keywordId,
    siteId,
    share ? 1 : 0,
  );
};

/** The "share all" control: one keyword, every site it is linked to. */
export const setKeywordShareImages = (keywordId: number, share: boolean): void => {
  run(
    `UPDATE keyword_sites SET share_images = ?, updated_at = datetime('now')
      WHERE keyword_id = ?`,
    share ? 1 : 0,
    keywordId,
  );
};

/* =========================================================================
 * Shared article images
 *
 * One row per keyword, holding the public URL of each of the four article
 * images. The first site to publish a keyword writes it; every later site
 * reads it and copies the files into its own media library.
 * ====================================================================== */

/**
 * The four article photographs a keyword's other sites copy.
 *
 * The column names are the old ones — feature_url, top_shot_url and the
 * rest — because they are storage, not meaning, and renaming them would cost
 * a migration to say the same thing. What each one holds is the hero
 * photograph and the three shots of the method.
 */
export interface SharedImageUrls {
  hero: string;
  stepA: string;
  stepB: string;
  stepC: string;
}

export const getSharedImages = (keywordId: number): SharedImageUrls | undefined => {
  const row = get<{
    feature_url: string;
    top_shot_url: string;
    texture_macro_url: string;
    before_after_url: string;
  }>(
    `SELECT feature_url, top_shot_url, texture_macro_url, before_after_url
       FROM keyword_images WHERE keyword_id = ?`,
    keywordId,
  );

  return row
    ? {
        hero: row.feature_url,
        stepA: row.top_shot_url,
        stepB: row.texture_macro_url,
        stepC: row.before_after_url,
      }
    : undefined;
};

/** The title and hero photograph of a run's article, for a link card. */
export const recipeCardForRun = (runId: number | null): { title: string; imageUrl: string } | undefined => {
  if (!runId) return undefined;
  const row = get<{ title: string; keyword_id: number | null }>(
    'SELECT title, keyword_id FROM runs WHERE id = ?',
    runId,
  );
  if (!row?.title) return undefined;
  const hero = row.keyword_id ? getSharedImages(row.keyword_id)?.hero : undefined;
  return { title: row.title, imageUrl: hero ?? '' };
};

export const saveSharedImages = (
  keywordId: number,
  sourceSiteId: number,
  urls: SharedImageUrls,
): void => {
  run(
    `INSERT INTO keyword_images
       (keyword_id, feature_url, top_shot_url, texture_macro_url, before_after_url, source_site_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (keyword_id) DO UPDATE SET
       feature_url       = excluded.feature_url,
       top_shot_url      = excluded.top_shot_url,
       texture_macro_url = excluded.texture_macro_url,
       before_after_url  = excluded.before_after_url,
       source_site_id    = excluded.source_site_id,
       created_at        = datetime('now')`,
    keywordId,
    urls.hero,
    urls.stepA,
    urls.stepB,
    urls.stepC,
    sourceSiteId,
  );
};

export const clearSharedImages = (keywordId: number): void => {
  run('DELETE FROM keyword_images WHERE keyword_id = ?', keywordId);
};

/* =========================================================================
 * Runs and steps
 * ====================================================================== */

export interface RunRow {
  id: number;
  /** 'ok' written with Google research, 'none' without it, '' before the step. */
  research?: string;
  keyword_id: number | null;
  site_id: number | null;
  status: 'running' | 'published' | 'failed' | 'cancelled';
  started_at: string;
  finished_at: string | null;
  published_at: string | null;
  post_id: string | null;
  post_url: string | null;
  error: string | null;
  failed_step: string | null;
  mode: 'live' | 'dry';
  hold: '' | 'awaiting' | 'dry';
  attempts: number;
  retry_after: string | null;
  title: string;
  /** Which rotation this run drew, so a page can say what it was written in. */
  article_structure_id?: number | null;
  photo_style_id?: number | null;
  pin_design_id?: number | null;
}

export const createRun = (
  keywordId: number,
  siteId: number,
  mode: 'live' | 'dry' = 'live',
): number =>
  run(
    "INSERT INTO runs (keyword_id, site_id, status, mode) VALUES (?, ?, 'running', ?)",
    keywordId,
    siteId,
    mode,
  ).lastInsertRowid;

export const getRun = (id: number): RunRow | undefined =>
  get<RunRow>('SELECT * FROM runs WHERE id = ?', id);

export const markRunPublished = (
  id: number,
  postId: string,
  postUrl: string,
  title = '',
): void => {
  run(
    `UPDATE runs SET status = 'published', published_at = datetime('now'),
       finished_at = datetime('now'), post_id = ?, post_url = ?,
       error = NULL, failed_step = NULL, hold = '', retry_after = NULL,
       title = CASE WHEN ? = '' THEN title ELSE ? END
     WHERE id = ?`,
    postId,
    postUrl,
    title,
    title,
    id,
  );
};

/**
 * Stop a run short of publishing, on purpose.
 *
 * `cancelled` rather than `failed`: nothing went wrong, and counting a held
 * article as a failure would put it in the dashboard's failure count and in
 * every "this site is broken" heuristic built on top of it. Resume is what
 * releases it, and resume already reuses every completed step.
 */
export const markRunHeld = (id: number, hold: 'awaiting' | 'dry', title: string): void => {
  run(
    `UPDATE runs SET status = 'cancelled', finished_at = datetime('now'),
       hold = ?, title = ?, error = NULL, failed_step = NULL, retry_after = NULL
     WHERE id = ?`,
    hold,
    title,
    id,
  );
};

/**
 * A run that stopped because there was nothing to do -- the dish is already on
 * the site. `cancelled`, not `failed`: nothing broke, and it must not count
 * among the day's failures or be retried.
 */
export const markRunSkipped = (id: number, reason: string, step: string): void => {
  run(
    `UPDATE runs SET status = 'cancelled', hold = '', finished_at = datetime('now'),
       error = ?, failed_step = ?, retry_after = NULL
     WHERE id = ?`,
    reason,
    step,
    id,
  );
};

/** Runs stopped for a person to look at, newest first. */
export const listHeldRuns = (limit = 50): RunListRow[] =>
  all<RunListRow>(
    `SELECT r.*, s.domain AS site_domain, k.seed_keyword
       FROM runs r
       LEFT JOIN sites s ON s.id = r.site_id
       LEFT JOIN keywords k ON k.id = r.keyword_id
      WHERE r.hold != ''
      ORDER BY r.id DESC
      LIMIT ?`,
    limit,
  );

export const countHeldRuns = (): number =>
  get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE hold != ''")?.n ?? 0;

/** Titles already published on a site, for the near-duplicate check. */
export const publishedTitles = (siteId: number, limit = 500): { title: string; url: string | null }[] =>
  all<{ title: string; post_url: string | null }>(
    `SELECT title, post_url FROM runs
      WHERE site_id = ? AND status = 'published' AND title != ''
      ORDER BY id DESC LIMIT ?`,
    siteId,
    limit,
  ).map((r) => ({ title: r.title, url: r.post_url }));

export const setRunTitle = (id: number, title: string): void => {
  run('UPDATE runs SET title = ? WHERE id = ?', title, id);
};

/* -- Automatic retries ---------------------------------------------------- */

/** Schedule this run to be tried again, or clear a pending schedule. */
export const scheduleRetry = (id: number, retryAfter: string | null): void => {
  run(
    `UPDATE runs SET retry_after = ?,
       attempts = CASE WHEN ? IS NULL THEN attempts ELSE attempts END
     WHERE id = ?`,
    retryAfter,
    retryAfter,
    id,
  );
};

/**
 * The one failed run that is due to be retried, if any.
 *
 * Oldest first, so a backlog drains in the order it accumulated rather than
 * letting the newest failure starve the rest.
 */
export const dueRetry = (): RunRow | undefined =>
  get<RunRow>(
    `SELECT * FROM runs
      WHERE status = 'failed'
        AND retry_after IS NOT NULL
        AND retry_after <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      ORDER BY retry_after LIMIT 1`,
  );

/** Count this attempt and clear the schedule, so it cannot be picked twice. */
export const consumeRetry = (id: number): void => {
  run('UPDATE runs SET attempts = attempts + 1, retry_after = NULL WHERE id = ?', id);
};

export const markRunFailed = (id: number, error: string, failedStep: string): void => {
  run(
    `UPDATE runs SET status = 'failed', finished_at = datetime('now'),
       error = ?, failed_step = ? WHERE id = ?`,
    error,
    failedStep,
    id,
  );
};

export interface RunListRow extends RunRow {
  site_domain: string | null;
  seed_keyword: string | null;
  /** The Pinterest account(s) the pin really went to, by name ('' = no pin recorded). */
  pinned_on?: string;
}

/**
 * The Pinterest accounts a run's pin was posted on, as their usernames (or
 * "Pinterest 2" when one has none), read from what the run recorded as sent.
 */
export function pinnedOn(fanoutJson: string | null | undefined): string {
  let ids: string[] = [];
  try {
    ids = Object.keys((JSON.parse(fanoutJson || '{}') as Record<string, Record<string, string>>).pinterest ?? {});
  } catch {
    return '';
  }
  return ids
    .map((id) => getProfile(Number(id)))
    .filter((p): p is ChannelProfile => Boolean(p))
    .map((p) => p.channel_name.trim() || p.label)
    .join(', ');
}

/** Newest first; `siteId` keeps one site's runs only (Content -> Articles' site filter). */
export const listRuns = (limit = 50, offset = 0, siteId = 0): RunListRow[] =>
  all<RunListRow>(
    `SELECT r.*, s.domain AS site_domain, k.seed_keyword
       FROM runs r
       LEFT JOIN sites s ON s.id = r.site_id
       LEFT JOIN keywords k ON k.id = r.keyword_id
      ${siteId ? 'WHERE r.site_id = ?' : ''}
      ORDER BY r.started_at DESC, r.id DESC
      LIMIT ? OFFSET ?`,
    ...(siteId ? [siteId] : []),
    limit,
    offset,
  ).map((row) => ({ ...row, pinned_on: pinnedOn((row as { fanout_json?: string | null }).fanout_json) }));

export const countRuns = (siteId = 0): number =>
  (siteId
    ? get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE site_id = ?', siteId)
    : get<{ n: number }>('SELECT COUNT(*) AS n FROM runs'))?.n ?? 0;

export interface StepRow {
  id: number;
  run_id: number;
  step: string;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  attempt: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  endpoint: string | null;
  model: string | null;
  input_json: string | null;
  output_json: string | null;
  tokens_in: number;
  tokens_out: number;
  images: number;
  error: string | null;
}

export const listSteps = (runId: number): StepRow[] =>
  all<StepRow>('SELECT * FROM run_steps WHERE run_id = ? ORDER BY id', runId);

/**
 * Retire a completed step's checkpoint, so the next run of it does the work again.
 *
 * Marked failed with the reason rather than deleted: the row still says what
 * happened and what it cost, and the usage table still adds up. A resume reads
 * only 'ok' checkpoints, so this is enough to make it redo the step.
 */
export const invalidateStep = (runId: number, step: string, reason: string): void => {
  run(
    "UPDATE run_steps SET status = 'failed', error = ? WHERE run_id = ? AND step = ? AND status = 'ok'",
    reason,
    runId,
    step,
  );
};

export const getCompletedStep = (runId: number, step: string): StepRow | undefined =>
  get<StepRow>(
    "SELECT * FROM run_steps WHERE run_id = ? AND step = ? AND status = 'ok'",
    runId,
    step,
  );

export function beginStep(runId: number, step: string): void {
  run(
    `INSERT INTO run_steps (run_id, step, status, started_at)
     VALUES (?, ?, 'running', datetime('now'))
     ON CONFLICT (run_id, step) DO UPDATE SET
       status = 'running', started_at = datetime('now'),
       attempt = run_steps.attempt + 1, error = NULL`,
    runId,
    step,
  );
}

export function finishStep(
  runId: number,
  step: string,
  outcome: {
    status: 'ok' | 'failed';
    output?: unknown;
    error?: string;
    durationMs?: number;
    endpoint?: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    images?: number;
  },
): void {
  run(
    `UPDATE run_steps SET status = ?, finished_at = datetime('now'), duration_ms = ?,
       endpoint = ?, model = ?, output_json = ?, error = ?,
       tokens_in = ?, tokens_out = ?, images = ?
     WHERE run_id = ? AND step = ?`,
    outcome.status,
    outcome.durationMs ?? null,
    outcome.endpoint ?? null,
    outcome.model ?? null,
    outcome.output === undefined ? null : safeStringify(outcome.output),
    outcome.error ?? null,
    Math.max(0, Math.round(outcome.tokensIn ?? 0)),
    Math.max(0, Math.round(outcome.tokensOut ?? 0)),
    Math.max(0, Math.round(outcome.images ?? 0)),
    runId,
    step,
  );
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    // Keep a very large LLM payload from bloating the database.
    return json && json.length > 400_000 ? json.slice(0, 400_000) + '…[truncated]' : (json ?? 'null');
  } catch {
    return JSON.stringify({ unserialisable: String(value) });
  }
}

/* =========================================================================
 * Decisions
 * ====================================================================== */

export function recordDecisions(cycleId: string, decisions: Decision[]): void {
  transaction(() => {
    for (const d of decisions) {
      run(
        `INSERT INTO decisions (cycle_id, subject_type, subject_id, subject_label, decision, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        cycleId,
        d.subjectType,
        d.subjectId,
        d.subjectLabel,
        d.decision,
        d.reason,
      );
    }
  });
}

export interface DecisionRow {
  id: number;
  cycle_id: string;
  created_at: string;
  subject_type: string;
  subject_id: number | null;
  subject_label: string;
  decision: string;
  reason: string;
}

export const listRecentCycles = (limit = 20): { cycle_id: string; created_at: string; n: number }[] =>
  all(
    `SELECT cycle_id, MIN(created_at) AS created_at, COUNT(*) AS n
       FROM decisions GROUP BY cycle_id ORDER BY created_at DESC LIMIT ?`,
    limit,
  );

export const listDecisions = (cycleId: string): DecisionRow[] =>
  all<DecisionRow>('SELECT * FROM decisions WHERE cycle_id = ? ORDER BY id', cycleId);

export const pruneDecisions = (keepDays: number): number =>
  run("DELETE FROM decisions WHERE created_at < datetime('now', ?)", `-${keepDays} days`).changes;

/* =========================================================================
 * Settings (encrypted at rest when marked secret)
 * ====================================================================== */

export interface SettingRow {
  key: string;
  value: string;
  is_secret: number;
  updated_at: string;
}

export function getSetting(key: string, encryptionKey: Buffer): string {
  const row = get<SettingRow>('SELECT * FROM settings WHERE key = ?', key);
  if (!row) return '';
  return toBool(row.is_secret) ? decrypt(row.value, encryptionKey) : row.value;
}

export function setSetting(
  key: string,
  value: string,
  isSecret: boolean,
  encryptionKey: Buffer,
): void {
  const stored = isSecret ? encrypt(value, encryptionKey) : value;
  run(
    `INSERT INTO settings (key, value, is_secret) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value,
       is_secret = excluded.is_secret, updated_at = datetime('now')`,
    key,
    stored,
    fromBool(isSecret),
  );
}

export const listSettingKeys = (): SettingRow[] =>
  all<SettingRow>('SELECT * FROM settings ORDER BY key');

/* =========================================================================
 * Events
 * ====================================================================== */

export const insertEvent = (
  level: string,
  source: string,
  message: string,
  detail?: string,
): void => {
  run(
    'INSERT INTO events (level, source, message, detail) VALUES (?, ?, ?, ?)',
    level,
    source,
    message,
    detail ?? null,
  );
};

export interface EventRow {
  id: number;
  created_at: string;
  level: string;
  source: string;
  message: string;
  detail: string | null;
}

export const listEvents = (limit = 200, level?: string): EventRow[] =>
  level
    ? all<EventRow>(
        'SELECT * FROM events WHERE level = ? ORDER BY id DESC LIMIT ?',
        level,
        limit,
      )
    : all<EventRow>('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit);

/** Empty the log: every event, or only those of one level. Returns how many went. */
export const clearEvents = (level?: string): number =>
  (level ? run('DELETE FROM events WHERE level = ?', level) : run('DELETE FROM events')).changes;

export const pruneEvents = (keepDays: number): number =>
  run("DELETE FROM events WHERE created_at < datetime('now', ?)", `-${keepDays} days`).changes;

/* =========================================================================
 * Prompt overrides
 *
 * An edited prompt lives in the database because the files ship inside the
 * image, where an edit lasts only until the next redeploy. The file stays the
 * default: deleting the row restores the shipped text exactly.
 * ====================================================================== */

export interface PromptOverrideRow {
  name: string;
  body: string;
  updated_at: string;
}

export const getPromptOverride = (name: string): string | undefined =>
  get<{ body: string }>('SELECT body FROM prompt_overrides WHERE name = ?', name)?.body;

export const listPromptOverrides = (): PromptOverrideRow[] =>
  all<PromptOverrideRow>('SELECT * FROM prompt_overrides ORDER BY name');

export const setPromptOverride = (name: string, body: string): void => {
  run(
    `INSERT INTO prompt_overrides (name, body) VALUES (?, ?)
     ON CONFLICT (name) DO UPDATE SET body = excluded.body, updated_at = datetime('now')`,
    name,
    body,
  );
};

export const deletePromptOverride = (name: string): void => {
  run('DELETE FROM prompt_overrides WHERE name = ?', name);
};

/**
 * Find the row a CSV line refers to, so a re-import corrects rather than
 * duplicates.
 *
 * The article, not the group, is the identity. `seed_keyword` is a research
 * label shared by every recipe found under one topic — five different dishes
 * arrive as five rows all saying "Chicken Thighs" — so matching on it made a
 * re-import collapse those five into one, each row overwriting the previous
 * one's title, description and annotation. What survived was the last line of
 * the file, and the other four recipes were gone.
 *
 * `spy_title` names the actual dish, so that is what identifies a row. A line
 * with no title falls back to the seed, which is the only thing left to go on.
 */
export const findKeywordRow = (seed: string, spyTitle: string): KeywordRow | undefined => {
  const title = spyTitle.trim();

  if (title) {
    return get<KeywordRow>(
      'SELECT * FROM keywords WHERE spy_title = ? COLLATE NOCASE',
      title,
    );
  }

  // No article title: the seed is the whole of what this row says it is, so
  // two such rows are indistinguishable and treating them as one is right.
  return get<KeywordRow>(
    "SELECT * FROM keywords WHERE seed_keyword = ? COLLATE NOCASE AND spy_title = ''",
    seed.trim(),
  );
};

/** Every recipe found under one research label. */
export const keywordsInGroup = (seed: string, excludeId = 0): KeywordRow[] =>
  all<KeywordRow>(
    'SELECT * FROM keywords WHERE seed_keyword = ? COLLATE NOCASE AND id != ? ORDER BY id',
    seed.trim(),
    excludeId,
  );

/** Overwrite a keyword's imported fields, leaving its id and links intact. */
export function updateKeywordFields(
  id: number,
  fields: Omit<Partial<KeywordRow>, 'id' | 'seed_keyword'>,
): void {
  run(
    `UPDATE keywords SET spy_title = ?, spy_description = ?, spy_image_url = ?,
       spy_article_url = ?, spy_pin_image = ?, annotation = ?, status = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
    fields.spy_title ?? '',
    fields.spy_description ?? '',
    fields.spy_image_url ?? '',
    fields.spy_article_url ?? '',
    fields.spy_pin_image ?? '',
    fields.annotation ?? '',
    fields.status ?? 'go',
    id,
  );
}

/**
 * Bring stored domains to one spelling.
 *
 * Sites entered before the form normalised, or imported from a KEYS sheet that
 * did not, are stored as `https://bitespoon.com`. A CSV column headed
 * `bitespoon.com` then matches nothing, the import reports success, and every
 * keyword lands linked to no site. Running this once at boot means the repair
 * does not depend on someone re-saving eleven sites by hand.
 *
 * Idempotent: a domain already normalised is left alone. A domain that would
 * collide with another row is left alone too and reported, because silently
 * merging two sites is worse than the inconsistency.
 */
export function normaliseStoredDomains(
  normalise: (value: string) => string,
): { changed: string[]; conflicted: string[] } {
  const sites = listSites();
  const changed: string[] = [];
  const conflicted: string[] = [];

  // Keyed by the domain as it stands, not by its normalised form: keying by
  // the target collapses both spellings of a colliding pair into one entry, so
  // the guard below never fires and the UPDATE hits the UNIQUE constraint.
  const occupied = new Set(sites.map((s) => s.domain));

  for (const site of sites) {
    const target = normalise(site.domain);
    if (target === '' || target === site.domain) continue;

    if (occupied.has(target)) {
      conflicted.push(`${site.domain} -> ${target}`);
      continue;
    }

    run("UPDATE sites SET domain = ?, updated_at = datetime('now') WHERE id = ?", target, site.id);
    occupied.delete(site.domain);
    occupied.add(target);
    changed.push(`${site.domain} -> ${target}`);
  }

  return { changed, conflicted };
}

/* =========================================================================
 * Keywords: searching and bulk edits
 *
 * A hundred keywords across five sites is five hundred cells, and changing
 * them one select at a time is how a page stops being used. Filtering narrows
 * the table to the rows you mean; the bulk writes then act on exactly those.
 * ====================================================================== */

/**
 * A named view of the keyword list.
 *
 * The page used to expose the raw fields — keyword status, site, and link
 * status — as four separate dropdowns, one of which was labelled "Where it
 * stands there". Nobody could work out what a combination of them would show,
 * because answering that needed the data model in your head.
 *
 * These are the questions people actually ask instead. Each is one option.
 */
export type KeywordListView = 'all' | 'queued' | 'stuck' | 'done' | 'off';

export interface KeywordFilter {
  /** Matched against the keyword and its spy title, case-insensitively. */
  q?: string;
  view?: KeywordListView;
  /** Narrows every view to one site. 0 means "any site". */
  siteId?: number;
}

/** WHERE clause and parameters shared by the list and its count. */
function keywordWhere(filter: KeywordFilter): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  const q = (filter.q ?? '').trim();
  if (q) {
    clauses.push('(k.seed_keyword LIKE ? COLLATE NOCASE OR k.spy_title LIKE ? COLLATE NOCASE)');
    params.push(`%${q}%`, `%${q}%`);
  }

  // "Is this keyword going to publish somewhere?" — the question both `queued`
  // and `stuck` are asking, from opposite sides. Narrowed to one site when one
  // is chosen, so the same view reads as "here" rather than "anywhere".
  const goesSomewhere = filter.siteId
    ? 'EXISTS (SELECT 1 FROM keyword_sites ks WHERE ks.keyword_id = k.id AND ks.status = \'go\' AND ks.site_id = ?)'
    : "EXISTS (SELECT 1 FROM keyword_sites ks WHERE ks.keyword_id = k.id AND ks.status = 'go')";

  switch (filter.view ?? 'all') {
    case 'queued':
      clauses.push("k.status = 'go'", goesSomewhere);
      if (filter.siteId) params.push(filter.siteId);
      break;

    case 'stuck':
      // Set to go and linked to nothing that will take it. This is the state
      // that looks like supply on the dashboard and publishes nothing, which
      // is why it gets a view of its own.
      clauses.push("k.status = 'go'", `NOT ${goesSomewhere}`);
      if (filter.siteId) params.push(filter.siteId);
      break;

    case 'done':
      clauses.push("k.status = 'done'");
      if (filter.siteId) {
        clauses.push(
          'EXISTS (SELECT 1 FROM keyword_sites ks WHERE ks.keyword_id = k.id AND ks.site_id = ?)',
        );
        params.push(filter.siteId);
      }
      break;

    case 'off':
      clauses.push("k.status = 'no'");
      if (filter.siteId) {
        clauses.push(
          'EXISTS (SELECT 1 FROM keyword_sites ks WHERE ks.keyword_id = k.id AND ks.site_id = ?)',
        );
        params.push(filter.siteId);
      }
      break;

    case 'all':
    default:
      if (filter.siteId) {
        clauses.push(
          'EXISTS (SELECT 1 FROM keyword_sites ks WHERE ks.keyword_id = k.id AND ks.site_id = ?)',
        );
        params.push(filter.siteId);
      }
      break;
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** How many keywords each view holds, for the labels on the view picker. */
export function keywordViewCounts(siteId = 0): Record<KeywordListView, number> {
  const count = (view: KeywordListView): number => countKeywordsMatching({ view, siteId });
  return {
    all: count('all'),
    queued: count('queued'),
    stuck: count('stuck'),
    done: count('done'),
    off: count('off'),
  };
}

export const searchKeywords = (
  filter: KeywordFilter,
  limit = 100,
  offset = 0,
): KeywordRow[] => {
  const where = keywordWhere(filter);
  return all<KeywordRow>(
    `SELECT k.* FROM keywords k ${where.sql} ORDER BY k.id LIMIT ? OFFSET ?`,
    ...where.params,
    limit,
    offset,
  );
};

/** Every keyword id the filter matches, with no page limit — for "all N in this view" actions. */
export const keywordIdsMatching = (filter: KeywordFilter): number[] => {
  const where = keywordWhere(filter);
  return all<{ id: number }>(`SELECT k.id FROM keywords k ${where.sql} ORDER BY k.id`, ...where.params).map(
    (r) => r.id,
  );
};

export const countKeywordsMatching = (filter: KeywordFilter): number => {
  const where = keywordWhere(filter);
  return (
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM keywords k ${where.sql}`, ...where.params)?.n ?? 0
  );
};

/** `?, ?, ?` for an IN list. Ids are numbers, so nothing is interpolated raw. */
const placeholders = (ids: number[]): string => ids.map(() => '?').join(', ');

export const bulkSetKeywordStatus = (ids: number[], status: 'go' | 'done' | 'no'): number => {
  if (ids.length === 0) return 0;
  return run(
    `UPDATE keywords SET status = ?, updated_at = datetime('now')
      WHERE id IN (${placeholders(ids)})`,
    status,
    ...ids,
  ).changes;
};

export const bulkDeleteKeywords = (ids: number[]): number => {
  if (ids.length === 0) return 0;
  // In chunks, so thousands at once stay under SQLite's bound-parameter limit.
  return transaction(() => {
    let removed = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      removed += run(`DELETE FROM keywords WHERE id IN (${placeholders(chunk)})`, ...chunk).changes;
    }
    return removed;
  });
};

/**
 * Set the link status for every (keyword, site) pair in the selection.
 *
 * `siteIds` empty means every site, which is what "all sites" in the bulk bar
 * sends. Wrapped in one transaction so a half-applied grid is impossible.
 */
export const bulkSetLinks = (
  keywordIds: number[],
  siteIds: number[],
  status: 'go' | 'done' | 'no',
): number => {
  if (keywordIds.length === 0) return 0;
  const targets = siteIds.length ? siteIds : listSites().map((s) => s.id);
  if (targets.length === 0) return 0;

  return transaction(() => {
    let n = 0;
    for (const keywordId of keywordIds) {
      for (const siteId of targets) {
        setLink(keywordId, siteId, status);
        n += 1;
      }
    }
    return n;
  });
};

/** The same shape for image sharing. Only touches pairs that already exist. */
export const bulkSetShareImages = (
  keywordIds: number[],
  siteIds: number[],
  share: boolean,
): number => {
  if (keywordIds.length === 0) return 0;

  return transaction(() => {
    if (siteIds.length === 0) {
      return run(
        `UPDATE keyword_sites SET share_images = ?, updated_at = datetime('now')
          WHERE keyword_id IN (${placeholders(keywordIds)})`,
        share ? 1 : 0,
        ...keywordIds,
      ).changes;
    }
    return run(
      `UPDATE keyword_sites SET share_images = ?, updated_at = datetime('now')
        WHERE keyword_id IN (${placeholders(keywordIds)})
          AND site_id IN (${placeholders(siteIds)})`,
      share ? 1 : 0,
      ...keywordIds,
      ...siteIds,
    ).changes;
  });
};

/* =========================================================================
 * Pausing a site
 * ====================================================================== */

/**
 * Pause one site, with a note and optionally an end.
 *
 * The note is the point. "Paused" on its own is a state whose reason is gone
 * within a week, and the usual outcome is that nobody dares turn it back on.
 */
export const pauseSite = (
  id: number,
  reason: string,
  until: string | null,
): void => {
  run(
    `UPDATE sites SET status = 'paused', paused_reason = ?, paused_until = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
    reason.trim(),
    until,
    id,
  );
};

/* -- Bulk edits from the sites table -------------------------------------- */

/**
 * One field across several sites.
 *
 * Separate small updates rather than a route through upsertSite: that one
 * takes a whole site and treats a missing field as "keep", which is right for
 * a form that submits every field and wrong here, where the whole point is to
 * change one thing and touch nothing else.
 */
export const bulkSetDailyTarget = (ids: number[], target: number): number =>
  bulkUpdateSites(ids, 'daily_target = ?', Math.max(0, Math.round(target)));

export const bulkSetInterval = (ids: number[], minutes: number): number =>
  bulkUpdateSites(ids, 'interval_minutes = ?', Math.max(0, Math.round(minutes)));

export const bulkSetAutoPublish = (ids: number[], on: boolean): number =>
  bulkUpdateSites(ids, 'auto_publish = ?', on ? 1 : 0);

export const bulkActivate = (ids: number[]): number =>
  bulkUpdateSites(ids, "status = 'active', paused_reason = '', paused_until = NULL");

export const bulkPause = (ids: number[], reason: string): number =>
  bulkUpdateSites(ids, "status = 'paused', paused_until = NULL, paused_reason = ?", reason.trim());

function bulkUpdateSites(
  ids: number[],
  assignment: string,
  ...values: (string | number)[]
): number {
  if (ids.length === 0) return 0;

  const holes = ids.map(() => '?').join(', ');
  const result = run(
    `UPDATE sites SET ${assignment}, updated_at = datetime('now') WHERE id IN (${holes})`,
    ...values,
    ...ids,
  );
  return result.changes;
}

export const activateSite = (id: number): void => {
  run(
    `UPDATE sites SET status = 'active', paused_reason = '', paused_until = NULL,
       updated_at = datetime('now')
     WHERE id = ?`,
    id,
  );
};

/**
 * Bring back every site whose pause has run out.
 *
 * A real write rather than a rule applied at read time. Deriving it would mean
 * the Sites page showing "active" over a row that still says paused in the
 * database, and every later query having to remember the same rule. One
 * UPDATE, called at the top of a tick, keeps the table honest.
 *
 * Returns the domains resumed so the caller can log or announce them.
 */
export function resumeExpiredPauses(): string[] {
  const due = all<{ id: number; domain: string }>(
    `SELECT id, domain FROM sites
      WHERE status = 'paused'
        AND paused_until IS NOT NULL
        AND paused_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
  );

  for (const site of due) activateSite(site.id);
  return due.map((s) => s.domain);
}

/* =========================================================================
 * Prompt history
 * ====================================================================== */

/**
 * How many versions of one prompt are kept.
 *
 * Prompts run to thousands of characters and every save appends one. Twenty
 * covers "put back what I had this morning", which is the whole use; keeping
 * every version forever would make prompt_versions the largest table here.
 */
export const PROMPT_VERSION_LIMIT = 20;

export interface PromptVersionRow {
  id: number;
  name: string;
  body: string;
  created_at: string;
}

/** Append a version, then drop everything past the limit for that prompt. */
export function savePromptVersion(name: string, body: string): void {
  transaction(() => {
    // Saving the same text twice in a row is a no-op, not a new version:
    // pressing Save without editing should not push a real version out.
    const newest = get<{ body: string }>(
      'SELECT body FROM prompt_versions WHERE name = ? ORDER BY id DESC LIMIT 1',
      name,
    );
    if (newest?.body === body) return;

    run('INSERT INTO prompt_versions (name, body) VALUES (?, ?)', name, body);
    run(
      `DELETE FROM prompt_versions
        WHERE name = ?
          AND id NOT IN (
            SELECT id FROM prompt_versions WHERE name = ? ORDER BY id DESC LIMIT ?
          )`,
      name,
      name,
      PROMPT_VERSION_LIMIT,
    );
  });
}

export const listPromptVersions = (name: string): PromptVersionRow[] =>
  all<PromptVersionRow>(
    'SELECT * FROM prompt_versions WHERE name = ? ORDER BY id DESC',
    name,
  );

export const getPromptVersion = (id: number): PromptVersionRow | undefined =>
  get<PromptVersionRow>('SELECT * FROM prompt_versions WHERE id = ?', id);

/* =========================================================================
 * Which model runs which prompt
 * ====================================================================== */

export const listModelOverrides = (): Map<string, string> =>
  new Map(
    all<{ prompt: string; model: string }>('SELECT prompt, model FROM model_overrides').map(
      (r) => [r.prompt, r.model] as const,
    ),
  );

export const setModelOverride = (prompt: string, model: string): void => {
  const trimmed = model.trim();

  // Blank means "back to the shipped default", which is the absence of a row
  // rather than a row holding an empty string.
  if (trimmed === '') {
    run('DELETE FROM model_overrides WHERE prompt = ?', prompt);
    return;
  }

  run(
    `INSERT INTO model_overrides (prompt, model) VALUES (?, ?)
     ON CONFLICT (prompt) DO UPDATE SET model = excluded.model, updated_at = datetime('now')`,
    prompt,
    trimmed,
  );
};

/* =========================================================================
 * Notification de-duplication
 * ====================================================================== */

/**
 * Record the state last announced for one kind of notice.
 *
 * Returns true when the state changed, which is exactly when a message should
 * be sent. The check and the write are one call so there is no window where a
 * second caller sees the old state and sends a duplicate.
 */
export function noticeChanged(kind: string, state: string): boolean {
  const previous = get<{ state: string }>('SELECT state FROM notice_state WHERE kind = ?', kind);
  if (previous?.state === state) return false;

  run(
    `INSERT INTO notice_state (kind, state) VALUES (?, ?)
     ON CONFLICT (kind) DO UPDATE SET state = excluded.state, updated_at = datetime('now')`,
    kind,
    state,
  );
  return true;
}

/* =========================================================================
 * Usage
 * ====================================================================== */

export interface RunUsage {
  tokensIn: number;
  tokensOut: number;
  images: number;
  durationMs: number;
  llmCalls: number;
}

export const runUsage = (runId: number): RunUsage => {
  const row = get<{
    tokens_in: number;
    tokens_out: number;
    images: number;
    duration_ms: number;
    llm_calls: number;
  }>(
    `SELECT COALESCE(SUM(tokens_in), 0)  AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out,
            COALESCE(SUM(images), 0)     AS images,
            COALESCE(SUM(duration_ms), 0) AS duration_ms,
            COALESCE(SUM(CASE WHEN model IS NOT NULL AND model != '' THEN 1 ELSE 0 END), 0)
              AS llm_calls
       FROM run_steps WHERE run_id = ?`,
    runId,
  );

  return {
    tokensIn: Number(row?.tokens_in ?? 0),
    tokensOut: Number(row?.tokens_out ?? 0),
    images: Number(row?.images ?? 0),
    durationMs: Number(row?.duration_ms ?? 0),
    llmCalls: Number(row?.llm_calls ?? 0),
  };
};

/**
 * Published and failed counts per local day, oldest first.
 *
 * `days` days of history, including days with nothing — a gap in the series is
 * a day the platform did not publish, and dropping it would draw a chart that
 * quietly hides exactly the thing you are looking for.
 */
export function dailyActivity(
  days: number,
  timezone: string,
): { day: string; published: number; failed: number }[] {
  const modifier = tzModifier(timezone);

  const rows = all<{ day: string; published: number; failed: number }>(
    `SELECT date(started_at, ?) AS day,
            SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
            SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed
       FROM runs
      WHERE started_at >= datetime('now', ?)
      GROUP BY day`,
    modifier,
    `-${Math.max(1, Math.floor(days))} days`,
  );

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const series: { day: string; published: number; failed: number }[] = [];

  for (let back = days - 1; back >= 0; back--) {
    const at = new Date(Date.now() - back * 86_400_000);
    const day = get<{ d: string }>("SELECT date(?, ?) AS d", at.toISOString(), modifier)?.d ?? '';
    const found = byDay.get(day);
    series.push({
      day,
      published: Number(found?.published ?? 0),
      failed: Number(found?.failed ?? 0),
    });
  }

  return series;
}

/* =========================================================================
 * Held runs: editing what was written, and throwing it away
 * ====================================================================== */

/**
 * Overwrite a completed step's stored output.
 *
 * The checkpoint *is* the article: a resume replays from stored outputs, so
 * editing one before approving is what makes the edit reach the site. Only
 * ever called with a document the caller has already parsed.
 */
export const replaceStepOutput = (runId: number, step: string, output: unknown): void => {
  run(
    "UPDATE run_steps SET output_json = ? WHERE run_id = ? AND step = ? AND status = 'ok'",
    safeStringify(output),
    runId,
    step,
  );
};

/**
 * Close a held run without publishing it.
 *
 * The steps stay. They are the record of what was written and what it cost,
 * and deleting them to tidy up would make a discarded article invisible in the
 * usage figures it genuinely contributed to.
 */
export const discardRun = (id: number): void => {
  run(
    `UPDATE runs SET status = 'cancelled', hold = '', finished_at = datetime('now'),
       error = 'Discarded before publishing', retry_after = NULL
     WHERE id = ?`,
    id,
  );
};

/** Every run for one keyword, newest first — the keyword's own history. */
export const listRunsForKeyword = (keywordId: number, limit = 25): RunListRow[] =>
  all<RunListRow>(
    `SELECT r.*, s.domain AS site_domain, k.seed_keyword
       FROM runs r
       LEFT JOIN sites s ON s.id = r.site_id
       LEFT JOIN keywords k ON k.id = r.keyword_id
      WHERE r.keyword_id = ?
      ORDER BY r.id DESC
      LIMIT ?`,
    keywordId,
    limit,
  );

/* =========================================================================
 * Where a keyword's images came from
 * ====================================================================== */

export interface SharedImageInfo extends SharedImageUrls {
  sourceDomain: string | null;
  createdAt: string;
  /** Sites that have copied this set rather than generating their own. */
  reusedBy: number;
}

/**
 * The stored image set for one keyword, with its provenance.
 *
 * Exists because "are these four images really this keyword's own?" was not a
 * question the UI could answer. The store is keyed by keyword_id, so crossing
 * keywords is not representable — but being told that is not the same as being
 * able to open two keywords and see two different sets of URLs.
 */
export const sharedImageInfo = (keywordId: number): SharedImageInfo | undefined => {
  const row = get<{
    feature_url: string;
    top_shot_url: string;
    texture_macro_url: string;
    before_after_url: string;
    created_at: string;
    domain: string | null;
    source_site_id: number | null;
  }>(
    `SELECT i.feature_url, i.top_shot_url, i.texture_macro_url, i.before_after_url,
            i.created_at, i.source_site_id, s.domain
       FROM keyword_images i
       LEFT JOIN sites s ON s.id = i.source_site_id
      WHERE i.keyword_id = ?`,
    keywordId,
  );

  if (!row) return undefined;

  // Every site that published this keyword other than the one that made the
  // images. Those are the runs that copied instead of generating.
  const reused =
    get<{ n: number }>(
      `SELECT COUNT(DISTINCT site_id) AS n FROM runs
        WHERE keyword_id = ? AND status = 'published'
          AND (? IS NULL OR site_id != ?)`,
      keywordId,
      row.source_site_id,
      row.source_site_id,
    )?.n ?? 0;

  return {
    hero: row.feature_url,
    stepA: row.top_shot_url,
    stepB: row.texture_macro_url,
    stepC: row.before_after_url,
    sourceDomain: row.domain,
    createdAt: row.created_at,
    reusedBy: reused,
  };
};

export interface KeywordImageCounts {
  /** Runs that generated a fresh set of four article images. */
  generatedRuns: number;
  /** Runs that copied an existing set instead of calling Google. */
  copiedRuns: number;
  /** Pinterest graphics successfully made. One per site, never shared. */
  pinsMade: number;
  /** Attempts at a Pinterest graphic that failed. */
  pinsFailed: number;
  /** Article images that reached Google: four per generating run. */
  articleGenerated: number;
}

/** How many article images one generating run makes. */
export const ARTICLE_IMAGES_PER_RUN = 4;

/**
 * What this keyword has cost at the image service.
 *
 * Counts *runs* from facts that have always been recorded — a step's status,
 * and which site the stored image set came from — rather than summing
 * run_steps.images.
 *
 * That column arrived in migration 005 with DEFAULT 0, so every run from
 * before that deploy reports zero. Summing it made a run that generated four
 * images indistinguishable from one that copied them, and the page confidently
 * reported "0 article images made" directly above the four images it was
 * displaying. A column added later is not evidence about what happened
 * earlier, and a counter that cannot say "I do not know" will instead say
 * something false.
 *
 * The tell for a generating run is `images > 0` where that was measured, or
 * being the site the image set is recorded against where it was not.
 *
 * Runs made since the four images became four steps carry the count on those
 * steps (`generate-image-*`) rather than on `generate-images`, which is now
 * the collector and always reads 0. Both places are checked, so a run from
 * either era is read correctly.
 */
export const keywordImageCounts = (keywordId: number): KeywordImageCounts => {
  const row = get<{
    generated: number;
    copied: number;
    pins_made: number;
    pins_failed: number;
  }>(
    `SELECT
       COALESCE(SUM(CASE
         WHEN s.step = 'generate-images' AND s.status = 'ok'
          AND (s.images > 0 OR EXISTS (
                SELECT 1 FROM run_steps i
                WHERE i.run_id = s.run_id AND i.step LIKE 'generate-image-%' AND i.images > 0)
               OR r.site_id = (
                SELECT source_site_id FROM keyword_images WHERE keyword_id = ?))
         THEN 1 ELSE 0 END), 0)                                        AS generated,

       COALESCE(SUM(CASE
         WHEN s.step = 'generate-images' AND s.status = 'ok'
          AND s.images = 0
          AND NOT EXISTS (
                SELECT 1 FROM run_steps i
                WHERE i.run_id = s.run_id AND i.step LIKE 'generate-image-%' AND i.images > 0)
          AND (r.site_id IS NULL OR r.site_id IS NOT (
                SELECT source_site_id FROM keyword_images WHERE keyword_id = ?))
         THEN 1 ELSE 0 END), 0)                                        AS copied,

       COALESCE(SUM(CASE WHEN s.step = 'generate-pin-image' AND s.status = 'ok'
                         THEN 1 ELSE 0 END), 0)                        AS pins_made,
       COALESCE(SUM(CASE WHEN s.step = 'generate-pin-image' AND s.status = 'failed'
                         THEN 1 ELSE 0 END), 0)                        AS pins_failed
     FROM run_steps s
     JOIN runs r ON r.id = s.run_id
     WHERE r.keyword_id = ?`,
    keywordId,
    keywordId,
    keywordId,
  );

  const generatedRuns = Number(row?.generated ?? 0);

  return {
    generatedRuns,
    copiedRuns: Number(row?.copied ?? 0),
    pinsMade: Number(row?.pins_made ?? 0),
    pinsFailed: Number(row?.pins_failed ?? 0),
    articleGenerated: generatedRuns * ARTICLE_IMAGES_PER_RUN,
  };
};

/** Whether this site publishes on its own or holds each article for approval. */
export const setAutoPublish = (id: number, auto: boolean): void => {
  run(
    "UPDATE sites SET auto_publish = ?, updated_at = datetime('now') WHERE id = ?",
    fromBool(auto),
    id,
  );
};

/** Which spelling and units this site is written in. */
export const setWritingStyle = (id: number, style: 'fr' | 'us' | 'uk'): void => {
  run(
    "UPDATE sites SET writing_style = ?, updated_at = datetime('now') WHERE id = ?",
    style,
    id,
  );
};

/* -- Facebook tokens, pages and reels ------------------------------------- */

/**
 * A token this platform publishes with. One per Facebook app: the pages a
 * token can manage are the pages that app was given, so more apps means more
 * tokens, and every page hangs off the token it was found under.
 *
 * Encrypted with the platform key exactly as a secret setting is.
 */
export interface FbTokenRow {
  id: number;
  name: string;
  token_encrypted: string;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface FbTokenView extends FbTokenRow {
  page_count: number;
}

/**
 * A Facebook Page this platform may publish Reels to.
 *
 * Rows are written only by a token sync; nobody types a page id. The three
 * things a person sets -- niche, auto_publish, enabled -- are theirs, and a
 * sync never touches them. No credential is stored on the page: its token is
 * minted from the token it came from at publish time.
 */
export interface FbPageRow {
  id: number;
  page_id: string;
  name: string;
  token_id: number | null;
  /** Legacy: the topic that used to pick the page. Nothing reads it any more. */
  niche: string | null;
  /** The site this page belongs to; NULL is a page nobody has given a site yet, so nothing goes to it. */
  site_id: number | null;
  auto_publish: number;
  enabled: number;
  last_used_at: string | null;
  last_error: string | null;
  /** The presenter this page's reels are made with; NULL means dish only. */
  presenter_id: number | null;
  /** An image post on the page for every article. */
  posts: number;
  /** A reel on the page for every article. */
  reels: number;
  /** A step-by-step photo collage on the page for every article. */
  collage: number;
  /** The Buffer account (Channels -> Accounts -> Facebook N) this page is set from; NULL for one synced from a token and not yet claimed there. */
  profile_id: number | null;
  created_at: string;
}

/** Every distinct keyword group, for the niche picker. */
export const keywordGroups = (): string[] =>
  all<{ seed_keyword: string }>(
    `SELECT DISTINCT seed_keyword FROM keywords
      WHERE seed_keyword != '' ORDER BY seed_keyword COLLATE NOCASE`,
  ).map((r) => r.seed_keyword);

/* -- Tokens --------------------------------------------------------------- */

export const listFbTokens = (): FbTokenView[] =>
  all<FbTokenView>(
    `SELECT t.*, (SELECT COUNT(*) FROM fb_pages p WHERE p.token_id = t.id) AS page_count
       FROM fb_tokens t ORDER BY t.id`,
  );

export function insertFbToken(name: string, token: string, key: Buffer): number {
  const secret = token.trim();
  if (!secret) throw new Error('Paste the token.');

  run(
    'INSERT INTO fb_tokens (name, token_encrypted) VALUES (?, ?)',
    name.trim() || `Token ${listFbTokens().length + 1}`,
    encrypt(secret, key),
  );
  return get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0;
}

/** The token itself. Empty when there is none, or it was encrypted under another key. */
export function fbTokenSecret(id: number, key: Buffer): string {
  const row = get<FbTokenRow>('SELECT * FROM fb_tokens WHERE id = ?', id);
  if (!row) return '';
  try {
    return decrypt(row.token_encrypted, key);
  } catch {
    // Same reasoning as siteSecrets: an unreadable credential should fail at
    // call time as an auth error, not while rendering a page.
    return '';
  }
}

export const deleteFbToken = (id: number): void => {
  // Pages cascade in a fresh database; an upgraded one gained token_id by
  // ALTER TABLE, where SQLite does not enforce the reference. So both.
  run('DELETE FROM fb_pages WHERE token_id = ?', id);
  run('DELETE FROM fb_tokens WHERE id = ?', id);
};

export function markFbTokenSynced(id: number, error: string | null): void {
  run(
    "UPDATE fb_tokens SET last_synced_at = datetime('now'), last_error = ? WHERE id = ?",
    error ? error.slice(0, 500) : null,
    id,
  );
}

/* -- Pages ---------------------------------------------------------------- */

export const listFbPages = (): FbPageRow[] =>
  all<FbPageRow>('SELECT * FROM fb_pages ORDER BY name, page_id');

export const getFbPage = (id: number): FbPageRow | undefined =>
  get<FbPageRow>('SELECT * FROM fb_pages WHERE id = ?', id);

/**
 * Insert a page, or rename one already here.
 *
 * Never touches niche, auto_publish or enabled: a sync that reset them would
 * start posting to a page somebody had turned off. A new page arrives with
 * auto-publish on, because the point of the platform is not to be asked.
 */
export function upsertFbPage(input: {
  pageId: string;
  name: string;
  tokenId: number | null;
}): number {
  const pageId = input.pageId.trim();
  if (!pageId) throw new Error('A page needs its Facebook page id.');

  run(
    `INSERT INTO fb_pages (page_id, name, token_id, auto_publish, enabled) VALUES (?, ?, ?, 1, 1)
     ON CONFLICT (page_id) DO UPDATE SET name = excluded.name, token_id = excluded.token_id`,
    pageId,
    input.name.trim(),
    input.tokenId,
  );
  return get<{ id: number }>('SELECT id FROM fb_pages WHERE page_id = ?', pageId)?.id ?? 0;
}

/**
 * Make the pages under a token match what Graph just listed for it.
 *
 * A page Graph no longer returns is disabled, not deleted: its niche and its
 * history stay, and if the token regains it the next sync re-enables nothing
 * -- the person does, having seen why it stopped.
 */
export function syncFbPages(
  tokenId: number,
  pages: { id: string; name: string }[],
): { added: number; renamed: number; dropped: number } {
  const known = new Map(
    all<FbPageRow>('SELECT * FROM fb_pages WHERE token_id = ?', tokenId).map((p) => [p.page_id, p]),
  );
  const seen = new Set<string>();
  let added = 0;
  let renamed = 0;

  for (const page of pages) {
    seen.add(page.id);
    const existing =
      known.get(page.id) ?? get<FbPageRow>('SELECT * FROM fb_pages WHERE page_id = ?', page.id);
    upsertFbPage({ pageId: page.id, name: page.name, tokenId });
    if (!existing) added++;
    else if (existing.name !== page.name) renamed++;
  }

  let dropped = 0;
  for (const [pageId, row] of known) {
    if (seen.has(pageId) || row.enabled !== 1) continue;
    run(
      "UPDATE fb_pages SET enabled = 0, last_error = 'No longer under this token' WHERE id = ?",
      row.id,
    );
    dropped++;
  }

  return { added, renamed, dropped };
}

/**
 * What a person sets on a page. A page with no site is not posted to.
 *
 * A site may have several pages; which one a reel goes to is pageForSite's
 * rotation, so nothing here has to refuse a second page for a site.
 */
export function setFbPageOptions(
  id: number,
  options: {
    siteId: number | null;
    autoPublish: boolean;
    enabled: boolean;
    posts?: boolean;
    reels?: boolean;
    collage?: boolean;
  },
): void {
  const siteId = options.siteId && options.siteId > 0 ? options.siteId : null;

  run(
    'UPDATE fb_pages SET site_id = ?, auto_publish = ?, enabled = ? WHERE id = ?',
    siteId,
    options.autoPublish ? 1 : 0,
    options.enabled ? 1 : 0,
    id,
  );
  if (options.posts !== undefined || options.reels !== undefined || options.collage !== undefined) {
    run(
      'UPDATE fb_pages SET posts = COALESCE(?, posts), reels = COALESCE(?, reels), collage = COALESCE(?, collage) WHERE id = ?',
      options.posts === undefined ? null : options.posts ? 1 : 0,
      options.reels === undefined ? null : options.reels ? 1 : 0,
      options.collage === undefined ? null : options.collage ? 1 : 0,
      id,
    );
  }

  // Reels made before this page had a site were left with nowhere to go. They
  // are this page's now, so the Reels page shows them under it and
  // auto-publish can take them.
  // Only a page that takes reels: a reel made for the other networks alone
  // (no page took reels) must not land on a page that only takes posts.
  if (siteId && options.enabled) {
    run(
      `UPDATE reels SET fb_page_id = ?
       WHERE fb_page_id IS NULL AND status != 'published' AND site_id = ?
         AND (SELECT reels FROM fb_pages WHERE id = ?) = 1`,
      id,
      siteId,
      id,
    );
  }
}

export const deleteFbPage = (id: number): void => {
  run('DELETE FROM fb_pages WHERE id = ?', id);
};

/**
 * The page set from one Buffer account's own card, if its Posts or Reels box
 * was ever ticked.
 *
 * A profile can end up with more than one fb_pages row pointing at it: the
 * card's own row (page_id = "profile:<id>", the one upsertFbPageForProfile
 * writes the Posts/Reels/Collage boxes to) plus a real page that a Graph sync
 * or an older migration linked to the same profile. Those stale rows carry
 * posts/reels/collage = 0, so a plain "first row wins" read could hand back
 * the untouched one -- showing the boxes empty just after they were saved, and
 * gating posting off for a page whose box is ticked. The card's own row is the
 * authority here, so it is preferred explicitly.
 */
export const getFbPageByProfile = (profileId: number): FbPageRow | undefined =>
  get<FbPageRow>(
    'SELECT * FROM fb_pages WHERE profile_id = ? ORDER BY (page_id = ?) DESC, id DESC LIMIT 1',
    profileId,
    `profile:${profileId}`,
  );

/**
 * What a Facebook account card (Channels -> Accounts) sets directly: the page
 * it posts as, and whether that page takes posts, reels, or neither.
 *
 * One page per account, found by the account rather than typed as a separate
 * Facebook page id: Buffer already holds the real connection, so all a page
 * row needs here is something to be recognised by. The id is synthetic and
 * stable across renames, so saving a new name never creates a second page.
 */
export function upsertFbPageForProfile(
  profileId: number,
  siteId: number,
  name: string,
  posts: boolean,
  reels: boolean,
  collage = false,
): void {
  const pageId = `profile:${profileId}`;
  const trimmed = name.trim();
  const enabled = posts || reels || collage;
  run(
    `INSERT INTO fb_pages (page_id, name, profile_id, site_id, posts, reels, collage, auto_publish, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (page_id) DO UPDATE SET
       name = excluded.name, site_id = excluded.site_id, profile_id = excluded.profile_id,
       posts = excluded.posts, reels = excluded.reels, collage = excluded.collage, enabled = excluded.enabled`,
    pageId,
    trimmed,
    profileId,
    siteId,
    posts ? 1 : 0,
    reels ? 1 : 0,
    collage ? 1 : 0,
    enabled ? 1 : 0,
  );

  // Reels made before this account had a page to carry were left with
  // nowhere to go; they are this page's now (see setFbPageOptions) -- when it takes reels.
  if (enabled && reels) {
    run(
      `UPDATE reels SET fb_page_id = (SELECT id FROM fb_pages WHERE page_id = ?)
       WHERE fb_page_id IS NULL AND status != 'published' AND site_id = ?`,
      pageId,
      siteId,
    );
  }
}

/** Remove the page set from a Facebook account's card, when the account itself is removed. */
export function deleteFbPageByProfile(profileId: number): void {
  run('DELETE FROM fb_pages WHERE profile_id = ?', profileId);
}

export function markFbPageUsed(id: number): void {
  run(
    "UPDATE fb_pages SET last_used_at = datetime('now'), last_error = NULL WHERE id = ?",
    id,
  );
}

export function markFbPageFailed(id: number, error: string): void {
  run(
    "UPDATE fb_pages SET last_used_at = datetime('now'), last_error = ? WHERE id = ?",
    error.slice(0, 500),
    id,
  );
}

/**
 * The page a site's next post or reel goes to.
 *
 * A page belongs to a site (Channels -> Accounts -> Facebook pages). With
 * several, they take turns: the one that went longest ago is next, so a site
 * with two pages alternates between them. `need` asks only for pages that take
 * posts or reels; none means nothing goes out and the run says why.
 */
/** Which of a site's pages may take its posts and reels (alias p). */
const CARD_RULE = `(
  (p.profile_id IS NOT NULL AND EXISTS (SELECT 1 FROM channel_profiles c WHERE c.id = p.profile_id AND c.enabled = 1))
  OR (p.profile_id IS NULL AND NOT EXISTS (SELECT 1 FROM fb_pages q WHERE q.site_id = p.site_id AND q.profile_id IS NOT NULL))
)`;

/**
 * Whether a site's reels go anywhere besides Facebook: a network other than
 * Facebook switched on for reels (on Pinterest and Instagram, an account with
 * Reels ticked). A reel is then made even with no Facebook page taking it.
 */
export function reelsElsewhere(site: Pick<SiteRow, 'pin_reels'> & { ig_reels?: number; yt_reels?: number; tt_reels?: number }): boolean {
  return Boolean(site.pin_reels || site.ig_reels || site.yt_reels || site.tt_reels);
}

export function pageForSite(siteId: number, need?: 'posts' | 'reels' | 'collage'): FbPageRow | undefined {
  const flag =
    need === 'posts' ? 'AND p.posts = 1' : need === 'reels' ? 'AND p.reels = 1' : need === 'collage' ? 'AND p.collage = 1' : '';
  // A page set from an account's card (profile_id) is only as on as the account:
  // its toggle off means the page takes nothing, whatever its ticks say.
  // A page with no card (one synced from a Facebook token) counts only for a
  // site that has no cards at all: once a site has cards, they alone decide.
  // Such a page arrives with Reels ticked and is not shown among the cards,
  // so with every card off for reels it still took the site's reels.
  return get<FbPageRow>(
    `SELECT p.* FROM fb_pages p
      WHERE p.enabled = 1 AND p.site_id = ? ${flag}
        AND ${CARD_RULE}
      ORDER BY COALESCE((SELECT MAX(r.id) FROM reels r WHERE r.fb_page_id = p.id), 0), p.id
      LIMIT 1`,
    siteId,
  );
}

/**
 * The Facebook page an article's reel goes to: in rotation, the page of the
 * account the article's own photo post went to (saved on the run under
 * "facebook"), so a pizza reel and its pizza photo land on the same page.
 * Before this the reel had its own turn (pageForSite) next to the post's
 * account turn, and the two drifted apart -- the reel on page 1, the photo
 * on page 2. Falls back to the reel turn when the run has no Facebook account
 * yet, when that account's page has Reels unticked or is off, or when the
 * site posts to all (every page gets the reel then anyway).
 */
export function reelPageForRun(runId: number | null, siteId: number): FbPageRow | undefined {
  if (runId && !postsToAll(siteId, 'facebook')) {
    let chosen: Record<string, number> = {};
    try {
      chosen = JSON.parse(get<{ p: string }>('SELECT profiles_json AS p FROM runs WHERE id = ?', runId)?.p || '{}');
    } catch {
      chosen = {};
    }
    const profileId = chosen.facebook;
    if (profileId) {
      const page = get<FbPageRow>(
        `SELECT p.* FROM fb_pages p
          WHERE p.profile_id = ? AND p.site_id = ? AND p.enabled = 1 AND p.reels = 1
            AND ${CARD_RULE}
          ORDER BY (p.page_id = ?) DESC, p.id DESC
          LIMIT 1`,
        profileId,
        siteId,
        `profile:${profileId}`,
      );
      if (page) return page;
    }
  }
  return pageForSite(siteId, 'reels');
}

/**
 * The Facebook pages a site's articles reach, and whether any of them takes
 * posts, and whether any takes reels -- what the site's Facebook card says.
 */
export function facebookForSite(siteId: number): { pages: FbPageRow[]; posts: boolean; reels: boolean; collage: boolean } {
  // The pages that can take anything, by the same rule as pageForSite: an
  // account switched off, or a cardless page on a site with cards, does not
  // count -- so the card's header no longer says "reels" when none is made.
  const pages = all<FbPageRow>(`SELECT p.* FROM fb_pages p WHERE p.enabled = 1 AND p.site_id = ? AND ${CARD_RULE} ORDER BY p.name, p.id`, siteId);
  return {
    pages,
    posts: pages.some((p) => p.posts === 1),
    reels: pages.some((p) => p.reels === 1),
    collage: pages.some((p) => p.collage === 1),
  };
}

/**
 * Add a page by hand, for publishing through Buffer.
 *
 * Pages otherwise arrive from a Graph sync, which needs the very access
 * token the Buffer route exists to do without. Buffer holds the Facebook
 * connection itself, so all this row has to carry is a name to recognise it
 * by and the niche that decides which keywords reach it.
 *
 * The id is synthetic and marked as such: nothing publishes with it on this
 * route, and a made-up number that looked like a real page id would be worse
 * than one that plainly is not.
 */
export function addManualFbPage(input: { name: string; siteId?: number | null }): number {
  const name = input.name.trim();
  if (!name) throw new Error('A page needs a name.');

  const pageId = `manual:${slugishId(name)}`;

  if (get<{ id: number }>('SELECT id FROM fb_pages WHERE page_id = ?', pageId)) {
    throw new Error(`A page called "${name}" is already here.`);
  }

  run(
    `INSERT INTO fb_pages (page_id, name, token_id, site_id, auto_publish, enabled)
     VALUES (?, ?, NULL, ?, 1, 1)`,
    pageId,
    name,
    input.siteId && input.siteId > 0 ? input.siteId : null,
  );

  return get<{ id: number }>('SELECT id FROM fb_pages WHERE page_id = ?', pageId)?.id ?? 0;
}

function slugishId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return slug || 'page';
}

/** The token this page was found under. Empty when the page has none. */
export function fbPageToken(pageRowId: number, key: Buffer): string {
  const page = getFbPage(pageRowId);
  return page?.token_id ? fbTokenSecret(page.token_id, key) : '';
}

/** A real Facebook page id and a token that can act on it, for a Graph call. */
export interface FbGraphTarget {
  pageId: string;
  token: string;
}

/**
 * The real page id and token to make a Graph call for a page row -- a direct
 * publish, the comment-keyword private reply, or the id backfill.
 *
 * Two kinds of `fb_pages` row describe the same real Facebook page. A Buffer
 * account-card page (`page_id` = "profile:<id>") or a hand-added one
 * ("manual:<slug>") carries the site and the Posts/Reels/Collage flags but no
 * token and only a synthetic id, because Buffer held the connection. A row a
 * token sync brought in (under "Facebook tokens") carries the real numeric id
 * and a token, but not the site or the flags. Anything that talks to Graph
 * needs what only the second kind has, while the posting pipeline selects the
 * first kind (it is the one with the flags).
 *
 * This bridges them: a row that already has its own token and a real id is
 * returned as-is; a synthetic row is matched to a synced row for the same
 * real page -- by name first, then, failing that, by site when the site has
 * exactly one synced page. Nothing has to be re-entered once the token is
 * synced. `undefined` means there is no token that can reach this page, and
 * the caller skips the Graph step (a clear log line, never a thrown publish).
 */
export function resolveFbGraphTarget(pageRowId: number, key: Buffer): FbGraphTarget | undefined {
  const page = getFbPage(pageRowId);
  if (!page) return undefined;

  const synthetic = page.page_id.startsWith('profile:') || page.page_id.startsWith('manual:');
  if (page.token_id && !synthetic) {
    const token = fbTokenSecret(page.token_id, key);
    return token ? { pageId: page.page_id, token } : undefined;
  }

  const synced = all<FbPageRow>(
    `SELECT * FROM fb_pages
      WHERE token_id IS NOT NULL
        AND enabled = 1
        AND page_id NOT LIKE 'profile:%'
        AND page_id NOT LIKE 'manual:%'`,
  );
  if (synced.length === 0) return undefined;

  const name = page.name.trim().toLowerCase();
  const sameName = name ? synced.filter((p) => p.name.trim().toLowerCase() === name) : [];
  const sameSite = page.site_id !== null ? synced.filter((p) => p.site_id === page.site_id) : [];
  const pick =
    // A name match is the surest: the card's channel name is the page's name.
    sameName.find((p) => p.site_id === page.site_id) ??
    sameName.find((p) => p.site_id === null) ??
    sameName[0] ??
    // No name match: the site's own synced page, but only when there is
    // exactly one -- guessing between two would post to the wrong page.
    (sameSite.length === 1 ? sameSite[0] : undefined);

  if (!pick?.token_id) return undefined;
  const token = fbTokenSecret(pick.token_id, key);
  return token ? { pageId: pick.page_id, token } : undefined;
}

/**
 * The token for a real Facebook page id -- what a webhook entry carries. The
 * keyword handler uses it to ask Graph which video a post is, when the post id
 * in the comment event is not the id the reel was recorded under.
 */
export function fbGraphTargetByRealPageId(realPageId: string, key: Buffer): FbGraphTarget | undefined {
  const page = get<FbPageRow>(
    'SELECT * FROM fb_pages WHERE page_id = ? AND token_id IS NOT NULL AND enabled = 1',
    realPageId,
  );
  if (!page?.token_id) return undefined;
  const token = fbTokenSecret(page.token_id, key);
  return token ? { pageId: page.page_id, token } : undefined;
}

export type ReelStatus =
  | 'draft'
  | 'generating'
  | 'ready'
  | 'publishing'
  | 'published'
  | 'failed';

export interface ReelRow {
  id: number;
  run_id: number | null;
  site_id: number | null;
  keyword_id: number | null;
  fb_page_id: number | null;
  status: ReelStatus;
  prompt: string;
  caption: string;
  reference_json: string;
  job_id: string | null;
  video_url: string | null;
  fb_video_id: string | null;
  /** The word this reel asks readers to comment; null before per-post keywords. */
  trigger_keyword?: string | null;
  error: string | null;
  /** Which of the studio's stages an in-flight reel is on; 'done' past them all. */
  stage: ReelStage;
  /** The article, its images, and once planned the storyboard, as JSON. */
  plan_json: string;
  format: string;
  /** The assembled file, once there is one. */
  output_path: string;
  /** Where the reel went, channel by channel (Buffer route), as JSON. */
  channels_json?: string | null;
  /** Times it was retried on its own after a full Buffer queue. */
  auto_retries?: number;
  created_at: string;
  updated_at: string;
}

export type ReelStage = 'planning' | 'imaging' | 'filming' | 'assembling' | 'mixing' | 'done';

/** A reel with the names needed to render it, joined once rather than per row. */
export interface ReelView extends ReelRow {
  site_domain: string | null;
  seed_keyword: string | null;
  run_title: string | null;
  post_url: string | null;
  page_name: string | null;
  page_external_id: string | null;
}

const REEL_VIEW_SQL = `
  SELECT r.*, s.domain AS site_domain, k.seed_keyword,
         run.title AS run_title, run.post_url,
         p.name AS page_name, p.page_id AS page_external_id
    FROM reels r
    LEFT JOIN sites s     ON s.id = r.site_id
    LEFT JOIN keywords k  ON k.id = r.keyword_id
    LEFT JOIN runs run    ON run.id = r.run_id
    LEFT JOIN fb_pages p  ON p.id = r.fb_page_id
`;

export const listReels = (limit = 100): ReelView[] =>
  all<ReelView>(`${REEL_VIEW_SQL} ORDER BY r.created_at DESC LIMIT ?`, limit);

export const getReel = (id: number): ReelView | undefined =>
  get<ReelView>(`${REEL_VIEW_SQL} WHERE r.id = ?`, id);

/**
 * The reel a Facebook webhook comment belongs to, by the native video id
 * recorded when it published. This is how an incoming comment is matched
 * back to the article link it should send.
 */
export const getReelByFbVideoId = (fbVideoId: string): ReelView | undefined =>
  get<ReelView>(`${REEL_VIEW_SQL} WHERE r.fb_video_id = ?`, fbVideoId);

/**
 * Published reels still missing Facebook's own video id.
 *
 * A reel published through Buffer is recorded with Buffer's own post id in
 * `fb_video_id` (see `publishThroughBuffer`'s comment) -- Buffer queues the
 * post, so nothing at publish time can know what Facebook will assign it.
 * That id is never purely numeric (it is Buffer's internal GraphQL id, a
 * 24-character hex string); a real Facebook video or post id is. The GLOB
 * here is how a row asks to be matched up later, once the video is actually
 * live: empty, or containing anything other than a digit.
 */
export const reelsAwaitingNativeVideoId = (limit = 200): ReelView[] =>
  all<ReelView>(
    `${REEL_VIEW_SQL}
      WHERE r.status = 'published'
        AND r.fb_page_id IS NOT NULL
        AND (r.fb_video_id IS NULL OR r.fb_video_id = '' OR r.fb_video_id GLOB '*[^0-9]*')
      ORDER BY r.updated_at DESC
      LIMIT ?`,
    limit,
  );

/**
 * Feed posts: the article's own image post, and the photo collage.
 *
 * `reels` carries this for Reels because a reel borrows a published article's
 * assets and has a short life of its own; a feed post has neither, so instead
 * of a second near-empty copy of `reels`, this is the minimum the webhook
 * needs to go from a native Facebook post id back to the run that made it.
 */
export interface FbFeedPostRow {
  id: number;
  run_id: number | null;
  fb_page_id: number | null;
  purpose: 'facebook' | 'facebook-collage';
  buffer_post_id: string;
  fb_post_id: string | null;
  /** The word this post asks readers to comment; null before per-post keywords. */
  trigger_keyword?: string | null;
  created_at: string;
  updated_at: string;
}

/** A feed post with the names the webhook and the backfill need, joined once rather than per row. */
export interface FbFeedPostView extends FbFeedPostRow {
  post_url: string | null;
  page_name: string | null;
  page_external_id: string | null;
}

const FB_FEED_POST_VIEW_SQL = `
  SELECT f.*, run.post_url, p.name AS page_name, p.page_id AS page_external_id
    FROM fb_feed_posts f
    LEFT JOIN runs run   ON run.id = f.run_id
    LEFT JOIN fb_pages p ON p.id = f.fb_page_id
`;

/**
 * Record one feed post the moment Buffer schedules it -- not at the end of
 * the step -- the same reasoning as `markFanoutPosted`: this is the only
 * record of it until the backfill finds its real id, so losing the row to an
 * early return would make that id unreachable for the webhook forever.
 */
export function recordFbFeedPost(input: {
  runId: number | null;
  fbPageId: number | null;
  purpose: 'facebook' | 'facebook-collage';
  bufferPostId: string;
  triggerKeyword?: string | null;
}): void {
  // Best-effort: the post is already scheduled by the time this is called,
  // and the only thing this row is for is letting the webhook find it later
  // -- not something worth failing an otherwise-successful publish over, the
  // same as `fanoutPosted`'s own try/catch a few lines up.
  try {
    run(
      'INSERT INTO fb_feed_posts (run_id, fb_page_id, purpose, buffer_post_id, trigger_keyword) VALUES (?, ?, ?, ?, ?)',
      input.runId,
      input.fbPageId,
      input.purpose,
      input.bufferPostId,
      input.triggerKeyword ?? null,
    );
  } catch {
    // no database behind a test context, or run_id/fb_page_id do not (yet) exist
  }
}

/**
 * Feed posts still waiting on their real Facebook post id.
 *
 * Unlike `reels.fb_video_id`, which has to hold Buffer's placeholder id and
 * the real one in the same column (and so tells them apart with a GLOB, since
 * a video id is plain numeric and Buffer's is not), `fb_feed_posts` keeps
 * Buffer's id in its own column -- `fb_post_id` is simply NULL until
 * something resolves it. A real feed post id ("<page id>_<post id>") is not
 * numeric either, which is exactly why that column needed to be separate here.
 */
export const fbFeedPostsAwaitingNativeId = (limit = 200): FbFeedPostView[] =>
  all<FbFeedPostView>(
    `${FB_FEED_POST_VIEW_SQL}
      WHERE f.fb_page_id IS NOT NULL
        AND f.fb_post_id IS NULL
      ORDER BY f.updated_at DESC
      LIMIT ?`,
    limit,
  );

/**
 * Record a feed post published directly through Graph API, where the real
 * Facebook post id is already known the moment this is called -- there is
 * nothing for `backfillNativeFeedPostIds` to do, so `fb_post_id` is written
 * immediately instead of being left for it to fill in later. The direct
 * counterpart to `recordFbFeedPost` (the Buffer path).
 */
export function recordFbFeedPostResolved(input: {
  runId: number | null;
  fbPageId: number | null;
  purpose: 'facebook' | 'facebook-collage';
  fbPostId: string;
  triggerKeyword?: string | null;
}): void {
  try {
    run(
      'INSERT INTO fb_feed_posts (run_id, fb_page_id, purpose, buffer_post_id, fb_post_id, trigger_keyword) VALUES (?, ?, ?, ?, ?, ?)',
      input.runId,
      input.fbPageId,
      input.purpose,
      input.fbPostId,
      input.fbPostId,
      input.triggerKeyword ?? null,
    );
  } catch {
    // no database behind a test context, or run_id/fb_page_id do not (yet) exist
  }
}

export function setFbFeedPostNativeId(id: number, fbPostId: string): void {
  run(
    "UPDATE fb_feed_posts SET fb_post_id = ?, updated_at = datetime('now') WHERE id = ?",
    fbPostId,
    id,
  );
}

/**
 * The feed post a Facebook webhook comment belongs to, by the native post id
 * recorded on it once the backfill resolves it. The counterpart to
 * `getReelByFbVideoId`, for an image post or a collage rather than a reel.
 */
export const getFbFeedPostByNativeId = (fbPostId: string): FbFeedPostView | undefined =>
  get<FbFeedPostView>(`${FB_FEED_POST_VIEW_SQL} WHERE f.fb_post_id = ?`, fbPostId);

/** Reels the scheduler still has work to do on. */
export const activeReels = (): ReelView[] =>
  all<ReelView>(
    `${REEL_VIEW_SQL} WHERE r.status IN ('generating', 'ready', 'publishing')
      ORDER BY r.created_at`,
  );

export function createReel(input: {
  runId: number | null;
  siteId: number;
  keywordId: number;
  fbPageId: number | null;
  prompt: string;
  caption: string;
  references: string[];
  /** A studio reel starts on a stage; a one-shot reel has none and is a draft. */
  stage?: ReelStage;
}): number {
  run(
    `INSERT INTO reels (run_id, site_id, keyword_id, fb_page_id, prompt, caption, reference_json,
                        status, stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.runId,
    input.siteId,
    input.keywordId,
    input.fbPageId,
    input.prompt,
    input.caption,
    JSON.stringify(input.references),
    input.stage ? 'generating' : 'draft',
    input.stage ?? 'done',
  );
  return get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0;
}

/**
 * Move a reel along.
 *
 * One writer for every transition so `updated_at` cannot be forgotten -- the
 * scheduler uses it to spot a reel that stopped moving.
 */
export function updateReel(
  id: number,
  fields: Partial<{
    status: ReelStatus;
    jobId: string | null;
    videoUrl: string | null;
    fbVideoId: string | null;
    fbPageId: number | null;
    caption: string;
    triggerKeyword: string | null;
    error: string | null;
  }>,
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  const column: Record<string, string> = {
    status: 'status',
    jobId: 'job_id',
    videoUrl: 'video_url',
    fbVideoId: 'fb_video_id',
    fbPageId: 'fb_page_id',
    caption: 'caption',
    triggerKeyword: 'trigger_keyword',
    error: 'error',
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    sets.push(`${column[key]} = ?`);
    // Errors are truncated here rather than at every call site: a stack trace
    // pasted into this column is worth reading, not worth storing whole.
    values.push(key === 'error' && typeof value === 'string' ? value.slice(0, 1000) : value);
  }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  run(`UPDATE reels SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
}

/**
 * Empty the history Home shows: every finished article run and reel. What is
 * running or being published stays, so nothing in flight loses its row.
 */
export function clearHistory(): { runs: number; reels: number } {
  const reels = run("DELETE FROM reels WHERE status IN ('draft', 'ready', 'published', 'failed')").changes;
  const runs = run("DELETE FROM runs WHERE status <> 'running'").changes;
  return { runs: Number(runs), reels: Number(reels) };
}

/** Reels made for a site in the last `hours` hours (discarded ones are gone and do not count). */
export const reelsCreatedRecently = (siteId: number, hours: number): number =>
  get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM reels WHERE site_id = ? AND created_at >= datetime('now', ?)",
    siteId,
    `-${Math.max(0, hours)} hours`,
  )?.n ?? 0;

/**
 * Discard every reel still being made (no video yet), and keep every reel
 * whose video exists, whatever its state: those cost nothing more to publish.
 * Stops a runaway batch from spending more Flow credits without wasting what
 * was already made.
 */
export const discardUnfinishedReels = (): number =>
  run(
    `DELETE FROM reels WHERE status IN ('draft', 'generating')
       AND COALESCE(video_url, '') = '' AND COALESCE(output_path, '') = ''`,
  ).changes;

export const deleteReel = (id: number): void => {
  run('DELETE FROM reels WHERE id = ?', id);
};

/** Runs that could become a reel: published, with images, and not used yet. */
export interface ReelCandidate {
  run_id: number;
  site_id: number;
  keyword_id: number;
  site_domain: string;
  seed_keyword: string;
  spy_title: string;
  spy_description: string;
  annotation: string;
  title: string;
  post_url: string | null;
  published_at: string | null;
  images_json: string | null;
}

/**
 * Published articles with their four images still available.
 *
 * The images come from the generate-images checkpoint rather than from
 * keyword_images, because the latter only holds a row when sharing is on --
 * and a site that generated its own images has just as much to make a reel
 * from. A run whose checkpoint is gone simply does not appear.
 */
export const reelCandidates = (limit = 50): ReelCandidate[] =>
  all<ReelCandidate>(
    `SELECT r.id AS run_id, r.site_id, r.keyword_id, s.domain AS site_domain,
            k.seed_keyword, k.spy_title, k.spy_description, k.annotation,
            r.title, r.post_url, r.published_at,
            st.output_json AS images_json
       FROM runs r
       JOIN sites s     ON s.id = r.site_id
       JOIN keywords k  ON k.id = r.keyword_id
       JOIN run_steps st ON st.run_id = r.id
                        AND st.step = 'generate-images'
                        AND st.status = 'ok'
      WHERE r.status = 'published'
        AND r.reel_dismissed = 0
        AND NOT EXISTS (SELECT 1 FROM reels x WHERE x.run_id = r.id)
      ORDER BY r.published_at DESC
      LIMIT ?`,
    limit,
  );

/** Take articles off the "Make a reel from" list. The articles themselves are untouched. */
export const dismissReelCandidates = (runIds: number[] | 'all'): number => {
  if (runIds === 'all') {
    return Number(run(
      `UPDATE runs SET reel_dismissed = 1
        WHERE status = 'published' AND reel_dismissed = 0
          AND NOT EXISTS (SELECT 1 FROM reels x WHERE x.run_id = runs.id)`,
    ).changes);
  }
  let n = 0;
  for (const id of runIds) n += Number(run('UPDATE runs SET reel_dismissed = 1 WHERE id = ?', id).changes);
  return n;
};

/* -- Presenters ------------------------------------------------------------ */

export interface PresenterRow {
  id: number;
  name: string;
  flow_character_id: string;
  flow_voice_id: string;
  voice_description: string;
  portrait_url: string;
  created_at: string;
}

export const listPresenters = (): PresenterRow[] =>
  all<PresenterRow>('SELECT * FROM presenters ORDER BY name');

export const getPresenter = (id: number): PresenterRow | undefined =>
  get<PresenterRow>('SELECT * FROM presenters WHERE id = ?', id);

export function insertPresenter(input: {
  name: string;
  flowCharacterId: string;
  flowVoiceId: string;
  voiceDescription: string;
  portraitUrl: string;
}): number {
  const name = input.name.trim();
  if (!name) throw new Error('A presenter needs a name.');
  if (!input.flowCharacterId.trim()) throw new Error('A presenter needs a character.');
  return run(
    `INSERT INTO presenters (name, flow_character_id, flow_voice_id, voice_description, portrait_url)
     VALUES (?, ?, ?, ?, ?)`,
    name,
    input.flowCharacterId.trim(),
    input.flowVoiceId.trim(),
    input.voiceDescription.trim(),
    input.portraitUrl.trim(),
  ).lastInsertRowid;
}

export function updatePresenter(
  id: number,
  fields: Partial<{ name: string; voiceDescription: string; portraitUrl: string }>,
): void {
  if (fields.name !== undefined) {
    run('UPDATE presenters SET name = ? WHERE id = ?', fields.name.trim(), id);
  }
  if (fields.voiceDescription !== undefined) {
    run('UPDATE presenters SET voice_description = ? WHERE id = ?', fields.voiceDescription.trim(), id);
  }
  if (fields.portraitUrl !== undefined) {
    run('UPDATE presenters SET portrait_url = ? WHERE id = ?', fields.portraitUrl.trim(), id);
  }
}

/** ALTER-added foreign keys are not enforced by SQLite, so the pages are cleared here. */
export function deletePresenter(id: number): void {
  run('UPDATE fb_pages SET presenter_id = NULL WHERE presenter_id = ?', id);
  run('DELETE FROM presenters WHERE id = ?', id);
}

export const setFbPagePresenter = (pageRowId: number, presenterId: number | null): void => {
  run('UPDATE fb_pages SET presenter_id = ? WHERE id = ?', presenterId, pageRowId);
};

export const presenterForPage = (pageRowId: number): PresenterRow | undefined =>
  get<PresenterRow>(
    'SELECT p.* FROM presenters p JOIN fb_pages f ON f.presenter_id = p.id WHERE f.id = ?',
    pageRowId,
  );

/* -- Reel stages and scenes ------------------------------------------------ */

/**
 * Reels that failed only because every Buffer queue was full, last touched
 * long enough ago for Buffer to have published some, and not retried on their
 * own too often yet. They have their video; publishing is all that is left.
 */
export function reelsToRetryForFullBuffer(waitHours: number, maxRetries: number): ReelView[] {
  return all<ReelView>(
    `${REEL_VIEW_SQL} WHERE r.status = 'failed'
        AND (r.error LIKE '%All Buffer accounts are full%' OR r.error LIKE '%Scheduled posts limit reached%')
        AND (COALESCE(r.video_url, '') <> '' OR COALESCE(r.output_path, '') <> '')
        AND COALESCE(r.auto_retries, 0) < ?
        AND r.updated_at <= datetime('now', ?)`,
    maxRetries,
    `-${Math.max(1, Math.floor(waitHours))} hours`,
  );
}

export function markReelAutoRetry(id: number): void {
  run(
    "UPDATE reels SET status = 'ready', error = NULL, auto_retries = COALESCE(auto_retries, 0) + 1, updated_at = datetime('now') WHERE id = ?",
    id,
  );
}

export function setReelChannels(reelId: number, json: string): void {
  run("UPDATE reels SET channels_json = ?, updated_at = datetime('now') WHERE id = ?", json, reelId);
}

export function setReelStage(
  reelId: number,
  stage: ReelStage,
  fields: Partial<{ planJson: string; format: string; outputPath: string }> = {},
): void {
  run(
    `UPDATE reels SET stage = ?, updated_at = datetime('now'),
       plan_json   = COALESCE(?, plan_json),
       format      = COALESCE(?, format),
       output_path = COALESCE(?, output_path)
     WHERE id = ?`,
    stage,
    fields.planJson ?? null,
    fields.format ?? null,
    fields.outputPath ?? null,
    reelId,
  );
}

export interface ReelSceneRow {
  id: number;
  reel_id: number;
  position: number;
  seconds: number;
  presenter: 0 | 1;
  sources_json: string;
  image_prompt: string;
  motion_prompt: string;
  line: string;
  image_job_id: string | null;
  image_url: string | null;
  clip_job_id: string | null;
  clip_path: string | null;
  status: 'pending' | 'working' | 'done' | 'failed';
  error: string | null;
}

export const listScenes = (reelId: number): ReelSceneRow[] =>
  all<ReelSceneRow>('SELECT * FROM reel_scenes WHERE reel_id = ? ORDER BY position', reelId);

export const getScene = (id: number): ReelSceneRow | undefined =>
  get<ReelSceneRow>('SELECT * FROM reel_scenes WHERE id = ?', id);

export function replaceScenes(
  reelId: number,
  scenes: Array<{
    seconds: number;
    presenter: boolean;
    sources: string[];
    imagePrompt: string;
    motionPrompt: string;
    line: string;
  }>,
): void {
  run('DELETE FROM reel_scenes WHERE reel_id = ?', reelId);
  scenes.forEach((scene, index) => {
    run(
      `INSERT INTO reel_scenes
         (reel_id, position, seconds, presenter, sources_json, image_prompt, motion_prompt, line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      reelId,
      index + 1,
      scene.seconds,
      scene.presenter ? 1 : 0,
      JSON.stringify(scene.sources),
      scene.imagePrompt,
      scene.motionPrompt,
      scene.line,
    );
  });
}

export function updateScene(
  id: number,
  fields: Partial<{
    status: ReelSceneRow['status'];
    error: string | null;
    imageJobId: string | null;
    imageUrl: string | null;
    clipJobId: string | null;
    clipPath: string | null;
  }>,
): void {
  const column: Record<string, string> = {
    status: 'status',
    error: 'error',
    imageJobId: 'image_job_id',
    imageUrl: 'image_url',
    clipJobId: 'clip_job_id',
    clipPath: 'clip_path',
  };
  const sets: string[] = [];
  const values: (string | null)[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    sets.push(`${column[key]} = ?`);
    values.push(value as string | null);
  }
  if (sets.length === 0) return;
  run(`UPDATE reel_scenes SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
}

/** The formats this page's last reels used, newest first, for the rotation. */
export const recentFormatsForPage = (pageRowId: number, limit = 4): string[] =>
  all<{ format: string }>(
    `SELECT format FROM reels WHERE fb_page_id = ? AND format != ''
      ORDER BY id DESC LIMIT ?`,
    pageRowId,
    limit,
  ).map((r) => r.format);
