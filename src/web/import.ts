import { parseCsvTable } from '../lib/csv.js';
import {
  findKeywordRow,
  getSiteByDomain,
  insertKeyword,
  listSites,
  setLink,
  updateKeywordFields,
  upsertSite,
} from '../db/repos.js';
import { normaliseDomain } from '../lib/domain.js';
import { all, transaction } from '../db/index.js';
import { DishIndex } from '../core/similar-title.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('import');

/**
 * CSV import for keywords and their per-site status.
 *
 * Bulk entry stays where it works well — a spreadsheet — while the database
 * remains the source of truth. Unlike the sheet this replaces, a duplicate
 * site column cannot produce contradictory state: the last value simply wins
 * on a single row, and the UNIQUE constraint enforces one status per pair.
 */

const KEYWORD_FIELDS = new Set([
  'seed_keyword',
  'spy_title',
  'spy_description',
  'spy_image_url',
  'spy_article_url',
  'spy_pin_image',
  'annotation',
  'status',
  'row_number',
]);

/** Accept the old sheet's headers as well as the new ones. */
const ALIASES: Record<string, string> = {
  'seed keyword': 'seed_keyword',
  'spy title': 'spy_title',
  'spy description': 'spy_description',
  'spy image url': 'spy_image_url',
  'spy article url': 'spy_article_url',
  'spy pin image': 'spy_pin_image',
  row: 'status',
  keyword: 'seed_keyword',
};

const normaliseHeader = (header: string): string => {
  const lower = header.trim().toLowerCase();
  return ALIASES[lower] ?? lower.replace(/\s+/g, '_');
};

const normaliseStatus = (value: string): 'go' | 'done' | 'no' => {
  const v = value.trim().toLowerCase();
  if (v === 'go') return 'go';
  if (v === 'done') return 'done';
  return 'no';
};

export interface ImportReport {
  imported: number;
  updated: number;
  /** Site columns that matched a configured site. */
  matchedDomains: number;
  skipped: number;
  linksSet: number;
  unknownDomains: string[];
  errors: string[];
  /** Rows left out because an existing keyword already names the same dish: "new" ≈ "existing". */
  similar: string[];
}

/** Every keyword's dish title, for telling a new line that repeats one. */
function keywordDishIndex(): DishIndex {
  return new DishIndex(
    all<{ t: string }>("SELECT CASE WHEN trim(spy_title) <> '' THEN spy_title ELSE seed_keyword END AS t FROM keywords")
      .map((r) => r.t),
  );
}

