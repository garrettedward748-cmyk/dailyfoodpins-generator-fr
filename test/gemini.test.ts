import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { GeminiClient, GeminiError } from '../src/integrations/gemini.js';
import { chat, setGeminiRetryWait } from '../src/llm/client.js';
import { configureGemini, GEMINI_LAST_ERROR, GEMINI_LAST_OK, GEMINI_MODEL, geminiChatFor, joinMessages, jsonFrom, rememberGeminiChat, unusableReply, withGeminiChat } from '../src/llm/gemini.js';
import { listEndpointRows, upsertEndpoint } from '../src/llm/pool.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

const KEY = randomBytes(32);
const BASE = 'http://imagegen.test:8100';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const reply = (over: Record<string, unknown> = {}) => ({
  conversation_id: null, text: 'Hello there', markdown: 'Hello **there**', code_blocks: [], links: [], images: [], ...over,
});

/** The image service's Gemini routes, answering each prompt with `answer` (or failing with it). */
function service(answer: { result?: unknown; error?: string }) {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(BASE, '');
    if (path === '/v1/gemini/jobs') {
      sent.push(JSON.parse(String(init?.body)));
      return json({ id: 'job-1', status: 'queued', result: null, error: null }, 202);
    }
    if (path === '/v1/gemini/jobs/job-1') {
      return answer.error
        ? json({ id: 'job-1', status: 'failed', result: null, error: answer.error })
        : json({ id: 'job-1', status: 'done', result: answer.result, error: null });
    }
    if (path === '/v1/gemini/status') return json({ extension_connected: true, queued: 0, running: 0, last_success_at: null, last_error: null });
    throw new Error(`unexpected ${path}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, sent };
}

describe('Gemini client', () => {
  it('queues a prompt and returns the reply once the service has it', async () => {
    const { fetchImpl, sent } = service({ result: reply() });
    const client = new GeminiClient({ baseUrl: `${BASE}/`, apiKey: 'k', pollIntervalMs: 1, fetchImpl });
    const got = await client.ask({ prompt: 'Hi', account: 'a@b.c', timeoutS: 120 });
    expect(got.text).toBe('Hello there');
    expect(sent[0]).toEqual({ prompt: 'Hi', files: [], account: 'a@b.c', temporary: true, conversation_id: '', images: true, timeout_s: 120 });
  });

  it("reports the page's own failure code", async () => {
    const { fetchImpl } = service({ error: 'NOT_SIGNED_IN: Gemini is open but no Google account is signed in.' });
    const client = new GeminiClient({ baseUrl: BASE, apiKey: 'k', pollIntervalMs: 1, fetchImpl });
    const err = await client.ask({ prompt: 'Hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect((err as GeminiError).code).toBe('NOT_SIGNED_IN');
    expect((err as GeminiError).message).toMatch(/no Google account/);
  });

  it('gives up at once when the service has forgotten the prompt', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/v1/gemini/jobs') ? json({ id: 'job-1', status: 'queued' }, 202) : json({ detail: 'No such Gemini prompt.' }, 404),
    ) as unknown as typeof fetch;
    const client = new GeminiClient({ baseUrl: BASE, apiKey: 'k', pollIntervalMs: 1, fetchImpl });
    const err = (await client.ask({ prompt: 'Hi' }).catch((e: unknown) => e)) as GeminiError;
    expect(err.code).toBe('GONE');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('clamps the budget to what the service accepts', async () => {
    const { fetchImpl, sent } = service({ result: reply() });
    const client = new GeminiClient({ baseUrl: BASE, apiKey: 'k', pollIntervalMs: 1, fetchImpl });
    await client.submit({ prompt: 'x', timeoutS: 5 });
    await client.submit({ prompt: 'x', timeoutS: 99_999 });
    expect(sent.map((s) => s.timeout_s)).toEqual([60, 1800]);
  });
});

describe('a prompt as Gemini sees it', () => {
  it('puts the instructions first and asks for JSON when JSON is wanted', () => {
    const prompt = joinMessages([{ role: 'system', content: 'You write recipes.' }, { role: 'user', content: 'Lemon cake' }], 'json');
    expect(prompt).toBe('Instructions:\nYou write recipes.\n\nRequest:\nLemon cake\n\nAnswer with valid JSON only, in one ```json code block, with no other text.');
    expect(joinMessages([{ role: 'user', content: 'Just this' }], null)).toBe('Just this');
  });

  it('takes the JSON from its code block, or from the text around it', () => {
    expect(jsonFrom(reply({ code_blocks: [{ language: 'json', code: '{"a": 1}' }] }))).toBe('{"a": 1}');
    expect(jsonFrom(reply({ text: 'Here you go: {"title": "Cake"} enjoy', markdown: '' }))).toBe('{"title": "Cake"}');
    expect(jsonFrom(reply({ text: '[1, 2]', markdown: '' }))).toBe('[1, 2]');
    expect(() => jsonFrom(reply({ text: 'no json here {oops', markdown: '' }))).toThrow(/valid JSON/);
  });

  it('refuses a limit message or an empty reply, but not an answer that mentions a limit', () => {
    expect(unusableReply('')).toMatch(/empty/);
    expect(unusableReply("You've reached your limit for today. Try again tomorrow.")).toMatch(/did not answer/);
    expect(unusableReply('I can’t help with that.')).toMatch(/did not answer/);
    expect(unusableReply(`${'A long recipe. '.repeat(50)} Keep the speed limit in mind; try again later if it sinks.`)).toBeNull();
  });
});

