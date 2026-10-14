import { html, raw, type Html } from './layout.js';
import type { ResearchItem, ResearchResult, TopicIdea, TopicIdeas } from '../../research/keywords.js';
import { MAX_TOPICS } from '../../research/batch.js';

/** How many of the best are ticked at first; the "Tick the best" boxes change it. */
const DEFAULT_PICK = 10;

/** Tick the first N usable rows of a list (best first), untick the rest. */
const PICK_SCRIPT = `<script>
function pickBest(name, n) {
  n = Math.max(0, parseInt(n, 10) || 0);
  var k = {};
  document.querySelectorAll('input[name=' + name + ']').forEach(function (c) {
    var g = c.dataset.group || '0';
    k[g] = k[g] || 0;
    c.checked = c.dataset.usable === '1' && k[g]++ < n;
  });
}
</script>`;

const SOURCE: Record<ResearchItem['source'], string> = {
  autocomplete: 'Autocomplete',
  related: 'Related',
  'people-also-ask': 'People also ask',
};

/** Content -> Research: real Google searches in, keywords and blog questions out. */
export interface AutoSiteView {
  id: number;
  domain: string;
  on: boolean;
  niche: string;
  recipes: number;
  questions: number;
  ttl: number;
  hour: number;
  report: { day: string; topic: string; added: number; questions: number; removedKeywords: number; removedQuestions: number; error?: string } | null;
}

function autoSection(sites: AutoSiteView[]): Html {
  if (sites.length === 0) return raw('');
  return html`
    <details class="card" ${sites.some((s) => s.on) ? raw('open') : raw('')}>
      <summary><strong>Daily auto research</strong> <span class="muted small">— every day, fresh keywords and questions go in by themselves; unwritten ones expire</span></summary>
      <p class="help">
        Once a day at the hour set, for each site switched on: what it added before and was not written in time is removed
        (keywords you add by hand are never touched), then it picks a topic in the niche — in season first, not repeating one
        for 14 days — researches it, and adds the best recipes to Keywords and the best questions to Blog.
      </p>
      ${sites.map(
        (s) => html`<form method="post" action="/research/auto/${s.id}" class="card" style="margin-top:12px">
          <div class="spread">
            <strong>${s.domain}</strong>
            <label class="inline-check"><input type="checkbox" name="on" value="1" ${s.on ? raw('checked') : raw('')} /> On</label>
          </div>
          <div class="field-row" style="margin-top:10px">
            <div class="field"><label>Niche</label><input name="niche" value="${s.niche}" placeholder="e.g. dessert" /></div>
            <div class="field"><label>Recipes a day</label><input type="number" min="0" max="50" name="recipes" value="${s.recipes}" /></div>
            <div class="field"><label>Questions a day</label><input type="number" min="0" max="50" name="questions" value="${s.questions}" /></div>
            <div class="field"><label>Expire unwritten after (hours)</label><input type="number" min="1" max="720" name="ttl" value="${s.ttl}" /></div>
            <div class="field"><label>At (hour, 0–23)</label><input type="number" min="0" max="23" name="hour" value="${s.hour}" /></div>
          </div>
          <div class="row wrap">
            <button type="submit" class="primary small">Save</button>
            <button type="submit" class="small" formaction="/research/auto/${s.id}/run" title="Save and run today's research now">Run now</button>
            ${s.report
              ? html`<span class="small muted">Last: ${s.report.day} ·
                  ${s.report.error
                    ? html`<span class="badge error">failed</span> ${s.report.error}`
                    : html`“${s.report.topic}” — +${s.report.added} recipes, +${s.report.questions} questions; removed ${s.report.removedKeywords} + ${s.report.removedQuestions} unwritten`}</span>`
              : html`<span class="small muted">Not run yet.</span>`}
          </div>
        </form>`,
      )}
    </details>`;
}

