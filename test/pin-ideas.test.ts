import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { all, closeDatabase, get, openDatabase } from '../src/db/index.js';
import {
  addPastedKeywords, addProfile, createRun, firstProfile, runProfile, updateProfile, upsertBufferAccount, upsertSite,
} from '../src/db/repos.js';
import {
  addPinIdeas, analyseExport, count, dismissPinIdeas, exportAccount, exportUsername, lastPinReport, listPinIdeas, parsePinterestCsv, pinLines,
} from '../src/research/pinterest-ideas.js';
import { titleFromPage, slugTitle } from '../src/integrations/pinterest-page.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/** A Top pins export as Pinterest writes it: a few lines about the range first, then the table. */
const EN = [
  'Top pins',
  'Date range,2026-09-01 - 2026-09-30',
  '',
  'Pin ID,Title,Pin link,Destination URL,Impressions,Engagements,Pin clicks,Outbound clicks,Saves',
  '1,Easy Pizza Bites,https://www.pinterest.com/pin/1/,https://d.com/easy-pizza-bites/,"4,855",300,40,12,120',
  '2,Lemon Bars,https://www.pinterest.com/pin/2/,https://d.com/lemon-bars/,"1,200",50,10,1,20',
  '3,,https://www.pinterest.com/pin/3/,https://d.com/garlic-knots/,900,30,5,0,8',
  'Total,,,,"6,955",380,55,13,148',
].join('\n');

/** The French export: semicolons, French headers, spaces as thousands marks. */
const FR = [
  'Épingles les plus performantes',
  "Titre;Lien de l'épingle;Impressions;Enregistrements;Clics sur l'épingle;Clics sortants",
  "Bouchées de pizza;https://www.pinterest.fr/pin/9/;12 400;310;88;41",
  "Tarte au citron;https://www.pinterest.fr/pin/8/;2 050;14;3;0",
].join('\n');

/** The real export (Analytics → Overview → Export): settings, the daily table, Top boards, Top pins by link only. */
const REAL = [
  'Analytics overview',
  '2026-09-17 - 2026-10-17',
  'Content types,All',
  'Publish Types,',
  '',
  'Date,Impressions',
  '2026-09-17,247',
  '2026-09-18,360',
  "Data starting from 2026-10-16 is an estimate that gets adjusted as it's verified over time.",
  '',
  'Top Boards 2026-09-17 - 2026-10-17',
  'Pinterest Link,Impressions,Engagement,Pin clicks,Outbound clicks,Saves',
  'https://www.pinterest.com/ArbmomRecipes/apple-crumble-recipes/,190,0,0,0,0',
  'https://www.pinterest.com/ArbmomRecipes/pumpkin-dessert-recipes/,167,9,5,3,1',
  '"Top boards table is restricted to data from the last 6 months."',
  '',
  'Top Pins 2026-09-17 - 2026-10-17',
  'Pins created in the last 30 days from 2026-10-17',
  'Pinterest Link,Content Type,Source,Canonical,Impressions',
  'https://www.pinterest.com/pin/957929783263860232/,Organic,"From you, Not from you.",Yes,174',
  'https://www.pinterest.com/pin/957929783263665642/,Organic,From you,Yes,27',
  '"Top pins table is restricted to data from the last 6 months."',
].join('\n');

const KEY = randomBytes(32);
const site = () => upsertSite({ name: 'd', domain: 'd.com', status: 'active', daily_target: 1, interval_minutes: 60 }, KEY);

beforeEach(() => { setLogLevel('error'); openDatabase(':memory:'); });
afterEach(() => closeDatabase());

