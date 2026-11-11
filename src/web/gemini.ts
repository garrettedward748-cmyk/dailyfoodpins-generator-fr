import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { setModelOverride } from '../db/repos.js';
import { GeminiError, type GeminiFile, type GeminiReply } from '../integrations/gemini.js';
import { GEMINI_LAST_ERROR, GEMINI_LAST_OK, GEMINI_MODEL, geminiClient, recordGeminiOutcome } from '../llm/gemini.js';
import { invalidatePromptCache, modelFor, PROMPT_MODELS } from '../pipeline/prompts.js';
import type { Settings } from '../settings.js';
import type { Html } from './views/layout.js';
import { geminiPage } from './views/gemini.js';

/**
 * Setup -> Gemini: whether it works, which steps use it, and a box to try it.
 *
 * Gemini needs nothing set up of its own. It runs in the image service's browser, beside Google
 * Flow, signed in with the Google account that browser is on, and its extension is installed with
 * the image service. So this page has one decision on it -- which steps Gemini writes -- and that
 * is off for every step until someone ticks one, so an installation behaves exactly as before.
 */

export interface GeminiStage {
  title: string;
  about: string;
  prompts: string[];
}

/**
 * The steps Gemini can be switched on for, each a group of prompts. Every prompt in PROMPT_MODELS
 * sits in exactly one group (a test holds this), so a new prompt has to be placed here.
 */
export const GEMINI_STAGES: GeminiStage[] = [
  {
    title: 'Social posts',
    about: 'Pin descriptions, Facebook and Instagram posts, reel and collage captions, board picks.',
    prompts: ['pin-description', 'pick-board', 'facebook-post', 'instagram-post', 'reel-caption', 'collage-caption', 'comment-keyword'],
  },
  {
    title: 'Recipe and article',
    about: 'The recipe itself and the three parts of the article, with their fallbacks.',
    prompts: ['spy-validation', 'recipe-generator', 'part-1', 'part-2', 'part-3', 'part-1.fallback', 'part-2.fallback', 'part-3.fallback', 'recipe-tools', 'serp-brief'],
  },
  {
    title: 'Picture prompts',
    about: 'The text prompts sent to Flow for the photos and step shots.',
    prompts: ['image-prompts', 'extra-step-shots'],
  },
  {
    title: 'Reels and collages',
    about: 'Reel plans, steps, hands and did-you-know scripts, and collage steps.',
    prompts: ['reel-plan', 'reel-steps', 'reel-process', 'reel-hands', 'reel-didyouknow', 'collage-steps'],
  },
  {
    title: 'Blog and site pages',
    about: 'Blog articles and questions, site pages, extra posts.',
    prompts: ['blog-article', 'blog-questions', 'site-page', 'site-page-facts', 'extra-post'],
  },
  {
    title: 'Research and housekeeping',
    about: 'Research, radar, Search Console sorting, queue checks, categories, suggestions, JSON repair.',
    prompts: [
      'research-filter', 'research-topics', 'radar-sort', 'gsc-classify', 'queue-check', 'taxonomy-fill',
      'pin-ideas', 'suggest-boards', 'suggest-account-names', 'cook-suggestions', 'repair-json',
    ],
  },
].map((s) => ({ ...s, prompts: s.prompts.filter((p) => p in PROMPT_MODELS) }));

/** The stages whose every prompt is answered by Gemini. */
export function geminiStages(): string[] {
  return GEMINI_STAGES.filter((s) => s.prompts.length && s.prompts.every((p) => modelFor(p) === GEMINI_MODEL)).map((s) => s.title);
}

/**
 * Turn Gemini on for the named stages and off for the rest. Turning a stage off removes only the
 * Gemini choice: a prompt someone pointed at another model on the Prompts page keeps it.
 */
