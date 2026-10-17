import { html, raw, type Html } from './layout.js';
import type { PinIdea, PinIdeasReport } from '../../research/pinterest-ideas.js';

/**
 * Pinterest ideas: upload a site's Pinterest Analytics export, see which pins
 * work, tick the article ideas that follow them. Laid out like Radar on
 * purpose -- the same job from another source.
 */

export interface PinIdeasSiteView {
  id: number;
  domain: string;
  report: PinIdeasReport | null;
  waiting: number;
  running: boolean;
  /** The site's Pinterest accounts, by username, for the upload's picker. */
  accounts: { id: number; username: string; label: string }[];
  /** Where the analysis stands while it runs. */
  progress?: { stage: string; done: number; total: number; seconds: number } | null;
}

/** The stage in words; the same words the page's script writes as it polls. */
const STAGES: Record<string, string> = {
  reading: 'Reading the file',
  titles: 'Looking up the pin titles on Pinterest',
  ai: 'The AI is reading the pins and writing ideas',
  saving: 'Saving the new ideas',
};

/**
 * The live status while an export is analysed: the stage, a counter for the
 * pin titles, the seconds gone. It asks the server every two seconds and
 * reloads the page the moment the work is done, so the ideas appear by
 * themselves.
 */
function liveStatus(site: PinIdeasSiteView): Html {
  const p = site.progress ?? { stage: 'reading', done: 0, total: 0, seconds: 0 };
  const pct = p.stage === 'titles' && p.total ? Math.round((p.done / p.total) * 100) : p.stage === 'ai' ? 100 : 0;
  return html`<div id="pin-progress" style="margin:12px 0 0">
    <div class="spread small">
      <strong id="pin-stage">${STAGES[p.stage] ?? 'Working'}<span id="pin-count">${p.stage === 'titles' && p.total ? ` — ${p.done} / ${p.total}` : ''}</span>…</strong>
      <span class="muted"><span id="pin-seconds">${p.seconds}</span> s</span>
    </div>
    <div style="height:6px;border-radius:3px;background:var(--border, #2a2f3a);margin-top:6px;overflow:hidden">
      <div id="pin-bar" style="height:100%;width:${pct}%;background:var(--brand, #7c5cff);transition:width .4s"></div>
    </div>
    <p class="help" style="margin:6px 0 0">The page shows the ideas by itself when this is done. The AI step usually takes under a minute.</p>
    <script>
      (function () {
        var stages = ${raw(JSON.stringify(STAGES))};
        var started = Date.now() - ${p.seconds} * 1000;
        setInterval(function () {
          document.getElementById('pin-seconds').textContent = Math.round((Date.now() - started) / 1000);
        }, 1000);
        function poll() {
          fetch('/pin-ideas/${site.id}/progress', { cache: 'no-store', credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (p) {
              if (!p.running) { location.reload(); return; }
              document.getElementById('pin-stage').firstChild.textContent = stages[p.stage] || 'Working';
              document.getElementById('pin-count').textContent = p.stage === 'titles' && p.total ? ' — ' + p.done + ' / ' + p.total : '';
              var pct = p.stage === 'titles' && p.total ? Math.round(p.done / p.total * 100) : (p.stage === 'ai' || p.stage === 'saving' ? 100 : 0);
              document.getElementById('pin-bar').style.width = pct + '%';
              setTimeout(poll, 2000);
            })
            .catch(function () { setTimeout(poll, 4000); });
        }
        setTimeout(poll, 2000);
      })();
    </script>
  </div>`;
}

const num = (n: number): string => n.toLocaleString('en-US');

