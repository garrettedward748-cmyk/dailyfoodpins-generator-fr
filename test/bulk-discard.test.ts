import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { createRun, getRun, insertKeyword, listHeldRuns, markRunHeld, upsertSite } from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

const KEY = randomBytes(32);
let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  app = buildServer(new Settings(KEY), KEY, { password: 'correct-horse-battery-staple', secret: KEY, generated: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=correct-horse-battery-staple', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => { await app.close(); closeDatabase(); });

function held(n: number): number[] {
  const site = upsertSite({ name: 'D', domain: 'd.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);
  return Array.from({ length: n }, (_, i) => {
    const id = createRun(insertKeyword({ seed_keyword: 'x', spy_title: `Dish ${i}` }), site);
    markRunHeld(id, 'awaiting', `Dish ${i}`);
    return id;
  });
}
const post = (payload: string) => app.inject({ method: 'POST', url: '/runs/discard', payload, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });

describe('discarding many articles waiting for approval', () => {
  it('shows the controls, discards the ticked ones, then all', async () => {
    const [a, b, c] = held(3);
    const page = await app.inject({ method: 'GET', url: '/runs', headers: { cookie } });
    expect(page.body).toContain('Discard all 3');
    expect(page.body).toContain(`name="ids" value="${a}"`);

    await post(`mode=selected&ids=${a}&ids=${b}`);
    expect(getRun(a!)?.hold).toBe('');
    expect(listHeldRuns().map((r) => r.id)).toEqual([c]);

    await post('mode=all');
    expect(listHeldRuns()).toHaveLength(0);
  });
});
