import { GeminiClient, GeminiError, type GeminiReply } from '../integrations/gemini.js';
import type { Settings } from '../settings.js';
import type { ChatMessage, ChatRequest, Completion } from './client.js';

/**
 * Gemini as a model the prompts can be sent to.
 *
 * A prompt whose model is GEMINI_MODEL (set from Platform settings, stored as an ordinary model
 * override) is answered by Gemini in the image service's browser instead of the AI keys. It is
 * deliberately not an AI key: a key with no model list serves every model, so a Gemini key would
 * take prompts meant for the others, and its secret comes from the deployment, not from a person.
 *
 * Anything that stops Gemini answering -- signed out, daily limit, a reply that is not JSON when
 * JSON was asked for -- is thrown, and chat() then sends the same prompt to its usual model. A
 * Gemini session that needs attention must never be the reason nothing publishes.
 */

export const GEMINI_MODEL = 'gemini';

/** Platform settings keys holding the last outcome, for the status badge. */
export const GEMINI_LAST_OK = 'gemini_last_ok_at';
export const GEMINI_LAST_ERROR = 'gemini_last_error';

interface GeminiSetup {
  settings: Settings;
  /** The Google account Gemini should answer as; empty for the browser's default account. */
  account: () => string;
  fetchImpl?: typeof fetch;
}

let setup: GeminiSetup | null = null;

/** Called once at start-up, so chat() can reach the image service without being handed Settings. */
export function configureGemini(next: GeminiSetup | null): void {
  setup = next;
}

export function geminiClient(settings: Settings, fetchImpl?: typeof fetch): GeminiClient | null {
  const baseUrl = settings.get('image_base_url').trim();
  const apiKey = settings.get('image_api_key').trim();
  if (!baseUrl || !apiKey) return null;
  return new GeminiClient({ baseUrl, apiKey, fetchImpl });
}

/** Remember how the last prompt went: the time it worked, or why it did not. */
export function recordGeminiOutcome(settings: Settings, error: string | null): void {
  if (error) {
    settings.set(GEMINI_LAST_ERROR, `${new Date().toISOString()} ${error.slice(0, 300)}`);
  } else {
    settings.set(GEMINI_LAST_OK, new Date().toISOString());
    settings.set(GEMINI_LAST_ERROR, '');
  }
}

/**
 * The messages as one prompt. Gemini's page has a single box, so the instructions go first and
 * the request after them; a JSON prompt also says how the answer must come back.
 */
export function joinMessages(messages: ChatMessage[], format: 'json' | null | undefined): string {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content.trim()).filter(Boolean);
  const rest = messages.filter((m) => m.role !== 'system').map((m) => m.content.trim()).filter(Boolean);
  const parts = [
    ...(system.length ? [`Instructions:\n${system.join('\n\n')}`] : []),
    ...(rest.length ? [system.length ? `Request:\n${rest.join('\n\n')}` : rest.join('\n\n')] : []),
  ];
  if (format === 'json') {
    parts.push('Answer with valid JSON only, in one ```json code block, with no other text.');
  }
  return parts.join('\n\n');
}

/** The JSON in a reply: its code block when it has one, else the outermost braces in its text. */
export function jsonFrom(reply: Pick<GeminiReply, 'code_blocks' | 'text' | 'markdown'>): string {
  const candidates = [
    ...reply.code_blocks.filter((b) => b.language === 'json').map((b) => b.code),
    ...reply.code_blocks.map((b) => b.code),
    reply.text,
    reply.markdown,
  ];
  for (const candidate of candidates) {
    const text = candidate.trim();
    const start = text.search(/[[{]/);
    if (start < 0) continue;
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (end <= start) continue;
    const slice = text.slice(start, end + 1);
    try {
      JSON.parse(slice);
      return slice;
    } catch {
      /* try the next candidate */
    }
  }
  throw new GeminiError('Gemini did not answer with valid JSON', 'NOT_JSON');
}

// What Gemini says instead of an answer. Short replies only: a long one that merely mentions a
// limit is an answer.
const NOT_AN_ANSWER =
  /reached your (daily )?limit|you('ve| have) reached the (daily )?limit|limit resets|try again (later|tomorrow)|I('m| am) (not able|unable) to help|I can('|’)t help with (that|this)|I('m| am) just a language model/i;

/** Why a reply cannot be used as an answer, or null when it can. */
export function unusableReply(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 2) return 'Gemini gave an empty answer';
  if (trimmed.length < 600 && NOT_AN_ANSWER.test(trimmed)) return `Gemini did not answer: ${trimmed.slice(0, 160)}`;
  return null;
}

/** Ask Gemini for one completion. Throws when it cannot give a usable one. */
export async function geminiCompletion(request: ChatRequest): Promise<Completion> {
  if (!setup) throw new GeminiError('Gemini is not set up in this process', 'SETUP');
  const { settings } = setup;
  const client = geminiClient(settings, setup.fetchImpl);
  if (!client) throw new GeminiError('The image service is not configured, and Gemini runs there', 'SETUP');

  try {
    const reply = await client.ask({
      prompt: joinMessages(request.messages, request.format),
      account: setup.account(),
      temporary: true,
      images: false,
      timeoutS: Math.round((request.timeoutMs ?? 300_000) / 1000),
    });
    const problem = unusableReply(reply.text);
    if (problem) throw new GeminiError(problem, 'NOT_AN_ANSWER');
    const content = request.format === 'json' ? jsonFrom(reply) : reply.markdown || reply.text;
    recordGeminiOutcome(settings, null);
    return { content, tokensIn: 0, tokensOut: 0 };
  } catch (err) {
    const error = err instanceof GeminiError ? err : new GeminiError(err instanceof Error ? err.message : String(err));
    recordGeminiOutcome(settings, `${error.code}: ${error.message}`);
    throw error;
  }
}
