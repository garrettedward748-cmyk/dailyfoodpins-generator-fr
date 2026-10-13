import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { getSiteByDomain, listSites, siteSecrets, upsertSite } from '../src/db/repos.js';
import { exportDataset, exportSitesWithCredentials } from '../src/db/exports.js';
import { importSitesCsv } from '../src/web/import.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * Sites in and out of a spreadsheet.
 *
 * Two properties carry the weight here. A blank token must never erase a
 * stored one — that is what lets the credential-free export be edited and
 * imported back without silently unauthenticating every site. And the ordinary
 * export must never contain a secret, because it is a file that ends up in a
 * downloads folder and gets attached to things.
 */

const KEY = randomBytes(32);

const seed = (domain: string, over: Record<string, unknown> = {}): number =>
  upsertSite(
    {
      name: domain.split('.')[0]!,
      domain,
      status: 'active',
      pin_username: 'pinner',
      project_id: 'proj-1',
      daily_target: 3,
      interval_minutes: 480,
      apiToken: 'site-token',
      bufferToken: 'buffer-token',
      ...over,
    },
    KEY,
  );

const asCsv = (rows: string[][]): string =>
  rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');

describe('importing sites from a spreadsheet', () => {
  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
  });

  afterEach(() => closeDatabase());

  it('creates sites it has not seen', () => {
    const report = importSitesCsv(
      'name,domain,status,daily_target\n' +
        'bitespoon,bitespoon.com,active,3\n' +
        'longlivo,longlivo.com,paused,0\n',
      KEY,
    );

    expect(report.added).toBe(2);
    expect(report.updated).toBe(0);
    expect(listSites()).toHaveLength(2);
  });

  it('matches on the domain, so a second import corrects rather than duplicates', () => {
    importSitesCsv('name,domain,daily_target\nbitespoon,bitespoon.com,3\n', KEY);
    const second = importSitesCsv('name,domain,daily_target\nbitespoon,bitespoon.com,7\n', KEY);

    expect(second.added).toBe(0);
    expect(second.updated).toBe(1);
    expect(listSites()).toHaveLength(1);
    expect(getSiteByDomain('bitespoon.com')?.daily_target).toBe(7);
  });

  it('normalises a domain typed with a scheme or www', () => {
    importSitesCsv('domain\nhttps://www.bitespoon.com/\n', KEY);
    expect(getSiteByDomain('bitespoon.com')).toBeDefined();
  });

  it('skips a row with no domain rather than failing the file', () => {
    const report = importSitesCsv('name,domain\nno domain here,\nbitespoon,bitespoon.com\n', KEY);

    expect(report.skipped).toBe(1);
    expect(report.added).toBe(1);
  });

  /* -- credentials -------------------------------------------------------- */

  it('stores the credentials it is given, encrypted', () => {
    const report = importSitesCsv(
      'domain,api_token,buffer_token\nbitespoon.com,abc123,buf456\n',
      KEY,
    );

    expect(report.withCredentials).toBe(1);

    const site = getSiteByDomain('bitespoon.com')!;
    expect(site.api_token_encrypted).not.toContain('abc123');
    expect(siteSecrets(site, KEY)).toEqual({ apiToken: 'abc123', bufferToken: 'buf456' });
  });

  it('leaves a stored credential alone when the cell is blank', () => {
    // The property the round trip depends on. Without it, importing the
    // credential-free export unauthenticates every site at once.
    seed('bitespoon.com');
    importSitesCsv('domain,daily_target,api_token,buffer_token\nbitespoon.com,9,,\n', KEY);

    const site = getSiteByDomain('bitespoon.com')!;
    expect(site.daily_target).toBe(9);
    expect(siteSecrets(site, KEY)).toEqual({
      apiToken: 'site-token',
      bufferToken: 'buffer-token',
    });
  });

  it('leaves them alone when the columns are absent entirely', () => {
    seed('bitespoon.com');
    importSitesCsv('domain,daily_target\nbitespoon.com,4\n', KEY);

    expect(siteSecrets(getSiteByDomain('bitespoon.com')!, KEY).apiToken).toBe('site-token');
  });

  it('reports whether the file carried any credentials at all', () => {
    const without = importSitesCsv('domain\na.com\n', KEY);
    expect(without.withCredentials).toBe(0);
  });

  /* -- the other columns --------------------------------------------------- */

  it('reads the approval setting in the words a person would write', () => {
    importSitesCsv(
      'domain,auto_publish\na.com,no\nb.com,yes\nc.com,false\nd.com,approval\n',
      KEY,
    );

    expect(getSiteByDomain('a.com')?.auto_publish).toBe(0);
    expect(getSiteByDomain('b.com')?.auto_publish).toBe(1);
    expect(getSiteByDomain('c.com')?.auto_publish).toBe(0);
    expect(getSiteByDomain('d.com')?.auto_publish).toBe(0);
  });

  it('keeps the stored approval setting when the column is blank', () => {
    seed('bitespoon.com', { auto_publish: false });
    importSitesCsv('domain,daily_target\nbitespoon.com,2\n', KEY);

    expect(getSiteByDomain('bitespoon.com')?.auto_publish).toBe(0);
  });

  it('still accepts the old sheet headings', () => {
    importSitesCsv(
      'Website Name,Domain,status,hours_between,Pin username,Project ID\n' +
        'bitespoon,bitespoon.com,active,8,cookwith,proj-9\n',
      KEY,
    );

    const site = getSiteByDomain('bitespoon.com')!;
    expect(site.name).toBe('bitespoon');
    expect(site.interval_minutes).toBe(480);
    expect(site.pin_username).toBe('cookwith');
    expect(site.project_id).toBe('proj-9');
  });
});

