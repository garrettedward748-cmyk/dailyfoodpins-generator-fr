import type { Step } from '../engine.js';
import { HALAL_RULE, halalOnly, haramAllIn, haramContexts } from '../../core/halal.js';
import { NotHalalError } from './duplicate.js';
import { parseJson, requireFields } from '../json.js';
import { parseJsonOrRepair } from '../parse-with-repair.js';
import { fixRecipeSpelling, recipeFeedback, recipeProblems, RecipeRulesError } from '../../core/recipe-rules.js';
import { normaliseStyle, styleBlocks } from '../../core/writing-style.js';
import type { Category } from '../../integrations/site-api.js';
import { createLogger } from '../../lib/logger.js';
import {
  listPhotoStyles, markRunPhotoStyle, pickPhotoStyle, shootBlock, sitePhotoHistory, type PhotoStyle,
} from '../../core/photo-styles.js';
import {
  extraStepNumbers, parseStepPhotoMode, recipeStepCount, recipeStepText,
} from '../../core/step-photos.js';

const log = createLogger('content');

/**
 * Stages 1-4: gather site context, validate the spy source, derive SEO
 * metadata, generate the recipe, and turn it into image prompts.
 */

/**
 * The operator's research about this one recipe, as prompts receive it.
 *
 * `group` is the seed keyword — a label many recipes share, because spying on
 * one topic yields five or ten different dishes under it. It is passed so a
 * prompt can be told explicitly to ignore it as a subject.
 *
 * The rest was being collected and thrown away. Only `spy.title` ever reached
 * a model, and only in validate-spy; description and annotation were put into
 * the context by the step and then never referenced by the template. So the
 * whole article was written from one line of text, distilled into four SEO
 * fields — and five recipes sharing a topic came out as five copies of the
 * same article with the same pictures.
 */
