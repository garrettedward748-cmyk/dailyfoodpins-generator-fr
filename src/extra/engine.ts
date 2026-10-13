import { sitePostUrl } from '../core/social-only.js';
import { all, get, run } from '../db/index.js';
import {
  getCompletedStep,
  getKeyword,
  getSite,
  pageForSite,
  type SiteRow,
} from '../db/repos.js';
import { PipelineContext } from '../pipeline/context.js';
import { runStep, type Step } from '../pipeline/engine.js';
import { HALAL_RULE, halalOnly, haramIn } from '../core/halal.js';
import { generatePinImage } from '../pipeline/steps/images.js';
import { publishToBuffer, resolveBufferTarget } from '../pipeline/steps/publish.js';
import { facebookPostStep } from '../pipeline/steps/facebook-post.js';
import { instagramPostStep } from '../pipeline/steps/instagram-post.js';
import type { ImagePromptSet, SeoData } from '../pipeline/steps/content.js';
import { parseJson } from '../pipeline/json.js';
import { captionShape, listCaptionStructures, parseCaptionNetworks, pickCaptionStructure, siteCaptionHistory, withSiteOverrides } from '../core/caption-structures.js';
import { parseFacebookLinkMode, type FacebookLinkMode } from '../reels/recipe-text.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';

const log = createLogger('more-posts');

/**
 * Content -> More posts: new posts for a recipe that is already published.
 *
 * The article is not written again. A new picture (the pin graphic rotates to
 * another design), new words from a new angle, and the same Buffer route the
 * first posts took. Each batch keeps its checkpoints in a run row of its own,
 * so the original article's record is never touched and none of the site's
 * publishing counters move.
 */

export type Network = 'pinterest' | 'facebook' | 'instagram';
export const NETWORKS: readonly Network[] = ['pinterest', 'facebook', 'instagram'];

export interface Angle {
  id: string;
  label: string;
  brief: string;
}

export const ANGLES: readonly Angle[] = [
  { id: 'weeknight', label: 'Quick weeknight', brief: 'how fast and easy it is on a busy evening' },
  { id: 'make-ahead', label: 'Make-ahead', brief: 'it can be made in advance, so the day itself is calm' },
  { id: 'party', label: 'Party / gift', brief: 'bringing it to a gathering, a holiday table or giving it as a gift' },
  { id: 'swaps', label: 'Ingredient swaps', brief: 'easy swaps and small variations to make it your own' },
  { id: 'storage', label: 'Storage tips', brief: 'how to keep it, how long it lasts, and whether it freezes' },
  { id: 'texture', label: 'Taste and texture', brief: 'the first bite: the taste, the texture, what makes it special' },
];

/**
 * The angle for this round: the one asked for, or when left on automatic the
 * first one not used yet for this recipe, and once all are used the one used
 * the fewest times (the earliest in the list on a tie).
 */
export function pickAngle(choice: string, used: string[]): Angle {
  const asked = ANGLES.find((a) => a.id === choice);
  if (asked) return asked;
  const counts = new Map<string, number>();
  for (const id of used) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...ANGLES].sort((a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0))[0]!;
}

/* -- What can be posted again ---------------------------------------------- */

export interface PublishedRecipe {
  runId: number;
  siteId: number;
  siteDomain: string;
  keywordId: number | null;
  title: string;
  postUrl: string;
  publishedAt: string;
}

/** Published articles, newest first. A More posts batch is never listed: its run row is not 'published'. */
export function listPublishedRecipes(siteId?: number, limit = 300, hidden: 'exclude' | 'only' | 'all' = 'exclude'): PublishedRecipe[] {
  return all<{
    id: number; site_id: number; domain: string; keyword_id: number | null; title: string; post_url: string; published_at: string;
  }>(
    `SELECT r.id, r.site_id, s.domain, r.keyword_id, r.title, r.post_url, r.published_at
       FROM runs r JOIN sites s ON s.id = r.site_id
      WHERE r.status = 'published' AND r.mode = 'live' AND r.post_url IS NOT NULL AND r.post_url != ''
        ${siteId ? 'AND r.site_id = ?' : ''}
        ${hidden === 'exclude' ? 'AND r.id NOT IN (SELECT run_id FROM extra_hidden)' : hidden === 'only' ? 'AND r.id IN (SELECT run_id FROM extra_hidden)' : ''}
      ORDER BY r.id DESC LIMIT ?`,
    ...(siteId ? [siteId, limit] : [limit]),
  ).map((r) => ({
    runId: r.id,
    siteId: r.site_id,
    siteDomain: r.domain,
    keywordId: r.keyword_id,
    title: r.title || r.post_url,
    postUrl: r.post_url,
    publishedAt: r.published_at,
  }));
}

