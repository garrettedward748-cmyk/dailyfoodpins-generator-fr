import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPromptOverride, listModelOverrides } from '../db/repos.js';

/**
 * Loads and renders the prompt files extracted verbatim from the n8n
 * workflow. The prompts are the product; they are stored as plain text so
 * they can be edited without touching code, and so a diff shows exactly what
 * changed about article quality.
 *
 * Template syntax is {{dotted.path}}. Nothing else is interpreted — no
 * expressions, no logic. Anything clever belongs in the step, not the prompt.
 */

export interface PromptPair {
  system: string;
  user: string;
}

let promptsDir = './prompts';
const cache = new Map<string, string>();

export function configurePrompts(dir: string): void {
  promptsDir = dir;
  cache.clear();
}

/** Drop the cache so the next render picks up an edit. */
export function invalidatePromptCache(): void {
  cache.clear();
  modelCache = null;
}

/** The prompt as shipped, ignoring any edit. */
export function readShippedPrompt(name: string): string {
  const path = resolve(promptsDir, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/**
 * An edit made in the UI wins over the shipped file.
 *
 * The files live inside the image, so editing them in a running container
 * lasts until the next redeploy and then silently reverts. The database is the
 * only place an edit survives, and the file remains the fallback — deleting
 * the override restores the shipped text exactly.
 *
 * Cached because a run renders a dozen prompts and this sits in the hot path;
 * saving an edit clears it.
 */
function readPromptFile(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  let text: string;
  try {
    text = getPromptOverride(name) ?? readShippedPrompt(name);
  } catch {
    // Rendering a prompt must not depend on the database being open — the
    // prompt tests and any offline tooling read these without one.
    text = readShippedPrompt(name);
  }

  cache.set(name, text);
  return text;
}

/** Look up a dotted path in a context object. */
function lookup(context: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || acc === undefined) return undefined;
    if (typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[part];
  }, context);
}

export function render(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path: string) => {
    const value = lookup(context, path);
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

/** Report placeholders a context does not satisfy, for diagnostics. */
export function missingVariables(
  template: string,
  context: Record<string, unknown>,
): string[] {
  const missing = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    const path = match[1];
    if (path && lookup(context, path) === undefined) missing.add(path);
  }
  return [...missing];
}

/**
 * Load a prompt pair by name, rendering both halves.
 * `name` matches the extracted files, e.g. "part-1" or "part-1.fallback".
 */
export function loadPrompt(name: string, context: Record<string, unknown>): PromptPair {
  return {
    system: render(readPromptFile(`${name}.system.txt`), context),
    user: render(readPromptFile(`${name}.user.txt`), context),
  };
}

export function loadTemplate(name: string, context: Record<string, unknown>): string {
  return render(readPromptFile(name), context);
}

