import { HALAL_RULE, halalOnly, haramIn } from '../core/halal.js';
import { recipeFileName } from '../lib/file-name.js';
import { formatResearch, webSearchKeys, type Source } from '../llm/web-search.js';
import { findOnGoogle } from '../research/serp.js';
import { askPrompt } from '../llm/ask.js';
import { tryParseJson } from '../pipeline/json.js';
import { ImageClient } from '../integrations/images.js';
import { SiteApiClient, type SiteContentItem } from '../integrations/site-api.js';
import { siteApiFor } from '../integrations/site-api-for.js';
import { resolveProjectId } from '../core/project-id.js';
import { fixProperNouns, fixProperNounsInHtml } from '../core/proper-nouns.js';
import { checkBlogArticle, feedbackFor } from '../core/article-rules.js';
import { normaliseStyle, styleBlocks, type WritingStyle } from '../core/writing-style.js';
import {
  blogShape, listBlogStructures, markQuestionBlogStructure, pickBlogStructure, siteBlogHistory,
  type BlogStructure,
} from '../core/blog-structures.js';
import { sameQuestion, significantWords, titleSimilarity } from '../core/similar-title.js';
import { getSite, insertEvent, siteSecrets } from '../db/repos.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import {
  addBlogQuestions,
  answeredQuestions,
  blogPublishedToday,
  countBlogQuestions,
  getBlogQuestion,
  listBlogSites,
  markBlogRun,
  nextBlogQuestion,
  requeueStuckBlogQuestions,
  setBlogQuestionStatus,
  type BlogQuestionRow,
} from './repo.js';

const log = createLogger('blog');

/** A question is dropped as a near-duplicate of a published post above this. */
const DUPLICATE_THRESHOLD = 0.7;
/** Attempts before a question is left as failed instead of going back in line. */
const MAX_ATTEMPTS = 3;
/** How many questions to suggest when a site's queue runs dry. */
const SUGGEST_COUNT = 12;

export interface BlogArticleJson {
  title: string;
  slug: string;
  title_tag: string;
  meta_desc: string;
  excerpt: string;
  cover_alt: string;
  image_prompt: string;
  body_html: string;
}

export class BlogSkip extends Error {}

/* ---------- Choosing links ---------- */

/** A crude stem, enough to meet "freeze", "freezing" and "frozen" halfway: freez / froz. */
function stem(word: string): string {
  let w = word.toLowerCase();
  for (const suffix of ['ings', 'ing', 'ied', 'ies', 'ed', 'es', 's']) {
    if (w.length > suffix.length + 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w.replace(/e$/, '');
}

function words(text: string): Set<string> {
  return new Set(significantWords(text).filter((w) => w.length > 2).map(stem));
}

/** How much two texts share, by significant words. 0 when nothing. */
export function overlapScore(question: string, item: SiteContentItem): number {
  const q = words(question);
  if (q.size === 0) return 0;
  const target = words(`${item.title} ${item.keyword ?? ''} ${item.category ?? ''} ${item.summary ?? ''}`);
  let hits = 0;
  for (const w of q) if (target.has(w)) hits++;
  // Title words count double: they are what the page is about.
  const title = words(item.title);
  for (const w of q) if (title.has(w)) hits += 1;
  return hits / q.size;
}

/**
 * One recipe and up to two posts to link from an article about this question.
 *
 * The recipe is always chosen (its card goes under the article): the closest
 * by shared words, else the newest. Posts are linked only when they share the
 * topic — an unrelated link reads as filler to readers and to Google, so a
 * young blog simply links fewer posts until related ones exist.
 */
export function chooseLinks(
  question: string,
  content: SiteContentItem[],
): { recipe: SiteContentItem | null; posts: SiteContentItem[] } {
  const rank = (items: SiteContentItem[]) =>
    items
      .map((item, index) => ({ item, index, score: overlapScore(question, item) }))
      .sort((a, b) => b.score - a.score || a.index - b.index);

  const recipes = rank(content.filter((c) => c.type === 'recipe'));
  const posts = rank(content.filter((c) => c.type === 'post'));

  const recipe = recipes[0]?.item ?? null;
  const chosenPosts = posts.filter((p) => p.score > 0).slice(0, 2).map((p) => p.item);

  return { recipe, posts: chosenPosts };
}

/* ---------- Limiting articles per dish ---------- */

/** A post is about a recipe when most of the recipe title's words are in the post's title or keyword. */
const ABOUT_THRESHOLD = 0.6;

/**
 * The published posts about the same dish as this question: those that cover
 * most of the words of the recipe the question belongs to. Empty when the site
 * has no recipe to compare with.
 */
export function postsAboutSameDish(question: string, content: SiteContentItem[]): SiteContentItem[] {
  const { recipe } = chooseLinks(question, content);
  if (!recipe) return [];
  const target = words(recipe.title);
  if (target.size === 0) return [];
  return content.filter((c) => {
    if (c.type !== 'post') return false;
    const own = words(`${c.title} ${c.keyword ?? ''}`);
    let hit = 0;
    for (const w of target) if (own.has(w)) hit++;
    return hit / target.size >= ABOUT_THRESHOLD;
  });
}

/** How many published posts are about each recipe (same test as postsAboutSameDish), by recipe slug. */
export function articleCounts(content: SiteContentItem[]): Map<string, number> {
  const posts = content.filter((c) => c.type === 'post').map((p) => words(`${p.title} ${p.keyword ?? ''}`));
  const counts = new Map<string, number>();
  for (const r of content.filter((c) => c.type === 'recipe')) {
    const target = words(r.title);
    let n = 0;
    if (target.size > 0) {
      for (const own of posts) {
        let hit = 0;
        for (const w of target) if (own.has(w)) hit++;
        if (hit / target.size >= ABOUT_THRESHOLD) n++;
      }
    }
    counts.set(r.slug, n);
  }
  return counts;
}

/** Whether "limit articles per dish" is on, and the number it allows. */
export function clusterCap(settings: Settings): number | null {
  if (!settings.getBool('blog_cluster_cap_enabled')) return null;
  const cap = Math.floor(settings.getNumber('blog_cluster_cap'));
  return cap >= 1 ? cap : 3;
}

/* ---------- Cleaning the model's HTML ---------- */

const ALLOWED = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'b', 'i']);