export function pinIdeasPage(data: {
  sites: PinIdeasSiteView[];
  site: PinIdeasSiteView | null;
  status: PinIdea['status'];
  rows: PinIdea[];
}): Html {
  const { site } = data;
  const tab = (status: PinIdea['status'], label: string) =>
    html`<a class="button small ${data.status === status ? 'primary' : ''}" href="/pin-ideas?site=${site?.id ?? ''}&status=${status}">${label}</a>`;
  const siteTab = (s: PinIdeasSiteView) =>
    html`<a class="button small ${site?.id === s.id ? 'primary' : ''}" href="/pin-ideas?site=${s.id}">${s.domain}${s.waiting ? html` <span class="badge brand">${s.waiting}</span>` : raw('')}</a>`;
  const r = site?.report ?? null;

  return html`
    <h1>Pinterest ideas</h1>
    <p class="subtitle">
      What already works on a site's Pinterest, turned into its next articles. Export the pins from Pinterest Analytics,
      upload the file here, and the AI reads which pins travel and proposes new dishes in the same vein. Tick the good
      ones: they go to Keywords, and each article is written from scratch as always.
    </p>

    ${data.sites.length === 0
      ? html`<div class="card"><p class="muted" style="margin:0">Add a site under Channels → Sites first.</p></div>`
      : html`<div class="row wrap" style="gap:8px;margin-bottom:12px">${data.sites.map(siteTab)}</div>`}

    ${site
      ? html`
        <div class="card">
          <form method="post" action="/pin-ideas/${site.id}/upload" enctype="multipart/form-data" class="row wrap" style="gap:12px;align-items:flex-end">
            <!-- Before the file: multipart hands the server only the fields that come before it. -->
            <div class="field" style="margin:0;min-width:220px">
              <label>Pinterest account</label>
              <select name="account">
                <option value="0">Found in the file</option>
                ${site.accounts.map((a) => html`<option value="${a.id}">${a.username || a.label}${a.username ? html` <span>(${a.label})</span>` : raw('')}</option>`)}
              </select>
            </div>
            <div class="field" style="margin:0;min-width:280px">
              <label>Pinterest Analytics export (.csv)</label>
              <input type="file" name="file" accept=".csv,text/csv" required />
            </div>
            <button type="submit" class="primary" ${site.running ? raw('disabled') : raw('')}>Upload and analyse</button>
          </form>
          <details style="margin-top:10px">
            <summary class="small muted" style="cursor:pointer">How to get the file</summary>
            <ol class="small" style="margin:8px 0 0">
              <li>On Pinterest, signed in as the account: <strong>Analytics → Overview</strong>.</li>
              <li>Pick the dates (the last 30 or 90 days give the clearest picture), then <strong>Export</strong> at the top.</li>
              <li>Upload that CSV here, as it is. It holds the top boards and the top pins; the pins' titles are looked up on Pinterest.</li>
              <li>One file per Pinterest account: upload each account's in turn if the site has several.</li>
            </ol>
            <p class="help" style="margin:6px 0 0">The English and French exports are both read. The account is read from the
              file's own board links; pick one only for a file that has no boards. Each idea's keyword then pins to that
              account rather than the next one in the turn (while it is on, takes posts and has a Buffer token).</p>
          </details>
          ${site.running ? liveStatus(site) : raw('')}
        </div>

        ${r
          ? html`<div class="card">
              <div class="spread">
                <strong>Last upload</strong>
                <span class="small muted">${r.day} · ${r.file} · ${r.pins} pin(s) read · ${r.found} new idea(s)</span>
              </div>
              ${r.account
                ? html`<p class="small" style="margin:8px 0 0">Account: <strong>${r.account.username}</strong> — its ideas pin there.</p>`
                : raw('')}
              ${r.accountNote ? html`<div class="flash warn" style="margin:8px 0 0">${r.accountNote}</div>` : raw('')}
              ${r.error ? html`<div class="flash error" style="margin:10px 0 0">${r.error}</div>` : raw('')}
              ${r.summary ? html`<p style="margin:10px 0 0">${r.summary}</p>` : raw('')}
              ${r.top.length
                ? html`<details style="margin-top:10px" ${data.rows.length ? raw('') : raw('open')}>
                    <summary class="small" style="cursor:pointer"><strong>The strongest boards and pins</strong> <span class="muted">(what the ideas follow)</span></summary>
                    <div class="table-wrap" style="margin-top:8px"><table>
                      <thead><tr><th>Board or pin</th><th>Impressions</th><th>Saves</th><th>Pin clicks</th><th>Outbound</th><th>Score</th></tr></thead>
                      <tbody>${r.top.map(
                        (p) => html`<tr>
                          <td><span class="badge ${p.kind === 'board' ? 'brand' : 'muted'}">${p.kind}</span>
                            ${p.url ? html`<a href="${p.url}" target="_blank" rel="noopener">${p.title}</a>` : p.title}</td>
                          <td>${num(p.impressions)}</td><td>${num(p.saves)}</td><td>${num(p.pinClicks)}</td>
                          <td><strong>${num(p.outbound)}</strong></td><td>${num(p.score)}</td>
                        </tr>`,
                      )}</tbody>
                    </table></div>
                    <p class="help" style="margin:6px 0 0">Score: 10 per outbound click (a visit to the site), 5 per save, 2 per pin click, plus impressions ÷ 100.</p>
                  </details>`
                : raw('')}
            </div>`
          : raw('')}

        <div class="row wrap" style="gap:8px;margin:12px 0">
          ${tab('new', 'New ideas')} ${tab('added', 'Added')} ${tab('dismissed', 'Dismissed')}
        </div>

        ${data.rows.length === 0
          ? html`<div class="card"><p class="muted" style="margin:0">${data.status === 'new' ? 'No new ideas. They appear after an upload.' : 'Nothing here.'}</p></div>`
          : html`<form method="post" action="/pin-ideas/${site.id}/add">
              <div class="card">
                <div class="table-wrap"><table>
                  <thead><tr>
                    <th class="pick"><input type="checkbox" onclick="var on=this.checked;this.closest('table').querySelectorAll('tbody input').forEach(function(c){c.checked=on})" /></th>
                    <th>Idea</th><th>Group</th><th>Pins to</th><th>Follows</th>
                  </tr></thead>
                  <tbody>${data.rows.map(
                    (i) => html`<tr>
                      <td class="pick"><input type="checkbox" name="ids" value="${i.id}" /></td>
                      <td><strong>${i.title}</strong></td>
                      <td class="small muted">${i.topic || '—'}</td>
                      <td class="small">${(() => {
                        const acc = site.accounts.find((a) => a.id === i.profile_id);
                        return acc ? html`<strong>${acc.username || acc.label}</strong>` : html`<span class="muted">the turn</span>`;
                      })()}</td>
                      <td class="small">${i.source
                        ? html`${i.source_url ? html`<a href="${i.source_url}" target="_blank" rel="noopener">${i.source}</a>` : i.source}
                            <span class="muted">· score ${num(i.score)}</span>`
                        : html`<span class="muted">the account's themes</span>`}</td>
                    </tr>`,
                  )}</tbody>
                </table></div>
              </div>
              <div class="save-bar">
                ${data.status === 'new'
                  ? html`<button type="submit" class="primary">Add the ticked ones</button>
                      <button type="submit" formaction="/pin-ideas/${site.id}/dismiss" class="danger">Dismiss the ticked ones</button>`
                  : raw('')}
                <button type="submit" formaction="/pin-ideas/${site.id}/delete?status=${data.status}" class="danger"
                        onclick="return confirm('Delete the ticked ideas? They are removed from this list; a later upload may propose them again.')">Delete the ticked ones</button>
                <button type="submit" formaction="/pin-ideas/${site.id}/delete-all?status=${data.status}" formnovalidate class="danger"
                        onclick="return confirm('Delete all ${data.rows.length} idea(s) on this tab for ${site.domain}?')">Delete all</button>
                <span class="muted small">${data.status === 'new'
                  ? html`Add sends ideas to Keywords for ${site.domain}, under their group. Dismissed ones never come back; deleted ones may be proposed again by a later upload.`
                  : data.status === 'added'
                    ? html`Deleting here removes the idea from this list only: its keyword stays in Keywords.`
                    : html`Deleted ones may be proposed again by a later upload.`}</span>
              </div>
            </form>`}`
      : raw('')}
  `;
}