export function importKeywordsCsv(csv: string): ImportReport {
  const { headers, rows } = parseCsvTable(csv);

  const report: ImportReport = {
    imported: 0,
    updated: 0,
    matchedDomains: 0,
    skipped: 0,
    linksSet: 0,
    unknownDomains: [],
    errors: [],
    similar: [],
  };

  if (headers.length === 0) {
    report.errors.push('The file appears to be empty.');
    return report;
  }

  const normalised = headers.map(normaliseHeader);
  if (!normalised.includes('seed_keyword')) {
    report.errors.push(
      'No "seed_keyword" column found. Expected a column named seed_keyword (or "Seed keyword").',
    );
    return report;
  }

  // Any header that is not a known keyword field is treated as a site domain.
  //
  // Both sides are normalised. A column heading is typed by a person into a
  // spreadsheet and a stored domain is typed by a person into a form, so the
  // same site turns up as bitespoon.com, https://bitespoon.com, www., a
  // trailing slash, or any mix. Comparing raw strings meant one spelling
  // matched and the rest silently did not — the import then reported success
  // while linking every keyword to nothing.
  const knownDomains = new Map(listSites().map((s) => [normaliseDomain(s.domain), s.id]));
  const domainColumns: { header: string; siteId: number }[] = [];
  const unknown = new Set<string>();

  headers.forEach((header, index) => {
    const key = normalised[index]!;
    if (KEYWORD_FIELDS.has(key) || key === '') return;

    const siteId = knownDomains.get(normaliseDomain(header));
    if (siteId) domainColumns.push({ header, siteId });
    else unknown.add(header);
  });

  report.unknownDomains = [...unknown];
  report.matchedDomains = domainColumns.length;

  const dishes = keywordDishIndex();

  transaction(() => {
    rows.forEach((row, rowIndex) => {
      const value = (key: string): string => {
        const index = normalised.indexOf(key);
        return index === -1 ? '' : (row[headers[index]!] ?? '');
      };

      const seed = value('seed_keyword').trim();
      if (!seed) {
        report.skipped++;
        return;
      }

      try {
        const fields = {
          spy_title: value('spy_title'),
          spy_description: value('spy_description'),
          spy_image_url: value('spy_image_url'),
          spy_article_url: value('spy_article_url'),
          spy_pin_image: value('spy_pin_image'),
          annotation: value('annotation'),
          status: normaliseStatus(value('status') || 'go'),
        };

        // Importing the same file twice is normal — the first attempt is often
        // the one where the site columns did not match. Updating the existing
        // keyword makes that a correction rather than 24 more rows.
        //
        // Matched on the article title, not the seed. The seed is a research
        // label that five different recipes legitimately share; keying on it
        // meant a file of five Chicken Thighs recipes imported as one row,
        // four of them silently overwritten.
        const existing = findKeywordRow(seed, fields.spy_title);
        let keywordId: number;
        if (existing) {
          updateKeywordFields(existing.id, fields);
          keywordId = existing.id;
          report.updated++;
        } else {
          // Not the same line again, but maybe the same dish in other words:
          // "Mini Blueberry Cheesecakes" and "Mini Blueberry Cheesecakes –
          // Individual Desserts" would publish the same recipe twice.
          const dishTitle = fields.spy_title.trim() || seed;
          const twin = dishes.find(dishTitle);
          if (twin) {
            report.skipped++;
            report.similar.push(`“${dishTitle}” ≈ “${twin}”`);
            return;
          }
          keywordId = insertKeyword({ seed_keyword: seed, ...fields });
          dishes.add(dishTitle);
          report.imported++;
        }

        for (const column of domainColumns) {
          const cell = (row[column.header] ?? '').trim();
          if (cell === '') continue;
          setLink(keywordId, column.siteId, normaliseStatus(cell));
          report.linksSet++;
        }
      } catch (err) {
        report.skipped++;
        report.errors.push(
          `Row ${rowIndex + 2}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  });

  log.info(
    `imported ${report.imported} keyword(s), ${report.linksSet} link(s), skipped ${report.skipped}`,
  );
  return report;
}

/** Import sites from the old KEYS sheet layout. */
export interface SiteImportReport {
  added: number;
  updated: number;
  skipped: number;
  /** Rows that carried a token, so the reader knows secrets were in that file. */
  withCredentials: number;
  errors: string[];
}

/**
 * Bulk site entry from a spreadsheet, credentials included.
 *
 * Credentials used to be refused here on the grounds that the sheet this
 * replaced repeated one shared token across every row. That is no longer true
 * — each domain has its own publishing token and its own Buffer account — and
 * typing twelve pairs of them into a form one at a time is the kind of setup
 * step that gets abandoned halfway.
 *
 * A blank token means "keep whatever is stored", the same rule the edit form
 * follows. That is what makes it safe to round-trip the credential-free export:
 * importing it back changes the settings and leaves the secrets alone.
 */
export function importSitesCsv(csv: string, encryptionKey: Buffer): SiteImportReport {
  const { rows } = parseCsvTable(csv);
  const report: SiteImportReport = {
    added: 0,
    updated: 0,
    skipped: 0,
    withCredentials: 0,
    errors: [],
  };

  transaction(() => {
    for (const row of rows) {
      const pick = (...names: string[]): string => {
        for (const name of names) {
          const found = Object.entries(row).find(
            ([k]) => k.trim().toLowerCase() === name.toLowerCase(),
          );
          if (found?.[1]) return found[1];
        }
        return '';
      };

      // Normalised on the way in, for the same reason headings are normalised
      // on the way out: a domain typed into a spreadsheet carries a scheme,
      // www, or a trailing slash about half the time, and a stored domain that
      // keeps them cannot be matched by anything typed the other way.
      const domain = normaliseDomain(pick('Domain', 'domain'));
      if (!domain) {
        report.skipped++;
        continue;
      }

      try {
        const existing = getSiteByDomain(domain);
        const toNumber = (value: string, fallback: number): number => {
          const n = Number(value);
          return Number.isFinite(n) ? n : fallback;
        };

        // Minutes is what is stored. The old sheet expressed the gap in hours,
        // and the export writes minutes, so both are accepted.
        const minutes = pick('interval_minutes');
        const hours = pick('hours_between');
        const intervalMinutes = minutes
          ? Math.round(toNumber(minutes, 480))
          : hours
            ? Math.round(toNumber(hours, 8) * 60)
            : (existing?.interval_minutes ?? 480);

        const apiToken = pick('api_token', 'Site API token').trim();
        const bufferToken = pick('buffer_token', 'Buffer API token').trim();
        if (apiToken || bufferToken) report.withCredentials++;

        // Absent column and empty cell are the same thing on purpose: a sheet
        // exported without credentials must not wipe the ones already stored.
        const autoPublish = pick('auto_publish').trim().toLowerCase();

        upsertSite(
          {
            name: pick('Website Name', 'name') || existing?.name || domain,
            domain,
            status: pick('status').toLowerCase() === 'active' ? 'active' : 'paused',
            pin_username: pick('Pin username', 'pin_username'),
            project_id: pick('Project ID', 'project_id'),
            daily_target: toNumber(pick('daily_target'), existing?.daily_target ?? 0),
            interval_minutes: intervalMinutes,
            paused_reason: pick('paused_reason'),
            auto_publish:
              autoPublish === ''
                ? (existing?.auto_publish ?? 1) === 1
                : !['0', 'no', 'false', 'off', 'manual', 'approval'].includes(autoPublish),
            // Blank leaves the stored credential untouched — upsertSite's rule.
            apiToken,
            bufferToken,
          },
          encryptionKey,
        );

        if (existing) report.updated++;
        else report.added++;
      } catch (err) {
        report.errors.push(`${domain}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  log.info(
    `imported ${report.added} site(s), updated ${report.updated}, skipped ${report.skipped}`,
  );
  return report;
}
