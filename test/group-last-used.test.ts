import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { insertKeyword, loadGroupLastUsed, upsertSite } from '../src/db/repos.js';

beforeEach(() => openDatabase(':memory:'));
afterEach(() => closeDatabase());

it('reads when each topic group last ran on each site', () => {
  const site = upsertSite({ name: 's', domain: 's.com', status: 'active', daily_target: 1, interval_minutes: 60 }, randomBytes(32));
  const a = insertKeyword({ seed_keyword: 'Vegan Dessert', spy_title: 'x' });
  const b = insertKeyword({ seed_keyword: 'vegan dessert ', spy_title: 'y' });
  run("INSERT INTO runs (keyword_id, site_id, started_at) VALUES (?, ?, '2026-09-01 10:00:00')", a, site);
  run("INSERT INTO runs (keyword_id, site_id, started_at) VALUES (?, ?, '2026-09-02 10:00:00')", b, site);
  expect(loadGroupLastUsed().get(`${site}|vegan dessert`)).toBe(Date.parse('2026-09-02T10:00:00Z'));
});
