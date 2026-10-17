import { all, get, run } from '../db/index.js';
import { addPastedKeywords, researchRepeats } from '../db/repos.js';
import { halalOnly, haramWord } from '../core/halal.js';
import { DishIndex } from '../core/similar-title.js';
import { parseCsv } from '../lib/csv.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { parseJson } from '../pipeline/json.js';

const log = createLogger('pin-ideas');

/**
 * Pinterest ideas: what already works on a site's Pinterest, turned into the
 * next articles.
 *
 * Pinterest gives no API for another account's numbers and asks a business
 * app to be reviewed for its own, so the numbers come the way Pinterest hands
 * them to anyone: Analytics -> export the CSV, then upload it here. The pins
 * are scored, the strongest are shown, and the model is asked for new article
 * ideas in the same vein ("the pizza pin travels: these three are its
 * neighbours"). As on Radar, only the idea is kept: ticked ones go to
 * Keywords, and the pipeline writes each article from scratch.
 */

/** One pin of the export, with the numbers that matter. */
export interface PinRow {
  title: string;
  url: string;
  impressions: number;
  saves: number;
  pinClicks: number;
  outbound: number;
  engagements: number;
  score: number;
}

export interface PinIdea {
  id: number;
  site_id: number;
  title: string;
  topic: string;
  source: string;
  source_url: string;
  score: number;
  status: 'new' | 'added' | 'dismissed';
  created_at: string;
}

export interface PinIdeasReport {
  day: string;
  file: string;
  pins: number;
  /** The strongest pins of the export, best first, as shown on the page. */
  top: PinRow[];
  /** What the model says these pins have in common. */
  summary: string;
  found: number;
  error?: string;
}

/* -- Reading the export ------------------------------------------------------ */

/** "Clics sur l'épingle" -> "clics sur l epingle": accents, case and punctuation do not matter. */
const norm = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

type Field = keyof Omit<PinRow, 'score'> | 'description' | 'destination';

/**
 * Which column is which, in the English and French exports. Order matters: the
 * first rule a header meets wins, so "outbound clicks" is never read as
 * "pin clicks", nor "pin link" as the pin's title.
 */
const COLUMNS: [Field, RegExp][] = [
  ['outbound', /^(outbound( link)? clicks?|clics? sortants?|clics? sur le lien|link clicks?)$/],
  ['pinClicks', /^(pin clicks?|clics? sur l ?epingle|clics? sur epingle|closeups?|gros plans?)$/],
  ['saves', /^(saves?|enregistrements?|epingles? enregistrees?|repins?)$/],
  ['impressions', /^impressions?$/],
  ['engagements', /^(engagements?|total engagements?|interactions?)$/],
  ['url', /^(pin (link|url)|lien (de|vers) l ?epingle|url de l ?epingle|pin)$/],
  ['destination', /^(destination( url| link)?|url de destination|lien de destination|link|url|lien|outbound link)$/],
  ['title', /^(pin )?(title|titre)( de l ?epingle)?$/],
  ['description', /^(pin )?description( de l ?epingle)?$/],
];

const fieldOf = (header: string): Field | null => {
  const h = norm(header);
  for (const [field, re] of COLUMNS) if (re.test(h)) return field;
  return null;
};

/** 1,234 · 1 234 · 1.2K · "—": a count, whatever the locale wrote. */
export function count(value: string | undefined): number {
  const v = (value ?? '').replace(/[\s  ]/g, '').toLowerCase();
  if (!v || !/\d/.test(v)) return 0;
  const k = /k$/.test(v) ? 1_000 : /m$/.test(v) ? 1_000_000 : 1;
  const digits = v.replace(/[km]$/, '');
  // With a suffix, "1.2" or "1,2" is a decimal; without one, a separator is a thousands mark.
  const n = k > 1 ? Number(digits.replace(',', '.')) : Number(digits.replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * k) : 0;
}

/** The words of an address's last part: ".../lemon-pizza-bites/" -> "lemon pizza bites". */
const slugWords = (url: string): string => {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const last = parts.at(-1) ?? '';
    return /^\d+$/.test(last) ? '' : decodeURIComponent(last).replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' ').trim();
  } catch {
    return '';
  }
};