describe('reading an export', () => {
  it('finds the table under the preamble, reads the counts, names a pin from its address, and drops the Total row', () => {
    const pins = parsePinterestCsv(EN);
    expect(pins.map((p) => p.title)).toEqual(['Easy Pizza Bites', 'Lemon Bars', 'garlic knots']);
    expect(pins.every((p) => p.kind === 'pin')).toBe(true);
    expect(pins[0]).toMatchObject({ impressions: 4855, saves: 120, pinClicks: 40, outbound: 12, url: 'https://www.pinterest.com/pin/1/' });
    // 12 outbound x10 + 120 saves x5 + 40 clicks x2 + 4855/100
    expect(pins[0]!.score).toBe(120 + 600 + 80 + 49);
  });

  it("reads the real export: skips the daily table and the notes, names boards from their address, leaves pins to be looked up", () => {
    const rows = parsePinterestCsv(REAL);
    expect(rows.map((r) => [r.kind, r.title])).toEqual([
      ['board', 'pumpkin dessert recipes'],
      ['board', 'apple crumble recipes'],
      ['pin', ''],
      ['pin', ''],
    ]);
    expect(rows[0]).toMatchObject({ impressions: 167, pinClicks: 5, outbound: 3, saves: 1, engagements: 9 });
    expect(rows[2]).toMatchObject({ url: 'https://www.pinterest.com/pin/957929783263860232/', impressions: 174 });
  });

  it('looks the pins up, and leaves out one that has no title anywhere', async () => {
    const siteId = site();
    let read = '';
    const report = await analyseExport(siteId, 'Pinterest_Analytics_overview.csv', REAL, {
      pinTitle: async (url) => (url.includes('860232') ? 'Easy Pumpkin Pie Bars' : ''),
      async ask(vars) { read = vars.pins; return JSON.stringify({ ideas: [{ title: 'Pumpkin Cheesecake Bars', group: 'pumpkin', from: 1 }] }); },
    }, '2026-10-17');
    expect(read.split('\n')).toEqual([
      '1. [board] pumpkin dessert recipes — 167 impressions, 1 saves, 5 pin clicks, 3 outbound clicks',
      '2. [board] apple crumble recipes — 190 impressions',
      '3. [pin] Easy Pumpkin Pie Bars — 174 impressions',
    ]);
    expect(report).toMatchObject({ pins: 3, found: 1 });
    expect(listPinIdeas(siteId, 'new')[0]).toMatchObject({ title: 'Pumpkin Cheesecake Bars', source: 'pumpkin dessert recipes' });
  });

  it('reports each stage as it goes, with a counter for the titles', async () => {
    const seen: string[] = [];
    await analyseExport(site(), 'p.csv', REAL, {
      pinTitle: async () => 'A Pin',
      progress: (stage, done, total) => seen.push(done === undefined ? stage : `${stage} ${done}/${total}`),
      ask: async () => JSON.stringify({ ideas: [] }),
    }, '2026-10-17');
    expect(seen).toEqual(['reading', 'titles 0/2', 'titles 2/2', 'ai', 'saving']);
  });

  it("reads a pin's title from its page: og:title, else the page's data, else the link's words", () => {
    expect(titleFromPage('<meta property="og:title" content="Easy Pumpkin Pie Bars | Pinterest">')).toBe('Easy Pumpkin Pie Bars');
    expect(titleFromPage('<meta property="og:title" content="Pinterest"><script>{"title":"Caramel Apple Cookies"}</script>')).toBe('Caramel Apple Cookies');
    expect(titleFromPage('<meta property="og:title" content="Pin on Desserts"><script>{"link":"https:\\/\\/arbmom.com\\/banana-bread-muffins\\/"}</script>')).toBe('banana bread muffins');
    expect(slugTitle('https://www.pinterest.com/pin/1/')).toBe('');
  });

  it('reads the French export', () => {
    const pins = parsePinterestCsv(FR);
    expect(pins[0]).toMatchObject({ title: 'Bouchées de pizza', impressions: 12400, saves: 310, pinClicks: 88, outbound: 41 });
    expect(pins).toHaveLength(2);
  });

  it('reads counts as the locales write them', () => {
    expect([count('1,234'), count('1 234'), count('1.2K'), count('1,5k'), count('—'), count('12')]).toEqual([1234, 1234, 1200, 1500, 0, 12]);
  });

  it('finds nothing in a file with no pins (the daily overview)', () => {
    expect(parsePinterestCsv('Date,Impressions\n2026-09-01,4\n2026-09-02,7')).toEqual([]);
  });
});

