import { chat, type ChatResult } from './client.js';
import { currentGeminiChat, withGeminiChat } from './gemini.js';
import { loadPrompt, modelFor, PROMPT_MODELS } from '../pipeline/prompts.js';
import type { Settings } from '../settings.js';

/**
 * Send one named prompt to the model it is assigned to.
 *
 * The pipeline context does this per step and adds the tokens to the step's
 * bill; the reel engine has no step to bill and calls this directly. One
 * implementation, so an override on the Prompts page reaches both.
 */
/**
 * The prompts that write the article itself, each building on the one before
 * (the recipe, its pictures' prompts, the three parts). They share the
 * article's one Gemini chat, so the article keeps its context.
 *
 * Everything else asked during the article -- checks, research, pins, social
 * posts, boards, reels, JSON repair -- carries what it needs in its own words
 * and goes to a short chat of its own. Gemini counts the whole chat against
 * the account's limit on every prompt, so a chat that also held all of those
 * made each later prompt dearer and spent the limit in a few articles.
 */
export const ARTICLE_CHAT_PROMPTS = new Set([
  'recipe-generator',
  'image-prompts',
  'extra-step-shots',
  'part-1',
  'part-2',
  'part-3',
  'part-1.fallback',
  'part-2.fallback',
  'part-3.fallback',
]);

export async function askPrompt(
  settings: Settings,
  encryptionKey: Buffer,
  promptName: string,
  variables: Record<string, unknown>,
  overrides: { model?: string; format?: 'json' | null } = {},
): Promise<ChatResult> {
  const spec = PROMPT_MODELS[promptName];
  const { system, user } = loadPrompt(promptName, variables);

  const messages = system.trim()
    ? [
        { role: 'system' as const, content: system },
        { role: 'user' as const, content: user },
      ]
    : [{ role: 'user' as const, content: user }];

  const send = () => chat(
    {
      // modelFor applies any override set on the Prompts page; the shipped
      // default underneath it is still PROMPT_MODELS.
      model: overrides.model ?? modelFor(promptName),
      // Where a prompt switched to Gemini goes when Gemini cannot answer it.
      fallbackModel: spec?.model,
      messages,
      format: overrides.format !== undefined ? overrides.format : (spec?.format ?? null),
    },
    encryptionKey,
    settings.get('llm_base_url'),
  );
  // Inside an article, only the article's own prompts go to its chat.
  return currentGeminiChat() && !ARTICLE_CHAT_PROMPTS.has(promptName) ? withGeminiChat('', send) : send();
}
