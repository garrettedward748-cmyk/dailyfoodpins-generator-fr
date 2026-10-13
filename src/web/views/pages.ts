import {
  emptyState,
  formatCount,
  formatDuration,
  formatTokens,
  html,
  Html,
  raw,
  runBadge,
  sparkline,
  statusBadge,
  timeAgo,
} from './layout.js';
import { BUFFER_ACCOUNT_LIMIT, hasSecret, type BufferAccount } from '../../db/repos.js';
import type {
  FbPageRow,
  FbTokenView,
  ReelCandidate,
  ReelView,
} from '../../db/repos.js';
import type {
  DecisionRow,
  EventRow,
  KeywordRow,
  RunListRow,
  RunRow,
  SiteRow,
  StepRow,
} from '../../db/repos.js';
import type { KeywordView, LinkView, SiteView } from '../../core/types.js';
import type { PresenterRow } from '../../db/repos.js';
import { formatMinutes } from '../../core/selector.js';
import { isSocialOnly } from '../../core/social-only.js';
import { scenesFor } from '../../reels/plan.js';
import { channelKeys, channelOf, readChannels } from '../../reels/engine.js';
import { ARTICLE_ROLES, MAX_REFERENCES, MUSIC_SLOTS, musicSlotKey, type ArticleRole, type ReelMode } from '../../reels/compose.js';

const ROLE_LABEL: Record<ArticleRole, string> = {
  hero: 'Hero',
  stepA: 'First method shot',
  stepB: 'Second method shot',
  stepC: 'Third method shot',
};
import type { ReelFormat } from '../../reels/formats.js';
import type { Endpoint } from '../../llm/pool.js';
import type { SettingSpec } from '../../settings.js';
import type { Supply } from '../../core/supply.js';
import type { RunUsage } from '../../db/repos.js';
import type { KeywordDiagnosis } from '../../core/diagnosis.js';
import type {
  KeywordImageCounts,
  KeywordListView,
  SharedImageInfo,
} from '../../db/repos.js';

/* =========================================================================
 * Dashboard
 * ====================================================================== */

export interface DashboardData {
  sites: SiteView[];
  eligibility: { domain: string; eligible: boolean; reason: string }[];
  publishedToday: number;
  failedToday: number;
  supply: Supply;
  recentRuns: RunListRow[];
  automationOn: boolean;
  problems: string[];
  busy: boolean;
  lockedAt: string | null;
  /** Scheduler checks, newest first — the Decisions page, folded in here. */
  cycles: { cycle_id: string; created_at: string; n: number }[];
  selectedCycle: string | null;
  decisions: DecisionRow[];
  /** For the manual run picker: what a person may choose to run right now. */
  keywords: KeywordView[];
  links: LinkView[];
  /** Articles written and stopped before publishing, waiting for a person. */
  held: RunListRow[];
  /** Published and failed per day, oldest first. */
  activity: { day: string; published: number; failed: number }[];
}

/**
 * The manual run picker.
 *
 * "Run once now" used to hand the decision to the selector, which meant it ran
 * whatever the scheduler would have run anyway — and refused when every site
 * had hit its daily target, which is exactly when someone reaches for it. It
 * now asks which site and which keyword, and runs that pair immediately.
 *
 * A <dialog>, so the modal behaviour, the backdrop and Escape to close are the
 * browser's rather than three more handlers to maintain.
 */
/** What the manual run picker needs: the sites, the keywords, their links, and whether a run is on. */
export type RunPickerData = Pick<DashboardData, 'sites' | 'keywords' | 'links' | 'busy'>;

export function runPicker(data: RunPickerData): Html {
  // Paused sites are listed, and labelled. Pausing stops the scheduler from
  // choosing a site; it is not meant to stop a person who names it.
  const runnable = data.sites;

  // Which keywords are linked to which sites, so choosing a site narrows the
  // keyword list to the pairs that were actually planned.
  const linkedSites = new Map<number, number[]>();
  for (const link of data.links) {
    if (link.status !== 'go') continue;
    const list = linkedSites.get(link.keywordId) ?? [];
    list.push(link.siteId);
    linkedSites.set(link.keywordId, list);
  }

  const choosable = data.keywords.filter((k) => k.status !== 'no');

  return html`
    <dialog id="run-once" class="card picker">
      <form method="post" action="/run-now">
        <h2>Run once now</h2>
        <p class="subtitle">
          This starts immediately and ignores the daily target and the interval
          since the last post. It publishes for real.
        </p>

        <div class="field">
          <label for="pick-site">Site</label>
          <select id="pick-site" name="site_id" required>
            ${runnable.map(
              (site) => html`<option value="${site.id}">
                ${site.domain}${site.status === 'paused' ? ' (paused)' : ''}
              </option>`,
            )}
          </select>
        </div>

        <div class="field">
          <label for="pick-keyword">Keyword</label>
          <select id="pick-keyword" name="keyword_id" required>
            ${choosable.map(
              (keyword) => html`<option value="${keyword.id}"
                data-sites="${(linkedSites.get(keyword.id) ?? []).join(',')}"
                >${keyword.spyTitle || keyword.seedKeyword}</option
              >`,
            )}
          </select>
          <p class="help">
            <label class="choice">
              <input type="checkbox" id="pick-all" />
              Show keywords that are not linked to this site
            </label>
          </p>
        </div>

        ${runnable.length === 0 || choosable.length === 0
          ? html`<div class="flash warn">
              Add at least one site and one keyword before running by hand.
            </div>`
          : raw('')}

        <div class="save-bar">
          <button type="button" id="run-once-cancel">Cancel</button>
          <button class="primary" type="submit"
                  ${runnable.length === 0 || choosable.length === 0 ? raw('disabled') : raw('')}>
            Run now
          </button>
        </div>
      </form>
    </dialog>

    <script>
      (function () {
        var dialog = document.getElementById('run-once');
        var site = document.getElementById('pick-site');
        var keyword = document.getElementById('pick-keyword');
        var all = document.getElementById('pick-all');

        // Hidden rather than removed, so unchecking the box brings them back
        // without rebuilding the list.
        function filter() {
          var chosen = site.value;
          var firstVisible = null;
          for (var i = 0; i < keyword.options.length; i++) {
            var option = keyword.options[i];
            var linked = (option.dataset.sites || '').split(',').indexOf(chosen) !== -1;
            var show = all.checked || linked;
            option.hidden = !show;
            option.disabled = !show;
            if (show && firstVisible === null) firstVisible = option;
          }
          // A hidden option can stay selected, which submits a pair the person
          // cannot see. Move to the first one they can.
          if (keyword.selectedOptions[0] && keyword.selectedOptions[0].hidden) {
            keyword.value = firstVisible ? firstVisible.value : '';
          }
        }

        document.getElementById('run-once-open').addEventListener('click', function () {
          filter();
          dialog.showModal();
        });
        document.getElementById('run-once-cancel').addEventListener('click', function () {
          dialog.close();
        });
        site.addEventListener('change', filter);
        all.addEventListener('change', filter);
      })();
    </script>
  `;
}

/** Decisions as a page of its own, under Activity. */
export function decisionsPage(
  cycles: { cycle_id: string; created_at: string; n: number }[],
  selected: string | null,
  rows: DecisionRow[],
  activity: { day: string; published: number; failed: number }[] = [],
): Html {
  return html`
    <h1>Decisions</h1>
    <p class="subtitle">Why the scheduler picked what it picked -- or nothing.</p>

    ${activity.length
      ? html`<div class="card">
          <div class="spread" style="align-items:center">
            <h3 style="margin:0">Last ${activity.length} days</h3>
            <span class="muted small">
              <span class="key brand"></span> published
              <span class="key red"></span> failed
            </span>
          </div>
          <div class="chart">${sparkline(activity, { width: 720, height: 64 })}</div>
        </div>`
      : raw('')}

    ${decisionsSection(cycles, selected, rows, '/decisions')}
  `;
}

