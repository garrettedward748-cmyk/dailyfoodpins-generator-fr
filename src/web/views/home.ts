import { html, raw, statusBadge, timeAgo, type Html } from './layout.js';
import type { RunListRow, ReelView } from '../../db/repos.js';
import type { Supply } from '../../core/supply.js';

/**
 * Home: what is happening, what needs a person, today's numbers, and what
 * happened last. Four parts, top to bottom, and nothing that belongs to a
 * section of its own -- the site table is under Channels, the scheduler's
 * reasoning under Activity.
 *
 * The rule that shapes it: everything that needs the person's hand appears
 * here as one line with one button. Nobody should have to go looking for the
 * thing that stopped the work.
 */

/** One thing a person has to do, and the one place to do it. */
export interface Attention {
  /** 'warn' stops work; 'info' is waiting on a choice. */
  kind: 'warn' | 'info';
  text: string;
  href: string;
  action: string;
  /** Opens in its own tab (the live browser). */
  external?: boolean;
}

export interface Running {
  runId: number | null;
  site: string;
  keyword: string;
  /** The step in progress, in words. */
  step: string;
  startedAt: string | null;
}

/** A run or a reel, flattened for one list. */
export interface RecentItem {
  at: string;
  href: string;
  what: string;
  status: string;
  detail: string;
  /** Which of the two the row is, shown as a badge in the last column. */
  kind: 'article' | 'reel';
}

export interface HomeData {
  automationOn: boolean;
  running: Running | null;
  attention: Attention[];
  today: {
    published: number;
    target: number;
    reels: number;
    failed: number;
    queued: number;
    supply: Supply;
  };
  recent: RecentItem[];
  /** The manual-run picker, rendered by the existing dashboard code. */
  picker: Html;
}

export function homePage(data: HomeData): Html {
  return html`
    <div class="spread">
      <div>
        <h1>Home</h1>
      </div>
      <div class="row">
        <button class="primary" type="button" id="run-once-open"
                ${data.running ? raw('disabled') : raw('')}>
          Run once now
        </button>
      </div>
    </div>

    ${data.picker}

    ${statusBar(data)}

    <h2>Needs you ${data.attention.length ? html`<span class="count">${data.attention.length}</span>` : raw('')}</h2>
    ${data.attention.length === 0
      ? html`<div class="card muted">Nothing. Everything that can run is running.</div>`
      : html`<div class="attention">
          ${data.attention.map(
            (a) => html`<div class="attention-row ${a.kind}">
              <span>${a.text}</span>
              <a class="button small" href="${a.href}"
                ${a.external ? raw('target="_blank" rel="noopener"') : raw('')}>${a.action}</a>
            </div>`,
          )}
        </div>`}

    <h2>Today</h2>
    <div class="grid">
      <div class="stat">
        <div class="value">${data.today.published}
          <span class="muted small">/ ${data.today.target}</span></div>
        <div class="label">Articles</div>
      </div>
      <div class="stat"><div class="value">${data.today.reels}</div><div class="label">Reels</div></div>
      <div class="stat ${data.today.failed ? 'bad' : ''}">
        <div class="value">${data.today.failed}</div><div class="label">Failed</div>
      </div>
      <div class="stat ${data.today.supply.level === 'ok' ? '' : `supply-${data.today.supply.level}`}">
        <div class="value">${data.today.queued}</div>
        <div class="label">Articles queued</div>
        <div class="muted small">
          ${data.today.supply.daysRemaining === null
            ? 'no active demand'
            : data.today.supply.daysRemaining >= 1
              ? `~${Math.floor(data.today.supply.daysRemaining)} day(s) left`
              : 'less than a day left'}
        </div>
      </div>
    </div>

    <h2>Recent <a class="button small" href="/runs">All articles</a>
      <a class="button small" href="/reels">All reels</a></h2>
    <div class="card table-wrap">
      ${data.recent.length === 0
        ? html`<div class="muted">Nothing yet. The first article appears here.</div>`
        : html`<table class="recent">
            <tbody>
              ${data.recent.map(
                (r) => html`<tr>
                  <td class="nowrap muted small">${timeAgo(r.at)}</td>
                  <td><a href="${r.href}">${r.what}</a></td>
                  <td>${statusBadge(r.status)}</td>
                  <td class="nowrap">
                    <span class="badge ${r.kind === 'reel' ? 'reel' : 'muted'}">${r.kind}</span>
                    ${r.detail ? html`<span class="small muted"> ${r.detail}</span>` : raw('')}
                  </td>
                </tr>`,
              )}
            </tbody>
          </table>`}
    </div>
  `;
}

function statusBar(data: HomeData): Html {
  const light = data.automationOn ? 'on' : 'off';
  const running = data.running
    ? html`<span class="muted">· running: ${data.running.site} — ${data.running.keyword}
        (${data.running.step}, started ${timeAgo(data.running.startedAt)})</span>`
    : data.automationOn
      ? html`<span class="muted">· waiting for the next check</span>`
      : raw('');

  const controls = data.running
    ? html`<form method="post" action="/run/restart">
          <button type="submit" title="Stop it and pick up from the last completed step">Restart</button>
        </form>
        <form method="post" action="/run/stop"
              onsubmit="return confirm('Stop this run? It will be marked failed.')">
          <button class="danger" type="submit">Stop</button>
        </form>`
    : raw('');

  return html`
    <div class="statusbar">
      <div class="row">
        <span class="light ${light}"></span>
        <strong>Automation ${light}</strong>
        ${running}
      </div>
      <div class="row">
        ${controls}
        <form method="post" action="/automation">
          <input type="hidden" name="enabled" value="${data.automationOn ? '0' : '1'}" />
          <button type="submit">${data.automationOn ? 'Pause' : 'Turn on'}</button>
        </form>
      </div>
    </div>
  `;
}

/** Runs and reels in one list, newest first. */
export function mergeRecent(runs: RunListRow[], reels: ReelView[], limit = 12): RecentItem[] {
  const items: RecentItem[] = [];

  for (const r of runs) {
    items.push({
      at: r.started_at,
      href: `/runs/${r.id}`,
      what: `${r.site_domain ?? '—'} · ${r.seed_keyword ?? r.title ?? '—'}`,
      status: r.status,
      kind: 'article',
      detail:
        r.status === 'failed'
          ? `failed at ${r.failed_step ?? '?'}`
          : r.status === 'cancelled' && r.hold
            ? r.hold === 'awaiting'
              ? 'waiting for approval'
              : 'dry run'
            : '',
    });
  }

  for (const r of reels) {
    items.push({
      at: r.created_at,
      href: `/reels/${r.id}`,
      what: `${r.page_name ?? 'no page'} · ${r.seed_keyword ?? r.run_title ?? '—'}`,
      status: r.status,
      kind: 'reel',
      detail: r.error ? r.error.slice(0, 80) : '',
    });
  }

  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}