const toMs = (sql: string | null | undefined): number | null => {
  if (!sql) return null;
  const t = Date.parse(`${sql.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
};

/** Take recipes off the More posts list and out of the automatic mode, or bring them back. The articles are untouched. */
export function setRecipesHidden(runIds: number[], hidden: boolean): number {
  let n = 0;
  for (const id of runIds) {
    n += hidden
      ? run('INSERT OR IGNORE INTO extra_hidden (run_id) VALUES (?)', id).changes
      : run('DELETE FROM extra_hidden WHERE run_id = ?', id).changes;
  }
  return n;
}

/** Hide the recipes of a site (or all) published more than this many days ago. */
export function hideOlderThan(days: number, siteId?: number): number {
  const rows = all<{ id: number }>(
    `SELECT r.id FROM runs r WHERE r.status = 'published' AND r.mode = 'live' AND r.published_at < datetime('now', ?)
       ${siteId ? 'AND r.site_id = ?' : ''}`,
    ...(siteId ? [`-${Math.max(0, Math.floor(days))} days`, siteId] : [`-${Math.max(0, Math.floor(days))} days`]),
  );
  return setRecipesHidden(rows.map((r) => r.id), true);
}

export const hiddenCount = (): number => get<{ n: number }>('SELECT COUNT(*) AS n FROM extra_hidden')?.n ?? 0;

/** When a recipe last went to a network: its first posts count, and so does every More posts batch. */
export function lastPostedAt(sourceRunId: number, network: Network): string | null {
  const first = get<{ at: string | null }>('SELECT published_at AS at FROM runs WHERE id = ?', sourceRunId)?.at ?? null;
  const extra =
    get<{ at: string | null }>(
      "SELECT MAX(created_at) AS at FROM extra_posts WHERE source_run_id = ? AND network = ? AND status = 'ok'",
      sourceRunId,
      network,
    )?.at ?? null;
  return [first, extra].filter((x): x is string => Boolean(x)).sort().pop() ?? null;
}

export const usedAngles = (sourceRunId: number): string[] =>
  all<{ angle: string }>("SELECT angle FROM extra_posts WHERE source_run_id = ? AND status = 'ok'", sourceRunId).map((r) => r.angle);

export interface NetworkState {
  network: Network;
  /** Switched on for this site, so it can be offered at all. */
  available: boolean;
  /** Why it cannot be offered, or must wait. */
  reason: string;
  lastAt: string | null;
  /** Days still to wait before another post; 0 when ready. */
  waitDays: number;
  ready: boolean;
}

export function gapDays(settings: Settings): number {
  const n = Math.floor(settings.getNumber('extra_post_gap_days'));
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

export function networkStates(settings: Settings, site: SiteRow, sourceRunId: number, now = Date.now()): NetworkState[] {
  const gap = gapDays(settings);
  return NETWORKS.map((network) => {
    let available = true;
    let reason = '';
    if (network === 'pinterest') {
      if ((site as { pin_posts?: number }).pin_posts === 0) {
        available = false;
        reason = 'Pinterest posts are off for this site';
      } else if (!settings.getBool('buffer_enabled')) {
        available = false;
        reason = 'Buffer is off in Settings';
      }
    } else if (network === 'facebook') {
      if (!settings.getBool('fb_enabled') || !pageForSite(site.id, 'posts')) {
        available = false;
        reason = 'no Facebook page of this site takes posts';
      }
    } else if (!(site as { ig_posts?: number }).ig_posts) {
      available = false;
      reason = 'Instagram posts are off for this site';
    }
    const lastAt = lastPostedAt(sourceRunId, network);
    const last = toMs(lastAt);
    const waitDays = last === null ? 0 : Math.max(0, Math.ceil((last + gap * 86_400_000 - now) / 86_400_000));
    if (available && waitDays > 0) reason = `wait ${waitDays} more day${waitDays === 1 ? '' : 's'}`;
    return { network, available, reason, lastAt, waitDays, ready: available && waitDays === 0 };
  });
}

/* -- Making a batch ------------------------------------------------------- */

interface ExtraTexts {
  pin_title: string;
  pin_description: string;
  facebook_text: string;
  instagram_caption: string;
}

/** Steps whose stored output the posting steps read, copied into the batch's own run. */
const COPIED_STEPS = ['validate-spy', 'generate-recipe', 'generate-article', 'post-article', 'generate-image-prompts', 'generate-images'];

/**
 * The next caption shape for a site's More posts (Setup -> Caption structures), never one of its last three.
 * What the reels used counts too, so a page's feed does not read the same from either source.
 */
function nextExtraShape(siteId: number): { id: number | null; body: string } {
  try {
    const mine = all<{ id: number }>(
      'SELECT shape_id AS id FROM extra_posts WHERE site_id = ? AND shape_id IS NOT NULL GROUP BY run_id ORDER BY MAX(id) DESC LIMIT 3',
      siteId,
    ).map((r) => r.id);
    const uses: Record<number, number> = {};
    for (const r of all<{ id: number; n: number }>('SELECT shape_id AS id, COUNT(DISTINCT run_id) AS n FROM extra_posts WHERE site_id = ? AND shape_id IS NOT NULL GROUP BY shape_id', siteId)) uses[r.id] = r.n;
    const reels = siteCaptionHistory(siteId);
    for (const [id, n] of Object.entries(reels.uses)) uses[Number(id)] = (uses[Number(id)] ?? 0) + n;
    const chosen = pickCaptionStructure(listCaptionStructures(siteId), [...mine, ...reels.recent].slice(0, 3), uses, siteId);
    return { id: chosen?.id ?? null, body: captionShape(chosen) };
  } catch {
    return { id: null, body: captionShape(null) };
  }
}

/** The words for every network at once, from one angle: coherent, and one model call. */
const writeExtraTexts: Step<{ seo: SeoData; angle: Angle; shapeRule: string }, ExtraTexts> = {
  name: 'extra-texts',
  title: 'Write the new posts',
  async run(ctx, input) {
    const ask = async (extra: string) =>
      ctx.prompt('extra-post', {
        site: { name: ctx.site.name },
        seo: input.seo,
        angle: input.angle,
        shapeRule: input.shapeRule,
        halal: halalOnly() ? `${HALAL_RULE}${extra}` : extra,
      });

    const read = (content: string): ExtraTexts => {
      const v = parseJson(content, 'the new posts') as Partial<ExtraTexts>;
      for (const f of ['pin_title', 'pin_description', 'facebook_text', 'instagram_caption'] as const) {
        if (typeof v[f] !== 'string' || !v[f]!.trim()) throw new Error(`The model's answer had no ${f}`);
      }
      return {
        pin_title: v.pin_title!.trim(),
        pin_description: v.pin_description!.trim().slice(0, 480),
        facebook_text: v.facebook_text!.trim(),
        instagram_caption: v.instagram_caption!.trim(),
      };
    };

    let result = await ask('');
    let texts = read(result.content);
    const haram = haramIn(texts);
    if (haram) {
      result = await ask(`\nYOUR LAST DRAFT USED “${haram}”, WHICH IS NOT ALLOWED. Write it again without it.`);
      texts = read(result.content);
      const still = haramIn(texts);
      if (still) throw new Error(`The new posts name “${still}” (Halal only); not posted.`);
    }
    return { value: texts, endpoint: result.endpoint, model: result.model };
  },
};

