import { html, raw, type Html } from './layout.js';
import type { RadarPost, RadarReport } from '../../research/social/radar.js';
import type { SocialSource } from '../../research/social/repo.js';

/**
 * Radar: the pages a site watches, and what they are talking about.
 *
 * Deliberately the same two pages and the same verdict buttons as Search
 * Console. It is the same job from a different source, and a second layout for
 * it would be a second thing to learn for no reason.
 */

export interface RadarSiteView {
  id: number;
  domain: string;
  on: boolean;
  hour: number;
  report: RadarReport | null;
  waiting: number;
  sources: number;
  running: boolean;
}

const reportLine = (r: RadarReport | null): Html =>
  r
    ? r.error
      ? html`<span class="badge error">failed</span> <span class="small">${r.day}: ${r.error}</span>`
      : html`<span class="small muted">${r.day}: ${r.posts} post(s) from ${r.pages} page(s), ${r.candidates} worth reading, ${r.found} kept as ideas${r.refreshed ? `, ${r.refreshed} waiting idea(s) brought up to date` : ''}</span>`
    : html`<span class="small muted">Not scanned yet.</span>`;

const age = (iso: string): string => {
  if (!iso) return '—';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return '—';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
};

export function radarPage(data: {
  sites: RadarSiteView[];
  site: RadarSiteView | null;
  status: RadarPost['status'];
  rows: RadarPost[];
  configured: boolean;
}): Html {
  const { site } = data;
  const tab = (status: RadarPost['status'], label: string) =>
    html`<a class="button small ${data.status === status ? 'primary' : ''}" href="/radar?site=${site?.id ?? ''}&status=${status}">${label}</a>`;
  return html`
    <h1>Radar</h1>
    <p class="subtitle">
      What the pages in your niche are posting, and how hard it travelled. Search Console tells you what people search
      for; this tells you what they pass on. Tick the good ones: ideas go to Keywords, questions to Blog, and the
      article is written from scratch as always.
    </p>

    ${!data.configured
      ? html`<div class="flash warn">No scraping service connected yet — start with <a href="/radar/setup">Radar → Setup</a>.</div>`
      : raw('')}


    ${site
      ? html`
        <div class="card">
          <div class="spread">
            <div>${reportLine(site.report)}
              ${site.running ? html`<div class="small"><strong>Scanning now…</strong> refresh this page in a few minutes.</div>` : raw('')}</div>
            <form method="post" action="/radar/${site.id}/scan">
              <button type="submit" class="small" ${!site.sources || site.running ? raw('disabled') : raw('')}
                      title="${site.sources ? 'Read the watched pages now' : 'Add a page under Setup first'}">Scan now</button>
            </form>
          </div>
          ${!site.sources
            ? html`<p class="help" style="margin:10px 0 0">No pages watched yet for this site — add them under <a href="/radar/setup">Setup</a>.</p>`
            : raw('')}
        </div>

        <div class="row wrap" style="gap:8px;margin:12px 0">
          ${tab('new', 'New ideas')} ${tab('added', 'Added')} ${tab('dismissed', 'Dismissed')}
        </div>

        ${data.rows.length === 0
          ? html`<div class="card"><p class="muted" style="margin:0">${data.status === 'new' ? 'No new ideas. They appear after a scan.' : 'Nothing here.'}</p></div>`
          : html`<form method="post" action="/radar/${site.id}/add">
              <div class="card">
                <div class="table-wrap"><table>
                  <thead><tr>
                    ${data.status === 'new'
                      ? html`<th class="pick"><input type="checkbox" onclick="var on=this.checked;this.closest('table').querySelectorAll('tbody input').forEach(function(c){c.checked=on})" /></th>`
                      : raw('')}
                    <th>Idea</th><th>Goes to</th><th>Engagement</th><th>Posted</th><th>Came from</th>
                  </tr></thead>
                  <tbody>${data.rows.map(
                    (r) => html`<tr>
                      ${data.status === 'new' ? html`<td class="pick"><input type="checkbox" name="ids" value="${r.id}" /></td>` : raw('')}
                      <td>
                        <strong>${r.title}</strong>
                        <details style="margin-top:4px">
                          <summary class="small muted">the post it came from</summary>
                          <p class="small" style="white-space:pre-wrap;margin:6px 0 0">${r.text.slice(0, 1200)}</p>
                        </details>
                      </td>
                      <td>${r.kind === 'recipe'
                        ? html`<span class="badge ok">article</span> <span class="small muted">${r.topic}</span>`
                        : html`<span class="badge brand">blog question</span>`}</td>
                      <td><strong>${r.score}</strong>
                        <div class="small muted">${r.likes} likes · ${r.comments} comments · ${r.shares} shares</div></td>
                      <td class="small">${age(r.posted_at)}</td>
                      <td class="small">${r.url ? html`<a href="${r.url}" target="_blank" rel="noopener">post</a>` : html`<span class="muted">—</span>`}</td>
                    </tr>`,
                  )}</tbody>
                </table></div>
              </div>
              ${data.status === 'new'
                ? html`<div class="save-bar">
                    <button type="submit" class="primary">Add the ticked ones</button>
                    <button type="submit" formaction="/radar/${site.id}/dismiss" class="danger">Dismiss the ticked ones</button>
                    <span class="muted small">Ideas go to Keywords (their topic as the group), questions to Blog, for ${site.domain}. Dismissed ones never come back.</span>
                  </div>`
                : raw('')}
            </form>`}`
      : html`<div class="card"><p class="muted" style="margin:0">Add a site under Channels → Sites first.</p></div>`}
  `;
}

