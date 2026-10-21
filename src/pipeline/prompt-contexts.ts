/**
 * What each prompt is allowed to reference.
 *
 * A prompt is plain text, so a placeholder no step supplies renders as an empty
 * string rather than raising anything — the article quietly comes out worse and
 * nothing says why. Two shipped that way before this existed: `spy.annotation`
 * in pin-description and `site.domain` in the pin graphic template.
 *
 * This is the single source of truth for that contract. The build asserts every
 * placeholder in every prompt file appears here, and the prompt editor lists
 * these to whoever is writing one and flags anything else on save.
 *
 * Adding a placeholder to a prompt means adding it here *and* passing it from
 * the step that renders that prompt.
 */

import { structureBlocks } from '../core/article-structures.js';
import { bannedList } from '../core/article-rules.js';
import { timeBlocks } from '../core/recipe-times.js';
import { styleBlocks } from '../core/writing-style.js';
import { blogShape } from '../core/blog-structures.js';
import { captionShape } from '../core/caption-structures.js';
import { reelShape } from '../core/reel-structures.js';

/** The tokens a site fills into its static pages, as the literal text the page must carry. */
export const SITE_PAGE_PLACEHOLDERS = {
  site_name: '{{site_name}}',
  domain: '{{domain}}',
  site_url: '{{site_url}}',
  email: '{{email}}',
  author: '{{author}}',
  updated: '{{updated}}',
};

/** A sample value per variable. Shape matters; the values are placeholders. */
const SEO = { keyword: 'k', title: 't', description: 'd', category: 'c', cuisine: 'n' };
/**
 * What the operator's own research says about this one recipe.
 *
 * `group` is the seed keyword — a label many recipes share, passed only so a
 * prompt can be told to ignore it. It shipped as the sole subject of the whole
 * pipeline once, which made every recipe in a group come out the same.
 */
const SPY = {
  title: 't',
  description: 'd',
  annotation: 'a',
  articleUrl: 'u',
  group: 'g',
};

/**
 * No images here on purpose. The article prompts used to be handed the
 * uploaded paths so they could copy them into their output, and a model that
 * mistyped one published a recipe with a broken photograph. The paths are
 * attached in code after the parts are merged instead.
 */
const ARTICLE_CONTEXT = {
  seo: SEO,
  // The site the article is for, by name: the prompts no longer carry one site's brand.
  site: { name: 'n', domain: 'example.com' },
  recipe: { raw: '{}' },
  // The site's spelling and units, the recipe's times, the words no article
  // may use, and — on a retry only — what the last draft got wrong.
  style: styleBlocks('fr'),
  times: timeBlocks({ prep: 10, cook: 12, rest: 5, total: 27, adjusted: false }, 'fr'),
  rules: { banned: bannedList('fr') },
  feedback: '',
  // The chosen shape, which part 1 and part 3 interpolate. The sample carries
  // the shipped default rather than an empty string, because an empty one
  // would make the prompt preview show a heading with nothing under it.
  ...structureBlocks(null),
};