export function researchPage(data: {
  sites: { id: number; domain: string }[];
  auto?: AutoSiteView[];
  topics: string[];
  perTopic: number;
  niche?: string;
  ideas?: TopicIdeas | null;
  job: { done: number; total: number; finished: boolean } | null;
  results: ResearchResult[] | null;
  hasSerper: boolean;
  /** The sites ticked on the search form; they arrive ticked on the results too. */
  selectedSites?: number[];
  /** A site chosen in the tabs above the page: the only one, so nothing to tick. */
  scopedSite?: number;
  /** The search the results belong to, so a failed "Add" can come back to them. */
  jobId?: string | null;
}): Html {
  const { results } = data;
  const picked = new Set(data.selectedSites ?? []);
  const only = data.scopedSite ? data.sites.find((s) => s.id === data.scopedSite) : undefined;
  const sitePicker = only
    ? html`<div><strong>${only.domain}</strong> <span class="muted small">— chosen in the tabs above</span>
        <input type="checkbox" name="site_ids" value="${only.id}" checked style="display:none" /></div>`
    : html`<div class="row wrap" style="gap:14px">
    ${data.sites.map(
      (s) => html`<label class="inline-check"><input type="checkbox" name="site_ids" value="${s.id}" ${data.sites.length === 1 || picked.has(s.id) ? raw('checked') : raw('')} /> ${s.domain}</label>`,
    )}
  </div>`;

  const rows = (items: ResearchItem[], name: string, kind: 'recipe' | 'question', group: number, topic: string) => {
    let picked = 0;
    return items.length === 0
      ? html`<p class="muted small">Nothing found.</p>`
      : html`<div class="table-wrap"><table>
          <thead><tr>
            <th class="pick"><input type="checkbox" checked onclick="var on=this.checked;this.closest('table').querySelectorAll('tbody input:not(:disabled)').forEach(function(c){c.checked=on})" /></th>
            <th>${kind === 'recipe' ? 'Keyword' : 'Question'}</th><th>Source</th><th>Note</th>
          </tr></thead>
          <tbody>${items.map((i) => {
            const off = Boolean(i.existing);
            const usable = !off && !i.broad;
            const checked = usable && ++picked <= DEFAULT_PICK;
            const value = kind === 'recipe' ? `${topic}||${i.text}` : i.text;
            return html`<tr>
              <td class="pick"><input type="checkbox" name="${name}" value="${value}" data-group="${group}" ${usable ? raw('data-usable="1"') : raw('')} ${checked ? raw('checked') : raw('')} ${off ? raw('disabled') : raw('')} /></td>
              <td>${off ? html`<span class="muted">${i.text}</span>` : i.text}</td>
              <td><span class="badge muted">${SOURCE[i.source]}</span></td>
              <td class="small muted">${off
                ? html`already have: ${i.existing}`
                : i.broad
                  ? 'a list of dishes, not one recipe'
                  : html`${i.top ? html`<span class="badge ok">top search</span> ` : ''}${i.elsewhere ? html`<span class="badge muted">already on ${i.elsewhere}</span>` : ''}`}</td>
            </tr>`;
          })}</tbody>
        </table></div>`;
  };

  const running = data.job && !data.job.finished;

  return html`
    <h1>Keyword research</h1>
    <p class="subtitle">
      Pick one or more topics. The platform collects what people really search on Google about each,
      removes what you already have, and splits it into recipes (for Keywords) and questions (for Blog).
    </p>

    ${autoSection(data.auto ?? [])}

    <form method="get" action="/research" class="card"
          onsubmit="var f=this;f.querySelectorAll('input[data-sites]').forEach(function(x){x.remove()});document.querySelectorAll('#topic-form input[name=site_ids]:checked').forEach(function(c){var h=document.createElement('input');h.type='hidden';h.name='site_ids';h.value=c.value;h.setAttribute('data-sites','1');f.appendChild(h)})">
      <div class="field-row">
        <div class="field">
          <label>Not sure what to search? Your site's niche</label>
          <input name="niche" value="${data.niche ?? data.ideas?.niche ?? ''}" placeholder="e.g. dessert" />
        </div>
        <div class="field field-action"><button type="submit">Topic ideas</button></div>
      </div>
      <p class="help" style="margin:0">Google's most searched topics in the niche, plus what is in season for the next weeks. Click topics to add them to the search.</p>
    </form>

    ${data.ideas ? ideaChips(data.ideas) : raw('')}

    <form method="get" action="/research" class="card" id="topic-form">
      ${data.niche ? html`<input type="hidden" name="niche" value="${data.niche}" />` : raw('')}
      <label>Topics <span class="muted small">— up to ${MAX_TOPICS}</span></label>
      <div class="tag-box" id="topic-tags">
        ${data.topics.map((t) => html`<span class="tag" data-topic="${t}">${t}<button type="button" aria-label="Remove">×</button><input type="hidden" name="seed" value="${t}" /></span>`)}
        <input type="text" id="topic-input" placeholder="Click topics above, or type one and press Enter" autocomplete="off" />
      </div>
      ${data.sites.length > 0
        ? html`<div class="field" style="margin-top:10px">
            <label>Send to <span class="muted small">— the sites that get the recipes (Keywords) and the questions (Blog)</span></label>
            ${sitePicker}
          </div>`
        : raw('')}
      <div class="field-row" style="margin-top:10px">
        <div class="field">
          <label>Results per topic</label>
          <input type="number" name="per" min="1" max="50" value="${data.perTopic}" />
          <div class="help">The best of each list, recipes and questions each.</div>
        </div>
        <div class="field field-action"><button type="submit" class="primary" ${running ? raw('disabled') : raw('')}>Find keywords</button></div>
      </div>
      <p class="help" style="margin:0">
        About a minute per topic, two at a time (Google, then an AI clean-up). ${data.hasSerper ? 'Autocomplete + People also ask + related searches.' : raw('Autocomplete only — add a Serper key under <a href="/settings">Setup → General</a> for “People also ask” and related searches.')}
      </p>
    </form>
    ${raw(TOPIC_SCRIPT)}

    ${running
      ? html`<div class="card"><strong>Searching Google…</strong>
          <span class="muted">${data.job!.done} of ${data.job!.total} topic(s) done. This page refreshes by itself.</span></div>
          <script>setTimeout(function () { location.reload(); }, 4000);</script>`
      : raw('')}

    ${results
      ? html`
        ${results.flatMap((r) => r.notes).map((n) => html`<div class="flash warn">${n}</div>`)}
        <form method="post" action="/research/import">
          ${data.jobId ? html`<input type="hidden" name="job" value="${data.jobId}" />` : raw('')}
          <div class="card">
            <label>Publish on</label>
            ${sitePicker}
            <div class="help">Each recipe goes into its own topic's group, which links it to a Pinterest board (Channels → Pinterest).</div>
          </div>

          <div class="card">
            <div class="field-row">
              <div class="field">
                <label>Tick the best recipes (per topic)</label>
                <input type="number" min="0" max="${data.perTopic}" value="${Math.min(DEFAULT_PICK, data.perTopic)}" oninput="pickBest('recipes', this.value)" />
              </div>
              <div class="field">
                <label>Tick the best questions (per topic)</label>
                <input type="number" min="0" max="${data.perTopic}" value="${Math.min(DEFAULT_PICK, data.perTopic)}" oninput="pickBest('questions', this.value)" />
              </div>
            </div>
            <div class="help">Lists are in order of Google popularity, best first. Type a number and that many are ticked from the top of each topic.</div>
          </div>
          ${raw(PICK_SCRIPT)}

          ${results.map(
            (r, g) => html`
              <h2>${r.seed}</h2>
              <h3>Recipes <span class="count">${r.recipes.filter((i) => !i.existing).length}</span></h3>
              <div class="card">${rows(r.recipes, 'recipes', 'recipe', g, r.seed)}</div>
              <h3>Questions for the blog <span class="count">${r.questions.length}</span></h3>
              <div class="card">${rows(r.questions, 'questions', 'question', g, r.seed)}</div>`,
          )}

          <div class="save-bar">
            <button type="submit" class="primary">Add the ticked ones</button>
            <span class="muted small">Recipes go to Keywords, questions to Blog, on the ticked sites. Repeats are skipped.</span>
          </div>
        </form>`
      : raw('')}
  `;
}