describe('the ideas', () => {
  it('keeps new ideas tied to their pin, and skips repeats, existing articles and haram ones', async () => {
    const siteId = site();
    addPastedKeywords(['Pepperoni-Free Veggie Pizza'], 'pizza', [siteId]);
    let asked = '';
    const report = await analyseExport(siteId, 'pins.csv', EN, {
      async ask(vars) {
        asked = vars.pins;
        return JSON.stringify({
          summary: 'Party bites do best.',
          ideas: [
            { title: 'Garlic Butter Pizza Bites', group: 'pizza', from: 1 },
            { title: 'Garlic Butter Pizza Bites', group: 'pizza', from: 1 },
            { title: 'Pepperoni-Free Veggie Pizza', group: 'pizza', from: 1 },
            { title: 'Bacon Pizza Rolls', group: 'pizza', from: 1 },
            { title: 'Lemon Crinkle Cookies', group: 'lemon', from: 2 },
          ],
        });
      },
    }, '2026-10-17');
    expect(asked).toBe(pinLines(parsePinterestCsv(EN)));
    expect(report).toMatchObject({ pins: 3, found: 2, summary: 'Party bites do best.' });
    const ideas = listPinIdeas(siteId, 'new');
    expect(ideas.map((i) => i.title)).toEqual(['Garlic Butter Pizza Bites', 'Lemon Crinkle Cookies']);
    expect(ideas[0]).toMatchObject({ topic: 'pizza', source: 'Easy Pizza Bites', source_url: 'https://www.pinterest.com/pin/1/' });
    expect(lastPinReport(siteId)?.top[0]?.title).toBe('Easy Pizza Bites');
  });

  it('says so when the file has no pins, without asking the model', async () => {
    const siteId = site();
    let called = false;
    const report = await analyseExport(siteId, 'overview.csv', 'Date,Impressions\n', { async ask() { called = true; return '{}'; } }, '2026-10-17');
    expect(called).toBe(false);
    expect(report.error).toMatch(/no pins or boards/);
  });

  it('adds the ticked ones to Keywords under their group, and a dismissed one never returns', async () => {
    const siteId = site();
    await analyseExport(siteId, 'p.csv', EN, {
      ask: async () => JSON.stringify({ ideas: [{ title: 'Garlic Butter Pizza Bites', group: 'pizza', from: 1 }, { title: 'Lemon Crinkle Cookies', group: 'lemon', from: 2 }] }),
    }, '2026-10-17');
    const [a, b] = listPinIdeas(siteId, 'new');
    expect(addPinIdeas(siteId, [a!.id])).toBe(1);
    expect(all<{ spy_title: string; seed_keyword: string }>('SELECT spy_title, seed_keyword FROM keywords')).toEqual([{ spy_title: 'Garlic Butter Pizza Bites', seed_keyword: 'pizza' }]);
    expect(dismissPinIdeas(siteId, [b!.id])).toBe(1);
    // The same ideas offered again by a second upload are not saved twice.
    const again = await analyseExport(siteId, 'p.csv', EN, {
      ask: async () => JSON.stringify({ ideas: [{ title: 'Lemon Crinkle Cookies', group: 'lemon', from: 2 }] }),
    }, '2026-10-18');
    expect(again.found).toBe(0);
  });
});

