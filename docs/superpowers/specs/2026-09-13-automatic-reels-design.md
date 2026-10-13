# Automatic Facebook reels — design

Branch: `FB-reels`. Date: 2026-09-13.

## Goal

An article published for niche *X* becomes a reel on the Facebook page assigned to *X*, with no person in the loop. Pages are found from tokens, not typed. One page carries one niche; the site the article was published on does not matter.

## What changes

### Data

**`fb_tokens`** (new)

| column | notes |
|---|---|
| id | |
| name | what the person calls it ("App 2") |
| token | encrypted with the platform key, as secret settings are |
| last_synced_at, last_error | from the last `/me/accounts` call |
| created_at | |

**`fb_pages`** (changed)

- add `token_id` → `fb_tokens.id` ON DELETE CASCADE
- add `niche TEXT` (a keyword `seed_keyword`, case-insensitive), NULL = not used. Unique among enabled pages, case-insensitive.
- `auto_publish` default becomes 1
- keep `enabled`, `last_used_at`, `last_error`
- pages are inserted only by a token sync; the "add page" form is removed

**`fb_page_routes`** — left in place, unused (migrations never drop tables); its code and UI are removed. **`fb_system_token`** setting — removed from `SETTING_SPECS`.

**Migration `010-fb-tokens`**
1. create `fb_tokens`; add columns to `fb_pages`.
2. if a stored `fb_system_token` exists, insert it as token "Imported" and attach every existing page to it (page rows stay; a sync later fills `name` where empty).
3. for each route with `seed_keyword != ''`: set that page's `niche` if the page has none yet and no other page already has that niche. Ambiguous cases are left NULL and logged.
4. leave `fb_page_routes` where it is; nothing reads it after this.

`reels` unchanged.

### Facebook client

`FacebookClient` is constructed per token (it already takes one token and mints page tokens per publish). New helper `clientForPage(pageId)` looks up the page's token. `listPages()` (exists) is used by the sync.

### Token sync

`syncToken(tokenId)`: call `/me/accounts` with the token; upsert every page (page_id, name, token_id); pages under this token that Graph no longer returns are set `enabled = 0` with `last_error = 'No longer under this token'`; record `last_synced_at` / `last_error`. Runs when a token is added and on **Refresh**. A failing token is saved anyway with its error shown, so the person can see what Graph said.

### Pipeline step `createReel`

Runs after `notify`, inside the same run, checkpointed like every other step. Input: seo, posted, images, run title.

1. `pageForNiche(ctx.keyword.seed_keyword)`; none, or `fb_enabled` off → return `{ skipped: 'no page for niche "X"' }` and log it. Not a failure.
2. Caption via `ctx.prompt('reel-caption', …)` with links stripped; on error use the title.
3. `createReel({ runId, siteId, keywordId, fbPageId, prompt: template, caption, references: the four article image urls })`.
4. `startGeneration(reel)`. If submit throws, the reel row is set `failed` with the error and the step still returns `{ reelId, error }` — the article is out, the run must not read as failed. The reel page's Retry covers it.

The step is the one place that decides "this run gets a reel". A resume of a run that already passed it does not make a second one.

### Reel engine

Unchanged in shape. `publishReel` uses the page's own token via `clientForPage`. `defaultDeps` no longer takes a token from settings.

### Web

**Settings → Facebook** (one page):
1. *Publish reels to Facebook* switch.
2. **Tokens** — table: name, pages, last synced, error; buttons Refresh, Remove. Form: name + token → Add. Adding syncs immediately and reports "Found N pages" or the Graph error.
3. **Pages** — table, one form per row: name (read only, with page id), **Niche** select (keyword groups + "not used"), Auto-publish checkbox, Enabled checkbox, last used / last error, Save. Choosing a niche already on another enabled page is refused with the other page's name.

Routes section and add-page form removed. Links elsewhere that pointed at "Pages & routes" now say "Facebook".

**Reels page**: list by status with Publish / Retry / Discard (exists). The composer stays reachable from a run's page as "Make a reel by hand".

**Run page**: shows the `createReel` step like any other, with the reel link or the skip reason.

### Telegram

Existing reel published / failed messages stay. Add one when a token sync fails.

## Not changing

Video prompt template, caption prompt, the four-reference rule, the link-as-first-comment behaviour, the imagegen service.

## Tests (vitest)

- migration 010: token import, route → niche conversion incl. the ambiguous case, routes table gone.
- `syncToken`: upserts, disables pages that vanished, records the error on a 400.
- `pageForNiche`: case-insensitive, ignores disabled, ignores NULL.
- step: page found → reel created & generating; no page → skipped, run published; submit throws → reel failed, run published; resume does not create a second reel.
- engine: publish uses the token attached to the page, not another one.
- settings page: refuses a duplicate niche; renders without waiting on Graph.
