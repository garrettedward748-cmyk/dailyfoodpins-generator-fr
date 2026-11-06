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
  const url = account ? `${base}?authuser=${encodeURIComponent(account)}` : base;
  const tab = await geminiTab();
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

async function run(job) {
  const port = await openFresh(job.payload.account || '', job.payload.conversationId || '');
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
