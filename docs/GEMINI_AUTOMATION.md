> **Ported into dailyfoodpins-generator-fr** (same as the English generator, dailyfoodpins-generator a352e64) from `walidselatnia-maker/Automation` @ `feature/gemini-chat` (`110f327`).
> The imagegen side (queue, `/v1/gemini` + `/ext/gemini` APIs, the Gemini Chat extension, packing) and the
> LLM routing (`src/integrations/gemini.ts`, `src/llm/gemini.ts`, `chat()` fallback) are the same as described below.
> Differences in this project:
> - There is no `src/newsite`. The UI is its own page, **Setup → Gemini** (`/settings/gemini`):
>   logic and routes in `src/web/gemini.ts`, view in `src/web/views/gemini.ts`, wired in `src/web/server.ts`.
>   Routes: `POST /settings/gemini/steps`, `POST /settings/gemini/ask`, `GET /settings/gemini/ask/:id`.
> - There is no Prompts-page `PROMPT_STAGES`; the steps are defined in `GEMINI_STAGES` (`src/web/gemini.ts`).
>   Every prompt in `PROMPT_MODELS` must sit in exactly one step (`test/settings-gemini.test.ts` checks it).
>   A single prompt can also be set to `gemini` on the Prompts page.
> - `geminiAccount()` always returns `''`: here each Google account has its own Chrome profile and only one
>   runs at a time, so Gemini simply uses the account the browser is on (no `?authuser`, no email check).
>   An account switch waits for a running Gemini prompt like it waits for an image job.
> - Tests: `test/gemini.test.ts`, `test/settings-gemini.test.ts`, `services/imagegen/tests/test_gemini.py`.

# Gemini Automation — Technical Report

Repository: `walidselatnia-maker/Automation`
Branch: **`feature/gemini-chat`** (3 commits ahead of `main` @ `91dc49a`; **not merged into `main`**)

| Commit | Summary |
|---|---|
| `a4fbcba` | Gemini Chat: Gemini answers prompts in the image service's Chrome |
| `c5a0080` | Keep "Try Gemini" uploads under the server's request limit |
| `110f327` | Type the whole prompt, line by line |

> If you search `main` for "gemini" you find nothing. Everything below lives on `feature/gemini-chat`.

---

## 1. What it is, in one paragraph

There is **no Gemini API key and no Google AI SDK**. Gemini is driven through its **consumer web page** (`https://gemini.google.com/app`) by a Chrome extension called **Gemini Chat**, which runs inside the **same Chrome** that the `imagegen` container already uses for Google Flow (image/video generation), signed in with the **same Google account**. The Node/TypeScript `platform` submits a prompt to the Python `imagegen` service over HTTP, the extension long-polls `imagegen` for work, types the prompt into Gemini's page, waits for the answer to finish streaming, scrapes it from the DOM into Markdown/text/code blocks/images, and posts it back. The platform polls until it has the reply. If anything goes wrong, the prompt **silently falls back** to the normal LLM (Ollama-compatible endpoints), so Gemini can never be the reason nothing publishes.

---

## 2. Architecture

