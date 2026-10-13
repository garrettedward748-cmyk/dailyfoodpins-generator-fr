import { gunzipSync, gzipSync } from 'node:zlib';
import { all, get, run, transaction } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { findKeywordRow, getSite, getSiteByDomain, type FbPageRow } from '../db/repos.js';

const log = createLogger('site-backup');

/**
 * A backup of ONE site: the site, everything that belongs to it, and nothing
 * that belongs to another site or to the platform.
 *
 * What is in it
 *   the site row (every setting on it) and its two tokens
 *   its accounts on each network, with their boards, and their Buffer tokens
 *   the keywords linked to it, the state of each for this site, shared images
 *   blog questions, Radar sources and posts, Search Console opportunities,
 *   Taxonomy jobs
 *   its history: runs and reels. That is what keeps rotation (the last three
 *   designs, styles, structures), today's count and "already published" honest
 *   after a restore, instead of starting from nothing
 *   its Facebook pages (name, what they take)
 *
 * What is not
 *   media files, the step-by-step log of runs that finished, events, Google
 *   accounts, prompts and the rotation lists: those are shared by every site,
 *   so restoring one site must not touch them.
 *
 * Tokens travel in the clear. They are encrypted in the database with this
 * platform's key, and a file that only works on the platform that wrote it
 * would not survive the move it is most useful for. Each token is re-encrypted
 * with the receiving platform's key on the way in. The file is therefore as
 * sensitive as the platform's full backups, which carry the key itself.
 *
 * Ids are never trusted across platforms: every row is inserted fresh and
 * every reference between rows is remapped as it goes in.
 */

export const SITE_BACKUP_FORMAT = 1;

type Row = Record<string, unknown>;
type Value = string | number | null;

export interface SiteBackupFile {
  kind: 'site-backup';
  format: number;
  created: string;
  domain: string;
  site: Row;
  profiles: Row[];
  bufferAccounts: Row[];
  keywords: { row: Row; link: Row | null; images: Row | null }[];
  blogQuestions: Row[];
  socialSources: Row[];
  socialPosts: Row[];
  gscOpportunities: Row[];
  taxonomyJobs: Row[];
  runs: Row[];
  runSteps: Row[];
  reels: Row[];
  fbPages: Row[];
}

export interface SiteBackupResult {
  file: SiteBackupFile;
  /** Things the person should know about the file, in plain words. */
  warnings: string[];
}

/* -------------------------------------------------------------------------
 * Export
 * ---------------------------------------------------------------------- */

/** The keywords a site's backup carries: linked to it, or named by its history. */
const KEYWORD_IDS = `
  SELECT keyword_id FROM keyword_sites WHERE site_id = ?
  UNION SELECT keyword_id FROM runs  WHERE site_id = ? AND keyword_id IS NOT NULL
  UNION SELECT keyword_id FROM reels WHERE site_id = ? AND keyword_id IS NOT NULL`;

