// Gemini Chat service worker.
//
// Long-polls the agent beside it for a prompt, runs it in a Gemini window of its own through the
// content script, and posts the reply back. One prompt at a time; a heartbeat every few seconds
// tells the agent the prompt is still being worked on, so a hand-off lost in transit is put back
// in the queue instead of waiting out its whole timeout.
//
// The window is a popup created straight at the Gemini address, never a blank tab: Flow Kit
// takes over blank tabs on startup and opens its own tabs in the first *normal* window, so a
// popup keeps the two extensions out of each other's way. Chrome here runs with background
// throttling off, so the window works whether or not it is in front.
const AGENT = 'http://127.0.0.1:8100/ext/gemini';
const APP = 'https://gemini.google.com/app';

const ports = new Map(); // tabId -> content-script port
let polling = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gemini-chat' || !port.sender?.tab) return;
  const tabId = port.sender.tab.id;
  ports.set(tabId, port);
  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
  });
});

// ── the Gemini window ────────────────────────────────────────────────────────
async function geminiTab() {
  const { tabId } = await chrome.storage.session.get('tabId');
  if (tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) return tab;
  }
  const win = await chrome.windows.create({ url: APP, type: 'popup', focused: false, left: 0, top: 0, width: 1280, height: 720 });
  const tab = win.tabs[0];
  await chrome.storage.session.set({ tabId: tab.id });
  return tab;
}

function loaded(tabId, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdate);
      reject(new Error('NO_PROMPT_BOX: the Gemini page did not finish loading'));
    }, timeoutMs);
    function onUpdate(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdate);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
}

// Every prompt reloads the page: at the chat it is to carry on (its earlier messages give the
// answer its context), or at a new chat, so it never lands in whatever chat was open last.
async function openFresh(account, conversationId) {
  const base = /^[A-Za-z0-9_-]+$/.test(conversationId || '') ? `${APP}/${conversationId}` : APP;
  // hl=en: Gemini follows the account's language otherwise, and the page's buttons are found by
  // their English names (a French account showed "Envoyer le message" and nothing was sent).
  const params = new URLSearchParams({ hl: 'en' });
  if (account) params.set('authuser', account);
  const url = `${base}?${params}`;
  const tab = await geminiTab();
  // Minimized (from the Browser page, say), the page is hidden and may not
  // draw the reply as it streams in: every prompt then failed with HIDDEN.
  // Put the window back without taking the focus from Flow's.
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (win && win.state !== 'normal') {
    await chrome.windows.update(tab.windowId, { state: 'normal' }).catch(() => {});
  }
  ports.delete(tab.id);
  const done = loaded(tab.id);
  await chrome.tabs.update(tab.id, { url });
  await done;
  const now = await chrome.tabs.get(tab.id);
  // An account that is not signed in is sent to Google's sign-in page instead.
  if (!(now.url || '').startsWith('https://gemini.google.com/')) {
    throw new Error(`NOT_SIGNED_IN: Google asked to sign in${account ? ` ${account}` : ''}. Sign in on the Browser page.`);
  }
  for (let i = 0; i < 80 && !ports.get(tab.id); i++) await sleep(250);
  const port = ports.get(tab.id);
  if (!port) throw new Error('NO_PROMPT_BOX: the Gemini page did not load the extension');
  return port;
}

// ── several Google accounts, one after another ───────────────────────────────
// Each signed-in Google account has its own free Gemini allowance. When the one
// in use shows "Limit reached · Resets at 10:44", the prompt goes to the next
// account signed in to this browser (?authuser=1, 2, ...), and the spent one is
// left alone until its reset. Accounts are added on the Browser page: in the
// Gemini window, the account picture, then "Add another account".
const MAX_ACCOUNTS = 6;

