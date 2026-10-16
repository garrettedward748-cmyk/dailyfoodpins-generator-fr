import { emptyState, html, Html, raw } from './layout.js';
import type { BackupFile } from '../../backup/index.js';

const KIND_LABEL: Record<string, string> = {
  auto: 'daily',
  manual: 'by hand',
  'before-restore': 'before a restore',
  uploaded: 'uploaded',
};

function size(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** Setup -> Backups. */
export function backupsPage(data: { backups: BackupFile[]; restarting?: boolean }): Html {
  const lastAuto = data.backups.find((b) => b.kind === 'auto');
  if (data.restarting) {
    return html`
      <h1>Restoring…</h1>
      <div class="flash warn">The backup is in place and the platform is restarting. This page reloads in 40 seconds.</div>
      <script>setTimeout(function () { location.href = '/settings/backups'; }, 40000);</script>
    `;
  }
  return html`
    <h1>Backups</h1>
    <p class="subtitle">
      A backup holds everything the platform stores: sites, keywords, articles and runs, settings,
      LLM keys, Buffer accounts and prompts — and the key those tokens are encrypted with.
      One is made <strong>every day</strong> on its own and the last 7 are kept.
      Last daily backup: <strong>${lastAuto ? when(lastAuto.time) : 'not yet'}</strong>.
    </p>

    <div class="card">
      <form method="post" action="/settings/backups/create" style="margin:0">
        <button type="submit" class="primary">Back up now</button>
      </form>
      <p class="small muted" style="margin-bottom:0">
        Kept on this server. <strong>Download one from time to time</strong> and keep it somewhere safe and
        private (it can unlock your saved tokens): if the server is lost, so are the copies on it.
        The list of Google accounts (names, Flow projects, limits) is included and can be restored from Setup → Google accounts. Their sign-ins are not: to move them too, use Setup → Google accounts → Download accounts + sign-ins.
      </p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Saved backups</h3>
      ${data.backups.length === 0
        ? emptyState('No backup yet. Press Back up now.')
        : html`<div class="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Type</th><th>Size</th><th></th></tr></thead>
              <tbody>
                ${data.backups.map(
                  (b) => html`<tr>
                    <td>${when(b.time)}</td>
                    <td class="muted">${KIND_LABEL[b.kind] ?? b.kind}</td>
                    <td class="muted">${size(b.size)}</td>
                    <td class="nowrap">
                      <a class="button small" href="/settings/backups/download?file=${encodeURIComponent(b.name)}">Download</a>
                      <form method="post" action="/settings/backups/restore" style="display:inline"
                            onsubmit="return confirm('Restore the platform to ${when(b.time)}? Everything changed since then is replaced. The current state is saved first, then the platform restarts.')">
                        <input type="hidden" name="file" value="${b.name}" />
                        <button type="submit" class="small">Restore</button>
                      </form>
                      <form method="post" action="/settings/backups/delete" style="display:inline"
                            onsubmit="return confirm('Delete this backup?')">
                        <input type="hidden" name="file" value="${b.name}" />
                        <button type="submit" class="small danger">Delete</button>
                      </form>
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`}
    </div>

    <div class="card">
      <h3 style="margin-top:0">Restore from a file</h3>
      <p class="small muted">
        Upload a backup you downloaded earlier (.tar.gz) — also how you move the platform to a new server.
        The current state is saved first, then the platform restarts on the backup.
      </p>
      <form method="post" action="/settings/backups/upload" enctype="multipart/form-data" class="row wrap" style="gap:8px"
            onsubmit="return confirm('Replace everything with this backup? The current state is saved first.')">
        <input type="file" name="backup" accept=".gz,.tgz,application/gzip" required />
        <button type="submit" class="primary">Upload and restore</button>
      </form>
    </div>
    ${raw('')}
  `;
}