export function buildSiteBackup(siteId: number, key: Buffer): SiteBackupResult {
  const site = getSite(siteId);
  if (!site) throw new Error('Site not found.');

  let unreadable = 0;
  const open = (value: unknown): string => {
    if (typeof value !== 'string' || value === '') return '';
    try {
      return decrypt(value, key);
    } catch {
      unreadable++;
      return '';
    }
  };

  const siteRow: Row = { ...site };
  siteRow.api_token = open(site.api_token_encrypted);
  siteRow.buffer_token = open(site.buffer_token_encrypted);
  delete siteRow.api_token_encrypted;
  delete siteRow.buffer_token_encrypted;
  delete siteRow.id;

  const bufferAccounts = all<Row>('SELECT * FROM buffer_accounts WHERE site_id = ? ORDER BY position, id', siteId).map((row) => {
    const out: Row = { ...row, token: open(row.token_encrypted) };
    delete out.token_encrypted;
    delete out.id;
    delete out.site_id;
    return out;
  });

  const links = new Map(
    all<Row>('SELECT * FROM keyword_sites WHERE site_id = ?', siteId).map((r) => [Number(r.keyword_id), r]),
  );
  const images = new Map(
    all<Row>(`SELECT * FROM keyword_images WHERE keyword_id IN (${KEYWORD_IDS})`, siteId, siteId, siteId).map((r) => [Number(r.keyword_id), r]),
  );
  const keywords = all<Row>(`SELECT * FROM keywords WHERE id IN (${KEYWORD_IDS}) ORDER BY id`, siteId, siteId, siteId).map((row) => ({
    row,
    link: links.get(Number(row.id)) ?? null,
    images: images.get(Number(row.id)) ?? null,
  }));

  const file: SiteBackupFile = {
    kind: 'site-backup',
    format: SITE_BACKUP_FORMAT,
    created: new Date().toISOString(),
    domain: site.domain,
    site: siteRow,
    profiles: all<Row>('SELECT * FROM channel_profiles WHERE site_id = ? ORDER BY platform, position, id', siteId),
    bufferAccounts,
    keywords,
    blogQuestions: all<Row>('SELECT * FROM blog_questions WHERE site_id = ? ORDER BY id', siteId),
    socialSources: all<Row>('SELECT * FROM social_sources WHERE site_id = ? ORDER BY id', siteId),
    socialPosts: all<Row>('SELECT * FROM social_posts WHERE site_id = ? ORDER BY id', siteId),
    gscOpportunities: all<Row>('SELECT * FROM gsc_opportunities WHERE site_id = ? ORDER BY id', siteId),
    taxonomyJobs: all<Row>('SELECT * FROM taxonomy_jobs WHERE site_id = ? ORDER BY id', siteId),
    // A run that is running belongs to this process and means nothing elsewhere.
    runs: all<Row>("SELECT * FROM runs WHERE site_id = ? AND status <> 'running' ORDER BY id", siteId),
    // Only for runs that can still resume. A published run's steps are spent.
    runSteps: all<Row>(
      `SELECT * FROM run_steps WHERE run_id IN
         (SELECT id FROM runs WHERE site_id = ? AND (status = 'failed' OR hold = 'awaiting'))`,
      siteId,
    ),
    // In-flight reels point at media that is not in the file.
    reels: all<Row>("SELECT * FROM reels WHERE site_id = ? AND status IN ('published', 'failed') ORDER BY id", siteId),
    fbPages: all<FbPageRow>('SELECT * FROM fb_pages WHERE site_id = ? ORDER BY id', siteId).map((p) => ({
      page_id: p.page_id, name: p.name, posts: p.posts, reels: p.reels,
      enabled: p.enabled, auto_publish: p.auto_publish, profile_id: p.profile_id,
    })),
  };

  const warnings: string[] = [];
  if (unreadable > 0) {
    warnings.push(
      `${unreadable} token${unreadable === 1 ? '' : 's'} could not be read with this platform's key and ${unreadable === 1 ? 'was' : 'were'} saved empty. Enter ${unreadable === 1 ? 'it' : 'them'} again after restoring.`,
    );
  }
  return { file, warnings };
}

/** The file as it is downloaded: compressed JSON. */
export const encodeSiteBackup = (file: SiteBackupFile): Buffer => gzipSync(Buffer.from(JSON.stringify(file)));

const stamp = (d = new Date()): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);

export const siteBackupName = (domain: string, now = new Date()): string =>
  `site-${domain.replace(/[^A-Za-z0-9.-]/g, '_')}-${stamp(now)}.json.gz`;

/* -------------------------------------------------------------------------
 * Reading a file back
 * ---------------------------------------------------------------------- */

const asRows = (value: unknown): Row[] => (Array.isArray(value) ? (value.filter((r) => r && typeof r === 'object') as Row[]) : []);