function decisionsSection(
  cycles: { cycle_id: string; created_at: string; n: number }[],
  selected: string | null,
  rows: DecisionRow[],
  base = '/',
): Html {
  if (cycles.length === 0) {
    return html`
      <h2>Decisions</h2>
      <div class="card">
        ${emptyState('No scheduler checks recorded yet. Every skip will be explained here.')}
      </div>
    `;
  }

  return html`
    <h2>Decisions</h2>
    <p class="subtitle">
      Every site checked and every keyword skipped, with the reason recorded at
      the moment the choice was made. Pick a check to read it.
    </p>

    <div class="card">
      <div class="row wrap">
        ${cycles.map(
          (c) => html`<a class="button small ${c.cycle_id === selected ? 'primary' : ''}"
            href="${base}?cycle=${c.cycle_id}#decisions">${timeAgo(c.created_at)} (${c.n})</a>`,
        )}
      </div>
    </div>

    ${selected
      ? html`<div class="card table-wrap scroll-y" id="decisions">
          <table>
            <thead><tr><th>Type</th><th>Subject</th><th>Decision</th><th>Reason</th></tr></thead>
            <tbody>
              ${rows.map(
                (r) => html`<tr>
                  <td class="muted small">${r.subject_type}</td>
                  <td>${r.subject_label || '—'}</td>
                  <td>${statusBadge(r.decision)}</td>
                  <td class="small">${r.reason}</td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>`
      : raw('')}
  `;
}

/* =========================================================================
 * Runs
 * ====================================================================== */

function runTable(runs: RunListRow[], selectable = false): Html {
  return html`<table>
    <thead>
      <tr>${selectable ? html`<th style="width:28px"></th>` : raw('')}<th>Started</th><th>Site</th><th>Keyword</th><th>Status</th><th>Detail</th><th></th></tr>
    </thead>
    <tbody>
      ${runs.map(
        (r) => html`<tr>
          ${selectable
            ? html`<td>${r.hold ? html`<input type="checkbox" name="ids" value="${r.id}" form="bulk-discard" aria-label="Select" />` : raw('')}</td>`
            : raw('')}
          <td class="nowrap muted">${timeAgo(r.started_at)}</td>
          <td>${r.site_domain ?? '—'}</td>
          <td>${r.seed_keyword ?? '—'}</td>
          <td>${runBadge(r)}</td>
          <td class="small">
            ${r.status === 'published'
              ? html`<a href="${r.post_url ?? '#'}" target="_blank" rel="noopener">view article</a>`
              : r.hold
                ? html`<span class="muted">${r.title || 'written, not published'}</span>`
                : html`<span class="muted"
                    >${r.failed_step ? `${r.failed_step}: ` : ''}${(r.error ?? '').slice(0, 120)}</span
                  >
                  ${r.retry_after
                    ? html`<div class="badge warn">retrying ${timeAgo(r.retry_after)}</div>`
                    : raw('')}`}
          </td>
          <td class="nowrap"><a class="button small" href="/runs/${r.id}">Open</a></td>
        </tr>`,
      )}
    </tbody>
  </table>`;
}

export function runsPage(
  runs: RunListRow[],
  page: number,
  total: number,
  heldCount = 0,
  filter: { sites: { id: number; domain: string }[]; site: number } = { sites: [], site: 0 },
): Html {
  const siteQ = filter.site ? `&site=${filter.site}` : '';
  const pages = Math.max(1, Math.ceil(total / 50));
  const anyHeld = runs.some((r) => r.hold);
  return html`
    <div class="spread">
      <div>
        <h1>Articles</h1>
        <p class="subtitle">
          ${total} article(s) so far. Open one to see every step, what it cost, and
          why it failed if it did.
        </p>
      </div>
      <a class="button" href="/data/export/articles" download>Export CSV</a>
    </div>
    ${heldCount > 0
      ? html`<form id="bulk-discard" method="post" action="/runs/discard" class="card row wrap" style="gap:8px;align-items:center"
              onsubmit="return confirm('Discard the chosen articles? They are not published; their keywords go back to go and are checked again before anything is written.')">
          <span><strong>${heldCount}</strong> waiting for approval</span>
          ${anyHeld ? html`<button type="submit" name="mode" value="selected" class="danger">Discard selected</button>` : raw('')}
          <button type="submit" name="mode" value="all" class="danger">Discard all ${heldCount}</button>
        </form>`
      : raw('')}
    <div class="card table-wrap">
      ${runs.length === 0 ? emptyState('No runs yet.') : runTable(runs, heldCount > 0)}
    </div>
    ${pages > 1
      ? html`<div class="row">
          ${page > 1 ? html`<a class="button small" href="/runs?page=${page - 1}${siteQ}">Previous</a>` : raw('')}
          <span class="muted small">Page ${page} of ${pages}</span>
          ${page < pages ? html`<a class="button small" href="/runs?page=${page + 1}${siteQ}">Next</a>` : raw('')}
        </div>`
      : raw('')}
  `;
}

export interface RunDetailData {
  run: RunRow;
  steps: StepRow[];
  site: SiteRow | undefined;
  keyword: KeywordRow | undefined;
  usage: RunUsage;
  /** The generated article, when one has been produced. */
  article: Record<string, unknown> | null;
  /** An existing article on this site with almost the same title. */
  duplicate: { title: string; url: string | null; similarity: number } | null;
  /**
   * The rotations this article drew: the shape it was written in, the shoot
   * its photographs were taken on, the design on its pin.
   *
   * Shown because a rotation nobody can see is a rotation nobody can judge:
   * comparing two articles meant reading them side by side and guessing which
   * shape each had.
   */
  rotations?: { label: string; name: string }[];
}

/** The Pinterest steps after publishing: a failure in one of them can be retried on its own. */
const PIN_STEPS = ['generate-pin-description', 'resolve-buffer-target', 'publish-to-buffer'];

/**
 * True when collage-post's last result was `{ error }`.
 *
 * The step never throws (it is a bonus post, not the article), so its row
 * is always 'ok' even on failure -- the only place that says it failed is
 * its own output, not the step's status the way PIN_STEPS can be checked.
 */
function collageFailed(steps: StepRow[]): boolean {
  const last = steps.find((s) => s.step === 'collage-post');
  if (!last?.output_json) return false;
  try {
    return typeof (JSON.parse(last.output_json) as { error?: unknown }).error === 'string';
  } catch {
    return false;
  }
}

export function runDetailPage(data: RunDetailData): Html {
  const { run, steps, site, keyword } = data;

  return html`
    <div class="spread">
      <div>
        <h1>${run.title || `Run #${run.id}`}</h1>
        <p class="subtitle">
          ${site?.domain ?? 'unknown site'} · ${keyword?.seed_keyword ?? 'unknown keyword'} ·
          started ${timeAgo(run.started_at)}
          ${run.mode === 'dry' ? html` · <span class="badge brand">dry run</span>` : raw('')}
        </p>
        ${(data.rotations ?? []).length
          ? html`<p class="row wrap small" style="gap:6px;margin:6px 0 0">
              ${(data.rotations ?? []).map((r) => html`<span class="badge muted" title="${r.label}">${r.label}: ${r.name}</span>`)}
            </p>`
          : raw('')}
      </div>
      <div class="row">
        ${runBadge(run)}
        ${run.status === 'failed'
          ? html`<form method="post" action="/runs/${run.id}/resume">
              <button class="primary" type="submit">Resume from failed step</button>
            </form>`
          : raw('')}
        ${run.status === 'published' && steps.some((s) => s.status === 'failed' && PIN_STEPS.includes(s.step))
          ? html`<form method="post" action="/runs/${run.id}/pin/retry">
              <button class="primary" type="submit">Retry the Pinterest pin</button>
            </form>`
          : raw('')}
        ${run.status === 'published' && collageFailed(steps)
          ? html`<form method="post" action="/runs/${run.id}/collage/retry">
              <button class="primary" type="submit">Retry the photo collage</button>
            </form>`
          : raw('')}
      </div>
    </div>

    ${run.hold ? approvalBar(run, data.duplicate) : raw('')}

    ${run.error
      ? html`<div class="flash error">
          <strong>Failed at "${run.failed_step ?? 'unknown'}"</strong>
          <div class="mono" style="margin-top:6px">${run.error}</div>
          ${run.retry_after
            ? html`<div class="small" style="margin-top:8px">
                Scheduled to retry by itself ${timeAgo(run.retry_after)} — attempt
                ${run.attempts + 1}. Resuming it here does the same thing sooner.
              </div>`
            : run.attempts > 0
              ? html`<div class="small" style="margin-top:8px">
                  Retried automatically ${run.attempts} time(s) and still failing, so it is
                  waiting for you.
                </div>`
              : raw('')}
        </div>`
      : raw('')}
    ${run.post_url
      ? html`<div class="flash ok">
          Published: <a href="${run.post_url}" target="_blank" rel="noopener">${run.post_url}</a>
        </div>`
      : raw('')}

    ${usageRow(data.usage)}

    ${data.article ? articlePreview(data.article, Boolean(run.hold), run.id) : raw('')}

    <h2>Steps</h2>
    ${steps.length === 0
      ? html`<div class="card">${emptyState('No steps recorded yet.')}</div>`
      : html`${steps.map(
          (step) => html`
            <div class="card step-${step.status}">
              <div class="spread">
                <div>
                  <strong>${step.step}</strong> ${statusBadge(step.status)}
                  <div class="muted small">
                    ${formatDuration(step.duration_ms)}
                    ${step.attempt > 1 ? html` · attempt ${step.attempt}` : raw('')}
                    ${step.endpoint ? html` · endpoint: ${step.endpoint}` : raw('')}
                    ${step.model ? html` · ${step.model}` : raw('')}
                    ${step.tokens_in + step.tokens_out > 0
                      ? html` · ${formatTokens(step.tokens_in)} in / ${formatTokens(step.tokens_out)} out`
                      : raw('')}
                    ${step.images > 0 ? html` · ${step.images} image(s)` : raw('')}
                  </div>
                </div>
                <span class="muted small nowrap">${timeAgo(step.started_at)}</span>
              </div>
              ${step.error
                ? html`<div class="flash error" style="margin-top:10px">${step.error}</div>`
                : raw('')}
              ${step.output_json
                ? html`<details>
                    <summary>Output</summary>
                    <pre>${prettyJson(step.output_json)}</pre>
                  </details>`
                : raw('')}
            </div>
          `,
        )}`}
  `;
}

/**
 * The decision bar on a held run.
 *
 * Approving is a resume: the article, the images and every other step are
 * already stored, so releasing it costs one HTTP post rather than a second
 * pipeline. That is also why discarding is offered here — the alternative to
 * "publish" should be visible in the same place, not hidden behind the run
 * list.
 */
function approvalBar(
  run: RunRow,
  duplicate: { title: string; url: string | null; similarity: number } | null,
): Html {
  return html`
    <div class="flash warn">
      <strong>
        ${run.hold === 'dry'
          ? 'Dry run — nothing was published'
          : duplicate && duplicate.similarity >= 1
            ? 'Held — this title is already on the site'
            : 'Written and waiting for your approval'}
      </strong>
      <div class="small" style="margin-top:6px">
        ${run.hold === 'dry'
          ? html`This ran the whole pipeline against ${run.title ? 'the keyword' : 'a keyword'} and
              stopped before posting. The images were generated and uploaded; only the article
              itself was not published. Publish it anyway if you like what you see.`
          : duplicate && duplicate.similarity >= 1
            ? html`An article with this exact title is already published here, so this one
                stopped before posting rather than putting a second copy on the site. Approve
                only if you mean to have both; otherwise discard it.`
            : html`This site has automatic publishing turned off, so every article stops here.
                Approving publishes it and continues to Pinterest exactly as a normal run would.`}
      </div>

      ${duplicate
        ? html`<div class="small" style="margin-top:10px">
            <span class="badge error">possible duplicate</span>
            ${Math.round(duplicate.similarity * 100)}% of the words overlap with
            &ldquo;${duplicate.title}&rdquo;, already on this site.
            ${duplicate.url
              ? html`<a href="${duplicate.url}" target="_blank" rel="noopener">Read the existing one</a>.`
              : raw('')}
          </div>`
        : raw('')}

      <div class="row wrap" style="margin-top:12px">
        <form method="post" action="/runs/${run.id}/resume">
          <button class="primary" type="submit">
            ${run.hold === 'dry' ? 'Publish it anyway' : 'Approve and publish'}
          </button>
        </form>
        <form method="post" action="/runs/${run.id}/discard"
              onsubmit="return confirm('Discard this article? The keyword goes back to go so it can be written again.')">
          <button class="danger" type="submit">Discard</button>
        </form>
      </div>
    </div>
  `;
}

/** What this run cost, from the tokens the provider reported per step. */
function usageRow(usage: RunUsage): Html {
  if (usage.tokensIn + usage.tokensOut + usage.images === 0) return raw('');

  return html`
    <div class="grid">
      <div class="stat">
        <div class="value">${formatTokens(usage.tokensIn + usage.tokensOut)}</div>
        <div class="label">Tokens</div>
        <div class="muted small">
          ${formatCount(usage.tokensIn)} in / ${formatCount(usage.tokensOut)} out
        </div>
      </div>
      <div class="stat">
        <div class="value">${usage.llmCalls}</div>
        <div class="label">Model calls</div>
      </div>
      <div class="stat">
        <div class="value">${usage.images}</div>
        <div class="label">Images generated</div>
      </div>
      <div class="stat">
        <div class="value">${formatDuration(usage.durationMs)}</div>
        <div class="label">Time in steps</div>
      </div>
    </div>
  `;
}

/**
 * The generated article, as prose rather than as JSON.
 *
 * The step output was always here in a <pre>, which is unreadable at article
 * length and impossible to judge — and judging it is the entire point of
 * holding it. The fields come from the prompts, so this renders what it
 * recognises and lists the rest rather than assuming a fixed shape.
 */
function articlePreview(
  article: Record<string, unknown>,
  editable: boolean,
  runId: number,
): Html {
  const text = (key: string): string => {
    const value = article[key];
    return typeof value === 'string' ? value : '';
  };

  const title = text('title') || text('name');
  const known = new Set(['title', 'name', 'description', 'intro', 'summary']);

  const body = Object.entries(article)
    .filter(([key]) => !known.has(key))
    .map(([key, value]) => html`
      <section class="article-block">
        <h4>${key.replace(/[_-]/g, ' ')}</h4>
        ${renderValue(value)}
      </section>
    `);

  return html`
    <h2>The article</h2>

    <!-- Folded away by default, like the step outputs below it. A finished
         recipe is a couple of thousand words, and on a run you opened to find
         out why Buffer rejected it, that is the whole page pushed off screen.
         Open on a held run, where reading it is the entire task. -->
    <details class="card article" ${editable ? raw('open') : raw('')}>
      <summary>
        ${title || 'Read the article'}
        <span class="muted small">${editable ? 'waiting for you' : 'read it'}</span>
      </summary>
      <div class="article-body">
        ${text('description') || text('intro') || text('summary')
          ? html`<p class="muted">${text('description') || text('intro') || text('summary')}</p>`
          : raw('')}
        ${body}
      </div>
    </details>

    ${editable
      ? html`<details class="card">
          <summary>Edit the article before publishing</summary>
          <p class="muted small" style="margin-top:10px">
            This is the exact document that will be posted. Editing it here replaces the stored
            step output, so approving afterwards publishes what you see. It has to stay valid
            JSON — a malformed edit is refused rather than saved.
          </p>
          <form method="post" action="/runs/${runId}/article">
            <div class="field">
              <textarea name="article" rows="22" spellcheck="false"
                        class="mono">${JSON.stringify(article, null, 2)}</textarea>
            </div>
            <button class="primary" type="submit">Save the edit</button>
          </form>
        </details>`
      : raw('')}
  `;
}

/** Render one article field, whatever shape the prompt produced. */
function renderValue(value: unknown): Html {
  if (typeof value === 'string') {
    return html`${value
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((paragraph) => html`<p>${paragraph}</p>`)}`;
  }

  if (Array.isArray(value)) {
    return html`<ul>
      ${value.map(
        (item) =>
          html`<li>${typeof item === 'string' ? item : raw(escapeForPre(JSON.stringify(item)))}</li>`,
      )}
    </ul>`;
  }

  if (value && typeof value === 'object') {
    return html`<dl>
      ${Object.entries(value as Record<string, unknown>).map(
        ([key, inner]) => html`<dt>${key.replace(/[_-]/g, ' ')}</dt>
          <dd>${typeof inner === 'string' ? inner : raw(escapeForPre(JSON.stringify(inner)))}</dd>`,
      )}
    </dl>`;
  }

  return html`<p>${String(value ?? '')}</p>`;
}

/** JSON dropped into markup still has to be escaped. */
function escapeForPre(json: string): string {
  return json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/* =========================================================================
 * Sites
 * ====================================================================== */

export function sitesPage(
  sites: SiteRow[],
  views: SiteView[],
  eligibility: { domain: string; eligible: boolean; reason: string }[] = [],
  /** Enabled Buffer accounts per site (Channels -> Pinterest / Facebook / Instagram). */
  bufferAccounts: Record<number, number> = {},
): Html {
  return html`
    <h1>Sites</h1>
    <p class="subtitle">
      Every website you publish to. Each one has its own daily target, gap between
      posts, and tokens. "Can run now?" says whether the platform would pick it at
      this moment, and why not if it would not.
    </p>

    ${sites.length === 0
      ? raw('')
      : html`
          <!-- Every control is a verb applied to the ticked rows, matching the
               keywords page. The two fields that need a value carry it beside
               the button that uses it, so no action depends on a field the
               person cannot see from the button they press. -->
          <form method="post" action="/sites/bulk" id="bulk" class="bulkbar">
            <div class="bulk-count">
              <span id="pick-count">0</span> selected
              <span class="muted small" id="pick-hint">— tick a row to act on it</span>
            </div>

            <div class="bulk-actions">
              <div class="bulk-group">
                <button type="submit" name="action" value="activate" class="primary">
                  Activate
                </button>
                <button type="submit" name="action" value="pause">Pause</button>
              </div>

              <div class="bulk-group">
                <span class="muted small">Publishing</span>
                <button type="submit" name="action" value="auto">Automatic</button>
                <button type="submit" name="action" value="hold">Hold for approval</button>
              </div>

              <div class="bulk-group">
                <label class="muted small" for="bulk-target">Articles a day</label>
                <input type="number" id="bulk-target" name="daily_target" min="0" max="100"
                       value="8" style="width:5rem" />
                <button type="submit" name="action" value="target" formnovalidate>Set</button>
              </div>

              <div class="bulk-group">
                <label class="muted small" for="bulk-interval">Wait between posts</label>
                <input type="number" id="bulk-interval" name="interval_amount" min="0"
                       value="3" style="width:5rem" />
                <select name="interval_unit" style="width:auto">
                  <option value="minutes">minutes</option>
                  <option value="hours" selected>hours</option>
                  <option value="days">days</option>
                </select>
                <button type="submit" name="action" value="interval" formnovalidate>Set</button>
              </div>
            </div>
          </form>
        `}

    <div class="card table-wrap">
      ${sites.length === 0
        ? emptyState('No sites yet. Add your first one below.')
        : html`<table>
            <thead>
              <!-- No Name column: in practice every site's name is its domain,
                   so the column was a second copy of the one beside it. The
                   field is still on the form, and still what the run log and
                   notifications call a site. -->
              <tr>
                <th class="pick">
                  <input type="checkbox" id="pick-all" title="Select every site" />
                </th>
                <th>Domain</th><th>Status</th><th>Publishing</th><th>Target</th>
                <th>Interval</th><th>Credentials</th><th>Today</th><th>Last publish</th>
                <th>Can run now?</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${sites.map((s) => {
                const v = views.find((x) => x.id === s.id);
                return html`<tr>
                  <td class="pick">
                    <input type="checkbox" form="bulk" name="ids" value="${s.id}" />
                  </td>
                  <td class="mono">
                    ${s.domain}
                    ${isSocialOnly(s)
                      ? html`<span class="badge muted" title="No website: posts go out without a link">social only</span>`
                      : raw('')}
                  </td>
                  <td>
                    ${statusBadge(s.status)}
                    ${s.status === 'paused' && s.paused_reason
                      ? html`<div class="muted small">${s.paused_reason}</div>`
                      : raw('')}
                    ${s.status === 'paused' && s.paused_until
                      ? html`<div class="muted small">resumes ${timeAgo(s.paused_until)}</div>`
                      : raw('')}
                  </td>
                  <td>
                    ${s.auto_publish === 0
                      ? html`<span class="badge warn">needs approval</span>`
                      : html`<span class="badge muted">automatic</span>`}
                  </td>
                  <td>${s.daily_target}</td>
                  <td class="nowrap">${formatMinutes(s.interval_minutes)}</td>
                  <td class="nowrap small">
                    ${isSocialOnly(s)
                      ? raw('')
                      : hasSecret(s.api_token_encrypted)
                      ? html`<span class="badge ok">API</span>`
                      : html`<span class="badge error">API</span>`}
                    ${hasSecret(s.buffer_token_encrypted) || (bufferAccounts[s.id] ?? 0) > 0
                      ? html`<span class="badge ok" title="${bufferAccounts[s.id] ?? 0} Buffer account(s) under Channels → Pinterest / Facebook / Instagram">Buffer${(bufferAccounts[s.id] ?? 0) > 1 ? ` ×${bufferAccounts[s.id]}` : ''}</span>`
                      : html`<span class="badge muted" title="No Buffer account: add one under Channels → Pinterest, Facebook or Instagram">Buffer</span>`}
                  </td>
                  <td>${v?.publishedToday ?? 0}</td>
                  <td class="nowrap muted">${timeAgo(v?.lastPublishAt ?? null)}</td>
                  <td>
                    ${(() => {
                      const verdict = eligibility.find((e) => e.domain === s.domain);
                      if (!verdict) return raw('');
                      return verdict.eligible
                        ? html`<span class="badge ok">yes</span>`
                        : html`<span class="badge muted">no</span>
                            <div class="muted small">${verdict.reason}</div>`;
                    })()}
                  </td>
                  <td class="nowrap">
                    <a class="button small" href="/sites/${s.id}">Edit</a>
                    <a class="button small" href="/sites/${s.id}/backup" title="Download this site, its accounts, keywords and history as one file">Back up</a>
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>`}
    </div>

    <h2>Add a site</h2>
    <div class="card">${siteForm(null)}</div>

    <details class="card">
      <summary><strong>Many at once</strong> <span class="muted small">— import or export sites as a CSV file</span></summary>
      <div style="margin-top:10px">
      <p class="muted small" style="margin-top:0">
        Columns: <span class="mono">name, domain, status, daily_target, interval_minutes,
        pin_username, project_id, auto_publish, paused_reason, api_token, buffer_token</span>.
        Only <span class="mono">domain</span> is required, and sites are matched on it &mdash;
        so importing the same file twice corrects rather than duplicates. A blank
        <span class="mono">api_token</span> or <span class="mono">buffer_token</span> keeps
        whatever is stored, which is what makes an export safe to edit and import straight back.
      </p>

      <form method="post" action="/sites/import" enctype="multipart/form-data">
        <div class="field"><input type="file" name="file" accept=".csv,text/csv" required /></div>
        <div class="row wrap">
          <button class="primary" type="submit">Import CSV</button>
          <a class="button" href="/sites/template.csv" download>Download a template</a>
          <a class="button" href="/data/export/sites" download>Export sites</a>
        </div>
        <div class="help" style="margin-top:8px">
          The export carries everything except the tokens, so it is safe to keep or share.
        </div>
      </form>
      </div>
    </details>

    <details class="card">
      <summary><strong>Restore a site</strong> <span class="muted small">— from a file made with "Back up"</span></summary>
      <div style="margin-top:10px">
        <p class="muted small" style="margin-top:0">
          The site is found by its domain. If it is not here it is created, with its accounts,
          keywords, tokens and history. If it is here, its own data is replaced by the backup's;
          other sites are not touched. A full platform backup is saved first
          (Setup &rarr; Backups), so a restore can be undone.
        </p>
        <form method="post" action="/sites/restore" enctype="multipart/form-data"
              onsubmit="return confirm('Restore this site from the file? If the site already exists, its data is replaced.')">
          <div class="field"><input type="file" name="file" accept=".gz,.json,application/gzip,application/json" required /></div>
          <div class="row wrap">
            <button class="primary" type="submit">Restore site</button>
          </div>
          <div class="help" style="margin-top:8px">
            The file holds this site's tokens in the clear. Keep it private.
          </div>
        </form>
      </div>
    </details>
    ${raw(BULK_SELECTION_SCRIPT)}
  `;
}

export function siteEditPage(site: SiteRow, bufferAccounts: BufferAccount[] = []): Html {
  return html`
    <div class="spread">
      <div>
        <h1>${site.domain}</h1>
        <p class="subtitle">Edit site configuration.</p>
      </div>
      <div class="row wrap">
        <!-- Publishing mode sits with Pause rather than in the form below.
             Both answer "what is this site doing right now", which is a
             different question from the settings underneath, and neither means
             anything on a site that does not exist yet — which is why they are
             gone from Add a site entirely. -->
        <form method="post" action="/sites/${site.id}/publishing">
          <select name="auto_publish" onchange="this.form.submit()"
                  title="Holding stops each run after the article is written">
            <option value="1" ${site.auto_publish !== 0 ? raw('selected') : raw('')}>
              publishes automatically
            </option>
            <option value="0" ${site.auto_publish === 0 ? raw('selected') : raw('')}>
              holds for approval
            </option>
          </select>
        </form>

        <!-- Spelling and units. A site for American cooks written in "savoury"
             and "260°C" is the failure this exists to prevent, and it is one
             setting per site rather than a rule buried in six prompts. -->
        <form method="post" action="/sites/${site.id}/style">
          <select name="writing_style" onchange="this.form.submit()"
                  title="The spelling and units every article on this site is written in">
            <option value="us" ${site.writing_style !== 'uk' ? raw('selected') : raw('')}>
              American — US spelling, °F and cups
            </option>
            <option value="uk" ${site.writing_style === 'uk' ? raw('selected') : raw('')}>
              British — UK spelling, °C and grams
            </option>
          </select>
        </form>

      ${site.status === 'active'
        ? html`<form method="post" action="/sites/${site.id}/pause" class="row wrap">
            <input type="text" name="reason" placeholder="why?" style="width:auto" required />
            <select name="hours" style="width:auto">
              <option value="4">4 hours</option>
              <option value="24" selected>a day</option>
              <option value="72">3 days</option>
              <option value="168">a week</option>
              <option value="0">until I say</option>
            </select>
            <button type="submit">Pause</button>
          </form>`
        : html`<form method="post" action="/sites/${site.id}/activate">
            <button class="primary" type="submit">Resume publishing</button>
          </form>`}
      </div>
    </div>

    ${site.status === 'paused' && site.paused_reason
      ? html`<div class="flash warn">
          Paused: ${site.paused_reason}
          ${site.paused_until
            ? html` &mdash; resuming by itself ${timeAgo(site.paused_until)}.`
            : html` &mdash; no end set, so it stays paused until you resume it.`}
        </div>`
      : raw('')}

    <div class="card">${siteForm(site)}</div>
    <div class="card muted small">
      Pinterest and Facebook (Buffer accounts, Pinterest username) are set under
      <a href="/pinterest">Channels &rarr; Pinterest</a> and
      <a href="/accounts#facebook-pages">Channels &rarr; Facebook</a>.
    </div>
    <div class="card">
      <h3>Back up this site</h3>
      <p class="muted small">
        One file with this site only: its settings and tokens, its accounts on each network
        (boards and Buffer tokens), its keywords, blog questions, Radar, Search Console and
        Taxonomy data, and its history. Restore it from the Sites page and nothing has to be
        filled in again. The file holds the tokens in the clear, so keep it private.
      </p>
      <a class="button" href="/sites/${site.id}/backup">Download backup</a>
    </div>
    <div class="card">
      <h3>Delete this site</h3>
      <p class="muted small">
        Removes the site and its keyword links. Run history is preserved but detached.
      </p>
      <form method="post" action="/sites/${site.id}/delete"
            onsubmit="return confirm('Delete ${site.domain}? This cannot be undone.')">
        <button class="danger" type="submit">Delete site</button>
      </form>
    </div>
  `;
}

/**
 * The Buffer accounts this site posts through, in the order they are tried.
 *
 * A Buffer queue takes ten posts a day and then refuses. With one account that
 * ended the run at its last step, with the article already written and
 * published. With several, the run moves down this list and finishes.
 */
export function bufferAccountsCard(
  site: Pick<SiteRow, 'id' | 'domain'>,
  allAccounts: BufferAccount[],
  platform: 'pinterest' | 'facebook' | 'instagram',
  back: string,
): Html {
  // This network's accounts, plus any shared with the other network.
  const accounts = allAccounts.filter((a) => a.platform === platform || (platform !== 'instagram' && a.platform === 'both'));
  const room = BUFFER_ACCOUNT_LIMIT - allAccounts.length;
  const network = platform === 'pinterest' ? 'Pinterest' : platform === 'instagram' ? 'Instagram' : 'Facebook';
  const hidden = html`<input type="hidden" name="back" value="${back}" />`;

  // A grid rather than a table. A table spreads its columns to fill the card,
  // which on a wide screen put a hand's width of nothing between the token
  // field and the switch beside it. The grid gives the two text fields the
  // room and holds everything else to the width it needs, and header and rows
  // share one column definition so they cannot fall out of line.
  const row = (account: BufferAccount): Html => {
    const full = account.fullUntil !== null && account.fullUntil > new Date();

    return html`
      <li class="account">
        <span class="account-index">${account.position}</span>

        <label class="account-field">
          <span>Label</span>
          <input type="text" form="buffer-${account.id}" name="label"
                 value="${account.label}" />
        </label>

        <label class="account-field">
          <span>API token</span>
          <input type="password" form="buffer-${account.id}" name="token"
                 autocomplete="new-password" placeholder="leave blank to keep the saved one" />
        </label>

        <label class="inline-check account-rotation">
          <input type="checkbox" form="buffer-${account.id}" name="enabled" value="1"
                 ${account.enabled ? raw('checked') : raw('')} />
          in rotation
        </label>

        <label class="account-field" style="max-width:150px">
          <span>Used for</span>
          <select form="buffer-${account.id}" name="platform">
            <option value="${platform}" ${account.platform === platform ? raw('selected') : raw('')}>${network} only</option>
            ${platform === 'instagram'
              ? raw('')
              : html`<option value="both" ${account.platform === 'both' ? raw('selected') : raw('')}>Pinterest + Facebook</option>`}
          </select>
        </label>

        <div class="account-state">
          ${full
            ? html`<span class="badge warn" title="${account.lastError ?? ''}">queue full</span>`
            : account.enabled
              ? html`<span class="badge ok">ready</span>`
              : html`<span class="badge muted">out</span>`}
          <span class="muted small">
            ${account.lastUsedAt ? html`used ${timeAgo(account.lastUsedAt)}` : 'never used'}
          </span>
        </div>

        <div class="account-actions">
          <form method="post" action="/sites/${site.id}/buffer/${account.id}"
                id="buffer-${account.id}">${hidden}</form>
          <button class="small" type="submit" form="buffer-${account.id}">Save</button>
          <form method="post" action="/sites/${site.id}/buffer/${account.id}/delete"
                onsubmit="return confirm('Remove this Buffer account? Posts will use the next one.')">
            ${hidden}
            <button class="danger small" type="submit">Remove</button>
          </form>
        </div>
      </li>
    `;
  };

  return html`
    <div class="spread">
      <h3 style="margin:0">Buffer accounts</h3>
      <span class="muted small">${accounts.length} for ${network}</span>
    </div>
    <p class="muted small">
      Used in order. When one account's queue is full (10 posts on the free plan), the next one
      takes over automatically.
    </p>

    ${accounts.length === 0
      ? emptyState(`No Buffer account for ${network} yet. Add one below.`)
      : html`<ul class="accounts">
          ${accounts.map(row)}
        </ul>`}

    ${room > 0
      ? html`<details ${accounts.length === 0 ? raw('open') : raw('')} style="margin-top:10px">
          <summary class="button small" style="display:inline-block">+ Add ${accounts.length ? 'another' : 'a'} Buffer account</summary>
          <form method="post" action="/sites/${site.id}/buffer" class="account-add" style="margin-top:10px">
            ${hidden}
            <input type="hidden" name="platform" value="${platform}" />
            <label class="account-field">
              <span>Label</span>
              <input type="text" name="label" placeholder="e.g. ${network} 2" />
            </label>
            <label class="account-field">
              <span>API token</span>
              <input type="password" name="token" required autocomplete="new-password"
                     placeholder="from the Buffer account to add" />
            </label>
            <input type="hidden" name="enabled" value="1" />
            <button class="primary" type="submit">Add account</button>
          </form>
        </details>`
      : html`<p class="muted small">This site holds ${BUFFER_ACCOUNT_LIMIT} accounts, the most allowed. Remove one to add another.</p>`}
  `;
}

/** The last Suggest boards answer, to copy into Pinterest. */
function boardSuggestions(siteId: number, json: string): Html {
  type Row = { group: string; name: string; description: string; exists?: boolean };
  let plan: { boards: Row[]; general: Omit<Row, 'group'> | null } | null = null;
  try { plan = json ? JSON.parse(json) : null; } catch { plan = null; }
  if (!plan) return raw('');
  const rows: Row[] = [...plan.boards, ...(plan.general ? [{ group: '(general)', ...plan.general }] : [])];
  const copy = (text: string) =>
    html`<button type="button" class="small" onclick="navigator.clipboard&&navigator.clipboard.writeText(this.dataset.t);this.textContent='Copied'" data-t="${text}">Copy</button>`;
  const toCreate = new Set(rows.filter((r) => !r.exists).map((r) => r.name)).size;
  return html`<div class="card" style="margin:0 0 14px">
    <div class="spread"><strong>${toCreate ? `Create the ${toCreate} new board(s) on Pinterest` : 'All groups use boards you already have'}</strong>
      <form method="post" action="/pinterest/${siteId}/boards/suggest/clear"><button type="submit" class="small">Hide</button></form></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Group</th><th>Board</th><th>Status</th><th>Description</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr>
        <td class="muted small">${r.group}</td>
        <td class="nowrap">${r.name} ${r.exists ? raw('') : copy(r.name)}</td>
        <td class="nowrap small">${r.exists ? html`<span class="muted">✅ Exists</span>` : html`<strong>➕ Create</strong>`}</td>
        <td class="small">${r.exists ? raw('') : html`${r.description} ${r.description ? copy(r.description) : raw('')}`}</td>
      </tr>`)}</tbody>
    </table></div>
  </div>`;
}

/** Channels -> Pinterest: per site, the profile its pins go to and the Buffer accounts that post them. */
export function pinterestPage(
  sites: { site: Pick<SiteRow, 'id' | 'domain' | 'pin_username' | 'pin_posts' | 'pin_reels' | 'pin_default_board' | 'pin_board_map' | 'pin_board_suggestions'>; accounts: BufferAccount[] }[],
  groups: string[] = [],
): Html {
  return html`
    <h1>Pinterest</h1>
    <p class="subtitle">
      Choose what each site pins: the article (an image pin) and/or its reel (a video pin), scheduled
      through the site's Buffer account. Add a second account when the first one's queue fills up.
    </p>
    ${sites.length === 0
      ? html`<div class="card">${emptyState('Add a site under Channels → Sites first.')}</div>`
      : sites.map(
          ({ site, accounts }) => html`
            <div class="card">
              <h2 style="margin-top:0">${site.domain}</h2>
              <form method="post" action="/pinterest/${site.id}/publish" class="row wrap" style="gap:18px;margin-bottom:14px">
                <input type="hidden" name="sent" value="1" />
                <label class="row" style="gap:6px;margin:0;cursor:pointer">
                  <input type="checkbox" name="pin_posts" value="1" ${site.pin_posts ? 'checked' : ''} onchange="this.form.submit()" />
                  <span><strong>Posts</strong> <span class="muted small">— an image pin for every article</span></span>
                </label>
                <label class="row" style="gap:6px;margin:0;cursor:pointer">
                  <input type="checkbox" name="pin_reels" value="1" ${site.pin_reels ? 'checked' : ''} onchange="this.form.submit()" />
                  <span><strong>Reels</strong> <span class="muted small">— a video pin for every reel</span></span>
                </label>
              </form>
              <form method="post" action="/pinterest/${site.id}/username" class="row wrap" style="gap:8px;align-items:flex-end;margin-bottom:14px">
                <div class="field" style="margin:0;min-width:240px">
                  <label for="pin-${site.id}">Pinterest username</label>
                  <input id="pin-${site.id}" type="text" name="pin_username" value="${site.pin_username}" placeholder="e.g. recipesbuzz" />
                </div>
                <button type="submit" class="small">Save</button>
                <span class="muted small">Only needed when a Buffer account holds more than one Pinterest profile.</span>
              </form>
              <form method="post" action="/pinterest/${site.id}/boards" style="margin-bottom:14px">
                <h3 style="margin:0 0 6px">Boards</h3>
                <p class="small muted" style="margin:0 0 8px">
                  Which board each pin goes on. A topic group linked to a board always goes there; any other recipe is
                  placed by AI on the board that fits it, and on the general board when none does.
                  Type board names exactly as they are on Pinterest.
                </p>
                <div class="row wrap" style="gap:12px;align-items:flex-start">
                  <div class="field" style="margin:0;min-width:220px">
                    <label for="pdb-${site.id}">General board</label>
                    <input id="pdb-${site.id}" name="default_board" value="${site.pin_default_board ?? ''}" placeholder="e.g. Easy Recipes" />
                  </div>
                  <div class="field" style="margin:0;flex:1;min-width:260px">
                    <label for="pbm-${site.id}">Topic group = Board <span class="muted small">(one per line, optional)</span></label>
                    <textarea id="pbm-${site.id}" name="board_map" rows="4" placeholder="dessert = Desserts&#10;chicken = Chicken Dinners">${site.pin_board_map ?? ''}</textarea>
                    ${groups.length
                      ? html`<div class="small muted">Your topic groups: ${groups.slice(0, 30).join(', ')}</div>`
                      : raw('')}
                  </div>
                </div>
                <div class="row" style="gap:8px;margin-top:8px">
                  <button type="submit" class="small">Save boards</button>
                  <button type="submit" class="small primary" formaction="/pinterest/${site.id}/boards/suggest"
                          title="AI suggests a board for each topic group, and fills the links">Suggest boards</button>
                </div>
              </form>
              ${boardSuggestions(site.id, site.pin_board_suggestions ?? '')}
              ${bufferAccountsCard(site, accounts, 'pinterest', '/pinterest')}
            </div>`,
        )}
  `;
}


function siteForm(site: SiteRow | null): Html {
  const action = site ? `/sites/${site.id}` : '/sites';

  // Show the interval in the largest unit that divides evenly, so 1440
  // minutes comes back as "1 day" rather than "1440 minutes".
  const minutes = site?.interval_minutes ?? 480;
  const [amount, unit] =
    minutes % 1440 === 0 && minutes >= 1440
      ? [minutes / 1440, 'days']
      : minutes % 60 === 0 && minutes >= 60
        ? [minutes / 60, 'hours']
        : [minutes, 'minutes'];

  const secretField = (
    name: string,
    label: string,
    stored: string,
    help: string,
  ): Html => html`
    <div class="field">
      <label>${label}</label>
      <input type="password" name="${name}" autocomplete="new-password"
             placeholder="${hasSecret(stored) ? 'saved — leave blank to keep' : 'not set'}" />
      <div class="help">
        ${help}
        ${hasSecret(stored)
          ? html`<span class="badge ok" style="margin-left:6px">saved</span>`
          : html`<span class="badge muted" style="margin-left:6px">missing</span>`}
      </div>
    </div>
  `;

  return html`
    <form method="post" action="${action}">
      <div class="field-row">
        <div class="field">
          <label>Name</label>
          <input type="text" name="name" required value="${site?.name ?? ''}" />
          <div class="help">Short label, e.g. bitespoon</div>
        </div>
        <div class="field">
          <label>Domain</label>
          <input type="text" name="domain" value="${site && !isSocialOnly(site) ? site.domain : ''}"
                 placeholder="example.com — or blank for social only" />
          <div class="help">
            Without https://. Renaming keeps this site's history.
            Leave it blank for a <strong>social-only</strong> account: no article, posts without a link.
            Writing a domain here later turns it into a normal site.
          </div>
        </div>
        <div class="field">
          <label>Status</label>
          <select name="status">
            <option value="active" ${site?.status === 'active' ? raw('selected') : raw('')}>active</option>
            <option value="paused" ${site?.status !== 'active' ? raw('selected') : raw('')}>paused</option>
          </select>
        </div>
      </div>

      <h3>Publishing schedule</h3>
      <div class="field-row">
        <div class="field">
          <label>Daily target</label>
          <input type="number" name="daily_target" min="0" value="${site?.daily_target ?? 3}" />
          <div class="help">Articles per day. 0 means never publish.</div>
        </div>
        <div class="field">
          <label>Minimum gap between posts</label>
          <div class="row" style="flex-wrap:nowrap">
            <input type="number" name="interval_amount" min="0" step="1" value="${amount}"
                   style="flex:1" />
            <select name="interval_unit" style="width:auto">
              <option value="minutes" ${unit === 'minutes' ? raw('selected') : raw('')}>minutes</option>
              <option value="hours" ${unit === 'hours' ? raw('selected') : raw('')}>hours</option>
              <option value="days" ${unit === 'days' ? raw('selected') : raw('')}>days</option>
            </select>
          </div>
          <div class="help">Any cadence: 20 minutes, 90 minutes, 3 days.</div>
        </div>
      </div>

      <h3>Credentials for this site</h3>
      <div class="field-row">
        ${secretField(
          'api_token',
          'Site API token',
          site?.api_token_encrypted ?? '',
          "The token that lets the platform post articles and upload images to this website. From the site's own admin. Not needed for a social-only account.",
        )}
      </div>

      <button class="primary" type="submit">${site ? 'Save changes' : 'Add site'}</button>
    </form>
  `;
}

/* =========================================================================
 * Keywords
 * ====================================================================== */

export interface KeywordFilterView {
  q: string;
  view: KeywordListView;
  siteId: number;
}

/** Where one keyword stands on one site, for the dots on its row. */
export interface SiteMark {
  domain: string;
  status: 'go' | 'done' | 'no' | 'unlinked';
}

/**
 * The views, in the words someone would use to ask for them.
 *
 * This replaced four dropdowns — keyword status, site, and one labelled "Where
 * it stands there" — whose combinations you had to hold the data model in your
 * head to predict. These are the five questions actually asked of this page.
 */
const VIEWS: { key: KeywordListView; label: string; blurb: string }[] = [
  { key: 'queued', label: 'Will publish', blurb: 'Set to go, with at least one site waiting to take it.' },
  {
    key: 'stuck',
    label: 'Going nowhere',
    blurb:
      'Set to go, but no site is set to go for it — so nothing will ever pick these up. ' +
      'They count as supply on the dashboard and publish nothing.',
  },
  { key: 'done', label: 'Finished', blurb: 'Already published everywhere they were meant to go.' },
  { key: 'off', label: 'Turned off', blurb: 'Set to no. The scheduler ignores them entirely.' },
  { key: 'all', label: 'Everything', blurb: 'Every keyword, whatever state it is in.' },
];

export function keywordsPage(
  keywords: KeywordRow[],
  sites: SiteRow[],
  marks: Map<number, SiteMark[]>,
  page: number,
  total: number,
  matched: number,
  counts: Record<KeywordListView, number>,
  filter: KeywordFilterView,
): Html {
  const pages = Math.max(1, Math.ceil(matched / 100));
  const current = VIEWS.find((v) => v.key === filter.view) ?? VIEWS[4]!;
  const back = `/keywords${pageLink(filter, page)}`;
  const siteName = sites.find((x) => x.id === filter.siteId)?.domain ?? '';

  return html`
    <div class="spread">
      <div>
        <h1>Keywords</h1>
        <p class="subtitle">
          ${total} keyword(s) across ${sites.length} site(s). A keyword publishes on a site when
          both are set to <span class="mono">go</span>.
        </p>
      </div>
      <div class="row wrap" style="gap:8px">
        <a class="button" href="/keywords/check" title="Find waiting keywords that are not one dish">Check the queue</a>
        <a class="button primary" href="/keywords/add">Add keywords</a>
      </div>
    </div>

    <!-- One question, not four fields. -->
    <form method="get" action="/keywords" class="viewbar">
      <div class="viewbar-line">
        <label for="view">Show me</label>
        <select id="view" name="view" onchange="this.form.submit()">
          ${VIEWS.map(
            (v) => html`<option value="${v.key}" ${filter.view === v.key ? raw('selected') : raw('')}>
              ${v.label} (${counts[v.key]})
            </option>`,
          )}
        </select>

        ${filter.siteId ? html`<input type="hidden" name="site" value="${filter.siteId}" />` : raw('')}

        <input type="search" name="q" value="${filter.q}" placeholder="search the words…" />
        <button type="submit">Search</button>
      </div>
      <p class="viewbar-blurb">
        ${current.blurb}
        ${filter.siteId ? html` Limited to <strong>${siteName}</strong>.` : raw('')}
      </p>
    </form>

    ${keywords.length === 0
      ? html`<div class="card">
          ${emptyState(
            filter.q
              ? `Nothing matches “${filter.q}” in this view.`
              : `No keywords are in this state${filter.siteId ? ` on ${siteName}` : ''}.`,
          )}
        </div>`
      : html`
          <!-- Every control below is a verb. The old bar read
               "Status [leave as is] On [all sites] set to [leave as is]",
               which is not a sentence anybody can act on. -->
          <form method="post" action="/keywords/bulk" id="bulk" class="bulkbar">
            <input type="hidden" name="back" value="${back}" />

            <div class="bulk-count">
              <span id="pick-count">0</span> selected
              <span class="muted small" id="pick-hint">— tick a row to act on it</span>
              ${matched > keywords.length
                ? html`<label class="small" style="margin-left:12px;display:inline-flex;gap:6px;align-items:center">
                    <input type="checkbox" name="scope" value="all" id="pick-everything" data-total="${matched}" />
                    Select all <strong>${matched}</strong> in this view (every page)
                  </label>
                  <input type="hidden" name="filter_q" value="${filter.q}" />
                  <input type="hidden" name="filter_view" value="${filter.view}" />
                  <input type="hidden" name="filter_site" value="${filter.siteId || ''}" />`
                : raw('')}
            </div>

            <div class="bulk-actions">
              <div class="bulk-group">
                ${filter.siteId
                  ? html`<input type="hidden" name="site_id" value="${filter.siteId}" />`
                  : html`<select name="site_id" aria-label="Which site these actions apply to">
                  <option value="">every site</option>
                  ${sites.map((x) => html`<option value="${x.id}">${x.domain}</option>`)}
                </select>`}
                <button type="submit" name="action" value="publish-on" class="primary">
                  Publish here
                </button>
                <button type="submit" name="action" value="stop-on">Stop here</button>
              </div>

              <div class="bulk-group">
                <button type="submit" name="action" value="off"
                        title="These keywords are never picked again until switched back on">Turn off</button>
              </div>

              <button type="submit" name="action" value="delete" class="danger" formnovalidate
                      onclick="var n=document.getElementById('pick-count').textContent;return confirm('Delete '+n+' keyword(s)? This cannot be undone.')">
                Delete
              </button>
            </div>
          </form>

          <div class="card table-wrap">
            <table class="kwlist">
              <thead>
                <tr>
                  <th class="pick"><input type="checkbox" id="pick-all" title="Select every row here" /></th>
                  <th>Keyword</th>
                  <th>Where it runs</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${keywords.map((k) => {
                  const row = marks.get(k.id) ?? [];
                  const going = row.filter((m) => m.status === 'go').length;

                  return html`<tr>
                    <td class="pick">
                      <input type="checkbox" form="bulk" name="ids" value="${k.id}" />
                    </td>
                    <td>
                      <a href="/keywords/${k.id}" class="kwtitle"
                        >${k.spy_title || k.seed_keyword}</a
                      >
                      <div class="muted small">
                        <span class="group-chip" title="Topic group — several recipes share this">
                          ${k.seed_keyword}
                        </span>
                        ${k.spy_title
                          ? raw('')
                          : html`<span class="badge error">no article title</span>`}
                      </div>
                    </td>
                    <td>
                      <div class="dots">
                        ${row.map(
                          (m) => html`<span class="dot ${m.status}"
                            title="${m.domain} — ${m.status === 'unlinked' ? 'not linked' : m.status}"
                          ></span>`,
                        )}
                      </div>
                      <div class="muted small">
                        ${k.status !== 'go'
                          ? html`keyword is <strong>${k.status}</strong>`
                          : going > 0
                            ? `${going} site(s) waiting for it`
                            : 'no site is set to go'}
                      </div>
                    </td>
                    <td class="nowrap">
                      <a class="button small" href="/keywords/${k.id}">Open</a>
                    </td>
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>

          <p class="muted small legend">
            <span class="dot go"></span> will publish here
            <span class="dot done"></span> already published
            <span class="dot no"></span> set to no
            <span class="dot unlinked"></span> not linked
            &mdash; hover a dot for the site.
          </p>
        `}

    ${pages > 1
      ? html`<div class="row">
          ${page > 1
            ? html`<a class="button small" href="/keywords${pageLink(filter, page - 1)}">Previous</a>`
            : raw('')}
          <span class="muted small">Page ${page} of ${pages}</span>
          ${page < pages
            ? html`<a class="button small" href="/keywords${pageLink(filter, page + 1)}">Next</a>`
            : raw('')}
        </div>`
      : raw('')}

    ${raw(BULK_SELECTION_SCRIPT)}
  `;
}

function pageLink(filter: KeywordFilterView, page: number): string {
  const params = new URLSearchParams();
  if (filter.q) params.set('q', filter.q);
  if (filter.view && filter.view !== 'all') params.set('view', filter.view);
  if (filter.siteId) params.set('site', String(filter.siteId));
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Row selection, in the smallest amount of script that does the job.
 *
 * The checkboxes sit in the table but belong to the bulk form above it, via
 * the HTML `form` attribute: a form inside a form is invalid. The script keeps
 * the counter honest and greys the bar out until something is ticked, so it
 * stops looking like six decisions you owe it on arrival. Submitting still
 * works with scripting off.
 */
const BULK_SELECTION_SCRIPT = `<script>
(function () {
  var form = document.getElementById('bulk');
  if (!form) return;

  var boxes = Array.prototype.slice.call(document.querySelectorAll('input[name="ids"]'));
  var all = document.getElementById('pick-all');
  var count = document.getElementById('pick-count');
  var hint = document.getElementById('pick-hint');

  var everything = document.getElementById('pick-everything');

  function sync() {
    var picked = 0;
    boxes.forEach(function (box) {
      if (box.checked) picked++;
      var row = box.closest('tr');
      if (row) row.classList.toggle('picked', box.checked);
    });

    // "All N in this view" acts on every page, not just the rows shown.
    if (everything && everything.checked) picked = Number(everything.getAttribute('data-total')) || picked;

    if (count) count.textContent = String(picked);
    if (hint) hint.style.display = picked ? 'none' : '';
    form.classList.toggle('armed', picked > 0);

    if (all) {
      all.checked = picked > 0 && picked === boxes.length;
      all.indeterminate = picked > 0 && picked < boxes.length;
    }
  }

  if (all) {
    all.addEventListener('change', function () {
      boxes.forEach(function (box) { box.checked = all.checked; });
      // On a view longer than one page, the header box means "all of them".
      if (everything) everything.checked = all.checked;
      sync();
    });
  }
  boxes.forEach(function (box) { box.addEventListener('change', function () {
    if (!box.checked && everything) everything.checked = false;
    sync();
  }); });
  if (everything) {
    everything.addEventListener('change', function () {
      boxes.forEach(function (box) { box.checked = everything.checked; });
      sync();
    });
  }
  sync();
})();
</script>`;

/* =========================================================================
 * Adding keywords
 * ====================================================================== */

/**
 * Import moved off the list.
 *
 * It was two large blocks of explanatory text under a table people came to
 * read, which is most of why that page felt like a wall.
 */
export function keywordAddPage(
  sites: { id: number; domain: string }[] = [],
  groups: string[] = [],
  picked = 0,
): Html {
  return html`
    <div class="spread">
      <div>
        <h1>Add keywords</h1>
        <p class="subtitle">Paste a list, or import a spreadsheet.</p>
      </div>
      <a class="button" href="/keywords">Back to keywords</a>
    </div>

    <h2>Paste a list</h2>
    <div class="card">
      <form method="post" action="/keywords/paste">
        <div class="field">
          <label for="paste-lines">Recipes — one per line, as specific as possible</label>
          <textarea id="paste-lines" name="lines" rows="10" required
                    placeholder="Lemon Bars with Shortbread Crust&#10;Creamy Tuscan Chicken Pasta&#10;No-Bake Oreo Cheesecake"></textarea>
          <div class="help">
            Name one dish per line, not a theme: “Chicken Enchiladas with Green Sauce”, not
            “dinner ideas”. Vague lines are rejected later and wasted. Duplicates are skipped.
          </div>
        </div>
        <div class="grid two">
          <div class="field">
            <label for="paste-group">Topic group</label>
            <input id="paste-group" name="seed_keyword" required list="paste-groups" placeholder="dessert" />
            <datalist id="paste-groups">
              ${groups.map((g) => html`<option value="${g}"></option>`)}
            </datalist>
            <div class="help">A short label that files these together, e.g. dessert, chicken, pasta.</div>
          </div>
          <div class="field">
            <label>Publish on</label>
            ${sites.length === 0
              ? html`<div class="muted small">No site yet — add one under Channels → Sites.</div>`
              : sites.map(
                  (site) => html`<label class="inline-check" style="display:block">
                    <input type="checkbox" name="site_ids" value="${site.id}" ${!picked || picked === site.id ? raw('checked') : raw('')} /> ${site.domain}
                  </label>`,
                )}
          </div>
        </div>
        <button class="primary" type="submit">Add keywords</button>
      </form>
    </div>

    <details class="card" style="margin-top:1.5rem">
      <summary><strong>From a spreadsheet</strong> <span class="muted small">— CSV import and export</span></summary>
      <div style="margin-top:10px">
      <p class="muted small" style="margin-top:0">
        Columns: <span class="mono">seed_keyword, spy_title, spy_description, annotation,
        status</span>, then one column per site domain holding
        <span class="mono">go</span>, <span class="mono">done</span> or
        <span class="mono">no</span>. Only <span class="mono">seed_keyword</span> is required.
      </p>
      <form method="post" action="/keywords/import" enctype="multipart/form-data">
        <div class="field"><input type="file" name="file" accept=".csv,text/csv" required /></div>
        <div class="row wrap">
          <button class="primary" type="submit">Import CSV</button>
          <a class="button" href="/keywords/template.csv" download>Download a template</a>
          <a class="button" href="/data/export/keywords" download>Export what is here</a>
        </div>
        <div class="help" style="margin-top:8px">
          The template already has a column for every site you have added. An export uses the same
          columns, so it can be edited in a spreadsheet and imported straight back.
        </div>
      </form>
      </div>
    </details>
  `;
}

/* =========================================================================
 * Settings
 * ====================================================================== */

/** What the image service knows about its models, for the picker. */
export interface ImageModelCatalogue {
  models: {
    key: string;
    label: string;
    wire: string | null;
    discovered: boolean;
    outcome: 'untried' | 'accepted' | 'refused' | 'rejected' | 'unknown';
    at: string | null;
    error: string | null;
  }[];
  discovered: boolean;
  /** What the last scan of the Flow page looked at and found. */
  scan?: {
    at?: string;
    error?: string;
    page?: string;
    inline_scripts?: number;
    fetched?: string[];
    failed?: string[];
    anchor_hits?: Record<string, number>;
    candidates?: string[];
    near?: Record<string, string[]>;
  };
}


/** The three image models Flow offers, in fallback order. Keys match the image service. */
const IMAGE_MODEL_CHOICES = [
  { key: 'NANO_BANANA_PRO', label: 'Nano Banana Pro' },
  { key: 'NANO_BANANA_2', label: 'Nano Banana 2.1' },
  { key: 'NANO_BANANA_2_LITE', label: 'Nano Banana 2 Lite' },
];

/**
 * The image model picker, with what Google last said to each beside it.
 *
 * Two of the three names are known. The third is read off the Flow page by
 * the image service, and a name read off a page is a candidate until Google
 * accepts it -- which Automatic mode never checks, because Nano Banana 2 is
 * unlimited and the walk never reaches a third name. So the verdicts are
 * shown here: pick the third one, run an article, and this line says whether
 * it worked. That is the verification, and it costs one image.
 */
function imageModelPicker(current: string, catalogue: ImageModelCatalogue | null): Html {
  const verdict = (m: ImageModelCatalogue['models'][number]): Html => {
    if (!m.wire) return html`<span class="badge">not found on the Flow page yet</span>`;
    switch (m.outcome) {
      case 'accepted':
        return html`<span class="badge ok">verified</span> <span class="muted small">${m.at ?? ''}</span>`;
      case 'refused':
        return html`<span class="badge warn">refused by Google</span> <span class="muted small">${m.error ?? ''}</span>`;
      case 'rejected':
        return html`<span class="badge error">not a model Flow knows</span>`;
      default:
        return html`<span class="badge">untried</span>`;
    }
  };

  // The three are a fixed set the platform knows; the service only adds what
  // each is called on the wire and what Google said to it. So the picker is
  // always complete, whether or not the service has answered yet.
  const known = new Map((catalogue?.models ?? []).map((m) => [m.key, m]));
  const options = [
    { value: 'auto', label: 'Automatic — Pro first, then the others as fallbacks', disabled: false },
    ...IMAGE_MODEL_CHOICES.map((c) => {
      const m = known.get(c.key);
      const wire = m?.wire ?? null;
      return {
        value: c.key,
        label: wire ? `${c.label} (${wire})` : m && !wire ? `${c.label} — not found yet` : c.label,
        disabled: Boolean(m) && !wire,
      };
    }),
  ];

  return html`
    <div class="field">
      <label for="image_model">Image model</label>
      <select id="image_model" name="image_model">
        ${options.map(
          (o) => html`<option value="${o.value}" ${o.value === current ? raw('selected') : raw('')}
                        ${o.disabled ? raw('disabled') : raw('')}>${o.label}</option>`,
        )}
      </select>
      <div class="help">
        Automatic asks for Nano Banana Pro and falls back when Google refuses it. Pick one to
        use it alone — that is how a model gets verified: choose it, run one image, and its
        line below says what Google answered.
      </div>
    </div>
    ${catalogue
      ? html`<table class="small" style="margin-top:8px">
          <tbody>
            ${catalogue.models.map(
              (m) => html`<tr>
                <td>${m.label}</td>
                <td class="mono muted">${m.wire ?? '—'}${m.discovered ? ' (read off the page)' : ''}</td>
                <td>${verdict(m)}</td>
              </tr>`,
            )}
          </tbody>
        </table>
        ${catalogue.discovered
          ? raw('')
          : html`<p class="small muted" style="margin-top:6px">
              Each model's line fills in when a job has asked for it; nothing has run
              since the last deploy.
            </p>`}
        ${scanReport(catalogue.scan)}`
      : html`<p class="small muted" style="margin-top:6px">
          The image service did not answer, so no verdicts to show. The choice still saves.
        </p>`}
  `;
}

/**
 * What the scan of the Flow page saw, for when the third model is "not found".
 *
 * A scan that finds nothing has to say what it looked at, or the next step is
 * guessing: were the bundles fetched at all, did the known names even appear,
 * what sat near them. This is that, folded up unless someone opens it.
 */
function scanReport(scan: ImageModelCatalogue['scan']): Html {
  if (!scan || (!scan.at && !scan.error)) return raw('');
  const hits = Object.entries(scan.anchor_hits ?? {});
  const near = Object.entries(scan.near ?? {});
  return html`
    <details class="small" style="margin-top:8px">
      <summary class="muted">What the scan of the Flow page saw${scan.at ? html` (${scan.at})` : raw('')}</summary>
      <div style="margin-top:6px">
        ${scan.error ? html`<div class="badge error">${scan.error}</div>` : raw('')}
        ${scan.page ? html`<div>Page: <span class="mono">${scan.page}</span></div>` : raw('')}
        <div>
          Inline scripts: ${String(scan.inline_scripts ?? 0)} ·
          fetched: ${String(scan.fetched?.length ?? 0)} ·
          could not fetch: ${String(scan.failed?.length ?? 0)}
        </div>
        ${hits.length
          ? html`<div>Known names found in the source:
              ${hits.map(([name, n]) => html`<span class="mono">${name}</span>&times;${String(n)} `)}
            </div>`
          : raw('')}
        ${scan.candidates?.length
          ? html`<div>Candidates near every known name:
              <span class="mono">${scan.candidates.join(', ')}</span></div>`
          : html`<div>No token sat near every known name.</div>`}
        ${near.map(
          ([name, tokens]) => html`<div style="margin-top:4px">Near <span class="mono">${name}</span>:
            <span class="mono muted">${tokens.length ? tokens.join(' ') : '—'}</span></div>`,
        )}
        ${scan.failed?.length
          ? html`<div style="margin-top:4px">Could not fetch:
              <div class="mono muted">${scan.failed.map((f) => html`${f}<br />`)}</div></div>`
          : raw('')}
      </div>
    </details>
  `;
}

/** The Serper keys: one row each, the one in use marked, and a box to add more (one per line). */
function serperPanel(stored: string, active: number): Html {
  const keys = stored.split(/[\s,;]+/).map((k) => k.trim()).filter(Boolean);
  const mask = (k: string) => (k.length > 10 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '••••');
  const inUse = keys.length ? active % keys.length : -1;
  return html`
    <p class="small" style="margin-top:0">
      Get a free key (2,500 searches per account):
      <a href="https://serper.dev/signup" target="_blank" rel="noopener"><strong>serper.dev/signup</strong></a>
      → sign in → <em>API Key</em> → copy. Several accounts = several keys: when one runs out the next takes over,
      and searching goes on from that key.
    </p>
    ${keys.length
      ? html`<div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Key</th><th>State</th><th></th></tr></thead>
          <tbody>${keys.map(
            (k, i) => html`<tr>
              <td class="muted">${i + 1}</td>
              <td class="mono">${mask(k)}</td>
              <td>${i === inUse ? html`<span class="badge ok">in use</span>` : i < inUse ? html`<span class="badge muted">used up</span>` : html`<span class="badge muted">waiting</span>`}</td>
              <td class="nowrap">
                ${i === inUse ? raw('') : html`<button type="submit" class="small" formaction="/settings/serper/${i}/use" formnovalidate>Use now</button>`}
                <button type="submit" class="small danger" formaction="/settings/serper/${i}/remove" formnovalidate
                        onclick="return confirm('Remove this key?')">Remove</button>
              </td>
            </tr>`,
          )}</tbody>
        </table></div>`
      : html`<p class="muted small">No key yet — research works with Google Autocomplete only.</p>`}
    <div class="field" style="margin-top:12px">
      <label>Add keys — one per line</label>
      <textarea name="serper_new" rows="3" placeholder="paste keys here, one per line"></textarea>
    </div>
    <button type="submit" class="small" formaction="/settings/serper/add">Add keys</button>
  `;
}

export function settingsPage(
  specs: SettingSpec[],
  values: Map<string, string>,
  problems: string[],
  imageModels: ImageModelCatalogue | null = null,
): Html {
  const groups: {
    key: SettingSpec['group'];
    title: string;
    blurb?: string;
    /** Rendered inside the card after the fields: links or a picker. */
    footer?: Html;
  }[] = [
    { key: 'general', title: 'General', blurb: 'The main switch.' },
    {
      key: 'schedule',
      title: 'Schedule',
      blurb: 'How often the platform checks for work, and how long one article may take.',
    },
    { key: 'retry', title: 'Retries', blurb: 'What happens when an article fails.' },
    {
      key: 'llm',
      title: 'Google research (Serper)',
      blurb: 'Google results for Content → Research, and for the facts each recipe is written from.',
      footer: serperPanel(values.get('serper_api_key') ?? '', Number(values.get('serper_key_index')) || 0),
    },
    {
      key: 'images',
      title: 'Image generation',
      blurb: 'Images are generated in Google Flow through the browser under Setup → Browser.',
      footer: imageModelPicker(values.get('image_model') ?? 'auto', imageModels),
    },
    { key: 'buffer', title: 'Pinterest (Buffer)', blurb: 'A pin for every article, scheduled through Buffer.' },
    {
      key: 'facebook',
      title: 'Facebook',
      // The tokens and pages live on their own page: they are tables, not
      // fields, and the switch here is the only thing about Facebook that
      // belongs in a settings form.
      footer: html`
        <div class="row wrap field-links">
          <a class="button primary" href="/accounts#facebook-pages">Tokens &amp; pages</a>
        </div>
      `,
    },
    { key: 'telegram', title: 'Telegram', blurb: 'Messages to your phone when something needs you.' },
  ];

  return html`
    <h1>General</h1>
    <p class="subtitle">
      How the platform behaves. Every change applies as soon as you save.
    </p>

    ${problems.length
      ? html`<div class="flash warn">
          <strong>Not ready to run</strong>
          <ul>${problems.map((p) => html`<li>${p}</li>`)}</ul>
        </div>`
      : html`<div class="flash ok">Configuration is complete.</div>`}

    <form method="post" action="/settings">
      ${(() => {
        // Hidden settings still resolve, still take their environment
        // override, and are still saved if something submits them. They are
        // simply not questions worth putting to anybody.
        const render = (group: (typeof groups)[number]) => {
          const fields = specs.filter((s) => s.group === group.key && !s.hidden);
          if (fields.length === 0 && !group.footer) return raw('');
          return html`
            <h2>${group.title}</h2>
            ${group.blurb ? html`<p class="subtitle">${group.blurb}</p>` : raw('')}
            <div class="card">
              ${fields.map((spec) => settingField(spec, values.get(spec.key) ?? ''))}
              ${group.footer ?? raw('')}
            </div>
          `;
        };
        // Timing and retry knobs work as shipped; they stay reachable but out of the way.
        const ADVANCED = ['schedule', 'retry'];
        return html`
          ${groups.filter((g) => !ADVANCED.includes(g.key)).map(render)}
          <details style="margin-top:1.5rem">
            <summary><strong>Advanced</strong> <span class="muted small">— scheduler timing and retries; the defaults are fine</span></summary>
            ${groups.filter((g) => ADVANCED.includes(g.key)).map(render)}
          </details>
        `;
      })()}

      <!-- Last thing on the page, deliberately: nothing should sit below the
           button that saves the form above it. -->
      <div class="save-bar">
        <button class="primary" type="submit">Save settings</button>
        <span class="muted small">Applies immediately. No restart.</span>
      </div>
    </form>
  `;
}

export function keysPage(endpoints: Endpoint[], baseUrl: string): Html {
  return html`
    <h1>LLM API keys</h1>
    <p class="subtitle">
      The API keys the article writer uses, all from <span class="mono">${baseUrl}</span>.
      More keys means more articles per hour: when one key hits its limit, the
      next one is used. Keys do not choose the model &mdash; that is under Prompts.
    </p>

    <div class="card table-wrap">
      ${endpoints.length === 0
        ? emptyState('No API keys yet. Nothing can be generated until you add at least one.')
        : html`<table>
            <thead>
              <tr><th>Name</th><th>Health</th><th>Last success</th><th>Last error</th><th></th></tr>
            </thead>
            <tbody>
              ${endpoints.map(
                (e) => html`<tr>
                  <td>
                    <strong>${e.name}</strong>
                    ${e.enabled ? raw('') : html` <span class="badge muted">disabled</span>`}
                    ${e.models.length
                      ? html`<div class="muted small">only: ${e.models.join(', ')}</div>`
                      : raw('')}
                  </td>
                  <td>
                    ${e.healthy
                      ? html`<span class="badge ok">healthy</span>`
                      : html`<span class="badge error">unhealthy</span>`}
                    ${e.consecutiveFails > 0
                      ? html`<div class="muted small">${e.consecutiveFails} consecutive failure(s)</div>`
                      : raw('')}
                    ${e.cooldownUntil && e.cooldownUntil > new Date()
                      ? html`<div class="muted small">cooling down</div>`
                      : raw('')}
                  </td>
                  <td class="muted small nowrap">${timeAgo(e.lastSuccessAt)}</td>
                  <td class="muted small">${e.lastError ? e.lastError.slice(0, 80) : '—'}</td>
                  <td class="nowrap">
                    <form method="post" action="/settings/endpoints/${e.id}/reset" style="display:inline">
                      <button class="small" type="submit">Reset</button>
                    </form>
                    <form method="post" action="/settings/endpoints/${e.id}/delete" style="display:inline"
                          onsubmit="return confirm('Delete key ${e.name}?')">
                      <button class="small danger" type="submit">&times;</button>
                    </form>
                  </td>
                </tr>`,
              )}
            </tbody>
          </table>`}
    </div>

    <h2>Add several at once</h2>
    <div class="card">
      <form method="post" action="/settings/endpoints/bulk">
        <div class="field">
          <label for="keys">One key per line</label>
          <textarea id="keys" name="keys" rows="8" required
                    placeholder="paste keys here, one per line"></textarea>
          <div class="help">
            Names are generated for you &mdash; <span class="mono">key-01</span>,
            <span class="mono">key-02</span> and so on, continuing from what is
            already here. To name one yourself, write
            <span class="mono">label = key</span> or
            <span class="mono">label, key</span> on that line. Blank lines and
            lines starting with <span class="mono">#</span> are ignored, and a key
            already stored is skipped rather than duplicated.
          </div>
        </div>
        <button class="primary" type="submit">Add keys</button>
      </form>
    </div>

    <h2>Add one</h2>
    <div class="card">
      <form method="post" action="/settings/endpoints">
        <div class="field-row">
          <div class="field">
            <label>Label</label>
            <input type="text" name="name" required placeholder="key-01" />
            <div class="help">Any name. Reusing one replaces that key.</div>
          </div>
          <div class="field">
            <label>API key</label>
            <input type="password" name="api_key" required autocomplete="new-password"
                   placeholder="paste the key" />
            <div class="help">Stored encrypted. Never displayed again.</div>
          </div>
        </div>
        <details>
          <summary class="muted small">Advanced</summary>
          <div class="field-row" style="margin-top:10px">
            <div class="field">
              <label>Restrict to models</label>
              <input type="text" name="models" placeholder="leave blank for all models" />
              <div class="help">Leave blank. Only if this key may not be used for some models.</div>
            </div>
            <div class="field">
              <label>Override base URL</label>
              <input type="text" name="base_url" placeholder="leave blank to use the shared URL" />
              <div class="help">Leave blank unless this key belongs to a different provider.</div>
            </div>
          </div>
        </details>
        <button class="primary" type="submit">Add key</button>
      </form>
    </div>
  `;
}

export function accountPage(usingGenerated: boolean): Html {
  return html`
    <h1>Password</h1>
    <p class="subtitle">
      One password protects the whole platform: every site token, every API key,
      and a browser signed in to Google.
    </p>

    ${usingGenerated
      ? html`<div class="flash warn">
          You are still on the password generated at first boot. It is printed in
          the container logs on every start, so anyone who can read those can sign
          in. Set your own below.
        </div>`
      : html`<div class="flash ok">A chosen password is in use.</div>`}

    <div class="card" style="max-width:520px">
      <form method="post" action="/settings/account">
        <div class="field">
          <label for="current">Current password</label>
          <input type="password" id="current" name="current" required
                 autocomplete="current-password" />
        </div>
        <div class="field">
          <label for="next">New password</label>
          <input type="password" id="next" name="next" required minlength="10"
                 autocomplete="new-password" />
          <div class="help">At least 10 characters.</div>
        </div>
        <div class="field">
          <label for="confirm">New password again</label>
          <input type="password" id="confirm" name="confirm" required minlength="10"
                 autocomplete="new-password" />
        </div>
        <button class="primary" type="submit">Change password</button>
      </form>
    </div>

    <p class="muted small" style="margin-top:14px">
      Once set, the generated password stops working. Forgotten it? Set
      <span class="mono">AUTH_PASSWORD</span> in the deployment environment and
      restart — that takes over again until you choose a new one here.
    </p>
  `;
}

function settingField(spec: SettingSpec, value: string): Html {
  const isBool = spec.default === 'true' || spec.default === 'false';

  if (isBool) {
    return html`<div class="field">
      <label>${spec.label}</label>
      <select name="${spec.key}">
        <option value="true" ${value === 'true' ? raw('selected') : raw('')}>enabled</option>
        <option value="false" ${value !== 'true' ? raw('selected') : raw('')}>disabled</option>
      </select>
      ${spec.help ? html`<div class="help">${spec.help}</div>` : raw('')}
    </div>`;
  }

  const type = spec.type === 'number' ? 'number' : spec.secret ? 'password' : 'text';
  const placeholder = spec.secret && value ? 'saved — leave blank to keep' : spec.default;

  return html`<div class="field">
    <label>${spec.label}</label>
    <input type="${type}" name="${spec.key}" placeholder="${placeholder}"
           ${type === 'number' ? raw('step="any" min="0"') : raw('')}
           value="${spec.secret ? '' : value}" />
    ${spec.help ? html`<div class="help">${spec.help}</div>` : raw('')}
  </div>`;
}

/* =========================================================================
 * Events
 * ====================================================================== */

export function eventsPage(events: EventRow[]): Html {
  return html`
    <h1>Events</h1>
    <p class="subtitle">
      A log of technical problems and what the scheduler did. If an article failed
      and its page did not say enough, the reason is usually here.
    </p>
    <div class="card table-wrap">
      ${events.length === 0
        ? emptyState('Nothing logged yet.')
        : html`<table>
            <thead><tr><th>When</th><th>Level</th><th>Source</th><th>Message</th></tr></thead>
            <tbody>
              ${events.map(
                (e) => html`<tr>
                  <td class="nowrap muted small">${timeAgo(e.created_at)}</td>
                  <td>${statusBadge(e.level === 'error' ? 'failed' : e.level === 'warn' ? 'pending' : 'ok')}</td>
                  <td class="muted small">${e.source}</td>
                  <td class="small">${e.message}</td>
                </tr>`,
              )}
            </tbody>
          </table>`}
    </div>
  `;
}

/* =========================================================================
 * Prompts
 * ====================================================================== */

export interface PromptSummary {
  /** File name, e.g. "part-1.user.txt". */
  file: string;
  /** Prompt it belongs to, e.g. "part-1". */
  prompt: string;
  /** "system", "user", or "template". */
  half: string;
  model: string;
  edited: boolean;
  lines: number;
}

export interface ModelChoice {
  prompt: string;
  shipped: string;
  effective: string;
  overridden: boolean;
}

export function promptsPage(
  prompts: PromptSummary[],
  models: ModelChoice[],
  knownModels: string[],
): Html {
  const byPrompt = new Map<string, PromptSummary[]>();
  for (const p of prompts) {
    const list = byPrompt.get(p.prompt) ?? [];
    list.push(p);
    byPrompt.set(p.prompt, list);
  }

  const editedCount = prompts.filter((p) => p.edited).length;

  return html`
    <h1>Prompts</h1>
    <p class="subtitle">
      The instructions the AI follows at each step. Editing them changes how
      articles are written. Every edit is saved and the original is always there
      to go back to; the last ${PROMPT_VERSIONS_KEPT} saves of each are
      kept so you can go back to this morning rather than all the way.
    </p>
    <p class="subtitle">
      Each prompt is sent to one AI model, chosen here. A bigger model writes
      better and costs more; API keys have nothing to do with this choice.
    </p>
    <div class="flash ok">The Pinterest graphic's design is no longer here: it has its own page,
      <a href="/settings/pin-designs">Setup → Pin designs</a>, with several designs that take turns.</div>

    ${editedCount > 0
      ? html`<div class="flash ok">
          ${editedCount} prompt file(s) edited. The rest are exactly as shipped.
        </div>`
      : raw('')}

    <datalist id="known-models">
      ${knownModels.map((m) => html`<option value="${m}"></option>`)}
    </datalist>

    ${[...byPrompt.entries()].map(([name, parts]) => {
      const choice = models.find((m) => m.prompt === name);
      return html`
        <div class="card">
          <div class="spread">
            <div>
              <strong>${name}</strong>
              ${parts.some((p) => p.edited)
                ? html` <span class="badge ok">edited</span>`
                : raw('')}
              ${choice?.overridden ? html` <span class="badge brand">custom model</span>` : raw('')}
            </div>
            <div class="row wrap">
              ${parts.map(
                (p) => html`<a class="button small" href="/settings/prompts/${p.file}"
                  >${p.half} &middot; ${p.lines} lines</a
                >`,
              )}
            </div>
          </div>

          ${choice
            ? html`<form method="post" action="/settings/prompts/model" class="row wrap"
                    style="margin-top:10px">
                  <input type="hidden" name="prompt" value="${name}" />
                  <label for="model-${name}" class="muted small" style="margin:0">Model</label>
                  <input type="text" id="model-${name}" name="model" list="known-models"
                         value="${choice.overridden ? choice.effective : ''}"
                         placeholder="${choice.shipped}" style="width:auto;min-width:200px" />
                  <button class="small" type="submit">Set</button>
                  ${choice.overridden
                    ? html`<span class="muted small">
                        shipped default is <span class="mono">${choice.shipped}</span> &mdash;
                        clear the box and press Set to go back to it
                      </span>`
                    : raw('')}
                </form>`
            : raw('')}
        </div>
      `;
    })}
  `;
}

/** Mirrors PROMPT_VERSION_LIMIT in repos.ts, for the copy above. */
export const PROMPT_VERSIONS_KEPT = 20;

export function promptEditPage(
  file: string,
  body: string,
  options: {
    model: string;
    variables: string[];
    unknown: string[];
    edited: boolean;
    shipped: string;
    versions: { id: number; created_at: string; body: string }[];
  },
): Html {
  return html`
    <div class="spread">
      <div>
        <h1>${file}</h1>
        <p class="subtitle">
          ${options.model ? html`Sent to <span class="mono">${options.model}</span>. ` : raw('')}
          ${options.edited
            ? 'Edited — the shipped version is still available below.'
            : 'Exactly as shipped.'}
        </p>
      </div>
      <a class="button" href="/settings/prompts">All prompts</a>
    </div>

    ${options.unknown.length
      ? html`<div class="flash warn">
          <strong>Unknown placeholder(s):</strong>
          <span class="mono">${options.unknown.join(', ')}</span>
          <div class="small" style="margin-top:6px">
            Nothing supplies these, so they render as empty text rather than
            failing &mdash; the article just quietly comes out worse. Use one of
            the variables listed below, or add it to the step that renders this
            prompt.
          </div>
        </div>`
      : raw('')}

    <div class="card">
      <form method="post" action="/settings/prompts/${file}">
        <div class="field">
          <textarea name="body" rows="24" spellcheck="false"
                    class="mono" style="width:100%">${body}</textarea>
        </div>
        <div class="row">
          <button class="primary" type="submit">Save</button>
          ${options.edited
            ? html`<button class="danger" type="submit" name="action" value="revert"
                     formnovalidate
                     onclick="return confirm('Discard your edit and restore the shipped prompt?')">
                Revert to shipped
              </button>`
            : raw('')}
        </div>
      </form>
    </div>

    <h2>Variables you can use</h2>
    <div class="card">
      ${options.variables.length === 0
        ? html`<p class="muted small">
            No variable list is defined for this file, so placeholders are not checked here.
          </p>`
        : html`<p class="muted small">
              Write them as <span class="mono">{{name}}</span>. Nothing else is
              interpreted &mdash; no expressions, no conditionals.
            </p>
            <div class="row wrap">
              ${options.variables.map((v) => html`<span class="badge muted mono">${v}</span>`)}
            </div>`}
    </div>

    ${options.versions.length
      ? html`<h2>Earlier versions</h2>
          <p class="subtitle">
            Every save is kept, newest first, up to ${PROMPT_VERSIONS_KEPT}. Restoring one puts
            its text in the editor as a new save &mdash; nothing is lost by trying.
          </p>
          ${options.versions.map(
            (version) => html`
              <div class="card">
                <div class="spread">
                  <div>
                    <strong>Saved ${timeAgo(version.created_at)}</strong>
                    <div class="muted small">
                      ${version.body.split('\n').length} lines, ${version.body.length} characters
                      ${version.body === body ? html` &middot; this is what is live now` : raw('')}
                    </div>
                  </div>
                  <div class="row">
                    <form method="post" action="/settings/prompts/${file}/restore">
                      <input type="hidden" name="version" value="${version.id}" />
                      <button class="small" type="submit"
                              ${version.body === body ? raw('disabled') : raw('')}>
                        Restore
                      </button>
                    </form>
                  </div>
                </div>
                <details>
                  <summary class="muted small">What changed from what is live</summary>
                  ${diffBlock(version.body, body)}
                </details>
              </div>
            `,
          )}`
      : raw('')}

    ${options.edited
      ? html`<h2>As shipped</h2>
          <div class="card">
            <pre class="mono small" style="white-space:pre-wrap;margin:0">${options.shipped}</pre>
          </div>`
      : raw('')}
  `;
}

/**
 * A line-level diff, shown as removed-then-added blocks.
 *
 * Not a real diff algorithm — the useful question here is "which lines are in
 * one and not the other", and for prompt text that is a set comparison. A
 * proper LCS diff would be a dependency and several hundred lines for a
 * marginally nicer rendering of a page that is read rarely.
 */
function diffBlock(older: string, newer: string): Html {
  const oldLines = older.split('\n');
  const newLines = newer.split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  const removed = oldLines.filter((line) => line.trim() && !newSet.has(line));
  const added = newLines.filter((line) => line.trim() && !oldSet.has(line));

  if (removed.length === 0 && added.length === 0) {
    return html`<p class="muted small">Identical to what is live.</p>`;
  }

  return html`<div class="diff">
    ${removed.map((line) => html`<div class="del">- ${line}</div>`)}
    ${added.map((line) => html`<div class="add">+ ${line}</div>`)}
  </div>`;
}

/* =========================================================================
 * One keyword: why it is or is not publishing
 * ====================================================================== */

export function keywordDetailPage(
  keyword: KeywordRow,
  diagnosis: KeywordDiagnosis,
  runs: RunListRow[],
  shares: Map<number, boolean>,
  images: SharedImageInfo | undefined,
  counts: KeywordImageCounts,
  siblings: KeywordRow[],
): Html {
  return html`
    <div class="spread">
      <div>
        <!-- A spy title can run to a couple of hundred characters, so a long
             one is clamped rather than allowed to become the whole page. -->
        <h1 class="${(keyword.spy_title || '').length > 70 ? 'long' : ''}"
            title="${keyword.spy_title || keyword.seed_keyword}">
          ${keyword.spy_title || keyword.seed_keyword}
        </h1>
      </div>
      <div class="row">
        <a class="button" href="/keywords">All keywords</a>
      </div>
    </div>

    ${keyword.spy_title.trim()
      ? raw('')
      : html`<div class="flash error">
          <strong>This keyword has no article title</strong>
          <div class="small" style="margin-top:6px">
            Only the topic group describes it, and a topic group covers many different
            recipes &mdash; so there is nothing here to say which dish to write. Runs for this
            keyword are refused rather than producing another copy of whatever else is in
            &ldquo;${keyword.seed_keyword}&rdquo;. Fill in
            <span class="mono">spy_title</span> and re-import.
          </div>
        </div>`}

    ${groupCard(keyword, siblings)}

    <div class="flash ${diagnosis.readyCount > 0 ? 'ok' : 'warn'}">${diagnosis.summary}</div>

    <h2>Is this keyword in use?</h2>
    <div class="card">
      <form method="post" action="/keywords/${keyword.id}/status" class="row wrap">
        ${(
          [
            ['go', 'Use it', 'The scheduler may pick this up.'],
            ['done', 'Finished', 'Published everywhere it was meant to go.'],
            ['no', 'Turned off', 'Never pick this up.'],
          ] as const
        ).map(
          ([value, label, why]) => html`
            <label class="choice ${keyword.status === value ? 'on' : ''}">
              <input type="radio" name="status" value="${value}"
                     ${keyword.status === value ? raw('checked') : raw('')}
                     onchange="this.form.submit()" />
              <span><strong>${label}</strong><span class="muted small">${why}</span></span>
            </label>
          `,
        )}
      </form>
    </div>

    <h2>Which sites should publish it?</h2>
    <p class="subtitle">
      One row per site, with the reason it can or cannot run right now. This is the same
      information the scheduler uses when it decides.
    </p>

    <div class="card table-wrap">
      ${diagnosis.sites.length === 0
        ? emptyState('No sites yet, so there is nowhere for this to publish.')
        : html`<table>
            <thead>
              <tr><th>Site</th><th>Should it run here?</th><th>Images</th><th>Right now</th></tr>
            </thead>
            <tbody>
              ${diagnosis.sites.map((verdict) => {
                const linked = verdict.link !== 'unlinked';
                const shared = shares.get(verdict.siteId) ?? true;

                return html`<tr>
                  <td>
                    <a href="/sites/${verdict.siteId}" class="mono">${verdict.domain}</a>
                  </td>
                  <td>
                    <form method="post" action="/keywords/${keyword.id}/link" class="row">
                      <input type="hidden" name="site_id" value="${verdict.siteId}" />
                      <input type="hidden" name="share_images" value="${shared ? '1' : '0'}" />
                      <select name="status" onchange="this.form.submit()">
                        <option value="go" ${verdict.link === 'go' ? raw('selected') : raw('')}>
                          yes — publish here
                        </option>
                        <option value="done" ${verdict.link === 'done' ? raw('selected') : raw('')}>
                          already published here
                        </option>
                        <option value="no"
                                ${verdict.link === 'no' || !linked ? raw('selected') : raw('')}>
                          no — skip this site
                        </option>
                      </select>
                    </form>
                  </td>
                  <td>
                    ${verdict.link === 'go' || verdict.link === 'done'
                      ? html`<form method="post" action="/keywords/${keyword.id}/link" class="row">
                          <input type="hidden" name="site_id" value="${verdict.siteId}" />
                          <input type="hidden" name="status" value="${verdict.link}" />
                          <label class="muted small"
                                 title="Reuse the article images another site already made for this keyword. The Pinterest graphic is always made fresh.">
                            <input type="checkbox" name="share_images" value="1"
                                   ${shared ? raw('checked') : raw('')}
                                   onchange="this.form.submit()" />
                            reuse
                          </label>
                        </form>`
                      : html`<span class="muted small">—</span>`}
                  </td>
                  <td class="small">
                    ${verdict.ready
                      ? html`<span class="badge ok">ready</span> ${verdict.reason}`
                      : verdict.reason}
                    ${verdict.blocked
                      ? html`<form method="post"
                                   action="/keywords/${keyword.id}/unblock/${verdict.siteId}"
                                   style="margin-top:6px">
                          <button class="small" type="submit"
                                  title="Offer this pair again on the next check">
                            Put it back in the running
                          </button>
                        </form>`
                      : raw('')}
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>`}
    </div>

    ${imagesSection(keyword, images, counts)}

    <h2>Its runs</h2>
    <div class="card table-wrap">
      ${runs.length === 0 ? emptyState('This keyword has never run.') : runTable(runs)}
    </div>

    <h2>What was imported</h2>
    <div class="card">
      <dl class="facts">
        <dt>Spy title</dt><dd>${keyword.spy_title || '—'}</dd>
        <dt>Spy description</dt><dd>${keyword.spy_description || '—'}</dd>
        <dt>Annotation</dt><dd>${keyword.annotation || '—'}</dd>
        <dt>Source URL</dt>
        <dd>
          ${keyword.spy_article_url
            ? html`<a href="${keyword.spy_article_url}" target="_blank" rel="noopener"
                >${keyword.spy_article_url}</a
              >`
            : '—'}
        </dd>
      </dl>
      <form method="post" action="/keywords/${keyword.id}/delete" style="margin-top:14px"
            onsubmit="return confirm('Delete this keyword? Its run history stays but is detached.')">
        <button class="danger small" type="submit">Delete this keyword</button>
      </form>
    </div>
  `;
}

/**
 * The topic group, stated as a label rather than an identity.
 *
 * Spying on one topic yields five or ten different recipes under it, so the
 * seed keyword is shared and means "where I found this", not "what this is".
 * Naming the siblings makes that concrete, and makes it obvious at a glance if
 * two of them are drifting towards the same article.
 */
function groupCard(keyword: KeywordRow, siblings: KeywordRow[]): Html {
  return html`
    <div class="card groupcard">
      <div>
        <span class="muted small">Topic group</span>
        <div>
          <span class="group-chip big">${keyword.seed_keyword}</span>
          <span class="muted small">
            &mdash; a research label, not the subject. The article is written from the title,
            description and notes below it.
          </span>
        </div>
      </div>

      ${siblings.length > 0
        ? html`<div style="margin-top:12px">
            <span class="muted small">
              ${siblings.length} other recipe(s) found under the same label. Each is its own
              keyword with its own article and its own images:
            </span>
            <div class="row wrap" style="margin-top:8px">
              ${siblings.map(
                (other) => html`<a class="button small" href="/keywords/${other.id}"
                  >${other.spy_title || `#${other.id}`}</a
                >`,
              )}
            </div>
          </div>`
        : html`<div class="muted small" style="margin-top:10px">
            The only recipe under this label so far.
          </div>`}
    </div>
  `;
}

/**
 * Which images this keyword owns, and what it has cost.
 *
 * "Only four article images but ten Pinterest ones" is the correct behaviour
 * of the sharing design, and it looks exactly like a bug until you can see the
 * arithmetic: four article images are generated once per *keyword* and copied
 * to every site it runs on, while the Pinterest graphic is generated once per
 * *site* because it is the asset that has to be unique.
 *
 * Showing the actual URLs matters more than the explanation. Two keywords
 * displaying two different sets is the only thing that really answers "are
 * these being shared across keywords?".
 */
function imagesSection(
  keyword: KeywordRow,
  images: SharedImageInfo | undefined,
  counts: KeywordImageCounts,
): Html {

  return html`
    <h2>Its images</h2>

    <div class="grid">
      <div class="stat">
        <div class="value">${counts.articleGenerated}</div>
        <div class="label">Article images made</div>
        <div class="muted small">
          ${counts.generatedRuns === 0
            ? 'none yet'
            : counts.generatedRuns === 1
              ? 'four, made once and reused'
              : `${counts.generatedRuns} sets of four — regenerated since`}
        </div>
      </div>
      <div class="stat">
        <div class="value">${counts.copiedRuns}</div>
        <div class="label">Sites that copied them</div>
        <div class="muted small">no call to Google</div>
      </div>
      <div class="stat ${counts.pinsFailed > 0 ? 'supply-low' : ''}">
        <div class="value">${counts.pinsMade}</div>
        <div class="label">Pinterest graphics made</div>
        <div class="muted small">
          one per site, never shared${counts.pinsFailed > 0
            ? `, ${counts.pinsFailed} attempt(s) failed`
            : ''}
        </div>
      </div>
    </div>

    <div class="card">
      ${images
        ? html`
            <p class="muted small" style="margin-top:0">
              These four belong to this keyword alone. They were made on
              <strong>${images.sourceDomain ?? 'a site that has since been removed'}</strong>
              ${timeAgo(images.createdAt)}, and
              ${images.reusedBy === 0
                ? 'no other site has copied them yet'
                : `${images.reusedBy} other site(s) copied them instead of asking Google again`}.
              Open another keyword and you will see a different set &mdash; the store is keyed by
              keyword, so one keyword&rsquo;s images can never be handed to another.
            </p>
            <div class="shots">
              ${(
                [
                  ['Hero', images.hero],
                  ['First method shot', images.stepA],
                  ['Second method shot', images.stepB],
                  ['Third method shot', images.stepC],
                ] as const
              ).map(
                ([label, url]) => html`
                  <a class="shot" href="${url}" target="_blank" rel="noopener">
                    <img src="${url}" alt="${label} for ${keyword.seed_keyword}" loading="lazy" />
                    <span>${label}</span>
                  </a>
                `,
              )}
            </div>
            <form method="post" action="/keywords/${keyword.id}/images/clear" style="margin-top:14px"
                  onsubmit="return confirm('Forget these? The next site to publish this keyword will generate a new set.')">
              <button class="danger small" type="submit">Forget these and make new ones</button>
            </form>
          `
        : html`<p class="muted small" style="margin:0">
            No image set stored for this keyword yet. The first site to publish it generates four
            and records them here; every site after that copies them, unless you have turned
            <span class="mono">reuse</span> off for that site above.
          </p>`}
    </div>
  `;
}

/* =========================================================================
 * Reels
 * ====================================================================== */

/** The four article images, as the generate-images step recorded them. */
export interface ReelImages {
  hero: string;
  stepA: string;
  stepB: string;
  stepC: string;
}

export interface ReelsPageData {
  candidates: (ReelCandidate & { images: ReelImages | null })[];
  reels: ReelView[];
  configured: boolean;
  enabled: boolean;
  pages: number;
  /** Every Facebook page, for publishing a reel its site has no page for. */
  fbPages: FbPageRow[];
  /** The site filter: every site, and the one shown (0: all). */
  filterSites?: { id: number; domain: string }[];
  site?: number;
}

const REEL_STATE: Record<string, { label: string; badge: string }> = {
  draft: { label: 'Draft', badge: 'pending' },
  generating: { label: 'Generating', badge: 'pending' },
  ready: { label: 'Ready to review', badge: 'ok' },
  publishing: { label: 'Publishing', badge: 'pending' },
  published: { label: 'Published', badge: 'ok' },
  failed: { label: 'Failed', badge: 'failed' },
};

/** An absolute URL for an image the site published. */
const onSite = (domain: string | null, path: string): string =>
  /^https?:\/\//i.test(path) ? path : `https://${(domain ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '')}${path}`;

/**
 * One reel, as a tile.
 *
 * A tile rather than a table row: the thing being judged here is a video and
 * four photographs, and a table forces that into a column narrow enough to
 * wrap a title onto four lines while a 9:16 preview stretches the row past the
 * height of a screen. Tiles let the media be the size it needs to be and the
 * text sit under it.
 */

/**
 * Publish a ready reel: straight to its page, or -- when its site has no
 * page -- to a page picked here and now. Picking one publishes to it and
 * remembers it on the reel; it does not change the page's site.
 */
export function publishControls(reel: ReelView, pages: FbPageRow[]): Html {
  if (reel.status !== 'ready') return raw('');
  if (reel.fb_page_id) {
    return html`<form method="post" action="/reels/${reel.id}/publish">
      <button class="primary" type="submit">Publish</button>
    </form>`;
  }
  const enabled = pages.filter((p) => p.enabled === 1);
  if (enabled.length === 0) {
    return html`<a class="button" href="/accounts#facebook-pages">Add a Facebook page first</a>`;
  }
  return html`<form method="post" action="/reels/${reel.id}/publish" class="row wrap">
    <select name="page_id" required>
      <option value="">Pick a page…</option>
      ${enabled.map((p) => html`<option value="${p.id}">${p.name || p.page_id}</option>`)}
    </select>
    <button class="primary" type="submit">Publish</button>
  </form>`;
}

function reelTile(reel: ReelView, fbPages: FbPageRow[]): Html {
  const state = REEL_STATE[reel.status] ?? { label: reel.status, badge: 'pending' };
  const live = reel.fb_video_id ? `https://www.facebook.com/reel/${reel.fb_video_id}` : '';

  return html`
    <article class="tile">
      <div class="tile-media">
        ${reel.output_path
          ? html`<video src="/reels/${reel.id}/video" controls muted playsinline preload="metadata"></video>`
          : reel.video_url
          ? html`<video src="${reel.video_url}" controls muted playsinline preload="metadata"></video>`
          : html`<div class="tile-placeholder">
              ${reel.status === 'generating' ? 'Generating…' : 'No video yet'}
            </div>`}
      </div>

      <div class="tile-body">
        <div class="row wrap">
          <input type="checkbox" name="ids" value="${reel.id}" form="bulk-reels" aria-label="Select" />
          ${statusBadge(state.badge)}<span class="small">${state.label}</span>
        </div>

        <div class="tile-title">
          <a href="/reels/${reel.id}">${reel.run_title ?? '(untitled)'}</a>
        </div>
        <div class="help">
          ${reel.site_domain ?? ''} &middot; ${reel.seed_keyword ?? ''}
        </div>
        <div class="help">
          ${reel.page_name
            ? html`To <strong>${reel.page_name}</strong>`
            : html`This site has no Facebook page &mdash; pick one below, or give a page this site under
                <a href="/accounts#facebook-pages">Channels &rarr; Facebook</a>`}
        </div>

        ${reel.error
          ? html`<div class="tile-error small">
              ${reel.error.length > 200 ? html`${reel.error.slice(0, 200)}…` : html`${reel.error}`}
              <a href="/reels/${reel.id}">Full report</a>
            </div>`
          : raw('')}

        <div class="row wrap tile-actions">
          ${publishControls(reel, fbPages)}
          ${reel.status === 'failed'
            ? html`<form method="post" action="/reels/${reel.id}/retry">
                <button type="submit">Retry</button>
              </form>`
            : raw('')}
          ${live ? html`<a class="button" href="${live}" target="_blank" rel="noopener">View</a>` : raw('')}
          <form method="post" action="/reels/${reel.id}/discard"
                onsubmit="return confirm('Discard this reel?')">
            <button class="danger" type="submit">Discard</button>
          </form>
        </div>
      </div>
    </article>
  `;
}

/** One published article that could become a reel. */
function candidateTile(c: ReelCandidate & { images: ReelImages | null }): Html {
  const images = c.images;

  return html`
    <article class="tile">
      <div class="tile-strip">
        ${images
          ? [images.hero, images.stepA, images.stepB, images.stepC].map(
              (src) => html`<img src="${onSite(c.site_domain, src)}" alt="" loading="lazy">`,
            )
          : html`<div class="tile-placeholder">Images unavailable</div>`}
      </div>

      <div class="tile-body">
        <div class="tile-title">${c.title || c.spy_title}</div>
        <div class="help">
          ${c.site_domain} &middot; ${c.seed_keyword} &middot; ${timeAgo(c.published_at ?? '')}
        </div>
        <div class="row wrap tile-actions">
          ${images
            ? html`<a class="button" href="/reels/new/${c.run_id}">Make a reel</a>`
            : raw('')}
          <form method="post" action="/reels/candidates/remove" style="display:inline">
            <input type="hidden" name="run_id" value="${c.run_id}" />
            <button type="submit" class="danger" title="Take it off this list. The article stays on the site.">Remove</button>
          </form>
        </div>
      </div>
    </article>
  `;
}

/**
 * One "send again" button per network, plus the re-encoding one.
 *
 * A network this reel never reached is shown but disabled: the button is how
 * you see where it went, and hiding it would leave the row looking identical
 * whether YouTube failed or was never switched on. Its state is in the title.
 */
function resendButtons(reel: ReelView): Html {
  const channels = readChannels(reel);
  const one = (name: 'facebook' | 'instagram' | 'youtube' | 'tiktok', label: string): Html => {
    // A network may have gone to several accounts: failed if any did, sent if
    // every one did.
    const states = channelKeys(channels).filter((k) => channelOf(k) === name).map((k) => channels[k]!);
    const failedOne = states.find((c) => c.status === 'failed');
    const state = failedOne ?? states[0];
    const accounts = states.length > 1 ? ` (${states.length} accounts)` : '';
    const where = failedOne
      ? `failed${accounts}: ${failedOne.error ?? ''} — sends again to the failed account(s) only`
      : state?.status === 'ok' ? `went there${accounts}` : state ? 'off for this site' : 'never sent there';
    return html`<form method="post" action="/reels/${reel.id}/resend" style="display:inline">
      <input type="hidden" name="channels" value="${name}" />
      <button type="submit" class="small" ${state ? raw('') : raw('disabled')}
              title="${label}: ${where}"
              onclick="return confirm('Send this reel to ${label} again? If it already succeeded there it will be posted twice.')">${label}</button>
    </form>`;
  };
  return html`${one('facebook', 'Facebook')} ${one('instagram', 'Instagram')} ${one('youtube', 'YouTube')} ${one('tiktok', 'TikTok')}
    <form method="post" action="/reels/${reel.id}/resend" style="display:inline">
      <input type="hidden" name="channels" value="facebook" />
      <input type="hidden" name="channels" value="instagram" />
      <input type="hidden" name="channels" value="youtube" />
      <input type="hidden" name="channels" value="tiktok" />
      <input type="hidden" name="reencode" value="1" />
      <button type="submit" class="small" title="Rebuild the video, then send it to all four again"
              onclick="return confirm('Re-encode the video and send it to Facebook, Instagram, YouTube and TikTok again? Anywhere it already succeeded, it will be posted twice.')">Re-encode + all</button>
    </form>`;
}

export function reelsPage(data: ReelsPageData): Html {
  const site = data.site ?? 0;
  const mine = <T extends { site_id: number | null }>(rows: T[]) => (site ? rows.filter((r) => r.site_id === site) : rows);
  const reels = mine(data.reels);
  data = { ...data, candidates: mine(data.candidates) };
  const working = reels.filter((r) => r.status !== 'published');
  const published = reels.filter((r) => r.status === 'published');

  return html`
    <div class="spread">
      <div>
        <h1>Reels</h1>
        <p class="subtitle">
          Every published article of a site that has a Facebook page becomes a reel here. Make one by
          hand from any article below.
        </p>
      </div>
      <div class="row wrap">
        <a class="button" href="/data/export/reels" download>Export CSV</a>
        <a class="button" href="/accounts#facebook-pages">Facebook pages</a>
      </div>
    </div>

    ${!data.configured
      ? html`<div class="flash warn">
          <strong>Facebook is not set up yet.</strong>
          Add a page and choose its site under
          <a href="/accounts#facebook-pages">Settings &rarr; Facebook</a>; reels are made automatically from then on.
        </div>`
      : !data.enabled
        ? html`<div class="flash warn">
            <strong>Reel publishing is switched off.</strong>
            Reels can still be generated and reviewed. Turn on &ldquo;Publish reels to
            Facebook&rdquo; in <a href="/settings">Settings</a> to release them.
          </div>`
        : raw('')}

    <h2>In progress</h2>
    ${working.length === 0
      ? html`<div class="card">${emptyState('No reels on the go.')}</div>`
      : html`<form id="bulk-reels" method="post" action="/reels/bulk" class="card row wrap" style="gap:10px;align-items:center">
          <label class="inline-check"><input type="checkbox"
            onclick="var on=this.checked;document.querySelectorAll('input[name=ids][form=bulk-reels]').forEach(function(c){c.checked=on})" /> Tick all</label>
          <button type="submit" name="action" value="retry" class="small">Retry selected</button>
          <button type="submit" name="action" value="discard" class="small danger"
                  onclick="var n=document.querySelectorAll('input[name=ids][form=bulk-reels]:checked').length;if(!n){alert('Tick the reels first.');return false}return confirm('Discard '+n+' reel(s)?')">Discard selected</button>
        </form>
        <div class="grid tiles">${working.map((r) => reelTile(r, data.fbPages))}</div>`}

    <div class="row" style="justify-content:space-between;align-items:flex-end;gap:8px">
      <div>
        <h2>Make a reel from</h2>
        <p class="subtitle">Published articles whose images are still on file.</p>
      </div>
      ${data.candidates.length > 1
        ? html`<form method="post" action="/reels/candidates/remove" onsubmit="return confirm('Take all ${data.candidates.length} articles off this list? The articles stay on the site.')">
            <input type="hidden" name="all" value="1" />
            <button type="submit" class="danger">Remove all</button>
          </form>`
        : raw('')}
    </div>
    ${data.candidates.length === 0
      ? html`<div class="card">
          ${emptyState('Nothing to turn into a reel yet. Publish an article first.')}
        </div>`
      : html`<div class="grid tiles">${data.candidates.map(candidateTile)}</div>`}

    ${published.length === 0
      ? raw('')
      : html`
          <!-- Folded away: finished work is worth being able to find, and worth
               nothing at all in the space where the current work is judged. -->
          <details class="card">
            <summary>Published (${published.length})</summary>
            <p class="small muted">Send a published reel to one network again: press that network's button. Use it when Buffer
              showed the post failed there — anywhere it succeeded, pressing the button posts it twice. A network is greyed out when
              this reel never went there. <strong>Re-encode + all</strong> rebuilds the video first and sends all three, which is the
              one that cures Facebook's "unable to process the media". Pinterest is left alone either way.</p>
            <div class="table-wrap scroll-y">
              <table>
                <thead><tr><th>Article</th><th>Page</th><th>When</th><th></th></tr></thead>
                <tbody>
                  ${published.map(
                    (reel) => html`<tr>
                      <td>${reel.run_title ?? '(untitled)'}</td>
                      <td class="small">${reel.page_name ?? ''}</td>
                      <td class="muted small nowrap">${timeAgo(reel.updated_at)}</td>
                      <td class="nowrap">
                        ${reel.fb_video_id
                          ? html`<a class="button" target="_blank" rel="noopener"
                                   href="https://www.facebook.com/reel/${reel.fb_video_id}">View</a>`
                          : raw('')}
                        ${resendButtons(reel)}
                      </td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>
          </details>`}
  `;
}

export interface ReelComposerData {
  candidate: ReelCandidate;
  images: ReelImages;
  caption: string;
  page: FbPageRow | undefined;
  /** Single: one clip from the prompt below and the ticked photos. Scenes: a storyboard. */
  mode: ReelMode;
  /** Single mode only: the prompt as the template renders it, for editing. */
  prompt: string;
  /** Single mode only: which photos are ticked to start with. */
  references: readonly ArticleRole[];
  /** Single mode only: the scene order the prompt was built with (Setup -> Reel structures). */
  structure?: { id: number | null; name: string | null };
}

/** What Setup → Reels shows and saves. */
export interface ReelSettingsData {
  mode: ReelMode;
  singleReferences: readonly ArticleRole[];
  lengthSeconds: number;
  allowed: string[];
  freshImages: boolean;
  cta: string;
  formats: ReelFormat[];
  publisher: 'facebook' | 'buffer';
  /** Music links for clip + steps reels, one box per entry, each box's links one per line. */
  music: readonly string[];
}

/**
 * Setup → Reels: how every reel is made.
 *
 * Two ways to make one, and each way's own options live under its radio
 * and show only when it is picked: the photo list means nothing to a
 * storyboard, and length and shapes mean nothing to a single clip. What is
 * true of both -- the call to action -- sits apart, below.
 */
export function reelSettingsPage(data: ReelSettingsData): Html {
  const lengths = [15, 30, 45, 60];
  const modeCard = (
    mode: ReelMode,
    title: string,
    detail: string,
  ) => html`<label class="choice ${data.mode === mode ? 'on' : ''}">
    <input type="radio" name="reel_mode" value="${mode}"
           ${data.mode === mode ? raw('checked') : raw('')} />
    <span><strong>${title}</strong><span class="muted small">${detail}</span></span>
  </label>`;

  return html`
    <h1>Reels</h1>
    <p class="subtitle">
      How every reel is made. Where it goes is decided per page under
      <a href="/accounts#facebook-pages">Channels &rarr; Facebook</a>.
    </p>

    <form method="post" action="/settings/reels" id="reel-settings">
      <h2>How a reel is made</h2>
      <div class="card">
        <div class="row wrap">
          ${modeCard(
            'single',
            'One clip',
            "One prompt and up to three of the article's photos go to Flow once. Ten seconds, ready in minutes.",
          )}
          ${modeCard(
            'hands',
            'Hands only',
            'One prompt too, but written as a single hands-only take, prep to plate, no voice and no text. About twenty seconds, still one clip’s credits.',
          )}
          ${modeCard(
            'process',
            'Process (hands only)',
            'The whole recipe from raw ingredients to the finished dish in 8 quick shots: hands only, one kitchen, no words. Each shot is filmed from the last frame of the one before. 8 clips’ credits, about half an hour.',
          )}
          ${modeCard(
            'mixed',
            'Clip + steps',
            'The same clip, then the method photos moving slowly with each step written on them, and the call to action. About twenty seconds, for the credits of one clip.',
          )}
        </div>
        <details ${data.mode === 'scenes' ? raw('open') : raw('')} style="margin-top:8px">
          <summary class="small muted">Advanced — storyboard reels (several scenes joined)</summary>
          <div class="row wrap" style="margin-top:8px">
            ${modeCard(
              'scenes',
              'A storyboard',
              'The model writes scenes; each is filmed on its own and they are joined. Longer, and more credits.',
            )}
          </div>
        </details>

        <div data-mode="single hands mixed" ${data.mode === 'single' || data.mode === 'hands' || data.mode === 'mixed' ? raw('') : raw('hidden')}>
          <div class="field">
            <label>Photos sent with the prompt</label>
            <div class="row wrap">
              ${ARTICLE_ROLES.map(
                (role) => html`<label class="inline-check">
                  <input type="checkbox" name="reel_single_references" value="${role}"
                         ${data.singleReferences.includes(role) ? raw('checked') : raw('')} />
                  ${ROLE_LABEL[role]}
                </label>`,
              )}
            </div>
            <div class="help">
              Flow takes up to ${MAX_REFERENCES} and leans on the first most. They can be
              changed for one reel on its Make a reel page.
            </div>
          </div>
        </div>

        <div data-mode="mixed process" ${data.mode === 'mixed' || data.mode === 'process' ? raw('') : raw('hidden')}>
          <div class="field">
            <label>Music</label>
            <div class="help" style="margin-top:-4px; margin-bottom:8px">
              Links to mp3 files you are allowed to use (for instance, ones you downloaded from
              Pixabay's own site and host somewhere), one per line. Each reel takes one at random
              from every box below combined and plays it under the whole reel, quieter while the
              clip speaks. All boxes empty: the photos have no sound.
            </div>
          </div>
          <div class="row wrap" style="gap:12px">
            ${Array.from({ length: MUSIC_SLOTS }, (_, i) => i + 1).map((slot) => {
              const key = musicSlotKey(slot);
              return html`<div class="field" style="flex:1 1 260px; min-width:220px">
                <label for="${key}">Box ${slot}</label>
                <textarea id="${key}" name="${key}" rows="5"
                          placeholder="https://yoursite.com/uploads/music-${slot}.mp3"
                >${data.music[slot - 1] ?? ''}</textarea>
              </div>`;
            })}
          </div>
        </div>

        <div data-mode="scenes" ${data.mode === 'scenes' ? raw('') : raw('hidden')}>
          <div class="field">
            <label for="reel_length_seconds">Length</label>
            <select id="reel_length_seconds" name="reel_length_seconds">
              ${lengths.map(
                (n) => html`<option value="${n}" ${n === data.lengthSeconds ? raw('selected') : raw('')}>
                  ${n} seconds &mdash; ${scenesFor(n)} scenes
                </option>`,
              )}
            </select>
            <div class="help">Each scene is one ten-second clip and costs its own video credits.</div>
          </div>
          <div class="field">
            <label class="inline-check">
              <input type="checkbox" name="reel_fresh_images" value="1"
                     ${data.freshImages ? raw('checked') : raw('')} />
              Make a new image for every scene
            </label>
            <div class="help">
              Off, scenes are filmed from the article's own photos for nothing extra.
            </div>
          </div>
          <div class="field">
            <label>Shapes a storyboard can take</label>
            ${data.formats.map(
              (f) => html`<div>
                <label class="inline-check">
                  <input type="checkbox" name="reel_formats" value="${f.key}"
                         ${data.allowed.includes(f.key) ? raw('checked') : raw('')} />
                  <strong>${f.title}</strong>
                  <span class="muted">&mdash; ${f.shape}</span>
                </label>
              </div>`,
            )}
            <div class="help">
              A page never repeats a shape from its last four reels, so more ticked means
              more variety.
            </div>
          </div>
        </div>
      </div>

      <h2>Every reel</h2>
      <div class="card">
        <div class="field">
          <label for="reel_cta_text">Call to action</label>
          <input type="text" id="reel_cta_text" name="reel_cta_text" value="${data.cta}" />
          <div class="help">
            The last thing every reel says and shows &mdash; the voiceover reads it word for word and it
            appears on the closing frame. Write <code>{domain}</code> and each site stamps its own address:
            one setting serves every site, so an address typed in by hand would follow one site's reels onto
            another's. Prefer the address over naming a place: the same video goes to Facebook, Instagram and
            YouTube, and the link sits somewhere different on each &mdash; the post text, the bio or first
            comment, the description &mdash; so &ldquo;in the comments&rdquo; is wrong on two of the three.
            On a YouTube Short the address is the only route at all, since links in a Short's description
            have not been clickable since 2023.
          </div>
        </div>
        <div class="field">
          <label for="reel_publisher">Publish reels through</label>
          <select id="reel_publisher" name="reel_publisher">
            <option value="facebook" ${data.publisher === 'facebook' ? raw('selected') : raw('')}>
              Facebook &mdash; straight to the Page with its own token
            </option>
            <option value="buffer" ${data.publisher === 'buffer' ? raw('selected') : raw('')}>
              Buffer &mdash; through the site's Buffer account, no Page token needed
            </option>
          </select>
          <div class="help">
            Buffer only queues the reel, so nothing here can confirm Facebook accepted it,
            and Buffer caps a reel at 90 seconds.
          </div>
        </div>
      </div>

      <div class="save-bar">
        <button class="primary" type="submit">Save</button>
        <span class="muted small">Applies to the next reel.</span>
      </div>
    </form>

    <div data-mode="mixed process" ${data.mode === 'mixed' || data.mode === 'process' ? raw('') : raw('hidden')}>
      <h2>Upload a song</h2>
      <div class="card">
        <div class="help" style="margin-top:-4px; margin-bottom:8px">
          Add a song straight from your computer instead of pasting a link. It is
          saved here and added to the box you pick, where it is picked at random
          just like any link already in it.
        </div>
        <div class="row wrap" style="gap:12px">
          ${Array.from({ length: MUSIC_SLOTS }, (_, i) => i + 1).map(
            (slot) => html`<form method="post" action="/settings/reels/music/upload?slot=${slot}"
                                 enctype="multipart/form-data"
                                 style="flex:1 1 260px; min-width:220px" class="field">
              <label for="music-upload-${slot}">Box ${slot}</label>
              <div class="row" style="gap:8px">
                <input type="file" id="music-upload-${slot}" name="file" accept="audio/*" required />
                <button class="small" type="submit">Upload</button>
              </div>
            </form>`,
          )}
        </div>
      </div>
    </div>

    <script>
      (function () {
        var form = document.getElementById('reel-settings');
        if (!form) return;
        var radios = form.querySelectorAll('input[name="reel_mode"]');
        // Not form.querySelectorAll: the music-upload buttons live in their
        // own forms just after this one closes, so they can submit a file
        // without turning this whole settings form into multipart/form-data.
        var sections = document.querySelectorAll('[data-mode]');
        function show() {
          var picked = form.querySelector('input[name="reel_mode"]:checked');
          var mode = picked ? picked.value : 'single';
          for (var i = 0; i < sections.length; i++) {
            sections[i].hidden = sections[i].dataset.mode.split(' ').indexOf(mode) < 0;
          }
          for (var j = 0; j < radios.length; j++) {
            radios[j].closest('.choice').classList.toggle('on', radios[j].checked);
          }
        }
        for (var k = 0; k < radios.length; k++) radios[k].addEventListener('change', show);
        show();
      })();
    </script>
  `;
}

/** What Setup → Collage shows and saves. */
export interface CollageSettingsData {
  enabled: boolean;
  steps: number;
  watermark: boolean;
}

/**
 * Setup → Collage: the step-by-step photo grid posted alongside the plain
 * Facebook post, when a page has it ticked. Deliberately a short page, same
 * card and save-bar conventions as Setup → Reels — there just isn't much to
 * decide here beyond on/off, how many photos, and whether to stamp the
 * address on it.
 */
export function collageSettingsPage(data: CollageSettingsData): Html {
  const steps = [6, 9, 12];
  return html`
    <h1>Collage</h1>
    <p class="subtitle">
      A step-by-step photo grid for every article — ingredients, the method, the finished dish —
      posted to <a href="/accounts#facebook-pages">Channels &rarr; Facebook</a> pages with
      Collage ticked. Each grid is made of fresh photographs generated just for it, on top of the
      article's own four images, so turning this on costs extra image credits per recipe.
    </p>

    <form method="post" action="/settings/collage" id="collage-settings">
      <div class="card">
        <div class="field">
          <label class="inline-check">
            <input type="checkbox" name="collage_enabled" value="1"
                   ${data.enabled ? raw('checked') : raw('')} />
            Post a step-by-step photo collage
          </label>
          <div class="help">
            Off by default. Turning it on needs at least one Facebook page with Collage ticked
            before anything actually goes out.
          </div>
        </div>

        <div class="field">
          <label for="collage_steps">Photographs in the collage</label>
          <select id="collage_steps" name="collage_steps">
            ${steps.map(
              (n) => html`<option value="${n}" ${n === data.steps ? raw('selected') : raw('')}>
                ${n} &mdash; a ${Math.ceil(Math.sqrt(n))}x${Math.ceil(n / Math.ceil(Math.sqrt(n)))} grid
              </option>`,
            )}
          </select>
          <div class="help">Each one is its own fresh image generation, from raw ingredients to the finished dish.</div>
        </div>

        <div class="field">
          <label class="inline-check">
            <input type="checkbox" name="collage_watermark" value="1"
                   ${data.watermark ? raw('checked') : raw('')} />
            Stamp the site address on the collage
          </label>
          <div class="help">
            The site's own domain, printed twice — near the top and near the bottom — the way the
            grid stays recognisably yours if it is shared further. Off: a plain grid, no text.
          </div>
        </div>
      </div>

      <div class="save-bar">
        <button class="primary" type="submit">Save</button>
        <span class="muted small">Applies to the next article.</span>
      </div>
    </form>
  `;
}

export function reelComposerPage(data: ReelComposerData): Html {
  const shots: { key: keyof ReelImages; label: string }[] = [
    { key: 'hero', label: 'Hero' },
    { key: 'stepA', label: 'First method shot' },
    { key: 'stepB', label: 'Second method shot' },
    { key: 'stepC', label: 'Third method shot' },
  ];

  return html`
    <h1>Make a reel</h1>
    <p class="subtitle">
      ${data.candidate.title || data.candidate.spy_title}
      &middot; ${data.candidate.site_domain} &middot; ${data.candidate.seed_keyword}
    </p>

    <form method="post" action="/reels/new/${data.candidate.run_id}">
      <div class="split">
        <div class="card">
          <h2>What it is made from</h2>
          ${data.mode === 'single' || data.mode === 'hands' || data.mode === 'mixed'
            ? html`<p class="help">
                  Tick up to ${MAX_REFERENCES} photos. Flow reads the dish from them together, so
                  the clip shows this food and not a lookalike.
                </p>
                <div class="pick-grid">
                  ${shots.map(
                    (shot) => html`
                      <label class="pick-tile">
                        <input type="checkbox" name="reference" value="${shot.key}"
                               ${data.references.includes(shot.key) ? raw('checked') : raw('')} />
                        <img src="${onSite(data.candidate.site_domain, data.images[shot.key])}"
                             alt="${shot.label}" loading="lazy">
                        <span class="pick-label">${shot.label}</span>
                      </label>`,
                  )}
                </div>
                <div class="field">
                  <label for="reel-prompt">Video prompt</label>
                  <textarea id="reel-prompt" name="prompt" rows="14" class="mono"
                            spellcheck="false"
                            ${data.mode === 'hands'
                              ? raw(`data-prompt-url="/reels/new/${data.candidate.run_id}/hands-prompt"`)
                              : raw('')}
                  >${data.prompt}</textarea>
                  <div class="help" id="reel-prompt-help">
                    ${data.mode === 'hands'
                      ? raw('Writing the prompt for this recipe… a hands-only take, prep to plate, no voice or text.')
                      : html`Sent as it is. The wording for every reel lives under Setup &rarr; Prompts
                        (reel-video), and the scenes under Setup &rarr; Reel structures.
                        ${data.structure?.name ? html`This one is built on <strong>${data.structure.name}</strong>.` : ''}`}
                  </div>
                  ${data.structure?.id && data.mode !== 'hands'
                    ? html`<input type="hidden" name="reel_structure_id" value="${data.structure.id}" />`
                    : ''}
                </div>`
            : html`<p class="help">
                  The storyboard is written for this article and filmed from these
                  photographs, scene by scene. Nothing to choose here.
                </p>
                <div class="pick-grid">
                  ${shots.map(
                    (shot) => html`
                      <div class="pick-tile">
                        <img src="${onSite(data.candidate.site_domain, data.images[shot.key])}"
                             alt="${shot.label}" loading="lazy">
                        <span class="pick-label">${shot.label}</span>
                      </div>`,
                  )}
                </div>`}
        </div>

        <div>
          <div class="card">
            <h2>Where it goes</h2>
            ${data.page
              ? html`
                  <p>
                    <strong>${data.page.name || data.page.page_id}</strong>
                  </p>
                  <p class="help">
                    The page for ${data.candidate.seed_keyword}.
                    ${data.page.auto_publish === 1
                      ? raw('It publishes automatically once the reel is ready.')
                      : raw('It will be held for you to review.')}
                  </p>`
              : html`<div class="flash warn">
                  This article's site has no Facebook page. The
                  reel will be made and then wait.
                  <a href="/accounts#facebook-pages">Assign one</a> to send it somewhere.
                </div>`}
          </div>

          <div class="card">
            <div class="field">
              <label for="reel-caption">Caption</label>
              <textarea id="reel-caption" name="caption" rows="6"
                        data-caption-url="/reels/new/${data.candidate.run_id}/caption">${data.caption}</textarea>
              <p class="help" id="reel-caption-help">Writing a caption… the title is there meanwhile. The link goes in the first comment, not here.</p>
            </div>
          </div>
        </div>
      </div>

      <div class="save-bar">
        <button class="primary" type="submit">Make the reel</button>
        <a class="button" href="/reels">Cancel</a>
        <span class="muted small">
          ${data.mode === 'process'
            ? raw('Eight hands-only shots, filmed one after another. About half an hour.')
            : data.mode === 'mixed'
            ? raw('One clip, then the method photos with their steps and the call to action. About twenty seconds.')
            : data.mode === 'single'
            ? raw('One clip, a few minutes.')
            : data.mode === 'hands'
            ? raw('One clip, a few minutes. About twenty seconds, hands only, no voice.')
            : raw('The storyboard is written first, then each scene is filmed. Ten minutes or so.')}
        </span>
      </div>
    </form>
    ${data.mode === 'hands' ? raw(REEL_PROMPT_SCRIPT) : ''}
    ${raw(REEL_CAPTION_SCRIPT)}
  `;
}

/**
 * Fill the caption in once the model has written it.
 *
 * Fetched after the page is up rather than rendered into it: the model takes
 * anywhere from two seconds to twenty and is sometimes down, and a page that
 * waited on it sat past Cloudflare's hundred seconds and answered 524. Only the
 * untouched box is replaced -- anyone who has started typing keeps what they
 * wrote.
 */
const REEL_CAPTION_SCRIPT = `<script>
(function () {
  var box = document.getElementById('reel-caption');
  var help = document.getElementById('reel-caption-help');
  if (!box || !box.dataset.captionUrl) return;

  var initial = box.value;
  var done = function (text) {
    if (help) help.textContent = text;
  };

  fetch(box.dataset.captionUrl, { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : { caption: null }; })
    .then(function (body) {
      if (body && body.caption && box.value === initial) {
        box.value = body.caption;
        done('Written by the model. Edit it as you like. The link goes in the first comment, not here.');
      } else if (body && body.caption) {
        done('A caption was written, but you had already started typing, so yours was kept.');
      } else {
        done('The model did not answer, so the title is there to start from. The link goes in the first comment, not here.');
      }
    })
    .catch(function () {
      done('The model did not answer, so the title is there to start from. The link goes in the first comment, not here.');
    });
})();
</script>`;

/**
 * Fill the hands-only prompt in once the model has written it, the same way
 * the caption above does and for the same reason: the model can take a
 * while, and the page must not wait on it. The untouched box only -- anyone
 * who started editing keeps what they wrote.
 */
const REEL_PROMPT_SCRIPT = `<script>
(function () {
  var box = document.getElementById('reel-prompt');
  var help = document.getElementById('reel-prompt-help');
  if (!box || !box.dataset.promptUrl) return;

  var initial = box.value;
  var done = function (text) {
    if (help) help.textContent = text;
  };

  fetch(box.dataset.promptUrl, { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : { prompt: null }; })
    .then(function (body) {
      if (body && body.prompt && box.value === initial) {
        box.value = body.prompt;
        done('Written by the model for this recipe. Edit it as you like before sending it.');
      } else if (body && body.prompt) {
        done('A prompt was written, but you had already started typing, so yours was kept.');
      } else {
        done('The model did not answer. Write the prompt by hand, or try again from Reels.');
      }
    })
    .catch(function () {
      done('The model did not answer. Write the prompt by hand, or try again from Reels.');
    });
})();
</script>`;

/* =========================================================================
 * Settings -> Facebook
 * ====================================================================== */

export interface FacebookSettingsData {
  enabled: boolean;
  tokens: FbTokenView[];
  pages: FbPageRow[];
  /** Every site, for the Site chooser on each page. */
  sites: { id: number; domain: string }[];
  /** The site whose Accounts page this is: its pages, and the ones nobody has claimed. */
  siteId: number;
  presenters: PresenterRow[];
}

/**
 * Two tables and nothing else.
 *
 * Tokens bring pages; a page belongs to a site. The page row asks one
 * question -- which site -- and a site may have several pages, which take turns.
 */

export interface PresentersData {
  presenters: PresenterRow[];
  /** Page names per presenter id, for "used by". */
  usedBy: Map<number, string[]>;
}

/** Setup → Presenters: the people who appear in reels. */
export function presentersPage(data: PresentersData): Html {
  return html`
    <h1>Presenters</h1>
    <p class="subtitle">
      A presenter is a character you made in Google Flow, with a voice. Reels on a page
      that has one show them on screen and let them speak. Make the character and the
      voice in Flow first (Setup &rarr; Browser), then add them here.
    </p>

    <h2>Add a presenter</h2>
    <div class="card">
      <form method="post" action="/settings/presenters">
        <div class="field-row">
          <div class="field">
            <label for="presenter-name">Name</label>
            <input type="text" id="presenter-name" name="name" required placeholder="Rima" />
            <div class="help">What you call them. It goes into the clip prompts as who is speaking.</div>
          </div>
          <div class="field">
            <label for="presenter-voice-description">How they sound</label>
            <input type="text" id="presenter-voice-description" name="voice_description"
                   placeholder="warm, unhurried, mid-thirties" />
            <div class="help">
              A few words. The same words go into every scene so the delivery stays the same.
            </div>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="presenter-character">Character</label>
            <input type="text" id="presenter-character" name="character" required
                   placeholder="https://flow.google.com/u/0/project/…/character/…" />
            <div class="help">
              In Flow, open the character. The address bar ends in
              <span class="mono">/character/&lt;id&gt;</span>: paste the whole address, or just the id.
            </div>
          </div>
          <div class="field">
            <label for="presenter-voice">Voice</label>
            <input type="text" id="presenter-voice" name="voice"
                   placeholder="paste the voice's address or id" />
            <div class="help">
              In Flow, open the voice you made for them and paste its address the same way.
              Leave empty for a presenter who does not speak.
            </div>
          </div>
        </div>
        <button class="primary" type="submit">Add presenter</button>
      </form>
    </div>

    <h2>Presenters</h2>
    ${data.presenters.length === 0
      ? html`<div class="card">${emptyState('No presenters yet. Reels show the dish only until there is one.')}</div>`
      : html`<div class="card table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>How they sound</th><th>Character</th><th>Voice</th><th>Used by</th><th></th></tr>
            </thead>
            <tbody>
              ${data.presenters.map((p) => {
                const formId = `presenter-${p.id}`;
                const pages = data.usedBy.get(p.id) ?? [];
                return html`<tr>
                  <td><input type="text" name="name" form="${formId}" value="${p.name}" /></td>
                  <td><input type="text" name="voice_description" form="${formId}" value="${p.voice_description}" /></td>
                  <td class="mono small">${p.flow_character_id}</td>
                  <td class="mono small">${p.flow_voice_id || html`<span class="muted">none</span>`}</td>
                  <td class="small">${pages.length ? pages.join(', ') : html`<span class="muted">no page yet</span>`}</td>
                  <td class="nowrap">
                    <form method="post" action="/settings/presenters/${p.id}" id="${formId}">
                      <button type="submit" class="small">Save</button>
                    </form>
                    <form method="post" action="/settings/presenters/${p.id}/delete"
                          onsubmit="return confirm('Remove ${p.name}? Pages using them go back to dish-only reels.')">
                      <button type="submit" class="small danger">Remove</button>
                    </form>
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>
        </div>`}
  `;
}

export function facebookSettingsPage(data: FacebookSettingsData): Html {
  const tokenName = new Map(data.tokens.map((t) => [t.id, t.name]));
  // Only pages a token brought in, not yet claimed by any account card above:
  // a manual page now lives entirely on its Facebook account and has nothing
  // to do here. This site's unclaimed pages, and the ones nobody has given a
  // site yet (so they can still be claimed).
  const pages = data.pages.filter((p) => p.token_id !== null && (p.site_id === data.siteId || p.site_id === null));

  return html`
    ${data.enabled
      ? raw('')
      : html`<div class="flash warn" style="margin-top:12px">
          Reels are switched off. Turn on <em>Publish reels to Facebook</em> under
          <a href="/settings">Settings</a> once an account above has a Page.
        </div>`}

    <details id="facebook-pages" style="border-top:1px solid rgba(127,127,127,.25);padding-top:14px;margin-top:16px">
    <summary style="cursor:pointer"><strong>Facebook tokens</strong> <span class="muted small">— only for publishing straight to Facebook without Buffer</span></summary>
    <p class="subtitle">
      Not the account above. Posting through Buffer needs nothing here — the Page each account
      posts as is set on its own card. This is only for the separate, token-based way to
      publish straight to Facebook, without Buffer holding the connection.
    </p>

    <div class="card">
      <h2>Tokens</h2>
      <p class="help">
        One per app. The platform reads every page the token can manage; you never type a
        page id. A token from Business Settings &rarr; System Users does not expire.
        Removing a token removes its pages.
      </p>

      ${data.tokens.length === 0
        ? emptyState('No token yet. Add one below and its pages appear.')
        : html`<div class="table-wrap">
            <table>
              <thead>
                <tr><th>Name</th><th>Pages</th><th>Last checked</th><th></th></tr>
              </thead>
              <tbody>
                ${data.tokens.map(
                  (t) => html`<tr>
                    <td>
                      ${t.name}
                      ${t.last_error
                        ? html`<div class="small error">${t.last_error}</div>`
                        : raw('')}
                    </td>
                    <td>${t.page_count}</td>
                    <td class="small muted nowrap">
                      ${t.last_synced_at ? timeAgo(t.last_synced_at) : 'never'}
                    </td>
                    <td class="nowrap">
                      <form method="post" action="/settings/facebook/tokens/${t.id}/refresh"
                            style="display:inline">
                        <button type="submit" class="small">Refresh</button>
                      </form>
                      <form method="post" action="/settings/facebook/tokens/${t.id}/delete"
                            style="display:inline"
                            onsubmit="return confirm('Remove this token and its ${t.page_count} page(s)?')">
                        <button type="submit" class="small danger">Remove</button>
                      </form>
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`}

      <form method="post" action="/settings/facebook/tokens" class="stack" style="margin-top:1rem">
        <div class="grid two">
          <div class="field">
            <label for="fb-token-name">Name</label>
            <input id="fb-token-name" name="name" placeholder="App 1" />
          </div>
          <div class="field">
            <label for="fb-token">Token</label>
            <input id="fb-token" name="token" type="password" required autocomplete="off" />
          </div>
        </div>
        <div><button type="submit" class="primary">Add token</button></div>
      </form>
    </div>

    <div class="card">
      <h2>Pages found under a token</h2>
      <p class="help">
        Choose what each page gets for every article: <strong>Posts</strong> — the recipe's picture
        (the Pinterest graphic, cut to Facebook's 4:5) with a short text and the recipe link —
        <strong>Reels</strong> — the video — and/or <strong>Collage</strong> — a step-by-step photo
        grid, when Setup &rarr; Collage has it switched on.
      </p>

      ${pages.length === 0
        ? emptyState('No pages yet. Connect a token above and its pages appear.')
        : html`<form method="post" action="/settings/facebook/pages">
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th class="pick"><input type="checkbox" title="Tick all" aria-label="Tick all"
                        onclick="var on=this.checked;this.closest('form').querySelectorAll('input[name=pick]').forEach(function(c){c.checked=on})" /></th>
                    <th>Page</th><th>Site</th><th>Posts</th><th>Reels</th><th>Collage</th>
                    <th>Last</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  ${pages.map(
                    (p) => html`<tr>
                      <td class="pick"><input type="checkbox" name="pick" value="${p.id}" aria-label="Select" /></td>
                      <td>
                        ${p.name || p.page_id}
                        <div class="small muted">
                          ${p.page_id}
                          ${p.token_id && tokenName.get(p.token_id)
                            ? html`&middot; ${tokenName.get(p.token_id)}`
                            : raw('')}
                        </div>
                      </td>
                      <td>
                        <select name="site_${p.id}">
                          <option value="">no site — not used</option>
                          ${data.sites.map(
                            (x) => html`<option value="${x.id}" ${p.site_id === x.id ? raw('selected') : raw('')}>${x.domain}</option>`,
                          )}
                        </select>
                        ${p.site_id === null ? html`<div class="small error">Choose a site, or nothing goes to this page.</div>` : raw('')}
                      </td>
                      <td>
                        <!-- Kept as they are: not asked on this page any more. -->
                        <input type="hidden" name="presenter_${p.id}" value="${p.presenter_id ?? ''}" />
                        ${p.auto_publish === 1 ? html`<input type="hidden" name="auto_${p.id}" value="on" />` : raw('')}
                        <input type="checkbox" name="posts_${p.id}" aria-label="Posts"
                               ${p.enabled === 1 && p.posts === 1 ? raw('checked') : raw('')} />
                      </td>
                      <td>
                        <input type="checkbox" name="reels_${p.id}" aria-label="Reels"
                               ${p.enabled === 1 && p.reels !== 0 ? raw('checked') : raw('')} />
                      </td>
                      <td>
                        <input type="checkbox" name="collage_${p.id}" aria-label="Collage"
                               ${p.enabled === 1 && p.collage === 1 ? raw('checked') : raw('')} />
                      </td>
                      <td class="small">
                        ${p.last_used_at
                          ? html`<span class="muted nowrap">${timeAgo(p.last_used_at)}</span>`
                          : html`<span class="muted">&mdash;</span>`}
                        ${p.last_error ? html`<div class="error">${p.last_error}</div>` : raw('')}
                      </td>
                      <td class="nowrap">
                        <button type="submit" class="small"
                                formaction="/settings/facebook/pages/${p.id}">Save</button>
                      </td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>
            <div class="save-bar">
              <button class="primary" type="submit">Save all pages</button>
              <span class="muted small">Every row above, in one go.</span>
              <button type="submit" class="danger" formaction="/settings/facebook/pages/delete" style="margin-left:auto"
                      onclick="var n=this.form.querySelectorAll('input[name=pick]:checked').length;if(!n){alert('Tick the pages to delete first.');return false}return confirm('Delete '+n+' page(s) from the platform? Their reels history is kept.')">Delete selected</button>
            </div>
          </form>`}
    </div>
      </details>
  `;
}
