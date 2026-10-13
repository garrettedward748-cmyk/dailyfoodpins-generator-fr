import { html, raw, type Html } from './layout.js';
import type { GscReport, Opportunity } from '../../gsc/engine.js';

/**
 * Search Console: its own section, apart from everything else. Two pages:
 * Opportunities (what Google shows the site for, with no page of its own)
 * and Setup (the key and each site's property).
 */

export interface GscSiteView {
  id: number;
  domain: string;
  property: string;
  on: boolean;
  hour: number;
  report: GscReport | null;
  waiting: number;
  running: boolean;
}

const reportLine = (r: GscReport | null): Html =>
  r
    ? r.error
      ? html`<span class="badge error">failed</span> <span class="small">${r.day}: ${r.error}</span>`
      : html`<span class="small muted">${r.day}: ${r.queries} searches, ${r.candidates} without a page of their own, ${r.found} kept as ideas</span>`
    : html`<span class="small muted">Not fetched yet.</span>`;

export function gscOpportunitiesPage(data: {
  sites: GscSiteView[];
  site: GscSiteView | null;
  status: Opportunity['status'];
  rows: Opportunity[];
  keySaved: boolean;
}): Html {
  const { site } = data;
  const tab = (status: Opportunity['status'], label: string) =>
    html`<a class="button small ${data.status === status ? 'primary' : ''}" href="/gsc?site=${site?.id ?? ''}&status=${status}">${label}</a>`;
  return html`
    <h1>Search Console</h1>
    <p class="subtitle">
      The searches your site already appears for in Google, with no page written for them yet — Google's own hint of
      what you can rank for. Tick the good ones: recipes go to Keywords, questions to Blog.
    </p>

    ${!data.keySaved
      ? html`<div class="flash warn">Not connected yet. Start with <a href="/gsc/setup">Search Console → Setup</a>, or upload a Queries.csv below.</div>`
      : raw('')}

    <div class="row wrap" style="gap:8px;margin-bottom:12px">
      ${data.sites.map(
        (s) => html`<a class="button ${site?.id === s.id ? 'primary' : ''}" href="/gsc?site=${s.id}">${s.domain}
          ${s.waiting ? html`<span class="badge ${site?.id === s.id ? 'muted' : 'brand'}" style="margin-left:6px;${site?.id === s.id ? 'background:#fff;color:#6c5ce7' : ''}">${s.waiting}</span>` : raw('')}</a>`,
      )}
    </div>

    ${site
      ? html`
        <div class="card">
          <div class="spread">
            <div>${reportLine(site.report)}
              ${site.running ? html`<div class="small"><strong>Fetching now…</strong> refresh this page in a minute.</div>` : raw('')}</div>
            <form method="post" action="/gsc/${site.id}/fetch">
              <button type="submit" class="small" ${!site.property || site.running ? raw('disabled') : raw('')}
                      title="${site.property ? 'Read the last 28 days now' : 'Choose a property under Setup first'}">Fetch now</button>
            </form>
          </div>
          <details style="margin-top:10px">
            <summary class="small">No API? Upload Search Console's Queries.csv instead</summary>
            <form method="post" action="/gsc/${site.id}/csv" enctype="multipart/form-data" class="row wrap" style="gap:8px;margin-top:8px">
              <input type="file" name="file" accept=".csv,text/csv" required style="width:auto" />
              <button type="submit" class="small">Upload</button>
            </form>
            <p class="help">Search Console → Performance → Export → Download CSV, then take <span class="mono">Queries.csv</span> out of the zip.
              It has no pages, so the AI decides alone and up to 1,000 searches come in.</p>
          </details>
        </div>

        <div class="row wrap" style="gap:8px;margin:12px 0">
          ${tab('new', 'New ideas')} ${tab('added', 'Added')} ${tab('dismissed', 'Dismissed')}
        </div>

        ${data.rows.length === 0
          ? html`<div class="card"><p class="muted" style="margin:0">${data.status === 'new' ? 'No new ideas. They appear after a fetch.' : 'Nothing here.'}</p></div>`
          : html`<form method="post" action="/gsc/${site.id}/add">
              <div class="card">
                <div class="table-wrap"><table>
                  <thead><tr>
                    ${data.status === 'new'
                      ? html`<th class="pick"><input type="checkbox" onclick="var on=this.checked;this.closest('table').querySelectorAll('tbody input').forEach(function(c){c.checked=on})" /></th>`
                      : raw('')}
                    <th>Search</th><th>Goes to</th><th>Impressions</th><th>Clicks</th><th>Position</th><th>Page Google shows now</th>
                  </tr></thead>
                  <tbody>${data.rows.map(
                    (r) => html`<tr>
                      ${data.status === 'new' ? html`<td class="pick"><input type="checkbox" name="ids" value="${r.id}" /></td>` : raw('')}
                      <td>${r.query}</td>
                      <td>${r.kind === 'recipe'
                        ? html`<span class="badge ok">recipe</span> <span class="small muted">${r.topic}</span>`
                        : html`<span class="badge brand">blog question</span>`}</td>
                      <td>${r.impressions}</td>
                      <td>${r.clicks}</td>
                      <td>${r.position ? r.position.toFixed(1) : '—'}</td>
                      <td class="small">${r.page ? html`<a href="${r.page}" target="_blank" rel="noopener">${pathOf(r.page)}</a>` : html`<span class="muted">—</span>`}</td>
                    </tr>`,
                  )}</tbody>
                </table></div>
              </div>
              ${data.status === 'new'
                ? html`<div class="save-bar">
                    <button type="submit" class="primary">Add the ticked ones</button>
                    <button type="submit" formaction="/gsc/${site.id}/dismiss" class="danger">Dismiss the ticked ones</button>
                    <span class="muted small">Recipes go to Keywords (their topic as the group), questions to Blog, for ${site.domain}. Dismissed ones never come back.</span>
                  </div>`
                : raw('')}
            </form>`}`
      : html`<div class="card"><p class="muted" style="margin:0">Add a site under Channels → Sites first.</p></div>`}
  `;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function gscSetupPage(data: {
  clientEmail: string | null;
  keyError: string | null;
  properties: string[] | null;
  propertiesError: string | null;
  sites: GscSiteView[];
  minImpressions: number;
}): Html {
  return html`
    <h1>Search Console setup</h1>
    <p class="subtitle">Once: a key that can read your Search Console, and which property belongs to which site.</p>

    <div class="card">
      <h2 style="margin-top:0">1. The key</h2>
      ${data.clientEmail
        ? html`
            <p>Saved. The key's address — add it in Search Console as a user of every site:</p>
            <div class="row wrap" style="gap:8px;align-items:center">
              <code style="font-size:14px">${data.clientEmail}</code>
              <button type="button" class="small" data-t="${data.clientEmail}"
                      onclick="navigator.clipboard&&navigator.clipboard.writeText(this.dataset.t);this.textContent='Copied'">Copy</button>
            </div>
            <form method="post" action="/gsc/setup/key/remove" style="margin-top:10px"
                  onsubmit="return confirm('Remove the key? Daily fetching stops until a new one is saved.')">
              <button type="submit" class="small danger">Remove the key</button>
            </form>`
        : html`
            <ol class="small" style="line-height:1.7">
              <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">console.cloud.google.com</a> and create a project (any name).</li>
              <li>Turn on the API: <a href="https://console.cloud.google.com/apis/library/searchconsole.googleapis.com" target="_blank" rel="noopener">Google Search Console API</a> → <strong>Enable</strong>.</li>
              <li><a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener">Service accounts</a> → <strong>Create service account</strong> → any name → <strong>Done</strong> (no roles needed).</li>
              <li>Open it → <strong>Keys</strong> → <strong>Add key</strong> → <strong>Create new key</strong> → <strong>JSON</strong>. A file downloads.</li>
              <li>Open that file, copy everything in it, paste it below and save.</li>
            </ol>
            <form method="post" action="/gsc/setup/key">
              <textarea name="key" rows="6" placeholder='{"type": "service_account", "client_email": "...", "private_key": "...", ...}' required></textarea>
              <button type="submit" class="primary" style="margin-top:8px">Save the key</button>
            </form>`}
      ${data.keyError ? html`<div class="flash error" style="margin-top:10px">${data.keyError}</div>` : raw('')}
    </div>

    <div class="card">
      <h2 style="margin-top:0">2. Give the key access</h2>
      <p class="small">In <a href="https://search.google.com/search-console" target="_blank" rel="noopener">Search Console</a>, for each site:
        <strong>Settings → Users and permissions → Add user</strong> → paste the key's address above → permission <strong>Restricted</strong> (read only) → Add.</p>
      ${data.properties
        ? html`<p class="small">The key can read: ${data.properties.length
            ? data.properties.map((p) => html`<code>${p}</code> `)
            : html`<strong>nothing yet</strong> — add it as a user, then reload this page.`}</p>`
        : data.propertiesError
          ? html`<div class="flash warn">${data.propertiesError}</div>`
          : raw('')}
    </div>

    <div class="card">
      <h2 style="margin-top:0">3. Each site</h2>
      ${data.sites.map(
        (s) => html`<form method="post" action="/gsc/setup/site/${s.id}" class="card" style="margin-top:10px">
          <div class="spread">
            <strong>${s.domain}</strong>
            <label class="inline-check"><input type="checkbox" name="on" value="1" ${s.on ? raw('checked') : raw('')} /> Fetch every day</label>
          </div>
          <div class="field-row" style="margin-top:8px">
            <div class="field">
              <label>Search Console property</label>
              ${data.properties && data.properties.length
                ? html`<select name="property">
                    <option value="">— choose —</option>
                    ${data.properties.map((p) => html`<option value="${p}" ${p === s.property ? raw('selected') : raw('')}>${p}</option>`)}
                  </select>`
                : html`<input name="property" value="${s.property}" placeholder="sc-domain:${s.domain}" />`}
            </div>
            <div class="field"><label>At (hour, 0–23)</label><input type="number" name="hour" min="0" max="23" value="${s.hour}" /></div>
          </div>
          <div class="row wrap" style="gap:8px;align-items:center">
            <button type="submit" class="primary small">Save</button>
            ${reportLine(s.report)}
          </div>
        </form>`,
      )}
    </div>

    <form method="post" action="/gsc/setup/options" class="card">
      <h2 style="margin-top:0">Options</h2>
      <div class="field" style="max-width:320px">
        <label>Least impressions for an idea (28 days)</label>
        <input type="number" name="min" min="1" max="10000" value="${data.minImpressions}" />
        <div class="help">Searches shown fewer times than this are left out. Lower finds more, but weaker, ideas.</div>
      </div>
      <button type="submit" class="small">Save</button>
    </form>
  `;
}
