import { chat, type ChatResult } from './client.js';
import { loadPrompt, modelFor, PROMPT_MODELS } from '../pipeline/prompts.js';
import type { Settings } from '../settings.js';

/**
 * Send one named prompt to the model it is assigned to.
 *
 * The pipeline context does this per step and adds the tokens to the step's
 * bill; the reel engine has no step to bill and calls this directly. One
 * implementation, so an override on the Prompts page reaches both.
 */
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

  return chat(
    {
      // modelFor applies any override set on the Prompts page; the shipped
      // default underneath it is still PROMPT_MODELS.
      model: overrides.model ?? modelFor(promptName),
      messages,
      format: overrides.format !== undefined ? overrides.format : (spec?.format ?? null),
    },
    encryptionKey,
    settings.get('llm_base_url'),
  );
}
