import { randomUUID } from 'node:crypto';
import type { ResearchResult, TopicIdeas } from './keywords.js';

/**
 * Several topics researched in one go, in the background.
 *
 * One topic takes up to a minute (Google, then the AI clean-up), so five in
 * one request would outlast Cloudflare's hundred seconds. The search runs
 * here instead, two topics at a time, and the page checks back until it is
 * done. Kept in memory: a search is looked at once, straight away.
 */

export const MAX_TOPICS = 5;
export const DEFAULT_PER_TOPIC = 20;
const PARALLEL = 2;
const KEEP_MS = 60 * 60 * 1000;

export interface ResearchJob {
  id: string;
  topics: string[];
  perTopic: number;
  niche: string;
  done: number;
  finished: boolean;
  results: ResearchResult[];
  error?: string;
  at: number;
}

const jobs = new Map<string, ResearchJob>();

/** The topics asked for: trimmed, lower-cased, no repeats, at most five. */
export function cleanTopics(raw: unknown): string[] {
  const list = ([] as unknown[]).concat(raw ?? []).flatMap((v) => String(v ?? '').split(','));
  const out: string[] = [];
  for (const t of list) {
    const topic = t.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
    if (topic && !out.includes(topic)) out.push(topic);
  }
  return out.slice(0, MAX_TOPICS);
}

/**
 * Each topic's list cut to `perTopic`, best first, with anything an earlier
 * topic already listed taken out -- the same dish found under two topics
 * shows once, under the first.
 */
export function mergeResults(results: ResearchResult[], perTopic: number): ResearchResult[] {
  const seenRecipes = new Set<string>();
  const seenQuestions = new Set<string>();
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return results.map((r) => {
    const recipes = r.recipes.filter((i) => !seenRecipes.has(key(i.text))).slice(0, perTopic);
    const questions = r.questions.filter((i) => !seenQuestions.has(key(i.text))).slice(0, perTopic);
    recipes.forEach((i) => seenRecipes.add(key(i.text)));
    questions.forEach((i) => seenQuestions.add(key(i.text)));
    return { ...r, recipes, questions };
  });
}

export function startResearchJob(
  topics: string[],
  perTopic: number,
  niche: string,
  research: (topic: string) => Promise<ResearchResult>,
): ResearchJob {
  for (const [id, j] of jobs) if (Date.now() - j.at > KEEP_MS) jobs.delete(id);
  const job: ResearchJob = { id: randomUUID(), topics, perTopic, niche, done: 0, finished: false, results: [], at: Date.now() };
  jobs.set(job.id, job);

  const raw: ResearchResult[] = new Array(topics.length);
  let next = 0;
  const worker = async () => {
    while (next < topics.length) {
      const i = next++;
      const topic = topics[i]!;
      try {
        raw[i] = await research(topic);
      } catch (err) {
        raw[i] = { seed: topic, recipes: [], questions: [], notes: [`“${topic}”: ${err instanceof Error ? err.message : String(err)}`] };
      }
      job.done += 1;
    }
  };
  void Promise.all(Array.from({ length: Math.min(PARALLEL, topics.length) }, worker)).then(() => {
    job.results = mergeResults(raw, perTopic);
    job.finished = true;
  });
  return job;
}

export const getResearchJob = (id: string): ResearchJob | undefined => jobs.get(id);

/** The last topic ideas per niche, so they stay on the page while a search runs. */
const ideasCache = new Map<string, TopicIdeas>();
export const rememberIdeas = (ideas: TopicIdeas): void => {
  ideasCache.set(ideas.niche.toLowerCase(), ideas);
};
export const recallIdeas = (niche: string): TopicIdeas | null => ideasCache.get(niche.toLowerCase()) ?? null;
