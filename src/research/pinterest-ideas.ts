import { all, get, run } from '../db/index.js';
import { addPastedKeywords, getProfile, listProfiles, researchRepeats, type ChannelProfile } from '../db/repos.js';
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

/**
 * One row of the export that says something: a pin, or a board (Pinterest's
 * export lists both, and a board's name is a topic in itself).
 */
export interface PinRow {
  kind: 'pin' | 'board';
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
  /** The Pinterest account the export came from; its keyword pins there. */
  profile_id: number | null;
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
  /** The Pinterest account the export is for, by its username. */
  account?: { id: number; username: string } | null;
  /** The username the file's own links show, when they show one. */
  detected?: string;
  /** Why the account could not be told, or a doubt about it. */
  accountNote?: string;
  error?: string;
}

/* -- Reading the export ------------------------------------------------------ */

/** "Clics sur l'épingle" -> "clics sur l epingle": accents, case and punctuation do not matter. */
const norm = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

type Field = keyof Omit<PinRow, 'score' | 'kind'> | 'description' | 'destination' | 'date';

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
  ['date', /^(date|jour)$/],
  ['url', /^(pin (link|url)|pinterest (link|url)|lien pinterest|lien (de|vers) l ?epingle|url de l ?epingle|pin)$/],
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
export const pinScore = (p: Omit<PinRow, 'score' | 'kind' | 'title' | 'url'>): number =>
  Math.round(p.outbound * 10 + p.saves * 5 + p.pinClicks * 2 + (p.outbound + p.saves + p.pinClicks === 0 ? p.engagements * 2 : 0) + p.impressions / 100);

/**
 * The pins and boards of a Pinterest Analytics export, best first.
 *
 * The export is several tables one after another, each under its own header
 * and a line or two of notes: the daily numbers (Date, Impressions), then Top
 * boards, then Top pins. Every header that names impressions starts a table;
 * a table keyed by date is the daily overview and gives nothing to write
 * after. A board is named from its address (".../banana-bread-recipes/" ->
 * "banana bread recipes"). A pin row usually carries only its link: its title
 * is left empty here and looked up from Pinterest before the model reads it.
 * Columns may come in English or French, separated by commas, semicolons or
 * tabs; a "Total" row is not a pin.
 */
export function parsePinterestCsv(text: string): PinRow[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sample = body.split('\n').slice(0, 40).join('\n');
  const delimiter = ([',', ';', '\t'] as const)
    .map((d) => [d, sample.split(d).length] as const)
    .sort((a, b) => b[1] - a[1])[0]![0];
  const rows = parseCsv(body, delimiter);

  const found = new Map<string, PinRow>();
  let columns: (Field | null)[] | null = null;
  for (const cells of rows) {
    if (cells.length >= 2 && cells.some((c) => fieldOf(c) === 'impressions')) {
      columns = cells.map(fieldOf);
      continue;
    }
    // A note, a table's own title, a blank line: one cell, no numbers.
    if (!columns || cells.length < 2 || cells.every((c) => !c.trim())) continue;
    if (columns.includes('date')) continue; // the daily overview
    const at = (field: Field) => {
      const i = columns!.indexOf(field);
      return i < 0 ? '' : (cells[i] ?? '').trim();
    };

    const link = at('url');
    const destination = at('destination');
    const isPin = /\/pin\/\d+/.test(link);
    const isBoard = !isPin && /pinterest\.[a-z.]+\/[^/]+\/[^/]+/.test(link);
    const description = at('description').replace(/\s+/g, ' ');
    const title = (at('title') || description.slice(0, 120) || (isBoard ? slugWords(link) : '') || slugWords(destination))
      .replace(/\s+/g, ' ')
      .trim();
    if (/^(total|totaux?|all|tous)$/i.test(title)) continue;
    // Nothing to name it by, and no pin link to look a name up with.
    if (!title && !isPin) continue;

    const numbers = {
      impressions: count(at('impressions')),
      saves: count(at('saves')),
      pinClicks: count(at('pinClicks')),
      outbound: count(at('outbound')),
      engagements: count(at('engagements')),
    };
    const row: PinRow = {
      kind: isBoard ? 'board' : 'pin',
      title,
      url: link.startsWith('http') ? link : destination.startsWith('http') ? destination : '',
      ...numbers,
      score: pinScore(numbers),
    };
    // The same pin listed twice (two tables, two ranges): its better line.
    const key = row.url || norm(title);
    const had = found.get(key);
    if (!had || had.score < row.score) found.set(key, row);
  }
  return [...found.values()].sort((a, b) => b.score - a.score || b.impressions - a.impressions);
}

