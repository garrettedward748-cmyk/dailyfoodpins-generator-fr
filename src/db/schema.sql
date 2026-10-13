-- Article Platform schema
--
-- Two principles drive this design, both learned from the n8n/Sheets system
-- it replaces:
--
--  1. Derived facts are never stored. today_count, last_publish, error_count
--     are all computed from `runs`. A stored counter can drift from reality,
--     be incremented as a string ("3" + 1 = "31"), or be lost to a concurrent
--     write. A query cannot.
--
--  2. Invalid states are made unrepresentable. The old SPY sheet had a column
--     per domain, which allowed duplicate columns for the same site holding
--     contradictory values. Here the matrix is rows with a UNIQUE constraint,
--     so that state cannot be written at all.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Sites (replaces the KEYS sheet)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sites (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  domain         TEXT    NOT NULL UNIQUE,
  status         TEXT    NOT NULL DEFAULT 'paused'
                         CHECK (status IN ('active', 'paused')),
  pin_username   TEXT    NOT NULL DEFAULT '',
  project_id     TEXT    NOT NULL DEFAULT '',

  -- Credentials are per site: every domain has its own publishing token and
  -- its own Buffer account. Encrypted at rest with ENCRYPTION_KEY.
  api_token_encrypted    TEXT NOT NULL DEFAULT '',
  buffer_token_encrypted TEXT NOT NULL DEFAULT '',

  -- Why this site is paused, and when it comes back on its own.
  --
  -- "Paused" with no note is a state nobody remembers the reason for a week
  -- later, and a pause meant to last a day lasts a month because turning it
  -- back on is a thing someone has to remember. Both are fixed by writing the
  -- reason down and giving the pause an end.
  paused_reason  TEXT    NOT NULL DEFAULT '',
  paused_until   TEXT,

  -- 0 holds every article for a human to read before it is published. The
  -- pipeline stops after the article is generated and waits.
  auto_publish   INTEGER NOT NULL DEFAULT 1 CHECK (auto_publish IN (0, 1)),

  daily_target   INTEGER NOT NULL DEFAULT 0 CHECK (daily_target >= 0),

  -- Minimum gap between posts, in minutes. Stored as minutes rather than
  -- hours so any cadence is expressible: 20 minutes, 90 minutes, 3 days.
  interval_minutes INTEGER NOT NULL DEFAULT 480 CHECK (interval_minutes >= 0),

  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Keywords (replaces the SPY DATA sheet's fixed columns)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS keywords (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  seed_keyword     TEXT    NOT NULL,
  spy_title        TEXT    NOT NULL DEFAULT '',
  spy_description  TEXT    NOT NULL DEFAULT '',
  spy_image_url    TEXT    NOT NULL DEFAULT '',
  spy_article_url  TEXT    NOT NULL DEFAULT '',
  spy_pin_image    TEXT    NOT NULL DEFAULT '',
  annotation       TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT 'go'
                           CHECK (status IN ('go', 'done', 'no')),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_keywords_status ON keywords (status);

-- ---------------------------------------------------------------------------
-- Keyword x Site matrix (replaces the column-per-domain grid)
--
-- The UNIQUE constraint is the whole point: the old sheet had bitespoon.com
-- as two separate columns that could disagree with each other, which made a
-- keyword look permanently eligible and drove an infinite loop. Here that
-- state is rejected by the database.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS keyword_sites (
  keyword_id   INTEGER NOT NULL REFERENCES keywords (id) ON DELETE CASCADE,
  site_id      INTEGER NOT NULL REFERENCES sites (id)    ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'no'
                       CHECK (status IN ('go', 'done', 'no')),
  -- On by default: reusing one image set across a keyword's sites is the
  -- behaviour that should need no thought. Generating fresh is the exception.
  share_images INTEGER NOT NULL DEFAULT 1 CHECK (share_images IN (0, 1)),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Set by the scheduler when a pair has failed the same way often enough that
  -- offering it again only spends the site's slot on a known failure. Kept
  -- separate from `status` on purpose: 'no' is a person's decision, and a
  -- system that writes into it makes the two indistinguishable.
  blocked_at     TEXT,
  blocked_reason TEXT,
  PRIMARY KEY (keyword_id, site_id)
);
CREATE INDEX IF NOT EXISTS idx_ks_site_status ON keyword_sites (site_id, status);

-- ---------------------------------------------------------------------------
-- Article images shared between the sites that publish one keyword.
--
-- The site API returns a permanent path, so `https://<domain><path>` is a
-- stable public URL. Storing the URL means there is no image cache to manage,
-- expire, or back up: the first site to publish becomes the source, and every
-- later site downloads from it and uploads its own copy.
--
-- The Pinterest graphic is deliberately absent. It is the asset that has to be
-- unique per site, so it is generated every time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS keyword_images (
  keyword_id        INTEGER PRIMARY KEY REFERENCES keywords (id) ON DELETE CASCADE,
  feature_url       TEXT    NOT NULL,
  top_shot_url      TEXT    NOT NULL,
  texture_macro_url TEXT    NOT NULL,
  before_after_url  TEXT    NOT NULL,
  source_site_id    INTEGER REFERENCES sites (id) ON DELETE SET NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Runs: one publishing attempt. The source of truth for every derived counter.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id    INTEGER REFERENCES keywords (id) ON DELETE SET NULL,
  site_id       INTEGER REFERENCES sites (id)    ON DELETE SET NULL,
  status        TEXT    NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'published', 'failed', 'cancelled')),
  started_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  published_at  TEXT,
  post_id       TEXT,
  post_url      TEXT,
  error         TEXT,
  failed_step   TEXT,

  -- 'live' publishes. 'dry' runs the whole pipeline and stops before posting,
  -- so a prompt change can be read before it reaches a real site.
  mode          TEXT    NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'dry')),

  -- Why this run stopped short of publishing, when it did.
  --
  --   ''          not held
  --   'awaiting'  the site requires approval; a person has to release it
  --   'dry'       a dry run, which was never going to publish
  --
  -- A held run is `cancelled`: not published, not failed, not occupying the
  -- scheduler lock. Approving one resumes it, and resume already reuses every
  -- completed step — so approval costs one HTTP post, not a whole pipeline.
  hold          TEXT    NOT NULL DEFAULT '' CHECK (hold IN ('', 'awaiting', 'dry')),

  -- Automatic retries already spent on this run.
  attempts      INTEGER NOT NULL DEFAULT 0,
  retry_after   TEXT,

  -- The generated title, kept so the next run on this site can be checked
  -- against it without re-reading every stored step output.
  title         TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_runs_site_pub ON runs (site_id, published_at);
