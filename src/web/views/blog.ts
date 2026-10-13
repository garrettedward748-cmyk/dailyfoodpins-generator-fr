import { emptyState, html, Html, raw, timeAgo } from './layout.js';
import type { BlogQuestionRow, BlogSiteRow } from '../../blog/repo.js';

export interface BlogSiteView extends BlogSiteRow {
  queued: number;
  suggested: number;
  doneToday: number;
}

type QuestionView = BlogQuestionRow & { site_domain: string };

const STATUS_LABEL: Record<BlogQuestionRow['status'], string> = {
  suggested: 'to approve',
  queued: 'queued',
  working: 'writing…',
  done: 'published',
  failed: 'failed',
  skipped: 'skipped',
};

function hours(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

/** Why the blog is or is not writing on a site right now, in a few words. */
function blogState(s: { blog_enabled: number; status: string; queued: number; doneToday: number; blog_daily_target: number; blog_last_at: string | null; blog_interval_minutes: number }): { text: string; warn: boolean } {
  if (s.blog_enabled !== 1) return { text: 'Off — tick On and Save', warn: true };
  if (s.status !== 'active') return { text: 'Site paused', warn: true };
  if (s.queued === 0) return { text: 'No questions queued', warn: true };
  if (s.doneToday >= s.blog_daily_target) return { text: "Today's number reached", warn: false };
  const last = s.blog_last_at ? Date.parse(`${s.blog_last_at.replace(' ', 'T')}Z`) : 0;
  const wait = Math.ceil((last + s.blog_interval_minutes * 60_000 - Date.now()) / 60_000);
  if (wait > 0) return { text: `Next in ${wait >= 60 ? `${Math.floor(wait / 60)}h ${wait % 60}m` : `${wait}m`}`, warn: false };
  return { text: 'Due — writes when the recipe run is free', warn: false };
}

export function blogPage(data: { sites: BlogSiteView[]; questions: QuestionView[]; site?: number }): Html {
  const site = data.site ?? 0;
  // A site picked in the tabs above is the only one on this page.
  const shown = site ? data.sites.filter((s) => s.id === site) : data.sites;
  const questions = site ? data.questions.filter((q) => q.site_id === site) : data.questions;
  const suggested = questions.filter((q) => q.status === 'suggested');
  const rest = questions.filter((q) => q.status !== 'suggested');

  return html`
    <div class="spread">
      <div>
        <h1>Blog</h1>
        <p class="subtitle">
          Articles that answer the questions people ask Google. Each links one recipe and one or two
          other articles, carries a cover photo, and ends with the recipe's printable card. They run on
          their own clock, apart from recipes.
        </p>
      </div>
    </div>

    <h2>Schedule per site</h2>
    ${shown.length === 0
      ? html`<div class="card">${emptyState('Add a site under Channels → Sites first.')}</div>`
      : html`<div class="card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Site</th><th>On</th><th>Per day</th><th>Every</th>
                  <th>Queue</th><th>Today</th><th>Last</th><th></th>
                </tr>
              </thead>
              <tbody>
                ${shown.map(
                  (s) => html`<tr>
                    <td>
                      ${s.domain}
                      ${s.status !== 'active' ? html`<div class="small muted">site paused</div>` : raw('')}
                    </td>
                    <td colspan="3">
                      <form method="post" action="/blog/sites/${s.id}" class="row wrap" style="gap:8px;align-items:center">
                        <label class="inline-check" style="margin:0">
                          <input type="checkbox" name="enabled" ${s.blog_enabled === 1 ? raw('checked') : raw('')}
                                 aria-label="Blog on for ${s.domain}" /> On
                        </label>
                        <input type="number" name="daily" min="1" max="24" value="${s.blog_daily_target}" style="width:70px"
                               aria-label="Articles per day" />
                        <select name="interval" aria-label="Time between articles">
                          ${[60, 120, 180, 240, 360, 480, 720, 1440].map(
                            (m) => html`<option value="${m}" ${s.blog_interval_minutes === m ? raw('selected') : raw('')}>${hours(m)}</option>`,
                          )}
                          ${[60, 120, 180, 240, 360, 480, 720, 1440].includes(s.blog_interval_minutes)
                            ? raw('')
                            : html`<option value="${s.blog_interval_minutes}" selected>${hours(s.blog_interval_minutes)}</option>`}
                        </select>
                        <button type="submit" class="small">Save</button>
                      </form>
                    </td>
                    <td>
                      ${s.queued} queued
                      ${s.suggested ? html`<div class="small warn-text">${s.suggested} to approve</div>` : raw('')}
                    </td>
                    <td>${s.doneToday} / ${s.blog_daily_target}</td>
                    <td class="small muted">
                      ${s.blog_last_at ? timeAgo(s.blog_last_at) : 'never'}
                      <div class="${blogState(s).warn ? 'warn-text' : ''}">${blogState(s).text}</div>
                    </td>
                    <td class="nowrap">
                      <form method="post" action="/blog/sites/${s.id}/suggest" style="display:inline">
                        <button type="submit" class="small" title="Ask the model for new questions from this site's recipes">Suggest questions</button>
                      </form>
                      <form method="post" action="/blog/sites/${s.id}/write" style="display:inline">
                        <button type="submit" class="small primary" ${s.queued === 0 ? raw('disabled') : raw('')}
                                title="Write the next queued question now">Write one now</button>
                      </form>
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>
          <p class="small muted" style="margin-bottom:0">
            An article is written when the site is on, the time since the last one has passed, and today's
            number is not reached. When a queue runs dry, new questions are suggested here for you to approve.
          </p>
        </div>`}

    <h2>Add questions</h2>
    <div class="card">
      <form method="post" action="/blog/questions">
        <div class="row wrap" style="gap:12px;align-items:flex-end">
          ${site
            ? html`<input type="hidden" name="site_id" value="${site}" />`
            : html`<label style="min-width:220px">
            Site
            <select name="site_id" required>
              ${data.sites.map((s) => html`<option value="${s.id}">${s.domain}</option>`)}
            </select>
          </label>`}
        </div>
        <label style="display:block;margin-top:10px">
          Questions — one per line, as people type them into Google
          <textarea name="lines" rows="8" required
                    placeholder="How long does cheesecake need to cool before slicing?&#10;Can you freeze banana pudding?&#10;Why did my cheesecake crack in the oven?"></textarea>
        </label>
        <button type="submit" class="primary" style="margin-top:8px">Add to the queue</button>
        <span class="small muted">Duplicates are skipped, so pasting the same list twice is safe.</span>
      </form>
    </div>

    ${suggested.length > 0
      ? html`
          <h2>Suggested — approve before they are written</h2>
          <div class="card">
            <form method="post" action="/blog/questions/bulk">
              <div class="table-wrap">
                <table>
                  <thead><tr><th><input type="checkbox" onclick="for (const b of this.closest('form').querySelectorAll('input[name=ids]')) b.checked = this.checked" aria-label="Select all" /></th><th>Question</th>${site ? raw('') : html`<th>Site</th>`}</tr></thead>
                  <tbody>
                    ${suggested.map(
                      (q) => html`<tr>
                        <td><input type="checkbox" name="ids" value="${q.id}" checked aria-label="Select" /></td>
                        <td>${q.question}</td>
                        ${site ? raw('') : html`<td class="small muted">${q.site_domain}</td>`}
                      </tr>`,
                    )}
                  </tbody>
                </table>
              </div>
              <div class="row wrap" style="gap:8px;margin-top:10px">
                <button type="submit" name="action" value="approve" class="primary">Approve selected</button>
                <button type="submit" name="action" value="delete" class="danger"
                      onclick="var n=this.form.querySelectorAll('input[name=ids]:checked').length;return n===0||confirm('Delete '+n+' question(s)?')">Delete selected</button>
              </div>
            </form>
          </div>`
      : raw('')}

    <h2>Queue and history</h2>
    <div class="card">
      ${rest.length === 0
        ? emptyState('No questions yet. Paste some above, or press “Suggest questions”.')
        : html`<form method="post" action="/blog/questions/bulk">
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th class="pick"><input type="checkbox" title="Tick all" aria-label="Tick all"
                        onclick="var on=this.checked;this.closest('form').querySelectorAll('input[name=ids]').forEach(function(c){c.checked=on})" /></th><th>Question</th>${site ? raw('') : html`<th>Site</th>`}<th>Status</th><th>Result</th></tr>
                </thead>
                <tbody>
                  ${rest.map(
                    (q) => html`<tr>
                      <td><input type="checkbox" name="ids" value="${q.id}" aria-label="Select" /></td>
                      <td>${q.question}${q.source === 'ai' ? html` <span class="small muted">· suggested</span>` : raw('')}</td>
                      ${site ? raw('') : html`<td class="small muted">${q.site_domain}</td>`}
                      <td>${STATUS_LABEL[q.status]}${q.attempts > 1 ? html` <span class="small muted">(${q.attempts} tries)</span>` : raw('')}</td>
                      <td class="small">
                        ${q.post_url ? html`<a href="${q.post_url}" target="_blank" rel="noopener">open</a>` : raw('')}
                        ${q.error ? html`<span class="error">${q.error.slice(0, 160)}</span>` : raw('')}
                      </td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>
            <div class="row wrap" style="gap:8px;margin-top:10px">
              <button type="submit" name="action" value="retry">Put back in the queue</button>
              <button type="submit" name="action" value="delete" class="danger"
                      onclick="var n=this.form.querySelectorAll('input[name=ids]:checked').length;return n===0||confirm('Delete '+n+' question(s)?')">Delete selected</button>
            </div>
          </form>`}
    </div>
  `;
}