/**
 * The Pinterest username the export belongs to, read from its board links
 * ("pinterest.com/ArbmomRecipes/banana-bread-recipes/" -> "ArbmomRecipes").
 * The most frequent one, since a file is one account's; '' when the file
 * lists no boards.
 */
export function exportUsername(text: string): string {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/pinterest\.[a-z.]+\/([A-Za-z0-9_]{3,30})\/[^/\s",]+\/?/g)) {
    const user = m[1]!;
    if (/^(pin|search|ideas|today|business|settings|_)$/i.test(user)) continue;
    counts.set(user, (counts.get(user) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/** A Pinterest account's username: the name on Buffer when it is set, else the username field. */
const usernameOf = (p: Pick<ChannelProfile, 'channel_name' | 'buffer_channel'>): string => (p.channel_name || p.buffer_channel || '').trim();

/**
 * Which of the site's Pinterest accounts an export is for. The username in
 * the file decides when it matches one; the account picked on the page is
 * used when the file shows none. A pick the file contradicts is reported,
 * and the file wins, since it cannot be wrong about whose numbers it holds.
 */
export function exportAccount(
  siteId: number,
  detected: string,
  pickedId: number,
): { account: ChannelProfile | null; note: string } {
  const accounts = listProfiles(siteId, 'pinterest');
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const byFile = detected
    ? accounts.find((p) => same(p.channel_name, detected) || same(p.buffer_channel ?? '', detected))
    : undefined;
  const picked = pickedId ? accounts.find((p) => p.id === pickedId) : undefined;
  if (byFile) {
    return {
      account: byFile,
      note: picked && picked.id !== byFile.id ? `You picked ${usernameOf(picked)}, but the file is ${detected}'s: its ideas go to ${detected}.` : '',
    };
  }
  if (picked) {
    return { account: picked, note: detected ? `The file is ${detected}'s, which is none of this site's accounts; its ideas go to ${usernameOf(picked)} as picked.` : '' };
  }
  return {
    account: null,
    note: detected
      ? `The file is ${detected}'s, which is none of this site's Pinterest accounts: its ideas pin in turn, like any keyword.`
      : 'The file names no account and none was picked: its ideas pin in turn, like any keyword.',
  };
}

/* -- Asking for ideas -------------------------------------------------------- */

/** How many of the best pins the model reads, and how many ideas it may give. */
export const PINS_READ = 25;
export const IDEAS_WANTED = 12;

/** The pins as the prompt shows them. */
export const pinLines = (pins: PinRow[]): string =>
  pins
    .slice(0, PINS_READ)
    .map((p, i) => {
      // A pin from the Top pins table often has only its impressions: no zeros for numbers it was never given.
      const known = p.saves + p.pinClicks + p.outbound + p.engagements > 0;
      const numbers = known
        ? `${p.impressions} impressions, ${p.saves} saves, ${p.pinClicks} pin clicks, ${p.outbound} outbound clicks`
        : `${p.impressions} impressions`;
      return `${i + 1}. [${p.kind}] ${p.title.slice(0, 160)} — ${numbers}`;
    })
    .join('\n');

/** How many untitled pins are looked up on Pinterest, and how many at once. */
const LOOKUPS = 30;
const AT_ONCE = 4;

/**
 * Give the untitled pins their titles, from Pinterest, a few at a time. A pin
 * whose title cannot be found is left out: the model cannot learn anything
 * from a bare number.
 */
async function nameThePins(
  rows: PinRow[],
  pinTitle: ((url: string) => Promise<string>) | undefined,
  progress: (done: number, total: number) => void = () => undefined,
): Promise<PinRow[]> {
  const untitled = rows.filter((r) => !r.title && r.url).slice(0, LOOKUPS);
  if (pinTitle) {
    progress(0, untitled.length);
    for (let i = 0; i < untitled.length; i += AT_ONCE) {
      await Promise.all(
        untitled.slice(i, i + AT_ONCE).map(async (r) => {
          try {
            r.title = (await pinTitle(r.url)).replace(/\s+/g, ' ').trim().slice(0, 160);
          } catch {
            r.title = '';
          }
        }),
      );
      progress(Math.min(i + AT_ONCE, untitled.length), untitled.length);
    }
  }
  return rows.filter((r) => r.title);
}

export interface PinIdeasDeps {
  ask(vars: { pins: string; count: number; existing: string }): Promise<string>;
  /** A pin's title, from its page on Pinterest; '' when there is none to read. */
  pinTitle?(url: string): Promise<string>;
  /** Where the work stands, for the page: looking up titles (done of total), asking the model, saving. */
  progress?(stage: PinIdeasStage, done?: number, total?: number): void;
}

export type PinIdeasStage = 'reading' | 'titles' | 'ai' | 'saving';

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
export async function analyseExport(
  siteId: number,
  fileName: string,
  text: string,
  deps: PinIdeasDeps,
  today: string,
  pickedProfileId = 0,
): Promise<PinIdeasReport> {
  const report: PinIdeasReport = { day: today, file: fileName, pins: 0, top: [], summary: '', found: 0 };
  let profileId: number | null = null;
  try {
    const detected = exportUsername(text);
    const { account, note } = exportAccount(siteId, detected, pickedProfileId);
    profileId = account?.id ?? null;
    report.account = account ? { id: account.id, username: usernameOf(account) || account.label } : null;
    report.detected = detected;
    report.accountNote = note;
    deps.progress?.('reading');
    const rows = parsePinterestCsv(text);
    if (rows.length === 0) {
      throw new Error('no pins or boards in this file — export it from Pinterest Analytics → Overview → Export, with the date range you want');
    }
    const pins = await nameThePins(rows, deps.pinTitle, (done, total) => deps.progress?.('titles', done, total));
    report.pins = pins.length;
    report.top = pins.slice(0, 15);
    if (pins.length === 0) {
      throw new Error('the pins in this file have no titles, and Pinterest did not give them — try again later');
    }

    const known = existingTitles(siteId);
    deps.progress?.('ai');
    const answer = parseJson(
      await deps.ask({ pins: pinLines(pins), count: IDEAS_WANTED, existing: known.slice(-80).map((t) => `- ${t}`).join('\n') || '- (none yet)' }),
      'the pin ideas',
    ) as { summary?: unknown; ideas?: { title?: unknown; group?: unknown; from?: unknown }[] };
    report.summary = String(answer.summary ?? '').trim().slice(0, 800);

    deps.progress?.('saving');
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
        `INSERT OR IGNORE INTO pin_ideas (site_id, title, topic, source, source_url, score, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        siteId, title.slice(0, 200), topic, from?.title.slice(0, 300) ?? '', from?.url ?? '', from?.score ?? 0, profileId,
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
  // By topic and by account: each keyword is told which Pinterest account its pin goes to.
  const groups = new Map<string, { topic: string; profileId: number | null; lines: string[] }>();
  for (const r of rows) {
    const topic = r.topic || 'pinterest';
    // An account removed since the upload: the turn, like any keyword.
    const profileId = r.profile_id && getProfile(r.profile_id)?.site_id === siteId ? r.profile_id : null;
    const key = `${topic}\u0000${profileId ?? 0}`;
    const g = groups.get(key) ?? { topic, profileId, lines: [] };
    g.lines.push(r.title);
    groups.set(key, g);
  }
  let added = 0;
  for (const g of groups.values()) {
    const r = addPastedKeywords(g.lines, g.topic, [siteId], g.profileId ? { pinProfileId: g.profileId } : {});
    added += r.added + r.linked;
  }
  mark(siteId, rows.map((r) => r.id), 'added');
  return added;
}

export const dismissPinIdeas = (siteId: number, ids: number[]): number => mark(siteId, ids, 'dismissed');

/**
 * Remove ideas from the list, the ticked ones or every one on a tab. Unlike
 * Dismiss, nothing remembers them: a later upload may propose them again. An
 * added idea's keyword stays in Keywords; only its line here goes.
 */
export function deletePinIdeas(siteId: number, status: PinIdea['status'], ids: number[] | 'all'): number {
  if (ids === 'all') return run('DELETE FROM pin_ideas WHERE site_id = ? AND status = ?', siteId, status).changes;
  if (!ids.length) return 0;
  return run(
    `DELETE FROM pin_ideas WHERE site_id = ? AND status = ? AND id IN (${ids.map(() => '?').join(',')})`,
    siteId, status, ...ids,
  ).changes;
}