/** Keep simple formatting only: no scripts, styles, event handlers or headings above h2. */
export function cleanArticleHtml(html: string, style: WritingStyle = 'us'): string {
  let out = html.replace(/<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1>/gi, '');
  out = out.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '<h2>$1</h2>');
  out = out.replace(/<\/?([a-z0-9]+)\b[^>]*>/gi, (tag, name: string) => {
    const lower = name.toLowerCase();
    if (!ALLOWED.has(lower)) return '';
    if (tag.startsWith('</')) return `</${lower}>`;
    if (lower === 'a') {
      const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
      const url = (href?.[2] ?? href?.[3] ?? '').trim();
      if (!/^(https?:\/\/|\/)/i.test(url)) return '<a>';
      return `<a href="${url.replace(/"/g, '&quot;')}">`;
    }
    return `<${lower}>`;
  });
  // Proper nouns the model lower-cased, put right before anything reads this.
  return fixProperNounsInHtml(out.replace(/<a>([\s\S]*?)<\/a>/gi, '$1').trim(), style);
}

/** Each url linked once: later links to a url already linked become plain text. */
export function dedupeLinks(html: string): string {
  const seen = new Set<string>();
  return html.replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/gi, (whole, href: string, text: string) => {
    const key = href.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return text;
    seen.add(key);
    return whole;
  });
}

/** Make sure every chosen link is in the article; add a short "Keep reading" list for any the model left out. */
export function ensureLinks(html: string, links: SiteContentItem[]): string {
  const missing = links.filter((l) => !html.includes(l.url));
  if (missing.length === 0) return html;
  const items = missing
    .map((l) => `<li><a href="${l.url}">${l.title.replace(/</g, '&lt;')}</a></li>`)
    .join('');
  const block = `<h2>À lire aussi</h2><ul>${items}</ul>`;
  const faq = html.search(/<h2>\s*(?:Questions fréquentes|Frequently asked questions)/i);
  return faq >= 0 ? html.slice(0, faq) + block + html.slice(faq) : html + block;
}

/* ---------- Writing one article ---------- */

function imageClientFor(settings: Settings, site: { project_id: string; domain: string }): ImageClient {
  const project = resolveProjectId(site.project_id, settings.get('flow_project_id'), site.domain);
  return new ImageClient({
    baseUrl: settings.get('image_base_url'),
    apiKey: settings.get('image_api_key'),
    pollIntervalMs: settings.getNumber('image_poll_interval_seconds') * 1000,
    maxAttempts: settings.getNumber('image_poll_max_attempts'),
    projectId: project.projectId,
    imageModel: settings.get('image_model'),
  });
}

