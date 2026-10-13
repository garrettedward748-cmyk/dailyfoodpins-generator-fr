import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { researchGoogle, RESEARCH_UNAVAILABLE } from '../src/pipeline/steps/research.js';
import { Settings } from '../src/settings.js';
import { setLogLevel } from '../src/lib/logger.js';

const KEY = randomBytes(32);
let settings: Settings;
let runId: number;
const realFetch = globalThis.fetch;

beforeEach(() => {
  setLogLevel('error');
  openDatabase(':memory:');
  settings = new Settings(KEY);
  settings.set('serper_api_key', 'k1');
  run("INSERT INTO sites (name, domain) VALUES ('s', 's.com')");
  run("INSERT INTO runs (site_id, status) VALUES (1, 'running')");
  runId = get<{ id: number }>('SELECT id FROM runs')!.id;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  closeDatabase();
});

const ctx = (prompt = vi.fn(async () => ({ content: 'CONSENSUS — 4 of 5 use wafers', endpoint: 'e', model: 'm' }))) =>
  ({
    settings,
    encryptionKey: KEY,
    runId,
    site: { domain: 's.com' },
    keyword: { spy_title: 'Banana Pudding', seed_keyword: 'dessert' },
    prompt,
  }) as never;

const seo = { keyword: 'banana pudding', title: '', description: '', category: '', cuisine: '' };

describe('the Google research step', () => {
  it('writes a brief from the top results and marks the run', async () => {
    globalThis.fetch = (async (u: string | URL | Request) =>
      String(u).includes('serper')
        ? new Response(JSON.stringify({ organic: [{ title: 'A', link: 'https://a.com', snippet: 'Use ripe bananas.' }], peopleAlsoAsk: [{ question: 'Can you freeze it?' }] }))
        : new Response('', { status: 403 })) as typeof fetch;
    const out = (await researchGoogle.run(ctx(), seo)) as { value: { status: string; brief: string; questions: string[] } };
    expect(out.value).toMatchObject({ status: 'ok', brief: 'CONSENSUS — 4 of 5 use wafers', questions: ['Can you freeze it?'] });
    expect(get<{ research: string }>('SELECT research FROM runs')!.research).toBe('ok');
  });

  it('waits when no search answers, then writes without it after six hours', async () => {
    globalThis.fetch = (async () => new Response('down', { status: 400 })) as typeof fetch;
    await expect(researchGoogle.run(ctx(), seo)).rejects.toThrow(RESEARCH_UNAVAILABLE);
    run("UPDATE runs SET started_at = datetime('now', '-7 hours')");
    const out = (await researchGoogle.run(ctx(), seo)) as { status: string };
    expect(out.status).toBe('none');
    expect(get<{ research: string }>('SELECT research FROM runs')!.research).toBe('none');
  });

  it('is skipped when switched off or when nothing is set up to search with', async () => {
    settings.set('serp_research_enabled', 'false');
    expect(((await researchGoogle.run(ctx(), seo)) as { status: string }).status).toBe('off');
    settings.set('serp_research_enabled', 'true');
    settings.set('serper_api_key', '');
    expect(((await researchGoogle.run(ctx(), seo)) as { status: string }).status).toBe('off');
  });
});