export function setGeminiStages(titles: string[]): void {
  const on = new Set(titles);
  for (const stage of GEMINI_STAGES) {
    for (const prompt of stage.prompts) {
      if (on.has(stage.title)) setModelOverride(prompt, GEMINI_MODEL);
      else if (modelFor(prompt) === GEMINI_MODEL) setModelOverride(prompt, '');
    }
  }
  invalidatePromptCache();
}

/**
 * The Google account Gemini asks as: always the one the image service's browser is on.
 *
 * Here every Google account has its own Chrome profile and only one runs at a time (see
 * services/imagegen/agent/accounts.py), so the browser holds exactly one Google sign-in and there
 * is nothing to choose between. Empty means "whoever is signed in"; the extension then opens
 * Gemini without ?authuser and does not check the email.
 */
export function geminiAccount(): string {
  return '';
}

/** Plain words for a failure code from the Gemini page. */
export function geminiProblem(code: string, message: string): string {
  switch (code) {
    case 'NOT_SIGNED_IN':
      return 'No Google account is signed in to Gemini. Open the Browser page and sign in to Google.';
    case 'WRONG_ACCOUNT':
      return `${message} The Browser page is where accounts are signed in.`;
    case 'TIMEOUT':
      return 'Gemini did not answer in time. Try again in a minute.';
    case 'LIMIT':
      return `${message}. The Gemini account's free plan allows only so many prompts; it answers again after the reset, or with another Google account.`;
    case 'NOT_AN_ANSWER':
    case 'NOT_JSON':
      return `${message}. The step used your AI keys instead.`;
    case 'GONE':
      return 'The image service restarted while Gemini was answering. Send it again.';
    case 'KEY':
    case 'SERVICE':
    case 'SETUP':
      return `The image service, where Gemini runs, is not answering properly: ${message}`;
    default:
      return message;
  }
}

export interface GeminiState {
  kind: 'ok' | 'bad' | 'idle';
  label: string;
  detail: string;
}

/** The badge and the line under it, from the last prompt's outcome and the service's answer. */
export async function geminiState(settings: Settings, fetchImpl?: typeof fetch): Promise<GeminiState> {
  const client = geminiClient(settings, fetchImpl);
  if (!client) return { kind: 'bad', label: 'Not available', detail: 'The image service is not configured, and Gemini runs there.' };
  let live: Awaited<ReturnType<typeof client.status>>;
  try {
    live = await client.status();
  } catch {
    return { kind: 'bad', label: 'Not answering', detail: 'The image service is not answering. Gemini runs there, beside Google Flow.' };
  }
  // What the service sees now, which a stored "last prompt failed" cannot say:
  // whether the Gemini extension is there at all, and how much is waiting.
  const queue = `${live.queued} prompt(s) waiting, ${live.running} being answered.`;
  if (!live.extension_connected && live.queued + live.running > 0) {
    return {
      kind: 'bad',
      label: 'Gemini page not connected',
      detail: `${queue} The Gemini page in the image service's browser is not picking prompts up: open the Browser page and check that a gemini.google.com window is open and signed in (it opens itself when Chrome starts; restarting Chrome from the Browser page brings it back).`,
    };
  }

  const okAt = settings.get(GEMINI_LAST_OK);
  const failed = settings.get(GEMINI_LAST_ERROR);
  if (failed) {
    const [at = '', ...rest] = failed.split(' ');
    const { code, message } = GeminiError.from(rest.join(' '));
    return {
      kind: 'bad',
      label: code === 'NOT_SIGNED_IN' || code === 'WRONG_ACCOUNT' ? 'Sign-in needed' : 'Last prompt failed',
      detail: `${geminiProblem(code, message)} (${at.slice(0, 16).replace('T', ' ')}). Now: ${queue}`,
    };
  }
  if (okAt) return { kind: 'ok', label: 'Working', detail: `Last answer ${okAt.slice(0, 16).replace('T', ' ')}.` };
  return { kind: 'idle', label: 'Not tried yet', detail: 'Send a test message below to check it.' };
}