describe('the page', () => {
  let app: FastifyInstance;
  let cookie: string;
  beforeEach(async () => {
    app = buildServer(new Settings(KEY), KEY, { password: 'pw-123456', secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/login', payload: 'password=pw-123456', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const header = login.headers['set-cookie'];
    cookie = Array.isArray(header) ? header[0]! : String(header);
  });
  afterEach(async () => { await app.close(); });

  it('shows the upload form, and takes a file', async () => {
    const siteId = site();
    const page = await app.inject({ method: 'GET', url: `/pin-ideas?site=${siteId}`, headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Upload and analyse');
    expect(page.body).toContain('href="/pin-ideas"');

    const boundary = '----pinideas';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pins.csv"\r\nContent-Type: text/csv\r\n\r\n`),
      Buffer.from(EN),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({ method: 'POST', url: `/pin-ideas/${siteId}/upload`, payload: body, headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(res.statusCode).toBe(303);
    // The page polls this while the export is analysed; the model is out of reach here, so it ends soon.
    const status = await app.inject({ method: 'GET', url: `/pin-ideas/${siteId}/progress`, headers: { cookie } });
    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.body)).toHaveProperty('running');
    expect(String(res.headers.location)).toContain(`/pin-ideas?site=${siteId}`);
  });
});

describe("the account an export is for", () => {
  /** Two Pinterest accounts with tokens: ArbmomRecipes and JenniferSoutherne. */
  function accounts(siteId: number): { arb: number; jen: number } {
    const arb = firstProfile(siteId, 'pinterest').id;
    const jen = addProfile(siteId, 'pinterest');
    updateProfile(arb, { channel_name: 'ArbmomRecipes' });
    updateProfile(jen, { channel_name: 'JenniferSoutherne' });
    for (const id of [arb, jen]) upsertBufferAccount({ siteId, label: `t${id}`, token: `tok${id}`, enabled: true, profileId: id }, KEY);
    return { arb, jen };
  }

  it("reads the username from the file's board links", () => {
    expect(exportUsername(REAL)).toBe('ArbmomRecipes');
    expect(exportUsername(EN)).toBe('');
  });

  it('lets the file decide, says so when the pick disagrees, and falls back to the pick or the turn', () => {
    const siteId = site();
    const { arb, jen } = accounts(siteId);
    expect(exportAccount(siteId, 'arbmomrecipes', 0)).toEqual({ account: expect.objectContaining({ id: arb }), note: '' });
    expect(exportAccount(siteId, 'ArbmomRecipes', jen).note).toMatch(/JenniferSoutherne, but the file is ArbmomRecipes/);
    expect(exportAccount(siteId, '', jen).account?.id).toBe(jen);
    expect(exportAccount(siteId, 'SomeoneElse', 0)).toMatchObject({ account: null, note: expect.stringMatching(/pin in turn/) });
  });

  it("pins an idea's keyword to that account instead of the next in the turn, and that counts as its turn", async () => {
    const siteId = site();
    const { arb, jen } = accounts(siteId);
    const report = await analyseExport(siteId, 'p.csv', REAL, {
      ask: async () => JSON.stringify({ ideas: [{ title: 'Pumpkin Cheesecake Bars', group: 'pumpkin', from: 1 }] }),
    }, '2026-10-17');
    expect(report.account).toEqual({ id: arb, username: 'ArbmomRecipes' });
    const [idea] = listPinIdeas(siteId, 'new');
    expect(idea!.profile_id).toBe(arb);
    addPinIdeas(siteId, [idea!.id]);
    const link = get<{ keyword_id: number; pin_profile_id: number }>('SELECT keyword_id, pin_profile_id FROM keyword_sites WHERE site_id = ?', siteId)!;
    expect(link.pin_profile_id).toBe(arb);

    // ArbmomRecipes is not next in the turn (it was just used), yet its idea goes there.
    updateProfile(arb, { turn: 5 } as never);
    const run1 = createRun(link.keyword_id, siteId);
    expect(runProfile(run1, siteId, 'pinterest', 'posts')?.id).toBe(arb);
    // A keyword of no account takes the turn: JenniferSoutherne, now first in it.
    const other = createRun(addKeyword(siteId), siteId);
    expect(runProfile(other, siteId, 'pinterest', 'posts')?.id).toBe(jen);

    // The account switched off: the idea's next run takes the turn instead.
    updateProfile(arb, { enabled: 0 });
    const run2 = createRun(link.keyword_id, siteId);
    expect(runProfile(run2, siteId, 'pinterest', 'posts')?.id).toBe(jen);
  });
});

function addKeyword(siteId: number): number {
  addPastedKeywords(['Plain Banana Bread'], 'banana', [siteId]);
  return get<{ id: number }>("SELECT id FROM keywords WHERE spy_title = 'Plain Banana Bread'")!.id;
}
