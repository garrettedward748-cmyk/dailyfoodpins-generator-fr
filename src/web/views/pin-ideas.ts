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
              <li>Pick the dates (the last 30 or 90 days give the clearest picture).</li>
              <li>Scroll to <strong>Top pins</strong>, set it to show pins (not boards), then <strong>Export</strong>.</li>
              <li>Upload that CSV here. One file per Pinterest account; upload each account's in turn if the site has several.</li>
            </ol>
            <p class="help" style="margin:6px 0 0">The English and French exports are both read. The daily overview export has no pins in it, so it gives no ideas.</p>
          </details>
          ${site.running ? html`<p class="small" style="margin:10px 0 0"><strong>Analysing now…</strong> refresh this page in a minute.</p>` : raw('')}
        </div>

        ${r
          ? html`<div class="card">
              <div class="spread">
                <strong>Last upload</strong>
                <span class="small muted">${r.day} · ${r.file} · ${r.pins} pin(s) read · ${r.found} new idea(s)</span>
              </div>
              ${r.error ? html`<div class="flash error" style="margin:10px 0 0">${r.error}</div>` : raw('')}
              ${r.summary ? html`<p style="margin:10px 0 0">${r.summary}</p>` : raw('')}
              ${r.top.length
                ? html`<details style="margin-top:10px" ${data.rows.length ? raw('') : raw('open')}>
                    <summary class="small" style="cursor:pointer"><strong>The strongest pins</strong> <span class="muted">(what the ideas follow)</span></summary>
                    <div class="table-wrap" style="margin-top:8px"><table>
                      <thead><tr><th>Pin</th><th>Impressions</th><th>Saves</th><th>Pin clicks</th><th>Outbound</th><th>Score</th></tr></thead>
                      <tbody>${r.top.map(
                        (p) => html`<tr>
                          <td>${p.url ? html`<a href="${p.url}" target="_blank" rel="noopener">${p.title}</a>` : p.title}</td>
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
                    ${data.status === 'new'
                      ? html`<th class="pick"><input type="checkbox" onclick="var on=this.checked;this.closest('table').querySelectorAll('tbody input').forEach(function(c){c.checked=on})" /></th>`
                      : raw('')}
                    <th>Idea</th><th>Group</th><th>Follows the pin</th>
                  </tr></thead>
                  <tbody>${data.rows.map(
                    (i) => html`<tr>
                      ${data.status === 'new' ? html`<td class="pick"><input type="checkbox" name="ids" value="${i.id}" /></td>` : raw('')}
                      <td><strong>${i.title}</strong></td>
                      <td class="small muted">${i.topic || '—'}</td>
                      <td class="small">${i.source
                        ? html`${i.source_url ? html`<a href="${i.source_url}" target="_blank" rel="noopener">${i.source}</a>` : i.source}
                            <span class="muted">· score ${num(i.score)}</span>`
                        : html`<span class="muted">the account's themes</span>`}</td>
                    </tr>`,
                  )}</tbody>
                </table></div>
              </div>
              ${data.status === 'new'
                ? html`<div class="save-bar">
                    <button type="submit" class="primary">Add the ticked ones</button>
                    <button type="submit" formaction="/pin-ideas/${site.id}/dismiss" class="danger">Dismiss the ticked ones</button>
                    <span class="muted small">Ideas go to Keywords for ${site.domain}, under their group. Dismissed ones never come back.</span>
                  </div>`
                : raw('')}
            </form>`}`
      : raw('')}
  `;
}
