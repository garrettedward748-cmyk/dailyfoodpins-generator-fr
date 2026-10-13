import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { getSite, upsertSite } from '../src/db/repos.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * One change across many sites.
 *
 * Moving the daily target on eight sites meant eight pages, and the eighth was
 * where the typo went.
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';

let app: FastifyInstance;
let cookie: string;

const seedSite = (domain: string, over: Record<string, unknown> = {}): number =>
  upsertSite(
    {
      name: domain.split('.')[0]!,
      domain,
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 8,
      interval_minutes: 180,
      ...over,
    },
    KEY,
  );

const bulk = async (fields: Record<string, string | string[]>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
    else params.set(key, value);
  }
  return app.inject({
    method: 'POST',
    url: '/sites/bulk',
    payload: params.toString(),
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  });
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

describe('editing several sites at once', () => {
  it('sets the daily target on every ticked site and no others', async () => {
    const a = seedSite('bitespoon.com');
    const b = seedSite('helergon.com');
    const untouched = seedSite('longlivo.com');

    await bulk({ ids: [String(a), String(b)], action: 'target', daily_target: '12' });

    expect(getSite(a)?.daily_target).toBe(12);
    expect(getSite(b)?.daily_target).toBe(12);
    expect(getSite(untouched)?.daily_target).toBe(8);
  });

  it('converts the interval from its unit, the way the site form does', async () => {
    const id = seedSite('bitespoon.com');

    await bulk({
      ids: String(id),
      action: 'interval',
      interval_amount: '2',
      interval_unit: 'days',
    });

    expect(getSite(id)?.interval_minutes).toBe(2880);
  });

  it('activates and pauses', async () => {
    const id = seedSite('bitespoon.com', { status: 'paused' });

    await bulk({ ids: String(id), action: 'activate' });
    expect(getSite(id)?.status).toBe('active');

    await bulk({ ids: String(id), action: 'pause' });
    const paused = getSite(id);
    expect(paused?.status).toBe('paused');
    // No end time: a bulk pause is a deliberate stop, and one that expired on
    // its own would be a surprise later.
    expect(paused?.paused_until).toBeNull();
    expect(paused?.paused_reason).toContain('sites list');
  });

  it('switches publishing between automatic and held', async () => {
    const id = seedSite('bitespoon.com');

    await bulk({ ids: String(id), action: 'hold' });
    expect(getSite(id)?.auto_publish).toBe(0);

    await bulk({ ids: String(id), action: 'auto' });
    expect(getSite(id)?.auto_publish).toBe(1);
  });

  it('handles one ticked row, which arrives as a string rather than an array', async () => {
    const id = seedSite('bitespoon.com');
    await bulk({ ids: String(id), action: 'target', daily_target: '3' });
    expect(getSite(id)?.daily_target).toBe(3);
  });

  it('changes nothing when nothing is ticked', async () => {
    const id = seedSite('bitespoon.com');
    const response = await bulk({ action: 'target', daily_target: '99' });

    expect(response.headers.location).toContain('Nothing%20was%20ticked');
    expect(getSite(id)?.daily_target).toBe(8);
  });

  it('refuses an action it does not recognise', async () => {
    const id = seedSite('bitespoon.com');
    const response = await bulk({ ids: String(id), action: 'delete-everything' });

    expect(response.headers.location).toContain('error=');
    expect(getSite(id)).toBeDefined();
  });

  it('puts a tick box on every row of the sites table', async () => {
    seedSite('bitespoon.com');
    const body = (await app.inject({ method: 'GET', url: '/sites', headers: { cookie } })).body;

    expect(body).toContain('action="/sites/bulk"');
    expect(body).toContain('name="ids"');
    expect(body).toContain('id="pick-all"');
  });
});
