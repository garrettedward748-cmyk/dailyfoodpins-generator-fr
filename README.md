# Article Platform

> **دليل المنصة بالعربية (تثبيت، إعداد، استعمال يومي):** [PLATFORM-GUIDE.md](PLATFORM-GUIDE.md)

> **Adding a new recipe site?** The full step-by-step guide (Cloudflare, Dokploy,
> site admin, Buffer and this platform) is in the site repository:
> [dailyfoodpins/NEW-SITE.md](https://github.com/garrettedward748-cmyk/dailyfoodpins/blob/main/NEW-SITE.md).
> One installation of this platform serves every site — add each one under Channels → Sites.

Self-hosted article generation and publishing for a set of recipe websites.
Replaces three n8n workflows — Master Orchestrator, Article generator, and
Daily Reset — with one application, and folds in the image generator that used
to be a second system.

Each person runs their own copy on their own server with their own sites.
Access is one shared password — no user accounts, no roles, no shared state
between installations.

---

## Install

Point any Docker platform (Coolify, Dokploy, Portainer, CapRover) at this
repository. Attach your domain to the `platform` service, container port 8080 —
the proxy reaches it over the Docker network, so nothing is published to the
host.

To run it on your own machine instead:

```bash
docker compose -f docker-compose.local.yml up -d --build
```

Two containers come up:

| | |
|---|---|
| `platform` | the pipeline, dashboard and scheduler. The only one with a domain. |
| `imagegen` | Chrome, the Google Flow extension, and an image job queue. No published port, no domain — the platform reaches it over an internal Docker network. |

No environment variables required. On first boot the platform generates its own
encryption key and admin password, and the image service generates the API key
the two authenticate with into a volume they both mount.

**The admin password is printed in the platform's logs** — search for
`ADMIN PASSWORD`. Set `AUTH_PASSWORD` to choose your own.

**The admin password is printed in the container logs** — search for
`ADMIN PASSWORD`. Set `AUTH_PASSWORD` to choose your own.

> Two volumes matter.
>
> `platform-data` holds the database, encryption key and admin password.
> `imagegen-data` holds the **signed-in Google session**. Losing that one means
> signing in to Google again by hand; losing the other means re-entering every
> credential. Back up both.

See [deploy/DEPLOY.md](deploy/DEPLOY.md) for the full guide.

## First-time setup

1. **Settings** — LLM base URL, timezone, and under Images the **Flow project
   ID**, which must be a real project id from the Google Flow UI. The image
   service URL and API key are already filled in.
2. **Settings → LLM API keys** — add each key one at a time. They share the base
   URL; keys exist to spread rate limits, not to pick models.
3. **Sites** — each site carries its **own** Site API token and Buffer token, a
   daily target, and a minimum gap expressed in minutes, hours or days.
4. **Keywords → Download template** — a CSV with a column per site, then import it.
5. **Browser** — sign in to Google once. This is a live Chrome session inside
   the dashboard; the session survives redeploys as long as `imagegen-data`
   does. The dashboard warns you here whenever it needs doing again.
6. **Settings → General** — enable automation, once **Run once now** succeeds.

## Migrating from Google Sheets

Export both sheets as CSV (File → Download → CSV), then:

```bash
docker compose run --rm platform node dist/scripts/import-sheets.js --keys KEYS.csv --spy "SPY DATA.csv"
```

Sites import first so per-domain columns can be matched to real sites.

Credentials are deliberately **not** imported. In the old sheet the API token,
Buffer token, and image URL were duplicated across every row; they belong in
Settings once.

The importer warns about duplicate domain columns. The old SPY sheet had
`bitespoon.com` and `treasurebarrel.com` twice, which let one keyword hold two
contradictory statuses. The database forbids that, but check those keywords
after importing to confirm the surviving value is the one you meant.

---

## How it works

```
Scheduler (every N minutes)
   │
   ├─ automation off, or a run already in progress ─→ stop
   │
   ├─ selectTask(sites, keywords, links, now)          ← a pure function
   │     Filter 1  site is active, under its daily target, past its interval
   │     Filter 2  keyword is 'go' AND linked 'go' to an eligible site
   │     → one task, or nothing, plus a reason for every decision
   │
   └─ pipeline (16 checkpointed steps — one per article image, so a
      failure at the third image resumes at the third image)
         fetch-categories → validate-spy → generate-recipe
         → generate-image-prompts → generate-image-{feature,top-shot,texture-macro,before-after}
         → generate-images → generate-article
         → post-article → generate-pin-image → generate-pin-description
         → resolve-buffer-target → publish-to-buffer → notify
```

### Why it cannot loop

The n8n orchestrator had an edge from its last node back to its first, with no
exit condition and no memory of what it had already tried. Combined with a
keyword lookup that always returned the same first row, that guaranteed an
infinite loop.

`selectTask` is a bounded iteration over a finite list with no back edge. When
a keyword has no eligible site, the loop moves to the next keyword — that is
what `continue` does. Termination is structural, not enforced by a counter.

The image polling loop is bounded too: a maximum attempt count, and a reported
`FAILED` status ends the wait instead of being retried forever.

### Why counters cannot drift

`today_count`, `last_publish`, and `error_count` are not columns. They are
queries over the `runs` table:

```sql
SELECT COUNT(*) FROM runs
WHERE site_id = ? AND status = 'published' AND date(published_at) = date('now')
```

This removes a whole class of bug: string arithmetic (`"3" + 1 = "31"`), lost
updates between concurrent runs, and counters disagreeing with reality. It also
removes the need for a nightly reset job — there is no counter to reset.

### Resuming a failed run

Every step's output is stored in `run_steps`. Re-running skips completed steps
and reuses their output, so a failure at step 11 costs one retry rather than
thirteen LLM calls and five image generations. Use **Resume from failed step**
on any failed run.

### LLM failover

The old workflow pinned each generation node to a specific Ollama credential.
That spread load but gave no resilience: if the endpoint wired into "Part 1"
went down, that stage failed every time while the others sat idle.

Here, a request names a model and the pool picks the least recently used
healthy endpoint serving it. On `429` the endpoint cools down and the request
is retried elsewhere; after three consecutive failures an endpoint is marked
unhealthy and skipped until a background check restores it. A run fails only
when every endpoint for that model is exhausted — and the error names each one
tried.

Every step records which endpoint served it, so **Settings → LLM endpoints**
shows exactly which key is throttled.

Which *model* runs which operation is separate, and follows the original
workflow: `gpt-oss:120b` for spy validation, pin descriptions, board selection
and JSON repair; `gpt-oss:20b` for the recipe; `gemma4:31b` for image prompts
and the three article parts. Any key can serve any model — keys spread rate
limits, the model table decides quality.

---

## Development

```bash
npm install
npm run dev        # tsx watch
npm test           # vitest
npm run typecheck
npm run build
```

### Layout

| Path | Contains |
|---|---|
| `src/core/selector.ts` | The pure selection function. Start here. |
| `src/db/schema.sql` | Schema, with the reasoning in comments |
| `src/pipeline/steps/` | One file per pipeline stage |
| `src/llm/pool.ts` | Endpoint pool and health tracking |
| `src/web/views/` | Server-rendered HTML, no build step |
| `src/web/browser-proxy.ts` | Serves the live Chrome session behind the login |
| `prompts/` | LLM prompts as plain text |
| `services/imagegen/` | The image service: Chrome, the Flow extension, a job queue (Python) |

### Prompts

Extracted verbatim from the n8n workflow, so article quality is unchanged.
Placeholders are `{{dotted.path}}` and nothing else is interpreted.

`part-1`, `part-2`, and `part-3` each have a `.fallback` variant using a
shorter prompt. The primary is tried first; the fallback runs only if the
primary fails or returns unusable JSON. This preserves the degradation
strategy the original encoded as duplicate nodes.

Prompts are baked into the image for deployment. `docker-compose.local.yml`
mounts them read-write so they can be edited without a rebuild.

### The image service

`services/imagegen` is a separate Python service with its own tests:

```bash
cd services/imagegen
python -m venv .venv && .venv/bin/pip install -r requirements.txt pytest pytest-asyncio
PYTHONPATH=. .venv/bin/python -m pytest
```

`tests/test_request_shape.py` is the one that matters. It pins the exact
payload sent to Google — key order, header set, model name, the batch wrapper —
against what Flow's own UI sends. It runs during the Docker build too, because
a drifted payload does not fail loudly; it quietly degrades the account's
reCAPTCHA score.

### Tests

```
test/selector.test.ts     the selection rules, including regressions for
                          every production bug found in the old system
test/integration.test.ts  real database: derived counters, the matrix
                          constraint, checkpoints
test/pipeline.test.ts     the full pipeline against a mocked world
test/pool.test.ts         endpoint failover, rate limits, health
test/auth.test.ts         every route is closed without a session
test/prompts.test.ts      every prompt placeholder is supplied by its step
test/units.test.ts        crypto, CSV, LLM JSON parsing, templating
test/shared-images.test.ts  reusing one image set across a keyword's sites
test/browser-proxy.test.ts  the browser view refuses an unsigned session
```

The regression tests encode bugs that actually occurred: `last_publish`
containing the literal text `{{ $json.now_iso }}` (which silently disabled
rate limiting), `"3" + 1 = "31"`, and the keyword that could never be
satisfied but was retried forever.

---

## Operations

| Task | Where |
|---|---|
| Why did nothing publish? | **Decisions** — every site and keyword with its reason |
| Why did a run fail? | **Runs → open the run** — per-step status, timing, input, output |
| Is an API key throttled? | **Settings → LLM endpoints** — health and last success |
| Technical errors | **/events** |
| Machine-readable status | `GET /healthz` |

### Backup

Two volumes, and they are not equally replaceable.

`platform-data` holds the database, the encryption key and the admin password.
Losing it means re-entering every credential.

`imagegen-data` holds the **signed-in Google session**. Losing it means signing
in to Google again by hand through the Browser page — slower, and it needs a
person.

Your Docker platform likely has volume backups built in; otherwise:

```bash
docker run --rm -v platform-data:/data -v "$PWD:/backup" alpine tar czf /backup/platform-$(date +%F).tar.gz -C /data .
```

```bash
docker run --rm -v imagegen-data:/data -v "$PWD:/backup" alpine tar czf /backup/imagegen-$(date +%F).tar.gz -C /data .
```

### Security notes

- The UI is password-protected; sessions are HMAC-signed `HttpOnly` cookies.
- Credentials are encrypted at rest (AES-256-GCM).
- Only `/healthz` and `/static/*` are public. `/healthz` never returns secrets.
- Let your platform terminate TLS.
- Each site carries its own API and Buffer tokens, so rotating one affects
  only that site.
- The image service publishes no ports and has no domain, which is what makes
  it unreachable: Docker routes inbound traffic to published ports only. It
  does have outbound internet, because Chrome has to reach Google. Do not give
  it a domain.
