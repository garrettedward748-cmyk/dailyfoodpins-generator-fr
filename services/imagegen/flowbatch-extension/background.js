// Service worker: the side panel, downloads and their filenames, and the
// trusted input Flow requires.
//
// Flow ignores synthetic events. A script-made click submits nothing and a
// script-made focus() leaves no caret in the ProseMirror composer, so every
// click, key and text insert goes through the Chrome debugger instead.

// The selector and settings defaults, and the bridge that lets an imagegen
// agent beside this Chrome hand it prompts (idle without one).
importScripts('shared/defaults.js', 'bridge.js');

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── debugger ─────────────────────────────────────────────────

const attached = new Set();

async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    const text = String(err?.message || err);
    if (!text.includes('already attached')) {
      // DevTools open on the tab, or another extension holds it. Neither is ours to take.
      throw new Error(`DEBUGGER_ATTACH_FAILED: ${text} (close DevTools on this tab)`);
    }
  }
  attached.add(tabId);
}

const send = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  forgetZoom(tabId);
});

const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 },
  '@': { code: 'Digit2', vk: 50, text: '@', modifiers: 8 },
};

// The user's own zoom per tab, kept in session storage: this worker is stopped
// when idle, and a variable would forget it.
const ZOOM_KEY = 'FB_ZOOM';
const savedZooms = async () => (await chrome.storage.session.get(ZOOM_KEY))[ZOOM_KEY] || {};
async function forgetZoom(tabId) {
  const saved = await savedZooms();
  delete saved[tabId];
  await chrome.storage.session.set({ [ZOOM_KEY]: saved });
}

// ─── downloads ────────────────────────────────────────────────

// While a batch runs, files Flow's own menu downloads are renamed to the
// batch's scheme. The rule lives in session storage, not in a variable: this
// worker is stopped when idle and restarted by the download event itself, and
// the listener below is registered at the top level for the same reason.
const NAMING_KEY = 'FB_NAMING';
const NAMING_MAX_AGE = 10 * 60 * 1000;

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    // Downloads this extension starts already carry their name.
    if (item.byExtensionId === chrome.runtime.id) return null;

    const naming = (await chrome.storage.session.get(NAMING_KEY))[NAMING_KEY];
    if (!naming || Date.now() - naming.at > NAMING_MAX_AGE) return null;

    const google = /google|gstatic|googleusercontent|^data:|^blob:/.test(item.url);
    const ext = (item.filename.split('.').pop() || '').toLowerCase();
    if (!google || !/^(mp4|webm|png|jpe?g|webp|gif)$/.test(ext)) return null;

    const n = naming.count;
    await chrome.storage.session.set({ [NAMING_KEY]: { ...naming, count: n + 1 } });
    const suffix = naming.many ? `_${String.fromCharCode(97 + (n % 26))}` : '';
    const folder = naming.folder ? `${naming.folder}/` : '';
    return { filename: `${folder}${naming.base}${suffix}.${ext}`, conflictAction: 'uniquify' };
  })()
    // Always answer: a listener that returns true and never calls suggest
    // holds the download open for as long as the browser lives.
    .then((suggestion) => (suggestion ? suggest(suggestion) : suggest()))
    .catch(() => suggest());
  return true;
});

// ─── messages ─────────────────────────────────────────────────

const handlers = {
  async DOWNLOAD({ url, filename }) {
    const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
    return { downloadId: id };
  },

  async SET_NAMING({ folder, base, many }) {
    await chrome.storage.session.set({ [NAMING_KEY]: { folder, base, many, count: 0, at: Date.now() } });
  },

  // Only the prompt that set the naming may clear it: with prompts overlapping,
  // a late timer from an earlier one must not wipe the next one's rule.
  async CLEAR_NAMING({ base }) {
    const naming = (await chrome.storage.session.get(NAMING_KEY))[NAMING_KEY];
    if (naming && naming.base === base) await chrome.storage.session.remove(NAMING_KEY);
  },

  // Flow switches to a narrow "mobile" layout (no hover menu on tiles) below
  // roughly 800 CSS px, and the side panel makes the page that narrow. Zoom the
  // tab out until the page is `cssWidth` wide, and remember the user's zoom.
  async FIT_ZOOM({ cssWidth, innerWidth }, tabId) {
    const current = await chrome.tabs.getZoom(tabId);
    const wanted = Math.max(0.4, Math.min(current, (current * innerWidth) / cssWidth));
    if (wanted >= current) return;
    // Remember the user's zoom only the first time: a batch that reloads the page
    // calls this again, and by then the zoom is already ours.
    const saved = await savedZooms();
    if (saved[tabId] === undefined) await chrome.storage.session.set({ [ZOOM_KEY]: { ...saved, [tabId]: current } });
    await chrome.tabs.setZoom(tabId, wanted);
  },

  async RESTORE_ZOOM(_msg, tabId) {
    const saved = await savedZooms();
    if (saved[tabId] === undefined) return;
    await chrome.tabs.setZoom(tabId, saved[tabId]);
    await forgetZoom(tabId);
  },

  // Replace the composer's contents (or append) with `text`. execCommand in the
  // page's own world: the composer keeps its own document, so text assigned to
  // the node is text it does not know about and the submit button stays off.
  async TYPE_TEXT({ text, replace }, tabId) {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [text, !!replace],
      func: (value, replaceAll) => {
        const editor = document.querySelector('div.ProseMirror');
        if (!editor) return { error: 'NO_COMPOSER' };
        editor.focus();
        if (replaceAll) document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, value);
        return { text: editor.innerText.trim() };
      },
    });
    return out?.result || { error: 'NO_RESULT' };
  },

  async KEY({ key }, tabId) {
    const def = KEYS[key];
    if (!def) throw new Error(`Unknown key ${key}`);
    await attach(tabId);
    const base = { key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk };
    if (def.modifiers) base.modifiers = def.modifiers;
    await send(tabId, 'Input.dispatchKeyEvent', { type: def.text ? 'keyDown' : 'rawKeyDown', ...(def.text ? { text: def.text } : {}), ...base });
    await pause(40);
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  },

  async INSERT_TEXT({ text }, tabId) {
    await attach(tabId);
    await send(tabId, 'Input.insertText', { text });
  },

  async CLICK_AT({ x, y }, tabId) {
    await attach(tabId);
    const at = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...at });
    await pause(50);
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...at });
  },

  async MOVE_AT({ x, y }, tabId) {
    await attach(tabId);
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y) });
  },

  async DETACH(_msg, tabId) {
    if (!attached.has(tabId)) return;
    attached.delete(tabId);
    await chrome.debugger.detach({ tabId });
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;

  handler(msg, sender.tab?.id)
    .then((result) => reply({ ok: true, ...result }))
    .catch((err) => reply({ ok: false, error: String(err?.message || err) }));
  return true;
});