/**
 * How strongly a pin works. An outbound click is a visit to the site, which is
 * the point; a save is the next best sign (it keeps the pin travelling); a
 * close-up shows interest. Impressions alone count for little: Pinterest
 * decides those.
 */
export const pinScore = (p: Omit<PinRow, 'score'>): number =>
  Math.round(p.outbound * 10 + p.saves * 5 + p.pinClicks * 2 + (p.outbound + p.saves + p.pinClicks === 0 ? p.engagements * 2 : 0) + p.impressions / 100);

/**
 * The pins of a Pinterest Analytics export, best first.
 *
 * The export can open with a few lines about the date range before its table,
 * use commas, semicolons or tabs, and name its columns in English or French;
 * the header is the first row that names impressions. A row with no title, no
 * description and no address to read one from is not a pin anyone can write
 * after, and a "Total" row is not a pin at all.
 */
export function parsePinterestCsv(text: string): PinRow[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sample = body.split('\n').slice(0, 15).join('\n');
  const delimiter = ([',', ';', '\t'] as const)
    .map((d) => [d, sample.split(d).length] as const)
    .sort((a, b) => b[1] - a[1])[0]![0];
  const rows = parseCsv(body, delimiter);

  const headerAt = rows.findIndex((r) => r.length >= 2 && r.some((c) => fieldOf(c) === 'impressions'));
  if (headerAt < 0) return [];
  const columns = rows[headerAt]!.map(fieldOf);
  const at = (cells: string[], field: Field) => {
    const i = columns.indexOf(field);
    return i < 0 ? '' : (cells[i] ?? '').trim();
  };

  const byTitle = new Map<string, PinRow>();
  for (const cells of rows.slice(headerAt + 1)) {
    if (cells.every((c) => !c.trim())) continue;
    const url = at(cells, 'url');
    const destination = at(cells, 'destination');
    const description = at(cells, 'description').replace(/\s+/g, ' ');
    const title = (at(cells, 'title') || description.slice(0, 120) || slugWords(destination)).replace(/\s+/g, ' ').trim();
    if (!title || /^(total|totaux?|all|tous)$/i.test(title)) continue;
    const base = {
      title,
      url: url.startsWith('http') ? url : destination.startsWith('http') ? destination : '',
      impressions: count(at(cells, 'impressions')),
      saves: count(at(cells, 'saves')),
      pinClicks: count(at(cells, 'pinClicks')),
      outbound: count(at(cells, 'outbound')),
      engagements: count(at(cells, 'engagements')),
    };
    const pin = { ...base, score: pinScore(base) };
    // The same pin listed twice (two date ranges in one file): its better line.
    const key = norm(title);
    const had = byTitle.get(key);
    if (!had || had.score < pin.score) byTitle.set(key, pin);
  }
  return [...byTitle.values()].sort((a, b) => b.score - a.score);
}

/* -- Asking for ideas -------------------------------------------------------- */

/** How many of the best pins the model reads, and how many ideas it may give. */
export const PINS_READ = 25;
export const IDEAS_WANTED = 12;

/** The pins as the prompt shows them. */
export const pinLines = (pins: PinRow[]): string =>
  pins
    .slice(0, PINS_READ)
    .map(
      (p, i) =>
        `${i + 1}. ${p.title.slice(0, 160)} — ${p.impressions} impressions, ${p.saves} saves, ${p.pinClicks} pin clicks, ${p.outbound} outbound clicks`,
    )
    .join('\n');

export interface PinIdeasDeps {
  ask(vars: { pins: string; count: number; existing: string }): Promise<string>;
}

/** What this site already has or has waiting, so no idea comes back as yesterday's article. */
function existingTitles(siteId: number): string[] {
  return [
    ...researchRepeats([siteId]).here,
    ...all<{ t: string }>('SELECT title AS t FROM pin_ideas WHERE site_id = ?', siteId).map((r) => r.t),
  ];
}

/**
 * Read an export for a site, ask for ideas, keep the new ones.
 *
 * The report is saved whatever happens, so the page always says what the
 * last upload did -- including "this file has no pins in it", which is the
 * usual mistake (the account's daily overview exported instead of its pins).
 */
