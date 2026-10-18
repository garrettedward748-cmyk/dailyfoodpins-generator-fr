import { emptyState, html, Html, raw } from './layout.js';

export interface GoogleAccountView {
  id: number;
  label: string;
  status: 'ok' | 'cooldown' | 'signed_out';
  until: number | null;
  reason: string | null;
  active: boolean;
  project_id?: string;
  daily_limit?: number | null;
  monthly_limit?: number | null;
  used_today?: number;
  used_month?: number;
  /** Whether this account is allowed to make still images. Default true. */
  images?: boolean;
  /** Whether this account is allowed to make video (reels). Default true. */
  video?: boolean;
}

function restEnds(until: number | null): string {
  if (!until) return '';
  const minutes = Math.max(0, Math.round((until * 1000 - Date.now()) / 60_000));
  return minutes >= 60 ? `back in ${Math.round(minutes / 60)} h` : `back in ${minutes} min`;
}

/** Setup -> Google accounts: the Flow accounts the image service rotates through. */
/** A cost bigger than a limit means the account can never make a single clip. */
function limitBlocksEveryClip(a: GoogleAccountView, cost: number): boolean {
  if (cost <= 0) return false;
  return (a.daily_limit != null && cost > a.daily_limit) || (a.monthly_limit != null && cost > a.monthly_limit);
}

