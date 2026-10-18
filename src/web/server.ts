import {
  imageServiceProblemFrom,
  type FlowStatus,
  type ServiceHealth,
} from '../core/image-service-health.js';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { isSocialOnly, siteKey } from '../core/social-only.js';
import { isMediaName, MEDIA_TYPES, mediaDir } from '../integrations/media-store.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { layout, raw, type Html } from './views/layout.js';
import { reelDetailPage } from './views/reel-detail.js';
import { morePostsPage } from './views/more-posts.js';
import {
  NETWORKS, checkRequest, gapDays, hiddenCount, hideOlderThan, listPublishedRecipes, setRecipesHidden, makeExtraPosts, networkStates, recentExtraPosts, usedAngles, type Network,
} from '../extra/engine.js';
import { homePage, mergeRecent, type Attention, type Running } from './views/home.js';
import { passwordAccepted, registerAuth, type AuthOptions } from './auth.js';
import { rejectionReason, storePassword, storedPasswordHash } from './password.js';
import { registerBrowserProxy } from './browser-proxy.js';
import {
  decisionsPage,
  runPicker,
  eventsPage,
  accountPage,
  keysPage,
  keywordAddPage,
  keywordDetailPage,
  keywordsPage,
  promptEditPage,
  promptsPage,
  runDetailPage,
  runsPage,
  settingsPage,
  siteEditPage,
  sitesPage,
  facebookSettingsPage,
  reelComposerPage,
  reelSettingsPage,
  collageSettingsPage,
  presentersPage,
  reelsPage,
  type ReelImages,
  type ImageModelCatalogue,
} from './views/pages.js';
import type { KeywordFilterView, SiteMark } from './views/pages.js';
import { importKeywordsCsv, importSitesCsv } from './import.js';
import {
  activateSite,
  setAutoPublish,
  setWritingStyle,
  bulkDeleteKeywords,
  bulkSetKeywordStatus,
  bulkSetLinks,
  bulkSetShareImages,
  countKeywords,
  countKeywordsMatching,
  keywordIdsMatching,
  addPastedKeywords,
  researchRepeats,
  keywordViewCounts,
  countRuns,
  deleteKeyword,
  deleteSite,
  getKeyword,
  getSite,
  getSiteByDomain,
  listDecisions,
  listEvents,
  clearEvents,
  clearHistory,
  listRecentCycles,
  listHeldRuns,
  listPromptVersions,
  listRuns,
  listSites,
  listSteps,
  getPromptVersion,
  dailyActivity,
  createRun,
  discardRun,
  getLinkShare,
  listRunsForKeyword,
  publishedTitles,
  replaceStepOutput,
  setRunTitle,
  type StepRow,
  type RunListRow,
  clearSharedImages,
  getLinksForKeyword,
  keywordImageCounts,
  keywordsInGroup,
  sharedImageInfo,
  pauseSite,
  runUsage,
  savePromptVersion,
  setModelOverride,
  searchKeywords,
  deletePromptOverride,
  getPromptOverride,
  loadLinkGrid,
  bulkActivate,
  bulkDeleteSites,
  bulkPause,
  bulkSetAutoPublish,
  bulkSetDailyTarget,
  bulkSetInterval,
  deleteBufferAccount,
  listBufferAccounts,
  loadKeywordViews,
  unblockLink,
  upsertBufferAccount,
  setPinterestPublishing,
  setInstagramPublishing,
  siteTopicGroups,
  getAccountNameSuggestions,
  setAccountNameSuggestions,
  type AccountName,
  type BoardPlan,
  parseBoardMap,
  type BufferPlatform,
  loadLinkViews,
  loadSiteViews,
  tzModifier,
  setPromptOverride,
  getRun,
  setKeywordShareImages,
  setKeywordStatus,
  setKeywordCook,
  setKeywordCookSuggestions,
  appendKeywordCookNote,
  setLink,
  setLinkShareImages,
  upsertSite,
  createReel,
  deleteFbToken,
  deleteReel,
  getFbPage,
  getReel,
  getReelByFbVideoId,
  getFbFeedPostByNativeId,
  recipeCardForRun,
  resolveFbGraphTarget,
  fbGraphTargetByRealPageId,
  insertFbToken,
  keywordGroups,
  listFbPages,
  deleteFbPage,
  listFbTokens,
  listReels,
  pageForSite,
  reelCandidates,
  dismissReelCandidates,
  setFbPageOptions,
  updateReel,
  setReelChannels,
  facebookForSite,
  firstProfile,
  listProfiles,
  postsToAll,
  setPostToAll,
  addProfile,
  getProfile,
  updateProfile,
  deleteProfile,
  type ChannelProfile,
  setReelStage,
  listScenes,
  getScene,
  updateScene,
  presenterForPage,
  listPresenters,
  insertPresenter,
  updatePresenter,
  deletePresenter,
  setFbPagePresenter,
  getFbPageByProfile,
  upsertFbPageForProfile,
  setProfileKinds,
  reelsElsewhere,
  deleteFbPageByProfile,
  type ReelCandidate,
  type FbPageRow,
  insertEvent,
  bufferChannelName,
} from '../db/repos.js';
import { all, get, run as runSql } from '../db/index.js';
import { FacebookClient } from '../integrations/facebook.js';

/** A Flow project typed on a site before projects moved to Google accounts. */
const legacySiteProject = (): string =>
  get<{ project_id: string }>("SELECT project_id FROM sites WHERE TRIM(project_id) <> '' ORDER BY id LIMIT 1")?.project_id.trim() ?? '';
