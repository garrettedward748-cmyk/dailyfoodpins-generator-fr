import type { Step } from '../engine.js';
import { createLogger, errorMessage } from '../../lib/logger.js';
import { LlmJsonError, parseJson } from '../json.js';
import { parseJsonOrRepair } from '../parse-with-repair.js';
import type { PipelineContext } from '../context.js';
import type { ArticleImages } from './images.js';
import type { RecipeData, SeoData } from './content.js';
import type { PostedRecipe } from '../../integrations/site-api.js';
import { getRun } from '../../db/repos.js';
import { fixProperNouns, fixProperNounsInHtml } from '../../core/proper-nouns.js';
import {
  listArticleStructures, markRunArticleStructure, pickArticleStructure, siteStructureHistory,
  structureBlocks, type ArticleStructure,
} from '../../core/article-structures.js';
import {
  ArticleRulesError, bannedList, checkPart, feedbackFor, ruleContextFor,
  type PartName, type RuleContext,
} from '../../core/article-rules.js';
import { timeBlocks } from '../../core/recipe-times.js';
import { normaliseStyle, styleBlocks, type WritingStyle } from '../../core/writing-style.js';

const log = createLogger('article');

/**
 * Article generation and publishing.
 *
 * The original generated three parts, each with a hand-wired fallback node
 * pointing at a different Ollama account AND a shorter prompt. Endpoint
 * failover is now the pool's job; what remains here is the *prompt*
 * fallback, which is a genuine quality strategy: try the full prompt, and if
 * it fails or returns unusable JSON, try the simpler one.
 */

export interface ArticleInput {
  seo: SeoData;
  recipe: RecipeData;
  images: ArticleImages;
}

/**
 * Variables every article prompt interpolates.
 *
 * Image paths are deliberately absent. They used to be handed to the model
 * so it could copy them into the output, which meant a mistyped or
 * hallucinated path published a recipe with a broken photo. They are
 * attached in code below instead, where copying cannot go wrong.
 */
function promptVariables(
  input: ArticleInput,
  structure: ArticleStructure | null,
  rules: RuleContext,
  feedback: string,
): Record<string, unknown> {
  return {
    seo: input.seo,
    recipe: { raw: input.recipe.raw },
    ...structureBlocks(structure),
    // The site's own spelling and units, so a prompt cannot hard-code a
    // country. The code also enforces both; this only tells the model first.
    style: styleBlocks(rules.style),
    // The recipe's times, worked out once. Part 1 may repeat them and part 2
    // is given them; neither is asked to add anything up.
    times: timeBlocks(rules.times, rules.style),
    rules: { banned: bannedList(rules.style) },
    // Empty on a first attempt. On a retry, the rules the last draft broke.
    feedback,
  };
}

type PartResult = { data: Record<string, unknown>; endpoint: string; model: string };

/**
 * Generate one part, and hold it to the article rules.
 *
 * Three attempts at most, each with the reason the last one failed:
 *   1. the full prompt;
 *   2. the full prompt again, told which rules the first draft broke;
 *   3. the simpler fallback prompt, told the same.
 * An answer that is not JSON at all skips the second attempt — asking the same
 * prompt for the same thing again is what the fallback exists to avoid. If the
 * third still breaks a rule the run stops with the rules named, rather than
 * publish a page that disagrees with itself.
 *
 * Endpoint-level retries have already happened inside the pool by this point,
 * so reaching the fallback means the prompt itself is the problem.
 */
