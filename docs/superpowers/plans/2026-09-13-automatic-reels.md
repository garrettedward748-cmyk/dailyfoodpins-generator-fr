# Automatic Facebook Reels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A published article for niche X becomes a reel on the page assigned to X, unattended; pages come from tokens, one page per niche.

**Architecture:** A new `fb_tokens` table holds one or more tokens (encrypted). Pages are synced from each token via Graph `/me/accounts` and carry a `niche` column. A new pipeline step `create-reel` runs after `notify`, looks up the page for the run's `seed_keyword`, writes the caption, creates the reel and submits the video; the existing reel engine polls and publishes using the page's own token. The `(site, niche)` routing table is retired.

**Tech Stack:** TypeScript, Fastify, better-sqlite3 (via `src/db`), vitest. Branch `FB-reels`. Repo `C:\Users\Administrator\Desktop\Vibe coding\Automation`.

## Global Constraints

- Everything works on redeploy alone: no env vars, no manual SQL, no hand steps.
- Migrations never drop tables (`src/db/migrations.ts` policy). `fb_page_routes` stays as an unused table; only its code and UI go.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Tests: `npx vitest run <file>`; typecheck: `npx tsc --noEmit`.
- The link goes in the first comment, never the caption (already enforced).

---

### Task 1: Migration 010 — tokens table, page niche, route conversion

**Files:**
- Modify: `src/db/migrations.ts` (append to `MIGRATIONS`)
- Modify: `src/db/schema.sql`
- Test: `test/fb-tokens-migration.test.ts`

**Produces:** tables `fb_tokens(id, name, token_encrypted, last_synced_at, last_error, created_at)`; columns `fb_pages.token_id INTEGER`, `fb_pages.niche TEXT`; unique index on enabled pages' niche (NOCASE).

- [ ] **Step 1: Failing test** — a legacy db (settings/sites/keywords tables + migrations < 010) with `fb_system_token` in settings and routes in `fb_page_routes`. Assert: token row "Imported" carries the encrypted blob verbatim and existing pages get `token_id = 1`; a niche routed to exactly one page (that page routed only that niche) becomes `fb_pages.niche`; a niche routed to two pages stays NULL on both; the every-niche route (`''`) assigns nothing; running 010's `up` twice does not throw.
- [ ] **Step 2: Run** — FAIL `no such table: fb_tokens`.
- [ ] **Step 3: Implement** — append migration `010-fb-tokens`: CREATE TABLE fb_tokens; `addColumn(fb_pages, token_id, 'INTEGER REFERENCES fb_tokens (id) ON DELETE CASCADE')`; `addColumn(fb_pages, niche, 'TEXT')`; `CREATE UNIQUE INDEX IF NOT EXISTS idx_fb_pages_niche ON fb_pages (niche COLLATE NOCASE) WHERE niche IS NOT NULL AND enabled = 1`. If `settings` has `fb_system_token` non-empty and `fb_tokens` is empty: insert `('Imported', value)` and `UPDATE fb_pages SET token_id = last_insert_rowid() WHERE token_id IS NULL`. If `fb_page_routes` exists: group routes with `seed_keyword != ''` by lowercase niche → set of page ids and by page → set of niches; for each niche with exactly one page whose page has exactly one niche, `UPDATE fb_pages SET niche = ? WHERE id = ? AND niche IS NULL` with the original casing; log a warning for each ambiguous one. Add `fb_tokens` CREATE TABLE to `schema.sql` beside the reels tables.
- [ ] **Step 4: Run** `test/fb-tokens-migration.test.ts test/column-migration.test.ts` — PASS.
- [ ] **Step 5: Commit** "Migration 010: Facebook tokens as rows, one niche per page".

---

### Task 2: Repos — tokens, page niche, lookup; retire routes

**Files:**
- Modify: `src/db/repos.ts` (the fb pages / routes block, ~1900–2110)
- Delete: `test/fb-routing.test.ts`
- Test: `test/fb-niche.test.ts`

**Produces:**
```ts
interface FbTokenRow { id; name; token_encrypted; last_synced_at; last_error; created_at }
interface FbTokenView extends FbTokenRow { page_count: number }
interface FbPageRow { id; page_id; name; token_id: number|null; niche: string|null; auto_publish; enabled; last_used_at; last_error; created_at }
listFbTokens(): FbTokenView[]
insertFbToken(name, token, key: Buffer): number          // encrypt(); name defaults to "Token N"; throws on empty token
fbTokenSecret(id, key): string                           // '' when missing/unreadable
deleteFbToken(id): void                                  // deletes its pages explicitly too (ALTER-added FK is not enforced)
markFbTokenSynced(id, error: string|null): void
upsertFbPage({ pageId, name, tokenId }): number          // insert or rename+re-token; never touches niche/auto/enabled
syncFbPages(tokenId, pages: {id,name}[]): { added, renamed, dropped }  // pages under this token not listed → enabled=0, last_error='No longer under this token'
setFbPageOptions(id, { niche: string|null, autoPublish, enabled }): void  // blank→NULL; throws "“X” is already on <name>. One niche goes to one page." when another enabled page holds it (NOCASE)
pageForNiche(seed): FbPageRow|undefined                  // enabled=1 AND niche = ? COLLATE NOCASE
fbPageToken(pageRowId, key): string
```
Keep `keywordGroups`, `listFbPages`, `getFbPage`, `deleteFbPage`, `markFbPageUsed`, `markFbPageFailed`. Remove `FbRouteRow`, `FbRouteView`, `listFbRoutes`, `upsertFbRoute`, `deleteFbRoute`, `EVERY_NICHE`, `ResolvedFbPage`, `resolveFbPage`.

