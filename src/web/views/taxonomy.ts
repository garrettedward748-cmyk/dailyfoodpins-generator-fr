import { html, raw, type Html } from './layout.js';
import { MIN_RECIPES, type TaxonomyJobRow, type TaxonomyReport } from '../../taxonomy/engine.js';

/**
 * Taxonomy: its own section. The site's category, cuisine and tag pages,
 * filled by the platform -- text by the AI, pictures by Flow -- one term at a
 * time, only what is empty.
 */

export interface TaxonomySiteView {
  id: number;
  domain: string;
  on: boolean;
  running: boolean;
  report: TaxonomyReport | null;
  jobs: TaxonomyJobRow[];
}

const KIND: Record<string, string> = { categories: 'Category', cuisines: 'Cuisine', tags: 'Tag' };

const reportLine = (r: TaxonomyReport | null): Html =>
  !r
    ? html`<span class="small muted">Not scanned yet.</span>`
    : r.error
      ? html`<span class="badge error">failed</span> <span class="small">${r.error}</span>`
      : html`<span class="small muted">Last scan ${r.at.slice(0, 16).replace('T', ' ')} UTC: ${r.total} terms,
          <strong>${r.pending}</strong> still to fill, ${r.missingImages} categories/cuisines without a picture,
          ${r.thinTags} tags under ${MIN_RECIPES} recipes (left alone, kept out of Google until they grow).</span>`;

export function taxonomyPage(data: { sites: TaxonomySiteView[]; imagePrompt: string; defaultPrompt: string }): Html {
  return html`
    <h1>Taxonomy</h1>
    <p class="subtitle">
      The site's category, cuisine and tag pages, filled automatically: title tag, meta description, intro and long
      text by the AI; a picture for each category and cuisine made in Flow. Only empty fields are filled — what you
      typed in the site's Admin → Taxonomy is never changed. One term every few minutes, under the same lock as the
      recipe runs.
    </p>

    ${data.sites.map((s) => {
      const failed = s.jobs.filter((j) => j.status === 'failed').length;
      return html`
        <div class="card">
          <div class="spread">
            <strong>${s.domain}</strong>
            <div class="row wrap" style="gap:8px;align-items:center">
              <form method="post" action="/taxonomy/${s.id}/switch" style="margin:0">
                <input type="hidden" name="on" value="${s.on ? '0' : '1'}" />
                <button type="submit" class="small ${s.on ? '' : 'primary'}">${s.on ? 'Turn off' : 'Turn on'}</button>
              </form>
              <form method="post" action="/taxonomy/${s.id}/run" style="margin:0">
                <button type="submit" class="small" ${s.running ? raw('disabled') : raw('')}>${s.running ? 'Filling…' : 'Fill now'}</button>
              </form>
              ${failed
                ? html`<form method="post" action="/taxonomy/${s.id}/retry" style="margin:0"><button type="submit" class="small">Retry failed (${failed})</button></form>`
                : raw('')}
            </div>
          </div>
          <div style="margin-top:6px">
            <span class="badge ${s.on ? 'ok' : 'muted'}">${s.on ? 'On' : 'Off'}</span>
            ${reportLine(s.report)}
          </div>
          ${s.jobs.length
            ? html`<details style="margin-top:10px"><summary class="small">Filled terms (${s.jobs.length})</summary>
                <table class="table" style="margin-top:8px">
                  <thead><tr><th>Term</th><th>Filled</th><th>When</th><th></th></tr></thead>
                  <tbody>
                    ${s.jobs.map((j) => html`<tr>
                      <td><span class="small muted">${KIND[j.tbl] ?? j.tbl}</span> ${j.name}</td>
                      <td class="small">${j.filled || '—'}</td>
                      <td class="small muted">${j.updated_at}</td>
                      <td>${j.status === 'failed'
                        ? html`<span class="badge error" title="${j.error}">failed ×${j.attempts}</span> <span class="small">${j.error}</span>`
                        : html`<span class="badge ok">done</span>`}</td>
                    </tr>`)}
                  </tbody>
                </table></details>`
            : raw('')}
        </div>`;
    })}

    <form method="post" action="/taxonomy/prompt" class="card">
      <h2 style="margin-top:0">Picture prompt (categories and cuisines)</h2>
      <p class="small muted">Sent to Flow for every category and cuisine without a picture. <code>{{name}}</code> is the
        term ("Breakfast", "Mexican"), <code>{{kind}}</code> is "category" or "cuisine". Kept here, apart from the other
        prompts. The text prompt is <a href="/prompts">Setup → Prompts → taxonomy-fill</a>.</p>
      <textarea name="prompt" rows="6" style="width:100%">${data.imagePrompt || data.defaultPrompt}</textarea>
      <div class="row" style="gap:8px;margin-top:8px">
        <button type="submit" class="primary small">Save</button>
        <button type="submit" class="small" name="reset" value="1">Back to the default</button>
      </div>
    </form>
  `;
}