describe('chat() with Gemini as the model', () => {
  let settings: Settings;
  const ollamaModels: string[] = [];

  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    settings = new Settings(KEY);
    settings.set('image_base_url', BASE);
    process.env.IMAGE_API_KEY = 'test-key';
    ollamaModels.length = 0;
    setGeminiRetryWait(0);
    // One AI key with no model list: it serves every model, so a stray "gemini" would reach it.
    upsertEndpoint({ name: 'Main', baseUrl: 'https://ollama.test', apiKey: 'x', models: [], enabled: true }, KEY);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      ollamaModels.push(body.model);
      return json({ message: { content: 'from the AI key' }, prompt_eval_count: 3, eval_count: 4 });
    }));
  });

  afterEach(() => {
    configureGemini(null);
    vi.unstubAllGlobals();
    delete process.env.IMAGE_API_KEY;
    closeDatabase();
  });

  it('is answered by Gemini, never by an AI key', async () => {
    const { fetchImpl, sent } = service({ result: reply({ code_blocks: [{ language: 'json', code: '{"ok": true}' }] }) });
    configureGemini({ settings, account: () => 'me@gmail.com', fetchImpl });
    const result = await chat({ model: GEMINI_MODEL, messages: [{ role: 'user', content: 'x' }], format: 'json', fallbackModel: 'gpt-oss:120b' }, KEY);
    expect(result).toMatchObject({ content: '{"ok": true}', endpoint: 'Gemini', model: GEMINI_MODEL });
    expect(sent[0]).toMatchObject({ account: 'me@gmail.com', temporary: true, images: false });
    expect(ollamaModels).toEqual([]);
    expect(settings.get(GEMINI_LAST_OK)).not.toBe('');
  });

  it("falls back to the prompt's usual model when Gemini cannot answer, and remembers why", async () => {
    const { fetchImpl } = service({ error: 'NOT_SIGNED_IN: sign in' });
    configureGemini({ settings, account: () => '', fetchImpl });
    const result = await chat({ model: GEMINI_MODEL, messages: [{ role: 'user', content: 'x' }], fallbackModel: 'gpt-oss:120b' }, KEY);
    expect(result).toMatchObject({ content: 'from the AI key', model: 'gpt-oss:120b', endpoint: 'Main' });
    expect(ollamaModels).toEqual(['gpt-oss:120b']);
    expect(settings.get(GEMINI_LAST_ERROR)).toMatch(/NOT_SIGNED_IN: sign in/);
    expect(listEndpointRows()[0]!.healthy).toBe(1);
  });

  it('falls back when JSON was asked for and Gemini wrote prose', async () => {
    const { fetchImpl } = service({ result: reply({ text: 'Sure! Here is a lovely cake.' }) });
    configureGemini({ settings, account: () => '', fetchImpl });
    const result = await chat({ model: GEMINI_MODEL, messages: [{ role: 'user', content: 'x' }], format: 'json', fallbackModel: 'gemma4:31b' }, KEY);
    expect(result.model).toBe('gemma4:31b');
    expect(settings.get(GEMINI_LAST_ERROR)).toMatch(/NOT_JSON/);
  }, 30_000);

  it('asks Gemini again after a passing failure instead of falling back at once', async () => {
    const answer: { result?: unknown; error?: string } = { error: 'TIMEOUT: slow page' };
    const { fetchImpl, sent } = service(answer);
    configureGemini({ settings, account: () => '', fetchImpl });
    const asking = chat({ model: GEMINI_MODEL, messages: [{ role: 'user', content: 'x' }], fallbackModel: 'gpt-oss:120b' }, KEY);
    await new Promise((r) => setTimeout(r, 2500));
    delete answer.error;
    answer.result = reply({ text: 'second time lucky', markdown: 'second time lucky' });
    const result = await asking;
    expect(result).toMatchObject({ endpoint: 'Gemini', content: 'second time lucky' });
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(ollamaModels).toEqual([]);
  }, 30_000);

  it('names Gemini first when the keys it falls back to fail too', async () => {
    const { fetchImpl } = service({ error: 'TIMEOUT: slow page' });
    configureGemini({ settings, account: () => '', fetchImpl });
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Add usage credits' }, 402)));
    await expect(chat({ model: GEMINI_MODEL, messages: [{ role: 'user', content: 'x' }], fallbackModel: 'gpt-oss:120b' }, KEY))
      .rejects.toThrow(/Gemini could not answer \(.*slow page.*\), and the AI keys/);
  }, 30_000);

  it("asks an article's prompts in one ordinary chat, carried on from prompt to prompt", async () => {
    const answer: { result?: unknown; error?: string } = { result: reply({ conversation_id: 'c1' }) };
    const { fetchImpl, sent } = service(answer);
    configureGemini({ settings, account: () => '', fetchImpl });
    const ask = () => chat({ model: GEMINI_MODEL, messages: [{ role: 'user', content: 'x' }], fallbackModel: 'gpt-oss:120b' }, KEY);

    await withGeminiChat('run:7', ask);
    expect(sent[0]).toMatchObject({ temporary: false, conversation_id: '' });
    expect(geminiChatFor(settings, 'run:7')).toBe('c1');

    await withGeminiChat('run:7', ask);
    expect(sent[1]).toMatchObject({ temporary: false, conversation_id: 'c1' });

    // Another article has its own chat; a prompt outside any article is a one-off temporary chat.
    answer.result = reply({ conversation_id: 'c2' });
    await withGeminiChat('run:8', ask);
    expect(sent[2]).toMatchObject({ temporary: false, conversation_id: '' });
    expect(geminiChatFor(settings, 'run:8')).toBe('c2');
    await ask();
    expect(sent[3]).toMatchObject({ temporary: true, conversation_id: '' });
    expect(geminiChatFor(settings, 'run:7')).toBe('c1');
  }, 30_000);

  it('moves to the new chat when the old one was gone, and lets go of one whose page failed', async () => {
    rememberGeminiChat(settings, 'run:7', 'old');
    const answer: { result?: unknown; error?: string } = { result: reply({ conversation_id: 'fresh' }) };
    const { fetchImpl, sent } = service(answer);
    configureGemini({ settings, account: () => '', fetchImpl });
    const ask = () => chat({ model: GEMINI_MODEL, messages: [{ role: 'user', content: 'x' }], fallbackModel: 'gpt-oss:120b' }, KEY);

    await withGeminiChat('run:7', ask);
    expect(sent[0]).toMatchObject({ conversation_id: 'old' });
    expect(geminiChatFor(settings, 'run:7')).toBe('fresh');

    answer.error = 'TIMEOUT: slow';
    await withGeminiChat('run:7', ask);
    expect(geminiChatFor(settings, 'run:7')).toBe('fresh');

    answer.error = 'NO_PROMPT_BOX: the page broke';
    await withGeminiChat('run:7', ask);
    expect(geminiChatFor(settings, 'run:7')).toBe('');
  }, 30_000);

  it("asks one article's prompts one after another, so they never start two chats", async () => {
    const answer: { result?: unknown; error?: string } = { result: reply({ conversation_id: 'c1' }) };
    const { fetchImpl, sent } = service(answer);
    configureGemini({ settings, account: () => '', fetchImpl });
    const ask = () => withGeminiChat('run:9', () => chat({ model: GEMINI_MODEL, messages: [{ role: 'user', content: 'x' }], fallbackModel: 'gpt-oss:120b' }, KEY));
    await Promise.all([ask(), ask()]);
    expect(sent.map((b) => b.conversation_id)).toEqual(['', 'c1']);
  }, 30_000);

  it('fails plainly with no fallback, and with no Gemini set up at all', async () => {
    const { fetchImpl } = service({ error: 'TIMEOUT: too slow' });
    configureGemini({ settings, account: () => '', fetchImpl });
    await expect(chat({ model: GEMINI_MODEL, messages: [{ role: 'user', content: 'x' }] }, KEY)).rejects.toThrow(/too slow/);
    configureGemini(null);
    const result = await chat({ model: GEMINI_MODEL, messages: [{ role: 'user', content: 'x' }], fallbackModel: 'gpt-oss:120b' }, KEY);
    expect(result.model).toBe('gpt-oss:120b');
    expect(ollamaModels).toEqual(['gpt-oss:120b']);
  }, 30_000);
});
