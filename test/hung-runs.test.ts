import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase, run as dbRun, get as dbGet } from '../src/db/index.js';
import { createRun, getRun, insertKeyword, upsertSite } from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { lockStatus, reapStalledRun, stopRun } from '../src/scheduler/index.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * A run that hangs must not hold the lock until someone notices.
 *
 * The symptom: the dashboard says "a run is in progress", nothing is
 * happening, and there is no way to clear it — the lock only went stale after
 * ninety minutes, and until then no other run could start.
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

let app: FastifyInstance;
let cookie: string;

/** Put the lock into the state a hung run leaves behind. */
const holdLock = (runId: number, silentForMinutes: number): void => {
  dbRun(
    `UPDATE scheduler_lock
        SET run_id = ?, locked_at = datetime('now', ?), heartbeat_at = datetime('now', ?)
      WHERE id = 1`,
    runId,
    `-${silentForMinutes} minutes`,
    `-${silentForMinutes} minutes`,
  );
};

const startedRun = (): number => {
  const siteId = upsertSite(
    {
      name: 'bitespoon',
      domain: 'bitespoon.com',
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 3,
      interval_minutes: 60,
    },
    KEY,
  );
  const keywordId = insertKeyword({
    seed_keyword: 'chicken thighs',
    spy_title: 'Honey Soy Chicken Thighs',
    status: 'go',
  });
  return createRun(keywordId, siteId);
};

beforeEach(async () => {
  setLogLevel('error');
  openDatabase(':memory:');
  app = buildServer(new Settings(KEY), KEY, {
    password: PASSWORD,
    secret: KEY,
    generated: false,
  });
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/login',
    payload: new URLSearchParams({ password: PASSWORD }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const header = login.headers['set-cookie'];
  cookie = Array.isArray(header) ? header[0]! : String(header);
});

afterEach(async () => {
  await app.close();
  closeDatabase();
});

describe('reaping a run whose process is gone', () => {
  it('leaves a run that is still reporting progress alone', () => {
    const runId = startedRun();
    holdLock(runId, 2);

    expect(reapStalledRun(new Settings(KEY))).toBeNull();
    expect(lockStatus()?.locked_at).not.toBeNull();
    expect(getRun(runId)?.status).toBe('running');
  });

  it('fails a silent run and frees the lock', () => {
    // Default step timeout is 8 minutes, and the watchdog allows 5 more.
    const runId = startedRun();
    holdLock(runId, 20);

    expect(reapStalledRun(new Settings(KEY))).toBe(runId);
    expect(lockStatus()?.locked_at).toBeNull();

    const run = getRun(runId);
    expect(run?.status).toBe('failed');
    expect(run?.error).toContain('Stalled');
  });

  it('says what happened, so the run page is not a mystery', () => {
    const runId = startedRun();
    holdLock(runId, 20);
    reapStalledRun(new Settings(KEY));

    // The point of the message: it names the likely cause and the way out,
    // rather than leaving someone to guess from a blank running row.
    expect(getRun(runId)?.error).toContain('Resume it');
  });

  it('does nothing when no run is in progress', () => {
    expect(reapStalledRun(new Settings(KEY))).toBeNull();
  });
});

describe('stopping a run by hand', () => {
  it('closes the run and releases the lock', () => {
    const runId = startedRun();
    holdLock(runId, 1);

    expect(stopRun()).toBe(runId);
    expect(lockStatus()?.locked_at).toBeNull();
    expect(getRun(runId)?.status).toBe('failed');
  });

  it('is a no-op when nothing is running', () => {
    expect(stopRun()).toBeNull();
  });

  it('offers Stop and Restart on the dashboard only while a run is in progress', async () => {
    const idle = await app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(idle.body).not.toContain('/run/stop');

    const runId = startedRun();
    holdLock(runId, 1);

    const busy = await app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(busy.body).toContain('/run/stop');
    expect(busy.body).toContain('/run/restart');
  });

  it('frees the lock through the button, not only the function', async () => {
    const runId = startedRun();
    holdLock(runId, 1);

    const response = await app.inject({
      method: 'POST',
      url: '/run/stop',
      payload: '',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.statusCode).toBe(303);
    expect(lockStatus()?.locked_at).toBeNull();
    expect(
      dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status = 'failed'")?.n,
    ).toBe(1);
  });
});