const tokenLine = (count: number, inUse: number): Html =>
  count === 0
    ? html`<span class="small muted">None saved.</span>`
    : count === 1
      ? html`<span class="badge ok">1 saved</span>`
      : html`<span class="badge ok">${count} saved</span> <span class="small muted">using token ${Math.min(inUse + 1, count)} of ${count}</span>`;

export function radarSetupPage(data: {
  provider: 'brightdata' | 'apify';
  brightdataTokens: number;
  apifyTokens: number;
  brightdataInUse: number;
  apifyInUse: number;
  perPage: number;
  minScore: number;
  sites: RadarSiteView[];
  sourcesBySite: Map<number, SocialSource[]>;
}): Html {
  return html`
    <h1>Radar setup</h1>
    <p class="subtitle">Once: a service that can read public pages, then the pages each site watches.</p>

    <form method="post" action="/radar/setup/provider" class="card">
      <h2 style="margin-top:0">1. The service</h2>
      <p class="small">Facebook's own API only lets an app read pages it manages, so reading someone else's page goes
        through one of these. Both have a free monthly allowance; neither asks for a card to start.</p>
      <div class="field" style="max-width:420px">
        <label>Which one</label>
        <select name="provider">
          <option value="brightdata" ${data.provider === 'brightdata' ? raw('selected') : raw('')}>Bright Data — 5,000 records a month free</option>
          <option value="apify" ${data.provider === 'apify' ? raw('selected') : raw('')}>Apify — $5 of compute a month free</option>
        </select>
      </div>
      <p class="small">Several tokens from several accounts are allowed in each box — one per line, or separated by
        commas. Each account has its own free allowance, so when one is spent the next takes over and scanning goes on
        from it. A token is only passed over when the service says it is spent or refused; a page that does not exist
        fails once rather than burning every token on the same dead handle.</p>
      <div class="field-row" style="margin-top:8px">
        <div class="field">
          <label>Bright Data API tokens ${tokenLine(data.brightdataTokens, data.brightdataInUse)}</label>
          <textarea name="brightdata" rows="3" placeholder="${data.brightdataTokens ? 'leave empty to keep what is saved' : 'one token per line'}"></textarea>
          <div class="help">brightdata.com → Account settings → API tokens. Saving replaces the whole list.</div>
        </div>
        <div class="field">
          <label>Apify API tokens ${tokenLine(data.apifyTokens, data.apifyInUse)}</label>
          <textarea name="apify" rows="3" placeholder="${data.apifyTokens ? 'leave empty to keep what is saved' : 'one token per line'}"></textarea>
          <div class="help">console.apify.com → Settings → API &amp; Integrations. Saving replaces the whole list.</div>
        </div>
      </div>
      <button type="submit" class="primary small" style="margin-top:8px">Save</button>
    </form>

    <form method="post" action="/radar/setup/options" class="card">
      <h2 style="margin-top:0">2. How much to read</h2>
      <div class="field-row">
        <div class="field">
          <label>Posts per page, per scan</label>
          <input type="number" name="per_page" min="5" max="100" value="${data.perPage}" />
          <div class="help">Each post is one record against the free allowance. 25 a day per page stays well inside it.</div>
        </div>
        <div class="field">
          <label>Least engagement for an idea</label>
          <input type="number" name="min_score" min="0" max="1000000" value="${data.minScore}" />
          <div class="help">Engagement is likes + 4× comments + 10× shares. 0 lets the AI judge everything read.</div>
        </div>
      </div>
      <button type="submit" class="small">Save</button>
    </form>

    <div class="card">
      <h2 style="margin-top:0">3. The pages each site watches</h2>
      ${data.sites.length === 0
        ? html`<p class="muted" style="margin:0">Add a site under Channels → Sites first.</p>`
        : data.sites.map((s) => {
            const sources = data.sourcesBySite.get(s.id) ?? [];
            return html`<div class="card" style="margin-top:10px">
              <form method="post" action="/radar/setup/site/${s.id}">
                <div class="spread">
                  <strong>${s.domain}</strong>
                  <label class="inline-check"><input type="checkbox" name="on" value="1" ${s.on ? raw('checked') : raw('')} /> Scan every day</label>
                </div>
                <div class="field-row" style="margin-top:8px">
                  <div class="field" style="max-width:200px"><label>At (hour, 0–23)</label><input type="number" name="hour" min="0" max="23" value="${s.hour}" /></div>
                </div>
                <div class="row wrap" style="gap:8px;align-items:center">
                  <button type="submit" class="primary small">Save</button>
                  ${reportLine(s.report)}
                </div>
              </form>

              ${sources.length
                ? html`<div class="table-wrap" style="margin-top:10px"><table>
                    <thead><tr><th>Page</th><th>Last scan</th><th></th></tr></thead>
                    <tbody>${sources.map(
                      (src) => html`<tr>
                        <td>
                          <a href="https://www.facebook.com/${src.handle}/" target="_blank" rel="noopener">${src.handle}</a>
                          ${src.enabled ? raw('') : html` <span class="badge muted">off</span>`}
                          ${src.last_error ? html`<div class="small error-text">${src.last_error}</div>` : raw('')}
                        </td>
                        <td class="small">${src.last_scan_at ?? '—'}</td>
                        <td class="small">
                          <form method="post" action="/radar/setup/source/${src.id}/toggle" style="display:inline">
                            <input type="hidden" name="site" value="${s.id}" />
                            <input type="hidden" name="on" value="${src.enabled ? '0' : '1'}" />
                            <button type="submit" class="small">${src.enabled ? 'Pause' : 'Resume'}</button>
                          </form>
                          <form method="post" action="/radar/setup/source/${src.id}/remove" style="display:inline"
                                onsubmit="return confirm('Stop watching ${src.handle}?')">
                            <input type="hidden" name="site" value="${s.id}" />
                            <button type="submit" class="small danger">Remove</button>
                          </form>
                        </td>
                      </tr>`,
                    )}</tbody>
                  </table></div>`
                : html`<p class="help" style="margin:10px 0 0">No pages yet.</p>`}

              <form method="post" action="/radar/setup/site/${s.id}/source" class="row wrap" style="gap:8px;margin-top:10px">
                <input name="handle" placeholder="facebook.com/thepage  or  thepage" required style="flex:1;min-width:220px" />
                <button type="submit" class="small">Watch this page</button>
              </form>
            </div>`;
          })}
    </div>
  `;
}
