// Agent bridge: lets the imagegen service beside this Chrome hand prompts to
// Flow Batch, the way the Gemini Chat extension takes its prompts.
//
// Long-polls http://127.0.0.1:8100/ext/flowbatch/poll for one prompt at a time,
// opens (or reuses) the Flow tab on the prompt's project, runs it as a one-item
// batch through the same content scripts the side panel drives, and posts the
// outcome back: whether it finished and where each result is served from.
// Nothing is downloaded: the agent reads the result off the project itself.
//
// In a browser with no agent beside it (a person's own Brave), every poll fails
// and the loop backs off to one quiet attempt a minute. Nothing else changes.
const FB_AGENT = 'http://127.0.0.1:8100/ext/flowbatch';
const FB_FLOW = 'https://flow.google.com/';

let fbPolling = false;
const fbSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── the Flow tab ─────────────────────────────────────────────

function fbTabLoaded(tabId, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdate);
      resolve();
    }
    function onUpdate(id, info) {
      if (id === tabId && info.status === 'complete') done();
    }
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
}

// The tab already on this project, or a Flow tab moved onto it, or a new one.
// The account segment (/u/N/) is copied from whatever Flow tab is open, so the
// project opens under the account that owns it.
async function fbProjectTab(projectId) {
  const tabs = await chrome.tabs.query({});
  const flow = tabs.filter((t) => (t.url || '').startsWith(FB_FLOW));
  const here = flow.find((t) => (t.url || '').includes(`/project/${projectId}`));
  if (here) return here;

  const prefix = (flow.map((t) => /^https:\/\/flow\.google\.com\/(u\/\d+\/)/.exec(t.url || '')).find(Boolean) || [])[1] || '';
  const url = `${FB_FLOW}${prefix}project/${projectId}`;
  const tab = flow[0]
    ? await chrome.tabs.update(flow[0].id, { url })
    : await chrome.tabs.create({ url, active: true });
  await fbTabLoaded(tab.id);
  return chrome.tabs.get(tab.id);
}

// The content scripts answer PING once they are in the page.
async function fbReady(tabId) {
  for (let i = 0; i < 120; i++) {
    try {
      const reply = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (reply?.ok) return reply;
    } catch { /* not injected yet */ }
    await fbSleep(500);
  }
  throw new Error('NO_PROMPT_BOX: the Flow page never loaded Flow Batch');
}

// ─── one prompt ───────────────────────────────────────────────

async function fbRun(job) {
  const p = job.payload || {};
  if (!p.projectId) throw new Error('No Flow project id on the prompt');
  if (!p.prompt) throw new Error('Empty prompt');

  const tab = await fbProjectTab(p.projectId);
  // In front, so the debugger's clicks land on a page that is laid out.
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  const page = await fbReady(tab.id);
  if (!(page.url || '').includes('/project/')) {
    throw new Error('NOT_SIGNED_IN: Flow did not open the project (signed out, or the project belongs to another account)');
  }

  const images = (p.images || []).filter((im) => im && im.name && im.dataUrl);
  const mode = images.length ? 'imageToImage' : 'textToImage';
  const stored = await chrome.storage.local.get('selectors');
  const selectors = { ...FlowBatch.DEFAULT_SELECTORS, ...(stored.selectors || {}) };
  const settings = {
    ...FlowBatch.DEFAULT_SETTINGS,
    mode,
    model: p.model || '',
    aspectRatio: p.aspectRatio || '',
    outputCount: 1,
    quality: 'none',
    maxInFlight: 1,
    retries: 1,
    delayMin: 0,
    delayMax: 0,
    timeoutMinutes: Math.max(2, Math.round((p.timeoutMs || 360_000) / 60_000)),
    maxImagesPerPrompt: 3,
    attachAll: true,
    chain: false,
    zoomOut: true,
  };
  const item = {
    prompt: String(p.prompt).replace(/\s+/g, ' ').trim(),
    mode,
    model: settings.model,
    aspectRatio: settings.aspectRatio,
    outputCount: 1,
    videoLength: '',
    quality: 'none',
    imageNames: [],
    characters: [],
    chain: false,
    attachAll: true,
  };

  const finished = fbWaitFor(job.id, tab.id, (p.timeoutMs || 360_000) + 60_000);

  // A run left over in the tab (one that timed out) is stopped first.
  await chrome.tabs.sendMessage(tab.id, { type: 'STOP' }).catch(() => {});
  let started = null;
  for (let i = 0; i < 20; i++) {
    started = await chrome.tabs
      .sendMessage(tab.id, { type: 'START', runId: job.id, items: [item], settings, selectors, library: images })
      .catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (started?.ok) break;
    await fbSleep(1000);
  }
  if (!started?.ok) {
    finished.cancel();
    throw new Error(`Flow Batch would not start: ${started?.error || 'no answer from the page'}`);
  }

  const status = await finished;
  const result = (status.results || [])[0] || {};
  if (result.status === 'done') return { sources: result.sources || [] };
  throw new Error(result.error || `Flow Batch ended as ${status.state}`);
}

// Resolves with the batch's last STATUS once it stops running. The run id ties
// the status to this prompt, which survives the page reloading mid-run.
function fbWaitFor(runId, tabId, timeoutMs) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('TIMEOUT: Flow Batch did not finish the prompt in time')), timeoutMs);
    function finish(err, status) {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (err) reject(err);
      else resolve(status);
    }
    function onMessage(msg, sender) {
      if (msg?.type !== 'STATUS' || sender.tab?.id !== tabId) return;
      const status = msg.data || {};
      if (status.runId !== runId || status.state === 'running') return;
      finish(null, status);
    }
    function onRemoved(id) {
      if (id === tabId) finish(new Error('NO_PROMPT_BOX: the Flow tab closed during the prompt'));
    }
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.tabs.onRemoved.addListener(onRemoved);
    cancel = () => finish(new Error('cancelled'));
  });
  promise.catch(() => {});
  promise.cancel = () => cancel();
  return promise;
}

// ─── talking to the agent ─────────────────────────────────────

const fbPost = (path, body) =>
  fetch(`${FB_AGENT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function fbReport(id, body) {
  for (let i = 0; i < 3; i++) {
    try {
      if ((await fbPost('/result', { id, ...body })).ok) return;
    } catch { /* the agent is restarting */ }
    await fbSleep(1000);
  }
}

async function fbPollLoop() {
  if (fbPolling) return;
  fbPolling = true;
  let backoff = 3000;
  try {
    for (;;) {
      let job = null;
      try {
        const r = await fetch(`${FB_AGENT}/poll`);
        if (r.status === 200) job = (await r.json()).job;
        backoff = 3000;
      } catch {
        // No agent here (a person's own browser), or it is not up yet.
        await fbSleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }
      if (!job) continue;
      const beat = setInterval(() => fbPost('/beat', { id: job.id }).catch(() => {}), 5_000);
      try {
        await fbReport(job.id, { ok: true, result: await fbRun(job) });
      } catch (e) {
        await fbReport(job.id, { ok: false, error: e.message || String(e) });
      } finally {
        clearInterval(beat);
      }
    }
  } finally {
    fbPolling = false;
  }
}

// A service worker is stopped when idle; the alarm brings the loop back.
chrome.alarms.create('flowbatch-bridge', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'flowbatch-bridge') fbPollLoop(); });
chrome.runtime.onStartup.addListener(fbPollLoop);
chrome.runtime.onInstalled.addListener(fbPollLoop);
fbPollLoop();