async function generatePart(
  ctx: PipelineContext,
  part: PartName,
  input: ArticleInput,
  structure: ArticleStructure | null,
  rules: RuleContext,
): Promise<PartResult> {
  const attempts = [part, part, `${part}.fallback`];
  let feedback = '';
  let lastProblems: string[] = [];
  let lastError: unknown;

  for (let i = 0; i < attempts.length; i++) {
    const promptName = attempts[i]!;

    try {
      const result = await ctx.prompt(promptName, promptVariables(input, structure, rules, feedback));
      const parsed = await parseJsonOrRepair<Record<string, unknown>>(ctx, result.content, `${promptName} output`);
      const checked = checkPart(part, parsed, rules);

      if (checked.problems.length === 0) {
        return { data: checked.data, endpoint: result.endpoint, model: result.model };
      }

      lastProblems = checked.problems;
      feedback = feedbackFor(checked.problems);
      log.warn(`${promptName} broke ${checked.problems.length} article rule(s): ${checked.problems.slice(0, 3).join('; ')}`);
    } catch (err) {
      lastError = err;
      log.warn(`${promptName} failed, trying the fallback`, errorMessage(err));
      // Not valid JSON, or the model was unreachable: the same prompt would
      // fail the same way, so go straight to the fallback.
      i = Math.max(i, attempts.length - 2);
    }
  }

  throw new ArticleRulesError(part, lastProblems, lastError);
}

/**
 * Assemble the recipe document from three generated parts.
 *
 * The original read allItems[0], [1], [2] positionally out of a merge node,
 * so a reordered merge would silently produce a scrambled article. Named
 * values make that impossible.
 */
export const generateArticle: Step<ArticleInput, Record<string, unknown>> = {
  name: 'generate-article',
  title: 'Generate article (3 parts)',
  async run(ctx, input) {
    // Setup -> Article structures: the next shape for this site, chosen once
    // and used by both the parts that have one, so an article cannot open in
    // one shape and close in another. With every structure switched off this
    // is null and the blocks fall back to the shape the site has always
    // written.
    let structure: ArticleStructure | null = null;
    try {
      const history = siteStructureHistory(ctx.site.id);
      structure = pickArticleStructure(listArticleStructures(), history.recent, history.uses, ctx.site.id);
    } catch {
      structure = null; // no database (offline tools)
    }

    // The site's spelling and units, and the recipe's times, fixed once so all
    // three parts are held to the same ones.
    const rules = ruleContextFor(normaliseStyle(ctx.site.writing_style), input.recipe);

    const part1 = await generatePart(ctx, 'part-1', input, structure, rules);
    const part2 = await generatePart(ctx, 'part-2', input, structure, rules);
    const part3 = await generatePart(ctx, 'part-3', input, structure, rules);

    if (structure) {
      try { markRunArticleStructure(ctx.runId, structure.id); } catch { /* recorded only for the rotation */ }
    }

    const article = { ...part1.data, ...part2.data, ...part3.data };

    if (!article.title) {
      throw new Error('Assembled article has no title; the parts did not merge as expected.');
    }

    return {
      value: attachSiteFields(article, input, normaliseStyle(ctx.site.writing_style)),
      endpoint: [part1.endpoint, part2.endpoint, part3.endpoint].join(', '),
      model: part1.model,
    };
  },
};

/**
 * Fill in everything the site needs that the model must not be asked for.
 *
 * Taxonomy and image paths are facts already established — the cuisine was
 * matched against the site's own list, the photographs were uploaded and
 * their paths returned. Asking three prompts to copy them faithfully only
 * creates three chances to get them wrong, and the site refuses the whole
 * post over a cuisine it does not recognise.
 */
/**
 * Proper nouns the model lower-cased, put right across the whole article.
 *
 * Done here rather than asked for in the prompt: "halloween" mid-sentence is
 * wrong every time, and a rule in a prompt is followed most of the time. Only
 * the text fields are walked — the numbers, the step images and anything the
 * site keys off are left exactly as they were.
 */