import {
  DATASETS,
  exportDataset,
  exportSitesWithCredentials,
  type Dataset,
} from '../db/exports.js';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  deleteEndpoint,
  listEndpoints,
  resetEndpointHealth,
  upsertEndpoint,
} from '../llm/pool.js';
import { executePipeline, PipelineContext } from '../pipeline/index.js';
import { evaluateSite, formatMinutes, localDateKey } from '../core/selector.js';
import { diagnoseKeyword } from '../core/diagnosis.js';
import { findDuplicate } from '../core/similar-title.js';
import { findBoard, sameBoard } from '../core/board-match.js';
import { normaliseStyle } from '../core/writing-style.js';
import { readSupply, supplyWarning } from '../core/supply.js';
import { listPromptFiles } from '../pipeline/prompt-files.js';
import {
  invalidatePromptCache,
  KNOWN_MODELS,
  modelChoices,
  modelFor,
  PROMPT_MODELS,
  readShippedPrompt,
} from '../pipeline/prompts.js';
import { unknownVariables, variablesFor } from '../pipeline/prompt-contexts.js';
import { DETECTED_PUBLIC_URL, SETTING_SPECS, type Settings } from '../settings.js';
import { getSetting, setSetting } from '../db/repos.js';
import {
  lockStatus,
  resumeRun,
  setImageServiceProblem,
  stopRun,
  tick,
} from '../scheduler/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { TelegramClient } from '../integrations/telegram.js';
import { syncToken, type SyncResult } from '../reels/tokens.js';
import { AccountOffError, channelKeys, channelOf, defaultDeps, publishReel, readChannels, startGeneration } from '../reels/engine.js';
import { presenterFor } from '../reels/presenter.js';
import { loadPrompt } from '../pipeline/prompts.js';
import {
  ARTICLE_ROLES,
  MAX_REFERENCES,
  MUSIC_SLOTS,
  buildHandsPrompt,
  buildReelPrompt,
  isLocalMusicLine,
  musicSlotKey,
  musicUploadsDir,
  reelMode,
  referenceUrls,
  seedFromRun,
  isStudioMode,
  singleReferenceRoles,
  withoutLinks,
  type ArticleRole,
} from '../reels/compose.js';
import { reelCta } from '../reels/cta.js';
import { FORMATS } from '../reels/formats.js';
import { backupsPage } from './views/backups.js';
import { BufferClient } from '../integrations/buffer.js';
import { askPrompt } from '../llm/ask.js';
import {
  addPinIdeas, analyseExport, deletePinIdeas, dismissPinIdeas, lastPinReport, listPinIdeas, waitingPinIdeas, type PinIdea, type PinIdeasStage,
} from '../research/pinterest-ideas.js';
import { pinIdeasPage, type PinIdeasSiteView } from './views/pin-ideas.js';
import { pinTitle } from '../integrations/pinterest-page.js';
import { tryParseJson } from '../pipeline/json.js';
import { describeRun, emptyReport, experiencesForPrompt, gatherExperiences, pickSuggestions, readSuggestions } from '../cook/suggest.js';
import { webSearchKeys } from '../llm/web-search.js';
import { backupPath, backupsDir, createBackup, listBackups, pruneBackups, requestRestart, stageRestore } from '../backup/index.js';
import { buildSiteBackup, encodeSiteBackup, parseSiteBackup, restoreSiteBackup, siteBackupName, type RestoreReport } from '../backup/site.js';
import { createWriteStream, mkdirSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { pipeline as pipeStreams } from 'node:stream/promises';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { idFromFlowUrl } from '../reels/ids.js';
import { chat } from '../llm/client.js';
import { normaliseDomain } from '../lib/domain.js';
import { blogPage } from './views/blog.js';
import { sitePagesPage } from './views/site-pages.js';
import { canWrite, getAboutAuto, getPageFacts, getSitePage, listSitePages, savePageFacts, setAboutAuto } from '../pages/repo.js';
import { draftSiteFacts, publishSitePage, writeAndPublishAll, writeSitePage } from '../pages/engine.js';
import { isPageSlug, PAGE_TITLE } from '../pages/specs.js';
import { researchPage } from './views/research.js';
import { addPinDesign, deletePinDesign, designProblems, listPinDesigns, pinDesignUses, savePinDesign } from '../core/pin-designs.js';
import { pinDesignsPage } from './views/pin-designs.js';
import { addPhotoStyle, deletePhotoStyle, listPhotoStyles, photoStyleUses, savePhotoStyle } from '../core/photo-styles.js';
import { photoStylesPage } from './views/photo-styles.js';
import { writeReelCaption } from '../reels/caption.js';
import {
  addCaptionStructure, captionStructureUses, CAPTION_NETWORK_LABELS, deleteCaptionStructure,
  customizeCaption, isCaptionCustom, listCaptionStructures, nextCaptionShape, parseCaptionNetworks, resetCaption, saveCaptionStructure,
  setSiteCaptionSetting, withSiteOverrides,
  serializeCaptionNetworks,
} from '../core/caption-structures.js';
import { captionStructuresPage } from './views/caption-structures.js';
import { parseFacebookLinkMode, parseRecipeInPost } from '../reels/recipe-text.js';
import {
  addReelStructure, deleteReelStructure, listReelStructures, markReelStructure, nextReelShape,
  reelStructureName, reelStructureUses, saveReelStructure, templateIgnoresStructures,
} from '../core/reel-structures.js';
import { reelStructuresPage } from './views/reel-structures.js';
import {
  addArticleStructure, articleStructureUses, deleteArticleStructure, listArticleStructures, saveArticleStructure,
} from '../core/article-structures.js';
import { articleStructuresPage } from './views/article-structures.js';
import {
  addBlogStructure, blogStructureUses, deleteBlogStructure, listBlogStructures, saveBlogStructure,
} from '../core/blog-structures.js';
import { blogStructuresPage } from './views/blog-structures.js';
import { queueCheckPage } from './views/queue-check.js';
import { gscOpportunitiesPage, gscSetupPage, type GscSiteView } from './views/gsc.js';
import { radarPage, radarSetupPage, type RadarSiteView } from './views/radar.js';
import {
  addToQueue as radarAddToQueue, countWaiting as radarWaiting, dismiss as radarDismiss,
  listPosts as radarPosts, liveRadarDeps, radarOptionsFrom, scanSite as radarScanSite,
  type RadarPost, type RadarReport, type RadarSiteFields,
} from '../research/social/radar.js';
import { addSource, listSources, removeSource, toggleSource } from '../research/social/repo.js';
import { splitTokens, tokenCounts, tokenStateIn } from '../research/social/providers.js';
import { taxonomyPage } from './views/taxonomy.js';
import { accountsPage } from './views/accounts.js';
import { igLinkCard } from './views/instagram.js';
import { DEFAULT_IMAGE_PROMPT, isRunning as taxoRunning, listJobs as taxoJobs, readReport as taxoReport, retryFailed as taxoRetry, runSiteGuarded as taxoRun, type TaxonomySiteFields } from '../taxonomy/engine.js';
import {
  addOpportunities, countOpportunities, dismissOpportunities, listOpportunities, liveGscDeps, minImpressionsFrom,
  parseQueriesCsv, refreshSite, type GscSiteFields, type QueryStat,
} from '../gsc/engine.js';
import { GscClient, parseServiceAccount } from '../gsc/client.js';
import type { RunRow, SiteRow } from '../db/repos.js';
import { latestQueueCheck, queuedKeywords, removeFromQueue, startQueueCheck } from '../research/queue-check.js';
import { cleanTopics, DEFAULT_PER_TOPIC, getResearchJob, recallIdeas, rememberIdeas, startResearchJob } from '../research/batch.js';
import { liveDeps as liveResearchDeps, runAutoResearch, serperStateIn } from '../research/auto.js';
import { filterWithModel, parseTopicIdeas, researchKeywords, titleCase, topicCandidates, verifyTopics } from '../research/keywords.js';
import { googleAccountsPage, type GoogleAccountView } from './views/google-accounts.js';
import { parseSnapshot, restorableCount, serviceIsBehind, takeSnapshot } from './google-snapshot.js';
import {
  addBlogQuestions,
  blogPublishedToday,
  countBlogQuestions,
  deleteBlogQuestion,
  getBlogQuestion,
  listBlogQuestions,
  listBlogSites,
  nextBlogQuestion,
  setBlogQuestionStatus,
  setBlogSettings,
} from '../blog/repo.js';
import { runOneBlogQuestion, suggestBlogQuestions } from '../blog/engine.js';
import { releaseRunLock, retryCollagePost, retryPinterestPin, tryAcquireRunLock, heartbeat as runHeartbeat } from '../scheduler/index.js';

const log = createLogger('web');

/* -- Reels ---------------------------------------------------------------- */

/**
 * The four image paths a published run left behind.
 *
 * Read from the generate-images checkpoint rather than from keyword_images:
 * that table only holds a row when sharing is on, and a site that generated
 * its own images has just as much to build a reel from. A checkpoint that
 * cannot be read is not an error worth showing -- the run simply cannot become
 * a reel, and the page says so.
 */
function readReelImages(candidate: ReelCandidate): ReelImages | null {
  if (!candidate.images_json) return null;

  try {
    const parsed = JSON.parse(candidate.images_json) as Partial<ReelImages>;
    if (!parsed.hero || !parsed.stepA || !parsed.stepB || !parsed.stepC) {
      return null;
    }
    return parsed as ReelImages;
  } catch {
    return null;
  }
}

/**
 * What the caption box shows the instant the composer opens.
 *
 * The title and nothing else. The url that used to sit under it is gone on
 * purpose -- the link goes in the first comment, never the caption -- and the
 * model's version arrives a moment later, fetched by the page, if the model is
 * up. The page never waits for it: it did once, the LLM pool was down, and the
 * composer sat past Cloudflare's hundred seconds and answered 524.
 */
function placeholderCaption(candidate: ReelCandidate): string {
  return candidate.title || candidate.spy_title;
}

/**
 * A caption written by the model. Fetched by the composer after it has
 * rendered, never awaited by a page.
 *
 * Written rather than assembled: the old default was the title with the
 * article url under it, which Facebook shows as a bare link on a post nobody
 * has a reason to stop for. The shape wanted is a hook that stops the scroll,
 * a few lines about the dish, hashtags -- and no link anywhere in it. The link
 * goes in the first comment, where it does not drag the post's reach down and
 * still gets tapped.
 *
 * Never fatal. A model that is down or slow costs the suggestion, not the
 * page: the title stays in the box and the person types.
 */
async function buildReelCaption(
  candidate: ReelCandidate,
  settings: Settings,
  encryptionKey: Buffer,
): Promise<string> {
  // The same writer the pipeline uses, and the same rotation, so a caption
  // written by hand in the composer is not a different animal from the ones
  // the platform writes by itself.
  return writeReelCaption(
    {
      title: candidate.title || candidate.spy_title,
      group: candidate.seed_keyword,
      description: candidate.spy_description,
      annotation: candidate.annotation,
    },
    settings,
    encryptionKey,
    nextCaptionShape(candidate.site_id ?? 0).shape,
  );
}

type Flash = { kind: 'ok' | 'error' | 'warn'; message: string } | null;

/** Flash messages are passed through the query string; there are no sessions. */
function readFlash(query: unknown): Flash {
  const q = query as { ok?: string; error?: string; warn?: string };
  if (q.ok) return { kind: 'ok', message: q.ok };
  if (q.error) return { kind: 'error', message: q.error };
  if (q.warn) return { kind: 'warn', message: q.warn };
  return null;
}

const redirect = (reply: FastifyReply, path: string, flash?: Flash): FastifyReply => {
  // The message goes before any #anchor, or the browser reads it as part of the anchor.
  const [base, hash] = path.split('#', 2) as [string, string | undefined];
  const url = flash
    ? `${base}${base.includes('?') ? '&' : '?'}${flash.kind}=${encodeURIComponent(flash.message)}${hash ? `#${hash}` : ''}`
    : path;
  return reply.redirect(url, 303);
};

/**
 * A form body that is always an object.
 *
 * Fastify leaves `request.body` undefined when nothing parsed it — a POST with
 * no content-type, or a client that sent none. Reading a field off that throws,
 * and the user gets a 500 stack page for what is really "that submission was
 * malformed". Every handler here reads fields, so they all go through this.
 */
/** Public answers under a commenter's comment once the recipe was sent by DM. */
const PUBLIC_REPLIES = [
  'Just sent it to your inbox! Enjoy! 💛',
  'Recipe sent! Check your messages and enjoy!',
  "On its way! Look in your inbox 😊",
  'Done! The recipe is in your messages now.',
  'Sent! Check your DMs and happy cooking! 🍽️',
  "Check your inbox, it's there! Enjoy!",
];

const formBody = (request: FastifyRequest): Record<string, unknown> =>
  (request.body as Record<string, unknown> | undefined) ?? {};

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const asNumber = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** https://host as the visitor's browser reached this platform, or null for a local or bare-IP address. */
export function requestOrigin(request: Pick<FastifyRequest, 'headers'>): string | null {
  const first = (v: string | string[] | undefined) => String(Array.isArray(v) ? v[0] : v ?? '').split(',')[0]!.trim();
  const host = (first(request.headers['x-forwarded-host']) || first(request.headers.host)).toLowerCase().replace(/:(80|443)$/, '');
  if (!host || !/^[a-z0-9.-]+(:\d+)?$/.test(host)) return null;
  const name = host.replace(/:\d+$/, '');
  if (!name.includes('.') || name === 'localhost' || name.endsWith('.localhost') || /^\d+(\.\d+){3}$/.test(name)) return null;
  // A public domain is served over https; only the proxy saying otherwise makes it http.
  return `${first(request.headers['x-forwarded-proto']) === 'http' ? 'http' : 'https'}://${host}`;
}

/** Two addresses that name the same place: case and a trailing slash aside. */
export const sameOrigin = (a: string, b: string): boolean =>
  Boolean(a && b) && a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

export function buildServer(
  settings: Settings,
  encryptionKey: Buffer,
  auth: AuthOptions,
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });

  void app.register(formbody);
  void app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  void app.register(fastifyStatic, {
    root: resolve(dirname(fileURLToPath(import.meta.url)), 'public'),
    prefix: '/static/',
  });

  // Must come after formbody so the login form body is parsed.
  registerAuth(app, auth);

  // The live Chrome session, behind the same login as everything else.
  registerBrowserProxy(app, {
    targetUrl: process.env.IMAGEGEN_VNC_URL ?? 'http://imagegen:6080',
    secret: auth.secret,

    // Chrome is no longer running just because the container is: its GPU
    // process costs 170% of a 185% container with nothing loaded, so the agent
    // starts it for a job and stops it afterwards. Opening this page is the
    // other reason to want one — signing in to Google needs a window — and
    // without this the page would come up on an empty display and look broken.
    //
    // Failure is deliberately not fatal. If the image service cannot be
    // reached, showing the viewer and letting it say so beats refusing to
    // render the page someone opened to find out what is wrong.
    onOpen: async () => {
      const base = settings.get('image_base_url').replace(/\/+$/, '');
      if (!base) return;
      try {
        await fetch(`${base}/flow/chrome/start`, {
          method: 'POST',
          headers: { 'X-API-Key': settings.get('image_api_key') },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        // The viewer will show an empty display; /browser/procs says why.
      }
    },

    // Closing the tab is what says nobody is watching. Without it the hold has
    // to be guessed at, and the guess was fifteen minutes: every visit to this
    // page cost eighteen minutes of a browser at 170%, so checking whether the
    // CPU had come down was itself what kept it up.
    onViewerGone: async () => {
      const base = settings.get('image_base_url').replace(/\/+$/, '');
      if (!base) return;
      try {
        await fetch(`${base}/flow/chrome/stop`, {
          method: 'POST',
          headers: { 'X-API-Key': settings.get('image_api_key') },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        // It stops on the idle timer anyway; this only makes it prompt.
      }
    },
  });

  /* -- Site tabs: one site at a time on the Content pages ---------------------- */

  const SCOPED = new Set(['/runs', '/keywords', '/research', '/radar', '/blog', '/site-pages', '/more-posts', '/reels']);
  const scopeOf = new WeakMap<FastifyRequest, number>();

  // ?site=<id> or ?site=all picks (and is remembered in a cookie, so the choice
  // follows the person from Keywords to Blog to Reels); with neither, the
  // remembered one applies. The pages read it from ?site as before.
  // The address this platform is opened at, kept so "Public address of this
  // platform" fills itself in: Buffer and Facebook fetch social-only media from
  // it. Taken as the browser reached it -- through Dokploy's proxy, so its
  // forwarded host and scheme first -- and written only when it changes. A
  // local or bare-IP address is never one Buffer could use, so it is skipped.
  let detectedOrigin: string | null = null;
  app.addHook('onRequest', async (request) => {
    const origin = requestOrigin(request);
    if (!origin || origin === detectedOrigin) return;
    detectedOrigin = origin;
    try {
      if (getSetting(DETECTED_PUBLIC_URL, encryptionKey) !== origin) setSetting(DETECTED_PUBLIC_URL, origin, false, encryptionKey);
    } catch {
      detectedOrigin = null; // no database yet: tried again on the next request
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'GET') return;
    const path = request.url.split('?')[0] ?? '';
    if (!SCOPED.has(path)) return;
    const query = request.query as { site?: string };
    const known = new Set(listSites().map((x) => x.id));
    const raw = query.site === undefined ? undefined : asString(query.site).trim();
    let id = 0;
    if (raw !== undefined && raw !== '') {
      id = raw === 'all' ? 0 : asNumber(raw, 0);
      if (!known.has(id)) id = 0;
      reply.header('set-cookie', `scope_site=${id || 'all'}; Path=/; Max-Age=31536000; SameSite=Lax`);
    } else if (raw === undefined) {
      const m = /(?:^|;\s*)scope_site=(\d+)/.exec(String(request.headers.cookie ?? ''));
      id = m ? asNumber(m[1], 0) : 0;
      if (!known.has(id)) id = 0;
    }
    scopeOf.set(request, id);
    if (id > 0) query.site = String(id);
    else if (raw === 'all') delete query.site;
  });

  const siteBarFor = (request: FastifyRequest) => {
    const path = request.url.split('?')[0] ?? '';
    if (!SCOPED.has(path)) return null;
    const sites = listSites().map((x) => ({ id: x.id, domain: x.domain }));
    const scope = scopeOf.get(request) ?? 0;
    // Radar watches one site at a time, so it has no "all".
    const allowAll = path !== '/radar';
    const selected = scope || (allowAll ? 0 : (radarSites()[0]?.id ?? 0));
    return { sites, selected, allowAll, path };
  };

  const page = (
    reply: FastifyReply,
    title: string,
    active: string,
    body: Html,
    flash: Flash = null,
  ): FastifyReply =>
    reply.type('text/html; charset=utf-8').send(
      layout({
        title,
        // The real path, so the rail picks the section and the tab picks the
        // page. `active` is what the route thinks it is, and every settings
        // page says '/settings'; the URL knows better.
        active: reply.request.url.split('?')[0] || active,
        body,
        flash,
        automationOn: settings.getBool('automation_enabled'),
        siteBar: siteBarFor(reply.request),
      }),
    );

  /* -- Home ---------------------------------------------------------------- */

  /**
   * Everything a person has to do, each with the one place to do it.
   *
   * Gathered from every source that can stop the work or wait on a choice:
   * configuration problems, the image service, articles held for approval,
   * Facebook pages and tokens, and keyword supply. What stops work comes
   * first.
   */
  const attentionFor = (): Attention[] => {
    const items: Attention[] = [];

    items.push(...problemsWithPlaces(settings));

    for (const token of listFbTokens()) {
      if (token.last_error) {
        items.push({
          kind: 'warn',
          text: `Facebook token "${token.name}": ${token.last_error}`,
          href: '/accounts#facebook-pages',
          action: 'Check',
        });
      }
    }

    const held = listHeldRuns(20);
    if (held.length === 1) {
      const r = held[0]!;
      items.push({
        kind: 'info',
        text: `"${r.title || r.seed_keyword || 'an article'}" on ${r.site_domain ?? '—'} is waiting for approval`,
        href: `/runs/${r.id}`,
        action: 'Review',
      });
    } else if (held.length > 1) {
      items.push({
        kind: 'info',
        text: `${held.length} articles waiting for approval`,
        href: '/runs',
        action: 'Review',
      });
    }

    const unassigned = listFbPages().filter((p) => p.enabled && p.site_id === null);
    if (unassigned.length > 1) {
      items.push({
        kind: 'info',
        text: `${unassigned.length} Facebook pages have no site`,
        href: '/accounts#facebook-pages',
        action: 'Assign',
        post: {
          url: '/settings/facebook/pages/delete-unassigned',
          label: 'Remove all',
          fields: {},
          confirm: `Remove these ${unassigned.length} Facebook pages?`,
        },
      });
    }
    for (const fbPage of listFbPages()) {
      if (fbPage.enabled && fbPage.site_id === null) {
        items.push({
          kind: 'info',
          text: `Facebook page "${fbPage.name}" has no site, so nothing goes to it`,
          href: '/accounts#facebook-pages',
          action: 'Assign',
          post: {
            url: '/settings/facebook/pages/delete',
            label: 'Remove',
            fields: { pick: String(fbPage.id), back: '/' },
            confirm: `Remove the Facebook page ${fbPage.name}? It can come back if it is still under a connected token.`,
          },
        });
      }
    }

    if (settings.getBool('fb_enabled') && listPresenters().length > 0) {
      for (const fbPage of listFbPages()) {
        if (fbPage.enabled && fbPage.site_id !== null && fbPage.presenter_id === null) {
          items.push({
            kind: 'info',
            text: `Page "${fbPage.name}" has no presenter, so its reels show the dish only`,
            href: '/accounts#facebook-pages',
            action: 'Pick one',
          });
        }
      }
    }

    const failedReels = listReels(50).filter((r) => r.status === 'failed').length;
    if (failedReels) {
      items.push({
        kind: 'info',
        text: `${failedReels} reel(s) failed and can be retried`,
        href: '/reels',
        action: 'See reels',
      });
    }

    return items;
  };

  const runListRow = (id: number): RunListRow | undefined =>
    get<RunListRow>(
      `SELECT r.*, s.domain AS site_domain, k.seed_keyword
         FROM runs r LEFT JOIN sites s ON s.id = r.site_id
         LEFT JOIN keywords k ON k.id = r.keyword_id WHERE r.id = ?`,
      id,
    );

  /** The run holding the lock, and the step it is on, in words. */
  const runningNow = (): Running | null => {
    const lock = lockStatus();
    if (!lock?.locked_at) return null;
    const run = lock.run_id ? runListRow(lock.run_id) : undefined;
    const step = lock.run_id
      ? listSteps(lock.run_id).filter((s) => s.status === 'running').at(-1)?.step
      : undefined;
    return {
      runId: lock.run_id ?? null,
      site: run?.site_domain ?? '—',
      keyword: run?.seed_keyword ?? run?.title ?? '—',
      step: step ? step.replace(/-/g, ' ') : 'starting',
      startedAt: lock.locked_at,
    };
  };

  app.get('/', async (request, reply) => {
    const timezone = settings.get('timezone');
    const now = new Date();
    const dayKey = localDateKey(now, timezone);
    const views = loadSiteViews(dayKey, timezone);

    // "Today" in the platform's time zone, the same day the Sites page and the
    // daily limit count. These used UTC, so for an hour or more after local
    // midnight Home and Sites disagreed about how many were published today.
    const tz = tzModifier(timezone, now);
    const published =
      get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM runs WHERE status = 'published' AND date(published_at, ?) = ?`,
        tz,
        dayKey,
      )?.n ?? 0;
    const failed =
      get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM runs WHERE status = 'failed' AND date(started_at, ?) = ?`,
        tz,
        dayKey,
      )?.n ?? 0;
    const reelsToday =
      get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM reels WHERE status = 'published' AND date(updated_at, ?) = ?`,
        tz,
        dayKey,
      )?.n ?? 0;
    const supply = readSupply();
    const lock = lockStatus();

    return page(
      reply,
      'Home',
      '/',
      homePage({
        automationOn: settings.getBool('automation_enabled'),
        running: runningNow(),
        attention: attentionFor(),
        today: {
          published,
          target: views.filter((s) => s.status === 'active').reduce((n, s) => n + s.dailyTarget, 0),
          reels: reelsToday,
          failed,
          queued: supply.readyPairs,
          supply,
        },
        recent: mergeRecent(listRuns(12), listReels(12)),
        picker: runPicker({
          sites: views,
          keywords: loadKeywordViews(),
          links: loadLinkViews(),
          busy: Boolean(lock?.locked_at),
        }),
      }),
      readFlash(request.query),
    );
  });

  /** The master switch, from the status bar. */
  app.post('/automation', async (request, reply) => {
    const body = formBody(request);
    const on = asString(body.enabled) === '1';
    settings.set('automation_enabled', on ? 'true' : 'false');
    return redirect(reply, '/', {
      kind: 'ok',
      message: on ? 'Automation is on.' : 'Automation is paused. Nothing new starts until it is on again.',
    });
  });

  /* -- Decisions ------------------------------------------------------------ */

  app.get('/decisions', async (request, reply) => {
    const cycles = listRecentCycles(20);
    const requested = asString((request.query as { cycle?: string }).cycle);
    const selectedCycle = requested || cycles[0]?.cycle_id || null;
    return page(
      reply,
      'Decisions',
      '/decisions',
      decisionsPage(
        cycles,
        selectedCycle,
        selectedCycle ? listDecisions(selectedCycle) : [],
        dailyActivity(30, settings.get('timezone')),
      ),
    );
  });

  /** Turn a tick's outcome into something worth reading on the dashboard. */
  const describeTick = (result: {
    outcome: string;
    detail?: string;
    runId?: number;
    hold?: string;
  }): Flash => {
    const messages: Record<string, string> = {
      published: 'Published successfully.',
      failed: `Run failed: ${result.detail ?? 'see the run detail page'}`,
      'spy-rejected': 'Spy source rejected; the keyword was marked unusable.',
      duplicate: result.detail || 'Skipped — the dish is already on the site.',
      held:
        result.hold === 'dry'
          ? 'Dry run finished. The article is written and nothing was published — open the run to read it.'
          : 'Article written and waiting for approval — open the run to read it.',
      'no-task': `Nothing to publish: ${result.detail ?? ''}`,
      busy: 'A run is already in progress.',
      disabled: 'Automation is disabled. Enable it in Settings first.',
      misconfigured: `Configuration incomplete: ${result.detail ?? ''}`,
    };

    return {
      kind:
        result.outcome === 'published'
          ? 'ok'
          : result.outcome === 'failed'
            ? 'error'
            : result.outcome === 'held'
              ? 'ok'
              : 'warn',
      message: messages[result.outcome] ?? result.outcome,
    };
  };

  app.post('/run-now', async (request, reply) => {
    // A dry run exercises the whole pipeline and stops before posting, which
    // is the only way to see what a prompt change does without a live site
    // finding out first.
    const body = formBody(request);
    const mode = asString(body.mode) === 'dry' ? 'dry' : 'live';

    // A hand-picked pair runs immediately: no eligibility check, no waiting
    // for the next scheduler tick, no queued retry taking the slot. Both ids
    // or neither — half a pair would silently fall back to the selector and
    // publish something the person did not ask for.
    const siteId = asNumber(body.site_id, 0);
    const keywordId = asNumber(body.keyword_id, 0);
    const pick = siteId > 0 && keywordId > 0 ? { siteId, keywordId } : undefined;

    if ((siteId > 0) !== (keywordId > 0)) {
      return redirect(reply, '/', {
        kind: 'error',
        message: 'Pick both a site and a keyword, or neither.',
      });
    }

    try {
      const result = await tick(settings, encryptionKey, { mode, pick });
      const flash = describeTick(result);
      return redirect(reply, result.runId ? `/runs/${result.runId}` : '/', flash);
    } catch (err) {
      return redirect(reply, '/', { kind: 'error', message: errorMessage(err) });
    }
  });

  /**
   * Stop whatever is running, and pick it back up.
   *
   * A hung run held the lock until it went stale ninety minutes later, with
   * nothing on the page to clear it. Stop closes the run and frees the lock;
   * Restart resumes it from its last completed step, so the article written
   * before it hung is not written again.
   */
  app.post('/run/stop', async (request, reply) => {
    const runId = stopRun();
    return redirect(reply, runId ? `/runs/${runId}` : '/', {
      kind: runId ? 'ok' : 'warn',
      message: runId ? `Run ${runId} stopped and the lock released.` : 'Nothing was running.',
    });
  });

  app.post('/run/restart', async (request, reply) => {
    // Stop first: resume cannot take the lock while the stuck run holds it.
    const runId = stopRun('Stopped and restarted from the dashboard');
    if (!runId) {
      return redirect(reply, '/', { kind: 'warn', message: 'Nothing was running.' });
    }

    try {
      const result = await resumeRun(runId, settings, encryptionKey);
      return redirect(reply, `/runs/${runId}`, describeTick(result));
    } catch (err) {
      return redirect(reply, `/runs/${runId}`, { kind: 'error', message: errorMessage(err) });
    }
  });

  /* -- Runs -------------------------------------------------------------- */

  app.get('/runs', async (request, reply) => {
    const q = request.query as { page?: string; site?: string };
    const pageNum = Math.max(1, asNumber(q.page, 1));
    const siteId = asNumber(q.site, 0);
    return page(
      reply,
      'Runs',
      '/runs',
      runsPage(listRuns(50, (pageNum - 1) * 50, siteId), pageNum, countRuns(siteId), listHeldRuns(1000).length, {
        sites: listSites().map((x) => ({ id: x.id, domain: x.domain })),
        site: siteId,
      }),
      readFlash(request.query),
    );
  });

  /**
   * What this article drew from each rotation, by name.
   *
   * Looked up from the lists rather than joined: they are a handful of rows
   * each, and a run from before a rotation existed simply has nothing to show
   * rather than a dangling id.
   */
  const runRotations = (run: RunRow): { label: string; name: string }[] => {
    const named = (id: number | null | undefined, rows: { id: number; name: string }[]): string =>
      id ? rows.find((r) => r.id === id)?.name ?? '' : '';

    return [
      { label: 'Structure', name: named(run.article_structure_id, listArticleStructures()) },
      { label: 'Photo style', name: named(run.photo_style_id, listPhotoStyles()) },
      { label: 'Pin design', name: named(run.pin_design_id, listPinDesigns()) },
    ].filter((r) => r.name);
  };

  app.get('/runs/:id', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const run = getRun(id);
    if (!run) return redirect(reply, '/runs', { kind: 'error', message: `Run ${id} not found` });

    const steps = listSteps(id);
    const article = storedArticle(steps);

    return page(
      reply,
      run.title || `Run ${id}`,
      '/runs',
      runDetailPage({
        run,
        steps,
        site: run.site_id ? getSite(run.site_id) : undefined,
        keyword: run.keyword_id ? getKeyword(run.keyword_id) : undefined,
        usage: runUsage(id),
        article,
        rotations: runRotations(run),
        // Only worth computing where it will be read: on a held run, next to
        // the decision about whether to publish it.
        duplicate:
          run.hold && run.site_id && run.title
            ? findDuplicate(run.title, publishedTitles(run.site_id).filter((t) => t.title !== run.title))
            : null,
      }),
      readFlash(request.query),
    );
  });

  /** The generated article, read back out of its checkpoint. */
  const storedArticle = (steps: StepRow[]): Record<string, unknown> | null => {
    const step = steps.find((s) => s.step === 'generate-article' && s.status === 'ok');
    if (!step?.output_json) return null;

    try {
      const parsed = JSON.parse(step.output_json) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      // A truncated checkpoint is not worth a 500 on the page that would show
      // you it was truncated.
      return null;
    }
  };

  /**
   * Edit the generated article before it is published.
   *
   * Writes over the step's stored output, which is what a resume replays — so
   * approving after an edit publishes exactly what was on screen. Refused
   * unless it parses, because saving a malformed document here would turn a
   * held article into a failure at the post step later.
   */
  app.post('/runs/:id/article', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const run = getRun(id);
    if (!run) return redirect(reply, '/runs', { kind: 'error', message: 'Run not found' });

    if (!run.hold) {
      return redirect(reply, `/runs/${id}`, {
        kind: 'error',
        message: 'This run is not waiting for anything, so its article is not editable.',
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(asString(formBody(request).article));
    } catch (err) {
      return redirect(reply, `/runs/${id}`, {
        kind: 'error',
        message: `That is not valid JSON, so it was not saved: ${errorMessage(err)}`,
      });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return redirect(reply, `/runs/${id}`, {
        kind: 'error',
        message: 'The article has to be a JSON object.',
      });
    }

    const article = parsed as Record<string, unknown>;
    replaceStepOutput(id, 'generate-article', article);

    const title = typeof article.title === 'string' ? article.title.trim() : '';
    if (title) setRunTitle(id, title);

    return redirect(reply, `/runs/${id}`, {
      kind: 'ok',
      message: 'Saved. Approving now publishes what you edited.',
    });
  });

  /**
   * Throw away a held article and let the keyword be written again.
   *
   * The link goes back to `go` deliberately: discarding means "this attempt
   * was not good enough", not "never publish this keyword here". Leaving it
   * `done` would quietly retire the keyword for a rejection.
   */
  /** Discard several articles waiting for approval: the ticked ones, or all. */
  app.post('/runs/discard', async (request, reply) => {
    const body = formBody(request);
    const ids =
      asString(body.mode) === 'all'
        ? listHeldRuns(1000).map((r) => r.id)
        : ([] as unknown[]).concat(body.ids ?? []).map((v) => asNumber(v, 0)).filter((n) => n > 0);
    let discarded = 0;
    for (const id of ids) {
      const run = getRun(id);
      if (!run?.hold) continue;
      discardRun(id);
      // Back to go, as a single discard does. The run that picks it up checks
      // the site first, so a dish already there is skipped, not written again.
      if (run.keyword_id && run.site_id) setLink(run.keyword_id, run.site_id, 'go');
      discarded++;
    }
    return redirect(reply, '/runs', {
      kind: discarded ? 'ok' : 'warn',
      message: discarded ? `${discarded} article(s) discarded.` : 'Nothing was selected.',
    });
  });

  app.post('/runs/:id/discard', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const run = getRun(id);
    if (!run) return redirect(reply, '/runs', { kind: 'error', message: 'Run not found' });

    if (!run.hold) {
      return redirect(reply, `/runs/${id}`, {
        kind: 'error',
        message: 'Only an article waiting for approval can be discarded.',
      });
    }

    discardRun(id);
    if (run.keyword_id && run.site_id) setLink(run.keyword_id, run.site_id, 'go');

    return redirect(reply, '/', {
      kind: 'ok',
      message: 'Discarded. The keyword is back to go, so it will be written again.',
    });
  });

  app.post('/runs/:id/pin/retry', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    try {
      return redirect(reply, `/runs/${id}`, { kind: 'ok', message: await retryPinterestPin(id, settings, encryptionKey) });
    } catch (err) {
      return redirect(reply, `/runs/${id}`, { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/runs/:id/collage/retry', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    try {
      return redirect(reply, `/runs/${id}`, { kind: 'ok', message: await retryCollagePost(id, settings, encryptionKey) });
    } catch (err) {
      return redirect(reply, `/runs/${id}`, { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/runs/:id/resume', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    try {
      const result = await resumeRun(id, settings, encryptionKey);
      return redirect(reply, `/runs/${id}`, {
        kind: result.outcome === 'published' ? 'ok' : 'error',
        message:
          result.outcome === 'published'
            ? 'Resumed and published.'
            : `Resume ended as "${result.outcome}": ${result.detail ?? ''}`,
      });
    } catch (err) {
      return redirect(reply, `/runs/${id}`, { kind: 'error', message: errorMessage(err) });
    }
  });

  /* -- Sites ------------------------------------------------------------- */

  app.get('/sites', async (request, reply) => {
    const timezone = settings.get('timezone');
    const now = new Date();
    const views = loadSiteViews(localDateKey(now, timezone), timezone);
    const eligibility = views.map((site) => {
      const verdict = evaluateSite(site, { now, timezone });
      return { domain: site.domain, eligible: verdict.eligible, reason: verdict.reason };
    });
    return page(
      reply,
      'Sites',
      '/sites',
      sitesPage(
        listSites(),
        views,
        eligibility,
        Object.fromEntries(
          listSites().map((x) => [x.id, listBufferAccounts(x.id, encryptionKey).filter((a) => a.enabled && a.token.trim() !== '').length]),
        ),
      ),
      readFlash(request.query),
    );
  });

  app.get('/sites/:id', async (request, reply) => {
    const site = getSite(asNumber((request.params as { id: string }).id, 0));
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });
    return page(
      reply,
      site.domain,
      '/sites',
      siteEditPage(site, listBufferAccounts(site.id, encryptionKey)),
      readFlash(request.query),
    );
  });

  /**
   * One change across many sites.
   *
   * Editing eight sites to move the daily target meant eight pages, and the
   * eighth was where the typo went. Every action here is the same one the site
   * page performs, applied to the ticked rows.
   */
  app.post('/sites/bulk', async (request, reply) => {
    const body = formBody(request);

    // Fastify's form parser gives a single string for one checkbox and an
    // array for several; nothing ticked gives nothing at all.
    const picked = body.ids;
    const ids = (Array.isArray(picked) ? picked : picked === undefined ? [] : [picked])
      .map((value) => asNumber(value, 0))
      .filter((id) => id > 0);

    if (ids.length === 0) {
      return redirect(reply, '/sites', {
        kind: 'warn',
        message: 'Nothing was ticked, so nothing changed.',
      });
    }

    const done = (n: number, what: string): FastifyReply =>
      redirect(reply, '/sites', {
        kind: 'ok',
        message: `${n} site${n === 1 ? '' : 's'} ${what}.`,
      });

    switch (asString(body.action)) {
      case 'activate':
        return done(bulkActivate(ids), 'activated');

      case 'pause':
        // No end time and a reason that says where it came from: a bulk pause
        // is a deliberate stop, and one that expired on its own would be a
        // surprise later.
        return done(bulkPause(ids, 'Paused from the sites list'), 'paused');

      case 'delete':
        return done(bulkDeleteSites(ids), 'deleted');

      case 'auto':
        return done(bulkSetAutoPublish(ids, true), 'set to publish automatically');

      case 'hold':
        return done(bulkSetAutoPublish(ids, false), 'set to hold for approval');

      case 'target': {
        const target = Math.max(0, asNumber(body.daily_target, 0));
        return done(bulkSetDailyTarget(ids, target), `set to ${target} article(s) a day`);
      }

      case 'interval': {
        const minutes = readIntervalMinutes({
          interval_amount: body.interval_amount,
          interval_unit: body.interval_unit,
        });
        return done(bulkSetInterval(ids, minutes), `set to wait ${formatMinutes(minutes)}`);
      }

      default:
        return redirect(reply, '/sites', { kind: 'error', message: 'Unknown bulk action.' });
    }
  });

  /* -- Buffer accounts --------------------------------------------------- */
  // Several per site, tried in order. When Buffer refuses a post the run moves
  // to the next one rather than failing — see src/integrations/buffer-pool.ts.

  const bufferPlatform = (value: unknown): BufferPlatform | undefined => {
    const v = asString(value);
    return v === 'pinterest' || v === 'facebook' || v === 'instagram' || v === 'youtube' || v === 'tiktok' || v === 'both' ? v : undefined;
  };
  // Back to the page the form was on: Channels -> Pinterest or Facebook.
  const bufferBack = (body: Record<string, unknown>, siteId: number): string => {
    const raw = asString(body.back);
    return /^\/(accounts|pinterest|instagram|settings\/facebook|sites)(\/[\w-]*)?$/.test(raw) ? raw : `/sites/${siteId}`;
  };

  app.post('/sites/:id/buffer', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    const body = formBody(request);
    const back = bufferBack(body, siteId);

    try {
      upsertBufferAccount(
        {
          siteId,
          label: asString(body.label),
          token: asString(body.token),
          enabled: asString(body.enabled, '1') !== '0',
          platform: bufferPlatform(body.platform) ?? 'both',
          profileId: asNumber(body.profile_id, 0) || undefined,
        },
        encryptionKey,
      );
      return redirect(reply, back, { kind: 'ok', message: 'Buffer token added.' });
    } catch (err) {
      return redirect(reply, back, { kind: 'error', message: errorMessage(err) });
    }
  });

  app.get('/instagram', async (_request, reply) => reply.redirect('/accounts'));

  app.post('/instagram/link', async (request, reply) => {
    const body = formBody(request);
    const mode = asString(body.mode) === 'comment' ? 'comment' : 'bio';
    settings.set('ig_link_mode', mode);
    const keep = (key: string, field: string, max: number) => {
      const v = asString(body[field]).trim().slice(0, max);
      if (v) settings.set(key, v);
    };
    keep('ig_bio_line', 'bio_line', 150);
    keep('ig_comment_line', 'comment_line', 150);
    keep('ig_comment_text', 'comment_text', 300);
    return redirect(reply, /^\/accounts(\/\d+)?$/.test(asString(body.back)) ? asString(body.back) : '/instagram', {
      kind: 'ok',
      message: mode === 'bio' ? 'Saved: the caption says the link is in the bio.' : 'Saved: the link goes in the first comment.',
    });
  });

  app.post('/instagram/:id', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(siteId)) return redirect(reply, '/instagram', { kind: 'error', message: 'Site not found' });
    const body = formBody(request);
    const posts = asString(body.ig_posts) === '1';
    const reels = asString(body.ig_reels) === '1';
    setInstagramPublishing(siteId, posts, reels);
    const what = [posts ? 'posts' : '', reels ? 'reels' : ''].filter(Boolean).join(' and ') || 'nothing';
    return redirect(reply, /^\/accounts(\/\d+)?$/.test(asString(body.back)) ? asString(body.back) : '/instagram', { kind: 'ok', message: `Instagram will get ${what} from this site.` });
  });

  // YouTube takes Shorts and nothing else, so one switch rather than two.
  app.post('/youtube/:id', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(siteId)) return redirect(reply, '/accounts', { kind: 'error', message: 'Site not found' });
    const body = formBody(request);
    const reels = asString(body.yt_reels) === '1';
    runSql('UPDATE sites SET yt_reels = ? WHERE id = ?', reels ? 1 : 0, siteId);
    const back = /^\/accounts(\/\d+)?$/.test(asString(body.back)) ? asString(body.back) : '/accounts';
    return redirect(reply, back, { kind: 'ok', message: reels ? 'YouTube will get a Short for every reel.' : 'YouTube will get nothing from this site.' });
  });

  // TikTok, like YouTube, takes the reel's video and nothing else.
  app.post('/tiktok/:id', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(siteId)) return redirect(reply, '/accounts', { kind: 'error', message: 'Site not found' });
    const body = formBody(request);
    const reels = asString(body.tt_reels) === '1';
    runSql('UPDATE sites SET tt_reels = ? WHERE id = ?', reels ? 1 : 0, siteId);
    const back = /^\/accounts(\/\d+)?$/.test(asString(body.back)) ? asString(body.back) : '/accounts';
    return redirect(reply, back, { kind: 'ok', message: reels ? 'TikTok will get every reel the site makes.' : 'TikTok will get nothing from this site.' });
  });

  /* -- Channels -> Accounts --------------------------------------------- */

  /** The site last opened on Channels -> Accounts, so a form sent from it comes back to it. */
  const accountsSite = (request: FastifyRequest): number => {
    const m = /(?:^|;\s*)acc_site=(\d+)/.exec(String(request.headers.cookie ?? ''));
    return m ? Number(m[1]) : 0;
  };

  /**
   * What each network of a site really gets, and why a ticked switch may do
   * nothing: Buffer off in Setup, reels off, no Facebook page for the site's
   * niches, reels not published through Buffer. The cards' headers show it.
   */
  const channelStates = (siteId: number, site: (SiteRow & { ig_posts?: number; ig_reels?: number; yt_reels?: number; tt_reels?: number }) | undefined) => {
    const fbOn = settings.getBool('fb_enabled');
    const viaBuffer = settings.get('reel_publisher') === 'buffer';
    const bufferOn = settings.getBool('buffer_enabled');
    const fb = facebookForSite(siteId);
    // Reels are made with Facebook reels on, for a page that takes them -- or,
    // through Buffer, for the other networks alone when no page does.
    const elsewhere = Boolean(site && reelsElsewhere(site));
    const reelsMade = fbOn && (fb.reels || (viaBuffer && elsewhere));
    const reelBlock = !fbOn
      ? 'reels: Facebook reels are off in Setup'
      : !viaBuffer ? 'reels: set Publish reels through Buffer' : '';
    const pinPosts = (site?.pin_posts ?? 1) !== 0;
    const state = (posts: [boolean, string], reels: [boolean, string]) => ({
      on: [posts[0] && !posts[1] ? 'posts' : '', reels[0] && !reels[1] ? 'reels' : ''].filter(Boolean),
      notes: [posts[0] ? posts[1] : '', reels[0] ? reels[1] : ''].filter(Boolean),
    });
    return {
      pinterest: state(
        [pinPosts, bufferOn ? '' : 'posts: Buffer is off in Setup'],
        [Boolean(site?.pin_reels), reelsMade && viaBuffer ? '' : reelBlock],
      ),
      facebook: {
        on: [
          fbOn && viaBuffer && fb.posts ? 'posts' : '',
          fbOn && fb.reels ? 'reels' : '',
          fbOn && viaBuffer && fb.collage && settings.getBool('collage_enabled') ? 'collage' : '',
        ].filter(Boolean),
        notes: [
          fb.pages.length === 0 ? 'no Facebook page for this site' : '',
          fb.posts && !fbOn ? 'posts: Facebook is off in Setup' : '',
          fb.posts && fbOn && !viaBuffer ? 'posts: set Publish reels through Buffer' : '',
          fb.reels && !fbOn ? 'reels: Facebook reels are off in Setup' : '',
          fb.collage && !settings.getBool('collage_enabled') ? 'collage: off in Setup -> Collage' : '',
          fb.collage && fbOn && !viaBuffer ? 'collage: set Publish reels through Buffer' : '',
        ].filter(Boolean),
      },
      instagram: state(
        [Boolean(site?.ig_posts), ''],
        [Boolean(site?.ig_reels), reelsMade && viaBuffer ? '' : reelBlock],
      ),
      // YouTube takes Shorts and nothing else: there is no article or pin to
      // send there, so its posts half is always off.
      youtube: state(
        [false, ''],
        [Boolean(site?.yt_reels), reelsMade && viaBuffer ? '' : reelBlock],
      ),
      // TikTok, like YouTube, only ever takes the reel's video.
      tiktok: state(
        [false, ''],
        [Boolean(site?.tt_reels), reelsMade && viaBuffer ? '' : reelBlock],
      ),
    };
  };

  const accountsView = (reply: FastifyReply, flash: Flash, siteId = 0) => {
    const groups = keywordGroups();
    const allFbPages = listFbPages();
    // Profile ids are unique across every site, so one map read once serves them all.
    // A profile can have more than one row pointing at it -- the card's own
    // "profile:<id>" row that the Posts/Reels/Collage boxes are saved to, plus
    // a real page a Graph sync or old migration linked to the same profile. The
    // card's row is the one the boxes live on, so it wins; without this a stale
    // linked row (boxes = 0) could shadow it and the boxes would read empty
    // right after being saved. Same rule as getFbPageByProfile.
    const fbPages = new Map<number, FbPageRow>();
    for (const p of allFbPages) {
      if (p.profile_id === null) continue;
      const existing = fbPages.get(p.profile_id);
      if (!existing || p.page_id === `profile:${p.profile_id}`) {
        fbPages.set(p.profile_id, p);
      }
    }
    // The "Facebook tokens" block (the separate, direct-to-Graph way to post
    // without Buffer) is its own system, unrelated to the account cards
    // above. It used to stay hidden until a token or a token-brought page
    // already existed, on the idea that Buffer-only users have no reason to
    // see it -- but that also hid the one form that adds the first token,
    // so nobody could ever get past zero. Shown always now; the section
    // itself is a collapsed <details>, so an account that never uses it
    // costs one more collapsed row, not a page full of controls.
    const fbTokens = listFbTokens();
    const showFbSettings = true;
    const views = listSites().map((x) => {
      const site = getSite(x.id) as (SiteRow & { ig_posts?: number; ig_reels?: number; yt_reels?: number; tt_reels?: number }) | undefined;
      // Every site has at least account 1 of each network, so there is always somewhere to put a token.
      for (const platform of ['pinterest', 'facebook', 'instagram', 'youtube', 'tiktok'] as const) firstProfile(x.id, platform);
      return {
        id: x.id,
        domain: x.domain,
        pinPosts: (site?.pin_posts ?? 1) !== 0,
        pinReels: Boolean(site?.pin_reels),
        igPosts: Boolean(site?.ig_posts),
        igReels: Boolean(site?.ig_reels),
        ytReels: Boolean(site?.yt_reels),
        ttReels: Boolean(site?.tt_reels),
        profiles: listProfiles(x.id),
        tokens: listBufferAccounts(x.id, encryptionKey),
        fbPages,
        postToAll: (['pinterest', 'facebook', 'instagram', 'youtube', 'tiktok'] as const).filter((p) => postsToAll(x.id, p)),
        effective: channelStates(x.id, site),
        nameSuggestions: getAccountNameSuggestions(x.id),
      };
    });
    const current = views.find((v) => v.id === siteId) ?? views[0] ?? null;
    if (current) reply.header('set-cookie', `acc_site=${current.id}; Path=/; Max-Age=31536000; SameSite=Lax`);
    return page(reply, 'Accounts', '/accounts',
      accountsPage({
        sites: views,
        site: current,
        groups,
        igLink: igLinkCard({
          mode: settings.get('ig_link_mode') === 'comment' ? 'comment' : 'bio',
          bioLine: settings.get('ig_bio_line'),
          commentLine: settings.get('ig_comment_line'),
          commentText: settings.get('ig_comment_text'),
        }, current ? `/accounts/${current.id}` : '/accounts', true),
        facebookPages: showFbSettings
          ? facebookSettingsPage({
              enabled: settings.getBool('fb_enabled'),
              tokens: fbTokens,
              pages: allFbPages,
              sites: listSites().map((x) => ({ id: x.id, domain: x.domain })),
              siteId: current?.id ?? 0,
              presenters: listPresenters(),
            })
          : raw(''),
      }),
      flash);
  };

  app.get('/accounts', async (request, reply) => accountsView(reply, readFlash(request.query), accountsSite(request)));
  app.get('/accounts/:siteId', async (request, reply) =>
    accountsView(reply, readFlash(request.query), asNumber((request.params as { siteId: string }).siteId, 0)));

  app.post('/accounts/:siteId/:platform/add', async (request, reply) => {
    const params = request.params as { siteId: string; platform: string };
    const siteId = asNumber(params.siteId, 0);
    const platform = (['pinterest', 'facebook', 'instagram', 'youtube', 'tiktok'] as const).find((p) => p === params.platform);
    if (!platform || !getSite(siteId)) return redirect(reply, '/accounts', { kind: 'error', message: 'Site not found' });
    firstProfile(siteId, platform);
    const id = addProfile(siteId, platform);
    const added = getProfile(id)!;
    return redirect(reply, `/accounts#profile-${id}`, {
      kind: 'ok',
      message: platform === 'pinterest'
        ? `${added.label} added with the first account's boards. Fill in its username and Buffer token.`
        : `${added.label} added. Fill in its name and Buffer token.`,
    });
  });

  // Rotate (the default) or post to all, for one network of one site.
  app.post('/accounts/:siteId/:platform/mode', async (request, reply) => {
    const params = request.params as { siteId: string; platform: string };
    const siteId = asNumber(params.siteId, 0);
    const platform = (['pinterest', 'facebook', 'instagram', 'youtube', 'tiktok'] as const).find((p) => p === params.platform);
    if (!platform || !getSite(siteId)) return redirect(reply, '/accounts', { kind: 'error', message: 'Site not found' });
    const all = asString(formBody(request).mode) === 'all';
    setPostToAll(siteId, platform, all);
    const name = { pinterest: 'Pinterest', facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok' }[platform];
    return redirect(reply, `/accounts/${siteId}#net-${platform}`, {
      kind: 'ok',
      message: all
        ? `${name}: every post now goes to every account that is on and has a Buffer token.`
        : `${name}: back to one account per post, in turn.`,
    });
  });

  app.post('/accounts/profile/:id', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const profile = getProfile(id);
    if (!profile) return redirect(reply, '/accounts', { kind: 'error', message: 'Account not found' });
    const body = formBody(request);
    const channelName = asString(body.channel_name).trim().slice(0, 200);
    updateProfile(id, {
      channel_name: channelName,
      // Absent from the form (an older page, a script): left as it was.
      ...('buffer_channel' in body ? { buffer_channel: asString(body.buffer_channel).trim().slice(0, 200) } : {}),
      enabled: 'enabled' in body ? 1 : 0,
    });
    // A Facebook account is the page it posts as: Posts and Reels live on
    // this same card, so saving it also sets the page behind it.
    if (profile.platform === 'facebook') {
      upsertFbPageForProfile(id, profile.site_id, channelName, 'posts' in body, 'reels' in body, 'collage' in body);
    }
    // Pinterest and Instagram: the same two ticks, on the account itself. Only
    // from a form that carries them, so an older page cannot clear both.
    if ((profile.platform === 'pinterest' || profile.platform === 'instagram') && 'kinds' in body) {
      setProfileKinds(id, 'posts' in body, 'reels' in body);
    }
    return redirect(reply, `/accounts#profile-${id}`, { kind: 'ok', message: 'Saved.' });
  });

  app.post('/accounts/profile/:id/delete', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const profile = getProfile(id);
    // Checked ahead of deleteProfile, which applies the same rule: the last
    // account of a network is not removed, and its page must not disappear
    // out from under it. deleteProfile's own delete carries fb_pages.profile_id
    // to NULL (ON DELETE SET NULL), so the page row has to go first or it
    // would be left behind, orphaned, once that id is gone.
    const willRemove = Boolean(profile) && listProfiles(profile!.site_id, profile!.platform).length > 1;
    if (willRemove && profile!.platform === 'facebook') deleteFbPageByProfile(id);
    return redirect(reply, '/accounts', deleteProfile(id)
      ? { kind: 'ok', message: 'Account removed.' }
      : { kind: 'warn', message: 'The last account of a network stays. Switch it off instead.' });
  });

  /** The boards on a Pinterest account's profile, read through its first Buffer token; null without one. */
  async function profileBoardNames(profile: ChannelProfile): Promise<string[] | null> {
    return (await profileBoards(profile))?.names ?? null;
  }

  /**
   * The Pinterest profile an account posts to on its Buffer token, and its boards.
   * A name that matches no profile there is an error, not "the first one": that
   * would read another account's boards and call them this one's.
   */
  async function profileBoards(profile: ChannelProfile): Promise<{ channel: string; token: string; names: string[] } | null> {
    const token = listBufferAccounts(profile.site_id, encryptionKey).find((a) => a.profileId === profile.id && a.enabled && a.token);
    if (!token) return null;
    const client = new BufferClient(token.token);
    const channels = (await client.getChannels(await client.getOrganizationId()))
      .filter((c) => c.service === '' || c.service === 'pinterest');
    const username = bufferChannelName(profile).trim().toLowerCase();
    const channel = username ? channels.find((c) => c.name.toLowerCase() === username) : channels[0];
    if (!channel) {
      throw new Error(username
        ? `no Pinterest profile named "${bufferChannelName(profile).trim()}" on the Buffer token ${token.label || ''}; it has: ${channels.map((c) => c.name).join(', ') || '(none)'}`
        : `the Buffer token ${token.label || ''} has no Pinterest profile`);
    }
    return { channel: channel.name, token: token.label || '', names: (channel.boards ?? []).map((b) => b.name) };
  }

  /**
   * The channels of an account's network on its Buffer account, by name, for
   * the "Pick from Buffer" button next to "Name on Buffer". Read through the
   * account's own Buffer token, so each account lists its own pages.
   */
  app.get('/accounts/profile/:id/buffer-channels', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const profile = getProfile(id);
    if (!profile) return reply.code(404).send({ error: 'Account not found' });
    const token = listBufferAccounts(profile.site_id, encryptionKey).find((a) => a.profileId === profile.id && a.enabled && a.token);
    if (!token) return reply.code(409).send({ error: 'Add a Buffer token to this account first.' });
    try {
      const client = new BufferClient(token.token);
      const channels = (await client.getChannels(await client.getOrganizationId()))
        .filter((c) => c.service === '' || c.service === profile.platform);
      return { names: channels.map((c) => c.name) };
    } catch (err) {
      return reply.code(502).send({ error: `Buffer did not answer: ${errorMessage(err)}` });
    }
  });

  app.post('/accounts/profile/:id/boards', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const profile = getProfile(id);
    if (!profile) return redirect(reply, '/accounts', { kind: 'error', message: 'Account not found' });
    const body = formBody(request);
    const defaultBoard = asString(body.default_board).trim();
    const map = asString(body.board_map).trim();
    updateProfile(id, { default_board: defaultBoard, board_map: map });
    const to = `/accounts#profile-${id}`;
    const wanted = [defaultBoard, ...parseBoardMap(map).values()].filter(Boolean);
    try {
      const names = wanted.length ? await profileBoardNames(profile) : null;
      if (!names) return redirect(reply, to, { kind: 'ok', message: 'Boards saved.' });
      const missing = wanted.filter((w) => !names.some((n) => n.toLowerCase() === w.toLowerCase()));
      return redirect(reply, to, missing.length
        ? { kind: 'warn', message: `Saved, but not on ${profile.label}: ${missing.join(', ')}. Its boards: ${names.join(', ') || '(none)'}.` }
        : { kind: 'ok', message: `Boards saved. Every name matches a board on ${profile.label}.` });
    } catch (err) {
      return redirect(reply, to, { kind: 'warn', message: `Boards saved; could not check them against Buffer: ${errorMessage(err)}` });
    }
  });

  app.post('/accounts/profile/:id/boards/suggest', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const profile = getProfile(id);
    const site = profile ? getSite(profile.site_id) : undefined;
    if (!profile || !site) return redirect(reply, '/accounts', { kind: 'error', message: 'Account not found' });
    const to = `/accounts#profile-${id}`;
    const groups = siteTopicGroups(site.id);
    if (groups.length === 0) {
      return redirect(reply, to, { kind: 'warn', message: 'This site has no keywords yet: add some, then suggest boards.' });
    }
    try {
      let existing: string[] = [];
      let readFrom = '';
      try {
        const read = await profileBoards(profile);
        existing = read?.names ?? [];
        if (read) readFrom = ` Read from ${read.channel} (Buffer ${read.token}), its boards: ${existing.join(', ') || '(none)'}.`;
      } catch (err) {
        return redirect(reply, to, { kind: 'error', message: `Could not read the boards from Buffer, so nothing was suggested: ${errorMessage(err)}` });
      }
      const result = await suggestBoardPlan(site, groups, existing, profile.default_board, profile.board_map, profile.board_suggestions);
      updateProfile(id, {
        board_suggestions: JSON.stringify({ boards: result.boards, general: result.general }),
        default_board: result.defaultBoard,
        board_map: result.mapText,
      });
      return redirect(reply, to, {
        kind: 'ok',
        message: result.toCreate
          ? `Boards linked. ${result.toCreate} new board(s) to create on Pinterest (marked Create below), then press Save boards to check.${readFrom}`
          : `Every group is linked to a board you already have. Nothing to create.${readFrom}`,
      });
    } catch (err) {
      return redirect(reply, to, { kind: 'error', message: `Could not suggest boards: ${errorMessage(err)}` });
    }
  });

  /**
   * Names for a new Pinterest account, built on the boards the site's
   * Pinterest accounts pin into and its topic groups.
   */
  app.post('/accounts/:siteId/pinterest/names', async (request, reply) => {
    const siteId = asNumber((request.params as { siteId: string }).siteId, 0);
    const site = getSite(siteId);
    const to = `/accounts/${siteId}#net-pinterest`;
    if (!site) return redirect(reply, '/accounts', { kind: 'error', message: 'Site not found' });
    const profiles = listProfiles(siteId, 'pinterest');
    const boards = new Map<string, string>();
    for (const p of profiles) {
      for (const n of [p.default_board, ...parseBoardMap(p.board_map).values()]) {
        if (n?.trim() && !boards.has(n.trim().toLowerCase())) boards.set(n.trim().toLowerCase(), n.trim());
      }
    }
    const groups = siteTopicGroups(siteId, 25);
    if (boards.size === 0 && groups.length === 0) {
      return redirect(reply, to, { kind: 'warn', message: 'No boards or keywords yet: set the boards (or add keywords) first, then suggest names.' });
    }
    const taken = profiles.map((p) => p.channel_name.trim()).filter(Boolean);
    try {
      const answer = await askPrompt(settings, encryptionKey, 'suggest-account-names', {
        site: { name: site.name, domain: site.domain },
        boards: [...boards.values()].map((n) => `- ${n}`).join('\n') || '(none yet)',
        groups: groups.map((g) => `- ${g.group}`).join('\n') || '(none yet)',
        taken: taken.map((n) => `- ${n}`).join('\n') || '(none)',
      });
      const parsed = tryParseJson<{ names?: Partial<AccountName>[] }>(answer.content)?.value;
      const seen = new Set(taken.map((n) => n.toLowerCase()));
      const names: AccountName[] = [];
      for (const n of parsed?.names ?? []) {
        const display = String(n?.display ?? '').trim();
        const username = String(n?.username ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
        if (!display || username.length < 3 || seen.has(username)) continue;
        seen.add(username);
        // The view adds the " | " itself: one the model put in too showed as "Name | | Tagline".
        names.push({ display: display.replace(/[\s|]+$/, ''), username, tagline: String(n?.tagline ?? '').replace(/^[\s|]+|[\s|]+$/g, ''), bio: String(n?.bio ?? '').trim() });
      }
      if (names.length === 0) throw new Error('the model gave no usable names');
      setAccountNameSuggestions(siteId, names);
      return redirect(reply, to, { kind: 'ok', message: `${names.length} names suggested below. Check the username is free on Pinterest before you pick one.` });
    } catch (err) {
      return redirect(reply, to, { kind: 'error', message: `Could not suggest names: ${errorMessage(err)}` });
    }
  });

  app.post('/accounts/:siteId/pinterest/names/clear', async (request, reply) => {
    const siteId = asNumber((request.params as { siteId: string }).siteId, 0);
    setAccountNameSuggestions(siteId, []);
    return redirect(reply, `/accounts/${siteId}#net-pinterest`, { kind: 'ok', message: 'Suggestions hidden.' });
  });

  /** Hide or show the last board suggestions: kept either way, so pressing Suggest again still builds on them. */
  const showSuggestions = (id: number, show: boolean): boolean => {
    const profile = getProfile(id);
    if (!profile?.board_suggestions) return false;
    try {
      const plan = JSON.parse(profile.board_suggestions) as Record<string, unknown>;
      if (show) delete plan.hidden; else plan.hidden = true;
      updateProfile(id, { board_suggestions: JSON.stringify(plan) });
      return true;
    } catch { return false; }
  };

  app.post('/accounts/profile/:id/boards/suggest/clear', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    showSuggestions(id, false);
    return redirect(reply, `/accounts#profile-${id}`, { kind: 'ok', message: 'Suggestions hidden. Show suggestions brings them back.' });
  });

  app.post('/accounts/profile/:id/boards/suggest/show', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    return redirect(reply, `/accounts#profile-${id}`, showSuggestions(id, true)
      ? { kind: 'ok', message: 'Suggestions shown.' }
      : { kind: 'warn', message: 'No suggestions to show: press Suggest boards.' });
  });

  /**
   * One board plan: the model's board per topic group, settled against the
   * boards the account already has (a near match becomes that board), with
   * the links filled -- the suggestion wins for its groups, other lines stay.
   */
  async function suggestBoardPlan(
    site: SiteRow,
    groups: { group: string; examples: string[] }[],
    existing: string[],
    currentDefault: string,
    currentMap: string,
    lastSuggestions = '',
  ) {
    type Board = { name: string; description: string; exists: boolean };
    const known = new Map(groups.map((g) => [g.group.toLowerCase(), g.group]));

    // New boards the last press proposed that are still not on Pinterest:
    // pressing again keeps them, name and description, rather than renaming.
    const pending = new Map<string, { name: string; description: string }>();
    try {
      const last = lastSuggestions ? (JSON.parse(lastSuggestions) as BoardPlan) : null;
      for (const b of [...(last?.boards ?? []), ...(last?.general ? [last.general] : [])]) {
        const key = String(b?.name ?? '').trim().toLowerCase();
        if (key && !findBoard(b.name, existing) && !pending.has(key)) pending.set(key, { name: b.name.trim(), description: b.description ?? '' });
      }
    } catch { /* an unreadable old plan: nothing to keep */ }
    const pendingNames = () => [...pending.values()].map((p) => p.name);
    /** An account board, a board still to create from last time, or undefined. */
    const lookup = (name: string): Board | undefined => {
      const real = existing.length ? findBoard(name, existing) : undefined;
      if (real) return { name: real, description: '', exists: true };
      const was = findBoard(name, pendingNames());
      if (was) return { name: was, description: pending.get(was.toLowerCase())?.description ?? '', exists: false };
      return existing.length ? undefined : { name, description: '', exists: false };
    };

    // A group already linked to a board the account has (or one proposed last
    // time) keeps it: pressing again only decides the groups still open.
    const map = parseBoardMap(currentMap);
    const settled = new Map<string, Board>();
    for (const [g, n] of [...map]) {
      const board = lookup(n);
      if (!board) { map.delete(g); continue; }
      map.set(g, board.name);
      if (known.has(g)) settled.set(g, board);
    }
    const defaultBoard = currentDefault.trim() ? lookup(currentDefault.trim()) : undefined;
    // A board still to create needs a description to copy: a group linked to
    // one that has none (copied from the first account) keeps its board name
    // but is asked about, for the description.
    const needsText = (b: Board | undefined) => Boolean(b && !b.exists && !b.description);
    const open = groups.filter((g) => {
      const s = settled.get(g.group.toLowerCase());
      return !s || needsText(s);
    });

    let parsed: BoardPlan | undefined;
    if (open.length || !defaultBoard || needsText(defaultBoard)) {
      const answer = await askPrompt(settings, encryptionKey, 'suggest-boards', {
        site: { name: site.name, domain: site.domain },
        groups: [
          ...open.map((g) => {
            const keep = settled.get(g.group.toLowerCase());
            return `- ${g.group}${g.examples.length ? `: ${g.examples.join('; ')}` : ''}${keep ? ` (board: ${keep.name})` : ''}`;
          }),
          ...(needsText(defaultBoard) ? [`(the general board must be named exactly "${defaultBoard!.name}": write its description)`] : []),
        ].join('\n') || '(none: only the general board is needed)',
        existing: [...existing, ...pendingNames()].map((n) => `- ${n}`).join('\n') || '(none yet)',
      });
      parsed = tryParseJson<BoardPlan>(answer.content)?.value;
    }
    // A board still to create keeps the description just written for it: with
    // no boards to read (no Buffer token yet), lookup hands every name back
    // bare, and the text to copy into Pinterest was lost.
    const settle = (name: string, description: string): Board => {
      const found = lookup(name);
      if (!found) return { name, description, exists: false };
      return found.exists ? found : { ...found, description: found.description || description };
    };

    const boards: ({ group: string } & Board)[] = groups.map((g) => {
      const key = g.group.toLowerCase();
      const s = settled.get(key);
      const said = (parsed?.boards ?? []).find((b) => b && typeof b.name === 'string' && b.name.trim() && String(b.group ?? '').toLowerCase() === key);
      if (s) return { group: g.group, ...s, description: needsText(s) ? String(said?.description ?? '').trim() : s.description };
      return said ? { group: g.group, ...settle(said.name.trim(), String(said.description ?? '').trim()) } : null;
    }).filter((b): b is { group: string } & Board => b !== null);

    // Two new names for one topic in the same answer become one board.
    const fresh: string[] = [];
    for (const b of boards) {
      if (b.exists) continue;
      const twin = findBoard(b.name, fresh);
      if (twin) { b.name = twin; b.description = boards.find((x) => x.name === twin && x.description)?.description ?? b.description; }
      else fresh.push(b.name);
    }
    // A group named like a board goes on that board, whatever the model said:
    // "honey" belongs on "Honey Recipes", not on "Chicken Recipes".
    const candidates = [...existing, ...fresh];
    for (const b of boards) {
      const own = candidates.find((n) => sameBoard(b.group, n));
      if (!own || own === b.name) continue;
      const isNew = !existing.includes(own);
      b.name = own;
      b.exists = !isNew;
      b.description = isNew ? boards.find((x) => x.name === own && x.description)?.description ?? '' : '';
    }

    const general: Board | null = defaultBoard
      ? (defaultBoard.exists ? null : { ...defaultBoard, description: defaultBoard.description || String(parsed?.general?.description ?? '').trim() })
      : parsed?.general && typeof parsed.general.name === 'string' && parsed.general.name.trim()
        ? settle(parsed.general.name.trim(), String(parsed.general.description ?? '').trim())
        : null;
    if (boards.length === 0 && !general && !defaultBoard) throw new Error('the model gave no usable boards');
    for (const b of boards) map.set(b.group.toLowerCase(), b.name);
    const mapText = [...map].map(([g, n]) => `${known.get(g) ?? g} = ${n}`).join('\n');
    const toCreate = new Set([...boards, ...(general ? [general] : [])].filter((b) => !b.exists).map((b) => b.name)).size;
    return { boards, general, mapText, defaultBoard: general?.name || defaultBoard?.name || '', toCreate };
  }

  // Pinterest and Instagram live on Channels -> Accounts now, site by site.
  app.get('/pinterest', async (_request, reply) => reply.redirect('/accounts'));

  app.post('/pinterest/:id/publish', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(siteId)) return redirect(reply, '/pinterest', { kind: 'error', message: 'Site not found' });
    const body = formBody(request);
    const posts = asString(body.pin_posts) === '1';
    const reels = asString(body.pin_reels) === '1';
    setPinterestPublishing(siteId, posts, reels);
    const what = [posts ? 'posts' : '', reels ? 'reels' : ''].filter(Boolean).join(' and ') || 'nothing';
    return redirect(reply, /^\/accounts(\/\d+)?$/.test(asString(body.back)) ? asString(body.back) : '/pinterest', { kind: 'ok', message: `Pinterest will get ${what} from this site.` });
  });

  app.post('/sites/:id/buffer/:accountId', async (request, reply) => {
    const params = request.params as { id: string; accountId: string };
    const siteId = asNumber(params.id, 0);
    const body = formBody(request);
    const back = bufferBack(body, siteId);

    try {
      upsertBufferAccount(
        {
          siteId,
          label: asString(body.label),
          token: asString(body.token),
          // An unchecked checkbox sends nothing, so absence is "off" here
          // rather than "leave it alone".
          enabled: 'enabled' in body,
          platform: bufferPlatform(body.platform),
        },
        encryptionKey,
        asNumber(params.accountId, 0),
      );
      return redirect(reply, back, { kind: 'ok', message: 'Buffer account saved.' });
    } catch (err) {
      return redirect(reply, back, { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/sites/:id/buffer/:accountId/delete', async (request, reply) => {
    const params = request.params as { id: string; accountId: string };
    deleteBufferAccount(asNumber(params.accountId, 0));
    return redirect(reply, bufferBack(formBody(request), asNumber(params.id, 0)), {
      kind: 'ok',
      message: 'Buffer account removed.',
    });
  });

  /** Convert the form's amount + unit pair into stored minutes. */
  const readIntervalMinutes = (body: Record<string, unknown>): number => {
    const amount = Math.max(0, asNumber(body.interval_amount, 8));
    const unit = asString(body.interval_unit, 'hours');
    const factor = unit === 'minutes' ? 1 : unit === 'days' ? 1440 : 60;
    return Math.round(amount * factor);
  };

  /** The upper end of the range, in the same unit; empty or not above the lower end = fixed gap (0). */
  const readIntervalMaxMinutes = (body: Record<string, unknown>): number => {
    const raw = asString(body.interval_max_amount).trim();
    if (raw === '') return 0;
    const amount = Math.max(0, asNumber(raw, 0));
    const unit = asString(body.interval_unit, 'hours');
    const factor = unit === 'minutes' ? 1 : unit === 'days' ? 1440 : 60;
    const max = Math.round(amount * factor);
    return max > readIntervalMinutes(body) ? max : 0;
  };

  const saveSite = (body: Record<string, unknown>, id?: number): number =>
    upsertSite(
      {
        name: asString(body.name).trim(),
        // Left blank: a social-only account, stored under a handle made from its name.
        domain: siteKey(asString(body.name), asString(body.domain)),
        status: asString(body.status) === 'active' ? 'active' : 'paused',
        // Set on Channels -> Pinterest now; kept when the site form does not carry it.
        pin_username: 'pin_username' in body ? asString(body.pin_username).trim() : undefined,
        // Set per Google account now; kept when the form does not carry it.
        project_id: 'project_id' in body ? asString(body.project_id).trim() : undefined,
        daily_target: Math.max(0, asNumber(body.daily_target, 0)),
        interval_minutes: readIntervalMinutes(body),
        // Only the site form carries it; elsewhere the stored range is kept.
        interval_max_minutes: 'interval_max_amount' in body ? readIntervalMaxMinutes(body) : undefined,
        // Absent, not blank. The site form no longer carries these — pausing
        // and publishing mode are their own controls on the site page — and
        // upsertSite reads undefined as "keep what is stored". Reading them
        // off the body regardless would make every save of the settings form
        // silently clear the pause reason and switch approval back on.
        paused_reason: 'paused_reason' in body ? asString(body.paused_reason).trim() : undefined,
        auto_publish:
          'auto_publish' in body ? asString(body.auto_publish, '1') !== '0' : undefined,
        // Blank means "keep the stored credential".
        apiToken: asString(body.api_token),
        bufferToken: asString(body.buffer_token),
      },
      encryptionKey,
      id,
    );

  app.post('/sites', async (request, reply) => {
    try {
      const body = formBody(request);
      const key = siteKey(asString(body.name), asString(body.domain));
      // A blank domain is a new social-only account; one whose name is
      // already taken must not quietly overwrite the other account's settings.
      if (isSocialOnly({ domain: key }) && getSiteByDomain(key)) {
        throw new Error(`Another account is already called "${key}". Pick another name.`);
      }
      // A domain is one site: adding it again used to overwrite that site's
      // name, status, schedule and tokens with this blank form's.
      const taken = isSocialOnly({ domain: key }) ? undefined : getSiteByDomain(key);
      if (taken) {
        throw new Error(
          `${key} is already a site here ("${taken.name}"). One domain is one site: open its Edit to change it. ` +
            'For more Pinterest, Facebook or other accounts on the same site, add them under Channels → Accounts.',
        );
      }
      saveSite(body);
      return redirect(reply, '/sites', {
        kind: 'ok',
        message: isSocialOnly({ domain: key }) ? `Social-only account "${key}" added.` : 'Site added.',
      });
    } catch (err) {
      return redirect(reply, '/sites', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/sites/:id', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const site = getSite(id);
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });

    const body = formBody(request);
    let newDomain: string;
    try {
      newDomain = siteKey(asString(body.name), asString(body.domain));
    } catch (err) {
      return redirect(reply, `/sites/${id}`, { kind: 'error', message: errorMessage(err) });
    }

    // Renaming onto a domain another site already owns would violate the
    // UNIQUE constraint; say so plainly instead of surfacing a SQL error.
    if (newDomain !== site.domain) {
      const clash = getSiteByDomain(newDomain);
      if (clash && clash.id !== id) {
        return redirect(reply, `/sites/${id}`, {
          kind: 'error',
          message: `Another site or account already uses ${newDomain}.`,
        });
      }
    }

    try {
      saveSite(body, id);
      const renamed = newDomain !== site.domain;
      return redirect(reply, '/sites', {
        kind: 'ok',
        message: renamed ? `Renamed ${site.domain} to ${newDomain}.` : `${newDomain} updated.`,
      });
    } catch (err) {
      return redirect(reply, `/sites/${id}`, { kind: 'error', message: errorMessage(err) });
    }
  });

  /**
   * Pause a site with a note and, usually, an end.
   *
   * The quick control on the site page rather than the full form, because
   * pausing is something you do in a hurry when a site starts misbehaving —
   * and the reason is worth capturing exactly then, while you still know it.
   */
  app.post('/sites/:id/pause', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const site = getSite(id);
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });

    const body = formBody(request);
    const reason = asString(body.reason).trim() || 'No reason given';
    const hours = Math.max(0, asNumber(body.hours, 24));
    const until = hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;

    pauseSite(id, reason, until);

    return redirect(reply, `/sites/${id}`, {
      kind: 'ok',
      message: until
        ? `${site.domain} is paused and will resume by itself in ${hours} hour(s).`
        : `${site.domain} is paused until you resume it.`,
    });
  });

  /**
   * Whether this site publishes on its own or holds each article for you.
   *
   * Its own control beside Pause rather than a field in the settings form:
   * both answer "what is this site doing right now", and neither means
   * anything on a site that does not exist yet.
   */
  app.post('/sites/:id/publishing', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const site = getSite(id);
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });

    const auto = asString(formBody(request).auto_publish, '1') !== '0';
    setAutoPublish(id, auto);

    return redirect(reply, `/sites/${id}`, {
      kind: 'ok',
      message: auto
        ? `${site.domain} publishes automatically again.`
        : `${site.domain} will hold every article until you approve it.`,
    });
  });

  /**
   * Which spelling and units this site is written in.
   *
   * Its own control beside publishing mode: a site is American or British, and
   * that is not a thing to find in a long settings form. The value is read
   * strictly — anything but "uk" is "us" — so a malformed post cannot store
   * something the pipeline does not understand.
   */
  app.post('/sites/:id/style', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const site = getSite(id);
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });

    const style = normaliseStyle(formBody(request).writing_style);
    setWritingStyle(id, style);

    return redirect(reply, `/sites/${id}`, {
      kind: 'ok',
      message: `${site.domain} is now written in ${style === 'fr' ? 'French with metric units' : style === 'uk' ? 'British spelling with metric units' : 'American spelling with US units'}. The next article uses it.`,
    });
  });

  app.post('/sites/:id/activate', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const site = getSite(id);
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });

    activateSite(id);
    return redirect(reply, `/sites/${id}`, {
      kind: 'ok',
      message: `${site.domain} is publishing again.`,
    });
  });

  /**
   * Bulk site entry from a spreadsheet.
   *
   * Matched on the domain, so importing the same file twice corrects rather
   * than duplicates. A blank token keeps whatever is stored, which is what
   * makes the credential-free export safe to edit and import back.
   */
  app.post('/sites/import', async (request, reply) => {
    try {
      const file = await request.file();
      if (!file) {
        return redirect(reply, '/sites', { kind: 'error', message: 'No file received.' });
      }

      const report = importSitesCsv((await file.toBuffer()).toString('utf8'), encryptionKey);

      if (report.errors.length > 0 && report.added + report.updated === 0) {
        return redirect(reply, '/sites', {
          kind: 'error',
          message: report.errors.slice(0, 3).join(' '),
        });
      }

      const parts: string[] = [];
      if (report.added) parts.push(`${report.added} site(s) added`);
      if (report.updated) parts.push(`${report.updated} updated`);
      if (report.skipped) parts.push(`${report.skipped} row(s) skipped with no domain`);

      let message = parts.length ? `${parts.join(', ')}.` : 'Nothing in that file to import.';

      // Saying which happened matters: a file with no token columns leaves the
      // stored credentials alone, and somebody expecting it to have set them
      // would otherwise find out at the next run.
      message +=
        report.withCredentials > 0
          ? ` ${report.withCredentials} row(s) carried credentials.`
          : ' No credentials in that file, so the stored ones were left untouched.';

      if (report.errors.length) {
        message += ` Failed: ${report.errors.slice(0, 3).join('; ')}`;
      }

      return redirect(reply, '/sites', {
        kind: report.errors.length ? 'warn' : 'ok',
        message,
      });
    } catch (err) {
      return redirect(reply, '/sites', { kind: 'error', message: errorMessage(err) });
    }
  });

  /**
   * Every site with its tokens in plain text.
   *
   * Its own route rather than a flag on /data/export/sites, because the two
   * files are not the same kind of thing: one is safe to attach to a message
   * and the other can publish to every site you own. That difference should
   * cost a separate deliberate click.
   */
  app.get('/sites/export/credentials', async (_request, reply) => {
    const data = exportSitesWithCredentials(encryptionKey);
    log.warn('site credentials exported in plain text');
    return csvFile(reply, data.filename, data.rows);
  });

  /**
   * One site as one file: the site, its accounts, keywords, history and tokens.
   *
   * A file that quietly lacked a token would defeat the point of having it, so
   * when a stored token cannot be read (it was saved under another key) the
   * download is refused and the person told which to enter again.
   */
  app.get('/sites/:id/backup', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const site = getSite(id);
    if (!site) return redirect(reply, '/sites', { kind: 'error', message: 'Site not found' });
    const { file, warnings } = buildSiteBackup(id, encryptionKey);
    if (warnings.length > 0) {
      return redirect(reply, `/sites/${id}`, { kind: 'error', message: `Not backed up: ${warnings.join(' ')}` });
    }
    log.warn(`site backup of ${site.domain} downloaded, with its tokens in the clear`);
    return reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Disposition', `attachment; filename="${siteBackupName(site.domain)}"`)
      .header('Cache-Control', 'no-store')
      .send(encodeSiteBackup(file));
  });

  const restoreSummary = (report: RestoreReport): string => {
    const c = report.counts;
    const parts = [
      `${c.accounts} account${c.accounts === 1 ? '' : 's'}`,
      `${c.keywords} keyword${c.keywords === 1 ? '' : 's'}`,
      `${c.runs} run${c.runs === 1 ? '' : 's'}`,
      `${c.reels} reel${c.reels === 1 ? '' : 's'}`,
    ];
    return `${report.domain} ${report.created ? 'created' : 'replaced'} from the backup: ${parts.join(', ')}. ${report.warnings.join(' ')} A full backup was saved first (Setup → Backups).`.replace(/\s+/g, ' ').trim();
  };

  app.post('/sites/restore', async (request, reply) => {
    const upload = await request.file({ limits: { fileSize: 256 * 1024 * 1024 } });
    if (!upload || !/\.(json\.gz|json|gz)$/i.test(upload.filename)) {
      return redirect(reply, '/sites', { kind: 'error', message: 'Choose a site backup file (its name ends in .json.gz).' });
    }
    let data: Buffer;
    try {
      data = await upload.toBuffer();
    } catch {
      return redirect(reply, '/sites', { kind: 'error', message: 'The file is too large.' });
    }
    try {
      const parsed = parseSiteBackup(data);
      // A replace is undoable only if there is something to go back to.
      await createBackup('before-restore');
      const report = restoreSiteBackup(parsed, encryptionKey);
      return redirect(reply, '/sites', { kind: 'ok', message: restoreSummary(report) });
    } catch (err) {
      return redirect(reply, '/sites', { kind: 'error', message: `Restore failed, nothing was changed: ${errorMessage(err)}` });
    }
  });

  app.post('/sites/:id/delete', async (request, reply) => {
    deleteSite(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/sites', { kind: 'ok', message: 'Site deleted.' });
  });

  /* -- Keywords ---------------------------------------------------------- */

  /** The view the keywords page was asked for, normalised. */
  const readKeywordFilter = (query: unknown): KeywordFilterView => {
    const q = query as { q?: string; view?: string; site?: string };
    const view = asString(q.view);

    return {
      q: asString(q.q).trim(),
      view:
        view === 'queued' || view === 'stuck' || view === 'done' || view === 'off'
          ? view
          : 'all',
      siteId: Math.max(0, asNumber(q.site, 0)),
    };
  };

  /* -- Reels ------------------------------------------------------------ */

  app.post('/reels/candidates/remove', async (request, reply) => {
    const body = formBody(request);
    const removed = asString(body.all) === '1'
      ? dismissReelCandidates('all')
      : dismissReelCandidates([asNumber(body.run_id, 0)].filter((n) => n > 0));
    return redirect(reply, '/reels', {
      kind: 'ok',
      message: `${removed} article(s) taken off the list. They stay published on the site.`,
    });
  });

  app.get('/reels', async (request, reply) => {
    const candidates = reelCandidates().map((c) => ({ ...c, images: readReelImages(c) }));

    return page(
      reply,
      'Reels',
      '/reels',
      reelsPage({
        candidates,
        reels: listReels(),
        // The Buffer route needs no Facebook token, only a page with a site.
        configured:
          (listFbTokens().length > 0 || settings.get('reel_publisher') === 'buffer') &&
          listFbPages().some((p) => p.site_id !== null),
        enabled: settings.getBool('fb_enabled'),
        pages: listFbPages().length,
        fbPages: listFbPages(),
        filterSites: listSites().map((x) => ({ id: x.id, domain: x.domain })),
        site: asNumber((request.query as { site?: string }).site, 0),
      }),
      readFlash(request.query),
    );
  });

  app.get('/reels/new/:runId', async (request, reply) => {
    const runId = asNumber((request.params as { runId: string }).runId, 0);
    const candidate = reelCandidates(500).find((c) => c.run_id === runId);
    if (!candidate) return reply.callNotFound();

    const images = readReelImages(candidate);
    if (!images) {
      return redirect(reply, '/reels', {
        kind: 'error',
        message: 'That run’s images could not be read.',
      });
    }

    const composerPage = pageForSite(candidate.site_id);
    const scenes = nextReelShape(candidate.site_id);
    const mode = reelMode(settings);
    return page(
      reply,
      'Make a reel',
      '/reels',
      reelComposerPage({
        candidate,
        images,
        caption: placeholderCaption(candidate),
        page: composerPage,
        mode,
        // Hands mode has no fixed template to fill in by hand here -- the
        // composer fetches it from the model after the page is up, the same
        // way the caption does, so a slow or down model never holds up the
        // page itself.
        prompt:
          mode === 'hands'
            ? ''
            : buildReelPrompt({
                title: candidate.title || candidate.spy_title,
                presenter: presenterFor(composerPage?.id),
                cta: reelCta(settings.get('reel_cta_text'), candidate.site_domain),
                shape: scenes.shape,
              }),
        references: singleReferenceRoles(settings),
        structure: { id: scenes.id, name: reelStructureName(scenes.id) },
      }),
      readFlash(request.query),
    );
  });

  /**
   * The hands-only prompt, written for this recipe. See the caption route
   * just below for why this is its own request rather than part of the page.
   */
  app.get('/reels/new/:runId/hands-prompt', async (request, reply) => {
    const runId = asNumber((request.params as { runId: string }).runId, 0);
    const candidate = reelCandidates(500).find((c) => c.run_id === runId);
    if (!candidate) return reply.status(404).send({ prompt: null });

    const images = readReelImages(candidate);
    if (!images) return reply.send({ prompt: null });

    const host = candidate.site_domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const title = candidate.title || candidate.spy_title;
    const seed = seedFromRun(runId, host, images, title);
    try {
      const prompt = await buildHandsPrompt(
        { title, recipe: seed.article.recipe },
        (name, vars) => askPrompt(settings, encryptionKey, name, vars),
      );
      return reply.send({ prompt: prompt || null });
    } catch (err) {
      log.warn(`hands-only prompt for run ${runId} could not be written — ${errorMessage(err)}`);
      return reply.send({ prompt: null });
    }
  });

  /**
   * The model's caption, for the composer to fill in once it has rendered.
   *
   * Its own request, not part of the page: the model takes anywhere from two
   * seconds to twenty and is sometimes down, and a page that waits on it sits
   * past Cloudflare's hundred seconds and answers 524 -- which is how this was
   * found. The composer opens with the title and swaps this in if it arrives.
   */
  app.get('/reels/new/:runId/caption', async (request, reply) => {
    const runId = asNumber((request.params as { runId: string }).runId, 0);
    const candidate = reelCandidates(500).find((c) => c.run_id === runId);
    if (!candidate) return reply.status(404).send({ caption: null });

    const caption = await buildReelCaption(candidate, settings, encryptionKey);
    // The placeholder is the fallback; sending it back would replace the
    // person's own edits with nothing new.
    const generated = caption !== placeholderCaption(candidate);
    return reply.send({ caption: generated ? caption : null });
  });

  app.post('/reels/new/:runId', async (request, reply) => {
    const runId = asNumber((request.params as { runId: string }).runId, 0);
    const body = request.body as { caption?: string; prompt?: string; reference?: string | string[]; reel_structure_id?: string };

    const candidate = reelCandidates(500).find((c) => c.run_id === runId);
    if (!candidate) return reply.callNotFound();

    const images = readReelImages(candidate);
    if (!images) {
      return redirect(reply, '/reels', {
        kind: 'error',
        message: 'That run’s images could not be read.',
      });
    }

    const host = candidate.site_domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const target = pageForSite(candidate.site_id, 'reels');
    const title = candidate.title || candidate.spy_title;

    const mode = reelMode(settings);
    if (!isStudioMode(mode)) {
      const ticked = ([] as string[])
        .concat(body.reference ?? [])
        .filter((r): r is ArticleRole => ARTICLE_ROLES.includes(r as ArticleRole));
      if (ticked.length === 0) {
        return redirect(reply, `/reels/new/${runId}`, { kind: 'error', message: 'Tick at least one photo.' });
      }
      if (ticked.length > MAX_REFERENCES) {
        return redirect(reply, `/reels/new/${runId}`, {
          kind: 'error',
          message: `Flow takes at most ${MAX_REFERENCES} photos in one request.`,
        });
      }
      const prompt = (body.prompt ?? '').trim();
      if (!prompt) {
        return redirect(reply, `/reels/new/${runId}`, { kind: 'error', message: 'The video prompt is empty.' });
      }

      const reelId = createReel({
        runId,
        siteId: candidate.site_id,
        keywordId: candidate.keyword_id,
        fbPageId: target?.id ?? null,
        prompt,
        caption: (body.caption ?? '').trim() || title,
        references: referenceUrls(host, images, ticked),
      });
      // Recorded only when the structure still exists: the page may have sat
      // open while it was deleted, and a dangling id would count for nothing.
      const structureId = asNumber(body.reel_structure_id, 0);
      if (structureId && reelStructureName(structureId)) markReelStructure(reelId, structureId);
      if (mode === 'mixed') {
        setReelStage(reelId, 'done', {
          planJson: JSON.stringify({ ...seedFromRun(runId, host, images, title), mixed: true }),
        });
      }
      try {
        await startGeneration(getReel(reelId)!, settings, defaultDeps(settings, encryptionKey).images);
      } catch (err) {
        updateReel(reelId, { status: 'failed', error: errorMessage(err) });
        return redirect(reply, `/reels/${reelId}`, { kind: 'error', message: errorMessage(err) });
      }
      return redirect(reply, `/reels/${reelId}`, { kind: 'ok', message: 'The clip is being made.' });
    }

    // The same reel the pipeline would have made: the engine writes the
    // storyboard, films it, and publishes it, one stage per minute.
    const reelId = createReel({
      runId,
      siteId: candidate.site_id,
      keywordId: candidate.keyword_id,
      fbPageId: target?.id ?? null,
      prompt: '',
      caption: (body.caption ?? '').trim() || title,
      references: [],
      stage: 'planning',
    });
    setReelStage(reelId, 'planning', {
      planJson: JSON.stringify({ ...seedFromRun(runId, host, images, title), process: mode === 'process' }),
    });

    return redirect(reply, `/reels/${reelId}`, {
      kind: 'ok',
      message: 'The reel is queued. The storyboard is written first, then each scene is filmed.',
    });
  });

  app.get('/reels/:id', async (request, reply) => {
    const reel = getReel(asNumber((request.params as { id: string }).id, 0));
    if (!reel) return reply.callNotFound();

    return page(
      reply,
      'Reel',
      '/reels',
      reelDetailPage(
        reel,
        listScenes(reel.id),
        reel.fb_page_id ? presenterForPage(reel.fb_page_id) : undefined,
        listFbPages(),
      ) as never,
      readFlash(request.query),
    );
  });

  /** The assembled reel, from the platform's own storage. */
  app.get('/reels/:id/video', async (request, reply) => {
    const reel = getReel(asNumber((request.params as { id: string }).id, 0));
    if (!reel?.output_path || !existsSync(reel.output_path)) return reply.callNotFound();
    return reply.type('video/mp4').send(createReadStream(reel.output_path));
  });

  /** One scene's clip, for the storyboard. */
  app.get('/reels/:id/scenes/:sceneId/clip', async (request, reply) => {
    const params = request.params as { id: string; sceneId: string };
    const scene = getScene(asNumber(params.sceneId, 0));
    if (!scene || scene.reel_id !== asNumber(params.id, 0)) return reply.callNotFound();
    if (!scene.clip_path || !existsSync(scene.clip_path)) return reply.callNotFound();
    return reply.type('video/mp4').send(createReadStream(scene.clip_path));
  });

  /**
   * Retry one scene. The others keep what they have; the reel goes back to
   * filming and the next tick picks the scene up.
   */
  app.post('/reels/:id/scenes/:sceneId/retry', async (request, reply) => {
    const params = request.params as { id: string; sceneId: string };
    const reelId = asNumber(params.id, 0);
    const scene = getScene(asNumber(params.sceneId, 0));
    if (!scene || scene.reel_id !== reelId) return reply.callNotFound();

    updateScene(scene.id, { status: 'pending', error: null, clipJobId: null, clipPath: null });
    setReelStage(reelId, 'filming');
    updateReel(reelId, { status: 'generating', error: null });
    return redirect(reply, `/reels/${reelId}`, { kind: 'ok', message: `Scene ${scene.position} will be filmed again.` });
  });

  app.post('/reels/:id/publish', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    let reel = getReel(id);
    if (!reel) return reply.callNotFound();

    // A reel its site has no page for can be sent to a page picked on the
    // tile. Remembered on the reel, so the link comment and the record of
    // where it went work as for any other.
    const body = formBody(request);
    const pickedPage = asNumber(body.page_id, 0);
    if (!reel.fb_page_id && pickedPage > 0) {
      if (!getFbPage(pickedPage)) return reply.callNotFound();
      updateReel(id, { fbPageId: pickedPage });
      reel = getReel(id)!;
    }

    try {
      await publishReel(reel, defaultDeps(settings, encryptionKey));
    } catch (err) {
      // An account switched off is not a failure: the reel stays ready.
      if (err instanceof AccountOffError) return redirect(reply, '/reels', { kind: 'warn', message: err.message });
      updateReel(id, { status: 'failed', error: errorMessage(err) });
      return redirect(reply, '/reels', { kind: 'error', message: errorMessage(err) });
    }

    return redirect(reply, '/reels', { kind: 'ok', message: 'Reel published.' });
  });

  /** Retry one reel: publish again when it has its video, otherwise make it again. */
  const retryReel = async (id: number): Promise<void> => {
    const reel = getReel(id);
    if (!reel) return;
    if (reel.video_url || reel.output_path) {
      updateReel(id, { status: 'ready', error: null });
    } else if (reel.stage !== 'done') {
      for (const scene of listScenes(id)) {
        if (scene.status === 'failed') {
          updateScene(scene.id, { status: 'pending', error: null, clipJobId: null, clipPath: null });
        }
      }
      updateReel(id, { status: 'generating', error: null });
    } else {
      await startGeneration(reel, settings, defaultDeps(settings, encryptionKey).images);
    }
  };

  app.post('/reels/bulk', async (request, reply) => {
    const body = formBody(request);
    const ids = ([] as unknown[]).concat(body.ids ?? []).map((v) => asNumber(v, 0)).filter((n) => n > 0);
    if (ids.length === 0) return redirect(reply, '/reels', { kind: 'warn', message: 'Tick at least one reel.' });
    if (asString(body.action) === 'discard') {
      for (const id of ids) deleteReel(id);
      return redirect(reply, '/reels', { kind: 'ok', message: `${ids.length} reel(s) discarded.` });
    }
    const problems: string[] = [];
    for (const id of ids) {
      try {
        await retryReel(id);
      } catch (err) {
        updateReel(id, { status: 'failed', error: errorMessage(err) });
        problems.push(errorMessage(err));
      }
    }
    return redirect(reply, '/reels', problems.length
      ? { kind: 'warn', message: `${ids.length - problems.length} reel(s) retrying; ${problems.length} could not: ${problems[0]}` }
      : { kind: 'ok', message: `${ids.length} reel(s) retrying.` });
  });

  app.post('/reels/:id/retry', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const reel = getReel(id);
    if (!reel) return reply.callNotFound();

    try {
      // A reel that already has its video failed at publishing, and the video
      // is the expensive half -- so retry the publish rather than the whole
      // thing. Only a reel with nothing to show is generated again.
      if (reel.video_url || reel.output_path) {
        updateReel(id, { status: 'ready', error: null });
      } else if (reel.stage !== 'done') {
        // A studio reel picks up at the stage it failed in. Scenes already
        // filmed keep their clips; only the failed ones are cleared.
        for (const scene of listScenes(id)) {
          if (scene.status === 'failed') {
            updateScene(scene.id, { status: 'pending', error: null, clipJobId: null, clipPath: null });
          }
        }
        updateReel(id, { status: 'generating', error: null });
      } else {
        await startGeneration(reel, settings, defaultDeps(settings, encryptionKey).images);
      }
    } catch (err) {
      updateReel(id, { status: 'failed', error: errorMessage(err) });
      return redirect(reply, '/reels', { kind: 'error', message: errorMessage(err) });
    }

    return redirect(reply, '/reels', { kind: 'ok', message: 'Retrying.' });
  });

  // Buffer took it, Facebook refused it later -- the platform only ever saw the
  // first half. Forget the Facebook and Instagram results and the site's copy
  // of the video, so the publish uploads a re-encoded one and schedules both again.
  app.post('/reels/:id/resend', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const reel = getReel(id);
    if (!reel) return reply.callNotFound();
    if (!reel.video_url && !reel.output_path) {
      return redirect(reply, '/reels', { kind: 'error', message: 'This reel has no video left to send. Make it again instead.' });
    }
    // Which networks to send again, and whether to rebuild the video first.
    // Only the named ones are cleared: publishReel skips a channel already
    // marked ok, so leaving the others alone is what stops a YouTube-only
    // retry posting to Facebook a second time.
    const body = formBody(request);
    const asked = ([] as unknown[]).concat(body.channels ?? []).map((v) => asString(v));
    const wanted = (['facebook', 'instagram', 'youtube', 'tiktok'] as const).filter((n) => asked.includes(n));
    const channels = readChannels(reel);

    if (wanted.length === 0) {
      return redirect(reply, '/reels', { kind: 'warn', message: 'Choose a network to send to again.' });
    }

    // A network may have gone to several accounts. Send again only to the
    // ones that failed there; when none failed, the person is asking for all
    // of them again — the same as a network with one account always did.
    for (const name of wanted) {
      const keys = channelKeys(channels).filter((k) => channelOf(k) === name);
      const failed = keys.filter((k) => channels[k]?.status === 'failed');
      for (const k of failed.length ? failed : keys) delete channels[k];
    }
    // The re-encode is what cures Facebook's "unable to process the media".
    // Left out of a single-network retry: it uploads a fresh copy of the video
    // to the site, which is waste when the media was never the problem.
    if (asString(body.reencode) === '1') delete channels.siteVideo;
    setReelChannels(id, JSON.stringify(channels));

    try {
      await publishReel({ ...reel, channels_json: JSON.stringify(channels) }, defaultDeps(settings, encryptionKey));
    } catch (err) {
      if (err instanceof AccountOffError) return redirect(reply, '/reels', { kind: 'warn', message: err.message });
      updateReel(id, { status: 'failed', error: errorMessage(err) });
      return redirect(reply, '/reels', { kind: 'error', message: errorMessage(err) });
    }

    const sent = wanted.join(', ');
    return redirect(reply, '/reels', {
      kind: 'ok',
      message: asString(body.reencode) === '1' ? `Re-encoded and scheduled again on ${sent}.` : `Scheduled again on ${sent}.`,
    });
  });

  app.post('/reels/:id/discard', async (request, reply) => {
    deleteReel(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/reels', { kind: 'ok', message: 'Reel discarded.' });
  });

  /* -- Settings -> Facebook ---------------------------------------------- */

  /* -- Settings -> Facebook ------------------------------------------------ */

  // Facebook pages are a section of Channels -> Accounts now.

  // Rendered from the database alone. Graph is asked only when a token is
  // added or refreshed; a page that waited on it would sit past Cloudflare's
  // hundred seconds whenever Facebook was slow.
  app.get('/settings/facebook', async (_request, reply) => reply.redirect('/accounts#facebook-pages'));

  /* -- Facebook webhook: keyword comment -> private reply ------------------
   *
   * Someone comments a trigger word (Settings -> General, "fb_comment_trigger",
   * "banana" by default) under a published reel or post. Facebook calls this
   * endpoint with the comment, this finds which reel it was left on by the
   * native video/post id already recorded on it, and replies with the
   * article's own link as a private message -- clickable, and never posted
   * as a public link Facebook's ranking would read as an exit.
   *
   * Both routes are in auth.ts's PUBLIC_PATHS: Meta cannot carry this app's
   * session cookie. In its place: the GET handshake checks `hub.verify_token`,
   * and the POST checks a `key` query parameter carried in the callback URL
   * itself (set once in Meta's Webhooks config, alongside the callback URL --
   * see Settings -> General for the value). A request missing or failing
   * either check is refused before anything in the payload is read.
   */
  const webhookSecret = (): string => {
    const value = (process.env.FB_WEBHOOK_VERIFY_TOKEN ?? '').trim();
    if (!value) log.warn('FB_WEBHOOK_VERIFY_TOKEN is not set; the Facebook webhook will refuse every request');
    return value;
  };

  app.get('/webhooks/facebook', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const secret = webhookSecret();

    if (secret && q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === secret) {
      return reply.status(200).type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.status(403).send('Forbidden');
  });

  interface FacebookCommentChange {
    field?: string;
    value?: {
      item?: string;
      verb?: string;
      comment_id?: string;
      post_id?: string;
      video_id?: string;
      message?: string;
      from?: { id?: string };
    };
  }
  interface FacebookWebhookBody {
    object?: string;
    entry?: { id?: string; changes?: FacebookCommentChange[] }[];
  }

  /** Which video a post is, as Graph last said -- so a comment is not a Graph call. */
  const videoOfPost = new Map<string, { videoId: string | undefined; at: number }>();

  app.post('/webhooks/facebook', async (request, reply) => {
    const secret = webhookSecret();
    const q = request.query as Record<string, string | undefined>;
    if (!secret || q.key !== secret) return reply.status(403).send('Forbidden');

    // Acknowledge immediately -- Facebook retries aggressively on anything
    // but a fast 200, and every comment is handled independently below.
    reply.status(200).send('EVENT_RECEIVED');

    const body = request.body as FacebookWebhookBody;
    const trigger = (settings.get('fb_comment_trigger').trim() || 'banana').toLowerCase();

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (change.field !== 'feed' || value?.item !== 'comment' || value?.verb !== 'add') continue;

        const message = (value.message ?? '').toLowerCase().trim();
        if (!message) continue;
        // The Page's own comments (the link it posts, a reply) never trigger
        // anything: a private reply to the Page itself can only fail.
        if (value.from?.id && value.from.id === entry.id) continue;

        const videoOrPostId = value.video_id ?? value.post_id;
        const commentId = value.comment_id;
        if (!videoOrPostId || !commentId) continue;

        // A reel first -- the common case -- then an image post or the photo
        // collage, which land in fb_feed_posts instead (see migration 049):
        // a reel borrows a published article's assets and has a short life
        // of its own, a feed post has neither, so there was nothing there to
        // extend. Both resolve to the same (link, page, token) the reply needs.
        let match = getReelByFbVideoId(videoOrPostId) ?? getFbFeedPostByNativeId(videoOrPostId);
        if (!match && !value.video_id && value.post_id && entry.id && message.length <= 40) {
          // A comment on a reel names the post, not the video the reel is
          // recorded under. Ask Graph which video the post is, and try again.
          // Only for a short comment (a keyword is a word, not a paragraph),
          // and a post is asked about once in a while, not on every comment.
          try {
            const asked = videoOfPost.get(value.post_id);
            let videoId: string | undefined;
            if (asked && Date.now() - asked.at < 10 * 60_000) {
              videoId = asked.videoId;
            } else {
              const via = fbGraphTargetByRealPageId(entry.id, encryptionKey);
              videoId = via
                ? await new FacebookClient({ systemUserToken: via.token }).videoIdOfPost(via.pageId, value.post_id)
                : undefined;
              videoOfPost.set(value.post_id, { videoId, at: Date.now() });
            }
            if (videoId) match = getReelByFbVideoId(videoId);
          } catch (err) {
            log.warn(`webhook: could not look up the video of post ${value.post_id}: ${errorMessage(err)}`);
          }
        }
        if (!match) {
          // Every post asks for its own word, which only a recorded post can
          // tell us; the global word is the one a stray comment is judged by.
          if (message.includes(trigger)) {
            log.info(`webhook comment ${commentId} matched "${trigger}" but no reel/post/link was found for ${videoOrPostId}`);
          }
          continue;
        }

        // The word this post asked for, taken from its dish; the global word
        // for anything published before posts had their own.
        const word = (match.trigger_keyword || trigger).toLowerCase();
        if (!message.includes(word)) continue;
        if (!match.post_url || !match.fb_page_id) {
          log.info(`webhook comment ${commentId} matched "${word}" but no reel/post/link was found for ${videoOrPostId}`);
          continue;
        }

        const label = 'purpose' in match ? `feed post ${match.id}` : `reel ${match.id}`;
        try {
          // The real page id and a token for it -- bridged from the synced
          // page when the reel/post went out on a Buffer account-card page,
          // which carries neither of its own. privateReply mints a page token
          // from pageId, so it has to be the real id, not "profile:<id>".
          const target = resolveFbGraphTarget(match.fb_page_id, encryptionKey);
          if (!target) throw new Error("that page has no Facebook token (its own or a synced page's)");
          const dm = new FacebookClient({ systemUserToken: target.token });
          const text = `Here's the recipe: ${match.post_url}`;
          const cardInfo = recipeCardForRun(match.run_id);
          let sentAsCard = false;
          if (cardInfo) {
            try {
              await dm.privateReply({
                pageId: target.pageId,
                commentId,
                message: text,
                card: { title: cardInfo.title, imageUrl: cardInfo.imageUrl, url: match.post_url },
              });
              sentAsCard = true;
            } catch (err) {
              // Not every comment accepts a template; the plain link still works.
              log.warn(`webhook: link card refused on ${label}, sending plain text: ${errorMessage(err)}`);
            }
          }
          if (!sentAsCard) await dm.privateReply({ pageId: target.pageId, commentId, message: text });
          log.info(`webhook: sent the recipe link to the commenter on ${label}`);
          if (settings.getBool('fb_public_reply')) {
            try {
              await new FacebookClient({ systemUserToken: target.token }).replyToComment({
                pageId: target.pageId,
                commentId,
                message: PUBLIC_REPLIES[Math.floor(Math.random() * PUBLIC_REPLIES.length)]!,
              });
            } catch (err) {
              log.warn(`webhook: could not post the public reply on ${label}: ${errorMessage(err)}`);
            }
          }
        } catch (err) {
          log.warn(`webhook: could not send a private reply on ${label}: ${errorMessage(err)}`);
        }
      }
    }
  });

  const describeSync = (name: string, result: SyncResult): Flash => {
    if (!result.ok) return { kind: 'error', message: `${name}: ${result.error}` };
    if (result.total === 0) {
      return {
        kind: 'warn',
        message:
          `${name}: the token works but manages no pages. Give the system user access ` +
          'to the pages in Business Settings, then refresh.',
      };
    }
    return {
      kind: 'ok',
      message:
        `${name}: ${result.total} page(s) — ${result.added} new, ${result.renamed} renamed, ` +
        `${result.dropped} no longer there.`,
    };
  };

  /** A token that stopped working is worth a message; a page render is not. */
  const tellTelegram = async (message: string): Promise<void> => {
    if (!settings.getBool('telegram_enabled')) return;
    try {
      await new TelegramClient(
        settings.get('telegram_bot_token'),
        settings.get('telegram_chat_id'),
      ).sendMessage(message);
    } catch (err) {
      log.warn(`could not send a Telegram message: ${errorMessage(err)}`);
    }
  };

  app.post('/settings/facebook/tokens', async (request, reply) => {
    const body = request.body as { name?: string; token?: string };

    let id: number;
    try {
      id = insertFbToken(body.name ?? '', body.token ?? '', encryptionKey);
    } catch (err) {
      return redirect(reply, '/accounts', { kind: 'error', message: errorMessage(err) });
    }

    const name = listFbTokens().find((t) => t.id === id)?.name ?? 'Token';
    const result = await syncToken(id, encryptionKey);
    // A token Graph refuses is not kept: a row that never worked is one more
    // thing on the page to wonder about, and the reason is in the message.
    if (!result.ok) {
      deleteFbToken(id);
      return redirect(reply, '/accounts', {
        kind: 'error',
        message: `${name} was not saved: ${result.error}`,
      });
    }
    return redirect(reply, '/accounts', describeSync(name, result));
  });

  app.post('/settings/facebook/tokens/:id/refresh', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const token = listFbTokens().find((t) => t.id === id);
    if (!token) return reply.callNotFound();

    const result = await syncToken(id, encryptionKey);
    if (!result.ok) {
      await tellTelegram(`<b>Facebook token failed</b>\n${token.name}\n${result.error}`);
    }
    return redirect(reply, '/accounts', describeSync(token.name, result));
  });

  app.post('/settings/facebook/tokens/:id/delete', async (request, reply) => {
    deleteFbToken(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/accounts', {
      kind: 'ok',
      message: 'Token and its pages removed.',
    });
  });

  /**
   * One page's settings, as the pages form carries them: every row's fields
   * are in the one form, suffixed with the page id, so a row's Save and the
   * Save-all button post the same body.
   */
  const pageFields = (body: Record<string, unknown>, id: number) => ({
    siteId: asNumber(body[`site_${id}`], 0),
    presenterId: asNumber(body[`presenter_${id}`], 0),
    autoPublish: asString(body[`auto_${id}`]) === 'on',
    posts: asString(body[`posts_${id}`]) === 'on',
    reels: asString(body[`reels_${id}`]) === 'on',
    collage: asString(body[`collage_${id}`]) === 'on',
    // A page with none of the three is simply off.
    enabled:
      `enabled_${id}` in body
        ? asString(body[`enabled_${id}`]) === 'on'
        : asString(body[`posts_${id}`]) === 'on' ||
          asString(body[`reels_${id}`]) === 'on' ||
          asString(body[`collage_${id}`]) === 'on',
  });

  const savePage = (id: number, fields: ReturnType<typeof pageFields>): void => {
    if (fields.siteId > 0 && !getSite(fields.siteId)) throw new Error('That site no longer exists.');
    setFbPagePresenter(id, fields.presenterId > 0 ? fields.presenterId : null);
    setFbPageOptions(id, {
      siteId: fields.siteId > 0 ? fields.siteId : null,
      autoPublish: fields.autoPublish,
      enabled: fields.enabled,
      posts: fields.posts,
      reels: fields.reels,
      collage: fields.collage,
    });
  };

  app.post('/settings/facebook/pages/delete-unassigned', async (_request, reply) => {
    const pages = listFbPages().filter((p) => p.site_id === null);
    for (const p of pages) deleteFbPage(p.id);
    return redirect(reply, '/', { kind: 'ok', message: `${pages.length} Facebook page(s) without a site removed.` });
  });

  app.post('/settings/facebook/pages/delete', async (request, reply) => {
    const ids = ([] as unknown[]).concat(formBody(request).pick ?? []).map((v) => asNumber(v, 0)).filter((n) => n > 0);
    if (ids.length === 0) return redirect(reply, '/accounts', { kind: 'warn', message: 'Tick at least one page.' });
    for (const id of ids) deleteFbPage(id);
    return redirect(reply, asString(formBody(request).back) === '/' ? '/' : '/accounts', { kind: 'ok', message: `${ids.length} page(s) deleted.` });
  });

  app.post('/settings/facebook/pages/:id', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    if (!getFbPage(id)) return reply.callNotFound();

    try {
      savePage(id, pageFields(formBody(request), id));
    } catch (err) {
      return redirect(reply, '/accounts', { kind: 'error', message: errorMessage(err) });
    }

    return redirect(reply, '/accounts', { kind: 'ok', message: 'Page saved.' });
  });

  /** Every page at once: each row's fields are in the one form, suffixed with its id. */
  app.post('/settings/facebook/pages', async (request, reply) => {
    const body = formBody(request);
    const pages = listFbPages().filter((p) => `site_${p.id}` in body);
    const fields = new Map(pages.map((p) => [p.id, pageFields(body, p.id)]));

    const problems: string[] = [];
    for (const p of pages) {
      try {
        savePage(p.id, fields.get(p.id)!);
      } catch (err) {
        problems.push(`${p.name || p.page_id}: ${errorMessage(err)}`);
      }
    }

    if (problems.length > 0) {
      return redirect(reply, '/accounts', {
        kind: 'error',
        message: `${pages.length - problems.length} page(s) saved. ${problems.join(' ')}`,
      });
    }
    return redirect(reply, '/accounts', {
      kind: 'ok',
      message: `${pages.length} page(s) saved.`,
    });
  });

  /* ---------- Google accounts for Flow (rotated by the image service) ---------- */

  const imageService = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const base = settings.get('image_base_url').replace(/\/+$/, '');
    if (!base) throw new Error('The image service URL is not set under Setup.');
    return fetch(`${base}${path}`, {
      ...init,
      headers: { 'X-API-Key': settings.get('image_api_key'), 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
  };

  const imageServiceError = async (response: Response): Promise<string> => {
    const body = (await response.json().catch(() => ({}))) as { detail?: string };
    return body.detail || `HTTP ${response.status}`;
  };

  app.get('/settings/google', async (request, reply) => {
    let view: Parameters<typeof googleAccountsPage>[0];
    try {
      const response = await imageService('/flow/accounts');
      if (!response.ok) throw new Error(await imageServiceError(response));
      let data = (await response.json()) as { accounts: GoogleAccountView[]; pending: number | null; clip_cost?: number };
      // The project used to be set in Settings or on a site. Carry it over to
      // account 1 once, so nothing needs typing again.
      const first = data.accounts.find((a) => a.id === 1);
      const legacy = settings.get('flow_project_id').trim() || legacySiteProject();
      if (first && !first.project_id && legacy) {
        const saved = await imageService('/flow/accounts/1/project', { method: 'PUT', body: JSON.stringify({ project_id: legacy }) });
        if (saved.ok) data = (await saved.json()) as typeof data;
      }
      view = { reachable: true, accounts: data.accounts, pending: data.pending, clipCost: data.clip_cost };
      // Keep a copy in the platform's database, so a backup carries the list. A
      // service that holds less than the copy (a new server) is offered the
      // copy back instead of being allowed to overwrite it.
      const saved = parseSnapshot(settings.get('google_accounts_snapshot'));
      if (saved && serviceIsBehind(saved, data.accounts)) {
        view.restore = { count: restorableCount(saved, data.accounts) };
      } else {
        const now = JSON.stringify(takeSnapshot(data.accounts, data.clip_cost));
        if (now !== settings.get('google_accounts_snapshot')) settings.set('google_accounts_snapshot', now);
      }
      const loginId = asNumber((request.query as { login?: string }).login, 0);
      if (loginId) {
        const st = await imageService(`/flow/accounts/${loginId}/login`);
        if (st.ok) view.login = { id: loginId, ...((await st.json()) as { state: string; message: string; running: boolean }) };
      }
    } catch (err) {
      view = { reachable: false, error: errorMessage(err), accounts: [], pending: null };
    }
    return page(reply, 'Google accounts', '/settings/google', googleAccountsPage(view), readFlash(request.query));
  });

  app.post('/settings/google/restore', async (_request, reply) => {
    const saved = parseSnapshot(settings.get('google_accounts_snapshot'));
    if (!saved) return redirect(reply, '/settings/google', { kind: 'error', message: 'No saved copy of the accounts.' });
    const put = async (path: string, body: unknown): Promise<void> => {
      const response = await imageService(path, { method: 'PUT', body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await imageServiceError(response));
    };
    try {
      const listed = await imageService('/flow/accounts');
      if (!listed.ok) throw new Error(await imageServiceError(listed));
      const have = new Set(((await listed.json()) as { accounts: { id: number }[] }).accounts.map((a) => a.id));
      let done = 0;
      for (const acc of saved.accounts) {
        let id = acc.id;
        if (!have.has(id)) {
          const added = await imageService('/flow/accounts', { method: 'POST', body: JSON.stringify({ label: acc.label }) });
          if (!added.ok) throw new Error(await imageServiceError(added));
          id = ((await added.json()) as { id: number }).id;
        }
        if (acc.project_id) await put(`/flow/accounts/${id}/project`, { project_id: acc.project_id });
        await put(`/flow/accounts/${id}/limits`, { daily_limit: acc.daily_limit, monthly_limit: acc.monthly_limit });
        await put(`/flow/accounts/${id}/capabilities`, { images: acc.images, video: acc.video });
        done += 1;
      }
      if (saved.clip_cost != null) await put('/flow/accounts-clip-cost', { clip_cost: saved.clip_cost });
      // What the service holds now is the truth; the next visit saves it afresh.
      settings.set('google_accounts_snapshot', '');
      return redirect(reply, '/settings/google', {
        kind: 'ok',
        message: `${done} account${done === 1 ? '' : 's'} restored (names, projects, limits). Sign each one in again: the sign-ins stay on the old server.`,
      });
    } catch (err) {
      return redirect(reply, '/settings/google', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/settings/google/add', async (request, reply) => {
    try {
      const response = await imageService('/flow/accounts', {
        method: 'POST',
        body: JSON.stringify({ label: asString(formBody(request).label) }),
      });
      if (!response.ok) throw new Error(await imageServiceError(response));
      const added = (await response.json()) as { id: number };
      return redirect(reply, '/settings/google', {
        kind: 'ok',
        message: `Account #${added.id} added. Press Sign in on its row, then sign in to Google in the Browser.`,
      });
    } catch (err) {
      return redirect(reply, '/settings/google', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/settings/google/:id/project', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    try {
      const response = await imageService(`/flow/accounts/${id}/project`, {
        method: 'PUT',
        body: JSON.stringify({ project_id: asString(formBody(request).project_id) }),
      });
      if (!response.ok) throw new Error(await imageServiceError(response));
      return redirect(reply, '/settings/google', { kind: 'ok', message: `Flow project saved for account #${id}.` });
    } catch (err) {
      return redirect(reply, '/settings/google', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/settings/google/:id/limits', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const body = formBody(request);
    const limit = (v: unknown): number | null => {
      const n = Math.floor(Number(asString(v).trim()));
      return asString(v).trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
    };
    try {
      const response = await imageService(`/flow/accounts/${id}/limits`, {
        method: 'PUT',
        body: JSON.stringify({ daily_limit: limit(body.daily_limit), monthly_limit: limit(body.monthly_limit) }),
      });
      if (!response.ok) throw new Error(await imageServiceError(response));
      return redirect(reply, '/settings/google', { kind: 'ok', message: `Credit limits saved for account #${id}.` });
    } catch (err) {
      return redirect(reply, '/settings/google', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/settings/google/:id/capabilities', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const body = formBody(request);
    try {
      const response = await imageService(`/flow/accounts/${id}/capabilities`, {
        method: 'PUT',
        body: JSON.stringify({ images: 'images' in body, video: 'video' in body }),
      });
      if (!response.ok) throw new Error(await imageServiceError(response));
      return redirect(reply, '/settings/google', { kind: 'ok', message: `Saved what account #${id} may make.` });
    } catch (err) {
      return redirect(reply, '/settings/google', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/settings/google/:id/reset', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    try {
      const response = await imageService(`/flow/accounts/${id}/reset`, { method: 'POST' });
      if (!response.ok) throw new Error(await imageServiceError(response));
      return redirect(reply, '/settings/google', { kind: 'ok', message: `Account #${id} reset: ready again, today's count from zero.` });
    } catch (err) {
      return redirect(reply, '/settings/google', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/settings/google/login', async (request, reply) => {
    const body = formBody(request);
    const id = asNumber(body.account, 0);
    try {
      const response = await imageService(`/flow/accounts/${id}/login`, {
        method: 'POST',
        body: JSON.stringify({ email: asString(body.email).trim(), password: asString(body.password) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(await imageServiceError(response));
      return reply.redirect(`/settings/google?login=${id}`, 303);
    } catch (err) {
      return redirect(reply, '/settings/google', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/settings/google/:id/project/create', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    try {
      const response = await imageService(`/flow/accounts/${id}/project/create`, { method: 'POST' });
      if (!response.ok) throw new Error(await imageServiceError(response));
      return reply.redirect(`/settings/google?login=${id}`, 303);
    } catch (err) {
      return redirect(reply, '/settings/google', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/settings/google/:id/login/code', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    await imageService(`/flow/accounts/${id}/login/code`, {
      method: 'POST',
      body: JSON.stringify({ code: asString(formBody(request).code) }),
    }).catch(() => null);
    return reply.redirect(`/settings/google?login=${id}`, 303);
  });

  app.post('/settings/google/clip-cost', async (request, reply) => {
    try {
      const response = await imageService('/flow/accounts-clip-cost', {
        method: 'PUT',
        body: JSON.stringify({ clip_cost: Math.max(0, Math.round(asNumber(formBody(request).clip_cost, 0))) }),
      });
      if (!response.ok) throw new Error(await imageServiceError(response));
      return redirect(reply, '/settings/google', { kind: 'ok', message: 'Clip cost saved.' });
    } catch (err) {
      return redirect(reply, '/settings/google', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/settings/google/:id/use', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    try {
      const response = await imageService(`/flow/accounts/${id}/use`, { method: 'POST' });
      if (!response.ok) throw new Error(await imageServiceError(response));
      return redirect(reply, '/settings/google', {
        kind: 'ok',
        message: `Account #${id} is now in use (after any image in progress). Open Browser to see it or sign in.`,
      });
    } catch (err) {
      return redirect(reply, '/settings/google', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/settings/google/:id/remove', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    try {
      const response = await imageService(`/flow/accounts/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await imageServiceError(response));
      // A removal is deliberate: drop it from the saved copy too, or the page would offer it back.
      const saved = parseSnapshot(settings.get('google_accounts_snapshot'));
      if (saved) settings.set('google_accounts_snapshot', JSON.stringify({ ...saved, accounts: saved.accounts.filter((a) => a.id !== id) }));
      return redirect(reply, '/settings/google', { kind: 'ok', message: `Account #${id} removed.` });
    } catch (err) {
      return redirect(reply, '/settings/google', { kind: 'error', message: errorMessage(err) });
    }
  });

  /* ---------- Backups ---------- */

  app.get('/settings/backups', async (request, reply) =>
    page(reply, 'Backups', '/settings/backups', backupsPage({ backups: listBackups() }), readFlash(request.query)),
  );

  app.post('/settings/backups/create', async (_request, reply) => {
    try {
      const name = await createBackup('manual');
      return redirect(reply, '/settings/backups', { kind: 'ok', message: `Backup made: ${name}` });
    } catch (err) {
      return redirect(reply, '/settings/backups', { kind: 'error', message: `Backup failed: ${errorMessage(err)}` });
    }
  });

  app.get('/settings/backups/download', async (request, reply) => {
    const path = backupPath(asString((request.query as { file?: string }).file));
    if (!path) return reply.code(404).send('Backup not found');
    const name = path.split('/').pop()!;
    return reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(createReadStream(path));
  });

  app.post('/settings/backups/delete', async (request, reply) => {
    const path = backupPath(asString(formBody(request).file));
    if (path) await rm(path, { force: true });
    return redirect(reply, '/settings/backups', { kind: 'ok', message: 'Backup deleted.' });
  });

  const restoreAndRestart = async (name: string, reply: import('fastify').FastifyReply) => {
    try {
      await stageRestore(name);
    } catch (err) {
      return redirect(reply, '/settings/backups', { kind: 'error', message: `Restore failed: ${errorMessage(err)}` });
    }
    requestRestart();
    return page(reply, 'Backups', '/settings/backups', backupsPage({ backups: [], restarting: true }));
  };

  app.post('/settings/backups/restore', async (request, reply) =>
    restoreAndRestart(asString(formBody(request).file), reply),
  );

  app.post('/settings/backups/upload', async (request, reply) => {
    const file = await request.file({ limits: { fileSize: 4 * 1024 * 1024 * 1024 } });
    if (!file || !/\.(tar\.gz|tgz)$/i.test(file.filename)) {
      return redirect(reply, '/settings/backups', { kind: 'error', message: 'Choose a backup file ending in .tar.gz.' });
    }
    const name = `upload-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-uploaded.tar.gz`;
    await pipeStreams(file.file, createWriteStream(`${backupsDir()}/${name}`));
    if (file.file.truncated) {
      await rm(`${backupsDir()}/${name}`, { force: true });
      return redirect(reply, '/settings/backups', { kind: 'error', message: 'The file is too large.' });
    }
    pruneBackups();
    return restoreAndRestart(name, reply);
  });

  /* ---------- Blog (People-Also-Ask articles) ---------- */

  app.get('/blog', async (request, reply) => {
    const sites = listBlogSites().map((s) => ({
      ...s,
      queued: countBlogQuestions(s.id, 'queued'),
      suggested: countBlogQuestions(s.id, 'suggested'),
      doneToday: blogPublishedToday(s.id),
    }));
    const siteId = asNumber((request.query as { site?: string }).site, 0);
    return page(reply, 'Blog', '/blog', blogPage({ sites, questions: listBlogQuestions(), site: siteId }), readFlash(request.query));
  });

  app.post('/blog/sites/:id', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const body = formBody(request);
    setBlogSettings(id, {
      enabled: asString(body.enabled) === 'on',
      dailyTarget: asNumber(body.daily, 1),
      intervalMinutes: asNumber(body.interval, 480),
    });
    return redirect(reply, '/blog', { kind: 'ok', message: 'Blog schedule saved.' });
  });

  app.post('/blog/questions', async (request, reply) => {
    const body = formBody(request);
    const siteId = asNumber(body.site_id, 0);
    if (!listBlogSites().some((s) => s.id === siteId)) {
      return redirect(reply, '/blog', { kind: 'error', message: 'Pick a site.' });
    }
    const { added, skipped, similar } = addBlogQuestions(siteId, asString(body.lines).split(/\r?\n/));
    return redirect(reply, '/blog', {
      kind: added > 0 ? 'ok' : 'warn',
      message:
        `${added} question(s) added${skipped ? `, ${skipped} skipped (already there, the same question, or too short)` : ''}.` +
        (similar.length ? ` Same as an existing question: ${similar.slice(0, 8).join('; ')}${similar.length > 8 ? ` and ${similar.length - 8} more` : ''}.` : ''),
    });
  });

  app.post('/blog/questions/bulk', async (request, reply) => {
    const body = formBody(request);
    const ids = ([] as unknown[]).concat(body.ids ?? []).map((v) => asNumber(v, 0)).filter((n) => n > 0);
    const action = asString(body.action);
    if (ids.length === 0) return redirect(reply, '/blog', { kind: 'warn', message: 'Tick at least one question.' });
    for (const id of ids) {
      if (action === 'delete') deleteBlogQuestion(id);
      else if (action === 'approve' || action === 'retry') {
        const q = getBlogQuestion(id);
        if (q && q.status !== 'working' && q.status !== 'done') setBlogQuestionStatus(id, 'queued', { error: null });
      }
    }
    const verb = action === 'delete' ? 'deleted' : action === 'approve' ? 'approved' : 'put back in the queue';
    return redirect(reply, '/blog', { kind: 'ok', message: `${ids.length} question(s) ${verb}.` });
  });

  app.post('/blog/sites/:id/suggest', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    try {
      const added = await suggestBlogQuestions(id, settings, encryptionKey);
      return redirect(reply, '/blog', {
        kind: added > 0 ? 'ok' : 'warn',
        message: added > 0 ? `${added} question(s) suggested — approve them below.` : 'No new questions came back. Try again.',
      });
    } catch (err) {
      return redirect(reply, '/blog', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/blog/sites/:id/write', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const question = nextBlogQuestion(id);
    if (!question) return redirect(reply, '/blog', { kind: 'warn', message: 'This site has no queued question.' });
    if (!tryAcquireRunLock()) {
      return redirect(reply, '/blog', { kind: 'warn', message: 'A recipe run is working right now. Try again in a few minutes.' });
    }
    // Minutes of work: started here, finished in the background.
    void runOneBlogQuestion(question, settings, encryptionKey, runHeartbeat).finally(() => releaseRunLock());
    return redirect(reply, '/blog', {
      kind: 'ok',
      message: `Writing “${question.question}”. It takes a few minutes — refresh this page to see it published.`,
    });
  });

  /* ---------- Site pages: About, Contact, Privacy, Terms, Disclaimer ---------- */

  app.get('/site-pages', async (request, reply) => {
    const sites = listSites().map((s) => ({
      id: s.id,
      name: s.name,
      domain: s.domain,
      facts: getPageFacts(s.id),
      autoAbout: getAboutAuto(s.id),
      pages: listSitePages(s.id),
    }));
    const siteId = asNumber((request.query as { site?: string }).site, 0);
    return page(reply, 'Site pages', '/site-pages', sitePagesPage({ sites, site: siteId }), readFlash(request.query));
  });

  app.post('/site-pages/:id/facts', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(id)) return redirect(reply, '/site-pages', { kind: 'error', message: 'Site not found.' });
    const body = formBody(request);
    savePageFacts(id, {
      author: asString(body.author),
      why: asString(body.why),
      testing: asString(body.testing),
      extra: asString(body.extra),
    });
    return redirect(reply, '/site-pages', { kind: 'ok', message: 'Facts saved. Write or rewrite a page to use them.' });
  });

  // Keeps what was typed in the form, then drafts only the fields still blank.
  app.post('/site-pages/:id/facts/draft', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(id)) return redirect(reply, '/site-pages', { kind: 'error', message: 'Site not found.' });
    const body = formBody(request);
    savePageFacts(id, {
      author: asString(body.author),
      why: asString(body.why),
      testing: asString(body.testing),
      extra: asString(body.extra),
    });
    try {
      const { filled } = await draftSiteFacts(id, settings, encryptionKey);
      return redirect(reply, '/site-pages', {
        kind: filled.length > 0 ? 'ok' : 'warn',
        message: filled.length > 0
          ? `Draft written into ${filled.length} blank field(s). Read it, keep only what is true, then Save facts.`
          : 'Every field already has text, so nothing was changed. Clear a field to have it drafted again.',
      });
    } catch (err) {
      return redirect(reply, '/site-pages', { kind: 'error', message: errorMessage(err) });
    }
  });

  // The weekly About refresh, on or off.
  app.post('/site-pages/:id/auto-about', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(id)) return redirect(reply, '/site-pages', { kind: 'error', message: 'Site not found.' });
    const on = asString(formBody(request).on) === '1';
    setAboutAuto(id, on);
    return redirect(reply, '/site-pages', {
      kind: 'ok',
      message: on
        ? 'The About page will be checked every 7 days and rewritten if the site has grown.'
        : 'The About page will no longer be refreshed by itself.',
    });
  });

  // All five pages, one after the other, in the background: several minutes of model time.
  app.post('/site-pages/:id/all', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(id)) return redirect(reply, '/site-pages', { kind: 'error', message: 'Site not found.' });
    void writeAndPublishAll(id, settings, encryptionKey).catch(() => undefined);
    return redirect(reply, '/site-pages', {
      kind: 'ok',
      message: 'Writing and publishing all the pages. It takes several minutes: refresh to follow each row.',
    });
  });

  app.post('/site-pages/:id/:slug/write', async (request, reply) => {
    const { id: rawId, slug } = request.params as { id: string; slug: string };
    const id = asNumber(rawId, 0);
    if (!getSite(id) || !isPageSlug(slug)) {
      return redirect(reply, '/site-pages', { kind: 'error', message: 'Unknown site or page.' });
    }
    if (!canWrite(getSitePage(id, slug))) {
      return redirect(reply, '/site-pages', { kind: 'warn', message: `The ${PAGE_TITLE[slug]} page is already being written.` });
    }
    // A minute or two of model time: started here, finished in the background.
    // A failure is written on the page itself (status failed, with the reason).
    void writeSitePage(id, slug, settings, encryptionKey).catch(() => undefined);
    return redirect(reply, '/site-pages', {
      kind: 'ok',
      message: `Writing the ${PAGE_TITLE[slug]} page. Refresh in a minute or two to read the draft.`,
    });
  });

  app.post('/site-pages/:id/:slug/publish', async (request, reply) => {
    const { id: rawId, slug } = request.params as { id: string; slug: string };
    const id = asNumber(rawId, 0);
    if (!getSite(id) || !isPageSlug(slug)) {
      return redirect(reply, '/site-pages', { kind: 'error', message: 'Unknown site or page.' });
    }
    try {
      const { words } = await publishSitePage(id, slug, encryptionKey);
      return redirect(reply, '/site-pages', {
        kind: 'ok',
        message: `The ${PAGE_TITLE[slug]} page is live on the site${words ? ` (${words} words)` : ''}.`,
      });
    } catch (err) {
      return redirect(reply, '/site-pages', { kind: 'error', message: errorMessage(err) });
    }
  });

  /* ---------- More posts: new posts for a recipe that is already published ---------- */

  app.get('/more-posts', async (request, reply) => {
    const q = request.query as { site?: string; q?: string; run?: string; hidden?: string };
    const siteId = asNumber(q.site, 0);
    const query = asString(q.q).trim().toLowerCase();
    const runId = asNumber(q.run, 0);

    const countByRun = new Map(
      all<{ source_run_id: number; n: number }>("SELECT source_run_id, COUNT(*) AS n FROM extra_posts WHERE status = 'ok' GROUP BY source_run_id").map((r) => [r.source_run_id, r.n]),
    );
    const showHidden = asString(q.hidden) === '1';
    const recipes = listPublishedRecipes(siteId || undefined, 300, showHidden ? 'only' : 'exclude')
      .filter((r) => !query || r.title.toLowerCase().includes(query))
      .slice(0, 150)
      .map((r) => ({ ...r, posts: countByRun.get(r.runId) ?? 0 }));

    let chosen;
    const picked = runId ? listPublishedRecipes(undefined, 1000, 'all').find((r) => r.runId === runId) : undefined;
    const pickedSite = picked ? getSite(picked.siteId) : undefined;
    if (picked && pickedSite) {
      chosen = { recipe: picked, states: networkStates(settings, pickedSite, picked.runId), usedAngles: usedAngles(picked.runId) };
    }

    return page(
      reply,
      'More posts',
      '/more-posts',
      morePostsPage({
        site: siteId,
        sites: listSites().map((s) => ({ id: s.id, domain: s.domain })),
        query: asString(q.q).trim(),
        recipes,
        chosen,
        gapDays: gapDays(settings),
        recent: recentExtraPosts(),
        busy: Boolean(lockStatus()?.locked_at),
        showHidden,
        hiddenCount: hiddenCount(),
      }),
      readFlash(request.query),
    );
  });

  app.post('/more-posts/bulk', async (request, reply) => {
    const body = formBody(request);
    const siteId = asNumber(body.site, 0);
    const action = asString(body.action);
    const back = `/more-posts?site=${siteId}`;
    const ids = ([] as unknown[]).concat(body.run_ids ?? []).map((v) => asNumber(v, 0)).filter((n) => n > 0);

    if (action === 'hide_old') {
      const n = hideOlderThan(asNumber(body.days, 90), siteId || undefined);
      return redirect(reply, back, { kind: 'ok', message: `${n} recipe${n === 1 ? '' : 's'} hidden.` });
    }
    if (ids.length === 0) return redirect(reply, back, { kind: 'warn', message: 'Tick at least one recipe.' });
    if (action === 'hide' || action === 'unhide') {
      const n = setRecipesHidden(ids, action === 'hide');
      return redirect(reply, back, { kind: 'ok', message: `${n} recipe${n === 1 ? '' : 's'} ${action === 'hide' ? 'hidden' : 'brought back'}.` });
    }
    if (action !== 'make') return redirect(reply, back, { kind: 'error', message: 'Unknown action.' });

    const wanted = ([] as unknown[]).concat(body.networks ?? []).map((v) => asString(v)).filter((n): n is Network => NETWORKS.includes(n as Network));
    if (wanted.length === 0) return redirect(reply, back, { kind: 'error', message: 'Tick at least one network.' });
    // Each recipe gets the networks ticked that are ready for it; one with none ready is skipped.
    const jobs = ids
      .map((id) => {
        const recipe = listPublishedRecipes(undefined, 1000, 'all').find((r) => r.runId === id);
        const site = recipe ? getSite(recipe.siteId) : undefined;
        if (!recipe || !site) return null;
        const ready = networkStates(settings, site, id).filter((s) => s.ready && wanted.includes(s.network)).map((s) => s.network);
        return ready.length ? { sourceRunId: id, networks: ready, angle: 'auto' } : null;
      })
      .filter((j): j is { sourceRunId: number; networks: Network[]; angle: string } => j !== null);
    if (jobs.length === 0) {
      return redirect(reply, back, { kind: 'warn', message: 'None of the selected recipes can be posted on those networks now (switched off, or still inside the gap).' });
    }
    if (!tryAcquireRunLock()) return redirect(reply, back, { kind: 'warn', message: 'A run is working right now. Try again in a few minutes.' });
    void (async () => {
      let ok = 0;
      let failed = 0;
      try {
        for (const job of jobs) {
          runHeartbeat();
          try {
            const report = await makeExtraPosts(job, settings, encryptionKey);
            for (const o of report.outcomes) o.ok ? ok++ : failed++;
          } catch (err) {
            failed += job.networks.length;
            insertEvent('error', 'more-posts', 'More posts failed', errorMessage(err));
          }
        }
        insertEvent(failed ? 'warn' : 'info', 'more-posts', `More posts (${jobs.length} recipes): ${ok} scheduled, ${failed} failed`, '');
      } finally {
        releaseRunLock();
      }
    })();
    const skipped = ids.length - jobs.length;
    return redirect(reply, back, {
      kind: 'ok',
      message: `Making new posts for ${jobs.length} recipe${jobs.length === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped: not ready)` : ''}. It takes a few minutes each: refresh and look under Recent extra posts.`,
    });
  });

  app.post('/more-posts', async (request, reply) => {
    const body = formBody(request);
    const siteId = asNumber(body.site, 0);
    const back = (extra = '') => `/more-posts?site=${siteId}${extra}`;
    const req = {
      sourceRunId: asNumber(body.run_id, 0),
      networks: ([] as unknown[]).concat(body.networks ?? []).map((v) => asString(v)).filter((n): n is Network => NETWORKS.includes(n as Network)),
      angle: asString(body.angle, 'auto'),
    };
    const problem = checkRequest(settings, req);
    if (problem) return redirect(reply, back(`&run=${req.sourceRunId}`), { kind: 'error', message: problem });
    if (!tryAcquireRunLock()) {
      return redirect(reply, back(`&run=${req.sourceRunId}`), { kind: 'warn', message: 'A run is working right now. Try again in a few minutes.' });
    }
    // Minutes of work (a picture is made): started here, finished in the background.
    void makeExtraPosts(req, settings, encryptionKey)
      .then((report) => {
        const failed = report.outcomes.filter((o) => !o.ok);
        insertEvent(
          failed.length ? 'warn' : 'info',
          'more-posts',
          `More posts (${report.angle.label}): ${report.outcomes.filter((o) => o.ok).length} scheduled, ${failed.length} failed`,
          report.outcomes.map((o) => `${o.network}: ${o.detail}`).join('; '),
        );
      })
      .catch((err) => insertEvent('error', 'more-posts', 'More posts failed', errorMessage(err)))
      .finally(() => releaseRunLock());
    return redirect(reply, back(), {
      kind: 'ok',
      message: 'Making the new posts. It takes a few minutes: refresh this page and look under Recent extra posts.',
    });
  });

  /* -- Search Console ------------------------------------------------------ */

  const gscRunning = new Set<number>();
  const gscSites = (): GscSiteView[] =>
    listSites().map((x) => {
      const s = getSite(x.id) as (SiteRow & GscSiteFields) | undefined;
      let report = null;
      try { report = s?.gsc_report ? JSON.parse(s.gsc_report) : null; } catch { report = null; }
      return {
        id: x.id,
        domain: x.domain,
        property: s?.gsc_property ?? '',
        on: Boolean(s?.gsc_on),
        hour: s?.gsc_hour ?? 7,
        report,
        waiting: countOpportunities(x.id),
        running: gscRunning.has(x.id),
      };
    });

  /** Fetch or sort in the background: a few model calls can outlast the proxy's hundred seconds. */
  const gscRefresh = (siteId: number, stats?: QueryStat[]): void => {
    const site = getSite(siteId) as (SiteRow & GscSiteFields) | undefined;
    if (!site || gscRunning.has(siteId)) return;
    gscRunning.add(siteId);
    void refreshSite(site, liveGscDeps(settings, encryptionKey), localDateKey(new Date(), settings.get('timezone')), minImpressionsFrom(settings), stats)
      .finally(() => gscRunning.delete(siteId));
  };

  app.get('/gsc', async (request, reply) => {
    const q = request.query as { site?: string; status?: string };
    const sites = gscSites();
    const site = sites.find((s) => s.id === asNumber(q.site, 0)) ?? sites[0] ?? null;
    const status = (['new', 'added', 'dismissed'] as const).find((s) => s === q.status) ?? 'new';
    return page(
      reply,
      'Search Console',
      '/gsc',
      gscOpportunitiesPage({ sites, site, status, rows: site ? listOpportunities(site.id, status) : [], keySaved: Boolean(settings.get('gsc_service_account').trim()) }),
      readFlash(request.query),
    );
  });

  const gscIds = (request: FastifyRequest): number[] =>
    ([] as unknown[]).concat(formBody(request).ids ?? []).map((v) => asNumber(v, 0)).filter((n) => n > 0);

  app.post('/gsc/:id/add', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    const ids = gscIds(request);
    if (!ids.length) return redirect(reply, `/gsc?site=${siteId}`, { kind: 'warn', message: 'Tick at least one.' });
    const r = addOpportunities(siteId, ids);
    return redirect(reply, `/gsc?site=${siteId}`, { kind: 'ok', message: `${r.recipes} recipe keyword(s) added to Keywords, ${r.questions} question(s) to Blog. Repeats were skipped.` });
  });

  app.post('/gsc/:id/dismiss', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    const n = dismissOpportunities(siteId, gscIds(request));
    return redirect(reply, `/gsc?site=${siteId}`, { kind: 'ok', message: `${n} dismissed.` });
  });

  app.post('/gsc/:id/fetch', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    gscRefresh(siteId);
    return redirect(reply, `/gsc?site=${siteId}`, { kind: 'ok', message: 'Reading the last 28 days from Search Console. Refresh this page in a minute.' });
  });

  app.post('/gsc/:id/csv', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    try {
      const file = await request.file();
      if (!file) return redirect(reply, `/gsc?site=${siteId}`, { kind: 'error', message: 'No file received.' });
      const stats = parseQueriesCsv((await file.toBuffer()).toString('utf8'));
      if (!stats.length) return redirect(reply, `/gsc?site=${siteId}`, { kind: 'error', message: 'The file has no searches in it.' });
      gscRefresh(siteId, stats);
      return redirect(reply, `/gsc?site=${siteId}`, { kind: 'ok', message: `${stats.length} searches read from the file; the AI is sorting them. Refresh in a minute.` });
    } catch (err) {
      return redirect(reply, `/gsc?site=${siteId}`, { kind: 'error', message: errorMessage(err) });
    }
  });

  app.get('/gsc/setup', async (request, reply) => {
    let clientEmail: string | null = null;
    let keyError: string | null = null;
    let properties: string[] | null = null;
    let propertiesError: string | null = null;
    const json = settings.get('gsc_service_account').trim();
    if (json) {
      try {
        const account = parseServiceAccount(json);
        clientEmail = account.client_email;
        properties = (await new GscClient(account).listSites()).map((s) => s.siteUrl);
      } catch (err) {
        if (clientEmail) propertiesError = errorMessage(err);
        else keyError = errorMessage(err);
      }
    }
    return page(
      reply,
      'Search Console setup',
      '/gsc/setup',
      gscSetupPage({ clientEmail, keyError, properties, propertiesError, sites: gscSites(), minImpressions: minImpressionsFrom(settings) }),
      readFlash(request.query),
    );
  });

  app.post('/gsc/setup/key', async (request, reply) => {
    const text = asString(formBody(request).key).trim();
    try {
      const account = parseServiceAccount(text);
      settings.set('gsc_service_account', text);
      return redirect(reply, '/gsc/setup', { kind: 'ok', message: `Key saved for ${account.client_email}. Now add that address as a user in Search Console.` });
    } catch (err) {
      return redirect(reply, '/gsc/setup', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/gsc/setup/key/remove', async (_request, reply) => {
    settings.set('gsc_service_account', '');
    return redirect(reply, '/gsc/setup', { kind: 'ok', message: 'Key removed.' });
  });

  app.post('/gsc/setup/site/:id', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(siteId)) return redirect(reply, '/gsc/setup', { kind: 'error', message: 'Site not found' });
    const body = formBody(request);
    const hour = Math.min(23, Math.max(0, Math.floor(asNumber(body.hour, 7))));
    runSql('UPDATE sites SET gsc_property = ?, gsc_on = ?, gsc_hour = ? WHERE id = ?',
      asString(body.property).trim().slice(0, 200), asString(body.on) === '1' ? 1 : 0, hour, siteId);
    return redirect(reply, '/gsc/setup', { kind: 'ok', message: 'Saved.' });
  });

  app.post('/gsc/setup/options', async (request, reply) => {
    const min = Math.min(10000, Math.max(1, Math.floor(asNumber(formBody(request).min, 20))));
    settings.set('gsc_min_impressions', String(min));
    return redirect(reply, '/gsc/setup', { kind: 'ok', message: `Ideas need at least ${min} impressions now.` });
  });

  /* -- Radar --------------------------------------------------------------- */

  /* -- Pinterest ideas: a site's Analytics export -> article ideas ---------- */

  /** The exports being analysed, by site, and where each stands -- for the page's live status. */
  const pinIdeasRunning = new Map<number, { stage: PinIdeasStage; done: number; total: number; started: number }>();
  const pinIdeasSites = (): PinIdeasSiteView[] =>
    listSites().map((x) => ({
      id: x.id,
      domain: x.domain,
      report: lastPinReport(x.id),
      waiting: waitingPinIdeas(x.id),
      running: pinIdeasRunning.has(x.id),
      accounts: listProfiles(x.id, 'pinterest').map((p) => ({ id: p.id, username: (p.channel_name || p.buffer_channel || '').trim(), label: p.label })),
      progress: (() => {
        const p = pinIdeasRunning.get(x.id);
        return p ? { stage: p.stage, done: p.done, total: p.total, seconds: Math.round((Date.now() - p.started) / 1000) } : null;
      })(),
    }));

  app.get('/pin-ideas', async (request, reply) => {
    const q = request.query as { site?: string; status?: string };
    const sites = pinIdeasSites();
    const site = sites.find((s) => s.id === asNumber(q.site, 0)) ?? sites[0] ?? null;
    const status = (['new', 'added', 'dismissed'] as const).find((s) => s === q.status) ?? 'new';
    return page(
      reply,
      'Pinterest ideas',
      '/pin-ideas',
      pinIdeasPage({ sites, site, status, rows: site ? listPinIdeas(site.id, status as PinIdea['status']) : [] }),
      readFlash(request.query),
    );
  });

  app.post('/pin-ideas/:id/upload', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    const back = `/pin-ideas?site=${siteId}`;
    if (!getSite(siteId)) return redirect(reply, '/pin-ideas', { kind: 'error', message: 'Site not found' });
    if (pinIdeasRunning.has(siteId)) return redirect(reply, back, { kind: 'warn', message: 'Already analysing an export for this site.' });
    let name = '';
    let text = '';
    let picked = 0;
    try {
      const file = await request.file({ limits: { fileSize: 10 * 1024 * 1024 } });
      if (!file) return redirect(reply, back, { kind: 'error', message: 'No file received.' });
      name = file.filename || 'export.csv';
      text = (await file.toBuffer()).toString('utf8');
      // The fields sent before the file come with it; the account picker is one.
      const field = (file.fields as Record<string, { value?: unknown } | undefined>).account;
      picked = asNumber(field?.value, 0);
    } catch (err) {
      return redirect(reply, back, { kind: 'error', message: `Could not read the file: ${errorMessage(err)}` });
    }
    // The model takes a while: the page is answered now, the ideas arrive on a refresh.
    pinIdeasRunning.set(siteId, { stage: 'reading', done: 0, total: 0, started: Date.now() });
    void analyseExport(
      siteId,
      name,
      text,
      { ask: async (vars) => (await askPrompt(settings, encryptionKey, 'pin-ideas', vars)).content, pinTitle: (url) => pinTitle(url),
        progress: (stage, done = 0, total = 0) => {
          const p = pinIdeasRunning.get(siteId);
          if (p) Object.assign(p, { stage, done, total });
        },
      },
      localDateKey(new Date(), settings.get('timezone')),
      picked,
    )
      .catch((err) => log.warn(`pin ideas for site ${siteId} failed: ${errorMessage(err)}`))
      .finally(() => pinIdeasRunning.delete(siteId));
    return redirect(reply, back, { kind: 'ok', message: 'Reading the export. The status below follows it, and the page shows the ideas by itself when it is done.' });
  });

  /** Polled by the page while an export is analysed: where it stands, and whether it is done. */
  app.get('/pin-ideas/:id/progress', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    const p = pinIdeasRunning.get(siteId);
    return reply.header('cache-control', 'no-store').send(
      p ? { running: true, stage: p.stage, done: p.done, total: p.total, seconds: Math.round((Date.now() - p.started) / 1000) } : { running: false },
    );
  });

  const pinIdeaIds = (request: FastifyRequest): number[] =>
    ([] as unknown[]).concat(formBody(request).ids ?? []).map((v) => asNumber(v, 0)).filter((n) => n > 0);

  app.post('/pin-ideas/:id/add', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    const ids = pinIdeaIds(request);
    if (!ids.length) return redirect(reply, `/pin-ideas?site=${siteId}`, { kind: 'warn', message: 'Tick at least one.' });
    const n = addPinIdeas(siteId, ids);
    return redirect(reply, `/pin-ideas?site=${siteId}`, { kind: 'ok', message: `${n} idea(s) added to Keywords. Repeats were skipped.` });
  });

  const ideaTab = (request: FastifyRequest): PinIdea['status'] =>
    (['new', 'added', 'dismissed'] as const).find((x) => x === (request.query as { status?: string }).status) ?? 'new';

  app.post('/pin-ideas/:id/delete', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    const status = ideaTab(request);
    const back = `/pin-ideas?site=${siteId}&status=${status}`;
    const ids = pinIdeaIds(request);
    if (!ids.length) return redirect(reply, back, { kind: 'warn', message: 'Tick at least one.' });
    const n = deletePinIdeas(siteId, status, ids);
    return redirect(reply, back, { kind: 'ok', message: `${n} idea(s) deleted.` });
  });

  app.post('/pin-ideas/:id/delete-all', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    const status = ideaTab(request);
    const n = deletePinIdeas(siteId, status, 'all');
    return redirect(reply, `/pin-ideas?site=${siteId}&status=${status}`, { kind: 'ok', message: `${n} idea(s) deleted.` });
  });

  app.post('/pin-ideas/:id/dismiss', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    const n = dismissPinIdeas(siteId, pinIdeaIds(request));
    return redirect(reply, `/pin-ideas?site=${siteId}`, { kind: 'ok', message: `${n} dismissed.` });
  });

  const radarRunning = new Set<number>();
  const radarSites = (): RadarSiteView[] =>
    listSites().map((x) => {
      const s = getSite(x.id) as (SiteRow & RadarSiteFields) | undefined;
      let report: RadarReport | null = null;
      try { report = s?.radar_report ? (JSON.parse(s.radar_report) as RadarReport) : null; } catch { report = null; }
      return {
        id: x.id,
        domain: x.domain,
        on: Boolean(s?.radar_on),
        hour: s?.radar_hour ?? 6,
        report,
        waiting: radarWaiting(x.id),
        sources: listSources(x.id).length,
        running: radarRunning.has(x.id),
      };
    });

  const radarConfigured = (): boolean => {
    const counts = tokenCounts(settings);
    return (settings.get('radar_provider') === 'apify' ? counts.apify : counts.brightdata) > 0;
  };

  /** In the background: a scan waits on someone else's service, which outlasts any request. */
  const radarScan = (siteId: number): void => {
    const site = getSite(siteId) as (SiteRow & RadarSiteFields) | undefined;
    if (!site || radarRunning.has(siteId)) return;
    radarRunning.add(siteId);
    void radarScanSite(site, liveRadarDeps(settings, encryptionKey), localDateKey(new Date(), settings.get('timezone')), radarOptionsFrom(settings))
      .finally(() => radarRunning.delete(siteId));
  };

  app.get('/radar', async (request, reply) => {
    const q = request.query as { site?: string; status?: string };
    const sites = radarSites();
    const site = sites.find((s) => s.id === asNumber(q.site, 0)) ?? sites[0] ?? null;
    const status = (['new', 'added', 'dismissed'] as const).find((s) => s === q.status) ?? 'new';
    return page(
      reply,
      'Radar',
      '/radar',
      radarPage({ sites, site, status, rows: site ? radarPosts(site.id, status as RadarPost['status']) : [], configured: radarConfigured() }),
      readFlash(request.query),
    );
  });

  const radarIds = (request: FastifyRequest): number[] =>
    ([] as unknown[]).concat(formBody(request).ids ?? []).map((v) => asNumber(v, 0)).filter((n) => n > 0);

  app.post('/radar/:id/add', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    const ids = radarIds(request);
    if (!ids.length) return redirect(reply, `/radar?site=${siteId}`, { kind: 'warn', message: 'Tick at least one.' });
    const r = radarAddToQueue(siteId, ids);
    return redirect(reply, `/radar?site=${siteId}`, { kind: 'ok', message: `${r.recipes} idea(s) added to Keywords, ${r.questions} question(s) to Blog. Repeats were skipped.` });
  });

  app.post('/radar/:id/dismiss', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    const n = radarDismiss(siteId, radarIds(request));
    return redirect(reply, `/radar?site=${siteId}`, { kind: 'ok', message: `${n} dismissed.` });
  });

  app.post('/radar/:id/scan', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    if (!radarConfigured()) return redirect(reply, `/radar?site=${siteId}`, { kind: 'error', message: 'No scraping service connected yet — see Radar → Setup.' });
    radarScan(siteId);
    return redirect(reply, `/radar?site=${siteId}`, { kind: 'ok', message: 'Reading the watched pages. Refresh this page in a few minutes.' });
  });

  app.get('/radar/setup', async (request, reply) => {
    const sites = radarSites();
    const sourcesBySite = new Map(sites.map((s) => [s.id, listSources(s.id)]));
    return page(
      reply,
      'Radar setup',
      '/radar/setup',
      radarSetupPage({
        provider: settings.get('radar_provider') === 'apify' ? 'apify' : 'brightdata',
        brightdataTokens: tokenCounts(settings).brightdata,
        apifyTokens: tokenCounts(settings).apify,
        brightdataInUse: tokenStateIn(settings, 'brightdata').get(),
        apifyInUse: tokenStateIn(settings, 'apify').get(),
        perPage: radarOptionsFrom(settings).perPage,
        minScore: radarOptionsFrom(settings).minScore,
        sites,
        sourcesBySite,
      }),
      readFlash(request.query),
    );
  });

  app.post('/radar/setup/provider', async (request, reply) => {
    const body = formBody(request);
    settings.set('radar_provider', asString(body.provider) === 'apify' ? 'apify' : 'brightdata');
    // An empty box means "keep what is saved", so a page reload cannot wipe
    // tokens the form never shows back. A box with something in it replaces the
    // whole list, and the token in use goes back to the first: the numbering it
    // pointed at belonged to the old list.
    for (const name of ['brightdata', 'apify'] as const) {
      const pasted = asString(body[name]).trim();
      if (!pasted) continue;
      settings.set(`${name}_token`, splitTokens(pasted).join('\n'));
      settings.set(`${name}_token_index`, '0');
    }
    const counts = tokenCounts(settings);
    return redirect(reply, '/radar/setup', { kind: 'ok', message: `Saved. ${counts.brightdata} Bright Data token(s), ${counts.apify} Apify token(s).` });
  });

  app.post('/radar/setup/options', async (request, reply) => {
    const body = formBody(request);
    settings.set('radar_posts_per_page', String(Math.min(100, Math.max(5, Math.floor(asNumber(body.per_page, 25))))));
    settings.set('radar_min_score', String(Math.max(0, Math.floor(asNumber(body.min_score, 0)))));
    return redirect(reply, '/radar/setup', { kind: 'ok', message: 'Saved.' });
  });

  app.post('/radar/setup/site/:id', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(siteId)) return redirect(reply, '/radar/setup', { kind: 'error', message: 'Site not found' });
    const body = formBody(request);
    const hour = Math.min(23, Math.max(0, Math.floor(asNumber(body.hour, 6))));
    runSql('UPDATE sites SET radar_on = ?, radar_hour = ? WHERE id = ?', asString(body.on) === '1' ? 1 : 0, hour, siteId);
    return redirect(reply, '/radar/setup', { kind: 'ok', message: 'Saved.' });
  });

  app.post('/radar/setup/site/:id/source', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(siteId)) return redirect(reply, '/radar/setup', { kind: 'error', message: 'Site not found' });
    const { added, handle } = addSource(siteId, asString(formBody(request).handle));
    if (!handle) return redirect(reply, '/radar/setup', { kind: 'error', message: 'That is not a page address.' });
    return redirect(reply, '/radar/setup', added
      ? { kind: 'ok', message: `Watching ${handle}.` }
      : { kind: 'warn', message: `${handle} was already on the list.` });
  });

  app.post('/radar/setup/source/:id/toggle', async (request, reply) => {
    const body = formBody(request);
    toggleSource(asNumber(body.site, 0), asNumber((request.params as { id: string }).id, 0), asString(body.on) === '1');
    return redirect(reply, '/radar/setup', { kind: 'ok', message: 'Saved.' });
  });

  app.post('/radar/setup/source/:id/remove', async (request, reply) => {
    removeSource(asNumber(formBody(request).site, 0), asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/radar/setup', { kind: 'ok', message: 'Removed. The ideas it already found stay.' });
  });

  /* -- Taxonomy ------------------------------------------------------------ */

  app.get('/taxonomy', async (request, reply) => {
    const sites = listSites().map((x) => {
      const s = getSite(x.id) as (SiteRow & TaxonomySiteFields) | undefined;
      return { id: x.id, domain: x.domain, on: Boolean(s?.taxo_on), running: taxoRunning(x.id), report: s ? taxoReport(s) : null, jobs: taxoJobs(x.id) };
    });
    return page(reply, 'Taxonomy', '/taxonomy',
      taxonomyPage({ sites, imagePrompt: settings.get('taxo_image_prompt'), defaultPrompt: DEFAULT_IMAGE_PROMPT }),
      readFlash(request.query));
  });

  app.post('/taxonomy/:id/switch', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    const on = asString(formBody(request).on) === '1';
    runSql('UPDATE sites SET taxo_on = ? WHERE id = ?', on ? 1 : 0, siteId);
    return redirect(reply, '/taxonomy', { kind: 'ok', message: on ? 'On: one term every few minutes, starting with the next check.' : 'Off.' });
  });

  app.post('/taxonomy/:id/run', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(siteId)) return redirect(reply, '/taxonomy', { kind: 'error', message: 'Site not found' });
    // In the background: every term is a model call and a Flow picture. Terms wait
    // their turn behind a recipe run instead of failing.
    void taxoRun(siteId, settings, encryptionKey, {
      max: 200,
      tryLock: tryAcquireRunLock,
      unlock: releaseRunLock,
      heartbeat: runHeartbeat,
      waitForLock: true,
    });
    return redirect(reply, '/taxonomy', { kind: 'ok', message: 'Filling now, one term after another (a few minutes each with a picture). Refresh this page to follow.' });
  });

  app.post('/taxonomy/:id/retry', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    const n = taxoRetry(siteId);
    return redirect(reply, '/taxonomy', { kind: 'ok', message: `${n} term(s) will be tried again.` });
  });

  app.post('/taxonomy/prompt', async (request, reply) => {
    const body = formBody(request);
    const text = asString(body.reset) === '1' ? '' : asString(body.prompt).trim();
    settings.set('taxo_image_prompt', text === DEFAULT_IMAGE_PROMPT ? '' : text.slice(0, 4000));
    return redirect(reply, '/taxonomy', { kind: 'ok', message: text ? 'Picture prompt saved.' : 'Back to the default picture prompt.' });
  });

  /* -- Keywords -> Check the queue ---------------------------------------- */

  app.get('/keywords/check', async (request, reply) =>
    page(reply, 'Check the queue', '/keywords', queueCheckPage(latestQueueCheck(), queuedKeywords().length), readFlash(request.query)),
  );

  app.post('/keywords/check', async (_request, reply) => {
    startQueueCheck(async (items) => (await askPrompt(settings, encryptionKey, 'queue-check', { items })).content);
    return reply.redirect('/keywords/check');
  });

  app.post('/keywords/check/remove', async (request, reply) => {
    const body = formBody(request);
    const ids = ([] as unknown[]).concat(body.ids ?? []).map((v) => asNumber(v, 0)).filter((n) => n > 0);
    if (ids.length === 0) return redirect(reply, '/keywords/check', { kind: 'warn', message: 'Nothing was ticked.' });
    const n = removeFromQueue(ids);
    const job = latestQueueCheck();
    if (job) job.flags = job.flags.filter((f) => !ids.includes(f.id));
    return redirect(reply, '/keywords/check', { kind: 'ok', message: `${n} keyword(s) taken out of the queue.` });
  });

  app.get('/keywords', async (request, reply) => {
    const q = request.query as { page?: string };
    const pageNum = Math.max(1, asNumber(q.page, 1));
    const filter = readKeywordFilter(request.query);

    const sites = listSites();
    const rows = searchKeywords(filter, 100, (pageNum - 1) * 100);

    // One dot per site, per keyword. Built from the whole grid in memory
    // rather than a query each: it is one small table and this is the only
    // page that needs it laid out this way.
    const grid = loadLinkGrid();
    const marks = new Map<number, SiteMark[]>();

    for (const keyword of rows) {
      marks.set(
        keyword.id,
        sites.filter((site) => !filter.siteId || site.id === filter.siteId).map((site) => {
          const cell = grid.find((l) => l.keywordId === keyword.id && l.siteId === site.id);
          return { domain: site.domain, status: cell?.status ?? ('unlinked' as const) };
        }),
      );
    }

    return page(
      reply,
      'Keywords',
      '/keywords',
      keywordsPage(
        rows,
        sites,
        marks,
        pageNum,
        countKeywords(),
        countKeywordsMatching(filter),
        keywordViewCounts(filter.siteId),
        filter,
      ),
      readFlash(request.query),
    );
  });

  app.post('/keywords/import', async (request, reply) => {
    try {
      const file = await request.file();
      if (!file) {
        return redirect(reply, '/keywords', { kind: 'error', message: 'No file received.' });
      }

      const report = importKeywordsCsv((await file.toBuffer()).toString('utf8'));

      if (report.errors.length > 0 && report.imported === 0) {
        return redirect(reply, '/keywords', {
          kind: 'error',
          message: report.errors.slice(0, 3).join(' '),
        });
      }

      const parts: string[] = [];
      if (report.imported) parts.push(`${report.imported} keyword(s) added`);
      if (report.updated) parts.push(`${report.updated} updated`);
      parts.push(`${report.linksSet} site link(s) set`);
      if (report.skipped) parts.push(`${report.skipped} row(s) skipped`);

      let message = `${parts.join(', ')}.`;
      if (report.similar.length) {
        message +=
          ` ${report.similar.length} left out as the same dish as an existing keyword: ` +
          `${report.similar.slice(0, 8).join('; ')}${report.similar.length > 8 ? ` and ${report.similar.length - 8} more` : ''}.`;
      }

      // A keyword linked to no site is not work â€” it will sit there looking
      // like supply and publish nothing. Say so plainly rather than reporting
      // a successful import and leaving the queue empty.
      if (report.matchedDomains === 0) {
        message +=
          ' No column matched a site, so nothing will publish yet.' +
          (report.unknownDomains.length
            ? ` These headings match no site you have configured: ${report.unknownDomains.join(', ')}.` +
              ' Check the domains under Sites, or download the template â€” its columns always match.'
            : ' Add one column per site domain.');
      } else if (report.linksSet === 0) {
        message +=
          ` ${report.matchedDomains} site column(s) matched, but every cell was empty.` +
          ' Put go, done or no in the cells to say where each keyword should run.';
      } else if (report.unknownDomains.length) {
        message += ` Columns matching no site were ignored: ${report.unknownDomains.join(', ')}.`;
      }

      const wrong = report.matchedDomains === 0 || report.linksSet === 0;

      return redirect(reply, '/keywords', {
        kind: wrong ? 'warn' : report.unknownDomains.length ? 'warn' : 'ok',
        message,
      });
    } catch (err) {
      return redirect(reply, '/keywords', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.get('/keywords/add', async (request, reply) =>
    page(
      reply,
      'Add keywords',
      '/keywords',
      keywordAddPage(
        listSites().map((x) => ({ id: x.id, domain: x.domain })),
        keywordGroups(),
        // The site chosen in the tabs is the one ticked; none chosen = all.
        asNumber(/(?:^|;\s*)scope_site=(\d+)/.exec(String(request.headers.cookie ?? ''))?.[1], 0),
      ),
      readFlash(request.query),
    ),
  );

  /* -- Keyword research ----------------------------------------------------- */

  app.get('/research', async (request, reply) => {
    const query = request.query as { seed?: string | string[]; niche?: string; per?: string; job?: string; site?: string; site_ids?: string | string[] };
    const topics = cleanTopics(query.seed);
    // The sites ticked on the search form: where the recipes and questions will go.
    const allSites = listSites();
    const known = new Set(allSites.map((x) => x.id));
    const siteIds = ([] as string[]).concat(query.site_ids ?? []).map((v) => asNumber(v, 0)).filter((id) => known.has(id));
    const scoped = asNumber(query.site, 0);
    if (siteIds.length === 0 && known.has(scoped)) siteIds.push(scoped);
    if (siteIds.length === 0 && allSites.length === 1) siteIds.push(allSites[0]!.id);
    const niche = asString(query.niche).trim().slice(0, 60);
    const perRaw = Math.floor(Number(asString(query.per)));
    const perTopic = Number.isFinite(perRaw) && perRaw > 0 ? Math.min(50, perRaw) : DEFAULT_PER_TOPIC;
    const serperKey = settings.get('serper_api_key');
    const serperState = serperStateIn(settings);

    // Several topics: searched in the background, the page checks back.
    if (topics.length > 0 && !query.job) {
      // A search nobody can add to is a minute of Google and an AI clean-up thrown away.
      if (siteIds.length === 0 && allSites.length > 0) {
        return redirect(reply, `/research${niche ? `?niche=${encodeURIComponent(niche)}` : ''}`, { kind: 'error', message: 'Tick at least one site to send to, then search again.' });
      }
      // Repeats are judged against the ticked sites only; what other sites
      // have is shown as a note and can still be added.
      const repeats = researchRepeats(siteIds);
      const job = startResearchJob(topics, perTopic, niche, async (topic) =>
        filterWithModel(await researchKeywords(topic, { serperKey, serperState, existingTitles: repeats.here, elsewhere: repeats.elsewhere }), async (vars) =>
          (await askPrompt(settings, encryptionKey, 'research-filter', vars)).content,
        ),
      );
      const back = new URLSearchParams({ job: job.id, ...(niche ? { niche } : {}) });
      for (const id of siteIds) back.append('site_ids', String(id));
      return reply.redirect(`/research?${back.toString()}`);
    }

    let ideas = niche ? recallIdeas(niche) : null;
    if (niche && !query.job && !ideas) {
      const { candidates, notes } = await topicCandidates(niche, { serperKey, serperState });
      const today = new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: settings.get('timezone') });
      try {
        const answer = await askPrompt(settings, encryptionKey, 'research-topics', {
          niche,
          today,
          candidates: candidates.map((c) => `- ${c}`).join('\n') || '(none: Google did not answer)',
          siteMix: '(not available)',
        });
        ideas = await verifyTopics(parseTopicIdeas(niche, answer.content, notes));
        if (ideas.topics.length || ideas.seasonal.length) rememberIdeas(ideas);
      } catch (err) {
        ideas = parseTopicIdeas(niche, '', [...notes, `AI: ${errorMessage(err)}`]);
      }
    }

    const job = query.job ? getResearchJob(asString(query.job)) : undefined;
    const jobGone = Boolean(query.job) && !job;
    return page(
      reply,
      'Keyword research',
      '/research',
      researchPage({
        sites: listSites().map((x) => ({ id: x.id, domain: x.domain })),
        auto: listSites().map((x) => {
          let report = null;
          try { report = x.auto_research_report ? JSON.parse(x.auto_research_report) : null; } catch { report = null; }
          return {
            id: x.id,
            domain: x.domain,
            on: Boolean(x.auto_research_on),
            niche: x.auto_research_niche ?? '',
            recipes: x.auto_research_recipes ?? 5,
            questions: x.auto_research_questions ?? 3,
            ttl: x.auto_research_ttl_hours ?? 24,
            hour: x.auto_research_hour ?? 6,
            report,
          };
        }),
        topics: job?.topics ?? [],
        perTopic: job?.perTopic ?? DEFAULT_PER_TOPIC,
        niche,
        ideas,
        job: job ? { done: job.done, total: job.topics.length, finished: job.finished } : null,
        results: job?.finished ? job.results : null,
        hasSerper: Boolean(serperKey.trim()),
        selectedSites: siteIds,
        scopedSite: known.has(scoped) ? scoped : 0,
        jobId: job?.id ?? null,
      }),
      jobGone ? { kind: 'warn', message: 'That search is no longer kept (the platform restarted or an hour passed). Search again.' } : readFlash(request.query),
    );
  });

  const saveAutoResearch = (siteId: number, body: Record<string, unknown>): void => {
    const n = (v: unknown, lo: number, hi: number, dflt: number) => {
      const x = Math.floor(Number(asString(v).trim()));
      return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
    };
    runSql(
      `UPDATE sites SET auto_research_on = ?, auto_research_niche = ?, auto_research_recipes = ?,
         auto_research_questions = ?, auto_research_ttl_hours = ?, auto_research_hour = ? WHERE id = ?`,
      asString(body.on) === '1' ? 1 : 0,
      asString(body.niche).trim().slice(0, 60),
      n(body.recipes, 0, 50, 5),
      n(body.questions, 0, 50, 3),
      n(body.ttl, 1, 720, 24),
      n(body.hour, 0, 23, 6),
      siteId,
    );
  };

  app.post('/research/auto/:id', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(siteId)) return redirect(reply, '/research', { kind: 'error', message: 'Site not found' });
    saveAutoResearch(siteId, formBody(request));
    return redirect(reply, '/research', { kind: 'ok', message: 'Daily research saved.' });
  });

  app.post('/research/auto/:id/run', async (request, reply) => {
    const siteId = asNumber((request.params as { id: string }).id, 0);
    if (!getSite(siteId)) return redirect(reply, '/research', { kind: 'error', message: 'Site not found' });
    saveAutoResearch(siteId, formBody(request));
    const site = getSite(siteId)!;
    if (!(site.auto_research_niche ?? '').trim()) {
      return redirect(reply, '/research', { kind: 'error', message: 'Set a niche first.' });
    }
    const report = await runAutoResearch(site, liveResearchDeps(settings, encryptionKey), localDateKey(new Date(), settings.get('timezone')));
    return redirect(reply, '/research', report.error
      ? { kind: 'error', message: `Research failed: ${report.error}` }
      : { kind: 'ok', message: `Topic "${report.topic}": ${report.added} recipe(s) and ${report.questions} question(s) added; ${report.removedKeywords + report.removedQuestions} unwritten removed.` });
  });

  app.post('/research/import', async (request, reply) => {
    const body = formBody(request);
    const list = (v: unknown) => ([] as unknown[]).concat(v ?? []).map((x) => asString(x).trim()).filter(Boolean);
    // Each ticked recipe is "topic||recipe": it joins its own topic's group.
    const byGroup = new Map<string, string[]>();
    for (const v of list(body.recipes)) {
      const cut = v.indexOf('||');
      const group = (cut >= 0 ? v.slice(0, cut) : asString(body.group)).trim().toLowerCase();
      const text = titleCase(cut >= 0 ? v.slice(cut + 2) : v);
      if (!group || !text) continue;
      byGroup.set(group, [...(byGroup.get(group) ?? []), text]);
    }
    const recipes = [...byGroup.values()].flat();
    const questions = list(body.questions);
    const known = new Set(listSites().map((x) => x.id));
    const siteIds = list(body.site_ids).map((v) => asNumber(v, 0)).filter((id) => known.has(id));
    if (siteIds.length === 0) {
      const job = asString(body.job).trim();
      return job && getResearchJob(job)
        ? redirect(reply, `/research?job=${encodeURIComponent(job)}`, { kind: 'error', message: 'Tick at least one site, then press “Add the ticked ones” again. Your results are still here.' })
        : redirect(reply, '/research', { kind: 'error', message: 'Tick at least one site, then add them again (search the topic once more).' });
    }
    const parts: string[] = [];
    for (const [group, lines] of byGroup) {
      const r = addPastedKeywords(lines, group, siteIds);
      parts.push(
        `${r.added} recipe keyword(s) added to "${group}"` +
          (r.linked ? `, ${r.linked} already on another site added to the ticked one(s)` : '') +
          (r.skipped ? ` (${r.skipped} repeat(s) skipped)` : ''),
      );
    }
    if (questions.length) {
      let added = 0;
      let skipped = 0;
      for (const siteId of siteIds) {
        const q = addBlogQuestions(siteId, questions);
        added += q.added;
        skipped += q.skipped;
      }
      parts.push(`${added} blog question(s) queued${skipped ? ` (${skipped} repeat(s) skipped)` : ''}`);
    }
    if (parts.length === 0) return redirect(reply, '/research', { kind: 'warn', message: 'Nothing was ticked.' });
    return redirect(reply, recipes.length ? '/keywords' : '/blog', { kind: 'ok', message: `${parts.join('; ')}.` });
  });

  app.post('/keywords/paste', async (request, reply) => {
    const body = formBody(request);
    const seed = asString(body.seed_keyword).trim();
    if (!seed) return redirect(reply, '/keywords/add', { kind: 'error', message: 'Give the list a topic group.' });
    const known = new Set(listSites().map((x) => x.id));
    const siteIds = ([] as unknown[])
      .concat(body.site_ids ?? [])
      .map((v) => asNumber(v, 0))
      .filter((id) => known.has(id));
    const { added: fresh, linked, skipped, similar } = addPastedKeywords(asString(body.lines).split(/\r?\n/), seed, siteIds);
    const added = fresh + linked;
    const where = siteIds.length ? ` They will publish on ${siteIds.length} site(s).` : ' No site was ticked, so none will publish yet.';
    return redirect(reply, added > 0 ? '/keywords' : '/keywords/add', {
      kind: added > 0 && siteIds.length ? 'ok' : 'warn',
      message:
        `${added} keyword(s) added${linked ? ` (${linked} already on another site)` : ''}${skipped ? `, ${skipped} skipped (already on the ticked sites, the same dish, or too short)` : ''}.${added ? where : ''}` +
        (similar.length ? ` Same dish as an existing keyword: ${similar.slice(0, 8).join('; ')}${similar.length > 8 ? ` and ${similar.length - 8} more` : ''}.` : ''),
    });
  });

  /**
   * Act on every ticked keyword.
   *
   * Each action is a verb that does one thing, because the bar this replaced
   * read "Status [leave as is] On [all sites] set to [leave as is]" — two
   * identical-looking dropdowns meaning different things, in a sentence with
   * no verb in it. Nobody could predict what Apply would do, so nobody used it.
   */
  app.post('/keywords/bulk', async (request, reply) => {
    const body = formBody(request);

    // Fastify's form parser gives a single string for one checkbox and an
    // array for several; a submission with none ticked gives nothing.
    const picked = body.ids;
    let ids = (Array.isArray(picked) ? picked : picked === undefined ? [] : [picked])
      .map((value) => asNumber(value, 0))
      .filter((id) => id > 0);

    // "Select all N in this view": the same filter the page showed, every page of it.
    if (asString(body.scope) === 'all') {
      ids = keywordIdsMatching(
        readKeywordFilter({ q: body.filter_q, view: body.filter_view, site: body.filter_site }),
      );
    }

    // Only ever back to a path on this app.
    const backRaw = asString(body.back, '/keywords');
    const back = backRaw.startsWith('/keywords') ? backRaw : '/keywords';

    if (ids.length === 0) {
      return redirect(reply, back, {
        kind: 'warn',
        message: 'Nothing was ticked, so nothing changed.',
      });
    }

    const action = asString(body.action);
    const siteId = Math.max(0, asNumber(body.site_id, 0));
    const siteIds = siteId ? [siteId] : [];
    const where = siteId
      ? (getSite(siteId)?.domain ?? 'that site')
      : 'every site';

    const done = (message: string): FastifyReply =>
      redirect(reply, back, { kind: 'ok', message });

    switch (action) {
      case 'publish-on': {
        // Setting the cells alone is not enough: a keyword whose own status is
        // done or no would still never be offered, and the row would sit there
        // looking correct. Turning it on is what the operator meant.
        const cells = bulkSetLinks(ids, siteIds, 'go');
        bulkSetKeywordStatus(ids, 'go');
        return done(
          `${ids.length} keyword(s) will now publish on ${where} (${cells} cell(s) set), ` +
            'and they are switched on.',
        );
      }

      case 'stop-on': {
        const cells = bulkSetLinks(ids, siteIds, 'no');
        return done(`${ids.length} keyword(s) will no longer publish on ${where} (${cells} cell(s)).`);
      }

      case 'finish':
        bulkSetKeywordStatus(ids, 'done');
        return done(`${ids.length} keyword(s) marked finished.`);

      case 'off':
        bulkSetKeywordStatus(ids, 'no');
        return done(`${ids.length} keyword(s) turned off.`);

      case 'share-on': {
        const cells = bulkSetShareImages(ids, siteIds, true);
        return done(`${cells} cell(s) will reuse existing article images on ${where}.`);
      }

      case 'share-off': {
        const cells = bulkSetShareImages(ids, siteIds, false);
        return done(`${cells} cell(s) will generate fresh article images on ${where}.`);
      }

      case 'delete': {
        const removed = bulkDeleteKeywords(ids);
        return done(`Deleted ${removed} keyword(s).`);
      }

      default:
        return redirect(reply, back, {
          kind: 'error',
          message: 'That is not something this page can do.',
        });
    }
  });

  /**
   * One keyword, and why it is or is not publishing.
   *
   * Decisions answer that question per cycle. This answers it per keyword,
   * which is the direction it is actually asked in — "this one has never gone
   * out, why?" — and reuses the selector's own evaluateSite, so a verdict here
   * and a verdict in the scheduler cannot drift apart.
   */
  /**
   * Put a held-back pair back in the running.
   *
   * The scheduler stops offering a pair that failed the same way repeatedly.
   * Clearing that is a person's call — they either fixed what was wrong or
   * decided it is worth another go — so there is no automatic expiry.
   */
  app.post('/keywords/:id/unblock/:siteId', async (request, reply) => {
    const params = request.params as { id: string; siteId: string };
    const keywordId = asNumber(params.id, 0);

    unblockLink(keywordId, asNumber(params.siteId, 0));
    return redirect(reply, `/keywords/${keywordId}`, {
      kind: 'ok',
      message: 'Back in the running. It will be offered again on the next check.',
    });
  });

  app.get('/keywords/:id', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const keyword = getKeyword(id);
    if (!keyword) {
      return redirect(reply, '/keywords', { kind: 'error', message: 'Keyword not found' });
    }

    const timezone = settings.get('timezone');
    const now = new Date();
    const sites = loadSiteViews(localDateKey(now, timezone), timezone);

    const diagnosis = diagnoseKeyword(
      { id: keyword.id, seedKeyword: keyword.seed_keyword, status: keyword.status },
      sites,
      getLinksForKeyword(id).map((l) => ({
        siteId: l.site_id,
        status: l.status as 'go' | 'done' | 'no',
        blocked: l.blocked_at !== null,
        blockedReason: l.blocked_reason ?? '',
      })),
      { now, timezone },
    );

    return page(
      reply,
      keyword.seed_keyword,
      '/keywords',
      keywordDetailPage(
        keyword,
        diagnosis,
        listRunsForKeyword(id),
        new Map(loadLinkGrid().filter((l) => l.keywordId === id).map((l) => [l.siteId, l.shareImages])),
        sharedImageInfo(id),
        keywordImageCounts(id),
        keywordsInGroup(keyword.seed_keyword, id),
      ),
      readFlash(request.query),
    );
  });

  /**
   * Write this keyword's article now, without publishing it.
   *
   * The scheduler picks its own pair, so "dry run" on the dashboard exercises
   * whatever is next in the queue. Here the keyword is already chosen, which
   * is what you want when the question is about this article rather than about
   * the pipeline.
   */
  app.post('/keywords/:id/dry-run', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const keyword = getKeyword(id);
    if (!keyword) {
      return redirect(reply, '/keywords', { kind: 'error', message: 'Keyword not found' });
    }

    const timezone = settings.get('timezone');
    const now = new Date();
    const sites = loadSiteViews(localDateKey(now, timezone), timezone);

    // Whichever linked site would take it, ignoring the daily target and the
    // interval: a dry run publishes nothing, so neither limit is protecting
    // anything here.
    const linked = getLinksForKeyword(id).filter((l) => l.status === 'go');
    const target =
      linked.map((l) => sites.find((s) => s.id === l.site_id)).find((s) => s?.status === 'active') ??
      linked.map((l) => sites.find((s) => s.id === l.site_id)).find(Boolean);

    if (!target) {
      return redirect(reply, `/keywords/${id}`, {
        kind: 'warn',
        message:
          'This keyword is not set to go on any site, so there is no site to write it for. ' +
          'Set a cell to go first.',
      });
    }

    const site = getSite(target.id);
    if (!site) {
      return redirect(reply, `/keywords/${id}`, { kind: 'error', message: 'That site vanished.' });
    }

    try {
      const runId = createRun(id, site.id, 'dry');
      const ctx = new PipelineContext({
        runId,
        site,
        keyword,
        settings,
        encryptionKey,
        shareImages: getLinkShare(id, site.id),
        mode: 'dry',
      });

      const outcome = await executePipeline(ctx);
      return redirect(reply, `/runs/${runId}`, {
        kind: outcome.status === 'failed' ? 'error' : 'ok',
        message:
          outcome.status === 'held'
            ? `Written for ${site.domain} and not published. Read it below.`
            : outcome.status === 'failed'
              ? `The dry run failed: ${outcome.error ?? ''}`
              : `Dry run ended as "${outcome.status}".`,
      });
    } catch (err) {
      return redirect(reply, `/keywords/${id}`, { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/keywords/:id/delete', async (request, reply) => {
    deleteKeyword(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/keywords', { kind: 'ok', message: 'Keyword deleted.' });
  });

  app.post('/keywords/:id/status', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const status = asString(formBody(request).status, 'no');
    if (status === 'go' || status === 'done' || status === 'no') setKeywordStatus(id, status);
    return redirect(reply, `/keywords/${id}`);
  });

  app.post('/keywords/:id/cook', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const body = formBody(request);
    setKeywordCook(id, asString(body.cook_recipe, ''), asString(body.cook_notes, ''));
    return redirect(reply, `/keywords/${id}`, { kind: 'ok', message: "Saved the cook's recipe and notes." });
  });

  /*
   * Readers' tips for the cook to approve. Search, read what readers wrote,
   * let the model point at tips two or more pages report, then hold its answer
   * to the rules in code. Nothing reaches the notes until the cook approves it.
   */
  app.post('/keywords/:id/cook/suggest', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const keyword = getKeyword(id);
    if (!keyword) return redirect(reply, '/keywords', { kind: 'error', message: 'Keyword not found' });

    const serperKey = settings.get('serper_api_key');
    const ollamaKeys = webSearchKeys(encryptionKey, settings.get('llm_base_url'));
    if (!serperKey.trim() && ollamaKeys.length === 0) {
      return redirect(reply, `/keywords/${id}`, { kind: 'error', message: 'No Serper or ollama.com key is set, so there is nothing to search with.' });
    }

    const title = (keyword.spy_title || keyword.seed_keyword).trim();
    try {
      const pages = await gatherExperiences(title, { serperKey, serperState: serperStateIn(settings), ollamaKeys });
      if (pages.length < 2) {
        setKeywordCookSuggestions(id, '');
        const comments = pages.reduce((n, p) => n + p.experiences.length, 0);
        return redirect(reply, `/keywords/${id}`, { kind: 'warn', message: `Found reader comments on only ${pages.length} page(s) (${comments} comment(s)); at least 2 pages are needed to suggest anything. Many recipe sites block automated reading.` });
      }
      const answer = await askPrompt(settings, encryptionKey, 'cook-suggestions', {
        title,
        recipe: (keyword.cook_recipe ?? '').trim()
          || `(No written recipe yet. Judge fit against the classic home version of ${title}${keyword.spy_description ? ` — ${keyword.spy_description}` : ''}.)`,
        notes: (keyword.cook_notes ?? '').trim() || '(none yet)',
        experiences: experiencesForPrompt(pages),
      });
      const report = emptyReport();
      const picked = pickSuggestions(tryParseJson(answer.content)?.value, pages.length, keyword.cook_notes ?? '', report);
      setKeywordCookSuggestions(id, picked.length ? JSON.stringify(picked) : '');
      const summary = describeRun(pages, report, picked.length);
      return redirect(reply, `/keywords/${id}`, picked.length
        ? { kind: 'ok', message: `${summary} Approve only what is true in your kitchen.` }
        : { kind: 'warn', message: summary });
    } catch (err) {
      return redirect(reply, `/keywords/${id}`, { kind: 'error', message: `Could not suggest tips: ${errorMessage(err)}` });
    }
  });

  app.post('/keywords/:id/cook/suggest/:index/:verdict', async (request, reply) => {
    const params = request.params as { id: string; index: string; verdict: string };
    const id = asNumber(params.id, 0);
    const keyword = getKeyword(id);
    if (!keyword) return redirect(reply, '/keywords', { kind: 'error', message: 'Keyword not found' });

    const list = readSuggestions(keyword.cook_suggestions);
    const index = asNumber(params.index, -1);
    const chosen = list[index];
    if (chosen) {
      if (params.verdict === 'accept') appendKeywordCookNote(id, chosen.tip);
      list.splice(index, 1);
      setKeywordCookSuggestions(id, list.length ? JSON.stringify(list) : '');
    }
    return redirect(reply, `/keywords/${id}#cook`);
  });

  app.post('/keywords/:id/link', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const body = formBody(request);
    const siteId = asNumber(body.site_id, 0);
    const status = asString(body.status, 'no');

    if (siteId && (status === 'go' || status === 'done' || status === 'no')) {
      setLink(id, siteId, status);
      // An unchecked checkbox submits nothing at all, so absence means off.
      setLinkShareImages(id, siteId, body.share_images === '1');
    }
    return redirect(reply, `/keywords/${id}`);
  });

  /* -- CSV templates ------------------------------------------------------ */

  /** Byte order mark, so Excel reads the file as UTF-8. */
  const BOM = '﻿';

  const csvCell = (value: string): string =>
    /["\r\n,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const csvFile = (reply: FastifyReply, filename: string, rows: string[][]): FastifyReply =>
    reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      // A BOM makes Excel open UTF-8 correctly instead of mangling accents.
      // CRLF line endings for the same reason.
      .send(BOM + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');

  app.get('/keywords/template.csv', async (_request, reply) => {
    const domains = listSites().map((s) => s.domain);
    const headers = [
      'seed_keyword', 'spy_title', 'spy_description', 'annotation', 'status', ...domains,
    ];

    const example = (
      keyword: string,
      title: string,
      status: string,
      per: (i: number) => string,
    ): string[] => [
      keyword, title, 'Short description of the source article.',
      'Comma, separated, pinterest, annotations', status,
      ...domains.map((_, i) => per(i)),
    ];

    return csvFile(reply, 'keywords-template.csv', [
      headers,
      example('Chicken Breast Recipe', 'Oven Baked Chicken Breast', 'go', (i) => (i === 0 ? 'go' : 'no')),
      example('Slow Cooker Beef', 'Slow Cooker Beef Stew', 'go', () => 'go'),
      example('Already Published', 'A keyword that is finished', 'done', () => 'done'),
    ]);
  });

  app.get('/sites/template.csv', async (_request, reply) =>
    csvFile(reply, 'sites-template.csv', [
      ['name', 'domain', 'status', 'daily_target', 'interval_minutes', 'pin_username',
        'project_id', 'auto_publish', 'paused_reason', 'api_token', 'buffer_token'],
      ['bitespoon', 'bitespoon.com', 'active', '3', '480', 'cookwithbitespoon', '',
        'yes', '', 'paste-the-site-token', 'paste-the-buffer-token'],
      ['longlivo', 'longlivo.com', 'paused', '0', '480', 'prepplat', '',
        'no', 'waiting on their API', '', ''],
    ]),
  );

  /* -- Exports ------------------------------------------------------------ */

  app.get('/data/export/:dataset', async (request, reply) => {
    const name = asString((request.params as { dataset: string }).dataset) as Dataset;
    if (!DATASETS.includes(name)) return reply.callNotFound();

    const data = exportDataset(name);
    return csvFile(reply, data.filename, data.rows);
  });

  /* -- Prompts ----------------------------------------------------------- */

  /**
   * Editing the prompts is editing the product, so it gets a real page rather
   * than a note telling someone to rebuild the image.
   */
  const promptFile = (name: string): string | null => {
    // Only files that actually ship. Without this the name is a path fragment
    // reaching anywhere on disk.
    const allowed = listPromptFiles().map((p) => p.file);
    return allowed.includes(name) ? name : null;
  };

  /**
   * The rows of a "save all" page.
   *
   * Every card contributes one value to each field, in document order, so the
   * arrays line up by position — except the checkboxes, which a browser only
   * submits when ticked. Those carry the row's own id as their value instead
   * of "1", so "which are on" is a set of ids rather than a column that
   * silently shifts up whenever one is unticked. That shift is the bug this
   * shape exists to make impossible.
   */
  const savedRows = (request: FastifyRequest, fields: string[]): { id: number; enabled: boolean; values: Record<string, string> }[] => {
    const body = formBody(request);
    const column = (key: string): string[] => ([] as unknown[]).concat(body[key] ?? []).map((v) => asString(v));
    const ids = column('id').map((v) => Number(v) || 0);
    const on = new Set(column('enabled'));
    const columns = Object.fromEntries(fields.map((f) => [f, column(f)]));

    return ids.map((id, i) => ({
      id,
      enabled: on.has(String(id)),
      values: Object.fromEntries(fields.map((f) => [f, (columns[f]![i] ?? '').trim()])),
    })).filter((row) => row.id > 0);
  };

  /* -- Setup -> Pin designs ------------------------------------------------ */

  app.get('/settings/pin-designs', async (request, reply) => {
    const designs = listPinDesigns();
    const problems: Record<number, string[]> = {};
    for (const d of designs) problems[d.id] = designProblems(d.body);
    return page(reply, 'Pin designs', '/settings/pin-designs', pinDesignsPage(designs, pinDesignUses(), problems), readFlash(request.query));
  });

  app.post('/settings/pin-designs/add', async (request, reply) => {
    const body = formBody(request);
    const name = asString(body.name).trim().slice(0, 80);
    const text = asString(body.body).trim();
    if (!name || !text) return redirect(reply, '/settings/pin-designs', { kind: 'error', message: 'A design needs a name and a text.' });
    const missing = designProblems(text);
    addPinDesign(name, text);
    return redirect(reply, '/settings/pin-designs', missing.length
      ? { kind: 'warn', message: `Added, but it is missing ${missing.join(', ')} and is skipped until those are in.` }
      : { kind: 'ok', message: 'Design added. It joins the rotation from the next pin.' });
  });

  app.post('/settings/pin-designs/save', async (request, reply) => {
    const rows = savedRows(request, ['name', 'body']);
    const blank = rows.find((r) => !r.values.name || !r.values.body);
    if (blank) return redirect(reply, '/settings/pin-designs', { kind: 'error', message: 'Every design needs a name and a text; nothing was saved.' });

    for (const row of rows) {
      savePinDesign(row.id, { name: row.values.name!.slice(0, 80), body: row.values.body!, enabled: row.enabled });
    }
    const broken = rows.filter((r) => designProblems(r.values.body!).length).length;
    return redirect(reply, '/settings/pin-designs', broken
      ? { kind: 'warn', message: `${rows.length} design(s) saved. ${broken} of them is missing one of the three fields and is skipped until it is added back.` }
      : { kind: 'ok', message: `${rows.length} design(s) saved.` });
  });

  app.post('/settings/pin-designs/:id/delete', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    if (listPinDesigns().length <= 1) {
      return redirect(reply, '/settings/pin-designs', { kind: 'error', message: 'Keep at least one design; switch it off instead.' });
    }
    deletePinDesign(id);
    return redirect(reply, '/settings/pin-designs', { kind: 'ok', message: 'Design deleted.' });
  });

  /* -- Setup -> Photo styles ----------------------------------------------- */

  app.get('/settings/photo-styles', async (request, reply) =>
    page(reply, 'Photo styles', '/settings/photo-styles', photoStylesPage(listPhotoStyles(), photoStyleUses()), readFlash(request.query)));

  app.post('/settings/photo-styles/add', async (request, reply) => {
    const body = formBody(request);
    const name = asString(body.name).trim().slice(0, 80);
    const text = asString(body.body).trim();
    if (!name || !text) return redirect(reply, '/settings/photo-styles', { kind: 'error', message: 'A style needs a name and a shoot.' });
    addPhotoStyle(name, text);
    return redirect(reply, '/settings/photo-styles', { kind: 'ok', message: 'Style added. It joins the rotation from the next recipe.' });
  });

  app.post('/settings/photo-styles/save', async (request, reply) => {
    const rows = savedRows(request, ['name', 'body']);
    if (rows.some((r) => !r.values.name || !r.values.body)) {
      return redirect(reply, '/settings/photo-styles', { kind: 'error', message: 'Every style needs a name and a shoot; nothing was saved.' });
    }
    for (const row of rows) {
      savePhotoStyle(row.id, { name: row.values.name!.slice(0, 80), body: row.values.body!, enabled: row.enabled });
    }
    return redirect(reply, '/settings/photo-styles', { kind: 'ok', message: `${rows.length} style(s) saved.` });
  });

  app.post('/settings/photo-styles/:id/delete', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    // Unlike pin designs, none left is a real setting: the AI goes back to
    // choosing a look per recipe, which is what it did before this page.
    deletePhotoStyle(id);
    return redirect(reply, '/settings/photo-styles', { kind: 'ok', message: 'Style deleted.' });
  });

  /* -- Setup -> Article structures ----------------------------------------- */

  app.get('/settings/article-structures', async (request, reply) =>
    page(reply, 'Article structures', '/settings/article-structures',
      articleStructuresPage(listArticleStructures(), articleStructureUses()), readFlash(request.query)));

  app.post('/settings/article-structures/add', async (request, reply) => {
    const body = formBody(request);
    const name = asString(body.name).trim().slice(0, 80);
    const intro = asString(body.intro).trim();
    const sections = asString(body.sections).trim();
    if (!name || !intro || !sections) {
      return redirect(reply, '/settings/article-structures', { kind: 'error', message: 'A structure needs a name, an introduction and an after-the-card shape.' });
    }
    addArticleStructure(name, intro, sections);
    return redirect(reply, '/settings/article-structures', { kind: 'ok', message: 'Structure added. It joins the rotation from the next article.' });
  });

  app.post('/settings/article-structures/save', async (request, reply) => {
    const rows = savedRows(request, ['name', 'intro', 'sections']);
    if (rows.some((r) => !r.values.name || !r.values.intro || !r.values.sections)) {
      return redirect(reply, '/settings/article-structures', {
        kind: 'error',
        message: 'Every structure needs a name, an introduction and an after-the-card shape; nothing was saved.',
      });
    }
    for (const row of rows) {
      saveArticleStructure(row.id, {
        name: row.values.name!.slice(0, 80),
        intro: row.values.intro!,
        sections: row.values.sections!,
        enabled: row.enabled,
      });
    }
    return redirect(reply, '/settings/article-structures', { kind: 'ok', message: `${rows.length} structure(s) saved.` });
  });

  app.post('/settings/article-structures/:id/delete', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    deleteArticleStructure(id);
    return redirect(reply, '/settings/article-structures', { kind: 'ok', message: 'Structure deleted.' });
  });

  /* -- Setup -> Blog structures -------------------------------------------- */

  app.get('/settings/blog-structures', async (request, reply) =>
    page(reply, 'Blog structures', '/settings/blog-structures',
      blogStructuresPage(listBlogStructures(), blogStructureUses()), readFlash(request.query)));

  app.post('/settings/blog-structures/add', async (request, reply) => {
    const body = formBody(request);
    const name = asString(body.name).trim().slice(0, 80);
    const text = asString(body.body).trim();
    if (!name || !text) return redirect(reply, '/settings/blog-structures', { kind: 'error', message: 'A structure needs a name and a shape.' });
    addBlogStructure(name, text);
    return redirect(reply, '/settings/blog-structures', { kind: 'ok', message: 'Structure added. It joins the rotation from the next article.' });
  });

  app.post('/settings/blog-structures/save', async (request, reply) => {
    const rows = savedRows(request, ['name', 'body']);
    if (rows.some((r) => !r.values.name || !r.values.body)) {
      return redirect(reply, '/settings/blog-structures', { kind: 'error', message: 'Every structure needs a name and a shape; nothing was saved.' });
    }
    for (const row of rows) {
      saveBlogStructure(row.id, { name: row.values.name!.slice(0, 80), body: row.values.body!, enabled: row.enabled });
    }
    return redirect(reply, '/settings/blog-structures', { kind: 'ok', message: `${rows.length} structure(s) saved.` });
  });

  app.post('/settings/blog-structures/:id/delete', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    deleteBlogStructure(id);
    return redirect(reply, '/settings/blog-structures', { kind: 'ok', message: 'Structure deleted.' });
  });

  /* -- Setup -> Caption structures ----------------------------------------- */

  /** The caption prompt as it is now: the person's edit if there is one, else the shipped file. */
  const CAPTION_PROMPT = 'reel-caption.user.txt';
  const captionPrompt = () => {
    const shipped = readShippedPrompt(CAPTION_PROMPT);
    const override = getPromptOverride(CAPTION_PROMPT);
    return { shipped, current: override ?? shipped, edited: override !== undefined && override !== shipped };
  };

  /** Which site a caption page request is about: 0 is the default every site follows. */
  const captionSite = (value: unknown): number => {
    const id = asNumber(value, 0);
    return id > 0 && getSite(id) ? id : 0;
  };
  const captionBack = (site: number) => `/settings/caption-structures${site ? `?site=${site}` : ''}`;

  app.get('/settings/caption-structures', async (request, reply) => {
    const prompt = captionPrompt();
    const site = captionSite((request.query as { site?: string }).site);
    const custom = site > 0 && isCaptionCustom(site);
    // What the page shows: the site's own values when it has them, the default otherwise.
    const view = custom ? withSiteOverrides(settings, site) : settings;
    const linkChoice = view.get('caption_extra_link');
    return page(reply, 'Caption structures', '/settings/caption-structures',
      captionStructuresPage(
        listCaptionStructures(site || undefined),
        captionStructureUses(),
        parseCaptionNetworks(view.get('caption_networks')),
        {
          template: prompt.current,
          templateEdited: prompt.edited,
          facebookLink: parseFacebookLinkMode(view.get('caption_fb_link')),
          facebookRecipe: parseRecipeInPost(view.get('caption_fb_recipe')),
          youtubeRecipe: parseRecipeInPost(view.get('caption_yt_recipe')),
          photoFacebookRecipe: parseRecipeInPost(view.get('caption_fb_post_recipe')),
          photoFacebookLink: parseFacebookLinkMode(view.get('caption_fb_post_link')),
          photoInstagramRecipe: parseRecipeInPost(view.get('caption_ig_post_recipe')),
          photoPinterestRecipe: parseRecipeInPost(view.get('caption_pin_recipe')),
          instagramRecipe: parseRecipeInPost(view.get('caption_ig_recipe')),
          tiktokRecipe: parseRecipeInPost(view.get('caption_tt_recipe')),
          youtubeRecipeLine: view.getBool('caption_yt_link_recipe'),
          youtubeSiteLine: view.getBool('caption_yt_link_site'),
          extraLink: linkChoice === 'yes' || linkChoice === 'no' ? linkChoice : 'setup',
          site,
          sites: listSites().map((x) => ({ id: x.id, domain: x.domain, custom: isCaptionCustom(x.id) })),
          custom,
        },
      ),
      readFlash(request.query));
  });

  app.post('/settings/caption-structures/customize', async (request, reply) => {
    const site = captionSite(formBody(request).site);
    if (site) customizeCaption(site, settings);
    return redirect(reply, captionBack(site), { kind: 'ok', message: 'This site now has caption settings of its own, starting from a copy of the default.' });
  });

  app.post('/settings/caption-structures/default', async (request, reply) => {
    const site = captionSite(formBody(request).site);
    if (site) resetCaption(site);
    return redirect(reply, captionBack(site), { kind: 'ok', message: 'This site follows the default again. Its own shapes and settings were removed.' });
  });

  // Back to the shipped prompt. The page's other fields are not saved by this.
  app.post('/settings/caption-structures/template/reset', async (_request, reply) => {
    if (getPromptOverride(CAPTION_PROMPT) !== undefined) {
      savePromptVersion(CAPTION_PROMPT, getPromptOverride(CAPTION_PROMPT)!);
      deletePromptOverride(CAPTION_PROMPT);
      invalidatePromptCache();
    }
    return redirect(reply, '/settings/caption-structures', { kind: 'ok', message: 'The shipped caption prompt is back.' });
  });

  app.post('/settings/caption-structures/save', async (request, reply) => {
    const form = formBody(request);
    const site = captionSite(form.site);
    const back = captionBack(site);
    if (site && !isCaptionCustom(site)) {
      return redirect(reply, back, { kind: 'error', message: 'This site follows the default. Customize it first; nothing was saved.' });
    }
    const rows = savedRows(request, ['name', 'body']);
    if (rows.some((r) => !r.values.name || !r.values.body)) {
      return redirect(reply, back, { kind: 'error', message: 'Every structure needs a name and a shape; nothing was saved.' });
    }
    // The prompt the shapes are slotted into is shared by every site; only the default page edits it.
    // Without {{captionShape}} the rotation would still run and change nothing, so refuse that
    // rather than save it. A browser sends a textarea's line breaks as CRLF; compared as sent,
    // an untouched prompt would look edited on every save.
    const template = site ? '' : asString(form.template).replace(/\r\n?/g, '\n');
    if (template.trim() !== '' && !/\{\{\s*captionShape\s*\}\}/.test(template)) {
      return redirect(reply, back, { kind: 'error', message: 'The prompt must contain {{captionShape}}, where the chosen structure goes; nothing was saved.' });
    }
    for (const row of rows) {
      saveCaptionStructure(row.id, { name: row.values.name!.slice(0, 80), body: row.values.body!, enabled: row.enabled });
    }
    // Only a real change becomes an override: saving the shipped text back
    // unchanged would freeze it, and a later improvement to the shipped file
    // would never reach this install.
    const prompt = captionPrompt();
    if (template.trim() !== '' && template !== prompt.current) {
      savePromptVersion(CAPTION_PROMPT, prompt.current);
      setPromptOverride(CAPTION_PROMPT, template);
      invalidatePromptCache();
    }

    // Everything below goes to the site's own settings when this is a site's page, to the shared ones otherwise.
    const put = (key: string, value: string) => (site ? setSiteCaptionSetting(site, key, value) : settings.set(key, value));

    // The networks ride on the same button. Unticked boxes submit nothing, so an
    // empty list means every box was cleared, not that the field was missing:
    // this form always carries all of them.
    const chosen = ([] as unknown[]).concat(form.network ?? []).map((v) => asString(v));
    put('caption_networks', serializeCaptionNetworks(chosen));
    const networks = parseCaptionNetworks(serializeCaptionNetworks(chosen));

    // So do Facebook's recipe and link, and YouTube's two lines. Stored as
    // words, never empty: Settings.get falls back to the default for an empty
    // value, which would turn "no link" back into "link in the post".
    put('caption_fb_recipe', parseRecipeInPost(asString(form.fb_recipe)));
    put('caption_fb_post_recipe', parseRecipeInPost(asString(form.fbp_recipe)));
    put('caption_fb_post_link', parseFacebookLinkMode(asString(form.fbp_link)));
    put('caption_ig_post_recipe', parseRecipeInPost(asString(form.igp_recipe)));
    put('caption_pin_recipe', parseRecipeInPost(asString(form.pin_recipe)));
    put('caption_yt_recipe', parseRecipeInPost(asString(form.yt_recipe)));
    put('caption_ig_recipe', parseRecipeInPost(asString(form.ig_recipe)));
    put('caption_tt_recipe', parseRecipeInPost(asString(form.tt_recipe)));
    put('caption_fb_link', parseFacebookLinkMode(asString(form.fb_link)));
    put('caption_yt_link_recipe', 'yt_link_recipe' in form ? 'true' : 'false');
    put('caption_yt_link_site', 'yt_link_site' in form ? 'true' : 'false');
    const extra = asString(form.extra_link);
    put('caption_extra_link', extra === 'yes' || extra === 'no' ? extra : 'setup');

    return redirect(reply, back, {
      kind: 'ok',
      message: networks.size > 0
        ? `${rows.length} structure(s) saved. The written caption goes to ${[...networks].map((n) => CAPTION_NETWORK_LABELS[n].name).join(', ')}.`
        : `${rows.length} structure(s) saved. No network uses the written caption, so reels go out with their title and link.`,
    });
  });

  app.post('/settings/caption-structures/add', async (request, reply) => {
    const body = formBody(request);
    const site = captionSite(body.site);
    const back = captionBack(site);
    if (site && !isCaptionCustom(site)) return redirect(reply, back, { kind: 'error', message: 'This site follows the default. Customize it first.' });
    const name = asString(body.name).trim().slice(0, 80);
    const text = asString(body.body).trim();
    if (!name || !text) return redirect(reply, back, { kind: 'error', message: 'A structure needs a name and a shape.' });
    addCaptionStructure(name, text, site || undefined);
    return redirect(reply, back, { kind: 'ok', message: 'Structure added. It joins the rotation from the next reel.' });
  });

  app.post('/settings/caption-structures/:id/delete', async (request, reply) => {
    const site = captionSite((request.query as { site?: string }).site);
    deleteCaptionStructure(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, captionBack(site), { kind: 'ok', message: 'Structure deleted.' });
  });

  /* -- Setup -> Reel structures -------------------------------------------- */

  app.get('/settings/reel-structures', async (request, reply) =>
    page(reply, 'Reel structures', '/settings/reel-structures',
      reelStructuresPage(listReelStructures(), reelStructureUses(), {
        mode: reelMode(settings),
        templateEdited: templateIgnoresStructures(),
      }),
      readFlash(request.query)));

  app.post('/settings/reel-structures/save', async (request, reply) => {
    const rows = savedRows(request, ['name', 'body']);
    if (rows.some((r) => !r.values.name || !r.values.body)) {
      return redirect(reply, '/settings/reel-structures', { kind: 'error', message: 'Every structure needs a name and its scenes; nothing was saved.' });
    }
    for (const row of rows) {
      saveReelStructure(row.id, { name: row.values.name!.slice(0, 80), body: row.values.body!, enabled: row.enabled });
    }
    return redirect(reply, '/settings/reel-structures', { kind: 'ok', message: `${rows.length} structure(s) saved.` });
  });

  app.post('/settings/reel-structures/add', async (request, reply) => {
    const body = formBody(request);
    const name = asString(body.name).trim().slice(0, 80);
    const text = asString(body.body).trim();
    if (!name || !text) return redirect(reply, '/settings/reel-structures', { kind: 'error', message: 'A structure needs a name and its scenes.' });
    addReelStructure(name, text);
    return redirect(reply, '/settings/reel-structures', { kind: 'ok', message: 'Structure added. It joins the rotation from the next reel.' });
  });

  app.post('/settings/reel-structures/:id/delete', async (request, reply) => {
    deleteReelStructure(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/settings/reel-structures', { kind: 'ok', message: 'Structure deleted.' });
  });

  app.get('/settings/prompts', async (request, reply) =>
    page(
      reply,
      'Prompts',
      '/settings',
      promptsPage(listPromptFiles(), modelChoices(), KNOWN_MODELS),
      readFlash(request.query),
    ),
  );

  /**
   * Point one prompt at a different model.
   *
   * Blank puts it back on the shipped default rather than storing an empty
   * string, so "undo" is the same gesture as "leave it alone".
   */
  app.post('/settings/prompts/model', async (request, reply) => {
    const body = formBody(request);
    const prompt = asString(body.prompt).trim();
    const model = asString(body.model).trim();

    if (!PROMPT_MODELS[prompt]) {
      return redirect(reply, '/settings/prompts', {
        kind: 'error',
        message: `There is no prompt called "${prompt}".`,
      });
    }

    setModelOverride(prompt, model);
    invalidatePromptCache();

    return redirect(reply, '/settings/prompts', {
      kind: 'ok',
      message: model
        ? `"${prompt}" now goes to ${model}. It applies to the next run.`
        : `"${prompt}" is back on its shipped model, ${PROMPT_MODELS[prompt].model}.`,
    });
  });

  /** Put an earlier version of a prompt back, as a new save. */
  app.post('/settings/prompts/:file/restore', async (request, reply) => {
    const file = promptFile(asString((request.params as { file: string }).file));
    if (!file) {
      return redirect(reply, '/settings/prompts', {
        kind: 'error',
        message: 'No such prompt file.',
      });
    }

    const version = getPromptVersion(asNumber(formBody(request).version, 0));
    if (!version || version.name !== file) {
      return redirect(reply, `/settings/prompts/${file}`, {
        kind: 'error',
        message: 'That version is not one of this prompt&#39;s.',
      });
    }

    // Saved as a new version rather than rewinding, so restoring is itself
    // undoable — going back should never destroy what you were on.
    savePromptVersion(file, getPromptOverride(file) ?? readShippedPrompt(file));
    setPromptOverride(file, version.body);
    invalidatePromptCache();

    return redirect(reply, `/settings/prompts/${file}`, {
      kind: 'ok',
      message: `Restored the version saved ${version.created_at}. The one it replaced is still in the list.`,
    });
  });

  app.get('/settings/prompts/:file', async (request, reply) => {
    const file = promptFile(asString((request.params as { file: string }).file));
    if (!file) {
      return redirect(reply, '/settings/prompts', { kind: 'error', message: 'No such prompt file.' });
    }

    const override = getPromptOverride(file);
    const shipped = readShippedPrompt(file);
    const body = override ?? shipped;
    const promptName = file.replace(/\.(system|user)\.txt$/, '').replace(/\.txt$/, '');

    return page(
      reply,
      file,
      '/settings',
      promptEditPage(file, body, {
        model: modelFor(promptName),
        variables: variablesFor(promptName),
        unknown: unknownVariables(promptName, body),
        edited: override !== undefined,
        shipped,
        versions: listPromptVersions(file),
      }),
      readFlash(request.query),
    );
  });

  app.post('/settings/prompts/:file', async (request, reply) => {
    const file = promptFile(asString((request.params as { file: string }).file));
    if (!file) {
      return redirect(reply, '/settings/prompts', { kind: 'error', message: 'No such prompt file.' });
    }

    const body = formBody(request);

    if (asString(body.action) === 'revert') {
      deletePromptOverride(file);
      invalidatePromptCache();
      return redirect(reply, `/settings/prompts/${file}`, {
        kind: 'ok',
        message: 'Reverted to the shipped prompt.',
      });
    }

    const text = asString(body.body);
    if (text.trim() === '') {
      return redirect(reply, `/settings/prompts/${file}`, {
        kind: 'error',
        message: 'An empty prompt would silently produce nothing. Revert instead if that is what you want.',
      });
    }

    // The version *before* this edit, so the list is "what I could go back
    // to" rather than "what I have already got".
    savePromptVersion(file, getPromptOverride(file) ?? readShippedPrompt(file));
    setPromptOverride(file, text);
    invalidatePromptCache();

    const promptName = file.replace(/\.(system|user)\.txt$/, '').replace(/\.txt$/, '');
    const unknown = unknownVariables(promptName, text);

    return redirect(reply, `/settings/prompts/${file}`, {
      kind: unknown.length ? 'warn' : 'ok',
      message: unknown.length
        ? `Saved, but ${unknown.join(', ')} is not supplied by any step and will render empty.`
        : 'Saved. It applies to the next run.',
    });
  });

  /* -- Decisions --------------------------------------------------------- */

  // It is a section of the dashboard now. Kept as a redirect because it was a
  // page for long enough to be bookmarked.

  /* -- Events ------------------------------------------------------------ */

  app.get('/events', async (request, reply) =>
    page(reply, 'Events', '/events', eventsPage(listEvents(200)), readFlash(request.query)),
  );

  app.post('/history/clear', async (_request, reply) => {
    const { runs, reels } = clearHistory();
    return redirect(reply, '/', { kind: 'ok', message: `History cleared: ${runs} article run${runs === 1 ? '' : 's'} and ${reels} reel${reels === 1 ? '' : 's'}.` });
  });

  app.post('/events/clear', async (request, reply) => {
    const only = asString(formBody(request).level);
    const removed = only === 'problems' ? clearEvents('warn') + clearEvents('error') : clearEvents();
    return redirect(reply, '/events', { kind: 'ok', message: `${removed} event${removed === 1 ? '' : 's'} deleted from the log.` });
  });

  /* -- Settings ---------------------------------------------------------- */

  /**
   * The image service's own health, refreshed in the background.
   *
   * Checked off the request path on purpose: the dashboard should not wait on
   * a container that might be restarting, and Chrome takes about a minute to
   * come up. Stale by up to a minute is the right trade for a page that always
   * renders.
   */
  let imageServiceProblem: string | null = null;
  let extensionMissingPolls = 0;

  /**
   * Ask the image service whether it accepts the settings as they now stand.
   *
   * Deliberately reports the key being wrong differently from the service being
   * down: one is something you just did, the other is something that happened
   * to you.
   */
  const checkImageService = async (): Promise<{ ok: boolean; detail: string }> => {
    const base = settings.get('image_base_url').replace(/\/+$/, '');
    if (!base) return { ok: false, detail: 'no image service URL is set' };

    try {
      const response = await fetch(`${base}/flow/status`, {
        headers: { 'X-API-Key': settings.get('image_api_key') },
        signal: AbortSignal.timeout(8_000),
      });

      if (response.status === 401) {
        return {
          ok: false,
          detail:
            'the API key was rejected. It has to match IMAGE_API_KEY in the deployment ' +
            'environment — changing it here alone is not enough.',
        };
      }
      if (!response.ok) return { ok: false, detail: `it answered HTTP ${response.status}` };
      return { ok: true, detail: 'accepted' };
    } catch (err) {
      return { ok: false, detail: `it could not be reached (${errorMessage(err)})` };
    }
  };

  let imageModelCatalogue: ImageModelCatalogue | null = null;

  const refreshImageServiceHealth = async (): Promise<void> => {
    const base = settings.get('image_base_url').replace(/\/+$/, '');
    if (!base) return;

    try {
      const response = await fetch(`${base}/flow/status`, {
        headers: { 'X-API-Key': settings.get('image_api_key') },
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        imageServiceProblem = `Image service answered HTTP ${response.status} — check it is running.`;
        return;
      }

      const status = (await response.json()) as FlowStatus;
      // /health is where the watchdog says a sign-in wall is up. Best effort:
      // without it, only what /flow/status says is judged.
      let health: ServiceHealth | null = null;
      try {
        const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
        if (h.ok) health = (await h.json()) as ServiceHealth;
      } catch {
        // Judged from status alone.
      }
      const chromeUp = status.chrome?.wanted_running ?? status.chrome?.always_on ?? true;
      extensionMissingPolls = !status.connected && chromeUp ? extensionMissingPolls + 1 : 0;
      imageServiceProblem = imageServiceProblemFrom(status, health, extensionMissingPolls);

      // The model catalogue rides on the same poll, so the Settings page reads
      // it from memory and never waits on the image service to render. It did
      // once, for the caption, and the page sat behind a dead service until
      // Cloudflare gave up. Best effort: a poll that cannot fetch it keeps the
      // last one it had.
      try {
        const models = await fetch(`${base}/flow/image-models`, {
          headers: { 'X-API-Key': settings.get('image_api_key') },
          signal: AbortSignal.timeout(5_000),
        });
        if (models.ok) imageModelCatalogue = (await models.json()) as ImageModelCatalogue;
      } catch {
        // Keep whatever was cached.
      }
    } catch {
      imageServiceProblem =
        'Image service unreachable — no images can be generated until it is back.';
    } finally {
      // The scheduler notifies on this but must not poll it: a second poller
      // would double the traffic to a container that is, by definition,
      // already having a hard time.
      setImageServiceProblem(imageServiceProblem);
    }
  };

  void refreshImageServiceHealth();
  const healthTimer = setInterval(() => void refreshImageServiceHealth(), 60_000);
  healthTimer.unref();

  /**
   * Configuration problems, including ones that live outside the settings
   * table: no API keys, or sites missing their own credentials.
   */
  const problemsWithPlaces = (s: Settings): Attention[] => {
    // Each problem says where it is fixed, so Home can offer the button.
    const problems: Attention[] = s
      .validate()
      .map((text) => ({ kind: 'warn', text, href: '/settings', action: 'Settings' }));

    if (listEndpoints(encryptionKey).filter((e) => e.enabled).length === 0) {
      problems.push({
        kind: 'warn',
        text: 'No LLM API keys added — nothing can be generated.',
        href: '/settings/keys',
        action: 'Add a key',
      });
    }

    if (imageServiceProblem) {
      const needsSignIn = /signed out|Browser page/i.test(imageServiceProblem);
      problems.push({
        kind: 'warn',
        text: imageServiceProblem,
        href: needsSignIn ? '/browser' : '/settings',
        action: needsSignIn ? 'Sign in' : 'Check',
        external: needsSignIn,
      });
    }

    // Social-only accounts' pictures are served from this platform's own address.
    if (listSites().some((site) => site.status === 'active' && isSocialOnly(site)) && !settings.get('public_url').trim()) {
      problems.push({
        kind: 'warn',
        text: 'A social-only account is active, but Setup → General → "Public address of this platform" is empty, so its pictures have nowhere to be served from.',
        href: '/settings',
        action: 'Setup',
      });
    }

    const supplyProblem = supplyWarning(readSupply());
    if (supplyProblem) {
      problems.push({ kind: 'warn', text: supplyProblem, href: '/keywords', action: 'Keywords' });
    }

    const sitesMissingToken = listSites()
      .filter((site) => site.status === 'active' && !isSocialOnly(site) && !site.api_token_encrypted.trim())
      .map((site) => site.domain);
    if (sitesMissingToken.length > 0) {
      problems.push({
        kind: 'warn',
        text: `Active site(s) without an API token: ${sitesMissingToken.join(', ')}.`,
        href: '/sites',
        action: 'Sites',
      });
    }

    return problems;
  };

  const problemsFor = (s: Settings): string[] => problemsWithPlaces(s).map((p) => p.text);

  app.get('/settings', async (request, reply) => {
    const values = new Map(SETTING_SPECS.map((s) => [s.key, settings.get(s.key)] as const));
    return page(
      reply,
      'Settings',
      '/settings',
      settingsPage(SETTING_SPECS, values, problemsFor(settings), imageModelCatalogue),
      readFlash(request.query),
    );
  });

  app.get('/settings/keys', async (request, reply) =>
    page(
      reply,
      'LLM API keys',
      '/settings',
      keysPage(
        listEndpoints(encryptionKey, settings.get('llm_base_url')),
        settings.get('llm_base_url'),
      ),
      readFlash(request.query),
    ),
  );

  app.get('/settings/account', async (request, reply) =>
    page(
      reply,
      'Password',
      '/settings',
      accountPage(auth.generated && !storedPasswordHash(encryptionKey)),
      readFlash(request.query),
    ),
  );

  app.post('/settings/account', async (request, reply) => {
    const body = formBody(request);
    const current = asString(body.current);
    const next = asString(body.next);
    const confirm = asString(body.confirm);

    const fail = (message: string): FastifyReply =>
      redirect(reply, '/settings/account', { kind: 'error', message });

    // Checked even though the caller already holds a session: a session that
    // was left open on a shared machine should not be able to lock the owner
    // out of their own platform.
    if (!passwordAccepted(current, auth)) {
      await new Promise((r) => setTimeout(r, 400));
      return fail('That is not the current password.');
    }

    const reason = rejectionReason(next, confirm);
    if (reason) return fail(reason);

    storePassword(next, encryptionKey);
    log.info('admin password changed');

    return redirect(reply, '/settings/account', {
      kind: 'ok',
      message: 'Password changed. It applies to the next sign-in; this session stays open.',
    });
  });

  /**
   * Add several keys at once.
   *
   * Pasting twenty keys one form at a time is the kind of chore that ends with
   * someone giving up at six, so the whole point is that the input is whatever
   * the provider's dashboard put on the clipboard.
   */
  app.post('/settings/endpoints/bulk', async (request, reply) => {
    const text = asString(formBody(request).keys);

    const existing = listEndpoints(encryptionKey);
    const takenNames = new Set(existing.map((e) => e.name.toLowerCase()));
    const seenKeys = new Set<string>();

    let counter = 0;
    const nextName = (): string => {
      // Continue the numbering rather than restarting it, so a second paste
      // does not collide with the first and silently replace those keys.
      let candidate: string;
      do {
        counter += 1;
        candidate = `key-${String(counter).padStart(2, '0')}`;
      } while (takenNames.has(candidate));
      takenNames.add(candidate);
      return candidate;
    };

    let added = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const [index, rawLine] of text.split('\n').entries()) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;

      // "label = key", "label, key", or a bare key.
      const separated = /^(.+?)\s*[=,]\s*(.+)$/.exec(line);
      const name = separated ? separated[1]!.trim() : '';
      const apiKey = (separated ? separated[2]! : line).trim();

      if (!apiKey) continue;
      if (seenKeys.has(apiKey)) {
        skipped += 1;
        continue;
      }
      seenKeys.add(apiKey);

      try {
        upsertEndpoint(
          { name: name || nextName(), baseUrl: '', apiKey, models: [], enabled: true },
          encryptionKey,
        );
        added += 1;
      } catch (err) {
        errors.push(`line ${index + 1}: ${errorMessage(err)}`);
      }
    }

    if (added === 0 && errors.length === 0) {
      return redirect(reply, '/settings/keys', {
        kind: 'warn',
        message: 'Nothing to add — no keys found in that text.',
      });
    }

    const parts = [`Added ${added} key(s).`];
    if (skipped) parts.push(`${skipped} duplicate(s) skipped.`);
    if (errors.length) parts.push(`Failed: ${errors.slice(0, 3).join('; ')}`);

    return redirect(reply, '/settings/keys', {
      kind: errors.length ? 'warn' : 'ok',
      message: parts.join(' '),
    });
  });

  /* -- Serper keys: stored together, shown one per row ---------------------- */
  const serperList = (): string[] => settings.get('serper_api_key').split(/[\s,;]+/).map((k) => k.trim()).filter(Boolean);
  const saveSerper = (keys: string[]) => settings.set('serper_api_key', keys.join('\n'));
  const addSerper = (text: unknown): number => {
    const keys = serperList();
    const fresh = asString(text).split(/[\s,;]+/).map((k) => k.trim()).filter((k) => k && !keys.includes(k));
    if (fresh.length) saveSerper([...keys, ...new Set(fresh)]);
    return new Set(fresh).size;
  };

  app.post('/settings/serper/add', async (request, reply) => {
    const added = addSerper(formBody(request).serper_new);
    return redirect(reply, '/settings', added
      ? { kind: 'ok', message: `${added} Serper key(s) added.` }
      : { kind: 'warn', message: 'No new key: the box was empty or the keys are already there.' });
  });

  app.post('/settings/serper/:i/remove', async (request, reply) => {
    const i = asNumber((request.params as { i: string }).i, -1);
    const keys = serperList();
    if (i < 0 || i >= keys.length) return redirect(reply, '/settings', { kind: 'error', message: 'Key not found.' });
    keys.splice(i, 1);
    saveSerper(keys);
    const active = Number(settings.get('serper_key_index')) || 0;
    if (i < active) settings.set('serper_key_index', String(active - 1));
    else if (active >= keys.length) settings.set('serper_key_index', '0');
    return redirect(reply, '/settings', { kind: 'ok', message: 'Serper key removed.' });
  });

  app.post('/settings/serper/:i/use', async (request, reply) => {
    const i = asNumber((request.params as { i: string }).i, -1);
    if (i < 0 || i >= serperList().length) return redirect(reply, '/settings', { kind: 'error', message: 'Key not found.' });
    settings.set('serper_key_index', String(i));
    return redirect(reply, '/settings', { kind: 'ok', message: `Serper key #${i + 1} is now in use.` });
  });

  app.post('/settings', async (request, reply) => {
    const body = formBody(request);
    // Keys pasted in the Serper box go in with the rest of the page.
    if (body.serper_new !== undefined) addSerper(body.serper_new);
    let imagesChanged = false;

    for (const spec of SETTING_SPECS) {
      const submitted = body[spec.key];
      if (submitted === undefined) continue;

      let value = asString(submitted).trim();
      // The detected address, sent back as the page showed it, stays automatic:
      // a later move to another domain then follows by itself.
      if (spec.key === 'public_url' && sameOrigin(value, getSetting(DETECTED_PUBLIC_URL, encryptionKey))) value = '';
      // A blank secret means "keep what is stored", not "erase it".
      if (spec.secret && value === '') continue;

      settings.set(spec.key, value);
      if (spec.group === 'images') imagesChanged = true;
    }

    // The rest after "unusual activity" is kept by the image service, which
    // does the rotating: hand it the new length.
    if (body.google_rest_hours !== undefined) {
      const hours = Number(asString(body.google_rest_hours).trim());
      if (Number.isFinite(hours) && hours >= 0) {
        try {
          const response = await imageService('/flow/accounts-rest', {
            method: 'PUT',
            body: JSON.stringify({ minutes: Math.round(hours * 60) }),
          });
          if (!response.ok) throw new Error(await imageServiceError(response));
        } catch (err) {
          return redirect(reply, '/settings', {
            kind: 'warn',
            message: `Settings saved, but the image service did not take the rest time: ${errorMessage(err)}`,
          });
        }
      }
    }

    if (!imagesChanged) {
      return redirect(reply, '/settings', { kind: 'ok', message: 'Settings saved.' });
    }

    // The image service checks the key against its own environment, so a key
    // changed here alone is accepted by the form and then rejected on every
    // generation. Silently. Test it now rather than at 3am mid-run.
    const reachable = await checkImageService();
    void refreshImageServiceHealth();

    return redirect(reply, '/settings', {
      kind: reachable.ok ? 'ok' : 'warn',
      message: reachable.ok
        ? 'Settings saved. The image service accepted the key.'
        : `Settings saved, but the image service refused them: ${reachable.detail}`,
    });
  });

  /* -- Presenters ----------------------------------------------------------- */

  const presentersView = () => {
    const usedBy = new Map<number, string[]>();
    for (const fbPage of listFbPages()) {
      if (fbPage.presenter_id === null) continue;
      usedBy.set(fbPage.presenter_id, [
        ...(usedBy.get(fbPage.presenter_id) ?? []),
        fbPage.name || fbPage.page_id,
      ]);
    }
    return presentersPage({ presenters: listPresenters(), usedBy });
  };

  app.get('/settings/presenters', async (request, reply) =>
    page(reply, 'Presenters', '/settings/presenters', presentersView(), readFlash(request.query)),
  );

  app.post('/settings/presenters', async (request, reply) => {
    const body = formBody(request);
    try {
      const voiceRaw = asString(body.voice).trim();
      insertPresenter({
        name: asString(body.name),
        flowCharacterId: idFromFlowUrl(asString(body.character)),
        flowVoiceId: voiceRaw ? idFromFlowUrl(voiceRaw) : '',
        voiceDescription: asString(body.voice_description),
        portraitUrl: '',
      });
    } catch (err) {
      return redirect(reply, '/settings/presenters', { kind: 'error', message: errorMessage(err) });
    }
    return redirect(reply, '/settings/presenters', {
      kind: 'ok',
      message: 'Presenter added. Pick them for a page under Channels → Facebook.',
    });
  });

  app.post('/settings/presenters/:id', async (request, reply) => {
    const id = asNumber((request.params as { id: string }).id, 0);
    const body = formBody(request);
    updatePresenter(id, {
      name: asString(body.name),
      voiceDescription: asString(body.voice_description),
    });
    return redirect(reply, '/settings/presenters', { kind: 'ok', message: 'Saved.' });
  });

  app.post('/settings/presenters/:id/delete', async (request, reply) => {
    deletePresenter(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/settings/presenters', { kind: 'ok', message: 'Presenter removed.' });
  });

  app.get('/settings/reels', async (request, reply) => {
    let allowed: string[] = [];
    try {
      const parsed = JSON.parse(settings.get('reel_formats') || '[]') as unknown;
      allowed = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      allowed = [];
    }
    if (allowed.length === 0) allowed = FORMATS.map((f) => f.key);
    return page(
      reply,
      'Reels',
      '/settings/reels',
      reelSettingsPage({
        mode: reelMode(settings),
        singleReferences: singleReferenceRoles(settings),
        lengthSeconds: settings.getNumber('reel_length_seconds') || 30,
        allowed,
        freshImages: settings.getBool('reel_fresh_images'),
        cta: settings.get('reel_cta_text'),
        formats: FORMATS,
        publisher: settings.get('reel_publisher') === 'buffer' ? 'buffer' : 'facebook',
        music: Array.from({ length: MUSIC_SLOTS }, (_, i) => settings.get(musicSlotKey(i + 1))),
      }),
      readFlash(request.query),
    );
  });

  app.post('/settings/reels', async (request, reply) => {
    const body = formBody(request);
    const chosen = ([] as string[])
      .concat((body.reel_formats as string | string[] | undefined) ?? [])
      .filter((key) => FORMATS.some((f) => f.key === key));
    if (chosen.length === 0) {
      return redirect(reply, '/settings/reels', { kind: 'error', message: 'Keep at least one shape on.' });
    }
    const refs = ([] as string[])
      .concat((body.reel_single_references as string | string[] | undefined) ?? [])
      .filter((r) => ARTICLE_ROLES.includes(r as ArticleRole));
    if (refs.length === 0) {
      return redirect(reply, '/settings/reels', { kind: 'error', message: 'Tick at least one photo for one-clip reels.' });
    }
    if (refs.length > MAX_REFERENCES) {
      return redirect(reply, '/settings/reels', {
        kind: 'error',
        message: `Flow takes at most ${MAX_REFERENCES} photos in one request.`,
      });
    }
    const pickedMode = asString(body.reel_mode);
    settings.set('reel_mode', ['scenes', 'mixed', 'process', 'hands'].includes(pickedMode) ? pickedMode : 'single');
    for (let slot = 1; slot <= MUSIC_SLOTS; slot++) {
      const key = musicSlotKey(slot);
      settings.set(
        key,
        asString(body[key])
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => /^https?:\/\//i.test(l) || isLocalMusicLine(l))
          .join('\n'),
      );
    }
    settings.set('reel_single_references', JSON.stringify(refs));
    const length = asNumber(body.reel_length_seconds, 30);
    settings.set('reel_length_seconds', String([15, 30, 45, 60].includes(length) ? length : 30));
    settings.set('reel_formats', JSON.stringify(chosen));
    settings.set('reel_fresh_images', asString(body.reel_fresh_images) === '1' ? 'true' : 'false');
    settings.set('reel_cta_text', asString(body.reel_cta_text).trim() || 'La recette complète : {domain}');
    settings.set('reel_publisher', asString(body.reel_publisher) === 'buffer' ? 'buffer' : 'facebook');
    return redirect(reply, '/settings/reels', { kind: 'ok', message: 'Saved. Applies to the next reel.' });
  });

  /**
   * A song uploaded straight from someone's computer, for one music box.
   *
   * Stored on disk here rather than pasted as a link, so it is recorded in
   * the box as a `local:<file>` line -- one more line pickMusic can draw
   * from, right alongside any links already there.
   */
  app.get('/settings/collage', async (request, reply) => {
    return page(
      reply,
      'Collage',
      '/settings/collage',
      collageSettingsPage({
        enabled: settings.getBool('collage_enabled'),
        steps: [6, 9, 12].includes(settings.getNumber('collage_steps')) ? settings.getNumber('collage_steps') : 9,
        watermark: settings.getBool('collage_watermark'),
      }),
      readFlash(request.query),
    );
  });

  app.post('/settings/collage', async (request, reply) => {
    const body = formBody(request);
    settings.set('collage_enabled', asString(body.collage_enabled) === '1' ? 'true' : 'false');
    const steps = asNumber(body.collage_steps, 9);
    settings.set('collage_steps', String([6, 9, 12].includes(steps) ? steps : 9));
    settings.set('collage_watermark', asString(body.collage_watermark) === '1' ? 'true' : 'false');
    return redirect(reply, '/settings/collage', { kind: 'ok', message: 'Saved. Applies to the next article.' });
  });

  app.post('/settings/reels/music/upload', async (request, reply) => {
    const slot = Math.min(MUSIC_SLOTS, Math.max(1, asNumber((request.query as { slot?: string }).slot, 1)));
    const key = musicSlotKey(slot);
    try {
      const file = await request.file();
      if (!file) {
        return redirect(reply, '/settings/reels', { kind: 'error', message: 'No file received.' });
      }
      const extension = extname(file.filename).toLowerCase();
      if (!['.mp3', '.wav', '.m4a', '.aac', '.ogg'].includes(extension)) {
        return redirect(reply, '/settings/reels', { kind: 'error', message: 'Choose an audio file (mp3, wav, m4a, aac or ogg).' });
      }
      const data = await file.toBuffer();
      const name = `${randomUUID()}${extension}`;
      mkdirSync(musicUploadsDir(), { recursive: true });
      await writeFile(join(musicUploadsDir(), name), data);
      const existing = settings.get(key);
      settings.set(key, existing ? `${existing}\nlocal:${name}` : `local:${name}`);
      return redirect(reply, '/settings/reels', { kind: 'ok', message: `${file.filename} uploaded to Box ${slot}.` });
    } catch (err) {
      return redirect(reply, '/settings/reels', { kind: 'error', message: `Upload failed: ${errorMessage(err)}` });
    }
  });

  app.post('/settings/endpoints', async (request, reply) => {
    const body = formBody(request);
    const name = asString(body.name).trim();
    const apiKey = asString(body.api_key).trim();

    if (!name) {
      return redirect(reply, '/settings', { kind: 'error', message: 'A label is required.' });
    }
    if (!apiKey) {
      return redirect(reply, '/settings', { kind: 'error', message: 'An API key is required.' });
    }

    try {
      upsertEndpoint(
        {
          name,
          // Blank means "use the shared base URL from settings".
          baseUrl: asString(body.base_url).trim(),
          apiKey,
          models: asString(body.models)
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean),
          enabled: true,
        },
        encryptionKey,
      );
      return redirect(reply, '/settings', { kind: 'ok', message: `API key "${name}" saved.` });
    } catch (err) {
      return redirect(reply, '/settings', { kind: 'error', message: errorMessage(err) });
    }
  });

  app.post('/settings/endpoints/:id/delete', async (request, reply) => {
    deleteEndpoint(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/settings', { kind: 'ok', message: 'API key deleted.' });
  });

  app.post('/settings/endpoints/:id/reset', async (request, reply) => {
    resetEndpointHealth(asNumber((request.params as { id: string }).id, 0));
    return redirect(reply, '/settings', { kind: 'ok', message: 'Key health reset.' });
  });

  /**
   * What is using the CPU inside the image container, as plain text.
   *
   * Deployment is Dokploy and there is no shell on the box, so `docker exec
   * ... top` is not available when that container starts burning cores. This
   * is the substitute: the agent samples /proc for a second and this renders
   * it. Behind the session cookie like every other page, and read-only.
   */
  app.get('/browser/procs', async (_request, reply) => {
    const base = settings.get('image_base_url').replace(/\/+$/, '');
    if (!base) return reply.type('text/plain').send('No image service URL is set.');

    try {
      const response = await fetch(`${base}/flow/procs`, {
        headers: { 'X-API-Key': settings.get('image_api_key') },
        // The endpoint samples for a second before it answers.
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return reply.type('text/plain').send(`Image service answered HTTP ${response.status}.`);
      }

      const body = (await response.json()) as {
        total_cpu_percent: number;
        processes: { pid: number; cpu_percent: number; memory_mb: number; command: string }[];
      };

      const lines = [
        `total ${body.total_cpu_percent}% CPU`,
        '',
        `${'PID'.padStart(7)}  ${'CPU%'.padStart(7)}  ${'MEM MB'.padStart(8)}  COMMAND`,
        ...body.processes.map(
          (p) =>
            `${String(p.pid).padStart(7)}  ${p.cpu_percent.toFixed(1).padStart(7)}  ` +
            `${p.memory_mb.toFixed(1).padStart(8)}  ${p.command}`,
        ),
      ];
      return reply.type('text/plain').send(lines.join('\n'));
    } catch (err) {
      return reply.type('text/plain').send(`Could not reach the image service: ${errorMessage(err)}`);
    }
  });

  /**
   * Per-thread CPU inside one process in the image container.
   *
   * /browser/procs says which process; this says which thread inside it, and
   * Chrome's thread names (VizCompositorThread, swiftshader, GpuWatchdog) are
   * specific enough to point at a fix. Two rounds of plausible-sounding Chrome
   * flags were spent not knowing this.
   */
  app.get('/browser/threads/:pid', async (request, reply) => {
    const base = settings.get('image_base_url').replace(/\/+$/, '');
    if (!base) return reply.type('text/plain').send('No image service URL is set.');
    const pid = asNumber((request.params as { pid: string }).pid, 0);

    try {
      const response = await fetch(`${base}/flow/threads/${pid}`, {
        headers: { 'X-API-Key': settings.get('image_api_key') },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return reply.type('text/plain').send(`Image service answered HTTP ${response.status}.`);
      }

      const body = (await response.json()) as {
        pid: number;
        thread_count: number;
        total_cpu_percent: number;
        threads: { tid: number; cpu_percent: number; name: string }[];
      };

      const lines = [
        `pid ${body.pid} — ${body.thread_count} threads, ${body.total_cpu_percent}% CPU total`,
        '',
        `${'TID'.padStart(7)}  ${'CPU%'.padStart(7)}  THREAD`,
        ...body.threads.map(
          (t) =>
            `${String(t.tid).padStart(7)}  ${t.cpu_percent.toFixed(1).padStart(7)}  ${t.name}`,
        ),
      ];
      return reply.type('text/plain').send(lines.join('\n'));
    } catch (err) {
      return reply.type('text/plain').send(`Could not reach the image service: ${errorMessage(err)}`);
    }
  });

  /* -- Health ------------------------------------------------------------ */

  /**
   * A social-only account's pictures and reels (see integrations/media-store.ts).
   * Public: Buffer, Facebook and Flow fetch these without a session.
   */
  app.get('/media/:name', async (request, reply) => {
    const name = (request.params as { name: string }).name;
    if (!isMediaName(name)) return reply.status(404).send('Not found');
    const path = join(mediaDir(), name);
    if (!existsSync(path)) return reply.status(404).send('Not found');
    const extension = name.split('.').pop() ?? '';
    // Facebook and Buffer fetch videos in ranges and want the size up front:
    // a chunked stream with no length is "media could not be processed".
    const size = statSync(path).size;
    reply
      .type(MEDIA_TYPES[extension] ?? 'application/octet-stream')
      .header('Cache-Control', 'public, max-age=86400')
      .header('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? '').trim());
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        return reply.status(416).header('Content-Range', `bytes */${size}`).send();
      }
      start = Math.max(0, start);
      end = Math.max(start, end);
      return reply
        .status(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Content-Length', String(end - start + 1))
        .send(createReadStream(path, { start, end }));
    }
    return reply.header('Content-Length', String(size)).send(createReadStream(path));
  });

  app.get('/healthz', async (_request, reply) => {
    const lock = lockStatus();
    return reply.send({
      ok: true,
      automation: settings.getBool('automation_enabled'),
      busy: Boolean(lock?.locked_at),
      problems: problemsFor(settings),
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    log.error('unhandled request error', errorMessage(error));
    void reply.status(500).type('text/html').send(
      layout({
        title: 'Error',
        active: '',
        body: { value: `<h1>Something went wrong</h1><pre>${errorMessage(error)}</pre>` } as never,
        flash: { kind: 'error', message: 'Unexpected error' },
      }),
    );
  });

  return app;
}