export interface ExtraRequest {
  sourceRunId: number;
  networks: Network[];
  /** An angle id, or 'auto'. */
  angle: string;
  /** Made by the scheduler rather than by a person. */
  auto?: boolean;
}

export interface ExtraOutcome {
  network: Network;
  ok: boolean;
  detail: string;
}

export interface ExtraReport {
  angle: Angle;
  outcomes: ExtraOutcome[];
}

const stepOutput = <T>(runId: number, step: string): T | undefined => {
  const done = getCompletedStep(runId, step);
  try {
    return done?.output_json ? (JSON.parse(done.output_json) as T) : undefined;
  } catch {
    return undefined;
  }
};

/** Why a request cannot start, or null when it can. Checked before anything is spent. */
export function checkRequest(settings: Settings, req: ExtraRequest, now = Date.now()): string | null {
  const source = get<{ site_id: number | null; status: string; post_url: string | null }>(
    'SELECT site_id, status, post_url FROM runs WHERE id = ?',
    req.sourceRunId,
  );
  if (!source || source.status !== 'published' || !source.post_url) return 'That recipe is not published.';
  const site = source.site_id ? getSite(source.site_id) : undefined;
  if (!site) return 'The site of that recipe no longer exists.';
  if (req.networks.length === 0) return 'Tick at least one network.';
  const states = networkStates(settings, site, req.sourceRunId, now);
  for (const network of req.networks) {
    const state = states.find((s) => s.network === network)!;
    if (!state.ready) return `${network[0]!.toUpperCase()}${network.slice(1)}: ${state.reason || 'not ready'}.`;
  }
  return null;
}

/**
 * Make and schedule the new posts. The caller holds the run lock.
 *
 * One network failing does not stop the others; every outcome is recorded.
 */