async function askJson<T>(
  settings: Settings,
  key: Buffer,
  prompt: string,
  vars: Record<string, unknown>,
  required: string[],
): Promise<T> {
  let lastError = 'no answer';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await askPrompt(settings, key, prompt, vars);
    const parsed = tryParseJson<Record<string, unknown>>(result.content);
    if (parsed) {
      const missing = required.filter((f) => typeof parsed.value[f] !== 'string' && !Array.isArray(parsed.value[f]));
      if (missing.length === 0) return parsed.value as T;
      lastError = `missing ${missing.join(', ')}`;
    } else {
      lastError = 'not JSON';
    }
    log.warn(`${prompt}: answer unusable (${lastError}), attempt ${attempt}`);
  }
  throw new Error(`The model's ${prompt} answer was unusable: ${lastError}`);
}

/**
 * Write and publish the article for one question. Returns the post's url.
 * Throws BlogSkip when the question should not be written at all.
 */
export async function writeBlogArticle(
  questionId: number,
  settings: Settings,
  key: Buffer,
  heartbeat: () => void = () => {},
): Promise<string> {
  const question = getBlogQuestion(questionId);
  if (!question) throw new Error('Question not found');
  const site = getSite(question.site_id);
  if (!site) throw new Error('Site not found');

  const api = siteApiFor(site, siteSecrets(site, key).apiToken);
  const content = await api.getContent();
  heartbeat();

  // Already answered on the site, perhaps under other words: not worth a second article.
  const twin = content.find((c) => c.type === 'post' && (
    titleSimilarity(question.question, c.title) >= DUPLICATE_THRESHOLD || sameQuestion(question.question, c.title)
  ));
  if (twin) throw new BlogSkip(`Already answered by the published post “${twin.title}”`);

  const cap = clusterCap(settings);
  if (cap !== null) {
    const same = postsAboutSameDish(question.question, content);
    if (same.length >= cap) {
      throw new BlogSkip(`The site already has ${same.length} articles about this dish (limit ${cap}), e.g. “${same[0]!.title}”`);
    }
  }

  const { recipe, posts } = chooseLinks(question.question, content);
  if (!recipe) throw new Error('The site has no published recipe yet to link to and show as a card.');

  const links = [
    `- A recipe (link it once): ${recipe.url} — "${recipe.title}"`,
    ...posts.map((p) => `- A related blog article (link it once): ${p.url} — "${p.title}"`),
  ].join('\n');

  // Research first: real, current facts from the web for the writer to paraphrase.
  // Serper first (several keys), Ollama web search when it cannot answer.
  const findings = await findOnGoogle(question.question, {
    serperKey: settings.get('serper_api_key'),
    serperState: {
      get: () => Number(settings.get('serper_key_index')) || 0,
      set: (i: number) => settings.set('serper_key_index', String(i)),
    },
    ollamaKeys: webSearchKeys(key, settings.get('llm_base_url')),
    skipDomain: site.domain,
    maxPages: 4,
  });
  const sources: Source[] = findings.pages.map((p) => ({
    title: p.title,
    url: p.url,
    content: p.text ?? (p.recipe ? `Ingredients: ${p.recipe.ingredients.join('; ')}. ${p.recipe.steps ?? ''}` : ''),
  }));
  heartbeat();

  // Setup -> Blog structures: the next shape for this site, so the blog is
  // not the same article with different facts in it. With every shape
  // switched off this is null and blogShape falls back to the one the blog
  // has always written.
  let structure: BlogStructure | null = null;
  try {
    const history = siteBlogHistory(site.id);
    structure = pickBlogStructure(listBlogStructures(), history.recent, history.uses, site.id);
  } catch {
    structure = null;
  }

  const write = (extra = '') =>
    askJson<BlogArticleJson>(
      settings,
      key,
      'blog-article',
      {
        site: { name: site.name, domain: site.domain },
        question: question.question,
        links,
        recipe: { title: recipe.title, summary: recipe.summary || recipe.title },
        // The rule, then whatever the last draft got wrong, then the notes.
        // The note used to be added only on a Halal-only site, so a rewrite on
        // any other site asked for the same article again with nothing changed.
        research: [halalOnly() ? HALAL_RULE : '', extra.trim(), formatResearch(sources)]
          .filter(Boolean)
          .join('\n\n'),
        blogShape: blogShape(structure),
        style: styleBlocks(style),
      },
      ['title', 'body_html', 'meta_desc', 'image_prompt'],
    );

  const style = normaliseStyle(site.writing_style);
  let article = await write();
  // Halal only: the rule asks, this checks. One rewrite naming the word; still there, no post.
  let haram = haramIn([article.title, article.meta_desc, article.excerpt, article.body_html]);
  if (haram) {
    log.warn(`blog article “${question.question}” used “${haram}” despite Halal only: asking for one rewrite`);
    article = await write(`\nYOUR LAST DRAFT USED “${haram}”, WHICH IS NOT ALLOWED. Write the article again with no alcohol and no pork anywhere, using a halal alternative.`);
    haram = haramIn([article.title, article.meta_desc, article.excerpt, article.body_html]);
    if (haram) throw new Error(`The article names “${haram}” (Halal only); not published.`);
  }

  // The site's spelling is put right in code. Units and voice need a judgement,
  // so a draft that breaks them is sent back once with the rule named; if the
  // rewrite breaks them too nothing is published.
  let checked = checkBlogArticle(article, style);
  if (checked.problems.length > 0) {
    log.warn(`blog article “${question.question}” broke ${checked.problems.length} rule(s): ${checked.problems.slice(0, 3).join('; ')}`);
    article = await write(`\n${feedbackFor(checked.problems)}`);
    haram = haramIn([article.title, article.meta_desc, article.excerpt, article.body_html]);
    if (haram) throw new Error(`The article names “${haram}” (Halal only); not published.`);
    checked = checkBlogArticle(article, style);
    if (checked.problems.length > 0) {
      throw new Error(`The article still breaks the rules after a rewrite, so it was not published: ${checked.problems.slice(0, 5).join('; ')}.`);
    }
  }
  article = checked.article;

  if (structure) {
    try { markQuestionBlogStructure(question.id, structure.id); } catch { /* recorded only for the rotation */ }
  }
  heartbeat();

  let body = cleanArticleHtml(article.body_html, style);
  if (body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length < 600) {
    throw new Error('The article came back too short (under 600 words).');
  }
  body = ensureLinks(dedupeLinks(body), [recipe, ...posts]);

  // The cover: generated in Flow, landscape, uploaded to the site.
  const images = imageClientFor(settings, site);
  const generated = await images.generate(article.image_prompt, 'HORIZONTAL');
  heartbeat();
  const extension = generated.contentType.includes('png') ? 'png' : generated.contentType.includes('jpeg') ? 'jpg' : 'webp';
  const uploaded = await api.uploadImage(generated.data, recipeFileName(article.title, 'cover', extension), generated.contentType, 'covers');
  heartbeat();

  const posted = await api.publishPost({
    title: fixProperNouns(article.title.trim() || question.question, style),
    slug: article.slug,
    title_tag: article.title_tag,
    meta_desc: article.meta_desc,
    excerpt: article.excerpt,
    body_html: body,
    cover: uploaded.url,
    cover_alt: article.cover_alt,
    recipe_card: recipe.slug,
  }, `blog-${question.id}`);

  setBlogQuestionStatus(question.id, 'done', { postUrl: posted.url, recipeSlug: recipe.slug });
  return posted.url;
}