CREATE INDEX IF NOT EXISTS idx_runs_status   ON runs (status);
CREATE INDEX IF NOT EXISTS idx_runs_started  ON runs (started_at DESC);

-- The indexes over `hold` and `retry_after` are NOT here. They are partial
-- indexes on columns that migration 003 adds, and this file runs against an
-- existing database before any migration does -- so putting them here made the
-- new code fail to boot against the deployed database with "no such column:
-- hold". They live in migration 004 instead. See src/db/migrations.ts.
--
-- The rule this cost us: nothing in this file may reference a column that a
-- migration adds. CREATE TABLE IF NOT EXISTS silently does nothing to a table
-- that already exists, but an index or a constraint outside it does not get
-- that courtesy.

-- ---------------------------------------------------------------------------
-- Run steps: checkpoints AND the debugging surface.
--
-- A completed row here means the step is skipped on resume and its stored
-- output is reused, so a failure at step 12 does not repay 13 LLM calls.
-- The same rows drive the run detail page in the UI.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  step        TEXT    NOT NULL,
  status      TEXT    NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'skipped')),
  attempt     INTEGER NOT NULL DEFAULT 1,
  started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER,
  endpoint    TEXT,             -- which Ollama endpoint served this step
  model       TEXT,
  input_json  TEXT,
  output_json TEXT,
  error       TEXT,

  -- What the step cost. Tokens come back from Ollama on every completion and
  -- were previously thrown away, which left "which prompt is expensive?"
  -- unanswerable. Images are counted because they are the slow, rate-limited
  -- resource, not because they are billed here.
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  images      INTEGER NOT NULL DEFAULT 0,

  UNIQUE (run_id, step)
);
CREATE INDEX IF NOT EXISTS idx_steps_run ON run_steps (run_id);

-- ---------------------------------------------------------------------------
-- Decisions: every accept / reject / skip with its reason.
-- Implements sections 16 and 17 of the specification.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id      TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  subject_type  TEXT    NOT NULL CHECK (subject_type IN ('site', 'keyword', 'pair', 'cycle')),
  subject_id    INTEGER,
  subject_label TEXT    NOT NULL DEFAULT '',
  decision      TEXT    NOT NULL CHECK (decision IN ('selected', 'eligible', 'rejected', 'skipped', 'none')),
  reason        TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_decisions_cycle   ON decisions (cycle_id);
CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions (created_at DESC);

