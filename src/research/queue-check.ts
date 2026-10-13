import { randomUUID } from 'node:crypto';
import { all, run } from '../db/index.js';
import { haramWord, halalOnly } from '../core/halal.js';
import { parseJson } from '../pipeline/json.js';

/**
 * Keywords > Check the queue: find the waiting keywords that are not one dish.
 *
 * Each of those costs a model call at publish time only to be refused by
 * validate-spy. Here they are found up front, a hundred to a model call, and
 * listed for a person to tick off; nothing is removed without that.
 */

export interface QueueFlag {
  id: number;
  title: string;
  group: string;
  why: string;
}

export interface QueueCheckJob {
  id: string;
  total: number;
  checked: number;
  finished: boolean;
  flags: QueueFlag[];
  errors: string[];
  at: number;
}

const BATCH = 80;
const PARALLEL = 2;
const REASONS: Record<string, string> = {
  topic: 'a topic or occasion, not one dish',
  list: 'a list of several dishes',
  'not food': 'not a dish',
  unclear: 'too vague to know the dish',
};

const jobs = new Map<string, QueueCheckJob>();
let current: string | null = null;

/** The keywords set to go with at least one site waiting for them. */
export function queuedKeywords(): { id: number; title: string; group: string }[] {
  return all<{ id: number; spy_title: string; seed_keyword: string }>(
    `SELECT k.id, k.spy_title, k.seed_keyword FROM keywords k
      WHERE k.status = 'go'
        AND EXISTS (SELECT 1 FROM keyword_sites ks WHERE ks.keyword_id = k.id AND ks.status = 'go')
      ORDER BY k.id`,
  ).map((r) => ({ id: r.id, title: r.spy_title.trim(), group: r.seed_keyword.trim() }));
}

export const getQueueCheck = (id: string): QueueCheckJob | undefined => jobs.get(id);
/** The check that is running or last ran, so the page can go back to it. */
export const latestQueueCheck = (): QueueCheckJob | undefined => (current ? jobs.get(current) : undefined);

export function startQueueCheck(ask: (items: string) => Promise<string>): QueueCheckJob {
  const running = latestQueueCheck();
  if (running && !running.finished) return running;

  const rows = queuedKeywords();
  const job: QueueCheckJob = { id: randomUUID(), total: rows.length, checked: 0, finished: false, flags: [], errors: [], at: Date.now() };
  jobs.clear();
  jobs.set(job.id, job);
  current = job.id;

  // What needs no model: no dish name at all, or a haram word.
  const forModel: typeof rows = [];
  const halal = halalOnly();
  for (const r of rows) {
    const word = halal ? haramWord(`${r.title} ${r.group}`) : null;
    if (!r.title) job.flags.push({ ...r, title: r.group, why: 'no dish name (spy title), only a topic group' });
    else if (word) job.flags.push({ ...r, why: `alcohol or pork (${word})` });
    else forModel.push(r);
  }
  job.checked = rows.length - forModel.length;

  const batches: (typeof rows)[] = [];
  for (let i = 0; i < forModel.length; i += BATCH) batches.push(forModel.slice(i, i + BATCH));
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      try {
        const answer = await ask(batch.map((r, i) => `${i + 1}. ${r.title} [${r.group}]`).join('\n'));
        const parsed = parseJson(answer, 'the queue check') as { flag?: { n?: unknown; why?: unknown }[] };
        for (const f of parsed.flag ?? []) {
          const row = batch[Number(f.n) - 1];
          if (!row) continue;
          const why = String(f.why ?? '').toLowerCase();
          job.flags.push({ ...row, why: REASONS[why] ?? (why || 'not one dish') });
        }
      } catch (err) {
        job.errors.push(err instanceof Error ? err.message : String(err));
      }
      job.checked += batch.length;
    }
  };
  void Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker)).then(() => {
    job.flags.sort((a, b) => a.id - b.id);
    job.finished = true;
  });
  if (batches.length === 0) job.finished = true;
  return job;
}

/** Take the ticked keywords out of the queue: set to 'no', not deleted, so they can come back. */
export function removeFromQueue(ids: number[]): number {
  let n = 0;
  for (const id of ids) n += run("UPDATE keywords SET status = 'no', updated_at = datetime('now') WHERE id = ? AND status = 'go'", id).changes;
  return n;
}