/** Check a file and shape it; throws a sentence the person can act on. */
export function parseSiteBackup(data: Buffer): SiteBackupFile {
  let text: string;
  try {
    text = (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data).toString('utf8');
  } catch {
    throw new Error('This file cannot be read: it is not a site backup.');
  }
  let parsed: Row;
  try {
    parsed = JSON.parse(text) as Row;
  } catch {
    throw new Error('This file cannot be read: it is not a site backup.');
  }
  if (parsed.kind !== 'site-backup') throw new Error('This file is not a site backup (it may be a full platform backup: restore that under Setup → Backups).');
  if (Number(parsed.format) > SITE_BACKUP_FORMAT) throw new Error('This backup was made by a newer version of the platform. Update the platform first.');
  const site = parsed.site as Row | undefined;
  const domain = typeof parsed.domain === 'string' ? parsed.domain.trim() : '';
  if (!site || typeof site !== 'object' || !domain) throw new Error('This site backup is incomplete: it has no site in it.');

  return {
    kind: 'site-backup',
    format: Number(parsed.format) || 1,
    created: String(parsed.created ?? ''),
    domain,
    site,
    profiles: asRows(parsed.profiles),
    bufferAccounts: asRows(parsed.bufferAccounts),
    keywords: (Array.isArray(parsed.keywords) ? parsed.keywords : [])
      .filter((k): k is { row: Row; link: Row | null; images: Row | null } => Boolean(k && typeof k === 'object' && (k as Row).row))
      .map((k) => ({ row: k.row, link: k.link ?? null, images: k.images ?? null })),
    blogQuestions: asRows(parsed.blogQuestions),
    socialSources: asRows(parsed.socialSources),
    socialPosts: asRows(parsed.socialPosts),
    gscOpportunities: asRows(parsed.gscOpportunities),
    taxonomyJobs: asRows(parsed.taxonomyJobs),
    runs: asRows(parsed.runs),
    runSteps: asRows(parsed.runSteps),
    reels: asRows(parsed.reels),
    fbPages: asRows(parsed.fbPages),
  };
}

/* -------------------------------------------------------------------------
 * Restore
 * ---------------------------------------------------------------------- */

export interface RestoreReport {
  domain: string;
  /** True when the site did not exist and was created; false when it was replaced. */
  created: boolean;
  counts: Record<string, number>;
  warnings: string[];
}

const columnsOf = (table: string): Set<string> => new Set(all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name));

/**
 * Insert one row, whatever it was saved with. Columns the file has and this
 * database does not are dropped (a newer platform wrote it); columns this
 * database has and the file lacks take their defaults (an older one did).
 * Column names are checked against the table itself, so a file cannot name
 * anything else. `id` is never carried: ids are this database's to hand out.
 */
