# Design notes

Why this system is shaped the way it is. Written for whoever — human or AI —
picks this up later with no memory of the conversation that produced it.

---

## Context

This replaces three n8n workflows:

| Workflow | Fate |
|---|---|
| Master Orchestrator | Replaced by `src/core/selector.ts` + `src/scheduler/` |
| Article generator | Replaced by `src/pipeline/` |
| Daily Reset | **Deleted.** No counter exists to reset. |

The Article generator worked. The Master Orchestrator did not, and the reasons
are worth recording because they drove most of the decisions here.

## The bugs that shaped the design

These were found by reading the exported workflows and a captured execution,
and confirmed against production sheet data. Each has a regression test.

### The infinite loop

A connection ran from the final node back to `Master Config`, with no exit
condition and no record of what had already been tried. `Get data` was
configured with `returnFirstMatch: true`, `executeOnce: true`, and a lookup for
`Row = Go`, so it returned the same keyword on every pass. Together those made
an infinite loop certain.

**Response:** `selectTask` is a pure function performing bounded iteration with
no back edge. Termination is structural. When a keyword has no eligible site,
`continue` moves to the next one — which is exactly the rule sections 11 and 12
of the original specification asked for.

### The second infinite loop

Image polling tested only `status === "COMPLETED"`. Any other value — including
`"FAILED"` — took the false branch, waited 15 seconds, and polled again. A
failed image job hung the execution permanently.

**Response:** `ImageClient.waitForCompletion` has a maximum attempt count and
treats terminal failure statuses as failures.

### Corrupted timestamps that disabled rate limiting

`Update Queue Success` mapped `last_publish` to `"{{ $json.now_iso }}"` —
missing the leading `=`, so n8n wrote the template text literally. Six
production rows contained that string. The filter then did:

```js
if (isNaN(last.getTime())) return true;   // "interval satisfied"
```

An unreadable timestamp meant the minimum-interval check passed
unconditionally. The rule had been silently off.

**Response:** an unparseable timestamp is a rejection with a stated reason, not
a free pass. See `evaluateSite`.

### String arithmetic on counters

`$('Read Master Queue').first().json.today_count + 1` — Sheets returns strings,
so `"3" + 1` produced `"31"`. The same expression also used `.first()`, which
is the first row of the sheet rather than the selected site.

**Response:** counters are `COUNT(*)` queries returning integers. There is no
stored counter to corrupt, and no row to address wrongly.

### Duplicate columns holding contradictory state

The SPY sheet had `bitespoon.com` and `treasurebarrel.com` as **two columns
each**. Reading a row into an object collapses duplicate keys — last wins — so
a write could land on the invisible column while reads saw the other. A keyword
marked `Done` in one and `Go` in the other looked permanently eligible, feeding
the loop above.

**Response:** `keyword_sites` with `PRIMARY KEY (keyword_id, site_id)`. The
state is unrepresentable.

### Smaller ones

- `Update Queue Fail` addressed rows via `.first()` — wrote errors to the wrong row.
- `error_count` mapped from `$json.new_error_count`, a field nothing ever set.
- Error branch read `$json.error` on an object, yielding `[object Object]`.
- `Code in JavaScript5` set `maxRetries = 5`; `Switch6` branched at `> 3`.
- `Code in JavaScript8` merged parts positionally from a merge node.
- Google indexing POSTed to `https://www.googleapis.com/auth/indexing` — the
  OAuth *scope*, not an endpoint. It had never worked. Feature dropped.

---

## Decisions

### One process, one job at a time

20 sites × a few posts a day ≈ 60 jobs/day, one every ~24 minutes. Concurrency
buys nothing at that volume and costs every race condition. A single row in
`scheduler_lock` is the entire concurrency story.

### Derived state over stored state

Any value that can be computed is computed. This removed the Daily Reset
workflow entirely and closed a class of bugs rather than fixing instances.

The cost is a slightly more expensive query per tick. At this scale that is
free, and it stays free to about 10,000 runs.

### `node:sqlite` over `better-sqlite3`

`better-sqlite3` needs a C++ toolchain. Since each teammate installs on their
own VPS and none of them are developers, a compilation step is a support ticket
waiting to happen. Node 24's built-in SQLite removes the native dependency.

### Everything in the UI, one line in `.env`

`.env` holds `ENCRYPTION_KEY` and nothing else. Credentials live encrypted in
the database behind the Settings page. "SSH in and edit a file" is not a
workable instruction for this audience.

### Endpoint pool over pinned credentials

The original pinned a specific Ollama credential into each node — nine accounts
across thirteen nodes. That distributed load but provided no failover: if the
endpoint wired into `Part 1` went down, that stage failed every time while the
other eight sat idle.

The pool inverts it: callers name a model, the pool picks. Adding a tenth box
is a row in a table.

### Prompts as data

Extracted verbatim into `prompts/*.txt`. Article quality is unchanged by
construction — if output changes after this rewrite, it is a bug, not a
redesign. Prompts are mounted read-only into the container so they can be
tuned without a rebuild.

`part-N.fallback` variants are preserved deliberately. They are *not* copies:
`part-2` and `part-3` fall back to materially shorter prompts. That is a
degradation strategy, distinct from endpoint failover, and both are kept.

### Server-rendered HTML, no framework

No build step, no hydration, no client state. The maintenance audience is an AI
with no prior context; template literals returning strings are the most legible
option available.

---

## What was deliberately not built

- **Authentication.** Single user, private network. Bind to localhost.
- **Multi-tenancy.** Each person runs their own instance on their own VPS.
- **Parallel publishing.** See the volume arithmetic above.
- **Google indexing.** The original call never worked; nothing is lost.
- **Content library / analytics.** Scoped out as "room to grow". The schema
  does not preclude them.

---

## Where to start reading

1. `src/core/selector.ts` — the decision logic, ~180 lines, pure.
2. `test/selector.test.ts` — the rules as executable examples.
3. `src/db/schema.sql` — the data model, with reasoning in comments.
4. `src/pipeline/index.ts` — the twelve stages in order.

If you change the selection rules, change `test/selector.test.ts` first. The
regression tests encode real production failures; deleting one to make a change
pass is how the original system's bugs came back.