function capitaliseNames(article: Record<string, unknown>, style: WritingStyle = 'us'): Record<string, unknown> {
  // slug and focus_keyword are deliberately absent: both are lower case by
  // design, and "fixing" them would change the page's address and the phrase
  // the page targets.
  const plain = ['title', 'headline', 'title_tag', 'meta_desc', 'image_alt', 'yield_text', 'difficulty'];
  const markup = ['intro_html', 'tips_html', 'notes_html'];

  const out: Record<string, unknown> = { ...article };

  for (const key of plain) {
    if (typeof out[key] === 'string') out[key] = fixProperNouns(out[key], style);
  }
  for (const key of markup) {
    if (typeof out[key] === 'string') out[key] = fixProperNounsInHtml(out[key], style);
  }

  // The recipe's own prose: the steps a cook reads and the questions below.
  if (Array.isArray(out.steps)) {
    out.steps = out.steps.map((step) =>
      step && typeof step === 'object'
        ? {
            ...(step as Record<string, unknown>),
            heading: typeof (step as Record<string, unknown>).heading === 'string'
              ? fixProperNouns(String((step as Record<string, unknown>).heading), style)
              : (step as Record<string, unknown>).heading,
            body: typeof (step as Record<string, unknown>).body === 'string'
              ? fixProperNouns(String((step as Record<string, unknown>).body), style)
              : (step as Record<string, unknown>).body,
          }
        : step,
    );
  }
  if (Array.isArray(out.faqs)) {
    out.faqs = out.faqs.map((faq) =>
      faq && typeof faq === 'object'
        ? {
            ...(faq as Record<string, unknown>),
            question: typeof (faq as Record<string, unknown>).question === 'string'
              ? fixProperNouns(String((faq as Record<string, unknown>).question), style)
              : (faq as Record<string, unknown>).question,
            answer_html: typeof (faq as Record<string, unknown>).answer_html === 'string'
              ? fixProperNounsInHtml(String((faq as Record<string, unknown>).answer_html), style)
              : (faq as Record<string, unknown>).answer_html,
          }
        : faq,
    );
  }

  return out;
}

export function attachSiteFields(
  article: Record<string, unknown>,
  input: ArticleInput,
  style: WritingStyle = 'us',
): Record<string, unknown> {
  // Named once and used throughout: taking the steps off `article` below
  // instead would hand the site the uncorrected copy, which is what it did
  // until a test caught it.
  const named = capitaliseNames(article, style);

  const filled: Record<string, unknown> = {
    ...named,
    category: input.seo.category,
    image: input.images.hero,
    image_alt: typeof article.image_alt === 'string' && article.image_alt.trim() !== ''
      ? article.image_alt
      : String(article.title ?? input.seo.title),
    status: 'published',
  };

  // An empty cuisine means the site has no term this recipe belongs to.
  // Sending the key anyway would be refused; leaving it out files the recipe
  // without one, which is what an unmatched cuisine actually means.
  if (input.seo.cuisine !== '') {
    filled.cuisine = input.seo.cuisine;
  } else {
    delete filled.cuisine;
  }

  filled.steps = spreadStepImages(named.steps, input.images);

  return filled;
}

/**
 * Put each method photograph on the step it was drawn for.
 *
 * The step numbers come from the prompt-writing step, which read the recipe
 * and chose the three moments where a cook has to judge something by eye.
 * Spreading the photographs evenly instead — which is what this did — put one
 * on the first step and one on the last, and the last step is "serve hot":
 * the hero photograph a second time.
 *
 * An even spread remains the fallback, for a model that answered with step
 * numbers that are missing, repeated, or not in the recipe at all. A
 * misplaced photograph is worth having; no photograph is not.
 */
function spreadStepImages(steps: unknown, images: ArticleImages): unknown {
  if (!Array.isArray(steps) || steps.length === 0) return steps;

  const photos = [images.stepA, images.stepB, images.stepC].filter(
    (path): path is string => typeof path === 'string' && path !== '',
  );

  if (photos.length === 0) return steps;

  const positions = chosenPositions(images.stepNumbers, photos.length, steps.length)
    ?? evenPositions(photos.length, steps.length);

  return steps.map((step, index) => {
    const slot = positions.indexOf(index);

    if (slot === -1 || typeof step !== 'object' || step === null) return step;

    return { ...(step as Record<string, unknown>), image: photos[slot] };
  });
}