function spyContext(ctx: import('../context.js').PipelineContext) {
  const cookRecipe = (ctx.keyword.cook_recipe ?? '').trim();
  const cookNotes = (ctx.keyword.cook_notes ?? '').trim();
  // The search results are other people's recipes, and a fig pizza's top
  // results are fig-and-prosciutto pizzas. Handed over as "use these facts",
  // they outvoted the one-line halal rule. Named up front instead.
  const fromResults = haramAllIn([ctx.research?.brief ?? '', cookRecipe, cookNotes].join('\n'));
  const resultsWarning = fromResults.length
    ? `THE SOURCES BELOW MENTION ${fromResults.map((w) => w.toUpperCase()).join(', ')} — NOT ALLOWED (Halal only). ` +
      'Leave them out entirely or use the halal alternative (beef or turkey bacon, turkey ham, beef pepperoni, beef bresaola ' +
      'or smoked turkey for cured pork, grape or apple juice or broth for alcohol; in French: bacon/lardons/jambon de dinde, jus de raisin), and do not name the forbidden item anywhere.'
    : '';
  return {
    group: ctx.keyword.seed_keyword,
    title: ctx.keyword.spy_title,
    description: ctx.keyword.spy_description,
    annotation: [
      halalOnly() ? HALAL_RULE : '',
      resultsWarning,
      // The cook's own recipe outranks everything below it: her ingredients,
      // amounts and steps are the dish. Search results only fill what she left out.
      cookRecipe
        ? `THE COOK'S OWN RECIPE — this is how she makes it in her kitchen. Keep her ingredients, amounts, times, temperatures and order of steps exactly; only fill in what she left out, and never contradict her:\n${cookRecipe}`
        : '',
      cookNotes ? `THE COOK'S NOTES — true facts from her kitchen; let her tips and variations reflect them:\n${cookNotes}` : '',
      ctx.keyword.annotation,
      ctx.research?.brief
        ? cookRecipe
          ? `WHAT THE TOP GOOGLE RESULTS SAY — use only to fill gaps in the cook's recipe and to cover questions people ask; where they disagree with her, she is right; never copy their wording:\n${ctx.research.brief}`
          : `WHAT THE TOP GOOGLE RESULTS SAY — use these facts (ingredients, amounts, times, temperatures), cover what they cover, add what they miss; never copy their wording:\n${ctx.research.brief}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    articleUrl: ctx.keyword.spy_article_url,
  };
}

export interface SeoData {
  keyword: string;
  title: string;
  description: string;
  category: string;
  cuisine: string;
}

/** The taxonomy a recipe has to be filed under, read from the site. */
export interface SiteTaxonomy {
  categories: Category[];
  cuisines: Category[];
}

/**
 * The five prompts for one recipe: the hero, three moments of the method,
 * and the Pinterest graphic.
 *
 * `stepNumbers` is the model's answer to which steps deserve a photograph,
 * in the same order as stepA, stepB and stepC. The article attaches each
 * image to the step it names — spreading them evenly used to put one on the
 * serving step, which is the hero shot over again.
 */
export interface ImagePromptSet {
  hero: string;
  stepA: string;
  stepB: string;
  stepC: string;
  stepNumbers: number[];
  pinTitle: string;
  pin: string;
}

/** GET /api/categories on the target site. */
export const fetchCategories: Step<void, Category[]> = {
  name: 'fetch-categories',
  title: 'Fetch site categories',
  async run(ctx) {
    const categories = await ctx.siteApi.getCategories();
    if (categories.length === 0) {
      throw new Error(
        `${ctx.site.domain} returned no categories. The article cannot be filed without one.`,
      );
    }
    return categories;
  },
};

/**
 * GET /api/cuisines on the target site.
 *
 * Unlike the category list this one is allowed to come back empty: a site
 * that files nothing by cuisine is a site whose recipes simply have none,
 * and refusing to write the article over that would be wrong.
 */
export const fetchCuisines: Step<void, Category[]> = {
  name: 'fetch-cuisines',
  title: 'Fetch site cuisines',
  async run(ctx) {
    return ctx.siteApi.getCuisines();
  },
};

/**
 * Validate the spy source against the site's categories.
 *
 * The model answers with FALSE when the source is unusable. The original
 * routed that to "mark the keyword No"; we surface it as a typed outcome and
 * let the runner decide.
 */
export class SpyRejectedError extends Error {
  constructor(readonly detail: string) {
    super(`Spy source rejected during validation: ${detail}`);
    this.name = 'SpyRejectedError';
  }
}

export const validateSpy: Step<SiteTaxonomy, SeoData> = {
  name: 'validate-spy',
  title: 'Validate spy source and derive SEO',
  async run(ctx, { categories, cuisines }) {
    if (!ctx.keyword.spy_title.trim()) {
      // Without it the only thing describing this row is the topic group, and
      // every recipe under that group would be written from the same words.
      throw new SpyRejectedError(
        'This keyword has no spy title, so there is nothing to say which dish it is. ' +
          'The seed keyword is a topic group, not a recipe.',
      );
    }

    const cuisineTitles = cuisines.map((c) => c.title);

    const result = await ctx.prompt('spy-validation', {
      spy: spyContext(ctx),
      categoryTitles: JSON.stringify(categories.map((c) => c.title)),
      cuisineTitles: JSON.stringify(cuisineTitles),
      site: { domain: ctx.site.domain },
    });

    if (result.content.includes('FALSE')) {
      throw new SpyRejectedError(result.content.slice(0, 300));
    }

    const required = ['keyword', 'title', 'description', 'category'];

    const parsed = await parseJsonOrRepair<Record<string, string>>(
      ctx,
      result.content,
      'Spy validation output',
      { requiredFields: required },
    );
    requireFields(parsed, required, 'Spy validation');

    const seo = {
      keyword: parsed.keyword!,
      title: parsed.title!,
      description: parsed.description!,
      category: parsed.category!,
      // The site rejects the whole post over a cuisine it does not know, so a
      // near-miss is corrected here rather than sent and refused three times.
      cuisine: matchTaxonomy(parsed.cuisine ?? '', cuisineTitles),
    };

    // Not fatal. A recipe filed under no cuisine is missing from one listing
    // page; a run killed over it loses the whole article.
    if (cuisineTitles.length > 0 && seo.cuisine === '') {
      log.warn(
        `run ${ctx.runId}: "${seo.title}" came back with the cuisine ` +
          `"${parsed.cuisine ?? ''}", which is not one of ${JSON.stringify(cuisineTitles)}. ` +
          'It will be published without a cuisine.',
      );
    }

    // The failure this whole change exists to stop, caught where it happens
    // rather than three steps later in a photograph. Not fatal: a genuinely
    // one-recipe topic will trip it, and refusing to write that article would
    // be worse than writing it.
    if (collapsedToGroup(seo.keyword, ctx.keyword.seed_keyword)) {
      log.warn(
        `run ${ctx.runId}: "${ctx.keyword.spy_title}" produced the keyword ` +
          `"${seo.keyword}", which is just the topic group "${ctx.keyword.seed_keyword}". ` +
          'Every recipe in that group will come out the same. Check the spy title, ' +
          'description and annotation are filled in for this keyword.',
      );
    }

    return { value: seo, endpoint: result.endpoint, model: result.model };
  },
};

/**
 * Snap a model's answer onto one of the site's own terms.
 *
 * Case and stray punctuation are not disagreements. A genuinely different
 * answer — "Algerian" where the site only has "North African" — returns
 * empty, which files the recipe with no cuisine rather than having the site
 * refuse the post outright. An empty list means the site files nothing by
 * cuisine, so there is nothing to match against.
 */
export function matchTaxonomy(value: string, allowed: string[]): string {
  const normalise = (text: string): string =>
    text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const wanted = normalise(value);
  if (wanted === '' || allowed.length === 0) return '';

  return allowed.find((title) => normalise(title) === wanted) ?? '';
}

export interface RecipeData {
  raw: string;
  parsed: Record<string, unknown>;
}

export const generateRecipe: Step<SeoData, RecipeData> = {
  name: 'generate-recipe',
  title: 'Generate recipe',
  async run(ctx, seo) {
    const style = normaliseStyle(ctx.site.writing_style);
    const spy = spyContext(ctx);

    // One draft, with an optional note appended to the research. Spelling is
    // put right here, in code, so what the three article parts are told to copy
    // word for word is already in the site's spelling.
    const draft = async (note: string) => {
      const result = await ctx.prompt('recipe-generator', {
        seo,
        style: styleBlocks(style),
        spy: note ? { ...spy, annotation: `${spy.annotation}\n\n${note}` } : spy,
      });
      // Parsed for validation; the raw string is what later prompts interpolate,
      // matching the original which passed Recipe generator's content through.
      const parsed = fixRecipeSpelling(
        await parseJsonOrRepair<Record<string, unknown>>(ctx, result.content, 'Recipe output'),
        style,
      );
      return { result, parsed };
    };

    let { result, parsed } = await draft('');

    // Two things are checked and either one earns the same single rewrite:
    //  - Halal only: the prompt asks for no alcohol or pork, this checks the
    //    answer, naming the offending word.
    //  - The recipe's own units and times: every later part is ordered to copy
    //    these numbers, so a Celsius-first oven or a total shorter than prep
    //    plus cook would be repeated three times over.
    // If either is still wrong the run stops before any image is paid for.
    let haram = haramAllIn(parsed);
    let problems = recipeProblems(parsed, style);

    // Every forbidden word is named, with where it sits: told only the first
    // one, a rewrite fixed "bacon" and kept the prosciutto in the FAQ.
    const halalNote = (words: string[]): string =>
      `YOUR LAST DRAFT USED ${words.map((w) => `“${w}”`).join(', ')}, WHICH IS NOT ALLOWED (Halal only). ` +
      'Write the recipe again with no alcohol and no pork anywhere — ingredients, steps, notes, tips, FAQ, title, description. ' +
      'Use the halal alternative (e.g. beef or turkey bacon, turkey ham, beef pepperoni, smoked turkey for cured pork, ' +
      'grape or apple juice or broth for alcohol) or leave it out. Found here:\n' +
      haramContexts(parsed, words).map((c) => `- ${c}`).join('\n');

    if (haram.length > 0 || problems.length > 0) {
      if (haram.length) log.warn(`recipe for “${seo.title}” used ${haram.join(', ')} despite Halal only: asking for a rewrite`);
      if (problems.length > 0) {
        log.warn(`recipe for “${seo.title}” broke ${problems.length} rule(s): ${problems.slice(0, 3).join('; ')}`);
      }

      const notes = [haram.length ? halalNote(haram) : '', recipeFeedback(problems)].filter(Boolean).join('\n\n');
      ({ result, parsed } = await draft(notes));

      // Halal gets one more try than the other rules: a recipe that is right in
      // every other way is not thrown away over one word left in a tip.
      haram = haramAllIn(parsed);
      if (haram.length) {
        log.warn(`recipe for “${seo.title}” still used ${haram.join(', ')}: asking for one last rewrite`);
        ({ result, parsed } = await draft(halalNote(haram)));
        haram = haramAllIn(parsed);
      }
      if (haram.length) throw new NotHalalError(seo.title, haram[0]!, 'recipe');

      problems = recipeProblems(parsed, style);
      if (problems.length > 0) throw new RecipeRulesError(seo.title, problems);
    }

    // What people ask Google about the dish rides along in the recipe JSON,
    // which every part of the article sees: the FAQ answers real questions.
    if (ctx.research?.questions.length) parsed.google_questions = ctx.research.questions.slice(0, 6);

    // The repaired document is what downstream prompts see. Passing the
    // original raw text on would hand every later step the same broken JSON
    // this step just spent a model call fixing.
    return {
      value: { raw: JSON.stringify(parsed), parsed },
      endpoint: result.endpoint,
      model: result.model,
    };
  },
};

export const generateImagePrompts: Step<
  { seo: SeoData; recipe: RecipeData },
  ImagePromptSet
> = {
  name: 'generate-image-prompts',
  title: 'Generate image prompts',
  async run(ctx, input) {
    // Setup -> Photo styles: the next shoot for this site, so its recipes do
    // not all look photographed on one afternoon. With every style switched
    // off the block is empty and the model chooses for itself, as it did
    // before this existed.
    let style: PhotoStyle | null = null;
    try {
      const history = sitePhotoHistory(ctx.site.id);
      style = pickPhotoStyle(listPhotoStyles(), history.recent, history.uses, ctx.site.id);
    } catch {
      style = null; // no database (offline tools)
    }

    const result = await ctx.prompt('image-prompts', {
      seo: input.seo,
      // The images have to show this dish, not a generic member of its topic
      // group, so the step that draws them sees the source too.
      spy: spyContext(ctx),
      recipe: { raw: input.recipe.raw },
      recipeJson: JSON.stringify(input.recipe.parsed),
      photoShoot: shootBlock(style),
    });

    if (style) {
      try { markRunPhotoStyle(ctx.runId, style.id); } catch { /* recorded only for the rotation */ }
    }

    const parsed = await parseJsonOrRepair<Record<string, string | number>>(
      ctx,
      result.content,
      'Image prompt output',
    );
    requireFields(
      parsed,
      ['hero', 'step_a', 'step_b', 'step_c', 'pin_title', 'pin'],
      'Image prompts',
    );

    return {
      value: {
        hero: String(parsed.hero),
        stepA: String(parsed.step_a),
        stepB: String(parsed.step_b),
        stepC: String(parsed.step_c),
        stepNumbers: [parsed.step_a_number, parsed.step_b_number, parsed.step_c_number].map(
          (n) => Number(n) || 0,
        ),
        pinTitle: String(parsed.pin_title),
        pin: String(parsed.pin),
      },
      endpoint: result.endpoint,
      model: result.model,
    };
  },
};

/** One extra method photograph: the recipe step it belongs to and its prompt. */
export interface ExtraStepShot {
  step: number;
  prompt: string;
}

/**
 * Prompts for the method photographs beyond the three the image prompts
 * chose, when Setup -> Photo styles asks for 5 or for every step.
 *
 * Which steps is decided in code (see core/step-photos.ts), so the model only
 * describes them. With the setting on 3, or nothing left to photograph, no
 * model is called and the answer is an empty list.
 *
 * A step the model skipped is simply left without a photograph: these are
 * extras, and the article is complete without them.
 */
export const generateExtraStepPrompts: Step<
  { seo: SeoData; recipe: RecipeData; prompts: ImagePromptSet },
  ExtraStepShot[]
> = {
  name: 'generate-extra-step-prompts',
  title: 'Generate extra method shot prompts',
  async run(ctx, input) {
    const mode = parseStepPhotoMode(ctx.settings.get('article_step_photos'));
    const wanted = extraStepNumbers(mode, recipeStepCount(input.recipe.parsed), input.prompts.stepNumbers);
    if (wanted.length === 0) return [];

    const result = await ctx.prompt('extra-step-shots', {
      title: input.seo.title,
      recipeJson: JSON.stringify(input.recipe.parsed),
      steps: wanted.map((n) => `Step ${n}: ${recipeStepText(input.recipe.parsed, n)}`).join('\n'),
      hero: input.prompts.hero,
      stepA: input.prompts.stepA,
      stepB: input.prompts.stepB,
      stepC: input.prompts.stepC,
    });

    const parsed = await parseJsonOrRepair<{ shots?: unknown }>(ctx, result.content, 'Extra method shot output');
    const shots = Array.isArray(parsed.shots) ? parsed.shots : [];

    const byStep = new Map<number, string>();
    for (const shot of shots) {
      if (!shot || typeof shot !== 'object') continue;
      const step = Math.trunc(Number((shot as Record<string, unknown>).step));
      const prompt = String((shot as Record<string, unknown>).prompt ?? '').trim();
      if (wanted.includes(step) && prompt !== '' && !byStep.has(step)) byStep.set(step, prompt);
    }

    const missing = wanted.filter((n) => !byStep.has(n));
    if (missing.length > 0) {
      log.warn(`run ${ctx.runId}: no prompt came back for step(s) ${missing.join(', ')}; they stay without a photograph`);
    }

    return {
      value: wanted.filter((n) => byStep.has(n)).map((step) => ({ step, prompt: byStep.get(step)! })),
      endpoint: result.endpoint,
      model: result.model,
    };
  },
};

/**
 * Did the model answer with the topic group instead of the dish?
 *
 * A research label like "chicken thighs" covers five different recipes. When
 * the derived keyword is that label and nothing more, every one of them writes
 * the same article and generates the same pictures — which is exactly the
 * symptom that led here.
 *
 * Compared on significant words so "Chicken Thighs" and "chicken thigh" are
 * the same answer, and "honey soy chicken thighs" is not.
 */
export function collapsedToGroup(keyword: string, group: string): boolean {
  const words = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .map((w) => w.replace(/s$/, ''))
        .filter((w) => w.length > 2),
    );

  const derived = words(keyword);
  const label = words(group);

  if (derived.size === 0 || label.size === 0) return false;

  // Adding nothing to the group's own words is the collapse. Any extra
  // significant word — a sauce, a method, a vessel — means it stayed specific.
  for (const word of derived) if (!label.has(word)) return false;
  return true;
}
