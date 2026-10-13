import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { getLinksForKeyword, listKeywords, upsertSite } from '../src/db/repos.js';
import { importKeywordsCsv } from '../src/web/import.js';
import { normaliseDomain, sameDomain } from '../src/lib/domain.js';

const KEY = randomBytes(32);

const site = (domain: string): number =>
  upsertSite(
    {
      name: domain,
      domain,
      status: 'active',
      pin_username: '',
      project_id: '',
      daily_target: 3,
      interval_minutes: 60,
    },
    KEY,
  );

describe('writing a domain', () => {
  it('reduces every spelling of one site to the same thing', () => {
    for (const written of [
      'bitespoon.com',
      'BITESPOON.COM',
      'https://bitespoon.com',
      'http://bitespoon.com',
      'https://www.bitespoon.com',
      'www.bitespoon.com',
      'https://bitespoon.com/',
      'https://bitespoon.com/recipes?a=1',
      '  bitespoon.com  ',
      'https://bitespoon.com:8443',
    ]) {
      expect(normaliseDomain(written), written).toBe('bitespoon.com');
    }
  });

  it('keeps different sites apart', () => {
    expect(sameDomain('bitespoon.com', 'longlivo.com')).toBe(false);
    expect(sameDomain('shop.bitespoon.com', 'bitespoon.com')).toBe(false);
  });

  it('treats empty as matching nothing, including other empties', () => {
    expect(sameDomain('', '')).toBe(false);
    expect(sameDomain('https://', 'www.')).toBe(false);
  });
});

describe('linking imported keywords to sites', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  /**
   * The reported bug: a CSV whose headings carried the scheme matched nothing,
   * so 24 keywords imported and zero links were set. The import said
   * "Imported 24 keyword(s)" and the queue stayed empty.
   */
  it('matches a scheme-prefixed heading to a bare stored domain', () => {
    site('bitespoon.com');

    const report = importKeywordsCsv('seed_keyword,https://bitespoon.com\nchicken,go\n');

    expect(report.matchedDomains).toBe(1);
    expect(report.linksSet).toBe(1);
    expect(report.unknownDomains).toEqual([]);
  });

  it('matches a bare heading to a scheme-prefixed stored domain', () => {
    // The other half of the same bug: writing the CSV the "clean" way still
    // failed, because it was the stored side carrying the scheme.
    site('https://bitespoon.com');

    const report = importKeywordsCsv('seed_keyword,bitespoon.com\nchicken,go\n');

    expect(report.linksSet).toBe(1);
  });

  it('matches regardless of www, case, or a trailing slash', () => {
    site('bitespoon.com');
    site('longlivo.com');

    const report = importKeywordsCsv(
      'seed_keyword,https://WWW.Bitespoon.com/,LONGLIVO.COM\nchicken,go,go\n',
    );

    expect(report.linksSet).toBe(2);
  });

  it('still reports a heading that matches no configured site', () => {
    site('bitespoon.com');

    const report = importKeywordsCsv('seed_keyword,https://nowhere.com\nchicken,go\n');

    expect(report.matchedDomains).toBe(0);
    expect(report.unknownDomains).toEqual(['https://nowhere.com']);
  });

  it('records the status written in each cell', () => {
    const a = site('a.com');
    const b = site('b.com');

    importKeywordsCsv('seed_keyword,https://a.com,https://b.com\nchicken,go,done\n');

    const links = getLinksForKeyword(listKeywords()[0]!.id);
    expect(links.find((l) => l.site_id === a)?.status).toBe('go');
    expect(links.find((l) => l.site_id === b)?.status).toBe('done');
  });

  it('leaves an empty cell unlinked rather than guessing', () => {
    site('a.com');
    site('b.com');

    const report = importKeywordsCsv('seed_keyword,a.com,b.com\nchicken,go,\n');

    expect(report.linksSet).toBe(1);
  });
});