/**
 * The model's chosen steps as zero-based positions, or undefined when its
 * answer cannot be used — too few, out of range, or two photographs landing
 * on one step.
 */
function chosenPositions(
  stepNumbers: number[] | undefined,
  photos: number,
  steps: number,
): number[] | undefined {
  if (!Array.isArray(stepNumbers) || stepNumbers.length < photos) return undefined;

  const positions = stepNumbers.slice(0, photos).map((n) => Math.trunc(n) - 1);

  const usable =
    positions.every((p) => Number.isInteger(p) && p >= 0 && p < steps) &&
    new Set(positions).size === positions.length;

  return usable ? positions : undefined;
}

function evenPositions(photos: number, steps: number): number[] {
  return Array.from({ length: photos }, (_, index) =>
    photos === 1 ? 0 : Math.round((index * (steps - 1)) / (photos - 1)),
  );
}

/**
 * Publish the article, repairing malformed JSON if the site rejects it.
 *
 * Mirrors the original's Posting → error → Article Json (repair) → Posting
 * loop, with the retry ceiling honoured consistently.
 */
const MAX_POST_ATTEMPTS = 3;

/**
 * The wait between attempts doubles from this. An object rather than a
 * constant so a test can set it to zero: the real waits are two and four
 * seconds, which is right for a site that is momentarily busy and wrong for a
 * test that has to finish in five.
 */
export const postRetry = { baseMs: 1000 };

/**
 * Refuse to publish on behalf of a run that is no longer the live one.
 *
 * Stopping a run by hand marks it failed and frees the scheduler lock, but it
 * cannot interrupt a pipeline that is awaiting somebody else's network call —
 * so the stopped run carries on in the background while the next run starts.
 * Every other late step only writes to this database and is harmless. This
 * one posts to a live website, and it published a second copy of the same
 * recipe a minute after the first.
 *
 * Checked immediately before each attempt, because the whole point is to
 * catch a stop that landed while this step was waiting.
 */
function stillTheLiveRun(runId: number): boolean {
  const row = getRun(runId);
  return row === undefined || row.status === 'running';
}

export const postArticle: Step<Record<string, unknown>, PostedRecipe> = {
  name: 'post-article',
  title: 'Publish article to site',
  async run(ctx, article) {
    let payload = article;
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_POST_ATTEMPTS; attempt++) {
      if (!stillTheLiveRun(ctx.runId)) {
        throw new Error(
          `Run ${ctx.runId} was stopped before its article reached ${ctx.site.domain}, ` +
            'so it was not published. Resume the run to publish it.',
        );
      }

      try {
        const posted = await ctx.siteApi.postRecipe(payload, `run-${ctx.runId}`);
        if (!posted.id) throw new Error('Site accepted the post but returned no id');
        log.info(`published to ${ctx.site.domain} as ${posted.id} (attempt ${attempt})`);
        return posted;
      } catch (err) {
        lastError = errorMessage(err);
        log.warn(`post attempt ${attempt}/${MAX_POST_ATTEMPTS} failed: ${lastError}`);

        if (attempt === MAX_POST_ATTEMPTS) break;

        // Ask the model to repair the document against the site's complaint.
        try {
          const repaired = await ctx.prompt('repair-json', {
            postError: lastError,
            articleJson: JSON.stringify(payload),
          });
          payload = parseJson<Record<string, unknown>>(repaired.content, 'Repaired article JSON');
          log.info('article JSON repaired, retrying');
        } catch (repairErr) {
          if (repairErr instanceof LlmJsonError) {
            log.warn('JSON repair produced invalid JSON; retrying with the original payload');
          } else {
            log.warn('JSON repair failed', errorMessage(repairErr));
          }
        }

        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * postRetry.baseMs));
      }
    }

    throw new Error(
      `Publishing to ${ctx.site.domain} failed after ${MAX_POST_ATTEMPTS} attempts. ` +
        `Last error: ${lastError}`,
    );
  },
};