describe('exporting sites', () => {
  beforeEach(() => {
    setLogLevel('error');
    openDatabase(':memory:');
    seed('bitespoon.com');
  });

  afterEach(() => closeDatabase());

  it('never puts a secret in the ordinary export', () => {
    const csv = asCsv(exportDataset('sites').rows);

    expect(csv).not.toContain('site-token');
    expect(csv).not.toContain('buffer-token');
  });

  it('does not offer the credential export on the Sites page', async () => {
    // A file that can publish to every site you own should not be one click
    // away on a busy page. The export still exists for a deliberate migration.
    const { randomBytes: rb } = await import('node:crypto');
    const { buildServer } = await import('../src/web/server.js');
    const { Settings } = await import('../src/settings.js');

    const key = rb(32);
    const app = buildServer(new Settings(key), key, {
      password: 'correct-horse-battery-staple',
      secret: key,
      generated: false,
    });
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/login',
      payload: new URLSearchParams({ password: 'correct-horse-battery-staple' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const header = login.headers['set-cookie'];
    const cookie = Array.isArray(header) ? header[0]! : String(header);

    const page = await app.inject({ method: 'GET', url: '/sites', headers: { cookie } });
    await app.close();

    expect(page.body).not.toContain('/sites/export/credentials');
    expect(page.body).toContain('/data/export/sites');
  });

  it('puts them in the one that says it does', () => {
    const csv = asCsv(exportSitesWithCredentials(KEY).rows);

    expect(csv).toContain('site-token');
    expect(csv).toContain('buffer-token');
  });

  it('round-trips the ordinary export without erasing the credentials', () => {
    const csv = asCsv(exportDataset('sites').rows);
    closeDatabase();

    // A second deployment importing that file: the settings arrive, the
    // secrets are simply absent rather than blanked.
    openDatabase(':memory:');
    seed('bitespoon.com', { daily_target: 99 });
    importSitesCsv(csv, KEY);

    const site = getSiteByDomain('bitespoon.com')!;
    expect(site.daily_target).toBe(3);
    expect(siteSecrets(site, KEY).apiToken).toBe('site-token');
  });

  it('round-trips the credential export onto an empty database', () => {
    const csv = asCsv(exportSitesWithCredentials(KEY).rows);
    closeDatabase();

    openDatabase(':memory:');
    const report = importSitesCsv(csv, KEY);

    expect(report.added).toBe(1);
    expect(report.withCredentials).toBe(1);

    const site = getSiteByDomain('bitespoon.com')!;
    expect(site.daily_target).toBe(3);
    expect(site.interval_minutes).toBe(480);
    expect(site.pin_username).toBe('pinner');
    expect(siteSecrets(site, KEY)).toEqual({
      apiToken: 'site-token',
      bufferToken: 'buffer-token',
    });
  });

  it('survives a token encrypted under a different key', () => {
    // siteSecrets returns '' rather than throwing, so the export is missing a
    // value instead of the page being a 500.
    const csv = asCsv(exportSitesWithCredentials(randomBytes(32)).rows);
    expect(csv).not.toContain('site-token');
  });
});