export function googleAccountsPage(data: {
  reachable: boolean;
  error?: string;
  accounts: GoogleAccountView[];
  pending: number | null;
  clipCost?: number;
  /** The sign-in running or just finished, when the page was opened for one. */
  login?: { id: number; state: string; message: string; running: boolean } | null;
  /** A saved copy holds accounts the service has lost, e.g. after a restore on a new server. */
  restore?: { count: number } | null;
}): Html {
  const many = data.accounts.length > 1;
  const clipCost = data.clipCost ?? 0;
  const blocked = data.accounts.filter((a) => a.video !== false && limitBlocksEveryClip(a, clipCost));
  return html`
    <h1>Google accounts</h1>
    <p class="subtitle">
      Images and reels are made in Google Flow with one account at a time. When it runs out of
      credits, is signed out, or keeps failing, the next account takes over on its own. Only one
      browser ever runs, so more accounts cost disk space, not speed or memory.
      Each account uses its own Flow project for every site: a project only works with the
      account that created it.
    </p>

    ${!data.reachable
      ? html`<div class="flash error">The image service did not answer${data.error ? `: ${data.error}` : ''}.</div>`
      : html`
          ${data.pending
            ? html`<div class="flash warn">Switching to account #${data.pending} as soon as the current image is finished.</div>`
            : raw('')}
          ${data.restore
            ? html`<div class="flash warn">
                A saved copy of the accounts (from a backup) has ${data.restore.count} that this image service does not have yet.
                <form method="post" action="/settings/google/restore" style="display:inline;margin-left:8px">
                  <button type="submit" class="small primary">Restore the accounts</button>
                </form>
                <div class="small muted">Names, Flow projects, limits and what each may make come back. The Google sign-ins do not: sign each account in again.</div>
              </div>`
            : raw('')}
          <div class="card">
            ${data.accounts.length === 0
              ? emptyState('No accounts.')
              : html`<div class="table-wrap">
                  <table>
                    <thead><tr><th>#</th><th>Account</th><th>State</th><th>Makes</th><th>Flow project ID</th><th>Credit limits</th><th></th></tr></thead>
                    <tbody>
                      ${data.accounts.map(
                        (a) => html`<tr>
                          <td>${a.id}</td>
                          <td>
                            ${a.label}
                            ${a.active ? html` <span class="badge ok">in use</span>` : raw('')}
                          </td>
                          <td>
                            ${a.status === 'ok'
                              ? html`<span class="badge ok">ready</span>`
                              : a.status === 'cooldown'
                                ? html`<span class="badge warn">resting</span> <span class="small muted">${restEnds(a.until)}</span>`
                                : html`<span class="badge error">needs sign-in</span>`}
                            ${a.reason ? html`<div class="small muted">${a.reason}</div>` : raw('')}
                            ${!a.project_id
                              ? html`<div><span class="badge warn">needs project ID</span></div>`
                              : raw('')}
                          </td>
                          <td>
                            <form method="post" action="/settings/google/${a.id}/capabilities" class="col" style="gap:4px">
                              <label class="small" style="margin:0;white-space:nowrap">
                                <input type="checkbox" name="images" value="1" ${a.images !== false ? raw('checked') : raw('')} /> Images
                              </label>
                              <label class="small" style="margin:0;white-space:nowrap" title="Video is Google's most closely watched resource — keep it to warmed-up accounts">
                                <input type="checkbox" name="video" value="1" ${a.video !== false ? raw('checked') : raw('')} /> Video
                              </label>
                              <button type="submit" class="small" style="margin-top:2px">Save</button>
                            </form>
                          </td>
                          <td>
                            <form method="post" action="/settings/google/${a.id}/project" class="row" style="gap:6px;flex-wrap:nowrap">
                              <input name="project_id" value="${a.project_id ?? ''}" placeholder="paste the project ID or its link"
                                     style="min-width:200px" />
                              <button type="submit" class="small">Save</button>
                            </form>
                            ${!a.project_id && a.status !== 'signed_out'
                              ? html`<form method="post" action="/settings/google/${a.id}/project/create" style="margin-top:4px">
                                  <button type="submit" class="small primary" title="Press New project in Flow on this account and save its ID">Create one for me</button>
                                </form>`
                              : raw('')}
                          </td>
                          <td>
                            <form method="post" action="/settings/google/${a.id}/limits" class="row" style="gap:6px;flex-wrap:nowrap;align-items:flex-end">
                              <label class="small" style="margin:0">Day
                                <input type="number" min="0" name="daily_limit" value="${a.daily_limit ?? ''}" placeholder="none" style="width:80px" />
                              </label>
                              <label class="small" style="margin:0">Month
                                <input type="number" min="0" name="monthly_limit" value="${a.monthly_limit ?? ''}" placeholder="none" style="width:80px" />
                              </label>
                              <button type="submit" class="small">Save</button>
                            </form>
                            <div class="small muted">used ${a.used_today ?? 0} today · ${a.used_month ?? 0} this month</div>
                            ${a.video !== false && limitBlocksEveryClip(a, clipCost)
                              ? html`<div class="small" style="color:var(--danger, #e5484d)">One clip (${clipCost}) is more than this limit: this account can never make a reel.</div>`
                              : raw('')}
                          </td>
                          <td class="nowrap">
                            <form method="post" action="/settings/google/${a.id}/use" style="display:inline">
                              <button type="submit" class="small ${a.status === 'signed_out' ? 'primary' : ''}"
                                      title="Make this the account in use and open it in the browser">
                                ${a.status === 'signed_out' ? 'Sign in' : a.active ? 'Open' : 'Use now'}
                              </button>
                            </form>
                            <form method="post" action="/settings/google/${a.id}/reset" style="display:inline"
                                  onsubmit="return confirm('Reset this account? It stops resting and today\\'s credit count starts from zero.')">
                              <button type="submit" class="small" title="End the rest and start today's count over">Reset</button>
                            </form>
                            ${many
                              ? html`<form method="post" action="/settings/google/${a.id}/remove" style="display:inline"
                                           onsubmit="return confirm('Remove this account and its saved sign-in?${a.active ? ' The next account takes over.' : ''}')">
                                  <button type="submit" class="small danger">Remove</button>
                                </form>`
                              : raw('')}
                          </td>
                        </tr>`,
                      )}
                    </tbody>
                  </table>
                </div>`}

            ${blocked.length
              ? html`<div class="flash error" style="margin-top:14px">
                  One video clip is set to cost ${clipCost} credits, more than the limit of account${blocked.length === 1 ? '' : 's'}
                  ${blocked.map((a) => `#${a.id}`).join(', ')}: ${blocked.length === 1 ? 'it' : 'they'} can never make a reel.
                  Set the real cost (about 20), or 0 to stop counting.
                </div>`
              : raw('')}
            <form method="post" action="/settings/google/clip-cost" class="row wrap" style="gap:8px;margin-top:14px;align-items:flex-end">
              <div class="field" style="margin:0;min-width:220px">
                <label for="g-cost">Credits one video clip costs</label>
                <input id="g-cost" type="number" min="0" name="clip_cost" value="${clipCost}" style="width:120px" />
              </div>
              <button type="submit">Save</button>
              <span class="small muted" style="max-width:420px">
                0 = clips are not counted: no limit stops an account, it works until Google says its credits are gone.
                Above 0, a reel is several clips: with a limit set, the account hands over before the next clip would pass it,
                and rests until the next day or month. Leave a limit blank for none.
              </span>
            </form>

            <form method="post" action="/settings/google/add" class="row wrap" style="gap:8px;margin-top:14px;align-items:flex-end">
              <div class="field" style="margin:0;min-width:220px">
                <label for="g-label">Add an account</label>
                <input id="g-label" name="label" placeholder="e.g. second Gmail" />
              </div>
              <button type="submit" class="primary">+ Add account</button>
            </form>
          </div>

          <div class="card">
            <h3 style="margin-top:0">Sign in to Google from here</h3>
            ${data.login
              ? html`<div class="flash ${data.login.state === 'failed' ? 'error' : data.login.state === 'done' ? 'ok' : 'warn'}">
                  Account #${data.login.id}: ${data.login.message || data.login.state}
                </div>
                ${data.login.state === 'need_code'
                  ? html`<form method="post" action="/settings/google/${data.login.id}/login/code" class="row" style="gap:8px;margin-bottom:12px">
                      <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="verification code" required style="width:180px" />
                      <button type="submit" class="primary">Send code</button>
                    </form>`
                  : raw('')}
                ${data.login.running
                  ? html`<script>setTimeout(function () { location.reload(); }, 4000);</script>`
                  : raw('')}`
              : raw('')}
            <form method="post" action="/settings/google/login" class="row wrap" style="gap:8px;align-items:flex-end"
                  autocomplete="off">
              <div class="field" style="margin:0">
                <label for="gl-acc">Account</label>
                <select id="gl-acc" name="account">
                  ${data.accounts.map((a) => html`<option value="${a.id}" ${a.status === 'signed_out' ? 'selected' : ''}>#${a.id} ${a.label}</option>`)}
                </select>
              </div>
              <div class="field" style="margin:0;min-width:220px">
                <label for="gl-email">Gmail</label>
                <input id="gl-email" name="email" type="email" required autocomplete="off" />
              </div>
              <div class="field" style="margin:0;min-width:180px">
                <label for="gl-pass">Password</label>
                <input id="gl-pass" name="password" type="password" required autocomplete="new-password" />
              </div>
              <button type="submit" class="primary">Sign in</button>
            </form>
            <p class="small muted" style="margin-bottom:0">
              Typed into Google's own sign-in page in that account's browser, then forgotten — the password is not stored.
              If Google sends a prompt to your phone, tap Yes; if it asks for a code, a box for it appears here.
              If Google refuses an automatic sign-in, use the <a href="/browser" target="_blank" rel="noopener">Browser</a> once.
            </p>
          </div>

          <div class="card">
            <h3 style="margin-top:0">Adding an account</h3>
            <ol class="small" style="margin:0;padding-left:18px">
              <li>Press <strong>+ Add account</strong>, then sign it in with <strong>Sign in to Google from here</strong> above.
                Its Flow project is created and saved on its own once it is signed in.</li>
              <li>If that fails, press <strong>Create one for me</strong> on its row — or create a <strong>New project</strong> in Flow on the
                <a href="/browser" target="_blank" rel="noopener">Browser</a> page and paste its ID. An account without a project is never used.</li>
              <li>Come back and press <strong>Use now</strong> on the account you want as the main one.</li>
            </ol>
            <p class="small muted" style="margin-bottom:0">
              A resting account (out of credits) comes back by itself after a few hours. Press
              <strong>Use now</strong> to bring one back sooner.
            </p>
          </div>
        `}
  `;
}