-- ---------------------------------------------------------------------------
-- Settings: everything that used to live in .env or be hardcoded in nodes.
-- Values flagged `secret` are encrypted at rest with ENCRYPTION_KEY.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  is_secret  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- LLM endpoint pool. Replaces nine hand-pinned Ollama credentials.
-- `models` is a JSON array of model names this endpoint can serve.
-- ---------------------------------------------------------------------------
-- One row per API KEY, not per server. All keys share the base URL held in
-- settings (`llm_base_url`), because the provider is one cloud endpoint; the
-- keys exist only to spread its rate limit. base_url stays per-row so a
-- self-hosted instance can be mixed in later, but is blank in normal use.
CREATE TABLE IF NOT EXISTS llm_endpoints (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL UNIQUE,
  base_url          TEXT    NOT NULL DEFAULT '',
  api_key_encrypted TEXT    NOT NULL DEFAULT '',
  models            TEXT    NOT NULL DEFAULT '[]',
  enabled           INTEGER NOT NULL DEFAULT 1,
  -- health, maintained by the pool at runtime
  healthy           INTEGER NOT NULL DEFAULT 1,
  consecutive_fails INTEGER NOT NULL DEFAULT 0,
  cooldown_until    TEXT,
  last_used_at      TEXT,
  last_success_at   TEXT,
  last_error        TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Scheduler lock: one row, one job at a time. This single row is the entire
-- concurrency control story, and why overlapping-execution races cannot occur.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduler_lock (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  run_id      INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  locked_at   TEXT,
  heartbeat_at TEXT
);
INSERT OR IGNORE INTO scheduler_lock (id, run_id, locked_at) VALUES (1, NULL, NULL);

-- ---------------------------------------------------------------------------
-- Application event log (technical errors, scheduler activity)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  level      TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  source     TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at DESC);

-- ---------------------------------------------------------------------------
-- Prompt overrides.
--
-- The prompt files ship inside the image, which makes them read-only in any
-- practical sense: a container filesystem is discarded on redeploy, so an edit
-- made there survives until the next deploy and then silently reverts.
--
-- An edit lives here instead. The file remains the default and the fallback,
-- so deleting a row restores the shipped prompt exactly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prompt_overrides (
  name       TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Prompt history.
--
-- prompt_overrides holds the current edit and the file underneath is the
-- shipped default, which covers "undo everything" but not "what did I have
-- last Tuesday?". Every save appends here first, so an edit that made articles
-- worse can be found and restored rather than reconstructed from memory.
--
-- Bounded by PROMPT_VERSION_LIMIT in repos.ts: prompts are large and the
-- twentieth-newest version of a prompt has never once been wanted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prompt_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prompt_versions ON prompt_versions (name, id DESC);

-- ---------------------------------------------------------------------------
-- Which model runs which prompt.
--
-- PROMPT_MODELS in prompts.ts is the shipped default, taken from the original
-- workflow. A row here overrides one entry of it. Separate from `settings`
-- because the set of keys is the set of prompts, which the settings page has
-- no business enumerating.
--
-- Unrelated to API keys: any key can serve any model. Keys spread a rate
-- limit; this decides quality.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_overrides (
  prompt     TEXT PRIMARY KEY,
  model      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Notification de-duplication.
--
-- A scheduler that ticks every fifteen minutes will happily send the same
-- "image service is down" message ninety-six times a day, and a channel that
-- cries wolf gets muted — which is worse than no channel at all. One row per
-- kind of notice holds the last state announced, so a message goes out when
-- the situation *changes*, and recovery is announced too.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notice_state (
  kind       TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Buffer accounts for one site, tried in order.
--
-- A site's Buffer queue fills at ten posts a day and then refuses everything
-- until tomorrow. Rather than failing the run there, the pipeline moves to the
-- site's next account and carries on — see src/integrations/buffer-pool.ts.
--
-- Position 1 is the site's original single token, migrated in. The token stays
-- encrypted with the same key as every other credential.
CREATE TABLE IF NOT EXISTS buffer_accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id          INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  label            TEXT    NOT NULL DEFAULT '',
  token_encrypted  TEXT    NOT NULL DEFAULT '',
  position         INTEGER NOT NULL DEFAULT 1,
  enabled          INTEGER NOT NULL DEFAULT 1,
  -- Set when Buffer refuses a post. Cleared by the next success, and ignored
  -- once it has passed, so a full queue takes an account out only until the
  -- day it is full rolls over.
  full_until       TEXT,
  last_used_at     TEXT,
  last_error       TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_buffer_accounts_site ON buffer_accounts (site_id, position);

-- ---------------------------------------------------------------------------
-- Every Facebook feed post (the article's own image post, and the photo
-- collage) Buffer scheduled, so the comment-keyword webhook ("banana" under
-- a post) can find its way back to the article link the same way it already
-- does for reels. See migration 049 for why this is its own table rather
-- than a column on `runs`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fb_feed_posts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  fb_page_id     INTEGER REFERENCES fb_pages (id) ON DELETE SET NULL,
  purpose        TEXT    NOT NULL DEFAULT 'facebook'
                 CHECK (purpose IN ('facebook', 'facebook-collage')),
  buffer_post_id TEXT    NOT NULL,
  fb_post_id     TEXT,
  trigger_keyword TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fb_feed_posts_native
  ON fb_feed_posts (fb_post_id) WHERE fb_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fb_feed_posts_pending
  ON fb_feed_posts (fb_page_id) WHERE fb_post_id IS NULL;
