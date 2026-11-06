// Gemini Chat content script: drives the gemini.google.com chat page for one job at a time.
//
// The background worker hands a job over a port; this answers on the same port. Errors start with
// a code (NOT_SIGNED_IN, WRONG_ACCOUNT, NO_PROMPT_BOX, HIDDEN, TIMEOUT) so the agent and the
// platform can tell "sign in again" from "try again" without reading prose.
(() => {
  if (window.__geminiChat) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const fail = (code, message) => { throw new Error(`${code}: ${message}`); };

  async function waitFor(fn, timeoutMs, onTimeout, every = 250) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return onTimeout();
      await sleep(every);
    }
  }

  const editor = () => $('rich-textarea .ql-editor[contenteditable="true"]') || $('div.ql-editor[role="textbox"]');
  const labelOf = (el) => (el.getAttribute('aria-label') || '').trim();
  const sendButton = () => $$('button').find((b) => /^send( message)?$/i.test(labelOf(b)));
  const stopButton = () => $$('button').find((b) => /^stop( response| generating)?$/i.test(labelOf(b)));
  const isDisabled = (b) => !b || b.disabled || b.getAttribute('aria-disabled') === 'true';
  const responses = () => $$('model-response');
  const conversationId = () => (location.pathname.match(/\/app\/([A-Za-z0-9_-]+)/) || [])[1] || null;

  // ── who is signed in ───────────────────────────────────────────────────────
  // Signed out, Gemini still opens (with fewer features) and shows a "Sign in" link to Google.
  const signInLink = () =>
    $('a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/v3/signin"], a[href*="accounts.google.com/AccountChooser"]') ||
    $$('a, button').find((el) => /^sign in$/i.test((el.textContent || '').trim()));
  // The Google bar's account button names the account: "Google Account: Name (name@gmail.com)".
  const accountLabel = () => $$('a[aria-label], button[aria-label]').map(labelOf).find((l) => /^Google Account/i.test(l)) || '';
  const accountEmail = () => (accountLabel().match(/[^\s()]+@[^\s()]+/) || [''])[0].toLowerCase();

  async function checkSession(account) {
    // Whichever shows first: the prompt box (signed in, or a signed-out Gemini) or the sign-in link.
    await waitFor(() => editor() || signInLink(), 20_000, () => fail('NO_PROMPT_BOX', 'the Gemini page did not show its prompt box'));
    await sleep(500); // the account button arrives a moment after the prompt box
    if (signInLink() && !accountLabel()) {
      fail('NOT_SIGNED_IN', 'Gemini is open but no Google account is signed in. Sign in on the Browser page.');
    }
    const email = accountEmail();
    if (account && email && email !== account.toLowerCase()) {
      fail('WRONG_ACCOUNT', `Gemini opened as ${email}, not ${account}. Sign ${account} in on the Browser page.`);
    }
    return email;
  }

  // ── temporary chat ─────────────────────────────────────────────────────────
  // A temporary chat stays out of the account's chat history but has no address to come back to,
  // so it is used only when asked for. The platform's article prompts ask for an ordinary chat,
  // one per article, so each answer has the article's earlier answers in mind. Best effort: if the
  // toggle cannot be found the prompt still goes, as an ordinary chat.
  const temporaryToggle = () => $$('button').find((b) => /^temporary chat$/i.test(labelOf(b)));
  const isPressed = (b) => b.getAttribute('aria-pressed') === 'true' || b.classList.contains('active');

  async function setTemporaryChat(on) {
    const toggle = temporaryToggle();
    if (!toggle) return false;
    if (isPressed(toggle) !== on) {
      toggle.click();
      await sleep(800);
      await waitFor(editor, 10_000, () => null);
    }
    return on;
  }

  // ── carrying on a chat ─────────────────────────────────────────────────────
  // An earlier chat's messages arrive a moment after its prompt box. Sending before they are all
  // in would mistake an old answer for the new one, so wait until they stop arriving and the last
  // one is finished. A chat that no longer exists (deleted, or another account's) opens as a new
  // one; the reply then carries the new chat's id and the platform remembers that one instead.
  async function settleHistory(wanted) {
    if (!wanted) return false;
    await waitFor(() => responses().length > 0 || conversationId() !== wanted, 15_000, () => null);
    if (conversationId() !== wanted) return false;
    // Still at the chat's address with none of its messages shown: sending now could take a late
    // old answer for the new one. The platform lets this chat go and the next prompt starts afresh.
    if (!responses().length) fail('NO_PROMPT_BOX', 'the earlier messages of this Gemini chat did not load');
    let count = -1;
    let stableSince = 0;
    await waitFor(() => {
      const n = responses().length;
      const last = responses().at(-1);
      if (n !== count || !last || !$('message-actions', last) || stopButton()) {
        count = n;
        stableSince = Date.now();
        return false;
      }
      return Date.now() - stableSince > 1500;
    }, 20_000, () => null);
    return true;
  }

  // ── input ──────────────────────────────────────────────────────────────────
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // Shift+Enter is a new line in Gemini's box; a plain line break is Enter, and Enter sends.
  function newLine(ed) {
    const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => 13 });
    Object.defineProperty(e, 'which', { get: () => 13 });
    ed.dispatchEvent(e);
  }

  const squash = (s) => s.replace(/\s+/g, '');

  // Typed one line at a time. Typed whole, the first line break sent the first line on its own
  // ("Instructions:") and lost the rest; a pasted text never reaches the box at all.
  async function setPrompt(text) {
    const ed = editor();
    ed.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    const before = responses().length;
    text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
      if (i) newLine(ed);
      if (line) document.execCommand('insertText', false, line);
    });
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    if (responses().length > before) fail('NO_PROMPT_BOX', 'Gemini sent part of the prompt while it was being typed');
    // Only the whole prompt is sent: half of one gets a confident answer to the wrong question.
    if (squash(ed.innerText) !== squash(text)) fail('NO_PROMPT_BOX', 'the whole prompt did not fit in the Gemini prompt box');
  }

  const previewCount = () =>
    $$('uploader-file-preview, uploader-file-preview-container [class*="preview"], [data-test-id*="file-preview"]').length;

  async function attachFiles(files) {
    if (!files.length) return;
    const ed = editor();
    ed.focus();
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([b64ToBytes(f.base64)], f.name, { type: f.mime }));
    const before = previewCount();
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await waitFor(() => previewCount() > before, 30_000, () => fail('UPLOAD', 'Gemini did not take the attached file'));
    // An upload is finished when no progress indicator is left in the input area and Send is enabled.
    await waitFor(
      () => !$('input-area-v2 mat-progress-bar, input-area-v2 mat-progress-spinner, input-area-v2 [role="progressbar"]') && !isDisabled(sendButton()),
      120_000,
      () => fail('UPLOAD', 'the attached file did not finish uploading'),
    );
  }

  // ── output ─────────────────────────────────────────────────────────────────
  const SKIP = new Set(['button', 'mat-icon', 'gem-icon', 'style', 'script', 'sources-list', 'message-actions', 'thinking-overlay']);

  function codeBlockInfo(block) {
    const pre = $('pre', block);
    const code = (pre ? $('code', pre) || pre : block).textContent;
    const label = ($('.code-block-decoration span, [class*="decoration"] span', block)?.textContent || '').trim().toLowerCase();
    return { language: label === 'code' ? '' : label, code: code.replace(/\n$/, '') };
  }

  function toMarkdown(node, inPre = false) {
    if (node.nodeType === 3) return inPre ? node.textContent : node.textContent.replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    // .attachment-container holds Gemini's follow-up suggestion chips, not the answer.
    if (SKIP.has(tag) || node.classList.contains('attachment-container') || node.hidden) return '';
    const kids = () => [...node.childNodes].map((c) => toMarkdown(c, inPre)).join('');
    const h = tag.match(/^h([1-6])$/);
    if (h) return `\n\n${'#'.repeat(+h[1])} ${kids().trim()}\n\n`;
    switch (tag) {
      case 'p': return `\n\n${kids().trim()}\n\n`;
      case 'br': return '  \n';
      case 'hr': return '\n\n---\n\n';
      case 'strong': case 'b': return `**${kids()}**`;
      case 'em': case 'i': return `*${kids()}*`;
      case 'code': return inPre ? kids() : `\`${node.textContent}\``;
      case 'a': return node.href ? `[${kids()}](${node.href})` : kids();
      case 'img': return node.src ? `![${node.alt || ''}](${node.src})` : '';
      case 'blockquote': return `\n\n${kids().trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
      case 'ul': case 'ol': {
        let n = 0;
        const items = [...node.children].filter((c) => c.tagName.toLowerCase() === 'li').map((li) => {
          const body = toMarkdown(li).trim().replace(/\n/g, '\n  ');
          return `${tag === 'ol' ? `${++n}.` : '-'} ${body}`;
        });
        return `\n\n${items.join('\n')}\n\n`;
      }
      case 'table': {
        const rows = $$('tr', node).map((tr) => $$('th,td', tr).map((c) => toMarkdown(c).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' ')));
        if (!rows.length) return '';
        const head = rows[0];
        return `\n\n| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n${rows.slice(1).map((r) => `| ${r.join(' | ')} |`).join('\n')}\n\n`;
      }
      case 'code-block': {
        const { language, code } = codeBlockInfo(node);
        return `\n\n\`\`\`${language}\n${code}\n\`\`\`\n\n`;
      }
      default: return kids();
    }
  }

  // The markdown is the faithful form (Gemini's own DOM is full of citation chips); text is it minus the syntax.
  function plainText(md) {
    return md
      .replace(/^```.*$/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/^#{1,6} /gm, '')
      .replace(/^\| ?-{3}.*$/gm, '')
      .replace(/^\| ?(.*?) ?\|$/gm, (_, row) => row.split(' | ').join('\t'))
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // A blob: picture refuses fetch() under the page's rules, but its pixels are same-origin, so a canvas reads them.
  async function imageBytes(img) {
    const src = img.currentSrc || img.src;
    try {
      const r = await fetch(src, { credentials: 'include' });
      if (r.ok) return { buf: await r.arrayBuffer(), mime: (r.headers.get('content-type') || 'image/png').split(';')[0] };
    } catch { /* fall through */ }
    if (!img.complete || !img.naturalWidth) return null;
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return blob ? { buf: await blob.arrayBuffer(), mime: 'image/png' } : null;
    } catch {
      return null; // a cross-origin picture taints the canvas
    }
  }

  async function collectImages(root, withData) {
    const seen = new Set();
    const out = [];
    for (const img of $$('img', root)) {
      const src = img.currentSrc || img.src;
      if (!src || seen.has(src) || src.startsWith('data:image/svg')) continue;
      if ((img.naturalWidth || img.width) < 80 && (img.naturalHeight || img.height) < 80) continue; // icons, avatars
      seen.add(src);
      const item = { url: src, alt: img.alt || '' };
      const got = withData ? await imageBytes(img) : null;
      if (got) Object.assign(item, { mime: got.mime, data_base64: bytesToB64(got.buf) });
      out.push(item);
    }
    return out;
  }

  async function extract(resp, withImages) {
    const body = $('.markdown', resp) || $('message-content', resp) || resp;
    const markdown = toMarkdown(body).replace(/\n{3,}/g, '\n\n').trim();
    return {
      conversation_id: conversationId(),
      text: plainText(markdown),
      markdown,
      code_blocks: $$('code-block', resp).map(codeBlockInfo),
      links: [...new Map($$('a[href]', body).filter((a) => /^https?:/.test(a.href)).map((a) => [a.href, { url: a.href, text: a.textContent.trim() }])).values()],
      images: await collectImages(resp, withImages),
    };
  }

  // ── the job ────────────────────────────────────────────────────────────────
  async function chat({ prompt = '', files = [], account = '', temporary = true, conversationId: wanted = '', images = true, timeoutMs = 240_000 }) {
    // A page that is not visible may not draw the reply as it streams in.
    if (document.visibilityState !== 'visible') fail('HIDDEN', 'the Gemini window is minimized or hidden');
    const email = await checkSession(account);
    const continued = await settleHistory(wanted);
    // Carrying on a chat is never temporary; a new chat is temporary only when asked.
    const temp = continued ? false : await setTemporaryChat(Boolean(temporary && !wanted));
    await waitFor(editor, 15_000, () => fail('NO_PROMPT_BOX', 'the Gemini page did not show its prompt box'));

    // The answer is the response that was not on the page before Send, at the end of the chat.
    const old = new Set(responses());
    const isNew = () => { const last = responses().at(-1); return last && !old.has(last) ? last : null; };
    const before = old.size;
    await setPrompt(prompt);
    await attachFiles(files);
    const send = await waitFor(() => { const b = sendButton(); return !isDisabled(b) && b; }, 15_000, () => fail('NO_PROMPT_BOX', 'the Send button stayed disabled'));
    send.click();

    await waitFor(() => responses().length > before && isNew(), 60_000, () => fail('TIMEOUT', 'Gemini did not start answering'));
    // Done when the reply's action row (copy, redo) is shown and no Stop button is left, for 1.5 s.
    let stableSince = 0;
    const end = Date.now() + timeoutMs;
    for (;;) {
      const last = responses().at(-1);
      if (last && $('message-actions', last) && !stopButton()) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince > 1500) break;
      } else {
        stableSince = 0;
      }
      if (Date.now() > end) fail('TIMEOUT', 'Gemini was still answering when the time ran out');
      await sleep(400);
    }
    return { ...(await extract(responses().at(-1), images)), account: email, temporary: temp, continued };
  }

  window.__geminiChat = { chat, setPrompt, toMarkdown, plainText };

  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    const port = chrome.runtime.connect({ name: 'gemini-chat' });
    port.onMessage.addListener(async (msg) => {
      if (msg.cmd !== 'run') return;
      try {
        port.postMessage({ id: msg.job.id, ok: true, result: await chat(msg.job.payload) });
      } catch (e) {
        port.postMessage({ id: msg.job.id, ok: false, error: e.message || String(e) });
      }
    });
  }
})();
