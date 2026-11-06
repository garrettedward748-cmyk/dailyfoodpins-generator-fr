import { html, raw, type Html } from './layout.js';

/** Setup -> Gemini. The logic and routes are in src/web/gemini.ts. */

interface StateView {
  kind: 'ok' | 'bad' | 'idle';
  label: string;
  detail: string;
}

interface StageView {
  title: string;
  about: string;
}

const CSS = `
.gm-steps { display: grid; gap: 8px; margin: 4px 0 14px; }
.gm-step { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: baseline; padding: 10px 12px; border: 1px solid rgba(127,127,127,.3); border-radius: 10px; cursor: pointer; }
.gm-step:has(input:checked) { border-color: currentColor; }
.gm-step input { grid-row: span 2; }
.gm-step span { opacity: .7; font-size: 13px; }
.gm-try textarea { width: 100%; min-height: 96px; }
.gm-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 10px; }
.gm-reply { margin-top: 16px; padding: 14px 16px; border: 1px solid rgba(127,127,127,.3); border-radius: 10px; }
.gm-reply.bad { border-color: #dc2626; }
.gm-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: inherit; }
.gm-code { margin: 12px 0 0; padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(127,127,127,.3); overflow-x: auto; font: 13px/1.5 ui-monospace, monospace; white-space: pre; }
.gm-pics { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.gm-pics img { max-width: 260px; max-height: 260px; border-radius: 8px; }
.gm-actions { display: flex; gap: 8px; margin-top: 12px; }
`;

export function geminiPage(state: StateView, stages: StageView[], onStages: string[]): Html {
  const badge = state.kind === 'ok' ? 'ok' : state.kind === 'bad' ? 'error' : 'muted';
  return html`<style>${raw(CSS)}</style>
    <h1>Gemini <span class="badge ${badge}">${state.label}</span></h1>
    <p class="subtitle">
      Gemini runs in the image service's browser, beside Google Flow, signed in with the Google
      account that browser is on. There is nothing to install or connect. Ticked steps are written
      by Gemini; if it cannot answer (signed out, daily limit reached, not JSON), the step is written
      by your AI keys instead, so nothing stops.
    </p>

    <div class="card">
      <p><b>Status:</b> ${state.detail}</p>
      <p><b>Steps using Gemini:</b> ${onStages.length ? onStages.join(', ') : 'None yet. Your AI keys write everything.'}</p>
    </div>

    <div class="card">
      <h2>Choose which steps Gemini writes</h2>
      <form method="post" action="/settings/gemini/steps">
        <div class="gm-steps">${stages.map(
          (s) => html`<label class="gm-step"><input type="checkbox" name="stage" value="${s.title}" ${raw(onStages.includes(s.title) ? 'checked' : '')}><b>${s.title}</b><span>${s.about}</span></label>`,
        )}</div>
        <p class="small muted">Gemini's daily limits are low for automatic use, and it answers one prompt at a time:
          start with one light step, such as Social posts. A single prompt can also be pointed at
          <span class="mono">gemini</span> on the Prompts page.</p>
        <button class="primary" type="submit">Save</button>
      </form>
    </div>

    <div class="card gm-try">
      <h2>Try Gemini</h2>
      <form id="gm-form">
        <label for="gm-prompt" class="small muted">Ask anything. Links in your message are read too, and you can attach pictures, PDFs or other files.</label>
        <textarea id="gm-prompt" name="prompt" placeholder="For example: write three short Pinterest titles for a lemon cake recipe"></textarea>
        <div class="gm-row">
          <input type="file" id="gm-files" multiple>
          <button class="primary" type="submit" id="gm-send">Send</button>
          <span class="small muted" id="gm-wait" role="status"></span>
        </div>
      </form>
      <div class="gm-reply" id="gm-reply" hidden></div>
    </div>
    ${raw(TRY_SCRIPT)}`;
}

// The reply is put on the page as text nodes, never as HTML: it is whatever Gemini wrote.
const TRY_SCRIPT = `<script>
(function () {
  var form = document.getElementById('gm-form');
  if (!form) return;
  var send = document.getElementById('gm-send'), wait = document.getElementById('gm-wait'), out = document.getElementById('gm-reply');
  // Files travel as base64 (a third larger) in a request the server caps at 20 MB.
  var MAX = 14 * 1024 * 1024;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function readFile(f) {
    return new Promise(function (ok, no) {
      var r = new FileReader();
      r.onload = function () { ok({ name: f.name, mime: f.type || 'application/octet-stream', base64: String(r.result).split(',')[1] || '' }); };
      r.onerror = function () { no(new Error('Could not read ' + f.name)); };
      r.readAsDataURL(f);
    });
  }
  function show(reply, error) {
    out.hidden = false; out.className = 'gm-reply' + (error ? ' bad' : ''); out.textContent = '';
    if (error) { out.appendChild(el('p', 'gm-text', error)); return; }
    out.appendChild(el('pre', 'gm-text', reply.text || '(no text)'));
    (reply.code_blocks || []).forEach(function (b) { out.appendChild(el('pre', 'gm-code', b.code)); });
    var pics = (reply.images || []).filter(function (i) { return i.data_base64; });
    if (pics.length) {
      var box = el('div', 'gm-pics');
      pics.forEach(function (i) { var img = el('img'); img.src = 'data:' + (i.mime || 'image/png') + ';base64,' + i.data_base64; img.alt = i.alt || 'Picture from Gemini'; box.appendChild(img); });
      out.appendChild(box);
    }
    var actions = el('div', 'gm-actions'), copy = el('button', 'small', 'Copy as Markdown');
    copy.type = 'button';
    copy.onclick = function () { navigator.clipboard.writeText(reply.markdown || reply.text || '').then(function () { copy.textContent = 'Copied'; }); };
    actions.appendChild(copy); out.appendChild(actions);
  }
  function done() { send.disabled = false; wait.textContent = ''; }
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var prompt = document.getElementById('gm-prompt').value.trim();
    var picked = Array.from(document.getElementById('gm-files').files || []);
    if (!prompt && !picked.length) { show(null, 'Write a message or attach a file first.'); return; }
    if (picked.reduce(function (n, f) { return n + f.size; }, 0) > MAX) { show(null, 'The files are too large together. Keep them under 14 MB.'); return; }
    send.disabled = true; wait.textContent = 'Sending…'; out.hidden = true;
    try {
      var files = await Promise.all(picked.map(readFile));
      var r = await fetch('/settings/gemini/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: prompt, files: files }) });
      var body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Could not send it.');
      var started = Date.now();
      for (;;) {
        await new Promise(function (ok) { setTimeout(ok, 2000); });
        var s = Math.round((Date.now() - started) / 1000);
        wait.textContent = 'Gemini is answering… ' + s + ' s (the first message can take a minute while the browser starts)';
        var p = await fetch('/settings/gemini/ask/' + encodeURIComponent(body.id));
        var job = await p.json();
        if (job.status === 'done') { show(job.reply); break; }
        if (job.status === 'failed' || !p.ok) { show(null, job.error || 'Gemini could not answer.'); break; }
      }
    } catch (err) { show(null, err.message || String(err)); }
    done();
  });
})();
</script>`;