const many = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)]);

/** What the page shows of a reply; pictures only as data (their blob: addresses mean nothing here). */
const forPage = (reply: GeminiReply) => ({
  text: reply.text,
  markdown: reply.markdown,
  code_blocks: reply.code_blocks,
  images: reply.images.filter((i) => i.data_base64).map((i) => ({ alt: i.alt, mime: i.mime, data_base64: i.data_base64 })),
});

type Flash = { kind: 'ok' | 'error' | 'warn'; message: string } | null;

export interface GeminiRouteDeps {
  settings: Settings;
  fetchImpl?: typeof fetch;
  /** Puts a body in the app's layout (server.ts's `page`). */
  render: (reply: FastifyReply, body: Html, flash: Flash) => FastifyReply;
  readFlash: (query: unknown) => Flash;
}

export function registerGeminiRoutes(app: FastifyInstance, deps: GeminiRouteDeps): void {
  const { settings } = deps;
  const client = () => geminiClient(settings, deps.fetchImpl);

  app.get('/settings/gemini', async (request, reply) => {
    const state = await geminiState(settings, deps.fetchImpl);
    return deps.render(reply, geminiPage(state, GEMINI_STAGES, geminiStages()), deps.readFlash(request.query));
  });

  app.post('/settings/gemini/steps', async (request: FastifyRequest, reply) => {
    const known = new Set(GEMINI_STAGES.map((s) => s.title));
    const picked = many((request.body as Record<string, unknown> | undefined)?.stage).filter((t) => known.has(t));
    setGeminiStages(picked);
    const message = picked.length ? `Gemini now writes: ${picked.join(', ')}.` : 'Gemini writes nothing now. Your AI keys write every step.';
    return reply.redirect(`/settings/gemini?ok=${encodeURIComponent(message)}`, 303);
  });

  app.post('/settings/gemini/ask', async (request: FastifyRequest, reply) => {
    const body = (request.body ?? {}) as { prompt?: unknown; files?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, 100_000) : '';
    const files = (Array.isArray(body.files) ? body.files : [])
      .filter((f): f is GeminiFile => Boolean(f && typeof f.name === 'string' && typeof f.mime === 'string' && typeof f.base64 === 'string'))
      .slice(0, 10);
    if (!prompt.trim() && !files.length) return reply.status(400).send({ error: 'Write a message or attach a file first.' });

    const gemini = client();
    if (!gemini) return reply.status(503).send({ error: geminiProblem('SETUP', 'it has no address or key in this deployment.') });
    try {
      const id = await gemini.submit({ prompt, files, account: geminiAccount(), temporary: true, images: true, timeoutS: 300 });
      return reply.send({ id });
    } catch (err) {
      const e = err instanceof GeminiError ? err : new GeminiError(String(err), 'SERVICE');
      return reply.status(502).send({ error: geminiProblem(e.code, e.message) });
    }
  });

  app.get('/settings/gemini/ask/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const gemini = client();
    if (!gemini) return reply.status(503).send({ status: 'failed', error: geminiProblem('SETUP', 'it has no address or key in this deployment.') });
    try {
      const job = await gemini.job(id);
      if (job.status === 'done' && job.result) {
        recordGeminiOutcome(settings, null);
        return reply.send({ status: 'done', reply: forPage(job.result) });
      }
      if (job.status === 'failed') {
        const e = GeminiError.from(job.error ?? '');
        recordGeminiOutcome(settings, `${e.code}: ${e.message}`);
        return reply.send({ status: 'failed', error: geminiProblem(e.code, e.message) });
      }
      return reply.send({ status: job.status });
    } catch (err) {
      const e = err instanceof GeminiError ? err : new GeminiError(String(err), 'SERVICE');
      return reply.status(502).send({ status: 'failed', error: geminiProblem(e.code, e.message) });
    }
  });
}
