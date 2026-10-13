import { describe, expect, it } from 'vitest';
import { cleanTopics, getResearchJob, mergeResults, startResearchJob } from '../src/research/batch.js';
import type { ResearchItem, ResearchResult } from '../src/research/keywords.js';

const item = (text: string): ResearchItem => ({ text, source: 'autocomplete' }) as ResearchItem;
const result = (seed: string, recipes: string[], questions: string[] = []): ResearchResult => ({
  seed,
  recipes: recipes.map(item),
  questions: questions.map(item),
  notes: [],
});

describe('several topics at once', () => {
  it('cleans the topics: trimmed, lower case, no repeats, five at most', () => {
    expect(cleanTopics(['  Pumpkin Cheesecake ', 'pumpkin cheesecake', 'a, b', 'c', 'd', 'e', 'f'])).toEqual([
      'pumpkin cheesecake', 'a', 'b', 'c', 'd',
    ]);
    expect(cleanTopics(undefined)).toEqual([]);
  });

  it('cuts each topic to its best N and shows a dish found twice only under the first topic', () => {
    const merged = mergeResults(
      [result('pumpkin', ['pumpkin cheesecake', 'pumpkin bars', 'pumpkin pie'], ['q1', 'q2']), result('pecan', ['Pumpkin Cheesecake', 'pecan bars'], ['q1', 'q3'])],
      2,
    );
    expect(merged[0]!.recipes.map((i) => i.text)).toEqual(['pumpkin cheesecake', 'pumpkin bars']);
    expect(merged[1]!.recipes.map((i) => i.text)).toEqual(['pecan bars']);
    expect(merged[1]!.questions.map((i) => i.text)).toEqual(['q3']);
  });

  it('runs every topic, keeps going past one that fails, and says so', async () => {
    const job = startResearchJob(['a', 'b', 'c'], 20, 'n', async (t) => {
      if (t === 'b') throw new Error('Google down');
      return result(t, [`${t} cake`]);
    });
    for (let i = 0; i < 50 && !getResearchJob(job.id)!.finished; i++) await new Promise((r) => setTimeout(r, 5));
    const done = getResearchJob(job.id)!;
    expect(done.done).toBe(3);
    expect(done.results.map((r) => r.seed)).toEqual(['a', 'b', 'c']);
    expect(done.results[1]!.notes[0]).toMatch(/Google down/);
  });
});
