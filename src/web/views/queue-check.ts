import { html, raw, type Html } from './layout.js';
import type { QueueCheckJob } from '../../research/queue-check.js';

/** Keywords -> Check the queue. */
export function queueCheckPage(job: QueueCheckJob | undefined, queued: number): Html {
  const running = job && !job.finished;
  return html`
    <p class="small"><a href="/keywords">&larr; Keywords</a></p>
    <h1>Check the queue</h1>
    <p class="subtitle">
      Finds the waiting keywords that are not one dish — topics, occasions, lists — which the writer would refuse anyway,
      after spending a model call on each. Nothing is removed until you press the button; removed keywords are set to
      <span class="mono">no</span>, not deleted.
    </p>

    <form method="post" action="/keywords/check" class="card">
      <div class="spread">
        <span>${queued} keyword(s) waiting. About ${Math.max(1, Math.ceil(queued / 80))} model call(s) to check them all.</span>
        <button type="submit" class="primary" ${running ? raw('disabled') : raw('')}>${job ? 'Check again' : 'Check the queue'}</button>
      </div>
    </form>

    ${running
      ? html`<div class="card"><strong>Checking…</strong>
          <span class="muted">${job!.checked} of ${job!.total} looked at, ${job!.flags.length} flagged so far. This page refreshes by itself.</span></div>
          <script>setTimeout(function () { location.reload(); }, 4000);</script>`
      : raw('')}

    ${job?.errors.length
      ? html`<div class="flash warn">${job.errors.length} batch(es) could not be checked (${job.errors[0]}). Run the check again to cover them.</div>`
      : raw('')}

    ${job && job.finished
      ? job.flags.length === 0
        ? html`<div class="card">Nothing to remove: every waiting keyword looks like one dish.</div>`
        : html`<form method="post" action="/keywords/check/remove">
            <div class="card">
              <div class="spread">
                <strong>${job.flags.length} keyword(s) that are not one dish</strong>
                <span class="muted small">Untick any you want to keep.</span>
              </div>
              <div class="table-wrap"><table>
                <thead><tr>
                  <th class="pick"><input type="checkbox" checked onclick="var on=this.checked;this.closest('table').querySelectorAll('tbody input').forEach(function(c){c.checked=on})" /></th>
                  <th>Keyword</th><th>Topic group</th><th>Why</th>
                </tr></thead>
                <tbody>${job.flags.map(
                  (f) => html`<tr>
                    <td class="pick"><input type="checkbox" name="ids" value="${f.id}" checked /></td>
                    <td>${f.title}</td>
                    <td class="muted small">${f.group}</td>
                    <td class="small">${f.why}</td>
                  </tr>`,
                )}</tbody>
              </table></div>
            </div>
            <div class="save-bar">
              <button type="submit" class="primary">Remove the ticked ones from the queue</button>
              <span class="muted small">They are set to “no” and can be set back to “go” on the Keywords page.</span>
            </div>
          </form>`
      : raw('')}
  `;
}
