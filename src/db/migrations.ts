import { createLogger } from '../lib/logger.js';
import type { Db } from './index.js';

const log = createLogger('migrate');

/**
 * Versioned schema changes, applied once each and recorded.
 *
 * schema.sql is all CREATE TABLE IF NOT EXISTS, which is a no-op against a
 * table that already exists — so a column added to one of those definitions
 * never reaches a database that has been deployed before. That was survivable
 * while nothing was live. It is not survivable now, and it had already broken:
 * a partial index added to schema.sql referenced a column that only existed on
 * fresh databases, so booting the new code against the deployed one failed
 * outright with "no such column: hold".
 *
 * The rules here:
 *
 *  - Every migration is idempotent on its own, so a half-applied state cannot
 *    wedge the next boot.
 *  - Each runs in a transaction and is recorded only if it commits.
 *  - Order is the array order, and it never changes. Appending is the only
 *    permitted edit to this list.
 *  - Nothing here drops a column, drops a table, or rewrites data. A migration
 *    that can lose something does not belong in a runner that executes
 *    unattended at boot; those go in a script somebody runs on purpose.
 */

export interface Migration {
  /** Stable identifier. Never renamed once deployed. */
  id: string;
  description: string;
  up(db: Db): void;
}

/* -- Idempotent helpers --------------------------------------------------- */

function hasTable(db: Db, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present: number } | undefined;
  return row !== undefined;
}