/* ---------- Suggesting questions ---------- */

/** Ask the model for new PAA questions from the site's recipes; saved as 'suggested' for approval. */
export async function suggestBlogQuestions(siteId: number, settings: Settings, key: Buffer, count = SUGGEST_COUNT): Promise<number> {
  const site = getSite(siteId);
  if (!site) throw new Error('Site not found');
  const api = siteApiFor(site, siteSecrets(site, key).apiToken);
  const everything = await api.getContent();
  // Recipes with the fewest articles first, so the model is shown the dishes the blog has
  // not covered yet instead of only the newest 60, and each carries its count.
  const counts = articleCounts(everything);
  const recipes = everything
    .filter((c) => c.type === 'recipe')
    .map((r, index) => ({ r, index, n: counts.get(r.slug) ?? 0 }))
    .sort((a, b) => a.n - b.n || a.index - b.index)
    .slice(0, 60);
  if (recipes.length === 0) throw new Error(`${site.domain} has no published recipes to suggest questions from.`);

  const existing = answeredQuestions(siteId).slice(0, 150);
  const result = await askJson<{ questions: string[] }>(
    settings,
    key,
    'blog-questions',
    {
      site: { name: site.name },
      recipes: recipes.map(({ r, n }) => `- ${r.title} (${n} article${n === 1 ? '' : 's'} so far)`).join('\n'),
      existing: existing.length ? existing.map((q) => `- ${q}`).join('\n') : '(none yet)',
      count,
    },
    ['questions'],
  );

  const fresh = (result.questions ?? [])
    .filter((q): q is string => typeof q === 'string')
    .filter((q) => !existing.some((e) => titleSimilarity(q, e) >= DUPLICATE_THRESHOLD || sameQuestion(q, e)));
  // Dishes that already have their share of articles are not suggested again, and
  // neither is a second question about one dish within this same batch.
  const cap = clusterCap(settings);
  if (cap !== null) {
    const taken = new Map<string, number>();
    const kept: string[] = [];
    for (const q of fresh) {
      const recipe = chooseLinks(q, everything).recipe;
      const key = recipe?.slug ?? '';
      const used = (key ? taken.get(key) : undefined) ?? postsAboutSameDish(q, everything).length;
      if (used >= cap) continue;
      if (key) taken.set(key, used + 1);
      kept.push(q);
    }
    return addBlogQuestions(siteId, kept, 'ai', 'suggested').added;
  }
  return addBlogQuestions(siteId, fresh, 'ai', 'suggested').added;
}