```
┌──────────────────────────── platform container (Node, Fastify, :8080) ────────────────────────────┐
│                                                                                                    │
│  pipeline step ──► askPrompt() ──► chat()  [src/llm/client.ts]                                     │
│   (article, social…)  src/llm/ask.ts     │                                                         │
│                                          │ model === 'gemini' ?                                    │
│                                          ├── yes ─► geminiCompletion()  [src/llm/gemini.ts]        │
│                                          │            │ joinMessages → GeminiClient.ask()          │
│                                          │            │ [src/integrations/gemini.ts]               │
│                                          │            │   POST /v1/gemini/jobs  ─────────┐         │
│                                          │            │   GET  /v1/gemini/jobs/:id (2s) ─┤         │
│                                          │            ▼                                  │         │
│                                          │   success → content   /  error → fallback ──┐ │         │
│                                          └── no / fallback ─► Ollama endpoint pool ◄───┘ │         │
│                                                                                          │         │
│  Platform settings page → "Gemini" section [src/newsite/gemini.ts]                       │         │
│    • status badge  • tick which stages use Gemini  • "Try Gemini" test box               │         │
└──────────────────────────────────────────────────────────────────────────────────────────┼─────────┘
                                         internal Docker network, X-API-Key              │
┌──────────────────────────── imagegen container (Python FastAPI, :8100) ─────────────────▼─────────┐
│                                                                                                    │
│  /v1/gemini/*  (API-key gated)  ─► GeminiQueue (in memory)  [agent/gemini.py]                      │
│                                     • holds Chrome (chrome.hold) while job is live                 │
│                                     • sweeper every 5 s: deadlines, lease re-queue, GC             │
│  /ext/gemini/* (loopback only) ◄──────────────┐                                                    │
│      GET  /poll   (long-poll, 25 s)           │                                                    │
│      POST /beat   (every 5 s while running)   │                                                    │
│      POST /result (ok + reply | error)        │                                                    │
│                                               │ http://127.0.0.1:8100                              │
│  ┌───────────────── Chrome (supervisord, started on demand) ──────────────────────────────┐        │
│  │  Flow Kit extension (images)            Gemini Chat extension                          │        │
│  │                                          background.js (service worker)                │        │
│  │                                            pollLoop → openFresh popup window           │        │
│  │                                                 │ chrome.runtime port "gemini-chat"    │        │
│  │                                          content.js on gemini.google.com               │        │
│  │                                            checkSession → temp chat → type prompt →    │        │
│  │                                            attach files → Send → wait → extract DOM    │        │
│  └────────────────────────────────────────────────────────────────────────────────────────┘        │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. File map

### Platform (TypeScript, `src/`)

| File | Role |
|---|---|
| `src/integrations/gemini.ts` | **HTTP client** to imagegen: `GeminiClient.submit / job / status / ask` (submit-then-poll). Types `GeminiAsk`, `GeminiReply`, `GeminiJob`, `GeminiStatus`. `GeminiError` with `code`; `GeminiError.from("CODE: message")` parses page error strings. |
| `src/llm/gemini.ts` | **Gemini as an LLM model.** `GEMINI_MODEL = 'gemini'`. `configureGemini()` (startup injection of Settings), `geminiClient()`, `joinMessages()`, `jsonFrom()`, `unusableReply()`, `geminiCompletion()`, `recordGeminiOutcome()`. |
| `src/llm/client.ts` | `chat()` intercepts `model === 'gemini'` **before** the endpoint pool; on any throw, retries with `request.fallbackModel`. New field `ChatRequest.fallbackModel`. |
| `src/llm/ask.ts` | `askPrompt()` now sets `fallbackModel: spec?.model` (the prompt's **shipped default** model from `PROMPT_MODELS`). |
| `src/newsite/gemini.ts` | **UI + routes**: `GEMINI_STAGES`, `geminiStages()`, `setGeminiStages()`, `geminiAccount()`, `geminiProblem()` (code → human text), `geminiState()` (badge), `geminiSection()` (HTML + inline "Try Gemini" script), `registerGeminiRoutes()`. |
| `src/newsite/platform-routes.ts` | Registers Gemini routes; adds `gemini` section to the Platform settings view (reuses the image-service health check). |
| `src/newsite/platform-view.ts` | Renders `v.gemini` after the Google accounts section. |
| `src/web/server.ts` | Calls `configureGemini({ settings, account: geminiAccount })` at boot. Fastify `bodyLimit` is 20 MB (relevant to uploads). |

### imagegen (Python, `services/imagegen/`)

| File | Role |
|---|---|
| `agent/gemini.py` | **`GeminiQueue`** (in-memory), `GeminiJob` dataclass, constants, `run_sweeper()`. |
| `agent/api/gemini.py` | Two routers: `platform` (`/v1/gemini`, `require_api_key`) and `extension` (`/ext/gemini`, `loopback_only`). Pydantic models `AskRequest`, `GeminiFile`, `Beat`, `Result`. |
| `agent/main.py` | Includes both routers; starts `gemini.run_sweeper()` in lifespan; cancels on shutdown. |
| `agent/api/ext_host.py` | Serves `/ext/gemini.crx` (alongside `/ext/flowkit.crx`) so Chrome can force-install it. |
| `agent/chrome.py` | (pre-existing) Chrome lifecycle: `hold()`/`release()` user counter, `ensure_running()`, idle stop after `CHROME_IDLE_STOP` (180 s). Gemini reuses it. |
| `gemini-extension/manifest.json` | MV3, perms `alarms, storage, tabs`; hosts `gemini.google.com/*`, `127.0.0.1:8100/*`. |
| `gemini-extension/background.js` | Service worker: poll loop, popup window management, heartbeat, result reporting. |
| `gemini-extension/content.js` | DOM automation of the Gemini page + DOM→Markdown extraction. |
| `docker/pack-extension.sh` | Build-time: packs **both** extensions into signed CRXs, derives IDs, writes one `update.xml` and one Chrome managed policy (`ExtensionInstallForcelist`) for both. |
| `Dockerfile` | `COPY gemini-extension/ /app/gemini-extension/`. |

### Tests

- `services/imagegen/tests/test_gemini.py` — queue/HTTP behaviour, loopback guard, API key, Chrome hold/release, timeouts, GC, extension liveness.
- `test/gemini.test.ts` — client polling, failure codes, GONE handling, budget clamp, `joinMessages`, `jsonFrom`, `unusableReply`, `chat()` routing + fallback.
- `test/newsite-gemini.test.ts` — stages, toggling, account selection, badge, UI, try-routes.

Docs touched: `README.md` (setup step 7), `deploy/DEPLOY.md` (troubleshooting rows), `docs/DESIGN.md` ("Gemini rides in the image service's Chrome").

---

## 4. How a pipeline prompt is routed to Gemini

1. **Selection is per prompt via model overrides.** On Platform settings → Gemini, the user ticks *stages* (from the Prompts page `PROMPT_STAGES`, filtered to prompts present in `PROMPT_MODELS`, i.e. excluding picture templates). `setGeminiStages(titles)` calls `setModelOverride(prompt, 'gemini')` for every prompt in ticked stages; for unticked stages it clears the override **only if it currently equals `'gemini'`** (other custom overrides are preserved). Then `invalidatePromptCache()`.
2. A stage counts as "on" only if **every** one of its prompts resolves to `gemini` (`geminiStages()`).
3. Default: **everything off**, so an installation behaves exactly as before.
4. At run time `askPrompt()` builds `{ model: modelFor(name), fallbackModel: spec.model, messages, format }`.
5. `chat()` sees `model === 'gemini'` → `geminiCompletion()`. Gemini is deliberately **not** registered as an endpoint/API key in the pool, because a key with no model list serves every model and would steal other prompts (and get marked unhealthy).
6. On success → returns `{ endpoint: 'Gemini', model: 'gemini', tokensIn: 0, tokensOut: 0 }`.
7. On **any** error → log warning, swap `model` to `fallbackModel`, continue into the normal Ollama pool. If there is no fallback (or it is also `gemini`), the error is rethrown.

### Prompt shaping (`joinMessages`)
Gemini's page has one input box, so messages are flattened:
```
Instructions:
<all system messages, joined by blank lines>

Request:
<all user/assistant messages, joined by blank lines>

Answer with valid JSON only, in one ```json code block, with no other text.   ← only when format === 'json'
```
(Without system messages, the "Request:" label is omitted.)

### Reply validation
- `unusableReply(text)`: empty (<2 chars) → reject; replies **under 600 chars** matching a refusal/limit regex (`reached your daily limit`, `try again later`, `I can't help with that`, `I'm just a language model`, …) → reject with `NOT_AN_ANSWER`. Long replies that merely mention a limit are accepted.
- JSON prompts: `jsonFrom(reply)` tries, in order: ```` ```json ```` code blocks → any code block → `text` → `markdown`; for each it slices from the first `{`/`[` to the last `}`/`]` and `JSON.parse`s. Fails with `NOT_JSON`.
- Non-JSON prompts: returns `reply.markdown || reply.text`.
- Outcome stored in settings keys `gemini_last_ok_at` / `gemini_last_error` (`"<ISO> CODE: message"`, truncated to 300 chars) for the status badge.

### Call parameters used by the pipeline
`temporary: true`, `images: false`, `timeoutS = request.timeoutMs/1000` (default 300), `account = geminiAccount()`.

---

## 5. HTTP contracts

### Platform → imagegen (header `X-API-Key: <image_api_key>`, base `settings.image_base_url`)

**`POST /v1/gemini/jobs`** → `202`
```json
{
  "prompt": "string (≤200 000)",
  "files": [{ "name": "a.png", "mime": "image/png", "base64": "..." }],   // ≤10, total base64 ≤40 MB
  "account": "email or empty",
  "temporary": true,
  "images": true,
  "timeout_s": 300                                                        // 60..1800, client clamps too
}
```
Response: `{ "id": "<uuid>", "status": "queued", "result": null, "error": null }`.
Errors: `422` empty prompt and no files; `413` files too big; `401/403` bad key.
Side effect: `chrome.hold()` immediately + `asyncio.create_task(chrome.ensure_running("a Gemini prompt"))`.
The payload stored for the extension gets `timeoutMs = (timeout_s − 60) * 1000` (60 s reserved for Chrome start + page load).

**`GET /v1/gemini/jobs/{id}`** → `{ id, status: queued|running|done|failed, result: GeminiReply|null, error: "CODE: msg"|null }`; `404` if unknown (service restarted / GC'd) → client code `GONE`.

**`GET /v1/gemini/status`** → `{ extension_connected, queued, running, last_success_at, last_error, chrome: {...} }`. `extension_connected` = extension polled within 45 s.

### Extension → imagegen (loopback only: `127.0.0.1`, `::1`, `localhost`; no key)

| Route | Body | Response |
|---|---|---|
| `GET /ext/gemini/poll` | — | `200 {job:{id,payload}}` or `204` after ≤25 s |
| `POST /ext/gemini/beat` | `{id}` | `{ok: bool}` |
| `POST /ext/gemini/result` | `{id, ok, result?, error?(≤2000)}` | `{ok: bool}` (false if unknown/already finished) |

### `GeminiReply` shape (produced by `content.js`)
```ts
{
  conversation_id: string | null,     // from /app/<id> URL
  text: string,                        // markdown with syntax stripped
  markdown: string,                    // DOM → Markdown (the faithful form)
  code_blocks: { language: string; code: string }[],
  links: { url: string; text: string }[],   // deduped http(s) links in the answer body
  images: { url, alt, mime?, data_base64? }[], // ≥80px; data only when images=true
  account?: string,                    // email shown in Google bar
  temporary?: boolean                  // whether temp chat toggle was engaged
}
```

---

## 6. imagegen queue internals (`agent/gemini.py`)

Kept **separate from the image job table on purpose**: the watchdog failure breaker, the unusual-activity hold and worker pause all read the image table. A Gemini sign-in problem must not stop pictures, and a Flow hold must not stop Gemini. **In memory, not SQLite**: losing a prompt on restart is cheap because the platform falls back.

| Constant | Value | Meaning |
|---|---|---|
| `LEASE_S` | 20 | Running job with no heartbeat for 20 s → re-queued (front of queue) |
| `MAX_DELIVERIES` | 3 | After 3 hand-outs with lost lease → `TIMEOUT: the Gemini page never picked the prompt up` |
| `EXTENSION_ALIVE_S` | 45 | Liveness window for `extension_connected` |
| `POLL_WAIT_S` | 25 | Long-poll duration |
| `KEEP_FINISHED_S` | 3600 | Finished jobs kept 1 h for late polls |
| sweeper | every 5 s | `sweep()`: deadline → `TIMEOUT: Gemini did not answer in time`; lease expiry → re-queue; GC |

State machine: `queued → running → done | failed` (and `running → queued` on lease loss).
`next_job()` pops FIFO from a deque, wakes on an `asyncio.Event` (re-checks every ≤5 s).
Chrome: `hold()` on submit, `release()` in `_close()` on done/failed/timeout — so Chrome's idle stop (180 s) never kills it mid-answer, and a queued prompt alone is enough to start Chrome.
`finish()` ignores results for unknown or already-finished jobs (duplicate deliveries are harmless).

---

## 7. The Chrome extension

### Installation
Chrome 151 ignores `--load-extension`, so at **image build** `pack-extension.sh` packs `/app/extension` → `flowkit.crx` and `/app/gemini-extension` → `gemini.crx`, derives each ID (SHA-256 of DER pubkey, first 32 hex → `a..p`), writes `/app/ext-dist/update.xml` naming both (codebases `http://127.0.0.1:8100/ext/{flowkit,gemini}.crx`), and writes **one** managed policy file (`/etc/opt/chrome/policies/managed/flowkit.json`) with `ExtensionInstallForcelist` + `ExtensionSettings` for both (one file because list policies across files are not merged). Build fails if either does not pack. **Bump `manifest.json` `version` when changing the extension**, or Chrome won't treat it as an upgrade.

### `background.js` (service worker)
- `pollLoop()` — infinite loop: `GET /poll`; on network error sleep 3 s; on job: start `setInterval` beat every 5 s, `run(job)`, `report()` result (3 tries, 1 s apart), clear beat. Guarded by a `polling` flag.
- Kept alive by `chrome.alarms` every 30 s, plus `onStartup`/`onInstalled`.
- **Own popup window** (`chrome.windows.create({type:'popup', focused:false, 1280×720})`) at the Gemini URL; tab id remembered in `chrome.storage.session`. Popup (not a blank tab / normal window) because Flow Kit hijacks blank tabs and opens its tabs in the first normal window.
- `openFresh(account)` — navigates the tab to `https://gemini.google.com/app` (plus `?authuser=<email>` if an account is given) **for every prompt** so it never lands in a previous chat; waits for `status === complete` (60 s); if the URL left `gemini.google.com` → `NOT_SIGNED_IN`; waits up to 20 s for the content script's port → else `NO_PROMPT_BOX`.
- `run(job)` — posts `{cmd:'run', job}` over the port; timeout `payload.timeoutMs + 30 s`; port disconnect → `NO_PROMPT_BOX`.

### `content.js` (on gemini.google.com) — `chat(payload)`
1. **Visibility**: if `document.visibilityState !== 'visible'` → `HIDDEN` (relies on Chrome running with background throttling off).
2. **`checkSession(account)`**: wait ≤20 s for the editor or a sign-in link; sign-in link and no "Google Account: …" button → `NOT_SIGNED_IN`; email from the account button ≠ requested → `WRONG_ACCOUNT`.
3. **Temporary chat** (best effort): click the button labelled "Temporary chat" unless already pressed.
4. **`setPrompt(text)`** — clear editor (`execCommand selectAll/delete`), then type **line by line** with `execCommand('insertText')`, separating lines with a synthetic **Shift+Enter** keydown (plain Enter would send). Paste doesn't work; typing the whole thing sent only "Instructions:". Then verifies: no new response appeared mid-typing, and whitespace-squashed editor text equals the prompt → else `NO_PROMPT_BOX` (never sends a partial prompt).
5. **`attachFiles(files)`** — builds a `DataTransfer` of `File`s from base64 and dispatches a synthetic `paste` on the editor; waits ≤30 s for a new preview chip (`UPLOAD`), then ≤120 s for progress indicators to vanish and Send to enable.
6. Click the **Send** button (aria-label `/^send( message)?$/i`, waits ≤15 s for enabled).
7. Wait ≤60 s for a new `<model-response>` → else `TIMEOUT`.
8. **Completion detection**: last response has `<message-actions>` **and** no Stop button, stable for **1.5 s**; overall `timeoutMs` → `TIMEOUT`.
9. **`extract()`** — walks the response's `.markdown` DOM into Markdown (headings, p, br, hr, bold/italic, inline code, links, images, blockquote, ul/ol, tables, `code-block`), skipping buttons/icons/sources/actions/thinking overlay and `.attachment-container` (suggestion chips). `plainText()` strips syntax. Images ≥80 px: fetched with credentials, or drawn to canvas for `blob:` URLs (cross-origin images return no data).

Key DOM selectors (most likely to break when Google changes the UI):
`rich-textarea .ql-editor[contenteditable="true"]`, `div.ql-editor[role="textbox"]`, `model-response`, `message-actions`, `code-block`, `.code-block-decoration span`, `uploader-file-preview`, `input-area-v2 mat-progress-bar`, buttons by aria-label (`Send message`, `Stop response`, `Temporary chat`, `Google Account: …`).

---

## 8. Timeout budget (default 300 s)

| Layer | Budget |
|---|---|
| Platform poll deadline | `timeoutS + 30 s` (= 330 s), polls every 2 s; 5 consecutive poll errors → throw; `404` → `GONE` immediately |
| imagegen job deadline | `timeout_s` from submit (**includes queue wait**) |
| Content-script answer time | `timeout_s − 60` (= 240 s) after Send |
| Background `run()` guard | content time + 30 s |
| Page load / port / session | 60 s / 20 s / 20 s |

Note: the extension handles **one prompt at a time** — parallel pipeline steps queue up FIFO and their queue wait eats into their deadline.

---

## 9. Error codes

Format on the wire: `"CODE: human message"`; parsed by `GeminiError.from`.

| Code | Origin | Meaning | Platform behaviour / user text (`geminiProblem`) |
|---|---|---|---|
| `NOT_SIGNED_IN` | extension | No Google session / redirected to sign-in | Badge "Sign-in needed"; sign in on Browser page |
| `WRONG_ACCOUNT` | content | Signed in as a different email | Badge "Sign-in needed" |
| `NO_PROMPT_BOX` | extension | Page/editor/port missing, partial prompt, Send disabled | Fallback |
| `HIDDEN` | content | Window not visible | Fallback |
| `UPLOAD` | content | File not accepted / didn't finish | Fallback |
| `TIMEOUT` | any layer | Too slow / never picked up | "Try again in a minute"; fallback |
| `NOT_AN_ANSWER` | platform | Empty, limit or refusal text | "…The step used your AI keys instead." |
| `NOT_JSON` | platform | JSON requested, none parseable | same |
| `GONE` | platform | 404 — imagegen restarted | "Send it again" |
| `KEY` / `SERVICE` | platform | 401/403 / other HTTP error | "image service not answering properly" |
| `SETUP` | platform | `configureGemini` not called or no image URL/key | same |

For pipeline prompts **every** code results in fallback to the shipped model (if one exists).

---

## 10. UI: Platform settings → Gemini (`/new-website/platform#gemini`)

- **Badge** (`geminiState`): `Not available` (no image URL/key) · `Not answering` (image service check failed / `/v1/gemini/status` failed) · `Sign-in needed` · `Last prompt failed` · `Working` · `Not tried yet`.
- **Account line**: `geminiAccount()` → if ≥2 Google accounts are listed (Flow's account list), the **first** email; otherwise empty = browser default account.
- **Choose which steps Gemini writes** → `POST /new-website/gemini/steps` (form field `stage`, repeated; unknown titles ignored) → 303 redirect with flash message.
- **Try Gemini**: textarea + file input; client caps files at **14 MB raw** (base64 ≈ +33% under the 20 MB Fastify body limit). `POST /new-website/gemini/ask` (prompt ≤100 000 chars, ≤10 files, `images: true`, `timeoutS: 300`) → `{id}`; then the page polls `GET /new-website/gemini/ask/:id` every 2 s. Replies are rendered as text nodes only (never HTML), images only as `data:` URIs, plus "Copy as Markdown". Try results also update the badge.

---

## 11. Design decisions to respect

1. **Not an API key / endpoint** — implemented as a model override intercepted in `chat()`.
2. **Never block publishing** — every failure falls back; all steps default off.
3. **Isolation from Flow** — separate queue, separate popup window, but shared Chrome lifecycle counter.
4. **Temporary chats** — keep automation out of the account's history and personalization.
5. **Loopback-only extension API** — port 8100 listens on all interfaces for the platform; only the in-container browser may take prompts.
6. Accepted risk (from `DESIGN.md`): automated prompts from the same account/browser as Flow; mitigated by temp chats, page-paced answering, opt-in steps. The UI warns Gemini's daily limits are low — start with a light step like Social posts.

---

## 12. Known gaps / things to watch

- **Fragile selectors**: any Gemini UI change (aria-labels, `ql-editor`, `model-response`, `message-actions`) breaks it; symptoms are mostly `NO_PROMPT_BOX` / `TIMEOUT`, hidden by the fallback. Check `gemini_last_error` or the badge.
- **Fallback is to the shipped default** (`PROMPT_MODELS[...].model`), not to whatever override the user had before switching the stage to Gemini.
- **No token accounting**: Gemini completions report `tokensIn/Out = 0`.
- **Serial throughput**: one prompt at a time; queue wait counts against `timeout_s`.
- **Language label detection** for code blocks depends on `.code-block-decoration`; `jsonFrom` slicing (first `{`/`[` → last `}`/`]`) can grab trailing junk, then falls through to the next candidate.
- **Multi-account**: chosen via `?authuser=<email>`; with exactly one listed account the browser default is used.
- **In-memory queue**: imagegen restart drops queued/running prompts (`GONE` → fallback).
- **Branch not merged** into `main`.

---

## 13. How to extend / debug

- **Make another prompt use Gemini**: it only needs to be in `PROMPT_MODELS` and in a `PROMPT_STAGES` stage; ticking the stage sets the override. Or set the model override to `gemini` directly via `setModelOverride`.
- **Use Gemini outside the pipeline** (e.g. with files or wanting images): use `geminiClient(settings).ask({...})` from `src/integrations/gemini.ts`; handle `GeminiError` yourself (no automatic fallback there).
- **Change DOM automation**: edit `services/imagegen/gemini-extension/content.js`, **bump `manifest.json` version**, rebuild the imagegen image. `window.__geminiChat` exposes `{chat, setPrompt, toMarkdown, plainText}` for manual testing in the page's DevTools.
- **Inspect live state**: `GET /v1/gemini/status` on imagegen (with `X-API-Key`), imagegen logs (`gemini: prompt xxxxxxxx queued/answered/failed`), platform logs (`Gemini could not answer, using <model> instead: …`).
- **Tests**: `npx vitest run test/gemini.test.ts test/newsite-gemini.test.ts`; in `services/imagegen`: `pytest tests/test_gemini.py tests/test_ext_host.py`.
