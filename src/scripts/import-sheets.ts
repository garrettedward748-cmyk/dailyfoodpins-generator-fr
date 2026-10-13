/**
 * One-time migration from the Google Sheets that ran the old system.
 *
 * Usage:
 *   npx tsx src/scripts/import-sheets.ts --keys KEYS.csv --spy "SPY DATA.csv"
 *
 * Export each sheet from Google Sheets with File → Download → CSV, then run
 * this. Sites are imported first so the SPY import can match its per-domain
 * columns to real site rows.
 */

import { readFileSync, existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { openDatabase, closeDatabase } from '../db/index.js';
import { importKeywordsCsv, importSitesCsv } from '../web/import.js';
import { listSites } from '../db/repos.js';
import { parseCsvTable } from '../lib/csv.js';
import { setLogLevel } from '../lib/logger.js';

interface Args {
  keys?: string;
  spy?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keys') args.keys = argv[++i];
    else if (argv[i] === '--spy') args.spy = argv[++i];
  }
  return args;
}

/**
 * The old SPY sheet had the same domain as two separate columns, which let a
 * keyword hold contradictory statuses. Report that clearly rather than
 * importing it silently — the reader deserves to know which value won.
 */
function warnAboutDuplicateColumns(csv: string): void {
  const { headers } = parseCsvTable(csv);
  const seen = new Map<string, number>();

  for (const header of headers) {
    const key = header.trim().toLowerCase();
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
  if (duplicates.length === 0) return;

  console.warn('\n⚠  Duplicate columns found in the SPY sheet:');
  for (const [name, count] of duplicates) {
    console.warn(`     "${name}" appears ${count} times — the rightmost value will be used.`);
  }
  console.warn(
    '   This is the defect that let a keyword look permanently eligible.\n' +
      '   Verify these keywords in the UI after importing.\n',
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!args.keys && !args.spy) {
    console.error(
      'Usage: tsx src/scripts/import-sheets.ts --keys KEYS.csv --spy "SPY DATA.csv"\n\n' +
        'Export each Google Sheet as CSV first (File → Download → CSV).',
    );
    process.exit(1);
  }

  const config = loadConfig();
  setLogLevel('info');
  openDatabase(config.dbPath);

  try {
    if (args.keys) {
      if (!existsSync(args.keys)) throw new Error(`File not found: ${args.keys}`);

      console.log(`\nImporting sites from ${args.keys}`);
      const result = importSitesCsv(readFileSync(args.keys, 'utf8'), config.encryptionKey);
      console.log(`  ✓ ${result.added} site(s) added, ${result.updated} updated`);
      if (result.skipped) console.log(`  · ${result.skipped} row(s) skipped (no domain)`);
      result.errors.forEach((e) => console.error(`  ✗ ${e}`));

      if (result.withCredentials > 0) {
        console.log(`\n  ${result.withCredentials} row(s) carried credentials.`);
      } else {
        console.log('\n  No credentials in that file. Each site needs its own pair:');
        console.log('    · Site API token    (Sites → open the site)');
        console.log('    · Buffer API token  (Sites → open the site)');
        console.log('  Add api_token and buffer_token columns, or fill them in the UI.');
      }
    }

    if (args.spy) {
      if (!existsSync(args.spy)) throw new Error(`File not found: ${args.spy}`);

      const csv = readFileSync(args.spy, 'utf8');
      warnAboutDuplicateColumns(csv);

      const known = listSites().map((s) => s.domain);
      if (known.length === 0) {
        console.warn('⚠  No sites in the database yet — per-domain columns cannot be matched.');
        console.warn('   Import KEYS first, then re-run with --spy.\n');
      }

      console.log(`Importing keywords from ${args.spy}`);
      const report = importKeywordsCsv(csv);
      console.log(`  ✓ ${report.imported} keyword(s), ${report.linksSet} site link(s)`);
      if (report.skipped) console.log(`  · ${report.skipped} row(s) skipped (no seed keyword)`);
      if (report.unknownDomains.length) {
        console.warn(`  ⚠ Unrecognised columns ignored: ${report.unknownDomains.join(', ')}`);
        console.warn('    Add those sites first if the columns were meant to be domains.');
      }
      report.errors.slice(0, 10).forEach((e) => console.error(`  ✗ ${e}`));
    }

    console.log('\nDone. Open the web UI to review before enabling automation.\n');
  } catch (err) {
    console.error(`\nImport failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    closeDatabase();
  }
}

main();
