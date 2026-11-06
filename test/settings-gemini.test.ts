import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { setModelOverride } from '../src/db/repos.js';
import { GEMINI_LAST_ERROR, GEMINI_LAST_OK, GEMINI_MODEL } from '../src/llm/gemini.js';
import { invalidatePromptCache, modelFor, PROMPT_MODELS } from '../src/pipeline/prompts.js';
import {
  GEMINI_STAGES,
  geminiAccount,
  geminiStages,
  geminiState,
  registerGeminiRoutes,
  setGeminiStages,
} from '../src/web/gemini.js';
import { geminiPage } from '../src/web/views/gemini.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

const KEY = randomBytes(32);
const BASE = 'http://imagegen.test:8100';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Setup -> Gemini', () => {
  let settings: Settings;
  let calls: { path: string; body?: Record<string, unknown> }[];
  let job: Record<string, unknown>;
  let serviceUp: boolean;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(BASE, '');
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (!serviceUp) throw new Error('fetch failed');
    if (path === '/v1/gemini/jobs') return json({ id: 'job-9', status: 'queued', result: null, error: null }, 202);
    if (path === '/v1/gemini/jobs/job-9') return json(job);
    if (path === '/v1/gemini/status') return json({ extension_connected: false, queued: 0, running: 0, last_success_at: null, last_error: null });
    return json({}, 404);
  }) as unknown as typeof fetch;

  const app = async (): Promise<FastifyInstance> => {
    const a = Fastify();
    await a.register(formbody);
    registerGeminiRoutes(a, {
      settings,
      fetchImpl,
      render: (reply, body) => reply.type('text/html').send(body.value),
      readFlash: () => null,
    });
    return a;
  };

  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    invalidatePromptCache();
    settings = new Settings(KEY);
    settings.set('image_base_url', BASE);
    process.env.IMAGE_API_KEY = 'test-key';
    calls = [];
    serviceUp = true;
    job = { id: 'job-9', status: 'running', result: null, error: null };
  });

  afterEach(() => {
    delete process.env.IMAGE_API_KEY;
    invalidatePromptCache();
    closeDatabase();
  });

  it('places every prompt in exactly one step', () => {
    const placed = GEMINI_STAGES.flatMap((s) => s.prompts);
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed].sort()).toEqual(Object.keys(PROMPT_MODELS).sort());
  });

  it('is off for every step until one is ticked, so nothing changes on its own', () => {
    expect(geminiStages()).toEqual([]);
    expect(modelFor('facebook-post')).toBe(PROMPT_MODELS['facebook-post']!.model);
  });

  it('switches whole steps to Gemini and back, leaving other model choices alone', () => {
    setModelOverride('blog-article', 'gemma4:31b');
    invalidatePromptCache();
    setGeminiStages(['Social posts', 'Reels and collages']);
    expect(geminiStages()).toEqual(['Social posts', 'Reels and collages']);
    expect(modelFor('pin-description')).toBe(GEMINI_MODEL);
    expect(modelFor('reel-plan')).toBe(GEMINI_MODEL);
    expect(modelFor('blog-article')).toBe('gemma4:31b');

    setGeminiStages(['Reels and collages']);
    expect(geminiStages()).toEqual(['Reels and collages']);
    expect(modelFor('pin-description')).toBe(PROMPT_MODELS['pin-description']!.model);
    expect(modelFor('blog-article')).toBe('gemma4:31b');
  });

  it('saves the ticked steps from the form and ignores made-up ones', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/settings/gemini/steps', payload: 'stage=Social+posts&stage=Nonsense', headers: FORM });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/settings\/gemini\?ok=/);
    expect(geminiStages()).toEqual(['Social posts']);
    const off = await (await app()).inject({ method: 'POST', url: '/settings/gemini/steps', payload: '', headers: FORM });
    expect(decodeURIComponent(off.headers.location as string)).toMatch(/AI keys write every step/);
    expect(geminiStages()).toEqual([]);
  });

  it("asks as whichever account the browser is on (one Google account per Chrome profile here)", () => {
    expect(geminiAccount()).toBe('');
  });

  it('says plainly how Gemini is doing', async () => {
    expect((await geminiState(settings, fetchImpl)).label).toBe('Not tried yet');

    settings.set(GEMINI_LAST_OK, '2026-11-02T08:00:00.000Z');
    expect(await geminiState(settings, fetchImpl)).toMatchObject({ kind: 'ok', label: 'Working' });

    settings.set(GEMINI_LAST_ERROR, '2026-11-02T09:00:00.000Z NOT_SIGNED_IN: no account');
    const out = await geminiState(settings, fetchImpl);
    expect(out).toMatchObject({ kind: 'bad', label: 'Sign-in needed' });
    expect(out.detail).toMatch(/Browser page/);

    serviceUp = false;
    expect(await geminiState(settings, fetchImpl)).toMatchObject({ kind: 'bad', label: 'Not answering' });
  });

  it('draws the steps as ticks and a box to try it', async () => {
    const out = geminiPage({ kind: 'idle', label: 'Not tried yet', detail: 'Send a test message below.' }, GEMINI_STAGES, ['Social posts']).value;
    expect(out).toMatch(/name="stage" value="Social posts" checked/);
    expect(out).toMatch(/name="stage" value="Reels and collages" >/);
    expect(out).toContain('action="/settings/gemini/steps"');
    expect(out).toContain('id="gm-form"');

    const page = await (await app()).inject({ url: '/settings/gemini' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Choose which steps Gemini writes');
  });

  it('sends a test message and hands back the reply, pictures as data only', async () => {
    const a = await app();
    const sent = await a.inject({ method: 'POST', url: '/settings/gemini/ask', payload: { prompt: 'Hi', files: [{ name: 'a.png', mime: 'image/png', base64: 'AAAA' }, { bad: 1 }] } });
    expect(sent.json()).toEqual({ id: 'job-9' });
    expect(calls.find((c) => c.path === '/v1/gemini/jobs')!.body).toMatchObject({
      prompt: 'Hi', temporary: true, images: true, files: [{ name: 'a.png', mime: 'image/png', base64: 'AAAA' }],
    });

    expect((await a.inject({ url: '/settings/gemini/ask/job-9' })).json()).toEqual({ status: 'running' });

    job = {
      id: 'job-9', status: 'done', error: null,
      result: { conversation_id: null, text: 'Hello', markdown: 'Hello', code_blocks: [{ language: 'python', code: 'print(1)' }], links: [], images: [{ url: 'blob:x', alt: 'cake', mime: 'image/png', data_base64: 'iVBO' }, { url: 'blob:y', alt: 'no data' }] },
    };
    const done = (await a.inject({ url: '/settings/gemini/ask/job-9' })).json();
    expect(done).toEqual({ status: 'done', reply: { text: 'Hello', markdown: 'Hello', code_blocks: [{ language: 'python', code: 'print(1)' }], images: [{ alt: 'cake', mime: 'image/png', data_base64: 'iVBO' }] } });
    expect(settings.get(GEMINI_LAST_OK)).not.toBe('');
  });

  it('explains a failure in plain words and remembers it', async () => {
    job = { id: 'job-9', status: 'failed', result: null, error: 'NOT_SIGNED_IN: Gemini is open but no Google account is signed in.' };
    const out = (await (await app()).inject({ url: '/settings/gemini/ask/job-9' })).json();
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/Open the Browser page/);
    expect(settings.get(GEMINI_LAST_ERROR)).toMatch(/NOT_SIGNED_IN/);
  });

  it('refuses an empty message and says when the image service is down', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/settings/gemini/ask', payload: { prompt: ' ' } })).statusCode).toBe(400);
    serviceUp = false;
    const down = await a.inject({ method: 'POST', url: '/settings/gemini/ask', payload: { prompt: 'Hi' } });
    expect(down.statusCode).toBe(502);
    expect(down.json().error).toMatch(/image service/);
  });
});