/* ---------- The blog clock ---------- */

export interface BlogTickDeps {
  /** The same lock recipe runs take, so the two never share the image service. */
  tryLock: () => boolean;
  unlock: () => void;
  heartbeat: () => void;
}

function minutesSince(sqlDate: string | null): number {
  if (!sqlDate) return Number.POSITIVE_INFINITY;
  const t = Date.parse(`${sqlDate.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? (Date.now() - t) / 60_000 : Number.POSITIVE_INFINITY;
}

/** Write one article for one site that is due, if any. Suggest questions for a site whose queue ran dry. */
export async function tickBlog(settings: Settings, key: Buffer, deps: BlogTickDeps): Promise<void> {
  requeueStuckBlogQuestions();
  if (!settings.getBool('automation_enabled')) return;

  for (const site of listBlogSites()) {
    if (site.blog_enabled !== 1 || site.status !== 'active') continue;
    if (minutesSince(site.blog_last_at) < site.blog_interval_minutes) continue;
    if (blogPublishedToday(site.id) >= site.blog_daily_target) continue;

    const question = nextBlogQuestion(site.id);
    if (!question) {
      // Queue empty: prepare suggestions once, for a person to approve.
      if (countBlogQuestions(site.id, 'suggested') === 0) {
        markBlogRun(site.id);
        try {
          const added = await suggestBlogQuestions(site.id, settings, key);
          insertEvent('warn', 'blog', `${site.domain}: blog queue is empty — ${added} new questions suggested, approve them under Content → Blog`);
        } catch (err) {
          log.warn(`${site.domain}: could not suggest blog questions: ${errorMessage(err)}`);
        }
      }
      continue;
    }

    if (!deps.tryLock()) return; // a recipe run is working; try again next minute
    try {
      await runOneBlogQuestion(question, settings, key, deps.heartbeat);
    } finally {
      deps.unlock();
    }
    return; // one article per tick
  }
}

/** Write one question now, recording the outcome on it. Used by the clock and the "Write now" button. */
export async function runOneBlogQuestion(
  question: BlogQuestionRow,
  settings: Settings,
  key: Buffer,
  heartbeat: () => void = () => {},
): Promise<{ ok: boolean; url?: string; error?: string }> {
  markBlogRun(question.site_id);
  setBlogQuestionStatus(question.id, 'working', { attempt: true });
  const domain = getSite(question.site_id)?.domain ?? '?';
  try {
    const url = await writeBlogArticle(question.id, settings, key, heartbeat);
    insertEvent('info', 'blog', `${domain}: blog article published — ${question.question}`, url);
    log.info(`blog article published: ${url}`);
    return { ok: true, url };
  } catch (err) {
    const message = errorMessage(err);
    if (err instanceof BlogSkip) {
      setBlogQuestionStatus(question.id, 'skipped', { error: message });
      insertEvent('warn', 'blog', `${domain}: blog question skipped — ${question.question}`, message);
      return { ok: false, error: message };
    }
    const attempts = (getBlogQuestion(question.id)?.attempts ?? MAX_ATTEMPTS);
    setBlogQuestionStatus(question.id, attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', { error: message });
    insertEvent('error', 'blog', `${domain}: blog article failed — ${question.question}`, message);
    return { ok: false, error: message };
  }
}