- [ ] **Step 1: Failing test** covering: token stored encrypted and read back; sync adds/renames/disables (and leaves niche/auto_publish untouched on the renamed page); deleting a token deletes its pages; `fbPageToken` returns the page's own token when two tokens exist; `pageForNiche` NOCASE, undefined for unknown, undefined for a disabled page; duplicate niche refused naming the holder; blank niche stored NULL.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** per the interface block. **Step 4:** delete `test/fb-routing.test.ts`; run `test/fb-niche.test.ts` — PASS (tsc breaks elsewhere until Tasks 4–6).
- [ ] **Step 5: Commit** "Repos: Facebook tokens, one niche per page; routes retired".

---

### Task 3: Token sync

**Files:** Create `src/reels/tokens.ts`; Test `test/fb-token-sync.test.ts`.

**Produces:**
```ts
type SyncResult = { ok: true; added; renamed; dropped; total } | { ok: false; error: string }
syncToken(tokenId, key, makeClient = (t) => new FacebookClient({ systemUserToken: t })): Promise<SyncResult>
```
Reads the secret (`''` → error "The token could not be read. Remove it and add it again."), calls `listPages()`, `syncFbPages`, `markFbTokenSynced(id, null)`; on throw `markFbTokenSynced(id, message)` and returns `{ok:false}`. Never throws.

- [ ] **Step 1: Failing test**: the client is made with the decrypted token and pages land; a throwing client leaves the token with `last_error` and returns its message.
- [ ] **Step 2: Run** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5: Commit** "Sync Facebook pages from a token".

---

### Task 4: Engine publishes with the page's token

**Files:** Modify `src/reels/engine.ts`, `src/scheduler/index.ts` (the `defaultDeps` call), `src/web/server.ts` (every `defaultDeps(settings)`), `test/reel-state.test.ts`.

**Changes:**
- `ReelDeps.facebook` → `facebookFor(pageRowId: number): Pick<FacebookClient, 'publishReel' | 'commentOnReel'>`.
- `defaultDeps(settings, key: Buffer)`; `facebookFor: (id) => new FacebookClient({ systemUserToken: fbPageToken(id, key) })`.
- `startGeneration(reel, settings, images: Pick<ImageClient, 'submitVideo'>)` — takes the image client directly (the pipeline step calls it without the rest of the deps). Update its callers to pass `deps.images` / `defaultDeps(...).images`.
- `publishReel`: `const facebook = deps.facebookFor(page.id)`; use it for both calls.
- Header comment: pages from different apps publish with their own token.

- [ ] **Step 1:** Update the harness: a module-level `fakeFacebook = { publishReel: vi.fn(...), commentOnReel: vi.fn(...) }`, `facebookFor: vi.fn(() => fakeFacebook)`, reset in `beforeEach`; `seed()` makes a token with `insertFbToken`, a page with `upsertFbPage({ pageId:'999', name, tokenId })`, then `setFbPageOptions(pageId, { niche: 'slow cooker', autoPublish, enabled: true })`. Add test "publishes with the token the page was found under": `expect(deps.facebookFor).toHaveBeenCalledWith(pageId)`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `test/reel-state.test.ts` PASS. **Step 5: Commit** "Reels publish with the token their page came from".

---

### Task 5: Pipeline step `create-reel`

**Files:** Create `src/reels/compose.ts`, `src/pipeline/steps/reel.ts`; Modify `src/pipeline/index.ts`, `src/web/server.ts` (remove `buildReelPrompt`, `withoutLinks`; `buildReelCaption` imports `withoutLinks`); Test `test/auto-reel.test.ts`.

**Produces:**
- `compose.ts`: `buildReelPrompt({ title, spy_title, seed_keyword })`, `withoutLinks(caption)`, `referenceUrls(host, images: ArticleImages): string[]` (feature, topShot, textureMacro, beforeAfter).
- `reel.ts`: `createReelStep: Step<{ seo; posted; images: ArticleImages; title: string }, { reelId: number|null; skipped?: string; error?: string }>`, name `'create-reel'`, title `'Make the Facebook reel'`.