/** Models each prompt was authored against, preserved from the workflow. */
export const PROMPT_MODELS: Record<string, { model: string; format: 'json' | null }> = {
  'spy-validation': { model: 'gpt-oss:120b', format: null },
  'recipe-generator': { model: 'gpt-oss:20b', format: null },
  'image-prompts': { model: 'gemma4:31b', format: null },
  'extra-step-shots': { model: 'gemma4:31b', format: 'json' },
  'part-1': { model: 'gemma4:31b', format: 'json' },
  'part-2': { model: 'gemma4:31b', format: 'json' },
  'part-3': { model: 'gemma4:31b', format: 'json' },
  'part-1.fallback': { model: 'gemma4:31b', format: 'json' },
  'part-2.fallback': { model: 'gemma4:31b', format: 'json' },
  'part-3.fallback': { model: 'gemma4:31b', format: 'json' },
  'pin-description': { model: 'gpt-oss:120b', format: null },
  'pick-board': { model: 'gpt-oss:120b', format: null },
  'repair-json': { model: 'gpt-oss:120b', format: null },
  'reel-caption': { model: 'gpt-oss:120b', format: null },
  'reel-plan': { model: 'gpt-oss:120b', format: 'json' },
  'reel-steps': { model: 'gpt-oss:120b', format: 'json' },
  'reel-process': { model: 'gpt-oss:120b', format: 'json' },
  'reel-hands': { model: 'gpt-oss:120b', format: null },
  'blog-article': { model: 'gpt-oss:120b', format: 'json' },
  'blog-questions': { model: 'gpt-oss:120b', format: 'json' },
  'site-page': { model: 'gpt-oss:120b', format: 'json' },
  'site-page-facts': { model: 'gpt-oss:120b', format: 'json' },
  'facebook-post': { model: 'gpt-oss:120b', format: null },
  'comment-keyword': { model: 'gpt-oss:120b', format: null },
  'collage-steps': { model: 'gpt-oss:120b', format: 'json' },
  'collage-caption': { model: 'gpt-oss:120b', format: null },
  'instagram-post': { model: 'gpt-oss:120b', format: null },
  'suggest-boards': { model: 'gpt-oss:120b', format: 'json' },
  'suggest-account-names': { model: 'gpt-oss:120b', format: 'json' },
  'research-filter': { model: 'gpt-oss:120b', format: 'json' },
  'queue-check': { model: 'gpt-oss:120b', format: 'json' },
  'recipe-tools': { model: 'gpt-oss:120b', format: 'json' },
  'gsc-classify': { model: 'gpt-oss:120b', format: 'json' },
  'radar-sort': { model: 'gpt-oss:120b', format: 'json' },
  'pin-ideas': { model: 'gpt-oss:120b', format: 'json' },
  'taxonomy-fill': { model: 'gpt-oss:120b', format: 'json' },
  'research-topics': { model: 'gpt-oss:120b', format: 'json' },
  'extra-post': { model: 'gpt-oss:120b', format: 'json' },
  'serp-brief': { model: 'gpt-oss:120b', format: null },
  'cook-suggestions': { model: 'gpt-oss:120b', format: 'json' },
};

/* -------------------------------------------------------------------------
 * Which model runs which prompt
 * ---------------------------------------------------------------------- */

/**
 * PROMPT_MODELS above is the shipped default, taken from the original
 * workflow. A row in model_overrides replaces one entry of it.
 *
 * Cached alongside the prompt bodies and cleared by the same call, because a
 * run resolves a dozen of these and neither is worth a query each time.
 */
let modelCache: Map<string, string> | null = null;

function overrides(): Map<string, string> {
  if (modelCache) return modelCache;

  try {
    modelCache = listModelOverrides();
  } catch {
    // Same reason as readPromptFile: rendering must not require a database.
    modelCache = new Map();
  }
  return modelCache;
}

/** The model a prompt should be sent to, override first. */
export function modelFor(promptName: string): string {
  const chosen = overrides().get(promptName);
  if (chosen && chosen.trim()) return chosen.trim();
  return PROMPT_MODELS[promptName]?.model ?? 'gemma4:31b';
}

/** Every prompt that has a model, with its default and any override. */
export function modelChoices(): {
  prompt: string;
  shipped: string;
  effective: string;
  overridden: boolean;
}[] {
  const chosen = overrides();

  return Object.entries(PROMPT_MODELS)
    .map(([prompt, spec]) => {
      const override = chosen.get(prompt)?.trim() ?? '';
      return {
        prompt,
        shipped: spec.model,
        effective: override || spec.model,
        overridden: override !== '' && override !== spec.model,
      };
    })
    .sort((a, b) => a.prompt.localeCompare(b.prompt));
}

/**
 * Models the shipped configuration mentions, for the editor's suggestions.
 *
 * Not a validated allow-list — a self-hosted Ollama can serve anything, and
 * refusing a model name because it is not in a hardcoded array would be the
 * kind of check that only ever gets in the way.
 */
export const KNOWN_MODELS = [...new Set(Object.values(PROMPT_MODELS).map((m) => m.model))].sort();
