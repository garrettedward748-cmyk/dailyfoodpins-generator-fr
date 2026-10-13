import type { Step } from '../engine.js';
import type { SeoData } from './content.js';
import { get, run } from '../../db/index.js';
import { findOnGoogle, findingsForPrompt } from '../../research/serp.js';
import { webSearchKeys } from '../../llm/web-search.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('research-google');

/**
 * Before the recipe is written: what the top Google results for the dish say
 * -- common ingredients, usual times and temperatures, what they cover, what
 * they miss -- plus the questions people ask. The writer gets it as facts to
 * use, never text to copy.
 *
 * When no search answers, the run waits and tries again (up to six hours
 * from its start), then is written without it and marked so.
 */

export const RESEARCH_UNAVAILABLE = 'Google research unavailable';
export const RESEARCH_WAIT_HOURS = 6;

export interface GoogleResearch {
  status: 'ok' | 'none' | 'off';
  provider?: string;
  brief: string;
  questions: string[];
  sources: { title: string; url: string }[];
}

export const markRunResearch = (runId: number, state: 'ok' | 'none'): void => {
  run('UPDATE runs SET research = ? WHERE id = ?', state, runId);
};

const runAgeHours = (runId: number): number => {
  const started = get<{ started_at: string }>('SELECT started_at FROM runs WHERE id = ?', runId)?.started_at;
  if (!started) return 0;
  const t = Date.parse(started.includes('T') ? started : `${started.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? 0 : (Date.now() - t) / 3_600_000;
};

export const researchGoogle: Step<SeoData, GoogleResearch> = {
  name: 'research-google',
  title: 'Research Google',
  async run(ctx, seo) {
    if (!ctx.settings.getBool('serp_research_enabled')) {
      return { status: 'off', brief: '', questions: [], sources: [] };
    }
    const query = (ctx.keyword.spy_title || seo.keyword || ctx.keyword.seed_keyword).trim();
    const serperState = {
      get: () => Number(ctx.settings.get('serper_key_index')) || 0,
      set: (i: number) => ctx.settings.set('serper_key_index', String(i)),
    };
    const serperKey = ctx.settings.get('serper_api_key');
    const ollamaKeys = webSearchKeys(ctx.encryptionKey, ctx.settings.get('llm_base_url'));
    // Nothing to search with is a setup choice, not an outage: no waiting.
    if (!serperKey.trim() && ollamaKeys.length === 0) {
      return { status: 'off', brief: '', questions: [], sources: [] };
    }
    const findings = await findOnGoogle(query, { serperKey, serperState, ollamaKeys, skipDomain: ctx.site.domain });

    if (!findings.ok) {
      if (runAgeHours(ctx.runId) < RESEARCH_WAIT_HOURS) {
        throw new Error(`${RESEARCH_UNAVAILABLE} (${findings.error ?? 'no answer'}); the article waits and tries again`);
      }
      log.warn(`run ${ctx.runId}: writing without Google research after ${RESEARCH_WAIT_HOURS}h of trying`);
      markRunResearch(ctx.runId, 'none');
      return { status: 'none', brief: '', questions: [], sources: [] };
    }

    const result = await ctx.prompt(
      'serp-brief',
      {
        keyword: query,
        questions: findings.questions.length ? findings.questions.map((q) => `- ${q}`).join('\n') : '(none found)',
        pages: findingsForPrompt(findings) || '(no page could be read)',
      },
      { format: null },
    );
    markRunResearch(ctx.runId, 'ok');
    return {
      value: {
        status: 'ok',
        provider: findings.provider,
        brief: result.content.trim().slice(0, 5000),
        questions: findings.questions,
        sources: findings.pages.map((p) => ({ title: p.title, url: p.url })),
      },
      endpoint: result.endpoint,
      model: result.model,
    };
  },
};