function insertRow(table: string, row: Row, override: Row = {}, verb = 'INSERT'): number {
  const have = columnsOf(table);
  const merged: Row = { ...row, ...override };
  delete merged.id;
  const cols = Object.keys(merged).filter((c) => have.has(c));
  const sql = `${verb} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return run(sql, ...cols.map((c) => (merged[c] ?? null) as Value)).lastInsertRowid;
}

const parseObject = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** A profile id from the file, as it is now. 0 means "no account" and stays 0. */
const mapId = (map: Map<number, number>, id: unknown): number | undefined => {
  const n = Number(id);
  return n === 0 ? 0 : map.get(n);
};

/** runs.profiles_json: { network: profileId } */
function remapProfilesJson(value: unknown, profiles: Map<number, number>): string {
  const parsed = parseObject(value);
  if (!parsed) return '';
  const out: Record<string, number> = {};
  for (const [network, id] of Object.entries(parsed)) {
    const now = mapId(profiles, id);
    if (now !== undefined) out[network] = now;
  }
  return JSON.stringify(out);
}

/** runs.fanout_json: { network: { profileId: postId } } */
function remapFanoutJson(value: unknown, profiles: Map<number, number>): string | null {
  const parsed = parseObject(value);
  if (!parsed) return null;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [network, posted] of Object.entries(parsed)) {
    if (!posted || typeof posted !== 'object') continue;
    out[network] = {};
    for (const [id, postId] of Object.entries(posted as Record<string, unknown>)) {
      const now = mapId(profiles, id);
      if (now !== undefined) out[network]![String(now)] = postId;
    }
  }
  return JSON.stringify(out);
}

/**
 * reels.channels_json: where a reel went. Keys are "network" or
 * "network:profileId", and `targets` lists profile ids per network.
 */
function remapChannelsJson(value: unknown, profiles: Map<number, number>): string | null {
  const parsed = parseObject(value);
  if (!parsed) return null;
  const out: Record<string, unknown> = {};
  for (const [name, state] of Object.entries(parsed)) {
    if (name === 'targets' && state && typeof state === 'object') {
      const targets: Record<string, unknown> = {};
      for (const [network, ids] of Object.entries(state as Record<string, unknown>)) {
        targets[network] = Array.isArray(ids) ? ids.map((id) => mapId(profiles, id) ?? 0) : ids;
      }
      out.targets = targets;
    } else if (name.includes(':')) {
      const [network, id] = name.split(':') as [string, string];
      const now = mapId(profiles, id);
      // An account that did not come across leaves the record under the bare network.
      if (now) out[`${network}:${now}`] = state;
      else if (!(network in out)) out[network] = state;
    } else {
      out[name] = state;
    }
  }
  return JSON.stringify(out);
}

/** The rows a site owns, which a replace removes before the backup's go in. */
const OWNED_TABLES = [
  'reels', 'runs', 'social_sources', 'social_posts', 'gsc_opportunities', 'taxonomy_jobs',
  'blog_questions', 'keyword_sites', 'channel_profiles', 'buffer_accounts',
];

/**
 * Put a site back from its backup.
 *
 * The site is found by its domain. Not there: it is created. There: its data is
 * replaced by the backup's, in place, so the site keeps its id and nothing else
 * that points at it is disturbed. All of it happens in one transaction, so a
 * file that turns out to be broken halfway leaves the site exactly as it was.
 *
 * Callers take a full platform backup first (see the route): this is a
 * replacement, and the person should be able to undo it.
 */
export function restoreSiteBackup(file: SiteBackupFile, key: Buffer): RestoreReport {
  const counts: Record<string, number> = {};
  const warnings: string[] = [];

  const existing = getSiteByDomain(file.domain);
  if (existing) {
    if (get('SELECT 1 FROM runs WHERE site_id = ? AND status = ?', existing.id, 'running')) {
      throw new Error('An article is being made for this site right now. Wait for it to finish, then restore.');
    }
    if (get("SELECT 1 FROM reels WHERE site_id = ? AND status IN ('generating', 'publishing')", existing.id)) {
      throw new Error('A reel is being made for this site right now. Wait for it to finish, then restore.');
    }
  }

  const seal = (value: unknown): string => (typeof value === 'string' && value !== '' ? encrypt(value, key) : '');

  transaction(() => {
    // The site row. Tokens leave the file in the clear and go in sealed.
    const siteRow: Row = { ...file.site, domain: file.domain };
    siteRow.api_token_encrypted = seal(file.site.api_token);
    siteRow.buffer_token_encrypted = seal(file.site.buffer_token);
    delete siteRow.api_token;
    delete siteRow.buffer_token;

    let siteId: number;
    if (existing) {
      siteId = existing.id;
      for (const table of OWNED_TABLES) run(`DELETE FROM ${table} WHERE site_id = ?`, siteId);
      const have = columnsOf('sites');
      const cols = Object.keys(siteRow).filter((c) => have.has(c) && c !== 'id');
      run(`UPDATE sites SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => (siteRow[c] ?? null) as Value), siteId);
    } else {
      siteId = insertRow('sites', siteRow);
    }

    // Accounts. Their ids are new, so remember which is which.
    const profiles = new Map<number, number>();
    for (const row of file.profiles) {
      profiles.set(Number(row.id), insertRow('channel_profiles', row, { site_id: siteId }));
    }
    counts.accounts = profiles.size;

    for (const row of file.bufferAccounts) {
      const profileId = row.profile_id == null ? null : (profiles.get(Number(row.profile_id)) ?? null);
      insertRow('buffer_accounts', { ...row, token_encrypted: seal(row.token) }, { site_id: siteId, profile_id: profileId });
    }
    counts.bufferTokens = file.bufferAccounts.length;

    // Keywords are shared between sites: one that is already here is reused,
    // by the same identity the importer uses, and only linked.
    const keywords = new Map<number, number>();
    let reused = 0;
    for (const { row, link, images } of file.keywords) {
      const found = findKeywordRow(String(row.seed_keyword ?? ''), String(row.spy_title ?? ''));
      const id = found ? found.id : insertRow('keywords', row);
      if (found) reused++;
      keywords.set(Number(row.id), id);
      if (link) insertRow('keyword_sites', link, { keyword_id: id, site_id: siteId }, 'INSERT OR REPLACE');
      // Images belong to the keyword, so another site's copy wins.
      if (images) insertRow('keyword_images', images, { keyword_id: id, source_site_id: siteId }, 'INSERT OR IGNORE');
    }
    counts.keywords = file.keywords.length;
    counts.keywordsAlreadyHere = reused;

    for (const row of file.blogQuestions) insertRow('blog_questions', row, { site_id: siteId });
    counts.blogQuestions = file.blogQuestions.length;

    const sources = new Map<number, number>();
    for (const row of file.socialSources) sources.set(Number(row.id), insertRow('social_sources', row, { site_id: siteId }));
    for (const row of file.socialPosts) {
      const sourceId = sources.get(Number(row.source_id));
      if (sourceId) insertRow('social_posts', row, { site_id: siteId, source_id: sourceId });
    }
    counts.radarSources = file.socialSources.length;
    counts.radarPosts = file.socialPosts.length;

    for (const row of file.gscOpportunities) insertRow('gsc_opportunities', row, { site_id: siteId });
    for (const row of file.taxonomyJobs) insertRow('taxonomy_jobs', row, { site_id: siteId });
    counts.searchConsole = file.gscOpportunities.length;
    counts.taxonomy = file.taxonomyJobs.length;

    // History.
    const runs = new Map<number, number>();
    for (const row of file.runs) {
      const keywordId = row.keyword_id == null ? null : (keywords.get(Number(row.keyword_id)) ?? null);
      runs.set(Number(row.id), insertRow('runs', row, {
        site_id: siteId,
        keyword_id: keywordId,
        profiles_json: remapProfilesJson(row.profiles_json, profiles),
        fanout_json: remapFanoutJson(row.fanout_json, profiles),
      }));
    }
    for (const row of file.runSteps) {
      const runId = runs.get(Number(row.run_id));
      if (runId) insertRow('run_steps', row, { run_id: runId });
    }
    counts.runs = file.runs.length;

    for (const row of file.reels) {
      insertRow('reels', row, {
        site_id: siteId,
        run_id: row.run_id == null ? null : (runs.get(Number(row.run_id)) ?? null),
        keyword_id: row.keyword_id == null ? null : (keywords.get(Number(row.keyword_id)) ?? null),
        // Pages are shared and numbered per platform; the page a reel went to
        // is on the reel's own record of where it was posted.
        fb_page_id: null,
        output_path: '',
        channels_json: remapChannelsJson(row.channels_json, profiles),
      });
    }
    counts.reels = file.reels.length;

    // A Facebook page belongs to a site, so it travels with it. A page this
    // platform already has (same Facebook page id) is left as it is: it is the
    // same page, and whichever site it is on keeps it.
    let pagesAdded = 0;
    for (const page of file.fbPages) {
      // A page set from an account card carries a synthetic id built from the
      // old platform's own profile id ("profile:<id>"), which means nothing
      // here and could even collide with an unrelated page by chance. It is
      // re-made fresh on the matching restored account instead of matched by
      // that id, and skips the cross-platform dedupe below, which is for a
      // real Facebook page id or a hand-added one, both portable as they are.
      const oldProfileId = page.profile_id == null ? null : Number(page.profile_id);
      const newProfileId = oldProfileId == null ? null : (profiles.get(oldProfileId) ?? null);
      if (oldProfileId !== null && newProfileId !== null) {
        insertRow('fb_pages', page, { site_id: siteId, niche: null, profile_id: newProfileId, page_id: `profile:${newProfileId}` });
        pagesAdded++;
        continue;
      }

      const existing = get<{ site_id: number | null; name: string }>('SELECT site_id, name FROM fb_pages WHERE page_id = ?', String(page.page_id ?? ''));
      if (existing) {
        if (existing.site_id !== null && existing.site_id !== siteId) {
          warnings.push(`Facebook page “${String(page.name ?? '')}” is already on this platform for another site, so it was not added to ${file.domain}. Move it under Channels → Accounts → Facebook pages if it should be here.`);
        }
        continue;
      }
      insertRow('fb_pages', page, { site_id: siteId, niche: null, profile_id: null });
      pagesAdded++;
    }
    counts.facebookPagesAdded = pagesAdded;
  });

  if (counts.keywordsAlreadyHere) {
    warnings.push(`${counts.keywordsAlreadyHere} keyword${counts.keywordsAlreadyHere === 1 ? ' was' : 's were'} already on this platform and ${counts.keywordsAlreadyHere === 1 ? 'was' : 'were'} linked, not duplicated.`);
  }
  log.info(`site ${file.domain} ${existing ? 'replaced from' : 'created from'} backup`);
  return { domain: file.domain, created: !existing, counts, warnings };
}
