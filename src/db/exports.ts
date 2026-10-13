/**
 * What the platform made, as spreadsheets.
 *
 * Articles and reels are the product; keywords and sites are the person's
 * own lists, exported in the shape their importers read back so they can be
 * edited in a spreadsheet and returned. Runs, steps, decisions and events
 * are not here: they are the platform's working, and nobody asked for them
 * in a sheet.
 */
import { all } from './index.js';
import { siteSecrets, type SiteRow } from './repos.js';

export type Dataset = 'keywords' | 'sites' | 'articles' | 'reels';

export const DATASETS: readonly Dataset[] = ['keywords', 'sites', 'articles', 'reels'];

export interface Export {
  filename: string;
  rows: string[][];
}

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/** A dataset as header row plus data rows, ready to be written as CSV. */
export function exportDataset(dataset: Dataset): Export {
  switch (dataset) {
    case 'keywords': {
      // Shaped so the export can be re-imported: the same columns the CSV
      // importer reads, one per site, holding go / done / no.
      const domains = all<{ id: number; domain: string }>(
        'SELECT id, domain FROM sites ORDER BY id',
      );
      const links = new Map(
        all<{ keyword_id: number; site_id: number; status: string }>(
          'SELECT keyword_id, site_id, status FROM keyword_sites',
        ).map((l) => [`${l.keyword_id}:${l.site_id}`, l.status] as const),
      );
      const keywords = all<Record<string, unknown>>(
        `SELECT id, seed_keyword, spy_title, spy_description, annotation, status
           FROM keywords ORDER BY id`,
      );

      return {
        filename: 'keywords.csv',
        rows: [
          ['seed_keyword', 'spy_title', 'spy_description', 'annotation', 'status',
            ...domains.map((d) => d.domain)],
          ...keywords.map((k) => [
            text(k.seed_keyword), text(k.spy_title), text(k.spy_description),
            text(k.annotation), text(k.status),
            ...domains.map((d) => links.get(`${Number(k.id)}:${d.id}`) ?? ''),
          ]),
        ],
      };
    }

    case 'sites': {
      // No tokens. An export is a file that ends up in a downloads folder, and
      // this one should be safe to attach to a message without thinking.
      // exportSitesWithCredentials is the deliberate other choice.
      //
      // Every other column round-trips through importSitesCsv, which reads a
      // blank token as "keep the stored one" — so this file can be edited in a
      // spreadsheet and imported back without erasing the secrets it omits.
      const rows = all<Record<string, unknown>>(
        `SELECT name, domain, status, daily_target, interval_minutes,
                pin_username, project_id, auto_publish, paused_reason
           FROM sites ORDER BY id`,
      );
      return {
        filename: 'sites.csv',
        rows: [
          ['name', 'domain', 'status', 'daily_target', 'interval_minutes',
            'pin_username', 'project_id', 'auto_publish', 'paused_reason',
            'api_token', 'buffer_token'],
          ...rows.map((r) => [
            text(r.name), text(r.domain), text(r.status), text(r.daily_target),
            text(r.interval_minutes), text(r.pin_username), text(r.project_id),
            r.auto_publish === 1 ? 'yes' : 'no', text(r.paused_reason),
            // Present but empty, so the shape matches the credential export and
            // the columns are there to fill in by hand.
            '', '',
          ]),
        ],
      };
    }

    case 'articles':
      return exportArticles();

    case 'reels':
      return exportReels();
  }
}

/**
 * The latest successful output of each step, per run, parsed.
 *
 * The step outputs are where everything the model wrote lives -- the title,
 * the image links, the pin -- and a step that ran twice keeps both rows, so
 * the newest ok one wins.
 */
function stepOutputs(): Map<number, Map<string, unknown>> {
  const byRun = new Map<number, Map<string, unknown>>();
  const rows = all<{ run_id: number; step: string; output_json: string | null }>(
    `SELECT run_id, step, output_json FROM run_steps
      WHERE status = 'ok' AND output_json IS NOT NULL ORDER BY id`,
  );
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.output_json!);
    } catch {
      continue;
    }
    let steps = byRun.get(row.run_id);
    if (!steps) byRun.set(row.run_id, (steps = new Map()));
    steps.set(row.step, parsed);
  }
  return byRun;
}

const field = (value: unknown, key: string): string =>
  value && typeof value === 'object' ? text((value as Record<string, unknown>)[key]) : '';

