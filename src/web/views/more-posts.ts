import { emptyState, html, Html, raw, timeAgo } from './layout.js';
import { ANGLES, type Network, type NetworkState, type PublishedRecipe } from '../../extra/engine.js';

const NETWORK_LABEL: Record<Network, string> = { pinterest: 'Pinterest', facebook: 'Facebook', instagram: 'Instagram' };
const NETWORK_NOTE: Record<Network, string> = {
  pinterest: 'New graphic and new description, on the board chosen as before',
  facebook: 'New picture and new post text',
  instagram: 'Another photo of the recipe and a new caption',
};

export interface MorePostsRecent {
  createdAt: string;
  domain: string;
  title: string;
  network: Network;
  angle: string;
  ok: boolean;
  detail: string;
  auto?: boolean;
}

export interface MorePostsData {
  site: number;
  sites: { id: number; domain: string }[];
  query: string;
  recipes: (PublishedRecipe & { posts: number })[];
  /** The recipe chosen, with where it can be posted now. */
  chosen?: { recipe: PublishedRecipe; states: NetworkState[]; usedAngles: string[] };
  gapDays: number;
  recent: MorePostsRecent[];
  busy: boolean;
  /** Each site's choice about the recipe link in these posts. */
  /** Showing the hidden recipes instead of the visible ones. */
  showHidden: boolean;
  hiddenCount: number;
}

function stateTag(s: NetworkState): Html {
  if (!s.available) return html`<span class="small muted">· ${s.reason}</span>`;
  if (s.waitDays > 0) return html`<span class="small warn-text">· ${s.reason}</span>`;
  return html`<span class="small" style="color:var(--ok, #2f7d4f)">· ready</span>`;
}