export const STEP_CONTEXTS: Record<string, Record<string, unknown>> = {
  'spy-validation': {
    spy: SPY,
    categoryTitles: '[]',
    cuisineTitles: '[]',
    site: { domain: 'example.com' },
  },
  'recipe-generator': { seo: SEO, spy: SPY, style: styleBlocks('us') },
  // photoShoot is the chosen shoot, or '' when every style is switched off —
  // which is the state the placeholder has to leave no trace in.
  'image-prompts': { seo: SEO, spy: SPY, recipe: { raw: '{}' }, recipeJson: '{}', photoShoot: '' },
  'extra-step-shots': { title: 'Lemon Bars', recipeJson: '{}', steps: 'Step 2: Press the crust into the pan.', hero: 'the bars', stepA: 'the crust', stepB: 'the filling', stepC: 'the cut bars' },
  'pin-description': {
    seo: SEO,
    cta: 'Try it!',
    site: { domain: 'example.com' },
    spy: SPY,
  },
  'facebook-post': { seo: SEO },
  'collage-caption': { seo: SEO },
  'comment-keyword': { title: 'Lemon Bars' },
  'collage-steps': { title: 'Lemon Bars', recipe: '{}', count: 9, note: '' },
  'instagram-post': { seo: SEO, linkLine: 'La recette complète : lien en bio' },
  'cook-suggestions': { title: 'Strawberry Pie', recipe: '- 2 cups strawberries', notes: '(none yet)', experiences: '[S1] example.com\n- Drained the frozen berries first.' },
  'serp-brief': { keyword: 'banana pudding', questions: '- Can you freeze banana pudding?', pages: '[Page 1] ...' },
  'research-topics': { niche: 'dessert', today: 'October 1, 2026', candidates: '- dessert bars\n- dessert cups', siteMix: '- Cheesecakes: 12 recipes' },
  'extra-post': {
    site: { name: 'n' },
    seo: SEO,
    angle: { label: 'Quick weeknight', brief: 'how fast and easy it is' },
    shapeRule: '',
    halal: '',
  },
  'research-filter': { seed: 'pasta', items: '1. pasta carbonara\n2. pasta garage' },
  'recipe-tools': { title: 'Lemon Bars', recipe: '{}' },
  'taxonomy-fill': {
    site: { name: 'Arbmom', domain: 'example.com' }, kind: 'category', name: 'Breakfast', url: 'https://example.com/category/breakfast', count: 12,
    fields: 'title_tag, meta_desc, intro_html, body_html', recipes: '- Lemon Bars — /recipe/lemon-bars', halal: '',
  },
  'gsc-classify': { items: '1. can you freeze lemon bars (120 impressions; /recipe/lemon-bars)' },
  'radar-sort': { items: '1. [430 engagement] Nobody tells you lemon bars freeze whole, crust and all.' },
  'pin-ideas': { pins: '1. Easy Pizza Bites — 4855 impressions, 120 saves, 40 pin clicks, 12 outbound clicks', count: 12, existing: '- Lemon Bars' },
  'queue-check': { items: '1. Lemon Bars [dessert]\n2. christmas dessert recipes [dessert]' },
  'suggest-account-names': { site: { name: 'n', domain: 'example.com' }, boards: '- Cheesecake Recipes', groups: '- cheesecake', taken: '- recipesbuzz' },
  'suggest-boards': { site: { name: 'n', domain: 'example.com' }, groups: '- dessert: Lemon Bars', existing: '- Easy Dessert Recipes' },
  'pick-board': { seo: SEO, topic: 'dessert', boardsJson: '{}' },
  'repair-json': { postError: 'e', articleJson: '{}' },
  // No url on purpose: the link goes in the first comment, never the caption.
  'reel-caption': { seo: SEO, spy: SPY, captionShape: captionShape(null) },
  'reel-video.template': { seo: SEO, presenter: { name: 'n', voice: 'v' }, cta: 'c', reelShape: reelShape(null) },
  'reel-process': { title: 'Lemon Bars', recipe: '{}', photos: 'hero: the bars', sources: 'hero, stepA', count: 8, note: '' },
  'reel-hands': { title: 'Lemon Bars', recipe: '{}' },
  'reel-didyouknow': { title: 'Lemon Bars', recipe: '{}' },
  'reel-steps': { title: 'Lemon Bars', stepA: 'the crust pressed into the pan', stepB: 'the filling poured over', stepC: 'the bars cut into squares', recipe: '{}' },
  'reel-plan': {
    article: { title: 't', recipe: 'r', imagePrompts: 'feature: f' },
    sources: 'feature',
    presenter: { name: 'n', voice: 'v' },
    format: { key: 'k', title: 'f', shape: 's' },
    scenes: 3,
    targetSeconds: 30,
    cta: 'c',
    note: '',
  },
  'blog-article': {
    site: { name: 'n', domain: 'example.com' },
    question: 'q',
    links: '- recipe: https://example.com/recipe/x',
    recipe: { title: 't', summary: 's' },
    research: '[Source 1] Title (https://example.com)\nNotes',
    // The chosen shape; the sample carries the shipped default so the prompt
    // preview shows a real one rather than a heading with nothing under it.
    blogShape: blogShape(null),
    style: styleBlocks('us'),
  },
  'blog-questions': {
    site: { name: 'n' },
    recipes: '- t',
    existing: '- q',
    count: 10,
  },
  'site-page': {
    site: { name: 'n', domain: 'example.com' },
    page: { title: 'About', spec: 's' },
    // The tokens the site fills in, passed through as themselves: written in a
    // prompt as {{site_name}} they would be rendered here, as empty strings.
    ph: SITE_PAGE_PLACEHOLDERS,
    facts: '- Author: a',
    content: '12 recipes',
    notes: '',
    style: styleBlocks('us'),
  },
  'site-page-facts': {
    site: { name: 'n' },
    content: '12 recipes',
    notes: '',
    style: styleBlocks('us'),
  },
};

for (const part of ['part-1', 'part-2', 'part-3']) {
  STEP_CONTEXTS[part] = ARTICLE_CONTEXT;
  STEP_CONTEXTS[`${part}.fallback`] = ARTICLE_CONTEXT;
}

/**
 * Templates rendered on their own, rather than as a system/user prompt pair.
 *
 * They are not sent to an LLM -- they are assembled and handed to an image or
 * video model -- so they have no entry in PROMPT_MODELS. They still need their
 * variables declared, because the placeholder check is the only thing standing
 * between a renamed field and a prompt that silently renders "{{seo.titel}}"
 * into a paid generation.
 */
export const TEMPLATE_CONTEXTS: Record<string, Record<string, unknown>> = {
  'pin-graphic.template': {
    seo: SEO,
    pinTitle: 'Layer By Layer',
    site: { domain: 'example.com' },
    imagePrompts: { pin: 'a vertical photograph' },
  },
};

/** Kept for the callers that named it before there was more than one. */
export const PIN_GRAPHIC_CONTEXT = TEMPLATE_CONTEXTS['pin-graphic.template']!;

/** Flatten a context into the dotted paths a template may use. */
function dottedPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return prefix ? [prefix] : [];

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    dottedPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** Every variable this prompt may reference, sorted. Empty if unknown. */
export function variablesFor(promptName: string): string[] {
  const context = TEMPLATE_CONTEXTS[promptName] ?? STEP_CONTEXTS[promptName];
  return context ? dottedPaths(context).sort() : [];
}

/** Placeholders in `body` that the step behind `promptName` does not supply. */
export function unknownVariables(promptName: string, body: string): string[] {
  const allowed = new Set(variablesFor(promptName));
  if (allowed.size === 0) return [];

  const used = new Set<string>();
  for (const match of body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    const path = match[1];
    if (path && !allowed.has(path)) used.add(path);
  }
  return [...used];
}