function columns(db: Db, table: string): string[] {
  if (!hasTable(db, table)) return [];
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * Add a column unless it is already there.
 *
 * The one schema change that is safe to apply unattended: it cannot lose data
 * and it cannot fail on a second run.
 *
 * CHECK constraints from schema.sql are deliberately not repeated in the
 * definitions passed here. SQLite cannot add a CHECK to an existing table
 * without rewriting the whole table, and rewriting a live table to gain a
 * constraint the application already enforces is a bad trade. A new database
 * gets the constraint from schema.sql; an older one gets the column and the
 * same behaviour.
 */
function addColumn(db: Db, table: string, column: string, definition: string): void {
  // No table means schema.sql has not created it yet, or this deployment never
  // had it. Either way there is nothing to alter and nothing to fix.
  if (!hasTable(db, table)) return;
  if (columns(db, table).includes(column)) return;

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  log.info(`added ${table}.${column}`);
}

/* -- The list ------------------------------------------------------------- */

export const MIGRATIONS: Migration[] = [
  {
    id: '001-share-images',
    description: 'Per keyword-and-site control over reusing article images',
    up(db) {
      addColumn(db, 'keyword_sites', 'share_images', 'INTEGER NOT NULL DEFAULT 1');
    },
  },

  {
    id: '002-site-pause-and-approval',
    description: 'A pause with a reason and an expiry, and per-site approval',
    up(db) {
      addColumn(db, 'sites', 'paused_reason', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'sites', 'paused_until', 'TEXT');
      addColumn(db, 'sites', 'auto_publish', 'INTEGER NOT NULL DEFAULT 1');
    },
  },

  {
    id: '003-run-mode-holds-retries',
    description: 'Dry runs, approval holds, automatic retries, and the published title',
    up(db) {
      addColumn(db, 'runs', 'mode', "TEXT NOT NULL DEFAULT 'live'");
      addColumn(db, 'runs', 'hold', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'runs', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'runs', 'retry_after', 'TEXT');
      addColumn(db, 'runs', 'title', "TEXT NOT NULL DEFAULT ''");
    },
  },

  {
    id: '004-run-indexes',
    description: 'Indexes over the columns 003 added',
    up(db) {
      // Separate from 003 on purpose. These are partial indexes over `hold`
      // and `retry_after`, so they cannot be created until those columns
      // exist. Having them in schema.sql — which runs before any column is
      // added — is precisely what broke booting against a deployed database.
      if (!columns(db, 'runs').includes('hold')) return;

      db.exec("CREATE INDEX IF NOT EXISTS idx_runs_hold ON runs (hold) WHERE hold != ''");
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_runs_retry ON runs (retry_after) ' +
          'WHERE retry_after IS NOT NULL',
      );
    },
  },

  {
    id: '005-step-usage',
    description: 'What each step cost, in tokens and images',
    up(db) {
      addColumn(db, 'run_steps', 'tokens_in', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'run_steps', 'tokens_out', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'run_steps', 'images', 'INTEGER NOT NULL DEFAULT 0');
    },
  },

  {
    id: '006-prompt-history-models-notices',
    description: 'Prompt versions, per-prompt models, notification de-duplication',
    up(db) {
      // Also in schema.sql, which is what creates them on a fresh database.
      // Repeated here so an existing one gets them without depending on the
      // order the two files happen to run in.
      db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_versions (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT    NOT NULL,
          body       TEXT    NOT NULL,
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_prompt_versions ON prompt_versions (name, id DESC);

        CREATE TABLE IF NOT EXISTS model_overrides (
          prompt     TEXT PRIMARY KEY,
          model      TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS notice_state (
          kind       TEXT PRIMARY KEY,
          state      TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },

  {
    id: '007-buffer-account-rotation',
    description: 'Per-site Buffer accounts, tried in order when a queue fills',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS buffer_accounts (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id          INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          label            TEXT    NOT NULL DEFAULT '',
          token_encrypted  TEXT    NOT NULL DEFAULT '',
          position         INTEGER NOT NULL DEFAULT 1,
          enabled          INTEGER NOT NULL DEFAULT 1,
          full_until       TEXT,
          last_used_at     TEXT,
          last_error       TEXT,
          created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_buffer_accounts_site ON buffer_accounts (site_id, position);
      `);

      // Every site that already had a token keeps posting through it, as
      // account one. Nothing to re-enter, and a site with one account behaves
      // exactly as it did before rotation existed.
      db.exec(`
        INSERT INTO buffer_accounts (site_id, label, token_encrypted, position)
        SELECT id, 'Account 1', buffer_token_encrypted, 1
          FROM sites
         WHERE buffer_token_encrypted <> ''
           AND id NOT IN (SELECT site_id FROM buffer_accounts);
      `);
    },
  },

  {
    id: '008-block-hopeless-pairs',
    description: 'Quarantine a keyword-site pair that keeps failing the same way',
    up(db) {
      addColumn(db, 'keyword_sites', 'blocked_at', 'TEXT');
      addColumn(db, 'keyword_sites', 'blocked_reason', 'TEXT');
    },
  },
  {
    id: '009-facebook-reels',
    description: 'Facebook pages, their keyword-group routes, and reels',
    up(db) {
      // Pages are registered by hand rather than synced from Graph. The token
      // can see every page in the business, and only some of them are ones
      // this platform should ever post to.
      db.exec(`
        CREATE TABLE IF NOT EXISTS fb_pages (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          page_id       TEXT    NOT NULL UNIQUE,
          name          TEXT    NOT NULL DEFAULT '',
          -- Per page, not per site: one page can be told to hold its reels
          -- for review while the others post on their own.
          auto_publish  INTEGER NOT NULL DEFAULT 1 CHECK (auto_publish IN (0, 1)),
          enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          last_used_at  TEXT,
          last_error    TEXT,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);

      // Which page a reel goes to, decided by (site, niche).
      //
      // One site carries several nano-niches and each niche has its own page,
      // so the site alone cannot decide and the niche alone cannot either. A
      // NULL site_id is the fallback for a niche whose page is shared across
      // every site, which is why site_id is nullable rather than required.
      db.exec(`
        CREATE TABLE IF NOT EXISTS fb_page_routes (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id      INTEGER REFERENCES sites (id) ON DELETE CASCADE,
          seed_keyword TEXT    NOT NULL,
          fb_page_id   INTEGER NOT NULL REFERENCES fb_pages (id) ON DELETE CASCADE,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);

      // COALESCE, because NULL never equals NULL in a UNIQUE index and two
      // identical fallback routes would both be accepted without it.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fb_route_unique
          ON fb_page_routes (COALESCE(site_id, 0), seed_keyword COLLATE NOCASE);
      `);

      // A reel is an artefact of a run, not a second kind of run: it borrows a
      // published article's images and caption and has its own short life
      // afterwards. Keeping it out of `runs` keeps every derived counter on the
      // dashboard meaning what it already means.
      db.exec(`
        CREATE TABLE IF NOT EXISTS reels (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id         INTEGER REFERENCES runs (id)     ON DELETE SET NULL,
          site_id        INTEGER REFERENCES sites (id)    ON DELETE SET NULL,
          keyword_id     INTEGER REFERENCES keywords (id) ON DELETE SET NULL,
          fb_page_id     INTEGER REFERENCES fb_pages (id) ON DELETE SET NULL,
          status         TEXT    NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','generating','ready',
                                           'publishing','published','failed')),
          prompt         TEXT    NOT NULL DEFAULT '',
          caption        TEXT    NOT NULL DEFAULT '',
          -- The images chosen as references, in order, as JSON.
          reference_json TEXT    NOT NULL DEFAULT '[]',
          job_id         TEXT,
          video_url      TEXT,
          fb_video_id    TEXT,
          error          TEXT,
          created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_reels_status ON reels (status, created_at DESC);
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_reels_run ON reels (run_id);`);
    },
  },
  {
    id: '010-fb-tokens',
    description: 'Tokens as rows, one niche per page; routes retired',
    up(db) {
      // A token per app. The single fb_system_token setting could reach only
      // the pages one app was allowed to see, so a second app meant a second
      // deployment. Encrypted with the platform key exactly as a secret
      // setting is, which is what lets the stored setting move over as-is.
      db.exec(`
        CREATE TABLE IF NOT EXISTS fb_tokens (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          name            TEXT    NOT NULL DEFAULT '',
          token_encrypted TEXT    NOT NULL,
          last_synced_at  TEXT,
          last_error      TEXT,
          created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
      addColumn(db, 'fb_pages', 'token_id', 'INTEGER REFERENCES fb_tokens (id) ON DELETE CASCADE');
      // The niche a page carries. One page, one niche; the site the article
      // was published on does not come into it. NULL is a page the platform
      // can see but does not post to.
      addColumn(db, 'fb_pages', 'niche', 'TEXT');
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fb_pages_niche
          ON fb_pages (niche COLLATE NOCASE) WHERE niche IS NOT NULL AND enabled = 1;
      `);

      if (hasTable(db, 'settings')) {
        const stored = db
          .prepare("SELECT value FROM settings WHERE key = 'fb_system_token' AND value != ''")
          .get() as { value: string } | undefined;
        const tokens = db.prepare('SELECT COUNT(*) AS n FROM fb_tokens').get() as { n: number };
        if (stored && tokens.n === 0) {
          db.prepare("INSERT INTO fb_tokens (name, token_encrypted) VALUES ('Imported', ?)").run(
            stored.value,
          );
          db.prepare(
            'UPDATE fb_pages SET token_id = (SELECT MAX(id) FROM fb_tokens) WHERE token_id IS NULL',
          ).run();
          log.info('moved the Facebook system token into fb_tokens');
        }
      }

      if (!hasTable(db, 'fb_page_routes')) return;

      // A route naming a niche and exactly one page, where that page was
      // routed nothing else, becomes the page's niche. Two pages for one
      // niche, or two niches on one page, is a question for a person: left
      // blank, and said so in the log. The table itself stays -- this runner
      // never drops one -- but nothing reads it after this.
      const routes = db
        .prepare("SELECT seed_keyword, fb_page_id FROM fb_page_routes WHERE seed_keyword != ''")
        .all() as { seed_keyword: string; fb_page_id: number }[];
      const pagesByNiche = new Map<string, Set<number>>();
      const nichesByPage = new Map<number, Set<string>>();
      for (const r of routes) {
        const niche = r.seed_keyword.trim().toLowerCase();
        if (!pagesByNiche.has(niche)) pagesByNiche.set(niche, new Set());
        pagesByNiche.get(niche)!.add(r.fb_page_id);
        if (!nichesByPage.has(r.fb_page_id)) nichesByPage.set(r.fb_page_id, new Set());
        nichesByPage.get(r.fb_page_id)!.add(niche);
      }

      const assign = db.prepare('UPDATE fb_pages SET niche = ? WHERE id = ? AND niche IS NULL');
      for (const [niche, pages] of pagesByNiche) {
        if (pages.size !== 1) {
          log.warn(`niche "${niche}" was routed to ${pages.size} pages; left for you to assign`);
          continue;
        }
        const [pageId] = pages;
        if (nichesByPage.get(pageId!)!.size !== 1) {
          log.warn(`page ${pageId} was routed several niches; left for you to assign`);
          continue;
        }
        const original = routes.find((r) => r.fb_page_id === pageId)!.seed_keyword.trim();
        assign.run(original, pageId!);
      }
    },
  },
  {
    id: '011-reel-studio',
    description: 'Presenters, reel scenes, and the stage a reel is at',
    up(db) {
      // A presenter is a character and a voice that live in the Flow project
      // as two assets -- that is where both are made and kept. What the
      // platform adds is the pairing, the name the operator knows them by,
      // and how the delivery should sound, in words the clip prompt repeats
      // scene after scene so it stays the same.
      db.exec(`
        CREATE TABLE IF NOT EXISTS presenters (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          name              TEXT    NOT NULL,
          flow_character_id TEXT    NOT NULL,
          flow_voice_id     TEXT    NOT NULL DEFAULT '',
          voice_description TEXT    NOT NULL DEFAULT '',
          portrait_url      TEXT    NOT NULL DEFAULT '',
          created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
      addColumn(db, 'fb_pages', 'presenter_id', 'INTEGER REFERENCES presenters (id) ON DELETE SET NULL');

      // The stage an in-flight reel is at. status stays as it was ('generating'
      // covers every stage) because its CHECK cannot be widened without
      // rebuilding the table; the stage says which of the five it is on.
      // 'done' is the default so every reel from before this reads as past
      // all of them, which for a one-shot reel is true.
      addColumn(db, 'reels', 'stage', "TEXT NOT NULL DEFAULT 'done'");
      addColumn(db, 'reels', 'plan_json', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'reels', 'format', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'reels', 'output_path', "TEXT NOT NULL DEFAULT ''");

      // One row per scene: what to film it from, what happens, what is said,
      // and how far it got. A scene that fails is retried alone.
      db.exec(`
        CREATE TABLE IF NOT EXISTS reel_scenes (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          reel_id       INTEGER NOT NULL REFERENCES reels (id) ON DELETE CASCADE,
          position      INTEGER NOT NULL,
          seconds       INTEGER NOT NULL DEFAULT 10,
          presenter     INTEGER NOT NULL DEFAULT 0 CHECK (presenter IN (0, 1)),
          sources_json  TEXT    NOT NULL DEFAULT '[]',
          image_prompt  TEXT    NOT NULL DEFAULT '',
          motion_prompt TEXT    NOT NULL DEFAULT '',
          line          TEXT    NOT NULL DEFAULT '',
          image_job_id  TEXT,
          image_url     TEXT,
          clip_job_id   TEXT,
          clip_path     TEXT,
          status        TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'working', 'done', 'failed')),
          error         TEXT,
          UNIQUE (reel_id, position)
        );
      `);
    },
  },
  {
    id: '012-fb-pages-auto-publish',
    description: 'Facebook pages publish on their own unless told otherwise',
    up(db) {
      // 009 created pages holding for review, then upsertFbPage started
      // adding them with auto-publish on, so the pages that have been here
      // longest were the only ones still waiting to be read. The platform's
      // point is not to be asked; a page that should wait is switched off
      // under Channels -> Facebook.
      db.exec('UPDATE fb_pages SET auto_publish = 1');
    },
  },
  {
    id: '013-blog-questions',
    description: 'Blog articles answering People-Also-Ask questions, on their own schedule',
    up(db) {
      // One row per question. 'suggested' rows came from the model and wait
      // for a person to approve them; only 'queued' rows are ever written.
      db.exec(`
        CREATE TABLE IF NOT EXISTS blog_questions (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id     INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          question    TEXT    NOT NULL,
          status      TEXT    NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('suggested', 'queued', 'working', 'done', 'failed', 'skipped')),
          source      TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
          attempts    INTEGER NOT NULL DEFAULT 0,
          post_url    TEXT,
          recipe_slug TEXT,
          error       TEXT,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE (site_id, question)
        );
        CREATE INDEX IF NOT EXISTS idx_blog_questions_next ON blog_questions (site_id, status, id);
      `);

      // Each site's blog runs on its own clock, apart from its recipes.
      addColumn(db, 'sites', 'blog_enabled', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'sites', 'blog_daily_target', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(db, 'sites', 'blog_interval_minutes', 'INTEGER NOT NULL DEFAULT 480');
      addColumn(db, 'sites', 'blog_last_at', 'TEXT');
    },
  },
  {
    id: '014-buffer-accounts-per-platform',
    description: 'A Buffer account serves Pinterest, Facebook, or both',
    up(db) {
      // 'both' keeps every existing account doing what it did: one Buffer
      // account holding a Pinterest and a Facebook channel posts pins and reels.
      addColumn(db, 'buffer_accounts', 'platform', "TEXT NOT NULL DEFAULT 'both'");

      // A token typed into the old site form lived only on the site row. The
      // accounts are now managed on Channels -> Pinterest / Facebook, so bring
      // it over as an account instead of leaving it invisible.
      db.exec(`
        INSERT INTO buffer_accounts (site_id, label, token_encrypted, position, platform)
        SELECT id, 'Account 1', buffer_token_encrypted, 1, 'both'
          FROM sites
         WHERE buffer_token_encrypted <> ''
           AND id NOT IN (SELECT site_id FROM buffer_accounts);
      `);
    },
  },
  {
    id: '015-image-sharing-off',
    description: 'Every article makes its own images; drop the stored shared sets',
    up(db) {
      // Sharing copied a keyword's first images into every later run, so a run
      // made after the prompts improved still showed the old pictures.
      db.exec(`
        UPDATE keyword_sites SET share_images = 0;
        DELETE FROM keyword_images;
      `);
    },
  },
  {
    id: '016-reel-candidate-dismissed',
    description: 'An article can be taken off the "Make a reel from" list',
    up(db) {
      addColumn(db, 'runs', 'reel_dismissed', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    id: '017-pinterest-post-and-reel-switches',
    description: 'Per site: pin each article (image) and/or each reel (video) on Pinterest',
    up(db) {
      addColumn(db, 'sites', 'pin_posts', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(db, 'sites', 'pin_reels', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    id: '018-facebook-posts-and-reels',
    description: 'Per Facebook page: an image post for every article and/or the reel',
    up(db) {
      addColumn(db, 'fb_pages', 'posts', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'fb_pages', 'reels', 'INTEGER NOT NULL DEFAULT 1');
    },
  },
  {
    id: '019-pinterest-board-routing',
    description: 'Per site: a fallback Pinterest board and topic group -> board links',
    up(db) {
      addColumn(db, 'sites', 'pin_default_board', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'sites', 'pin_board_map', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '020-pinterest-board-suggestions',
    description: 'The last board plan suggested for a site, shown until dismissed',
    up(db) {
      addColumn(db, 'sites', 'pin_board_suggestions', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '021-daily-auto-research',
    description: 'Daily keyword research per site; keywords and questions it adds expire unwritten',
    up(db) {
      addColumn(db, 'sites', 'auto_research_on', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'sites', 'auto_research_niche', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'sites', 'auto_research_recipes', 'INTEGER NOT NULL DEFAULT 5');
      addColumn(db, 'sites', 'auto_research_questions', 'INTEGER NOT NULL DEFAULT 3');
      addColumn(db, 'sites', 'auto_research_ttl_hours', 'INTEGER NOT NULL DEFAULT 24');
      addColumn(db, 'sites', 'auto_research_hour', 'INTEGER NOT NULL DEFAULT 6');
      addColumn(db, 'sites', 'auto_research_last_day', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'sites', 'auto_research_history', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'sites', 'auto_research_report', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keywords', 'auto_added_at', 'TEXT');
      addColumn(db, 'blog_questions', 'auto_added_at', 'TEXT');
    },
  },
  {
    id: '022-run-google-research',
    description: "Whether a run's article was written with Google research ('ok') or without it ('none')",
    up(db) {
      addColumn(db, 'runs', 'research', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '023-pin-designs',
    description: 'Pinterest graphic designs to rotate between, and which one each run used',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pin_designs (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          body       TEXT NOT NULL,
          enabled    INTEGER NOT NULL DEFAULT 1,
          position   INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      addColumn(db, 'runs', 'pin_design_id', 'INTEGER');
    },
  },
  {
    id: '024-instagram',
    description: 'Per site: an Instagram post for every article and/or the reel, through Buffer',
    up(db) {
      addColumn(db, 'sites', 'ig_posts', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'sites', 'ig_reels', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    id: '025-reel-channels',
    description: 'Where each reel went, channel by channel, so a retry only tries the ones that failed',
    up(db) {
      addColumn(db, 'reels', 'channels_json', 'TEXT');
    },
  },
  {
    id: '026-reel-auto-retry',
    description: 'How many times a reel refused for a full Buffer queue was retried on its own',
    up(db) {
      addColumn(db, 'reels', 'auto_retries', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    id: '027-search-console',
    description: 'Search Console: each site\'s property, and the searches worth an article',
    up(db) {
      addColumn(db, 'sites', 'gsc_property', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'sites', 'gsc_on', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'sites', 'gsc_hour', 'INTEGER NOT NULL DEFAULT 7');
      addColumn(db, 'sites', 'gsc_last_day', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'sites', 'gsc_report', "TEXT NOT NULL DEFAULT ''");
      db.exec(`
        CREATE TABLE IF NOT EXISTS gsc_opportunities (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id     INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          query       TEXT    NOT NULL,
          kind        TEXT    NOT NULL CHECK (kind IN ('recipe', 'question')),
          topic       TEXT    NOT NULL DEFAULT '',
          impressions INTEGER NOT NULL DEFAULT 0,
          clicks      INTEGER NOT NULL DEFAULT 0,
          position    REAL    NOT NULL DEFAULT 0,
          page        TEXT    NOT NULL DEFAULT '',
          status      TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'added', 'dismissed')),
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE (site_id, query)
        )
      `);
    },
  },
  {
    id: '028-taxonomy-filler',
    description: 'Taxonomy: per-site switch, last scan, and what was filled or failed per term',
    up(db) {
      addColumn(db, 'sites', 'taxo_on', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'sites', 'taxo_report', "TEXT NOT NULL DEFAULT ''");
      db.exec(`
        CREATE TABLE IF NOT EXISTS taxonomy_jobs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id     INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          tbl         TEXT    NOT NULL CHECK (tbl IN ('categories', 'cuisines', 'tags')),
          term_id     INTEGER NOT NULL,
          name        TEXT    NOT NULL DEFAULT '',
          status      TEXT    NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'failed')),
          attempts    INTEGER NOT NULL DEFAULT 0,
          filled      TEXT    NOT NULL DEFAULT '',
          error       TEXT    NOT NULL DEFAULT '',
          updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE (site_id, tbl, term_id)
        )
      `);
    },
  },
  {
    id: '029-channel-profiles',
    description: 'Several accounts per network per site (Pinterest 1, 2, ...), used in turn; current settings become account 1',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_profiles (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id           INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          platform          TEXT    NOT NULL CHECK (platform IN ('pinterest', 'facebook', 'instagram')),
          position          INTEGER NOT NULL DEFAULT 1,
          label             TEXT    NOT NULL DEFAULT '',
          -- The Buffer channel to post to: the Pinterest username, the Page or
          -- Instagram name as Buffer shows it. Empty: the first one of its network.
          channel_name      TEXT    NOT NULL DEFAULT '',
          default_board     TEXT    NOT NULL DEFAULT '',
          board_map         TEXT    NOT NULL DEFAULT '',
          board_suggestions TEXT    NOT NULL DEFAULT '',
          enabled           INTEGER NOT NULL DEFAULT 1,
          last_used_at      TEXT,
          -- Whose turn it is: the account with the lowest number goes next.
          turn              INTEGER NOT NULL DEFAULT 0,
          created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_channel_profiles_site ON channel_profiles (site_id, platform, position);
      `);
      addColumn(db, 'buffer_accounts', 'profile_id', 'INTEGER');
      // Which account of each network a run went to, so a resume and its reel stay on it.
      addColumn(db, 'runs', 'profiles_json', "TEXT NOT NULL DEFAULT ''");

      type Site = { id: number; pin_username: string; pin_default_board: string; pin_board_map: string; pin_board_suggestions: string; ig_posts: number; ig_reels: number };
      type Account = { id: number; site_id: number; label: string; token_encrypted: string; position: number; enabled: number; platform: string };
      const sites = db.prepare('SELECT id, pin_username, pin_default_board, pin_board_map, pin_board_suggestions, ig_posts, ig_reels FROM sites').all() as Site[];
      const addProfile = (siteId: number, platform: string, fields: Partial<Site> = {}): number => {
        db.prepare(
          `INSERT INTO channel_profiles (site_id, platform, position, label, channel_name, default_board, board_map, board_suggestions)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
        ).run(siteId, platform, `${platform[0]!.toUpperCase()}${platform.slice(1)} 1`,
          fields.pin_username ?? '', fields.pin_default_board ?? '', fields.pin_board_map ?? '', fields.pin_board_suggestions ?? '');
        return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
      };
      const copy = (a: Account, platform: string, profileId: number) => {
        db.prepare(
          `INSERT INTO buffer_accounts (site_id, label, token_encrypted, position, enabled, platform, profile_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(a.site_id, a.label, a.token_encrypted, a.position, a.enabled, platform, profileId);
      };
      for (const site of sites) {
        const pin = addProfile(site.id, 'pinterest', site);
        const fb = addProfile(site.id, 'facebook');
        const ig = addProfile(site.id, 'instagram');
        const accounts = db.prepare('SELECT * FROM buffer_accounts WHERE site_id = ? ORDER BY position, id').all(site.id) as Account[];
        const hasOwnInstagram = accounts.some((a) => a.platform === 'instagram');
        for (const a of accounts) {
          if (a.platform === 'pinterest') db.prepare('UPDATE buffer_accounts SET profile_id = ? WHERE id = ?').run(pin, a.id);
          else if (a.platform === 'facebook') db.prepare('UPDATE buffer_accounts SET profile_id = ? WHERE id = ?').run(fb, a.id);
          else if (a.platform === 'instagram') db.prepare('UPDATE buffer_accounts SET profile_id = ? WHERE id = ?').run(ig, a.id);
          else {
            // 'both' served Pinterest and Facebook: one row for each now.
            db.prepare("UPDATE buffer_accounts SET profile_id = ?, platform = 'pinterest' WHERE id = ?").run(pin, a.id);
            copy(a, 'facebook', fb);
          }
          // Instagram used to borrow the Facebook accounts when it had none.
          if (!hasOwnInstagram && (site.ig_posts || site.ig_reels) && (a.platform === 'facebook' || a.platform === 'both')) {
            copy(a, 'instagram', ig);
          }
        }
      }
    },
  },
  {
    id: '030-social-radar',
    description: 'Radar: the social pages a site watches, and the posts worth an article',
    up(db) {
      addColumn(db, 'sites', 'radar_on', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'sites', 'radar_hour', 'INTEGER NOT NULL DEFAULT 6');
      addColumn(db, 'sites', 'radar_last_day', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'sites', 'radar_report', "TEXT NOT NULL DEFAULT ''");
      db.exec(`
        CREATE TABLE IF NOT EXISTS social_sources (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id     INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          -- Only Facebook today. A column rather than an assumption, because
          -- the next network goes here and not in a second table.
          platform    TEXT    NOT NULL DEFAULT 'facebook' CHECK (platform IN ('facebook')),
          -- The page as its address names it: the handle, not the display name.
          handle      TEXT    NOT NULL,
          label       TEXT    NOT NULL DEFAULT '',
          enabled     INTEGER NOT NULL DEFAULT 1,
          last_scan_at TEXT,
          last_error  TEXT    NOT NULL DEFAULT '',
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE (site_id, platform, handle)
        );
        CREATE INDEX IF NOT EXISTS idx_social_sources_site ON social_sources (site_id, enabled);

        CREATE TABLE IF NOT EXISTS social_posts (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id     INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          source_id   INTEGER NOT NULL REFERENCES social_sources (id) ON DELETE CASCADE,
          -- The post as the provider identifies it, so the same post seen
          -- again updates its numbers instead of arriving twice.
          post_id     TEXT    NOT NULL,
          url         TEXT    NOT NULL DEFAULT '',
          text        TEXT    NOT NULL DEFAULT '',
          posted_at   TEXT    NOT NULL DEFAULT '',
          likes       INTEGER NOT NULL DEFAULT 0,
          comments    INTEGER NOT NULL DEFAULT 0,
          shares      INTEGER NOT NULL DEFAULT 0,
          -- likes + comments + shares, weighted; what the list is sorted by.
          score       INTEGER NOT NULL DEFAULT 0,
          -- What the model made of it: the article title and its topic group.
          kind        TEXT    NOT NULL DEFAULT 'recipe' CHECK (kind IN ('recipe', 'question')),
          title       TEXT    NOT NULL DEFAULT '',
          topic       TEXT    NOT NULL DEFAULT '',
          status      TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'added', 'dismissed')),
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE (site_id, post_id)
        );
        CREATE INDEX IF NOT EXISTS idx_social_posts_site ON social_posts (site_id, status, score DESC);
      `);
    },
  },
  {
    id: '031-photo-styles',
    description: 'Photo shoots to rotate between for the article images, and which one each run used',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS photo_styles (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          body       TEXT NOT NULL,
          enabled    INTEGER NOT NULL DEFAULT 1,
          position   INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      addColumn(db, 'runs', 'photo_style_id', 'INTEGER');
    },
  },
  {
    id: '032-article-structures',
    description: 'Article shapes to rotate between (the intro, and the sections after the recipe), and which one each run used',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS article_structures (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          -- What part 1 is told about the introduction.
          intro      TEXT NOT NULL DEFAULT '',
          -- What part 3 is told about the sections after the recipe card and
          -- the questions. Part 2 is the recipe card itself: structured data
          -- for Google, and no business varying.
          sections   TEXT NOT NULL DEFAULT '',
          enabled    INTEGER NOT NULL DEFAULT 1,
          position   INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      addColumn(db, 'runs', 'article_structure_id', 'INTEGER');
    },
  },
  {
    id: '033-blog-structures',
    description: 'Blog article shapes to rotate between, and which one each question was written in',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS blog_structures (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          -- What the blog prompt is told about the length, the headings and
          -- how the article ends. Everything else about a blog article -- the
          -- direct answer up top, the internal links, the recipe-card line --
          -- stays in the prompt, out of reach of a shape.
          body       TEXT NOT NULL DEFAULT '',
          enabled    INTEGER NOT NULL DEFAULT 1,
          position   INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      addColumn(db, 'blog_questions', 'blog_structure_id', 'INTEGER');
    },
  },
  {
    id: '034-youtube-channel',
    description: 'YouTube as a fourth network: Shorts from each reel, with its own accounts per site',
    up(db) {
      // SQLite cannot alter a CHECK constraint, so the table is rebuilt with
      // 'youtube' allowed. The ids are carried over exactly: buffer_accounts
      // .profile_id points at them, and while that column is not a declared
      // foreign key, renumbering here would quietly orphan every saved token.
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_profiles_034 (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id           INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          platform          TEXT    NOT NULL CHECK (platform IN ('pinterest', 'facebook', 'instagram', 'youtube')),
          position          INTEGER NOT NULL DEFAULT 1,
          label             TEXT    NOT NULL DEFAULT '',
          channel_name      TEXT    NOT NULL DEFAULT '',
          default_board     TEXT    NOT NULL DEFAULT '',
          board_map         TEXT    NOT NULL DEFAULT '',
          board_suggestions TEXT    NOT NULL DEFAULT '',
          enabled           INTEGER NOT NULL DEFAULT 1,
          last_used_at      TEXT,
          turn              INTEGER NOT NULL DEFAULT 0,
          created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO channel_profiles_034
          (id, site_id, platform, position, label, channel_name, default_board, board_map,
           board_suggestions, enabled, last_used_at, turn, created_at)
          SELECT id, site_id, platform, position, label, channel_name, default_board, board_map,
                 board_suggestions, enabled, last_used_at, turn, created_at
            FROM channel_profiles;
        DROP TABLE channel_profiles;
        ALTER TABLE channel_profiles_034 RENAME TO channel_profiles;
        CREATE INDEX IF NOT EXISTS idx_channel_profiles_site ON channel_profiles (site_id, platform, position);
      `);

      // Reels only: a Short is a video, so there is nothing here for articles
      // or pins to use.
      addColumn(db, 'sites', 'yt_reels', 'INTEGER NOT NULL DEFAULT 0');

      // Every site gets its "YouTube 1" slot, as 029 gave them the other
      // three, so the Accounts page has somewhere to put a token.
      const sites = db.prepare('SELECT id FROM sites').all() as { id: number }[];
      const exists = db.prepare("SELECT 1 FROM channel_profiles WHERE site_id = ? AND platform = 'youtube' LIMIT 1");
      const insert = db.prepare(
        "INSERT INTO channel_profiles (site_id, platform, position, label) VALUES (?, 'youtube', 1, 'Youtube 1')",
      );

      for (const site of sites) {
        if (!exists.get(site.id)) insert.run(site.id);
      }
    },
  },
  {
    id: '035-caption-structures',
    description: 'Reel caption shapes to rotate between, and which one each reel was written in',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS caption_structures (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          body       TEXT NOT NULL DEFAULT '',
          enabled    INTEGER NOT NULL DEFAULT 1,
          position   INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      addColumn(db, 'reels', 'caption_structure_id', 'INTEGER');
    },
  },
  {
    id: '036-reel-structures',
    description: 'Scene orders for one-clip reels to rotate between, and which one each reel was filmed in',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reel_structures (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          body       TEXT NOT NULL DEFAULT '',
          enabled    INTEGER NOT NULL DEFAULT 1,
          position   INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      addColumn(db, 'reels', 'reel_structure_id', 'INTEGER');
    },
  },
  {
    id: '037-post-to-all',
    description: 'Networks a site posts to on every account instead of one in turn, and what each run already posted where',
    up(db) {
      // A comma list of networks; empty is the rotation every site had.
      addColumn(db, 'sites', 'post_to_all', "TEXT NOT NULL DEFAULT ''");
      // {network: {profileId: postId}} — so a retry posts only where it failed.
      addColumn(db, 'runs', 'fanout_json', 'TEXT');
    },
  },
  {
    id: '038-first-bite-no-steam',
    description: 'The "First bite" reel structure no longer asks for steam, where it is still the shipped text',
    up(db) {
      // Heavy steam is the clearest sign a food video was generated, and this
      // shape asked for it on every dish, muffins included. Only a body still
      // word for word the shipped one is changed: one somebody edited is theirs.
      const shipped = "SCENE 1 — 0–3 sec | THE FIRST BITE\nOpen on a fork or spoon lifting the first portion of the finished dish toward the camera — the inside, the steam or the set texture, in close-up.\nVoiceover: the opening line — what that first bite is like.\nSubtitle: that sentence in full.\n\nSCENE 2 — 3–8 sec | HOW IT GOT HERE\nCut back in time: the raw ingredients, then the one step that matters most in this recipe, then the dish going in or setting.\nVoiceover: one complete sentence on the step that makes it work.\nSubtitle: that sentence, shortened into a sentence of its own.";
      db.prepare('UPDATE reel_structures SET body = ? WHERE body = ?')
        .run(shipped.replace('the steam or the set texture', 'its crumb or its set texture'), shipped);
    },
  },
  {
    id: '039-fb-page-site',
    description: 'A Facebook page belongs to a site; the niche no longer decides where a post or reel goes',
    up(db) {
      addColumn(db, 'fb_pages', 'site_id', 'INTEGER REFERENCES sites (id) ON DELETE SET NULL');
      // One niche, one page: gone with the niche. Two sites could not each have
      // a page that takes every keyword, which is the whole reason for this.
      db.exec('DROP INDEX IF EXISTS idx_fb_pages_niche');
      if (!hasTable(db, 'sites')) return;

      // Only what is certain. A page whose niche is a topic that exactly one
      // site publishes goes to that site; with a single site everything goes
      // to it. A page that could belong to either of two sites is left for a
      // person to choose (Channels -> Accounts -> Facebook pages), because
      // guessing would post one site's articles to the other's page.
      const siteIds = (db.prepare('SELECT id FROM sites').all() as { id: number }[]).map((r) => r.id);
      const pages = db.prepare('SELECT id, niche FROM fb_pages WHERE site_id IS NULL').all() as { id: number; niche: string | null }[];
      const set = db.prepare('UPDATE fb_pages SET site_id = ? WHERE id = ?');
      for (const page of pages) {
        const niche = (page.niche ?? '').trim();
        if (siteIds.length === 1 && niche !== '') {
          set.run(siteIds[0]!, page.id);
          continue;
        }
        if (niche === '' || niche === '*') {
          if (niche === '*') log.warn(`Facebook page ${page.id} took every keyword; choose its site under Channels -> Accounts`);
          continue;
        }
        const owners = db
          .prepare(
            `SELECT DISTINCT ks.site_id AS id FROM keyword_sites ks JOIN keywords k ON k.id = ks.keyword_id
              WHERE k.seed_keyword = ? COLLATE NOCASE`,
          )
          .all(niche) as { id: number }[];
        if (owners.length === 1) set.run(owners[0]!.id, page.id);
        else log.warn(`Facebook page ${page.id} (niche "${niche}") could belong to ${owners.length} sites; choose one under Channels -> Accounts`);
      }
    },
  },
  {
    id: '040-fb-page-per-account',
    description: 'A Facebook page is set from its own Buffer account card; each account keeps at most one page',
    up(db) {
      addColumn(db, 'fb_pages', 'profile_id', 'INTEGER REFERENCES channel_profiles (id) ON DELETE SET NULL');
      if (!hasTable(db, 'channel_profiles')) return;

      // Pair each site's Facebook pages with its Facebook accounts, oldest to
      // oldest, so a page already filled in (name, posts, reels) keeps
      // working without anyone retyping it. A page past the account count
      // gets an account made for it, so a working page is never silently
      // dropped; an account past the page count is simply left to be filled
      // in from its own card, the same as a brand-new one.
      const siteIds = (
        db.prepare('SELECT DISTINCT site_id AS id FROM fb_pages WHERE site_id IS NOT NULL').all() as { id: number }[]
      ).map((r) => r.id);
      const link = db.prepare('UPDATE fb_pages SET profile_id = ? WHERE id = ?');
      // Only when the account has no channel name of its own yet: that field
      // already picks the Buffer channel, and a value someone typed there on
      // purpose must not be overwritten by the page's display name.
      const fillName = db.prepare("UPDATE channel_profiles SET channel_name = ? WHERE id = ? AND channel_name = ''");
      const addFacebookProfile = db.prepare(
        "INSERT INTO channel_profiles (site_id, platform, position, label) VALUES (?, 'facebook', ?, ?)",
      );
      const lastId = db.prepare('SELECT last_insert_rowid() AS id');

      for (const siteId of siteIds) {
        const pages = db
          .prepare('SELECT id, name FROM fb_pages WHERE site_id = ? AND profile_id IS NULL ORDER BY id')
          .all(siteId) as { id: number; name: string }[];
        const profiles = db
          .prepare("SELECT id FROM channel_profiles WHERE site_id = ? AND platform = 'facebook' ORDER BY position, id")
          .all(siteId) as { id: number }[];

        for (let i = 0; i < pages.length; i++) {
          const page = pages[i]!;
          let profileId: number;
          if (i < profiles.length) {
            profileId = profiles[i]!.id;
          } else {
            const position = profiles.length + 1;
            addFacebookProfile.run(siteId, position, `Facebook ${position}`);
            profileId = (lastId.get() as { id: number }).id;
            profiles.push({ id: profileId });
          }
          link.run(profileId, page.id);
          fillName.run(page.name, profileId);
        }
      }
    },
  },
  {
    id: '041-fb-page-collage',
    description: 'Per Facebook page: a step-by-step photo collage for every article',
    up(db) {
      addColumn(db, 'fb_pages', 'collage', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    id: '042-tiktok',
    description: 'TikTok as a fifth network: the reel\'s video, with its own accounts per site',
    up(db) {
      // Same rebuild 034 did for YouTube: SQLite cannot alter a CHECK
      // constraint, so the table is rebuilt with 'tiktok' allowed. Ids carry
      // over exactly, for the same reason -- buffer_accounts.profile_id
      // points at them.
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_profiles_042 (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id           INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          platform          TEXT    NOT NULL CHECK (platform IN ('pinterest', 'facebook', 'instagram', 'youtube', 'tiktok')),
          position          INTEGER NOT NULL DEFAULT 1,
          label             TEXT    NOT NULL DEFAULT '',
          channel_name      TEXT    NOT NULL DEFAULT '',
          default_board     TEXT    NOT NULL DEFAULT '',
          board_map         TEXT    NOT NULL DEFAULT '',
          board_suggestions TEXT    NOT NULL DEFAULT '',
          enabled           INTEGER NOT NULL DEFAULT 1,
          last_used_at      TEXT,
          turn              INTEGER NOT NULL DEFAULT 0,
          created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO channel_profiles_042
          (id, site_id, platform, position, label, channel_name, default_board, board_map,
           board_suggestions, enabled, last_used_at, turn, created_at)
          SELECT id, site_id, platform, position, label, channel_name, default_board, board_map,
                 board_suggestions, enabled, last_used_at, turn, created_at
            FROM channel_profiles;
        DROP TABLE channel_profiles;
        ALTER TABLE channel_profiles_042 RENAME TO channel_profiles;
        CREATE INDEX IF NOT EXISTS idx_channel_profiles_site ON channel_profiles (site_id, platform, position);
      `);

      // Reels only, like YouTube: a TikTok video is the reel's video, so
      // there is nothing here for articles or pins to use.
      addColumn(db, 'sites', 'tt_reels', 'INTEGER NOT NULL DEFAULT 0');

      // Every site gets its "TikTok 1" slot, as 034 gave them YouTube's.
      const sites = db.prepare('SELECT id FROM sites').all() as { id: number }[];
      const exists = db.prepare("SELECT 1 FROM channel_profiles WHERE site_id = ? AND platform = 'tiktok' LIMIT 1");
      const insert = db.prepare(
        "INSERT INTO channel_profiles (site_id, platform, position, label) VALUES (?, 'tiktok', 1, 'TikTok 1')",
      );

      for (const site of sites) {
        if (!exists.get(site.id)) insert.run(site.id);
      }
    },
  },
  {
    id: '043-fb-page-relink-profile',
    description: "Point each 'profile:<id>' fb_pages row back at its profile",
    up(db) {
      // A card's own page row (page_id = "profile:<id>") is how the Accounts
      // page and the per-account posting gate find a Facebook account's
      // Posts/Reels/Collage settings -- they look it up by profile_id. But
      // upsertFbPageForProfile's ON CONFLICT clause never set profile_id, so a
      // row first created with a null one (an earlier build, or carried through
      // the 040 rebuild) kept it null through every save: the boxes wrote to a
      // row no profile_id lookup could see, and read back empty on every
      // account. The INSERT now sets it going forward; this repairs the rows
      // already on disk by reading the id straight out of the page_id.
      db.exec(`
        UPDATE fb_pages
        SET profile_id = CAST(substr(page_id, 9) AS INTEGER)
        WHERE page_id LIKE 'profile:%'
          AND profile_id IS NULL
          AND substr(page_id, 9) GLOB '[0-9]*'
      `);
    },
  },
  {
    id: '044-extra-posts',
    description: 'More posts: new Pinterest, Facebook and Instagram posts for a recipe that is already published',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS extra_posts (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id       INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          keyword_id    INTEGER,
          -- The published article run this is another post for.
          source_run_id INTEGER NOT NULL,
          -- The run row holding this batch's checkpoints, kept apart from article runs.
          run_id        INTEGER,
          network       TEXT NOT NULL CHECK (network IN ('pinterest', 'facebook', 'instagram')),
          angle         TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed')),
          detail        TEXT NOT NULL DEFAULT '',
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_extra_posts_source ON extra_posts (source_run_id, network, created_at)');
    },
  },
  {
    id: '045-extra-posts-auto',
    description: 'More posts: mark the batches the scheduler made on its own',
    up(db) {
      db.exec('ALTER TABLE extra_posts ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    id: '046-extra-posts-link-and-shape',
    description: 'More posts: whether a site puts the recipe link in them, and which caption shape each batch used',
    up(db) {
      addColumn(db, 'sites', 'extra_link', "TEXT NOT NULL DEFAULT 'setup'");
      addColumn(db, 'extra_posts', 'shape_id', 'INTEGER');
    },
  },
  {
    id: '047-extra-hidden',
    description: 'More posts: recipes hidden from the list (and from the automatic mode)',
    up(db) {
      db.exec("CREATE TABLE IF NOT EXISTS extra_hidden (run_id INTEGER PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    },
  },
  {
    id: '048-caption-per-site',
    description: 'Caption structures: a site can have shapes and caption settings of its own',
    up(db) {
      // NULL = the default every site follows; a number = that site's own shape.
      addColumn(db, 'caption_structures', 'site_id', 'INTEGER');
      // A site that has any row here has its own caption settings ('_custom' marks it).
      db.exec(`
        CREATE TABLE IF NOT EXISTS site_caption_settings (
          site_id INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          key     TEXT NOT NULL,
          value   TEXT NOT NULL,
          PRIMARY KEY (site_id, key)
        )
      `);
    },
  },
  {
    id: '049-fb-feed-posts',
    description: 'Every Facebook feed post (article post, collage) Buffer scheduled, so the comment-keyword webhook can find it too',
    up(db) {
      // Mirrors what `reels.fb_video_id` already does for Reels: Buffer hands
      // back its own internal post id, not Facebook's, and there is nothing
      // at schedule time that can know what Facebook will assign a post that
      // has not gone out yet. `fb_post_id` starts out null and is filled in
      // once the backfill matches it to the real one -- see
      // `backfillNativeFeedPostIds` in src/reels/engine.ts.
      //
      // A row per (run, account, purpose) rather than folding this into
      // `runs.fanout_json`: the webhook has to go from a native post id
      // *back* to a run, and a JSON blob on every run gives it nothing to
      // index -- it would mean scanning every run on every comment. This
      // table exists only to make that lookup a WHERE clause, the same
      // reason `reels.fb_video_id` does.
      db.exec(`
        CREATE TABLE IF NOT EXISTS fb_feed_posts (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id         INTEGER REFERENCES runs (id) ON DELETE SET NULL,
          fb_page_id     INTEGER REFERENCES fb_pages (id) ON DELETE SET NULL,
          -- 'facebook' is the article's own image post; 'facebook-collage' is
          -- the step-by-step photo collage -- the same two purposes
          -- markFanoutPosted already distinguishes on the run.
          purpose        TEXT    NOT NULL DEFAULT 'facebook'
                         CHECK (purpose IN ('facebook', 'facebook-collage')),
          buffer_post_id TEXT    NOT NULL,
          fb_post_id     TEXT,
          created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fb_feed_posts_native
          ON fb_feed_posts (fb_post_id) WHERE fb_post_id IS NOT NULL;
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_fb_feed_posts_pending
          ON fb_feed_posts (fb_page_id) WHERE fb_post_id IS NULL;
      `);
    },
  },
  {
    id: '050-post-trigger-keyword',
    description: 'The comment keyword each reel and feed post invites, so every post can ask for its own word',
    up(db) {
      // Each post names the dish, so the word it asks readers to comment is
      // taken from the dish ("pizza"), not one word for the whole page. Null
      // on everything published before this: the webhook then falls back to
      // the global trigger word, as it always did.
      addColumn(db, 'reels', 'trigger_keyword', 'TEXT');
      addColumn(db, 'fb_feed_posts', 'trigger_keyword', 'TEXT');
    },
  },
  {
    id: '051-site-writing-style',
    description: 'Spelling and units per site (fr, us or uk); in this French edition a site is written in French by default',
    up(db) {
      // French edition: every site starts as "fr" (French spelling, metric
      // units). "us" and "uk" stay available on the site page for an English
      // site added next to the French ones.
      addColumn(db, 'sites', 'writing_style', "TEXT NOT NULL DEFAULT 'fr'");
    },
  },
  {
    id: '052-site-pages',
    description: 'Static pages (About, Contact, Privacy, Terms, Disclaimer) written for a site and sent to its /api/page, with the facts they are written from',
    up(db) {
      db.exec(`
        -- What only the owner knows. The model is told to write around anything
        -- that is not here rather than invent it.
        CREATE TABLE IF NOT EXISTS site_page_facts (
          site_id    INTEGER PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
          author     TEXT NOT NULL DEFAULT '',
          why        TEXT NOT NULL DEFAULT '',
          testing    TEXT NOT NULL DEFAULT '',
          extra      TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- One row per site and page: the latest draft, and whether it was sent.
        CREATE TABLE IF NOT EXISTS site_pages (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id      INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          slug         TEXT    NOT NULL CHECK (slug IN ('about', 'contact', 'privacy', 'terms', 'disclaimer')),
          status       TEXT    NOT NULL DEFAULT 'empty'
                               CHECK (status IN ('empty', 'working', 'draft', 'published', 'failed')),
          draft_html   TEXT    NOT NULL DEFAULT '',
          words        INTEGER NOT NULL DEFAULT 0,
          error        TEXT,
          written_at   TEXT,
          published_at TEXT,
          UNIQUE (site_id, slug)
        );
      `);
    },
  },
  {
    id: '053-about-auto-refresh',
    description: 'Optional weekly rewrite of the About page when the site has grown, with what the site looked like at the last check',
    up(db) {
      // Off by default: nothing is rewritten or sent until the owner switches it on.
      addColumn(db, 'site_page_facts', 'auto_about', 'INTEGER NOT NULL DEFAULT 0');
      // "recipes|posts|categories" when the About page was last checked; blank until the first check.
      addColumn(db, 'site_page_facts', 'about_seen', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'site_page_facts', 'about_checked_at', 'TEXT');
    },
  },
  {
    id: '054-profile-buffer-channel',
    description: "A separate name for the Buffer channel an account posts to, so the account's own name stays free for the owner",
    up(db) {
      // Blank: the account's name is also the Buffer channel's name, as before.
      addColumn(db, 'channel_profiles', 'buffer_channel', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '055-keyword-cook-input',
    description: "The cook's own recipe and notes for a keyword, so an article can be written from a real kitchen instead of from search results",
    up(db) {
      // Both blank: the keyword is written exactly as before.
      addColumn(db, 'keywords', 'cook_recipe', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keywords', 'cook_notes', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '056-keyword-cook-suggestions',
    description: 'Tips from real readers waiting for the cook to approve or reject',
    up(db) {
      // JSON list of { tip, sources }; blank means none waiting.
      addColumn(db, 'keywords', 'cook_suggestions', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '057-keyword-site-auto-added',
    description: 'Daily research expiry per site: a keyword shared with another site loses only this site',
    up(db) {
      addColumn(db, 'keyword_sites', 'auto_added_at', 'TEXT');
      if (hasTable(db, 'keyword_sites') && columns(db, 'keywords').includes('auto_added_at')) {
        db.exec(`
          UPDATE keyword_sites SET auto_added_at =
            (SELECT k.auto_added_at FROM keywords k WHERE k.id = keyword_sites.keyword_id)
          WHERE auto_added_at IS NULL;
        `);
      }
    },
  },
];

/* -- The runner ----------------------------------------------------------- */

function ensureLedger(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function appliedMigrations(db: Db): string[] {
  ensureLedger(db);
  const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[];
  return rows.map((r) => r.id);
}

/** Migrations that would run against this database, in order. */
export function pendingMigrations(db: Db): Migration[] {
  const applied = new Set(appliedMigrations(db));
  return MIGRATIONS.filter((m) => !applied.has(m.id));
}

export interface MigrationReport {
  applied: string[];
  alreadyApplied: number;
}

/**
 * Bring the database up to date.
 *
 * Each migration is its own transaction: one that throws rolls back and is not
 * recorded, so the next boot retries exactly that one rather than skipping it
 * or re-running the ones that already succeeded. The error is rethrown — a
 * process that carries on against a half-migrated schema fails later, somewhere
 * less obvious, with a message about a missing column.
 */
export function runMigrations(db: Db): MigrationReport {
  const applied = new Set(appliedMigrations(db));
  const done: string[] = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migration.id);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* rolling back a transaction that already failed */
      }
      log.error(`migration ${migration.id} failed: ${String(err)}`);
      throw err;
    }

    log.info(`applied ${migration.id} — ${migration.description}`);
    done.push(migration.id);
  }

  return { applied: done, alreadyApplied: applied.size };
}