/** The images step keeps the path the article uses; a sheet wants the link. */
const onSite = (domain: unknown, path: string): string => {
  if (!path || /^https?:\/\//.test(path)) return path;
  const host = text(domain).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return host ? `https://${host}${path}` : path;
};

/**
 * One row per article the platform made: what it is, where it went, and the
 * pictures and pin that went with it. The body is left out on purpose --
 * thousands of words a row is not something a spreadsheet opens.
 */
function exportArticles(): Export {
  const outputs = stepOutputs();
  const runs = all<Record<string, unknown>>(
    `SELECT r.id, r.status, r.title, r.post_id, r.post_url,
            s.domain AS site, k.seed_keyword AS keyword
       FROM runs r
       LEFT JOIN sites s ON s.id = r.site_id
       LEFT JOIN keywords k ON k.id = r.keyword_id
      ORDER BY r.id`,
  );
  return {
    filename: 'articles.csv',
    rows: [
      ['run_id', 'site', 'keyword', 'status', 'title', 'description', 'category',
        'post_url', 'post_id', 'hero_image', 'method_shot_1', 'method_shot_2',
        'method_shot_3', 'pin_image', 'pin_description'],
      ...runs.map((r) => {
        const steps = outputs.get(Number(r.id)) ?? new Map<string, unknown>();
        const seo = steps.get('validate-spy');
        const images = steps.get('generate-images');
        const pin = steps.get('generate-pin-image');
        return [
          text(r.id), text(r.site), text(r.keyword), text(r.status),
          field(seo, 'title') || text(r.title), field(seo, 'description'),
          field(seo, 'category'), text(r.post_url), text(r.post_id),
          onSite(r.site, field(images, 'hero')), onSite(r.site, field(images, 'stepA')),
          onSite(r.site, field(images, 'stepB')), onSite(r.site, field(images, 'stepC')),
          field(pin, 'url'),
          text(steps.get('generate-pin-description')),
        ];
      }),
    ],
  };
}

/** One row per reel: what it is, which page it is for, and where the video is. */
function exportReels(): Export {
  const reels = all<Record<string, unknown>>(
    `SELECT r.status, r.stage, r.format, r.caption, r.video_url, r.fb_video_id, r.error,
            s.domain AS site, k.seed_keyword AS keyword,
            COALESCE(NULLIF(run.title, ''), k.spy_title) AS title,
            p.name AS fb_page,
            (SELECT COUNT(*) FROM reel_scenes sc WHERE sc.reel_id = r.id) AS scenes
       FROM reels r
       LEFT JOIN sites s    ON s.id = r.site_id
       LEFT JOIN keywords k ON k.id = r.keyword_id
       LEFT JOIN runs run   ON run.id = r.run_id
       LEFT JOIN fb_pages p ON p.id = r.fb_page_id
      ORDER BY r.id`,
  );
  return {
    filename: 'reels.csv',
    rows: [
      ['site', 'keyword', 'title', 'fb_page', 'status', 'mode', 'format', 'scenes',
        'caption', 'video_url', 'facebook_url', 'error'],
      ...reels.map((r) => {
        // A single-clip reel never enters the studio's stages and has no
        // shape; anything else is a storyboard.
        const scenes = r.stage !== 'done' || text(r.format) !== '' || Number(r.scenes) > 0;
        return [
          text(r.site), text(r.keyword), text(r.title), text(r.fb_page), text(r.status),
          scenes ? 'scenes' : 'single', text(r.format), scenes ? text(r.scenes) : '',
          text(r.caption), text(r.video_url),
          r.fb_video_id ? `https://www.facebook.com/reel/${text(r.fb_video_id)}` : '',
          text(r.error),
        ];
      }),
    ],
  };
}

/**
 * Every site with its credentials in plain text.
 *
 * Kept apart from exportDataset('sites') deliberately. That one omits the
 * tokens so it can be shared, diffed, or attached to a message without
 * thinking about it; this one is a file that can publish to all your sites,
 * and the difference has to be a separate deliberate action rather than a flag
 * somebody passes by accident.
 *
 * Round-trips through importSitesCsv, which treats a blank token as "keep the
 * stored one" — so the safe export can be edited and imported back without
 * erasing the secrets it does not contain.
 */
export function exportSitesWithCredentials(encryptionKey: Buffer): Export {
  const rows = all<SiteRow>('SELECT * FROM sites ORDER BY id');

  return {
    filename: 'sites-with-credentials.csv',
    rows: [
      ['name', 'domain', 'status', 'daily_target', 'interval_minutes', 'pin_username',
        'project_id', 'auto_publish', 'paused_reason', 'api_token', 'buffer_token'],
      ...rows.map((site) => {
        const secrets = siteSecrets(site, encryptionKey);
        return [
          site.name,
          site.domain,
          site.status,
          String(site.daily_target),
          String(site.interval_minutes),
          site.pin_username,
          site.project_id,
          site.auto_publish === 1 ? 'yes' : 'no',
          site.paused_reason,
          secrets.apiToken,
          secrets.bufferToken,
        ];
      }),
    ],
  };
}