/** When a limit lifts, from "Resets at 10:44" (this browser's clock); three hours when unsaid. */
function resetsAt(message) {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(message || '');
  if (!m) return Date.now() + 3 * 3600_000;
  let h = Number(m[1]);
  const half = (m[3] || '').toLowerCase();
  if (half === 'pm' && h < 12) h += 12;
  if (half === 'am' && h === 12) h = 0;
  const at = new Date();
  at.setHours(h, Number(m[2]), 0, 0);
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
  return at.getTime() + 60_000;
}

async function rotation() {
  const { geminiLimits = {}, geminiAccounts = MAX_ACCOUNTS } = await chrome.storage.local.get(['geminiLimits', 'geminiAccounts']);
  for (const [k, until] of Object.entries(geminiLimits)) if (until <= Date.now()) delete geminiLimits[k];
  return { limits: geminiLimits, count: geminiAccounts };
}

async function run(job) {
  // A prompt for a named account goes to it alone.
  if (job.payload.account) return runAs(job, job.payload.account);
  const { limits, count } = await rotation();
  const seen = new Set();
  let last = null;
  for (let user = 0; user < count; user++) {
    if (limits[user]) continue;
    try {
      return await runAs(job, String(user));
    } catch (e) {
      const msg = e.message || String(e);
      // Past the last signed-in account Google asks for a sign-in, or quietly
      // opens the first account again: either way the list ends here.
      const email = (/ as (\S+@\S+)$/.exec(msg) || [])[1] || '';
      if ((user > 0 && msg.startsWith('NOT_SIGNED_IN')) || (email && seen.has(email))) {
        await chrome.storage.local.set({ geminiAccounts: Math.max(1, user) });
        break;
      }
      if (!msg.startsWith('LIMIT')) throw e;
      if (email) seen.add(email);
      limits[user] = resetsAt(msg);
      await chrome.storage.local.set({ geminiLimits: limits });
      last = e;
    }
  }
  const next = Object.values(limits).sort((a, b) => a - b)[0];
  throw new Error(`LIMIT: every Google account's Gemini limit is reached${next ? `; the first comes back at ${new Date(next).toTimeString().slice(0, 5)}` : ''}. Add another account in the Gemini window on the Browser page for more.${last ? ` (${last.message})` : ''}`);
}

async function runAs(job, account) {
  const port = await openFresh(account, job.payload.conversationId || '');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('TIMEOUT: the Gemini page stopped answering')), (job.payload.timeoutMs || 240_000) + 30_000);
    function finish(err, result) {
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onGone);
      if (err) reject(err);
      else resolve(result);
    }
    function onMessage(msg) {
      if (msg.id !== job.id) return;
      if (msg.ok) finish(null, msg.result);
      else finish(new Error(msg.error));
    }
    function onGone() {
      finish(new Error('NO_PROMPT_BOX: the Gemini page closed or reloaded during the prompt'));
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onGone);
    port.postMessage({ cmd: 'run', job });
  });
}

// ── talking to the agent ─────────────────────────────────────────────────────
const post = (path, body) =>
  fetch(`${AGENT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function report(id, body) {
  for (let i = 0; i < 3; i++) {
    try {
      if ((await post('/result', { id, ...body })).ok) return;
    } catch { /* the agent is restarting */ }
    await sleep(1000);
  }
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      let job = null;
      try {
        const r = await fetch(`${AGENT}/poll`);
        if (r.status === 200) job = (await r.json()).job;
      } catch {
        await sleep(3000); // the agent is not up yet
        continue;
      }
      if (!job) continue;
      const beat = setInterval(() => post('/beat', { id: job.id }).catch(() => {}), 5_000);
      try {
        await report(job.id, { ok: true, result: await run(job) });
      } catch (e) {
        await report(job.id, { ok: false, error: e.message || String(e) });
      } finally {
        clearInterval(beat);
      }
    }
  } finally {
    polling = false;
  }
}

// A service worker is stopped when idle; the alarm brings the loop back.
chrome.alarms.create('gemini-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'gemini-keepalive') pollLoop(); });
chrome.runtime.onStartup.addListener(pollLoop);
chrome.runtime.onInstalled.addListener(pollLoop);
pollLoop();