export async function analyseExport(siteId: number, fileName: string, text: string, deps: PinIdeasDeps, today: string): Promise<PinIdeasReport> {
  const report: PinIdeasReport = { day: today, file: fileName, pins: 0, top: [], summary: '', found: 0 };
  try {
    const pins = parsePinterestCsv(text);
    report.pins = pins.length;
    report.top = pins.slice(0, 15);
    if (pins.length === 0) {
      throw new Error('no pins in this file — export the table of pins (Analytics → Top pins → Export), not the daily overview');
    }

    const known = existingTitles(siteId);
    const answer = parseJson(
      await deps.ask({ pins: pinLines(pins), count: IDEAS_WANTED, existing: known.slice(-80).map((t) => `- ${t}`).join('\n') || '- (none yet)' }),
      'the pin ideas',
    ) as { summary?: unknown; ideas?: { title?: unknown; group?: unknown; from?: unknown }[] };
    report.summary = String(answer.summary ?? '').trim().slice(0, 800);

    const twins = new DishIndex(known);
    const halal = halalOnly();
    const read = pins.slice(0, PINS_READ);
    let found = 0;
    for (const idea of answer.ideas ?? []) {
      const title = String(idea.title ?? '').replace(/\s+/g, ' ').trim();
      if (title.length < 3 || twins.find(title) || (halal && haramWord(title))) continue;
      twins.add(title);
      const from = read[Number(idea.from) - 1];
      const topic = String(idea.group ?? '').trim().toLowerCase().slice(0, 40);
      found += run(
        `INSERT OR IGNORE INTO pin_ideas (site_id, title, topic, source, source_url, score) VALUES (?, ?, ?, ?, ?, ?)`,
        siteId, title.slice(0, 200), topic, from?.title.slice(0, 300) ?? '', from?.url ?? '', from?.score ?? 0,
      ).changes;
    }
    report.found = found;
  } catch (err) {
    report.error = errorMessage(err);
  }
  run('UPDATE sites SET pin_ideas_report = ? WHERE id = ?', JSON.stringify(report), siteId);
  log.info(`pin ideas site ${siteId}: ${report.pins} pin(s), ${report.found} idea(s)${report.error ? ` — ${report.error}` : ''}`);
  return report;
}

/* -- The ideas waiting, and the verdicts ---------------------------------- */

export const listPinIdeas = (siteId: number, status: PinIdea['status']): PinIdea[] =>
  all<PinIdea>('SELECT * FROM pin_ideas WHERE site_id = ? AND status = ? ORDER BY score DESC, id DESC LIMIT 300', siteId, status);

export const waitingPinIdeas = (siteId: number): number =>
  get<{ n: number }>("SELECT COUNT(*) AS n FROM pin_ideas WHERE site_id = ? AND status = 'new'", siteId)?.n ?? 0;

export function lastPinReport(siteId: number): PinIdeasReport | null {
  const raw = get<{ r: string | null }>('SELECT pin_ideas_report AS r FROM sites WHERE id = ?', siteId)?.r;
  try {
    return raw ? (JSON.parse(raw) as PinIdeasReport) : null;
  } catch {
    return null;
  }
}

const mark = (siteId: number, ids: number[], status: PinIdea['status']): number => {
  if (!ids.length) return 0;
  return run(
    `UPDATE pin_ideas SET status = ? WHERE site_id = ? AND status = 'new' AND id IN (${ids.map(() => '?').join(',')})`,
    status, siteId, ...ids,
  ).changes;
};

/** The ticked ideas go to Keywords for this site, each under its topic. */
export function addPinIdeas(siteId: number, ids: number[]): number {
  if (!ids.length) return 0;
  const rows = all<PinIdea>(
    `SELECT * FROM pin_ideas WHERE site_id = ? AND status = 'new' AND id IN (${ids.map(() => '?').join(',')})`,
    siteId, ...ids,
  );
  const byTopic = new Map<string, string[]>();
  for (const r of rows) byTopic.set(r.topic || 'pinterest', [...(byTopic.get(r.topic || 'pinterest') ?? []), r.title]);
  let added = 0;
  for (const [topic, lines] of byTopic) {
    const r = addPastedKeywords(lines, topic, [siteId]);
    added += r.added + r.linked;
  }
  mark(siteId, rows.map((r) => r.id), 'added');
  return added;
}

export const dismissPinIdeas = (siteId: number, ids: number[]): number => mark(siteId, ids, 'dismissed');