/** Topic chips add to the search; the box holds them as tags. */
const TOPIC_SCRIPT = `<script>
(function () {
  var box = document.getElementById('topic-tags');
  var input = document.getElementById('topic-input');
  var form = document.getElementById('topic-form');
  if (!box || !input || !form) return;
  var MAX = ${MAX_TOPICS};
  function tags() { return Array.prototype.slice.call(box.querySelectorAll('.tag')); }
  function has(t) { return tags().some(function (el) { return el.dataset.topic === t; }); }
  function mark() {
    document.querySelectorAll('[data-add-topic]').forEach(function (b) {
      b.classList.toggle('primary', has(b.dataset.addTopic));
    });
  }
  function add(t) {
    t = (t || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    if (!t || has(t)) return;
    if (tags().length >= MAX) { alert('Up to ' + MAX + ' topics at a time.'); return; }
    var el = document.createElement('span');
    el.className = 'tag';
    el.dataset.topic = t;
    el.appendChild(document.createTextNode(t));
    var x = document.createElement('button');
    x.type = 'button'; x.setAttribute('aria-label', 'Remove'); x.textContent = '×';
    el.appendChild(x);
    var h = document.createElement('input');
    h.type = 'hidden'; h.name = 'seed'; h.value = t;
    el.appendChild(h);
    box.insertBefore(el, input);
    mark();
  }
  function remove(t) {
    tags().forEach(function (el) { if (el.dataset.topic === t) el.remove(); });
    mark();
  }
  box.addEventListener('click', function (e) {
    var b = e.target.closest('.tag button');
    if (b) remove(b.parentNode.dataset.topic); else input.focus();
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(input.value); input.value = ''; }
    else if (e.key === 'Backspace' && !input.value) { var t = tags(); if (t.length) remove(t[t.length - 1].dataset.topic); }
  });
  document.addEventListener('click', function (e) {
    var chip = e.target.closest('[data-add-topic]');
    if (!chip) return;
    e.preventDefault();
    if (has(chip.dataset.addTopic)) remove(chip.dataset.addTopic); else add(chip.dataset.addTopic);
  });
  form.addEventListener('submit', function (e) {
    if (input.value.trim()) { add(input.value); input.value = ''; }
    if (!tags().length) { e.preventDefault(); alert('Pick or type at least one topic.'); return; }
    if (form.querySelector('input[name=site_ids]') && !form.querySelector('input[name=site_ids]:checked')) {
      e.preventDefault(); alert('Tick at least one site to send to.');
    }
  });
  mark();
})();
</script>`;

function ideaChips(ideas: TopicIdeas): Html {
  const chip = (t: TopicIdea) =>
    html`<button type="button" class="button small" data-add-topic="${t.topic}" title="${t.why}">${t.topic}</button>`;
  return html`
    ${ideas.notes.map((n) => html`<div class="flash warn">${n}</div>`)}
    ${ideas.topics.length
      ? html`<div class="card">
          <h3 style="margin-top:0">Most searched in “${ideas.niche}”</h3>
          <div class="row wrap" style="gap:8px">${ideas.topics.map(chip)}</div>
          <p class="help" style="margin-bottom:0">Named by AI, then checked on Google: only topics Google suggests many searches for are kept, most suggested first. Click to add to the search; click again to take it out.</p>
        </div>`
      : raw('')}
    ${ideas.seasonal.length
      ? html`<div class="card">
          <h3 style="margin-top:0">In season soon <span class="muted small">— publish 4–6 weeks ahead for Pinterest</span></h3>
          <div class="row wrap" style="gap:8px">${ideas.seasonal.map(chip)}</div>
        </div>`
      : raw('')}
  `;
}