export function morePostsPage(data: MorePostsData): Html {
  const { chosen } = data;
  return html`
    <div class="spread">
      <div>
        <h1>More posts</h1>
        <p class="subtitle">
          New posts for a recipe that is already on the site. No new article is written: each post gets a
          new picture and new words from a new angle, and goes out the same way the first ones did.
        </p>
      </div>
    </div>

    ${data.busy
      ? html`<div class="card"><p style="margin:0" class="warn-text">A run is working right now. Posts made here wait their turn: try again in a few minutes.</p></div>`
      : raw('')}

    ${chosen
      ? html`
    <h2>2 · Where, and which angle</h2>
    <div class="card">
      <p style="margin-top:0"><strong>${chosen.recipe.title}</strong><br />
        <a class="small" href="${chosen.recipe.postUrl}" target="_blank" rel="noopener">${chosen.recipe.postUrl}</a></p>
      <form method="post" action="/more-posts">
        <input type="hidden" name="run_id" value="${chosen.recipe.runId}" />
        <input type="hidden" name="site" value="${data.site}" />
        ${chosen.states.map(
          (s) => html`<label class="inline-check" style="display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line, #e3e1db)">
            <input type="checkbox" name="networks" value="${s.network}" ${s.ready ? raw('checked') : raw('disabled')} style="margin-top:4px" />
            <span>
              <strong>${NETWORK_LABEL[s.network]}</strong> ${stateTag(s)}
              <span class="small muted" style="display:block">${NETWORK_NOTE[s.network]}${s.lastAt ? html` · last post ${timeAgo(s.lastAt)}` : raw('')}</span>
            </span>
          </label>`,
        )}

        <h3 style="margin-bottom:6px">Angle</h3>
        <div class="row wrap" style="gap:8px">
          <label class="inline-check"><input type="radio" name="angle" value="auto" checked /> Automatic (the next one not used yet)</label>
          ${ANGLES.map(
            (a) => html`<label class="inline-check"><input type="radio" name="angle" value="${a.id}" />
              ${a.label}${chosen.usedAngles.includes(a.id) ? html` <span class="small muted">(used)</span>` : raw('')}</label>`,
          )}
        </div>
        <p class="small muted">
          The picture gets a different graphic design from the earlier ones. Uses image generation and Buffer as the
          normal run does. Minimum gap per recipe and network: ${data.gapDays} day${data.gapDays === 1 ? '' : 's'}
          (Settings → General).
        </p>
        <button type="submit" class="primary" ${data.busy ? raw('disabled') : raw('')}>Make and schedule</button>
        <a class="button" href="/more-posts?site=${data.site}" style="margin-left:8px">Choose another recipe</a>
      </form>
    </div>`
      : html`
    <h2>1 · Recipe</h2>
    <div class="card">
      <form method="get" action="/more-posts" class="row wrap" style="gap:8px;align-items:flex-end">
        ${data.sites.length > 1
          ? html`<label>Site
              <select name="site">
                <option value="0" ${data.site === 0 ? raw('selected') : raw('')}>All sites</option>
                ${data.sites.map((s) => html`<option value="${s.id}" ${data.site === s.id ? raw('selected') : raw('')}>${s.domain}</option>`)}
              </select></label>`
          : data.site
            ? html`<input type="hidden" name="site" value="${data.site}" />`
            : raw('')}
        <label style="flex:1;min-width:200px">Search
          <input type="text" name="q" value="${data.query}" placeholder="red velvet" /></label>
        <button type="submit">Search</button>
      </form>
      <div class="row wrap" style="gap:8px;align-items:center;margin:10px 0">
        <form method="post" action="/more-posts/bulk" class="row wrap" style="gap:8px;align-items:center">
          <input type="hidden" name="site" value="${data.site}" />
          <input type="hidden" name="action" value="hide_old" />
          <span class="small muted">Hide recipes published more than</span>
          <input type="number" name="days" value="90" min="1" style="width:80px" />
          <span class="small muted">days ago</span>
          <button type="submit" class="small" onclick="return confirm('Hide these recipes from this list and from the automatic mode? The articles stay on the site.')">Hide</button>
        </form>
        <span style="flex:1"></span>
        ${data.showHidden
          ? html`<a class="button small" href="/more-posts?site=${data.site}">Back to the list</a>`
          : data.hiddenCount > 0
            ? html`<a class="button small" href="/more-posts?site=${data.site}&hidden=1">Hidden (${data.hiddenCount})</a>`
            : raw('')}
      </div>
      ${data.recipes.length === 0
        ? emptyState(data.showHidden ? 'No hidden recipe.' : 'No published recipe matches.')
        : html`<form method="post" action="/more-posts/bulk" id="bulk">
          <input type="hidden" name="site" value="${data.site}" />
          <div class="row wrap" style="gap:10px;align-items:center;margin:8px 0">
            ${data.showHidden
              ? html`<button type="submit" name="action" value="unhide" class="small">Bring selected back</button>`
              : html`<span class="small muted">On:</span>
                ${(['pinterest', 'facebook', 'instagram'] as Network[]).map(
                  (n) => html`<label class="small" style="display:inline-flex;gap:4px;align-items:center"><input type="checkbox" name="networks" value="${n}" checked /> ${NETWORK_LABEL[n]}</label>`,
                )}
                <button type="submit" name="action" value="make" class="small primary" ${data.busy ? raw('disabled') : raw('')}
                  onclick="return confirm('Make new posts for every selected recipe, on the networks ticked? Each takes a few minutes; a network still inside its gap is skipped.')">Make posts for selected</button>
                <button type="submit" name="action" value="hide" class="small"
                  onclick="return confirm('Hide the selected recipes from this list and from the automatic mode? The articles stay on the site.')">Hide selected</button>`}
            <span class="small muted" id="bulk-count"></span>
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th style="width:32px"><input type="checkbox" id="bulk-all" title="Select all" /></th><th>Recipe</th><th>Site</th><th>Published</th><th>More posts so far</th><th></th></tr></thead>
            <tbody>
              ${data.recipes.map(
                (r) => html`<tr>
                  <td><input type="checkbox" name="run_ids" value="${r.runId}" class="bulk-item" /></td>
                  <td>${r.title}</td>
                  <td class="small muted">${r.siteDomain}</td>
                  <td class="small muted">${timeAgo(r.publishedAt)}</td>
                  <td>${r.posts}</td>
                  <td class="nowrap"><a class="button small primary" href="/more-posts?site=${data.site}&run=${r.runId}">Choose</a></td>
                </tr>`,
              )}
            </tbody>
          </table></div>
          </form>
          <script>
            (function () {
              var all = document.getElementById('bulk-all');
              var items = Array.prototype.slice.call(document.querySelectorAll('.bulk-item'));
              var count = document.getElementById('bulk-count');
              function show() { var n = items.filter(function (i) { return i.checked; }).length; count.textContent = n ? n + ' selected' : ''; all.checked = n > 0 && n === items.length; }
              all.addEventListener('change', function () { items.forEach(function (i) { i.checked = all.checked; }); show(); });
              items.forEach(function (i) { i.addEventListener('change', show); });
              show();
            })();
          </script>`}
    </div>`}

    <h2>Recent extra posts</h2>
    <div class="card">
      ${data.recent.length === 0
        ? emptyState('Nothing made here yet.')
        : html`<div class="table-wrap"><table>
            <thead><tr><th>When</th><th>Recipe</th><th>Where</th><th>Angle</th><th>Result</th></tr></thead>
            <tbody>
              ${data.recent.map(
                (r) => html`<tr>
                  <td class="small muted">${timeAgo(r.createdAt)}</td>
                  <td>${r.title.replace(/^More posts · [^·]+· /, '')}<div class="small muted">${r.domain}</div></td>
                  <td>${NETWORK_LABEL[r.network]}</td>
                  <td>${r.angle}${r.auto ? html` <span class="small muted">(auto)</span>` : ''}</td>
                  <td class="${r.ok ? '' : 'warn-text'}">${r.ok ? 'scheduled' : r.detail || 'failed'}</td>
                </tr>`,
              )}
            </tbody>
          </table></div>`}
    </div>
  `;
}