describe('importing the same file twice', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  const csv = 'seed_keyword,spy_title,a.com\nchicken,Roast chicken,go\nbeef,Beef stew,go\n';

  it('updates rather than duplicating', () => {
    site('a.com');

    importKeywordsCsv(csv);
    const second = importKeywordsCsv(csv);

    // Re-importing is the normal correction after a first attempt that matched
    // no columns. Duplicating would leave 24 useless rows behind every fix.
    expect(listKeywords()).toHaveLength(2);
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(2);
  });

  it('applies the corrected links to the keywords already there', () => {
    site('bitespoon.com');

    const first = importKeywordsCsv('seed_keyword,wrongdomain.com\nchicken,go\n');
    expect(first.linksSet).toBe(0);

    const second = importKeywordsCsv('seed_keyword,bitespoon.com\nchicken,go\n');

    expect(listKeywords()).toHaveLength(1);
    expect(second.linksSet).toBe(1);
    expect(getLinksForKeyword(listKeywords()[0]!.id)).toHaveLength(1);
  });

  it('refreshes a row when the same article comes round again', () => {
    site('a.com');
    importKeywordsCsv('seed_keyword,spy_title,spy_description\nchicken,Honey Soy Thighs,old\n');

    importKeywordsCsv('seed_keyword,spy_title,spy_description\nchicken,Honey Soy Thighs,new\n');

    expect(listKeywords()).toHaveLength(1);
    expect(listKeywords()[0]?.spy_description).toBe('new');
  });

  /**
   * Spying on one topic yields five or ten different recipes under it, so the
   * seed keyword is a research label rather than an identity. Keying on it
   * meant a file of five Chicken Thighs recipes imported as one row, four of
   * them silently overwritten — one article, one set of images, repeated.
   */
  describe('several recipes under one topic', () => {
    const FILE =
      'seed_keyword,spy_title\n' +
      'Chicken Thighs,Baked Chicken Thighs in Honey Soy Sauce\n' +
      'Chicken Thighs,One-pot chicken and rice\n' +
      'Chicken Thighs,Caramelized BBQ Chicken Thighs in the Oven\n' +
      'Chicken Thighs,Creamy Garlic Chicken Thighs\n';

    it('keeps every recipe as its own keyword', () => {
      site('a.com');
      const report = importKeywordsCsv(FILE);

      expect(report.imported).toBe(4);
      expect(listKeywords()).toHaveLength(4);
    });

    it('keeps each recipe title, rather than the last line winning', () => {
      site('a.com');
      importKeywordsCsv(FILE);

      expect(listKeywords().map((k) => k.spy_title)).toEqual([
        'Baked Chicken Thighs in Honey Soy Sauce',
        'One-pot chicken and rice',
        'Caramelized BBQ Chicken Thighs in the Oven',
        'Creamy Garlic Chicken Thighs',
      ]);
    });

    it('leaves them all sharing the topic label', () => {
      site('a.com');
      importKeywordsCsv(FILE);

      expect(new Set(listKeywords().map((k) => k.seed_keyword))).toEqual(
        new Set(['Chicken Thighs']),
      );
    });

    it('gives each its own images, since the store is keyed by keyword', () => {
      site('a.com');
      importKeywordsCsv(FILE);

      const ids = listKeywords().map((k) => k.id);
      expect(new Set(ids).size).toBe(4);
    });

    it('does not duplicate them when the same file is imported twice', () => {
      site('a.com');
      importKeywordsCsv(FILE);
      const second = importKeywordsCsv(FILE);

      expect(listKeywords()).toHaveLength(4);
      expect(second.imported).toBe(0);
      expect(second.updated).toBe(4);
    });

    it('still collapses rows that carry no article title at all', () => {
      site('a.com');
      // Nothing distinguishes these two, so treating them as one row is right.
      importKeywordsCsv('seed_keyword\nchicken\nchicken\n');

      expect(listKeywords()).toHaveLength(1);
    });
  });

  it('matches the seed keyword regardless of case', () => {
    site('a.com');
    importKeywordsCsv('seed_keyword\nChicken\n');

    importKeywordsCsv('seed_keyword\nCHICKEN\n');

    expect(listKeywords()).toHaveLength(1);
  });
});

describe('repairing domains already stored', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('rewrites a stored domain that carries a scheme', async () => {
    const { normaliseStoredDomains, listSites } = await import('../src/db/repos.js');
    site('https://bitespoon.com/');

    const result = normaliseStoredDomains(normaliseDomain);

    expect(result.changed).toEqual(['https://bitespoon.com/ -> bitespoon.com']);
    expect(listSites()[0]?.domain).toBe('bitespoon.com');
  });

  it('leaves an already-clean domain alone', async () => {
    const { normaliseStoredDomains } = await import('../src/db/repos.js');
    site('bitespoon.com');

    expect(normaliseStoredDomains(normaliseDomain).changed).toEqual([]);
  });

  it('is safe to run twice', async () => {
    const { normaliseStoredDomains, listSites } = await import('../src/db/repos.js');
    site('https://bitespoon.com');

    normaliseStoredDomains(normaliseDomain);
    const second = normaliseStoredDomains(normaliseDomain);

    expect(second.changed).toEqual([]);
    expect(listSites()).toHaveLength(1);
  });

  it('refuses to merge two sites that would collide', async () => {
    const { normaliseStoredDomains, listSites } = await import('../src/db/repos.js');
    site('bitespoon.com');
    site('https://bitespoon.com');

    const result = normaliseStoredDomains(normaliseDomain);

    // Quietly merging two configured sites — each with its own tokens and
    // publishing history — is worse than leaving the inconsistency visible.
    expect(result.changed).toEqual([]);
    expect(result.conflicted).toHaveLength(1);
    expect(listSites()).toHaveLength(2);
  });

  it('lets the repaired site match a bare CSV heading afterwards', async () => {
    const { normaliseStoredDomains } = await import('../src/db/repos.js');
    site('https://bitespoon.com');
    normaliseStoredDomains(normaliseDomain);

    const report = importKeywordsCsv('seed_keyword,bitespoon.com\nchicken,go\n');

    expect(report.linksSet).toBe(1);
  });
});
