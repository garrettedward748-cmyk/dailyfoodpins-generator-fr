import type { Step } from '../engine.js';
import type { PostedRecipe } from '../../integrations/site-api.js';
import { haramWord } from '../../core/halal.js';
import { parseJson } from '../json.js';

export interface RecipeToolsInput {
  title: string;
  recipe: unknown;
  posted: PostedRecipe;
}

export type RecipeToolsOutput = { tools: { name: string; search: string }[] } | { skipped: string };

/**
 * The kitchen tools the recipe uses, sent to the site for its "Tools I used"
 * box -- which the site shows, with Amazon links, once Settings there has an
 * Associates tracking ID. One small model call after publishing; never the
 * reason a run fails.
 */
export const recipeToolsStep: Step<RecipeToolsInput, RecipeToolsOutput> = {
  name: 'recipe-tools',
  title: 'List the tools used (affiliate box)',
  async run(ctx, input) {
    if (!ctx.settings.getBool('recipe_tools_enabled')) return { skipped: 'Tools box is off (Setup → General)' };
    const id = String((input.posted as { id?: unknown }).id ?? '');
    if (!id) return { skipped: 'the site gave no recipe id' };

    const answer = await ctx.prompt('recipe-tools', {
      title: input.title,
      recipe: (typeof input.recipe === 'string' ? input.recipe : JSON.stringify(input.recipe ?? {})).slice(0, 8000),
    });
    const parsed = parseJson(answer.content, 'the tools list') as { tools?: { name?: unknown; search?: unknown }[] };
    const tools = (parsed.tools ?? [])
      .map((t) => ({ name: String(t.name ?? '').trim().slice(0, 80), search: String(t.search ?? t.name ?? '').trim().slice(0, 100) }))
      .filter((t) => t.name && !haramWord(`${t.name} ${t.search}`))
      .slice(0, 6);
    if (tools.length === 0) return { skipped: 'no tools found in the recipe' };

    await ctx.siteApi.setRecipeTools(id, tools);
    return { tools };
  },
};
