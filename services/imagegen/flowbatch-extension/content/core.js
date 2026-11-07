// Content-script core: reporting, cancellation, finding elements, and the
// trusted input calls every other module builds on.
(() => {
  const FB = (self.FlowBatch = self.FlowBatch || {});
  if (FB.core) return;

  class Cancelled extends Error {}

  // The running job. Modules read selectors/settings through it.
  const state = { job: null };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const between = (min, max) => (max <= min ? min : min + Math.random() * (max - min));
  const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ─── talking to the rest of the extension ───────────────────

  const emit = (type, data) => {
    try {
      chrome.runtime.sendMessage({ type, data }).catch(() => {});
    } catch {
      // The extension was reloaded under this tab; nothing is listening.
    }
  };

  const log = (level, message) => emit('LOG', { level, message, at: Date.now() });

  async function ask(message) {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error(reply?.error || `${message.type} failed`);
    return reply;
  }

  // ─── cancellation ───────────────────────────────────────────

  const throwIfCancelled = () => {
    if (state.job?.cancelled) throw new Cancelled('Stopped');
  };

  async function wait(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      throwIfCancelled();
      await sleep(Math.min(250, end - Date.now()));
    }
  }

  // ─── finding things ─────────────────────────────────────────

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  const CLICKABLE =
    'button,a,li,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="tab"],[role="radio"],[role="checkbox"],[role="switch"],[role="link"]';

  // innerText, not textContent: Flow's icon and label sit in separate elements
  // with no whitespace between them ("videocamVideo"), and only innerText
  // puts the break back. textContent is the fallback where there is no layout.
  const textOf = (el) => (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();

  const labelOf = (el) => `${el.getAttribute('aria-label') || ''} ${textOf(el)}`.trim();

  function toRegex(body) {
    const m = body.match(/^\/(.*)\/([a-z]*)$/s);
    try {
      return m ? new RegExp(m[1], m[2] || 'i') : new RegExp(escapeRe(body), 'i');
    } catch {
      return null;
    }
  }

  // Of the matches, keep those with no matching descendant: the control itself,
  // not every wrapper around it.
  const innermost = (els) => els.filter((el) => !els.some((other) => other !== el && el.contains(other)));

  function findAll(selector, root = document) {
    if (!selector) return [];
    // `scope >> inner`: look for `inner` only inside elements matching `scope`.
    const at = selector.indexOf(' >> ');
    if (at > 0) {
      const inner = selector.slice(at + 4);
      let scopes;
      try {
        scopes = [...root.querySelectorAll(selector.slice(0, at))];
      } catch {
        return [];
      }
      return scopes.flatMap((scope) => findAll(inner, scope));
    }
    if (selector.startsWith('text:')) {
      const re = toRegex(selector.slice(5));
      if (!re) return [];
      return innermost([...root.querySelectorAll(CLICKABLE)].filter((el) => isVisible(el) && re.test(labelOf(el))));
    }
    if (selector.startsWith('contains:')) {
      const re = toRegex(selector.slice(9));
      if (!re) return [];
      const hits = [...root.querySelectorAll('*')].filter((el) => {
        if (!isVisible(el)) return false;
        const own = `${el.getAttribute('alt') || ''} ${el.getAttribute('aria-label') || ''} ${textOf(el)}`.trim();
        return own.length < 400 && re.test(own);
      });
      return innermost(hits);
    }
    try {
      return [...root.querySelectorAll(selector)];
    } catch {
      return [];
    }
  }

  const find = (selector, root) => findAll(selector, root).find(isVisible) || null;

  // `{name}` placeholders, filled with values escaped for a regex.
  const fill = (template, values) =>
    template.replace(/\{(\w+)\}/g, (_, name) => escapeRe(values[name] ?? ''));

  async function waitFor(selector, timeoutMs, what) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      throwIfCancelled();
      const el = find(selector);
      if (el) return el;
      if (Date.now() > end) throw new Error(`Could not find ${what} (${selector})`);
      await sleep(300);
    }
  }

  const isDisabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true';

  // ─── one thing at a time on the page ────────────────────────

  // Submitting a prompt and downloading an earlier result both click, hover and
  // press keys on the same page. Run either under this lock so one never closes
  // the other's menu. Watching a render (reading only) needs no lock.
  let uiTail = Promise.resolve();
  function withUi(task) {
    const run = uiTail.then(task, task);
    uiTail = run.catch(() => {});
    return run;
  }

  // ─── trusted input ──────────────────────────────────────────

  const centre = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  async function click(el, what = 'element') {
    if (isDisabled(el)) throw new Error(`${what} is disabled`);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(80);
    await ask({ type: 'CLICK_AT', ...centre(el) });
    await sleep(250);
  }

  async function hover(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(80);
    await ask({ type: 'MOVE_AT', ...centre(el) });
    await sleep(250);
  }

  // Click the control a selector names, waiting for it to exist.
  async function clickSelector(selector, what, timeoutMs = 8000) {
    await click(await waitFor(selector, timeoutMs, what), what);
  }

  // The same, but only if it is there; returns whether it clicked.
  async function clickIfPresent(selector, what) {
    const el = find(selector);
    if (!el || isDisabled(el)) return false;
    await click(el, what);
    return true;
  }

  const pressKey = (key) => ask({ type: 'KEY', key });

  // Set a plain input's value the way a user typing would.
  function setInputValue(input, value) {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // The selectors in force: the job's, or the defaults when none is running.
  const selectors = () => state.job?.selectors || state.scanSelectors || FB.DEFAULT_SELECTORS;
  const settings = () => state.job?.settings || FB.DEFAULT_SETTINGS;

  FB.core = {
    Cancelled,
    state,
    sleep,
    between,
    escapeRe,
    emit,
    log,
    ask,
    throwIfCancelled,
    wait,
    isVisible,
    labelOf,
    textOf,
    findAll,
    withUi,
    find,
    fill,
    waitFor,
    isDisabled,
    click,
    hover,
    clickSelector,
    clickIfPresent,
    pressKey,
    setInputValue,
    selectors,
    settings,
  };
})();
