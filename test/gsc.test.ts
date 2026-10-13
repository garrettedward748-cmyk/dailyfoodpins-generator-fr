import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, get, openDatabase } from '../src/db/index.js';
import { addPastedKeywords, upsertSite } from '../src/db/repos.js';
import { GscClient, parseServiceAccount } from '../src/gsc/client.js';
import {
  addOpportunities, aggregate, candidates, dismissOpportunities, listOpportunities, pageCovers, parseQueriesCsv, refreshSite,
} from '../src/gsc/engine.js';
import { setLogLevel } from '../src/lib/logger.js';

const KEY = randomBytes(32);
const row = (query: string, page: string, impressions: number, position = 10, clicks = 0) => ({ query, page, impressions, clicks, ctr: 0, position });

describe('Search Console: the client', () => {
  it('signs a JWT, trades it for a token, and asks for query + page rows', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const account = parseServiceAccount(JSON.stringify({ client_email: 'bot@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: { body?: string }) => {
      calls.push({ url, body: init.body });
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ rows: [{ keys: ['banana bread', 'https://s.com/recipe/banana-bread'], clicks: 2, impressions: 90, ctr: 0.02, position: 7.5 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const rows = await new GscClient(account, fetchImpl).searchAnalytics('sc-domain:s.com', '2026-09-01', '2026-09-28');
    expect(rows[0]).toMatchObject({ query: 'banana bread', impressions: 90, position: 7.5 });
    expect(calls[0]!.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(calls[1]!.url).toContain('/sites/sc-domain%3As.com/searchAnalytics/query');
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ dimensions: ['query', 'page'], rowLimit: 5000 });
  });

  it('says plainly what is wrong with a bad key file', () => {
    expect(() => parseServiceAccount('nope')).toThrow(/JSON/);
    expect(() => parseServiceAccount('{"type":"service_account"}')).toThrow(/client_email/);
  });
});

describe('Search Console: finding ideas', () => {
  beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
  afterEach(() => closeDatabase());

  it('folds rows per search and keeps the page that showed most', () => {
    const s = aggregate([row('Freeze Banana Bread', 'https://s.com/recipe/banana-bread', 30, 12), row('freeze banana bread', 'https://s.com/blog/x', 10, 20)]);
    expect(s).toEqual([{ query: 'freeze banana bread', impressions: 40, clicks: 0, position: 14, page: 'https://s.com/recipe/banana-bread' }]);
  });

  it('knows when the page is already about the search', () => {
    expect(pageCovers('easy banana bread recipe', 'https://s.com/recipe/banana-bread')).toBe(true);
    expect(pageCovers('can you freeze banana bread', 'https://s.com/recipe/banana-bread')).toBe(false);
    expect(pageCovers('banana bread with oil', 'https://s.com/recipe/banana-bread')).toBe(false);
  });

  it('leaves out few impressions, the site name, haram, covered pages and what is already a keyword', () => {
    const siteId = upsertSite({ name: 's', domain: 'arbmom.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    addPastedKeywords(['Banana Bread With Oil'], 'banana bread', [siteId]);
    const stats = aggregate([
      row('can you freeze banana bread', 'https://arbmom.com/recipe/banana-bread', 120),
      row('arbmom banana bread', 'https://arbmom.com/recipe/banana-bread', 300),
      row('banana bread with rum', 'https://arbmom.com/recipe/banana-bread', 80),
      row('easy banana bread', 'https://arbmom.com/recipe/banana-bread', 500),
      row('banana bread with oil', 'https://arbmom.com/recipe/banana-bread', 60),
      row('banana muffins', 'https://arbmom.com/recipe/banana-bread', 5),
    ]);
    expect(candidates(stats, { id: siteId, domain: 'arbmom.com' }, 20).map((s) => s.query)).toEqual(['can you freeze banana bread']);
  });

  it('sorts with the model, saves, adds recipes to Keywords and questions to Blog, and remembers dismissals', async () => {
    const siteId = upsertSite({ name: 's', domain: 's.com', status: 'active', pin_username: '', project_id: '', daily_target: 1, interval_minutes: 60 }, KEY);
    const deps = {
      fetchRows: vi.fn(async () => [
        row('can you freeze banana bread', 'https://s.com/recipe/banana-bread', 120),
        row('chocolate banana muffins', 'https://s.com/recipe/banana-bread', 90),
        row('banana', 'https://s.com/recipe/banana-bread', 400),
      ]),
      ask: vi.fn(async (items: string) => {
        const n = (q: string) => items.split('\n').findIndex((l) => l.includes(q)) + 1;
        return JSON.stringify({ keep: [{ n: n('freeze'), type: 'question' }, { n: n('muffins'), type: 'recipe', group: 'muffins' }] });
      }),
      notify: vi.fn(async () => {}),
    };
    const site = { ...(get('SELECT * FROM sites WHERE id = ?', siteId) as object), gsc_property: 'sc-domain:s.com' } as never;
    const report = await refreshSite(site, deps, '2026-10-01', 20);
    expect(report).toMatchObject({ queries: 3, candidates: 2, found: 2 }); // "banana" is what the page is already about
    expect(deps.fetchRows).toHaveBeenCalledWith('sc-domain:s.com', '2026-09-01', '2026-09-28');

    const ideas = listOpportunities(siteId);
    const muffins = ideas.find((o) => o.query.includes('muffins'))!;
    const freeze = ideas.find((o) => o.query.includes('freeze'))!;
    expect(addOpportunities(siteId, [muffins.id, freeze.id])).toEqual({ recipes: 1, questions: 1 });
    expect(get<{ seed_keyword: string }>("SELECT seed_keyword FROM keywords WHERE spy_title = 'Chocolate Banana Muffins'")!.seed_keyword).toBe('muffins');
    expect(listOpportunities(siteId)).toHaveLength(0);
    expect(listOpportunities(siteId, 'added')).toHaveLength(2);

    // Fetched again: what was decided stays decided.
    await refreshSite(site, deps, '2026-10-02', 20);
    expect(listOpportunities(siteId)).toHaveLength(0);
    expect(dismissOpportunities(siteId, [])).toBe(0);
  });

  it("reads Search Console's Queries.csv", () => {
    const csv = '﻿Top queries,Clicks,Impressions,CTR,Position\n"can you freeze banana bread",3,"1,204",0.25%,9.4\nbanana muffins,0,40,0%,22\n';
    expect(parseQueriesCsv(csv)).toEqual([
      { query: 'can you freeze banana bread', clicks: 3, impressions: 1204, position: 9.4, page: '' },
      { query: 'banana muffins', clicks: 0, impressions: 40, position: 22, page: '' },
    ]);
    expect(() => parseQueriesCsv('Page,Clicks\nx,1')).toThrow(/Queries/);
  });
});