Behaviour: `fb_enabled` off → `{reelId:null, skipped:'Facebook reels are off'}`; no `pageForNiche(ctx.keyword.seed_keyword)` → `{reelId:null, skipped:'no page has the niche "X"'}`; caption via `ctx.prompt('reel-caption', { seo:{title}, spy:{group, description, annotation} })` through `withoutLinks`, title on failure or empty; `createReel({... fbPageId: page.id, prompt: buildReelPrompt(...), caption, references })`; `startGeneration(reel, ctx.settings, ctx.images)`; on throw `updateReel(id, {status:'failed', error})` and return `{reelId, error}`. Never throws.

Wiring in `src/pipeline/index.ts`: add to `PIPELINE_STEPS` after `notify`; after the `notify` runStep: `await runStep(ctx, createReelStep, { seo, posted, images, title });`.

- [ ] **Step 1: Failing test** — copy `buildWorld`/`LLM_REPLIES`/context scaffolding from `test/pipeline.test.ts`; add `'reel-caption'` reply `'Hook line!\n\nA cosy stew. https://never.example'` and its `MARKER-reel-caption` detection (seed the prompt fixture the same way the others are); stub `/v1/generate-video` → `{job_id:'video-1'}` or 503 when `failVideoSubmit`. Tests: reel made (status generating, job_id, fb_page_id, caption without the link, 4 references, step ok); no page → skipped, run published, no reel; fb_enabled off → no reel; submit 503 → reel failed with error, run published; caption reply empty → caption is title; running the pipeline twice on one run → one reel.
- [ ] **Step 2:** FAIL. **Step 3–5:** implement compose, step, wiring. **Step 6:** `test/auto-reel.test.ts test/pipeline.test.ts` PASS. **Step 7: Commit** "Make the reel as the last step of a published run".

---

### Task 6: Settings → Facebook page and its routes

**Files:** Modify `src/settings.ts`, `src/web/views/pages.ts` (FacebookSettingsData/facebookSettingsPage, reel card copy, composer page-lookup copy, links that said "Pages & routes"), `src/web/server.ts` (facebook routes, `/reels` `configured`, composer lookup); Delete `test/fb-page-import.test.ts`; Test `test/fb-settings.test.ts`.

**Produces:**
```ts
interface FacebookSettingsData { enabled: boolean; tokens: FbTokenView[]; pages: FbPageRow[]; groups: string[] }
```
Routes: `GET /settings/facebook`; `POST /settings/facebook/tokens` (`name`,`token`) → `insertFbToken` then `syncToken`, flash "<name>: N page(s) — a new, b renamed, c no longer there." / warn when 0 / error with Graph's message (also Telegram when `telegram_enabled`); `POST /settings/facebook/tokens/:id/refresh`; `POST /settings/facebook/tokens/:id/delete`; `POST /settings/facebook/pages/:id` (`niche`, `autoPublish`='on', `enabled`='on') — a niche no keyword has → error "No keyword has the niche “X”."; duplicate → the repo's message. Removed: `/settings/facebook/verify`, `/settings/facebook/pages/import`, `POST /settings/facebook/pages`, `/settings/facebook/pages/:id/delete`, `/settings/facebook/routes*`. `fb_system_token` removed from `SETTING_SPECS`; `fb_enabled` help: "When on, every published article whose niche has a page becomes a reel on that page."

View, top to bottom: warn banner if reels off; **Tokens** card (table name/pages/last checked/error + Refresh/Remove; add form name+token); **Pages** card (table: page+id, niche `<select>` of `groups` + "not used", auto-publish checkbox, enabled checkbox, last used/error, Save — one `<form>` per row via the `form=` attribute). Composer shows "Goes to <page>" or "No page has the niche X — assign one in Facebook settings". Reel card: "No page for this niche — assign one".

- [ ] **Step 1: Failing test** (login scaffolding from `fb-page-import.test.ts`): adding a token lists its pages and the flash says "2 page"; a 400 from Graph keeps the token with `last_error` and the flash carries the message; assigning a niche saves and the same niche on a second page is refused "already on One"; an unknown niche is refused "No keyword"; GET renders with fetch stubbed to throw, contains "Tokens" and "Pages", not "route".
- [ ] **Step 2:** FAIL. **Step 3–5:** implement settings, view, routes. **Step 6:** delete old test; `npx tsc --noEmit` clean; `npx vitest run` all green.
- [ ] **Step 7: Commit** "Facebook settings: tokens bring pages, each page takes one niche".

---

### Task 7: Copy, spec note, verification, push

- [ ] Reels page subtitle: "Every published article whose niche has a page becomes a reel here. Make one by hand from any article below." Grep `route` in `src/web` and `src/reels` for leftovers.
- [ ] Spec: "`fb_page_routes` — dropped" → "left in place, unused (migrations never drop tables); its code and UI are removed."
- [ ] `npx tsc --noEmit && npx vitest run` — clean. Commit "Reels: copy and spec note". `git push origin FB-reels`.