export async function makeExtraPosts(req: ExtraRequest, settings: Settings, encryptionKey: Buffer): Promise<ExtraReport> {
  const problem = checkRequest(settings, req);
  if (problem) throw new Error(problem);

  const source = get<{ site_id: number; keyword_id: number | null }>('SELECT site_id, keyword_id FROM runs WHERE id = ?', req.sourceRunId)!;
  const site = getSite(source.site_id)!;
  const keyword = source.keyword_id ? getKeyword(source.keyword_id) : undefined;
  if (!keyword) throw new Error('The keyword of this recipe no longer exists.');

  const seo = stepOutput<SeoData>(req.sourceRunId, 'validate-spy');
  const posted = stepOutput<Record<string, unknown>>(req.sourceRunId, 'post-article');
  const prompts = stepOutput<ImagePromptSet>(req.sourceRunId, 'generate-image-prompts');
  const images = stepOutput<{ hero?: string; stepA?: string; stepB?: string; stepC?: string }>(req.sourceRunId, 'generate-images');
  if (!seo || !posted) throw new Error('This recipe has no stored article details to post from.');

  const angle = pickAngle(req.angle, usedAngles(req.sourceRunId));
  const title = get<{ title: string }>('SELECT title FROM runs WHERE id = ?', req.sourceRunId)?.title || seo.title;
  const postUrl = sitePostUrl(site, String(posted.href ?? ""));

  // The batch's own run row. 'cancelled' so it is neither published nor failed; started long ago
  // and with no keyword, so the site's turn order and the keyword groups' rotation never see it.
  const batchRunId = run(
    `INSERT INTO runs (keyword_id, site_id, status, mode, started_at, finished_at, title)
     VALUES (NULL, ?, 'cancelled', 'live', '2000-01-01 00:00:00', datetime('now'), ?)`,
    site.id,
    `More posts · ${angle.label} · ${title}`,
  ).lastInsertRowid;
  for (const step of COPIED_STEPS) {
    run(
      `INSERT INTO run_steps (run_id, step, status, started_at, finished_at, output_json)
       SELECT ?, step, 'ok', started_at, finished_at, output_json FROM run_steps WHERE run_id = ? AND step = ? AND status = 'ok'`,
      batchRunId,
      req.sourceRunId,
      step,
    );
  }

  const ctx = new PipelineContext({
    runId: batchRunId,
    site,
    keyword,
    settings,
    encryptionKey,
    shareImages: false,
    mode: 'live',
    approved: true,
    allowResume: false,
  });

  const record = (network: Network, status: 'ok' | 'failed', detail: string) =>
    run(
      'INSERT INTO extra_posts (site_id, keyword_id, source_run_id, run_id, network, angle, status, detail, auto, shape_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      site.id,
      keyword.id,
      req.sourceRunId,
      batchRunId,
      network,
      angle.id,
      status,
      detail.slice(0, 500),
      req.auto ? 1 : 0,
      network === 'pinterest' ? null : (shape?.id ?? null),
    );

  const outcomes: ExtraOutcome[] = [];
  const fail = (network: Network, err: unknown) => {
    const cause = (err as { cause?: unknown })?.cause ?? err;
    const detail = errorMessage(cause);
    log.warn(`more posts ${site.domain}: ${network} not scheduled — ${detail}`);
    record(network, 'failed', detail);
    outcomes.push({ network, ok: false, detail });
  };

  // Setup -> Caption structures: the next shape, for the networks ticked there.
  const own = withSiteOverrides(settings, site.id);
  const shapeOn = parseCaptionNetworks(own.get('caption_networks'));
  const shapeFor = (['facebook', 'instagram'] as const).filter((n) => req.networks.includes(n) && shapeOn.has(n));
  const shape = shapeFor.length > 0 ? nextExtraShape(site.id) : null;
  const shapeRule = shape
    ? `For ${shapeFor.map((n) => `"${n === 'facebook' ? 'facebook_text' : 'instagram_caption'}"`).join(' and ')}, follow THE SHAPE below exactly: its opening, its body, its ending. ` +
      'The shape replaces the length and hashtag limits given above for those fields. Hashtags are lowercase and specific to the dish. No links, no URLs.\n' +
      `THE SHAPE:\n${shape.body}\n`
    : '';

  // The recipe link, by the site's own choice (More posts page); otherwise as Setup has it.
  const linkChoice = own.get('caption_extra_link');
  const setupFb = parseFacebookLinkMode(own.get('caption_fb_post_link'));
  const fbLink: FacebookLinkMode | undefined = linkChoice === 'no' ? 'none' : linkChoice === 'yes' ? (setupFb === 'none' ? 'text' : setupFb) : undefined;
  const igLink = linkChoice === 'yes' || linkChoice === 'no' ? linkChoice : undefined;

  let texts: ExtraTexts;
  try {
    texts = await runStep(ctx, writeExtraTexts, { seo, angle, shapeRule });
  } catch (err) {
    for (const network of req.networks) fail(network, err);
    return { angle, outcomes };
  }

  // The new graphic: used by Pinterest, and shown by Facebook. Its design rotates on its own.
  let pinImageUrl = '';
  let cta = texts.pin_title;
  if (req.networks.includes('pinterest') || req.networks.includes('facebook')) {
    try {
      const pin = await runStep(ctx, generatePinImage, {
        seo,
        prompts: { ...(prompts ?? ({} as ImagePromptSet)), pinTitle: texts.pin_title },
      });
      pinImageUrl = pin.url;
      cta = pin.cta;
    } catch (err) {
      for (const network of ['pinterest', 'facebook'] as const) if (req.networks.includes(network)) fail(network, err);
    }
  }
  const failed = (network: Network) => outcomes.some((o) => o.network === network);

  if (req.networks.includes('pinterest') && !failed('pinterest')) {
    try {
      const target = await runStep(ctx, resolveBufferTarget, seo);
      const pin = { seo, posted: posted as never, pinImageUrl, cta };
      const result = await runStep(ctx, publishToBuffer, { pin, description: texts.pin_description, target });
      if ('postId' in result) {
        record('pinterest', 'ok', `board "${target.boardName}"`);
        outcomes.push({ network: 'pinterest', ok: true, detail: `Pin scheduled on "${target.boardName}".` });
      } else {
        fail('pinterest', new Error('Buffer publishing is off; nothing was scheduled.'));
      }
    } catch (err) {
      fail('pinterest', err);
    }
  }

  if (req.networks.includes('facebook') && !failed('facebook')) {
    try {
      const result = await runStep(ctx, facebookPostStep, {
        seo,
        title,
        postUrl,
        pinImageUrl,
        heroImageUrl: images?.hero,
        text: texts.facebook_text,
        linkMode: fbLink,
      });
      if ('postId' in result) {
        record('facebook', 'ok', 'scheduled');
        outcomes.push({ network: 'facebook', ok: true, detail: 'Facebook post scheduled.' });
      } else {
        fail('facebook', new Error(result.skipped));
      }
    } catch (err) {
      fail('facebook', err);
    }
  }

  if (req.networks.includes('instagram')) {
    try {
      // Another of the article's own photographs than the ones used before, so the picture differs.
      const photos = [images?.stepA, images?.stepB, images?.stepC, images?.hero].filter((p): p is string => Boolean(p));
      const usedCount = all<{ n: number }>("SELECT COUNT(*) AS n FROM extra_posts WHERE source_run_id = ? AND network = 'instagram' AND status = 'ok'", req.sourceRunId)[0]?.n ?? 0;
      const photo = photos.length ? photos[usedCount % photos.length]! : '';
      const result = await runStep(ctx, instagramPostStep, { seo, title, postUrl, heroImageUrl: photo, caption: texts.instagram_caption, link: igLink });
      if ('postId' in result) {
        record('instagram', 'ok', 'scheduled');
        outcomes.push({ network: 'instagram', ok: true, detail: 'Instagram post scheduled.' });
      } else {
        fail('instagram', new Error(result.skipped));
      }
    } catch (err) {
      fail('instagram', err);
    }
  }

  return { angle, outcomes };
}

/** The latest batches, newest first, for the page. */
export function recentExtraPosts(limit = 30): {
  id: number; createdAt: string; domain: string; title: string; network: Network; angle: string; ok: boolean; detail: string; auto: boolean;
}[] {
  return all<{ id: number; created_at: string; domain: string; title: string; network: Network; angle: string; status: string; detail: string; auto: number }>(
    `SELECT e.id, e.created_at, s.domain, COALESCE(NULLIF(r.title, ''), '(unknown)') AS title, e.network, e.angle, e.status, e.detail, e.auto
       FROM extra_posts e
       JOIN sites s ON s.id = e.site_id
       LEFT JOIN runs r ON r.id = e.source_run_id
      ORDER BY e.id DESC LIMIT ?`,
    limit,
  ).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    domain: r.domain,
    title: r.title,
    network: r.network,
    angle: ANGLES.find((a) => a.id === r.angle)?.label ?? r.angle,
    ok: r.status === 'ok',
    detail: r.detail,
    auto: r.auto === 1,
  }));
}
