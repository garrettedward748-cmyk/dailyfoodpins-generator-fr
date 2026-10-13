/**
 * One Facebook post, whichever provider fetched it.
 *
 * The providers disagree about field names and agree about nothing else, so
 * the shape they are both reduced to lives here, next to the reducing. The
 * rest of the radar never sees a provider's own record.
 */
export interface SocialPost {
  /** The provider's id for the post: what stops the same post arriving twice. */
  postId: string;
  url: string;
  text: string;
  /** ISO date, or '' when the provider gave nothing usable. */
  postedAt: string;
  likes: number;
  comments: number;
  shares: number;
}

/** A page as its address names it, from a handle, a URL, or a pasted profile link. */
export function handleOf(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  if (!/facebook\.com/i.test(raw)) return raw.replace(/^@/, '').replace(/\/+$/, '');
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const parts = url.pathname.split('/').filter(Boolean);
    // /profile.php?id=123 has no handle; the numeric id is the handle.
    if (parts[0] === 'profile.php') return url.searchParams.get('id') ?? '';
    // /people/Some-Name/100012345 -> the id at the end.
    if (parts[0] === 'people' && parts.length >= 3) return parts[2]!;
    return parts[0] ?? '';
  } catch {
    return raw.replace(/^@/, '').replace(/\/+$/, '');
  }
}

export const pageUrl = (handle: string): string => `https://www.facebook.com/${handleOf(handle)}/`;

const num = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  if (typeof value !== 'string') return 0;
  // "1.2K", "3,405", "2.1M" — what a scraper reads off the page when the
  // provider has no number of its own.
  const match = value.replace(/,/g, '').match(/^([\d.]+)\s*([KkMm])?/);
  if (!match) return 0;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  const scale = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1;
  return Math.max(0, Math.round(base * scale));
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const isoDate = (value: unknown): string => {
  const raw = text(value);
  if (!raw) return '';
  const at = Date.parse(raw);
  return Number.isFinite(at) ? new Date(at).toISOString() : '';
};

type Raw = Record<string, unknown>;

/**
 * Bright Data's Facebook post record.
 *
 * Its likes live in `num_likes_type.num` rather than a plain number, and
 * `likes` is a separate field that is sometimes there and sometimes not —
 * hence both, highest wins.
 */
export function normalizeBrightData(raw: Raw): SocialPost {
  const likesType = raw['num_likes_type'];
  const nested = likesType && typeof likesType === 'object' ? (likesType as Raw)['num'] : undefined;
  return {
    postId: text(raw['post_id']) || text(raw['id']),
    url: text(raw['url']),
    text: text(raw['content']) || text(raw['post_text']),
    postedAt: isoDate(raw['date_posted']),
    likes: Math.max(num(nested), num(raw['likes'])),
    comments: num(raw['num_comments']),
    shares: num(raw['num_shares']),
  };
}

/**
 * Apify's Facebook post record.
 *
 * Apify is a marketplace: each actor names its own output, and an actor can
 * rename a field between versions. Every plausible spelling is accepted
 * rather than pinning the radar to one actor's current release.
 */
export function normalizeApify(raw: Raw): SocialPost {
  const first = (...keys: string[]): unknown => keys.map((k) => raw[k]).find((v) => v !== undefined && v !== null && v !== '');
  return {
    postId: text(first('postId', 'post_id', 'id', 'facebookId')),
    url: text(first('url', 'postUrl', 'link', 'topLevelUrl')),
    text: text(first('text', 'message', 'postText', 'content')),
    postedAt: isoDate(first('time', 'date', 'timestamp', 'publishedAt', 'date_posted')),
    likes: num(first('likes', 'likesCount', 'reactionsCount', 'num_likes')),
    comments: num(first('comments', 'commentsCount', 'num_comments')),
    shares: num(first('shares', 'sharesCount', 'num_shares')),
  };
}

/**
 * How loud a post was.
 *
 * Not raw likes. A like costs a thumb and says "seen"; a comment costs a
 * sentence and a share costs the sharer's own feed — the one that actually
 * predicts whether the subject travels. Weighted accordingly, so a post with
 * 200 likes and nothing else loses to one with 40 likes and 30 shares.
 *
 * The weights are what make that sentence true rather than merely hoped for:
 * at 3 and 5 it was false by ten points, which is how it was noticed.
 */
export const engagementScore = (post: SocialPost): number =>
  Math.round(post.likes + post.comments * 4 + post.shares * 10);

/** Worth showing at all: it has an id and enough words to carry an idea. */
export const usable = (post: SocialPost): boolean =>
  post.postId.trim().length > 0 && post.text.split(/\s+/).filter(Boolean).length >= 5;
