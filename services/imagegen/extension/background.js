/**
 * Flow Kit — Chrome Extension Background Service Worker
 *
 * Connects to local Python agent via WebSocket (agent runs WS server).
 * Captures bearer token, solves reCAPTCHA, proxies API calls through browser.
 */

const AGENT_WS_URL = 'ws://127.0.0.1:9222';
// NOTE: This is a browser-restricted public API key — safe to ship in extension bundles.
const API_KEY = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';

let ws = null;
let flowKey = null;
let callbackSecret = null;  // Auth secret for HTTP callback, received from server on WS connect
let state = 'off'; // off | idle | running
let manualDisconnect = false;

// ─── Account rotation state ───────────────────────────────────
let accounts = [];          // ["email1@gmail.com", "email2@gmail.com"]
let currentAuthUser = 0;    // Index matching Google's ?authuser=N
let autoRotate = true;

let metrics = {
  tokenCapturedAt: null,
  requestCount: 0,   // captcha-consuming requests only (gen image/video/upscale)
  successCount: 0,
  failedCount: 0,
  lastError: null,
};

// ─── URL → Log Type Classifier ─────────────────────────────

// Visible log types — only these appear in the request log
const _VISIBLE_TYPES = new Set(['GEN_IMG', 'GEN_VID', 'GEN_VID_REF', 'UPSCALE', 'TRACKING', 'URL_REFRESH']);

function _classifyApiUrl(url) {
  if (url.includes('uploadImage'))                     return 'UPLOAD';
  if (url.includes('batchGenerateImages'))              return 'GEN_IMG';
  if (url.includes('UpsampleVideo'))                   return 'UPSCALE';
  if (url.includes('ReferenceImages'))                 return 'GEN_VID_REF';
  if (url.includes('batchAsyncGenerateVideo'))          return 'GEN_VID';
  if (url.includes('batchCheckAsync'))                  return 'POLL';
  if (url.includes('upsampleImage'))                   return 'UPS_IMG';
  if (url.includes('/media/'))                         return 'MEDIA';
  if (url.includes('/credits'))                        return 'CREDITS';
  return 'API';
}

// ─── Request Log ────────────────────────────────────────────

let requestLog = [];

function addRequestLog(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 100) requestLog.pop();
  broadcastRequestLog();
}

function updateRequestLog(id, updates) {
  const entry = requestLog.find((e) => e.id === id);
  if (entry) Object.assign(entry, updates);
  broadcastRequestLog();
}

function broadcastRequestLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => {});
}

// ─── Startup ────────────────────────────────────────────────

// Also at the top level, not only in init(): a service worker revived by an
// event fires neither onInstalled nor onStartup, and the panel behaviour is
// worth asserting on every load. Idempotent, so repeating it costs nothing.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'reconnect') connectToAgent();
  if (alarm.name === 'keepAlive') keepAlive();
  if (alarm.name === 'token-refresh') {
    await refreshFlowToken('scheduled');
  }
  // Unconditional tab recycle. Something in a Flow tab left open for many
  // hours stops it producing a usable token, and a manual refresh has
  // consistently fixed it on the spot. Rather than keep hunting for what
  // decays, recycle the tab on a timer — cheap, and it matches the fix that
  // demonstrably works.
  if (alarm.name === 'tab-recycle' || alarm.name === 'tab-recycle-retry') {
    await refreshFlowToken('periodic');
  }
  if (alarm.name === 'flow-tab-idle') {
    await closeIdleFlowTab();
  }
});

// ─── State hydration ────────────────────────────────────────
// An MV3 service worker is terminated after ~30s idle and revived by the next
// event. Revival re-runs this file from scratch, so every module-level
// variable — flowKey included — resets to its initial value, and neither
// onInstalled nor onStartup fires to restore it.
//
// That is the real cause of NO_FLOW_KEY appearing after a long run: the token
// was never lost, just forgotten. It sat in chrome.storage the whole time.
// Reloading the Flow tab appeared to fix it only because the reload made the
// page send a request, and the header listener re-captured the token.
//
// Hydrating at module scope restores it on every revival, and awaiting the
// same promise before reading flowKey closes the race where a request arrives
// mid-hydration.

// The account segment Flow puts in its URLs: '' or 'u/N/'.
//
// https://flow.google.com/project/<id> belongs to the profile's default Google
// account; https://flow.google.com/u/4/project/<id> to its fifth. Which one
// depends on how many accounts are signed in to this Chrome, so it differs
// per installation and cannot be configured once. It is learned from any Flow
// URL the tab lands on and kept in storage, so a project URL built here goes
// to the account that owns the project rather than to account 0.
let flowPathPrefix = '';

function rememberFlowPrefix(url) {
  const m = /^https:\/\/flow\.google\.com\/(u\/\d+\/)?(project\/)?/.exec(url || '');
  if (!m) return;
  const seen = m[1] || '';
  // A bare /project/ URL is authoritative for 'no prefix'; a bare home URL is
  // not, since Google may still be about to redirect it to /u/N/.
  if (!seen && !m[2]) return;
  if (seen === flowPathPrefix) return;
  flowPathPrefix = seen;
  chrome.storage.local.set({ flowPathPrefix });
  console.log(`[FlowAgent] Flow account path is now '${seen || '(default account)'}'`);
}

chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.url) rememberFlowPrefix(change.url);
});

let _hydration = null;
let _hydratedAt = null;
const _workerStartedAt = Date.now();

async function reloadFromStorage() {
  const data = await chrome.storage.local.get([
    'flowKey', 'metrics', 'callbackSecret', 'accounts', 'currentAuthUser', 'autoRotate',
    'flowPathPrefix',
  ]);
  if (data.flowKey) flowKey = data.flowKey;
  if (typeof data.flowPathPrefix === 'string') flowPathPrefix = data.flowPathPrefix;
  if (data.metrics) Object.assign(metrics, data.metrics);
  if (data.callbackSecret) callbackSecret = data.callbackSecret;
  if (data.accounts) accounts = data.accounts;
  if (data.currentAuthUser !== undefined) currentAuthUser = data.currentAuthUser;
  if (data.autoRotate !== undefined) autoRotate = data.autoRotate;
  _hydratedAt = Date.now();
  console.log('[FlowAgent] State loaded from storage (flowKey present:', !!flowKey, ')');
  return !!flowKey;
}

function ensureHydrated() {
  // Cached deliberately: the common case is many calls per worker lifetime and
  // only the first needs to touch storage. Recovery paths must NOT use this —
  // a cached "no token" result would be returned forever even after one lands
  // in storage. They call reloadFromStorage() directly.
  if (!_hydration) _hydration = reloadFromStorage();
  return _hydration;
}

// Runs on every service-worker revival, not only on install/startup.
ensureHydrated();

// Chrome starts on about:blank and is pointed at the right page from here,
// because the right page depends on why it was started. For a queued job that
// is the job's project -- the agent says which -- so the first page Google
// sees is the one the work needs, rather than the home page followed by a
// navigation away from it. With nothing queued it is the home page, which is
// what someone opening the Browser page to sign in expects.
const AGENT_LANDING_URL = 'http://127.0.0.1:8100/ext/landing';

async function landWhereTheWorkIs() {
  let url = FLOW_HOME;
  try {
    const resp = await fetch(AGENT_LANDING_URL);
    if (resp.ok) url = (await resp.json())?.url || FLOW_HOME;
  } catch (e) {
    console.warn('[FlowAgent] Could not ask the agent where to land:', e?.message);
  }
  // The agent knows the project, not the account; the account segment is ours.
  const project = /^https:\/\/flow\.google\.com\/project\/(.+)$/.exec(url);
  if (project) url = projectUrl(project[1]);

  // Only a tab that is nowhere yet. A Flow tab already on a project is left
  // alone -- this runs on install and startup, never on a page mid-use.
  const tabs = await chrome.tabs.query({});
  const blank = tabs.find((t) => !t.url || t.url === 'about:blank' || t.url === 'chrome://newtab/');
  const home = tabs.find((t) => isFlowUrl(t.url) && !(t.url || '').includes('/project/'));
  const tab = blank || home;
  if (!tab) return;
  if ((tab.url || '') === url) return;

  console.log('[FlowAgent] Landing on ' + url);
  recordTabEvent('landed', 'startup', { url });
  await chrome.tabs.update(tab.id, { url }).catch(() => {});
}

async function init() {
  // The toolbar icon opens the side panel. The popup it used to open is a
  // small window that closes the moment focus leaves it; the panel stays
  // beside the Flow tab, which is where someone watching a run wants it.
  // default_popup is gone from the manifest for the same reason -- a popup
  // there takes the click before this setting is consulted.
  chrome.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});

  await ensureHydrated();
  await landWhereTheWorkIs();
  connectToAgent();
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
  // One minute is the floor Chrome enforces for a repeating alarm; the idle
  // window itself is FLOW_TAB_IDLE_CLOSE_MS and is checked inside.
  chrome.alarms.create('flow-tab-idle', { periodInMinutes: 1 });
}

// ─── Token Capture ──────────────────────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!value.startsWith('Bearer ya29.')) return;

    const token = value.replace(/^Bearer\s+/i, '').trim();
    if (!token) return;

    // Always update — even if same token string, refresh the timestamp
    flowKey = token;
    metrics.tokenCapturedAt = Date.now();
    chrome.storage.local.set({ flowKey, metrics });
    console.log('[FlowAgent] Bearer token captured');

    // Notify agent
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
  },
  {
    urls: [
      'https://aisandbox-pa.googleapis.com/*',
      'https://flow.google.com/*',
      'https://labs.google/*',
    ],
  },
  ['requestHeaders', 'extraHeaders'],
);

let _openingFlowTab = false;

async function captureTokenFromFlowTab() {
  const tabs = await chrome.tabs.query({
    url: FLOW_TAB_URLS,
  });
  if (!tabs.length) {
    if (_openingFlowTab) {
      console.log('[FlowAgent] Flow tab already opening, skipping');
      return;
    }
    _openingFlowTab = true;
    try {
      await openFlowTab('token-refresh');
      await sleep(3000);
      const retryTabs = await chrome.tabs.query({
        url: FLOW_TAB_URLS,
      });
      if (!retryTabs.length) {
        console.log('[FlowAgent] Flow tab not ready yet after open');
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: retryTabs[0].id },
        files: ['content.js'],
      });
      console.log('[FlowAgent] Token refresh triggered on newly opened Flow tab');
    } catch (e) {
      console.error('[FlowAgent] Token refresh failed after opening tab:', e);
    } finally {
      _openingFlowTab = false;
    }
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      files: ['content.js'],
    });
    console.log('[FlowAgent] Token refresh triggered on Flow tab');
  } catch (e) {
    console.error('[FlowAgent] Token refresh failed:', e);
  }
}

// ─── Diagnostics ────────────────────────────────────────────
// NO_FLOW_KEY has now been "fixed" twice and come back. The failure only
// appears after many hours, so it cannot be reproduced on demand — the only
// way to stop guessing is to record enough state that one snapshot taken while
// it is broken identifies the cause.
//
// The distinctions that matter, none of which the old status message could
// tell apart:
//   token in memory but not storage   the worker holds it, persistence failed
//   token in storage but not memory   hydration is not running or not working
//   token in neither                  capture stopped happening entirely
//   no Flow tab                       nothing can produce a token
//   Flow tab discarded                Chrome evicted it under memory pressure
//   tab URL not a Flow host          navigated away or bounced to a sign-in

async function collectDiagnostics() {
  const now = Date.now();
  const diag = {
    now: new Date(now).toISOString(),
    worker_uptime_s: Math.round((now - _workerStartedAt) / 1000),
    hydrated_at: _hydratedAt ? new Date(_hydratedAt).toISOString() : null,
    state,
    ws_open: ws?.readyState === WebSocket.OPEN,

    token_in_memory: !!flowKey,
    token_age_s: metrics.tokenCapturedAt
      ? Math.round((now - metrics.tokenCapturedAt) / 1000) : null,
    token_captured_at: metrics.tokenCapturedAt
      ? new Date(metrics.tokenCapturedAt).toISOString() : null,

    metrics: { ...metrics },
    refresh_in_flight: _refreshInFlight,

    // Why the idle close did or did not fire.
    //
    // These are the two module-level values closeIdleFlowTab() guards on, and
    // without them a tab still open twenty minutes after the last job is
    // indistinguishable from one being legitimately held: the extension's
    // console never reaches `docker logs`, so nothing about that decision was
    // observable from outside the browser. Both are counters a run mutates, so
    // a run that leaks one strands the tab open at the cost this closing exists
    // to avoid, and the only symptom is CPU that never comes down.
    flow_tab_users: _flowTabUsers,
    flow_tab_idle_since: _flowTabIdleSince
      ? new Date(_flowTabIdleSince).toISOString()
      : null,
    flow_tab_idle_age_s: _flowTabIdleSince
      ? Math.round((now - _flowTabIdleSince) / 1000)
      : null,
    flow_tab_idle_close_after_s: Math.round(FLOW_TAB_IDLE_CLOSE_MS / 1000),
  };

  try {
    const stored = await chrome.storage.local.get(['flowKey', 'metrics']);
    diag.token_in_storage = !!stored.flowKey;
    diag.token_matches_storage = !!stored.flowKey && stored.flowKey === flowKey;
    diag.storage_token_captured_at = stored.metrics?.tokenCapturedAt
      ? new Date(stored.metrics.tokenCapturedAt).toISOString() : null;
  } catch (e) {
    diag.token_in_storage = 'error: ' + e.message;
  }

  try {
    const flowTabs = await queryFlowTabs();
    diag.flow_tabs = flowTabs.map((t) => ({
      id: t.id,
      url: (t.url || '').slice(0, 120),
      status: t.status,
      discarded: t.discarded === true,
      frozen: t.frozen === true,
      active: t.active,
    }));
    const allTabs = await chrome.tabs.query({});
    diag.total_tabs = allTabs.length;
    diag.non_flow_tab_urls = allTabs
      .filter((t) => !(t.url || '').includes('/tools/flow'))
      .map((t) => (t.url || '').slice(0, 90))
      .slice(0, 10);
  } catch (e) {
    diag.flow_tabs = 'error: ' + e.message;
  }

  try {
    const alarms = await chrome.alarms.getAll();
    diag.alarms = alarms.map((a) => ({
      name: a.name,
      next_in_s: Math.round((a.scheduledTime - now) / 1000),
      period_min: a.periodInMinutes,
    }));
  } catch (e) {
    diag.alarms = 'error: ' + e.message;
  }

  diag.tab_audit_recent = tabAudit.slice(-10);
  return diag;
}

// ─── Flow token refresh ─────────────────────────────────────
// The bearer token expires after roughly an hour. Injecting content.js is not
// enough to renew it: capture is passive, driven by the Authorization header
// on requests the *page* makes, and injecting a script into an idle tab makes
// the page send nothing. Reloading it does.
//
// This reloads an existing tab. It never creates one, so it does not go
// through the openFlowTab gate and cannot contribute to runaway tab creation.

const TOKEN_MAX_AGE_MS = 30 * 60 * 1000;   // refresh well inside the ~60min life
const TAB_RECYCLE_MINUTES = 12 * 60;       // unconditional Flow tab reload
// How long to let a reloaded tab settle before anyone messages it. Longer
// than a healthy Flow load and shorter than the agent's 45s refresh_token
// timeout, so a slow page delays a batch rather than failing the call.
const RELOAD_SETTLE_TIMEOUT_MS = 25000;
let _refreshInFlight = false;

async function refreshFlowToken(reason) {
  await ensureHydrated();

  if (_refreshInFlight) {
    console.log('[FlowAgent] Token refresh already running, skipping');
    return false;
  }

  // Never reload mid-generation: the in-flight request would go with it.
  // Retry shortly instead of waiting for the next full period.
  if (state === 'running' && reason !== 'on-demand') {
    console.log('[FlowAgent] Busy generating, deferring reload by 5min');
    chrome.alarms.create('tab-recycle-retry', { delayInMinutes: 5 });
    return false;
  }

  // 'periodic' reloads unconditionally. The age check below applies only to
  // 'scheduled', and in practice made that path dead code: the Flow page
  // refreshes its own token constantly, so tokenCapturedAt is almost always
  // recent and the reload was skipped every time. The observed failure —
  // generation stops after many hours, a manual tab refresh fixes it
  // instantly — is cured by recycling the tab regardless of token age.
  if (reason === 'periodic') {
    console.log('[FlowAgent] Periodic tab recycle');
  } else {
    const age = metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : Infinity;
    if (reason === 'scheduled' && flowKey && age < TOKEN_MAX_AGE_MS) {
      console.log('[FlowAgent] Token still fresh (' + Math.round(age / 60000) + 'min), skipping reload');
      return false;
    }
  }

  _refreshInFlight = true;
  try {
    const tabs = await queryFlowTabs();
    if (!tabs.length) {
      // Nothing to recycle, and on a timer this must not become "open one".
      //
      // The tab is now closed on purpose between runs, and both the 15-minute
      // token refresh and the 12-hour recycle land in that gap. Falling
      // through to captureTokenFromFlowTab() here would reopen the tab and
      // leave it open, which is the entire cost this closing was for. There is
      // also nothing to keep fresh: the next run opens a new tab and captures
      // a new token as it loads.
      if (reason !== 'on-demand' && _flowTabUsers === 0) {
        console.log('[FlowAgent] No Flow tab and none in use — nothing to refresh (' + reason + ')');
        return false;
      }
      // No tab to reload — fall back to the guarded open/inject path.
      await captureTokenFromFlowTab();
      return !!flowKey;
    }

    // Reloading a dead project page just loads it again, and it will never
    // produce a token. Go somewhere that will.
    if (isDeadProjectPage(tabs[0].url)) {
      console.warn('[FlowAgent] Tab is on the Flow 404 page; returning to the project list');
      const home = waitForTabLoad(tabs[0].id, 20000);
      await chrome.tabs.update(tabs[0].id, { url: FLOW_HOME });
      await home.catch(() => {});
    }

    const before = metrics.tokenCapturedAt;
    console.log('[FlowAgent] Reloading Flow tab to refresh token (' + reason + ')');
    // Listener attached before the reload, not after: an idle tab emits no
    // onUpdated events, so the first 'complete' we see is this reload's -- and
    // attaching afterwards can miss a fast reload entirely and then sit out
    // the whole timeout on every batch.
    const settled = waitForTabLoad(tabs[0].id, RELOAD_SETTLE_TIMEOUT_MS);
    await chrome.tabs.reload(tabs[0].id, { bypassCache: false });

    // Wait for the page to finish loading, not just for a token to appear.
    //
    // These are seconds apart and the gap is the whole bug. The Authorization
    // header travels on the page's very first request, so tokenCapturedAt
    // updates almost immediately -- while the document is still loading and
    // content.js is not in place yet. Returning there told the agent the tab
    // was ready, it dispatched the batch, and the captcha message went to a
    // tab that was still navigating: the channel closed mid-solve
    // ("a listener indicated an asynchronous response ... message channel
    // closed"), solveCaptcha called that a transport failure, and recovery
    // opened a fresh Flow tab. Once per batch, because the reload is once per
    // batch.
    //
    // A reload that does not settle is not fatal on its own -- the captcha
    // path has its own recovery -- so a timeout here is a warning and the
    // token check below still decides the outcome.
    try {
      await settled;
    } catch (e) {
      console.warn('[FlowAgent] Flow tab did not finish loading after reload:', e.message);
    }

    // The header listener has almost certainly fired by now. Poll anyway: a
    // page served from cache can settle without re-requesting.
    for (let i = 0; i < 20; i++) {
      if (metrics.tokenCapturedAt && metrics.tokenCapturedAt !== before) {
        console.log('[FlowAgent] Token refreshed after reload');
        return true;
      }
      await sleep(1000);
    }
    console.warn('[FlowAgent] Reloaded but no new token seen within 20s');
    return false;
  } catch (e) {
    console.error('[FlowAgent] Token refresh failed:', e);
    return false;
  } finally {
    _refreshInFlight = false;
  }
}

// ─── WebSocket to Agent ─────────────────────────────────────

function connectToAgent() {
  if (manualDisconnect) return;
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(AGENT_WS_URL);
  } catch (e) {
    console.error('[FlowAgent] WS connect error:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[FlowAgent] Connected to agent');
    chrome.alarms.clear('reconnect');
    setState('idle');

    // Token refresh alarm — 45 min gives buffer before ~60 min expiry
    chrome.alarms.create('token-refresh', { periodInMinutes: 15 });
    // 12 hours. Alarms persist across service-worker restarts, so creating it
    // on every connect just resets the schedule rather than stacking timers.
    chrome.alarms.create('tab-recycle', { periodInMinutes: TAB_RECYCLE_MINUTES });

    // Send current state + resend token if we have one
    ws.send(JSON.stringify({
      type: 'extension_ready',
      flowKeyPresent: !!flowKey,
      tokenAge: flowKey && metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
    }));
    if (flowKey) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
  };

  ws.onmessage = async ({ data }) => {
    try {
      const msg = JSON.parse(data);

      if (msg.method === 'batch_rpc') {
        await handleBatchRpc(msg);
      } else if (msg.method === 'discover_image_models') {
        sendToAgent({ id: msg.id, result: await discoverImageModels(msg.params || {}) });
      } else if (msg.method === 'ui_generate_image') {
        // Holds the Flow tab itself, around the submit only (uiGenerateOnce).
        sendToAgent({ id: msg.id, result: await uiGenerateOnce(msg.params || {}) });
      } else if (msg.method === 'ui_page_images') {
        sendToAgent({ id: msg.id, result: await uiPageImages() });
      } else if (msg.method === 'ui_job_tiles') {
        sendToAgent({ id: msg.id, result: await uiJobTiles(msg.params || {}) });
      } else if (msg.method === 'ui_tile_image') {
        sendToAgent({ id: msg.id, result: await uiTileImage(msg.params || {}) });
      } else if (msg.method === 'ui_page_errors') {
        sendToAgent({ id: msg.id, result: await uiPageErrors(msg.params || {}) });
      } else if (msg.method === 'ui_probe_picker') {
        sendToAgent({ id: msg.id, result: await uiProbePicker(msg.params || {}) });
      } else if (msg.method === 'create_flow_project') {
        sendToAgent({ id: msg.id, result: await createFlowProject() });
      } else if (msg.method === 'google_login') {
        sendToAgent({ id: msg.id, result: await googleLoginStep(msg.params || {}) });
      } else if (msg.method === 'scan_flow_ui') {
        sendToAgent({ id: msg.id, result: await scanFlowUi(msg.params || {}) });
      } else if (msg.method === 'api_request') {
        await handleApiRequest(msg);
      } else if (msg.method === 'trpc_request') {
        await handleTrpcRequest(msg);
      } else if (msg.method === 'solve_captcha') {
        await handleSolveCaptcha(msg);
      } else if (msg.method === 'get_status') {
        sendToAgent({
          id: msg.id,
          result: {
            state,
            flowKeyPresent: !!flowKey,
            manualDisconnect,
            tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
            metrics,
          },
        });
      } else if (msg.method === 'refresh_token') {
        // Called by the worker before it starts a batch. Reloading the Flow
        // tab is the only thing that renews the bearer — see refreshFlowToken —
        // and it keeps cookies and the signed-in Google account untouched,
        // because it is a page reload and not a sign-out.
        const maxAgeMs = msg.params?.maxAgeMs ?? 0;
        await ensureHydrated();
        const age = metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : Infinity;
        if (maxAgeMs && flowKey && age < maxAgeMs) {
          sendToAgent({ id: msg.id, result: { ok: true, reloaded: false, tokenAgeMs: age } });
        } else {
          const ok = await refreshFlowToken('on-demand');
          const freshAge = metrics.tokenCapturedAt
            ? Date.now() - metrics.tokenCapturedAt
            : null;
          sendToAgent({
            id: msg.id,
            result: { ok, reloaded: true, tokenAgeMs: freshAge, flowKeyPresent: !!flowKey },
          });
        }
      } else if (msg.method === 'get_diagnostics') {
        sendToAgent({ id: msg.id, result: await collectDiagnostics() });
      } else if (msg.type === 'callback_secret') {
        callbackSecret = msg.secret;
        chrome.storage.local.set({ callbackSecret: msg.secret });
        console.log('[FlowAgent] Received callback secret');
      } else if (msg.type === 'pong') {
        // keepalive response
      } else if (msg.method === 'set_accounts') {
        // Update account list from agent
        accounts = msg.params?.accounts || [];
        autoRotate = msg.params?.autoRotate !== undefined ? msg.params.autoRotate : autoRotate;
        if (msg.params?.currentAuthUser !== undefined) currentAuthUser = msg.params.currentAuthUser;
        chrome.storage.local.set({ accounts, autoRotate, currentAuthUser });
        console.log('[FlowAgent] Accounts updated:', accounts.length, 'accounts, authuser=' + currentAuthUser);
        sendToAgent({ id: msg.id, result: { ok: true, count: accounts.length, currentAuthUser } });
      } else if (msg.method === 'switch_account') {
        handleSwitchAccount(msg);
      } else if (msg.method === 'get_account_status') {
        sendToAgent({ id: msg.id, result: {
          accounts,
          currentAuthUser,
          autoRotate,
          flowKeyPresent: !!flowKey,
          connected: ws?.readyState === WebSocket.OPEN,
        }});
      }
    } catch (e) {
      console.error('[FlowAgent] Message error:', e);
    }
  };

  ws.onclose = () => {
    setState('off');
    chrome.alarms.clear('token-refresh');
    if (!manualDisconnect) scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('[FlowAgent] WS error:', e);
    metrics.lastError = 'WS_ERROR';
    chrome.storage.local.set({ metrics });
  };
}

function scheduleReconnect() {
  chrome.alarms.create('reconnect', { delayInMinutes: 0.083 }); // ~5s
}

function keepAlive() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  } else {
    connectToAgent();
  }
}

// ─── Account Switching ──────────────────────────────────────

/**
 * Wait for a tab to finish loading, with timeout.
 */
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout (' + timeoutMs + 'ms)'));
    }, timeoutMs);
    const listener = (changedTabId, changeInfo) => {
      if (changedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Switch to a different Google account in the Flow tab.
 * Navigates to ?authuser=N to switch account context.
 * @param {object} msg - WS message { id, params: { authUser, auto } }
 */
async function handleSwitchAccount(msg) {
  const { id, params = {} } = msg;
  const { authUser, auto } = params;

  let targetUser;
  if (typeof authUser === 'number') {
    targetUser = authUser;
  } else if (auto && accounts.length > 1) {
    // Auto-rotate: try the next account in the list
    targetUser = (currentAuthUser + 1) % accounts.length;
  } else if (authUser === 'next') {
    targetUser = (currentAuthUser + 1) % Math.max(accounts.length, 1);
  } else if (authUser === 'prev') {
    targetUser = (currentAuthUser - 1 + accounts.length) % Math.max(accounts.length, 1);
  } else {
    targetUser = 0;
  }

  try {
    const tabs = await chrome.tabs.query({
      url: FLOW_TAB_URLS,
    });

    if (!tabs.length) {
      // No Flow tab open — just update the index and try to open one
      currentAuthUser = targetUser;
      chrome.storage.local.set({ currentAuthUser });
      await openFlowTab('switch-account', FLOW_HOME + '?authuser=' + targetUser);
      await sleep(5000);
      await captureTokenFromFlowTab();
      sendToAgent({ id, result: { ok: true, authUser: targetUser, note: 'opened new tab' } });
      return;
    }

    const tab = tabs[0];
    const url = new URL(tab.url);
    url.searchParams.set('authuser', String(targetUser));
    const newUrl = url.toString();

    console.log('[FlowAgent] Switching account: authuser ' + currentAuthUser + ' -> ' + targetUser);
    chrome.storage.local.set({ currentAuthUser: targetUser });

    // Navigate
    await chrome.tabs.update(tab.id, { url: newUrl });

    // Wait for page to load
    try {
      await waitForTabLoad(tab.id, 15000);
    } catch (e) {
      console.warn('[FlowAgent] Tab load wait timeout, proceeding anyway:', e.message);
      await sleep(2000);
    }

    // Extra wait for grecaptcha + token capture
    await sleep(4000);

    // Force token capture
    await captureTokenFromFlowTab();

    currentAuthUser = targetUser;
    console.log('[FlowAgent] Account switched to authuser=' + targetUser);

    sendToAgent({ id, result: { ok: true, authUser: targetUser, account: accounts[targetUser] || null } });
  } catch (e) {
    console.error('[FlowAgent] Account switch failed:', e);
    sendToAgent({ id, error: e.message || 'SWITCH_FAILED' });
  }
}

function sendToAgent(msg) {
  // API responses (with msg.id) go via HTTP — immune to WS disconnect
  if (msg.id) {
    fetch('http://127.0.0.1:8100/api/ext/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    }).catch(() => {
      // HTTP failed — fallback to WS
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
    return;
  }
  // Non-response messages (ping, status) or no secret yet — use WS
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── reCAPTCHA Solving ──────────────────────────────────────

// Self-healing captcha solver: if the Flow tab is missing or has navigated to a
// host the extension can't inject into (expired session → accounts.google.com,
// Google "unusual traffic" page, revoked site access), we open a fresh Flow tab
// and retry instead of hard-failing. Recovery is bounded and only triggers on
// fast-fail transport errors so it stays inside the agent's 60s submit window.

// Google moved Flow to its own host. Both are listed because the old address
// still redirects, and a tab opened before the move can still be sitting on it
// — but everything this extension does keys off matching the tab's URL, so a
// host it does not know about is a Flow tab it cannot see: no content script,
// no token capture, no captcha, and a "missing" tab it opens another of on
// every generation.
const FLOW_ORIGINS = ['https://flow.google.com/', 'https://labs.google/'];
const FLOW_TAB_URLS = [
  'https://flow.google.com/*',
  'https://labs.google/fx/tools/flow*',
  'https://labs.google/fx/*/tools/flow*',
];
const FLOW_HOME = 'https://flow.google.com/';

/** True for any URL this extension treats as the Flow app. */
const isFlowUrl = (url) => FLOW_ORIGINS.some((origin) => (url || '').startsWith(origin));
const CAPTCHA_HARD_TIMEOUT_MS = 30000;
const FLOW_TAB_READY_TIMEOUT_MS = 15000;   // how long to wait for a repair tab to land on Flow
const RECOVERY_MAX_ATTEMPTS = 1;            // one bounded recovery beyond the initial try

// ─── Flow tab creation choke point ──────────────────────────
// Every path that opens a Flow tab goes through openFlowTab(). Guarding each
// call site separately has already proven insufficient: the paths run
// concurrently (the worker drives MAX_CONCURRENT_REQUESTS solves in parallel,
// and rate-limit rotation fans out one switch_account per failed response),
// so the only reliable place to bound tab creation is a single global gate.

const FLOW_TAB_CREATE_COOLDOWN_MS = 20000;  // floor between two creations, any caller
let _flowTabCreateInFlight = null;
let _lastFlowTabCreatedAt = 0;

// Rolling audit of creations and of suppressed attempts, so a recurrence can be
// diagnosed from evidence instead of re-derived from the code. Read it from the
// service worker console with: chrome.runtime.sendMessage({type:'TAB_AUDIT'})
const tabAudit = [];
function recordTabEvent(action, reason, extra = {}) {
  const entry = { t: new Date().toISOString(), action, reason, ...extra };
  tabAudit.push(entry);
  if (tabAudit.length > 100) tabAudit.shift();
  console.log(`[FlowAgent][tab] ${action} reason=${reason}`, extra);
}

/**
 * Flow's own "no such project" page, which serves no API calls at all.
 *
 * Nothing navigates to a project any more — that change broke generation and
 * was reverted — but a tab left stranded on this page would never produce a
 * token again, so the refresh path still checks for it and retreats.
 */
const isDeadProjectPage = (url) => (url || '').includes('/404');

/**
 * Be on a project page before asking for a captcha.
 *
 * Measured in the page, both ways:
 *
 *   https://flow.google.com/            grecaptcha undefined
 *   https://flow.google.com/project/…   grecaptcha.enterprise.execute exists
 *
 * The list has nothing to generate, so it never loads reCAPTCHA, and a solve
 * from there fails however long it waits.
 *
 * Which project does not matter — the generation request names its own in
 * clientContext — so the address comes from a link on the page rather than
 * from a configured id. That is not a detail: building the URL from the site's
 * project id put the tab on Flow's 404 for an id this account cannot open, and
 * a 404 issues no requests, so the bearer token stopped arriving and every job
 * after it failed with NO_FLOW_KEY. A link that is on the page is a project
 * this account can open.
 */
/**
 * Wait for a project link to exist on the page, rather than asking once.
 *
 * Asking once was right when Chrome had been up for hours and the Flow tab was
 * long since loaded. Chrome now starts for a job and the first request arrives
 * about a minute later, and at that point one of two things is usually still
 * true: the content script has not been injected yet, so sendMessage rejects,
 * or it has and the project list -- which renders its links from data it is
 * still fetching -- has none to find. Both answer null, and the old code took
 * null as "this account has no projects", warned, and went on to a captcha that
 * cannot solve from the list.
 *
 * That is the CAPTCHA_FAILED that opened every cold run: it cost one whole
 * pipeline retry per article and then succeeded, because by the second attempt
 * the page had finished loading.
 *
 * Polling rather than a load event because neither failure is a load: the tab
 * can be `complete` with the list still empty.
 */
const PROJECT_LINK_WAIT_MS = 20000;
const PROJECT_LINK_POLL_MS = 1000;

async function findProjectUrl(tabId) {
  const deadline = Date.now() + PROJECT_LINK_WAIT_MS;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts++;
    const found = await chrome.tabs
      .sendMessage(tabId, { type: 'FIND_PROJECT_URL' })
      .catch(() => null);

    if (found?.url) {
      if (attempts > 1) {
        console.log(`[FlowAgent] Project link appeared after ${attempts} attempt(s)`);
      }
      return found.url;
    }
    await sleep(PROJECT_LINK_POLL_MS);
  }

  return null;
}

const projectUrl = (projectId) => `${FLOW_HOME}${flowPathPrefix}project/${projectId}`;
const isOnProject = (url, projectId) => (url || '').includes(`/project/${projectId}`);

/**
 * Go to the job's own project when it names one.
 *
 * Directly, by id, rather than via a link on the home page: that is one page
 * load instead of two and a navigation, and the tab then sits where the work
 * is. The trap this once fell into is still there -- an id the account cannot
 * open lands on Flow's 404, which issues no requests and has no reCAPTCHA --
 * so a 404 is not the end: the tab goes back to the list and the link hunt
 * below takes over, exactly as it did before ids were trusted at all.
 *
 * Returns true when the tab is on the named project.
 */
async function goToProject(tab, projectId) {
  rememberFlowPrefix(tab.url);
  if (isOnProject(tab.url, projectId)) return true;
  const target = projectUrl(projectId);

  console.log(`[FlowAgent] Moving to the job's project page: ${target}`);
  const settled = waitForTabLoad(tab.id, 20000);
  await chrome.tabs.update(tab.id, { url: target });
  await settled.catch((e) =>
    console.warn('[FlowAgent] Project page did not finish loading:', e.message),
  );

  const after = await chrome.tabs.get(tab.id).catch(() => null);
  if (after) rememberFlowPrefix(after.url);
  if (after && !isDeadProjectPage(after.url)) return true;

  console.warn(
    `[FlowAgent] Project ${projectId} is not one this account can open (Flow 404); ` +
      'returning to the project list to find one that is',
  );
  const back = waitForTabLoad(tab.id, 20000);
  await chrome.tabs.update(tab.id, { url: FLOW_HOME });
  await back.catch(() => {});
  return false;
}

async function ensureFlowTabOnProject(projectId = null) {
  const tab = (await queryFlowTabs())[0];
  if (!tab) return;
  if (projectId && (await goToProject(tab, projectId))) return;
  if ((tab.url || '').includes('/project/')) return;

  const url = await findProjectUrl(tab.id);

  if (!url) {
    console.warn(
      '[FlowAgent] No project link on the Flow page after ' +
        `${PROJECT_LINK_WAIT_MS / 1000}s — captcha will not solve from the ` +
        'project list. Is the account signed in with at least one project?',
    );
    return;
  }

  console.log('[FlowAgent] Moving to a project page for the captcha: ' + url);
  const settled = waitForTabLoad(tab.id, 20000);
  await chrome.tabs.update(tab.id, { url });
  await settled.catch((e) =>
    console.warn('[FlowAgent] Project page did not finish loading:', e.message),
  );

  // Belt to the braces: never leave the tab somewhere that serves no requests.
  const after = await chrome.tabs.get(tab.id).catch(() => null);
  if (after && isDeadProjectPage(after.url)) {
    const back = waitForTabLoad(tab.id, 20000);
    await chrome.tabs.update(tab.id, { url: FLOW_HOME });
    await back.catch(() => {});
  }
}

// Strict lookup — the set of tabs we are willing to message/inject into.
async function queryFlowTabs() {
  return chrome.tabs.query({ url: FLOW_TAB_URLS });
}

// Tolerant existence check, used ONLY to decide whether opening another tab is
// warranted. A healthy Flow tab stops matching FLOW_TAB_URLS while it is
// mid-redirect — an authuser switch bounces through accounts.google.com — and
// that blind spot is what makes concurrent callers each open "the missing tab".
async function flowTabLikelyExists() {
  if ((await queryFlowTabs()).length) return true;
  if ((await chrome.tabs.query({ url: ['https://flow.google.com/*', 'https://labs.google/*'] })).length)
    return true;
  const loading = await chrome.tabs.query({ status: 'loading' });
  return loading.some((t) => (t.url || '').startsWith('https://accounts.google.com/'));
}

// The single gate. Returns true if a Flow tab exists or was opened, false if
// creation was suppressed. Never opens more than one tab per cooldown window.
async function openFlowTab(reason, url = FLOW_HOME) {
  if (_flowTabCreateInFlight) {
    recordTabEvent('joined-inflight', reason);
    return _flowTabCreateInFlight;
  }
  _flowTabCreateInFlight = (async () => {
    if (await flowTabLikelyExists()) {
      recordTabEvent('skipped-exists', reason);
      return true;
    }
    const since = Date.now() - _lastFlowTabCreatedAt;
    if (since < FLOW_TAB_CREATE_COOLDOWN_MS) {
      recordTabEvent('suppressed-cooldown', reason, { msSinceLast: since });
      return false;
    }
    _lastFlowTabCreatedAt = Date.now();
    const tabCount = (await chrome.tabs.query({})).length;
    recordTabEvent('created', reason, { url, totalTabsBefore: tabCount });
    await chrome.tabs.create({ url, active: false });
    return true;
  })();
  try {
    return await _flowTabCreateInFlight;
  } finally {
    _flowTabCreateInFlight = null;
  }
}

function isContentsAccessError(err) {
  const m = (err?.message || '').toLowerCase();
  return (
    m.includes('cannot access contents of the page') ||
    m.includes('permission to access the respective host') ||
    m.includes('cannot access contents') ||
    m.includes('access to the respective host') ||
    m.includes('cannot access a')
  );
}

// Errors that mean "no usable Flow tab right now" — recoverable by reopening.
function isRecoverableTransportError(err) {
  const m = (err?.message || '');
  return (
    m.startsWith('TAB_HOST_BLOCKED') ||
    isContentsAccessError(err) ||
    m.includes('Receiving end does not exist') ||
    m.includes('Could not establish connection') ||
    m === 'NO_FLOW_TAB'
  );
}

// Map an internal failure reason to the code surfaced back to the agent.
function classifyTerminalCaptchaError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('timeout')) return 'CAPTCHA_TIMEOUT';
  if (m.includes('no_flow_tab')) return 'NO_FLOW_TAB';
  if (m.includes('host_blocked') || m.includes('cannot access')) return 'SESSION_EXPIRED';
  return msg || 'CAPTCHA_FAILED';
}

// Wait for a Flow tab that is fully loaded on a Flow host. Returns the tab
// or null if none settles in time (e.g. session expired → redirected away).
async function waitForFlowTabReady(timeoutMs = FLOW_TAB_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tabs = await chrome.tabs.query({ url: FLOW_TAB_URLS });
    const ready = tabs.find((t) => t.status === 'complete' && isFlowUrl(t.url));
    if (ready) return ready;
    await sleep(500);
  }
  return null;
}

// Ensure a usable Flow tab exists on a permitted host. Returns true when a
// ready Flow tab exists, false when none settled (session expired / consent /
// block page → needs manual user action, or creation was gated).
async function ensureFlowTab() {
  await openFlowTab('captcha-recovery');
  return !!(await waitForFlowTabReady());
}

// ─── Keep the Flow tab only while it is being used ──────────
//
// Measured on the deployed container: with the Flow tab closed the whole
// service idles at 43% CPU, the GPU process at 11%. With it open the GPU
// process alone takes 283%, while the renderer stays under 10% and the size of
// the screen makes no difference at all. So the cost is not the page being
// drawn -- it is a fixed-size canvas Flow animates without stop, executed by
// SwiftShader on the CPU because the container has no GPU.
//
// The tab is not needed between runs. The generation request itself is sent
// from this service worker with a stored bearer token, so the page is only
// required for two things: capturing that token, and running the reCAPTCHA.
// Both happen inside a run, and a run takes four to six minutes.
//
// So it is held open for the duration of a request and closed a couple of
// minutes after the last one finishes. Three cores for five minutes a run,
// instead of three cores forever.
//
// Opening a fresh tab per run also captures a fresh token on the way in, which
// is the thing people were achieving by hand when they refreshed the tab to
// get their access back.

const FLOW_TAB_IDLE_CLOSE_MS = 120000;

// A count, not a flag: the worker drives MAX_CONCURRENT_REQUESTS in parallel,
// and the second request finishing must not close a tab the first is still
// using.
let _flowTabUsers = 0;
let _flowTabIdleSince = null;

/** Claim the tab. Call synchronously, before any await. */
function holdFlowTab() {
  _flowTabUsers++;
  _flowTabIdleSince = null;
}

/** Give it back. The close happens on the idle alarm, not here. */
function releaseFlowTab() {
  _flowTabUsers = Math.max(0, _flowTabUsers - 1);
  if (_flowTabUsers === 0) _flowTabIdleSince = Date.now();
}

/**
 * Close the Flow tab once nothing has needed it for a while.
 *
 * Driven by an alarm rather than setTimeout on purpose. A timer dies with the
 * service worker, and a tab left open because the worker was recycled is
 * exactly the cost this is here to avoid. Alarms survive that.
 */
async function closeIdleFlowTab() {
  // state is module-level and resets to 'idle' when the worker is revived, so
  // it is checked alongside the counter rather than instead of it.
  if (_flowTabUsers > 0 || state === 'running') {
    _flowTabIdleSince = null;
    return;
  }
  // Null after a revival as well as after a hold. Either way, start counting
  // from now rather than assuming the tab has been idle all along.
  if (_flowTabIdleSince === null) {
    _flowTabIdleSince = Date.now();
    return;
  }
  if (Date.now() - _flowTabIdleSince < FLOW_TAB_IDLE_CLOSE_MS) return;

  const tabs = await queryFlowTabs();
  if (!tabs.length) return;

  // Never close Chrome's last tab.
  //
  // Chrome quits when its final tab goes, and supervisord has autorestart=true
  // with startsecs=10 — a Chrome that lived the two minutes this timer waits
  // counts as a successful start, so startretries never engages and the restart
  // is unconditional and endless. It comes back on the command line's own
  // https://labs.google/fx/tools/flow, in the foreground, animating the canvas
  // that costs 283%. Closing the tab to save three cores would spend them.
  //
  // That is not hypothetical: Chrome is launched with exactly one URL, and it
  // matches FLOW_TAB_URLS, so on a container that has never run a job every tab
  // on the browser is a tab this function removes. `about:blank` used to be on
  // that command line and would have covered it; it was removed by the revert
  // in 620b7be, which landed after this close logic and never knew about it.
  //
  // Opening the blank tab here rather than putting it back on the command line
  // keeps the invariant next to the code that depends on it, where the next
  // person editing Chrome's flags cannot take it away by accident.
  const allTabs = await chrome.tabs.query({});
  if (allTabs.length <= tabs.length) {
    await chrome.tabs
      .create({ url: 'about:blank', active: true })
      .catch((e) => console.warn('[FlowAgent] Could not open the blank tab:', e.message));
  }

  recordTabEvent('closed', 'idle', { count: tabs.length });
  await chrome.tabs
    .remove(tabs.map((t) => t.id))
    .catch((e) => console.warn('[FlowAgent] Could not close the idle Flow tab:', e.message));
}

async function requestCaptchaFromTab(tabId, requestId, pageAction) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) {
      // sendMessage itself hit a host-access failure (tab navigated off Flow).
      if (isContentsAccessError(error)) throw new Error('TAB_HOST_BLOCKED: ' + msg);
      throw error;
    }

    // Content script not loaded yet — inject and retry.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
      await sleep(200);
      return await chrome.tabs.sendMessage(tabId, {
        type: 'GET_CAPTCHA',
        requestId,
        pageAction,
      });
    } catch (injectErr) {
      // Injection refused: tab is on a host the manifest doesn't permit. Tag it
      // so the outer loop knows this is recoverable by opening a fresh Flow tab.
      const im = injectErr?.message || 'INJECTION_FAILED';
      const tagged = isContentsAccessError(injectErr) ? 'TAB_HOST_BLOCKED: ' + im : im;
      throw new Error(tagged);
    }
  }
}

async function solveCaptcha(requestId, captchaAction) {
  let lastError = null;

  for (let attempt = 0; attempt <= RECOVERY_MAX_ATTEMPTS; attempt++) {
    const tabs = await chrome.tabs.query({ url: FLOW_TAB_URLS });

    if (tabs.length) {
      try {
        const resp = await Promise.race([
          requestCaptchaFromTab(tabs[0].id, requestId, captchaAction),
          new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), CAPTCHA_HARD_TIMEOUT_MS)),
        ]);
        // Success or a solver-level error (e.g. grecaptcha threw) — either way
        // it's a real answer, not a transport failure we can heal.
        return resp;
      } catch (e) {
        lastError = e?.message || 'CAPTCHA_FAILED';
        const recoverable = isRecoverableTransportError(e);
        // A real CAPTCHA_TIMEOUT already burned the time budget — don't recover.
        if (!recoverable || attempt === RECOVERY_MAX_ATTEMPTS) {
          return { error: classifyTerminalCaptchaError(lastError) };
        }
        // Fall through to recovery: open/repair a Flow tab and retry once.
      }
    } else {
      lastError = 'NO_FLOW_TAB';
    }

    // Last iteration — the result is already decided, so opening a repair tab
    // here would create a tab nobody retries against.
    if (attempt === RECOVERY_MAX_ATTEMPTS) break;

    // Recovery: ensure a usable Flow tab exists on a permitted host.
    const recovered = await ensureFlowTab();
    if (!recovered) {
      // Flow tab opened but didn't stay on a Flow host → bounced to a
      // login/consent/block page. Needs the user, not another retry.
      return { error: 'SESSION_EXPIRED' };
    }
  }

  return { error: classifyTerminalCaptchaError(lastError) };
}

// ─── reCAPTCHA rejection recovery ───────────────────────────
//
// A solved captcha is not an accepted captcha. grecaptcha.enterprise.execute()
// returns a token for any session; Google then *scores* it server-side and
// answers 403 "reCAPTCHA evaluation failed" when the score is under its
// threshold. That is a different failure from the solver breaking, and it used
// to be passed straight back to the agent, which classified it as permanent
// and failed the job on the first attempt of five.
//
// Reloading the Flow tab is what resets the scored session — it is exactly
// what the side panel's "Refresh Token" button does, and pressing that by hand
// was the known workaround. This does it automatically, once, then solves a
// fresh captcha and re-sends.
//
// Re-sending is safe: a 403 is returned before any generation happens, so the
// rejected attempt cost no credits and no image exists to duplicate.

const RECAPTCHA_REJECT_MAX_RETRIES = 1;
const RECAPTCHA_SETTLE_MS = 2500;

function isRecaptchaRejection(status, data) {
  if (status !== 403) return false;

  // The message lives at different depths depending on which API answered.
  let text;
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    return false;
  }
  return /recaptcha/i.test(text || '');
}

// Reload the Flow tab and wait for grecaptcha to come back up. Returns false
// when no usable tab settles, which means the session needs a person and
// retrying would only burn time.
async function resetCaptchaSession(reason) {
  console.warn(`[FlowAgent] reCAPTCHA rejected (${reason}) — reloading Flow tab for a fresh session`);
  recordTabEvent('captcha-session-reset', reason);

  // 'on-demand' bypasses both the age check and the busy-deferral: we are
  // already inside a failed request, so there is nothing left to protect.
  await refreshFlowToken('on-demand');

  const tab = await waitForFlowTabReady();
  if (!tab) {
    console.error('[FlowAgent] No Flow tab settled after reload — session needs attention');
    return false;
  }

  // The tab reports complete before grecaptcha has finished initialising, and
  // a token solicited in that window is the low-scoring kind we are recovering
  // from. injected.js polls for grecaptcha too; this is belt and braces.
  await sleep(RECAPTCHA_SETTLE_MS);
  return true;
}

async function handleSolveCaptcha(msg) {
  const { id, params } = msg;
  const result = await solveCaptcha(id, params?.captchaAction || 'VIDEO_GENERATION');

  // Standalone captcha solve counts as captcha-consuming
  metrics.requestCount++;
  if (result?.token) {
    metrics.successCount++;
  } else {
    metrics.failedCount++;
    metrics.lastError = result?.error || 'NO_TOKEN';
  }
  chrome.storage.local.set({ metrics });

  sendToAgent({ id, result });
}

// ─── API Request Proxy ──────────────────────────────────────

async function handleTrpcRequest(msg) {
  const { id, params } = msg;
  const { url, method = 'POST', headers = {}, body } = params;

  if (!isFlowUrl(url)) {
    sendToAgent({ id, error: 'INVALID_TRPC_URL' });
    return;
  }

  setState('running');
  // TRPC calls don't consume captcha — don't count in metrics

  const logId = id;
  const logType = url.includes('createProject') ? 'CREATE_PROJECT' : 'TRPC';
  // TRPC calls are silent — don't show in request log

  const fetchHeaders = { 'Content-Type': 'application/json', ...headers };
  if (flowKey) {
    fetchHeaders['authorization'] = `Bearer ${flowKey}`;
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const data = await resp.json();
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'success' });
    sendToAgent({ id, status: resp.status, data });
  } catch (e) {
    console.error('[FlowAgent] tRPC request failed:', e);
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'failed', error: e.message || 'TRPC_FETCH_FAILED' });
    sendToAgent({ id, error: e.message || 'TRPC_FETCH_FAILED' });
  } finally {
    setState('idle');
  }
}

// ─── batchexecute, the transport Flow moved to ──────────────
//
// Everything below this comment is a second way of reaching Flow, sitting
// beside the api_request path rather than replacing it. Images still go the old
// way and still work; video does not, and this is why.
//
// The old way is a fetch from this service worker to aisandbox-pa.googleapis.com
// carrying a bearer token sniffed off the page. Video began answering that with
// INVALID_ARGUMENT -- Flow refusing the request itself -- and the reason is
// visible in Flow Kit's own client: it no longer sends video that way at all.
// Flow moved to a batchexecute endpoint on flow.google.com in September 2026,
// and the calls it takes can only be signed by a page that is already signed in.
//
// So this does not send anything from here. It runs the request *inside* the
// Flow tab, which is the only context that has the three values the endpoint
// checks, all of them read off WIZ_global_data at call time:
//
//   SNlM0e   the `at` token, posted in the body
//   FdrFJe   f.sid
//   cfb2h    bl
//
// The captcha is minted moments before the request leaves and substituted into
// the payload here, because it is single-use: a replayed one comes back
// PUBLIC_ERROR_UNUSUAL_ACTIVITY. The agent builds the payload with a
// __CAPTCHA__ marker in the slot and this fills it in.
//
// Ported from the upstream Flow Kit extension, which is the reference for this
// whole service -- not invented here.

const CAPTCHA_SLOT = '__CAPTCHA__';

// The project listing runs to tens of megabytes. Anything larger than this is
// truncated inside the tab rather than pushed through the WebSocket bridge.
const MAX_RPC_TEXT = 2_000_000;

/** Chrome discards backgrounded tabs; executeScript throws on a dead one. */
async function reviveTabIfNeeded(tab) {
  if (!tab?.discarded) return tab;
  try {
    await chrome.tabs.reload(tab.id);
    await sleep(2500);
    return await chrome.tabs.get(tab.id);
  } catch {
    return null;
  }
}

async function runBatchRpc(cmd) {
  const tabs = await queryFlowTabs();
  let candidate = tabs.find((t) => !t.discarded) || tabs[0];

  if (!candidate) {
    // No Flow tab. Open one -- on the job's project when it names one, so the
    // first page Google sees is the one the work needs -- and let the app
    // boot: WIZ_global_data is not on the page immediately, and without it
    // `at` comes back empty.
    try {
      const created = await chrome.tabs.create({
        url: cmd.projectId ? projectUrl(cmd.projectId) : FLOW_HOME,
        active: false,
      });
      await waitForTabLoad(created.id, 20000).catch(() => {});
      await sleep(1500);
      const fresh = await queryFlowTabs();
      candidate = fresh.find((t) => !t.discarded) || fresh[0];
    } catch (e) {
      return { error: e?.message || 'NO_FLOW_TAB' };
    }
    if (!candidate) return { error: 'NO_FLOW_TAB' };
  }

  const tab = await reviveTabIfNeeded(candidate);
  if (!tab) return { error: 'FLOW_TAB_DISCARDED' };

  let freq = cmd.freq;
  if (cmd.captchaAction) {
    // grecaptcha is loaded on a project page and not on the project list --
    // measured in the page, both ways. The REST path has always done this before
    // asking for a token; the batch path was written without it and every
    // captcha it asked for failed. Both transports need it for the same reason:
    // the captcha is minted by the page, so the page has to be one that has it.
    await ensureFlowTabOnProject(cmd.projectId);

    const solved = await solveCaptcha(cmd.id, cmd.captchaAction);
    if (!solved?.token) return { error: `CAPTCHA_FAILED: ${solved?.error || 'no token'}` };
    freq = freq.split(CAPTCHA_SLOT).join(solved.token);
  }

  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [cmd.rpcid, freq, MAX_RPC_TEXT, cmd.match || null],
    func: async (rpcid, freqStr, maxText, match) => {
      const wiz = globalThis.WIZ_global_data || {};
      const at = wiz.SNlM0e;
      const sid = wiz.FdrFJe;
      const bl = wiz.cfb2h;
      if (!at) return { error: 'NO_AT_TOKEN' };

      // The query string Flow's own client sends, in its order. Captured off
      // a signed-in tab generating by hand, because every part of this was
      // guessed and three parts were guessed wrong:
      //
      //   source-path  the page the call came from. Flow sends it on every
      //                RPC and this sent it on none -- a generate from
      //                nowhere, which is not a request the app can make.
      //   hl           the page's own language. Hardcoded to en-AU here
      //                against a page that says en.
      //   _reqid       a session counter, not a nonce: it starts somewhere
      //                random and rises by exactly 100000 per request, so it
      //                says how far into the session a call is. A new random
      //                number each time describes a session that never gets
      //                anywhere -- and every generate we make looks like the
      //                first one a brand-new page ever sent.
      //
      // The counter continues the page's own sequence rather than keeping a
      // private one, so our calls and Flow's read as the one session they
      // are. Our own requests land in the same timeline, so it advances by
      // itself from there.
      const seen = performance.getEntriesByType('resource')
        .filter((e) => e.name.includes('batchexecute'))
        .map((e) => Number(new URLSearchParams(e.name.split('?')[1] || '').get('_reqid')))
        .filter((n) => Number.isFinite(n) && n > 0);
      const reqid = seen.length
        ? Math.max(...seen) + 100000
        : Math.floor(Math.random() * 90000) + 10000;

      const url =
        `/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=${encodeURIComponent(rpcid)}` +
        `&source-path=${encodeURIComponent(location.pathname)}` +
        `&bl=${encodeURIComponent(bl || '')}&f.sid=${encodeURIComponent(sid || '')}` +
        `&hl=${encodeURIComponent(document.documentElement.lang || 'en')}` +
        `&_reqid=${reqid}&rt=c`;

      // Caught here, in the page, because a rejection from an injected
      // function does not travel: executeScript answers with no result and
      // the error is gone. That was every "NO_INJECTION_RESULT" -- a fetch
      // cut off by the page navigating or reloading under it, reported as
      // nothing at all. The message names what happened and where the tab
      // was, which is what it takes to tell those apart.
      try {
        const resp = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'x-same-domain': '1',
          },
          body: new URLSearchParams({ 'f.req': freqStr, at }),
        });

        const text = await resp.text();
        if (match) {
          const found = text.indexOf(match);
          return {
            status: resp.status,
            matched: found !== -1,
            text: found === -1 ? '' : text.slice(found, found + 800),
          };
        }
        return { status: resp.status, text: text.slice(0, maxText) };
      } catch (e) {
        return {
          error: `INJECTION_FAILED: ${e?.name || 'Error'}: ${e?.message || String(e)} ` +
            `(${location.href})`,
        };
      }
    },
  });

  if (injected?.result) return injected.result;

  // Nothing came back and the function above did not catch it: the frame
  // itself went away mid-call (a discard, a close), or a newer Chrome put the
  // reason on the injection result. Say which, rather than the bare code.
  const detail = injected?.error?.message || injected?.error || 'the tab returned nothing';
  const where = await chrome.tabs.get(tab.id).then((t) => t?.url).catch(() => 'tab gone');
  console.warn('[FlowAgent] batch RPC returned no result:', detail, where);
  return { error: `NO_INJECTION_RESULT: ${detail} (${where})` };
}

// One captcha at a time, whatever the worker sends.
//
// The worker runs MAX_CONCURRENT_REQUESTS jobs in parallel, so two video
// submits arrive together -- and both want the same single Flow tab: one
// navigates it to a project page while the other is mid-solve, and the token
// the second gets belongs to a page that is no longer there. That is a run of
// CAPTCHA_FAILED with nothing wrong in either request.
//
// Serialised here rather than by lowering concurrency, because the contended
// thing is the tab and it lives here. Requests without a captcha -- polls,
// listing lookups -- do not touch it and are not held up behind this.
let _captchaTurn = Promise.resolve();

function takeCaptchaTurn(run) {
  const mine = _captchaTurn.then(run, run);
  _captchaTurn = mine.then(() => {}, () => {});
  return mine;
}

/**
 * Read the image model names off the Flow page's own source.
 *
 * Flow offers three image models and the vendored client knows the wire names
 * of two. The third is not guessed: the page's JavaScript has to carry every
 * name it can put on the wire, so it is read from there. Every UPPER_SNAKE
 * token found within a stretch of each known name is returned, grouped by
 * which known name it was near; the agent keeps only the ones near all of
 * them, which is what sharing an enum looks like in minified source.
 *
 * Tokens, not quoted strings. The first version matched "GEM_PIX_2" in quotes
 * and found nothing, because a minified enum is {GEM_PIX_2:0,NARWHAL:1} and
 * a switch is case"GEM_PIX_2": -- the quotes are not reliably there.
 *
 * The page lists its scripts; this worker fetches them. Not the page: the
 * bundles live on gstatic, and a fetch from the page is a cross-origin request
 * gstatic does not answer with CORS headers, so every one of them was skipped
 * and the scan read only the inline scripts. The worker has host permission
 * for gstatic and fetches without CORS.
 *
 * Everything it saw comes back under `debug`, so a scan that finds nothing
 * says what it looked at instead of leaving the answer to be guessed at.
 */
async function discoverImageModels({ known = [] }) {
  if (!known.length) return { near: {} };

  let tabs = await queryFlowTabs();
  let tab = tabs.find((t) => !t.discarded) || tabs[0];
  if (!tab) {
    try {
      await chrome.tabs.create({ url: FLOW_HOME, active: false });
      await sleep(5000);
      tabs = await queryFlowTabs();
      tab = tabs.find((t) => !t.discarded) || tabs[0];
    } catch (e) {
      return { error: e?.message || 'NO_FLOW_TAB' };
    }
    if (!tab) return { error: 'NO_FLOW_TAB' };
  }
  tab = await reviveTabIfNeeded(tab);
  if (!tab) return { error: 'FLOW_TAB_DISCARDED' };

  // 1. What the page has: inline script text, and the URLs of the rest.
  let listing;
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        const inline = [];
        const urls = [];
        for (const s of Array.from(document.scripts)) {
          if (s.src) urls.push(s.src);
          else if (s.textContent) inline.push(s.textContent);
        }
        return { inline, urls, href: location.href };
      },
    });
    listing = injected?.result;
  } catch (e) {
    return { error: 'LISTING_FAILED: ' + (e?.message || e) };
  }
  if (!listing) return { error: 'NO_LISTING' };

  // 2. Fetch the external ones from here, where cross-origin is allowed.
  const MAX_SCRIPT = 16_000_000;
  const DEADLINE = Date.now() + 40_000;
  const sources = [...listing.inline];
  const fetched = [];
  const failed = [];
  for (const url of listing.urls) {
    if (Date.now() > DEADLINE) { failed.push(url + ' (deadline)'); continue; }
    try {
      const r = await fetch(url);
      if (!r.ok) { failed.push(`${url} (HTTP ${r.status})`); continue; }
      const text = await r.text();
      if (text.length > MAX_SCRIPT) { failed.push(`${url} (${text.length} bytes)`); continue; }
      sources.push(text);
      fetched.push(`${url} (${text.length})`);
    } catch (e) {
      failed.push(`${url} (${e?.message || e})`);
    }
  }

  // 3. Every UPPER_SNAKE token within reach of each known name.
  const WINDOW = 1500;
  const TOKEN = /\b([A-Z][A-Z0-9_]{3,40})\b/g;
  const near = {};
  const hits = {};
  for (const anchor of known) {
    const found = [];
    const seen = new Set();
    let count = 0;
    for (const text of sources) {
      let at = text.indexOf(anchor);
      while (at !== -1) {
        count++;
        const slice = text.slice(Math.max(0, at - WINDOW), at + anchor.length + WINDOW);
        for (const m of slice.matchAll(TOKEN)) {
          if (!seen.has(m[1])) { seen.add(m[1]); found.push(m[1]); }
        }
        at = text.indexOf(anchor, at + anchor.length);
      }
    }
    near[anchor] = found;
    hits[anchor] = count;
  }

  return {
    near,
    debug: {
      page: listing.href,
      inline_scripts: listing.inline.length,
      fetched,
      failed,
      anchor_hits: hits,
    },
  };
}

// ─── Reading Flow's own interface ───────────────────────────
//
// Everything above reaches Flow by building its requests for it: we mint the
// captcha, we assemble f.req, we set the query string. That only works while
// our reconstruction matches what the real client sends, and when it drifts
// Google answers PUBLIC_ERROR_UNUSUAL_ACTIVITY -- a verdict on the request,
// not on the account.
//
// Driving the page's own controls has no reconstruction in it: Flow builds
// the request, Flow mints the captcha in its normal flow. What that needs is
// the controls, and Flow's markup is minified and changes without notice, so
// they are not hardcoded anywhere. This reads them off the live page, from
// the tab that is already signed in, and answers with enough to write a
// selector against -- and to write a new one the next time Flow moves.
//
// Read-only. It types nothing and clicks nothing.

/**
 * chrome.tabs.create, but never "No current window".
 *
 * A service worker has no window of its own, so a create without a windowId
 * goes to the last focused one -- and when the Flow tab was Chrome's last tab
 * and was closed, Chrome keeps running for this extension with no window at
 * all, and every create fails with "No current window". So a window is picked,
 * or made, explicitly.
 */
async function openTab(props) {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
  if (windows.length) return chrome.tabs.create({ ...props, windowId: windows[0].id });
  const win = await chrome.windows.create({ url: props.url, focused: !!props.active });
  return win.tabs?.[0] || (await chrome.tabs.query({ windowId: win.id }))[0];
}

/** Attributes worth seeing, with the noise (class soup, Angular ids) left out. */
const SCAN_ATTRS = [
  'id', 'name', 'type', 'role', 'placeholder', 'aria-label', 'aria-labelledby',
  'data-testid', 'data-test-id', 'jsname', 'jsaction', 'contenteditable',
  'disabled', 'title', 'value',
];

function describeElement(el) {
  const attrs = {};
  for (const name of SCAN_ATTRS) {
    const value = el.getAttribute?.(name);
    if (value !== null && value !== undefined && value !== '') {
      attrs[name] = String(value).slice(0, 200);
    }
  }
  const box = el.getBoundingClientRect?.() || { width: 0, height: 0, x: 0, y: 0 };
  return {
    tag: el.tagName?.toLowerCase(),
    text: (el.innerText || el.textContent || '').trim().slice(0, 120),
    attrs,
    // A control the eye cannot see is a control a click cannot reach, and
    // Flow keeps several hidden copies of its own buttons.
    visible: box.width > 0 && box.height > 0,
    box: { x: Math.round(box.x), y: Math.round(box.y),
           w: Math.round(box.width), h: Math.round(box.height) },
    path: cssPathOf(el),
  };
}

/** A selector that finds this element again: the stable attributes, or nth-child. */
function cssPathOf(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 6) {
    let part = node.tagName.toLowerCase();
    const testid = node.getAttribute('data-testid') || node.getAttribute('data-test-id');
    const jsname = node.getAttribute('jsname');
    if (node.id) {
      parts.unshift(`#${node.id}`);
      break;
    }
    if (testid) part += `[data-testid="${testid}"]`;
    else if (jsname) part += `[jsname="${jsname}"]`;
    else if (node.parentElement) {
      const kin = [...node.parentElement.children].filter((c) => c.tagName === node.tagName);
      if (kin.length > 1) part += `:nth-of-type(${kin.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

async function scanFlowUi({ projectId = null } = {}) {
  // grecaptcha and the generate controls both live on a project page, so the
  // scan has to be taken from one or it reports an interface that is not
  // there. Same reason the captcha path parks the tab first.
  await ensureFlowTabOnProject(projectId);

  const tabs = await queryFlowTabs();
  const candidate = tabs.find((t) => !t.discarded) || tabs[0];
  if (!candidate) return { error: 'NO_FLOW_TAB' };
  const tab = await reviveTabIfNeeded(candidate);
  if (!tab) return { error: 'FLOW_TAB_DISCARDED' };

  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [SCAN_ATTRS],
    func: (attrNames) => {
      // Redefined in the page: an injected function is serialised on its own
      // and carries nothing from the extension's scope with it.
      const pathOf = (el) => {
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 6) {
          let part = node.tagName.toLowerCase();
          const testid = node.getAttribute('data-testid') || node.getAttribute('data-test-id');
          const jsname = node.getAttribute('jsname');
          if (node.id) { parts.unshift('#' + node.id); break; }
          if (testid) part += `[data-testid="${testid}"]`;
          else if (jsname) part += `[jsname="${jsname}"]`;
          else if (node.parentElement) {
            const kin = [...node.parentElement.children].filter((c) => c.tagName === node.tagName);
            if (kin.length > 1) part += `:nth-of-type(${kin.indexOf(node) + 1})`;
          }
          parts.unshift(part);
          node = node.parentElement;
        }
        return parts.join(' > ');
      };

      const describe = (el) => {
        const attrs = {};
        for (const name of attrNames) {
          const value = el.getAttribute && el.getAttribute(name);
          if (value !== null && value !== undefined && value !== '') {
            attrs[name] = String(value).slice(0, 200);
          }
        }
        const box = el.getBoundingClientRect
          ? el.getBoundingClientRect()
          : { width: 0, height: 0, x: 0, y: 0 };
        return {
          tag: el.tagName ? el.tagName.toLowerCase() : '?',
          text: (el.innerText || el.textContent || '').trim().slice(0, 120),
          attrs,
          visible: box.width > 0 && box.height > 0,
          box: { x: Math.round(box.x), y: Math.round(box.y),
                 w: Math.round(box.width), h: Math.round(box.height) },
          path: pathOf(el),
        };
      };

      const take = (selector, limit) =>
        [...document.querySelectorAll(selector)].slice(0, limit).map(describe);

      // Where the prompt is typed. Flow's box has been a textarea and has
      // been a contenteditable div; both are asked for rather than guessed.
      const inputs = take('textarea, [contenteditable="true"], input[type="text"]', 25);

      // Every button, visible ones first: the generate control is a button
      // whose label is an icon as often as a word, so nothing is filtered on
      // text here -- that judgement is made off the scan, not inside it.
      const buttons = take('button, [role="button"]', 80)
        .sort((a, b) => Number(b.visible) - Number(a.visible));

      // The form, when there is one, is the smallest piece of markup that
      // holds the whole control cluster.
      const form = document.querySelector('form');

      return {
        url: location.href,
        title: document.title,
        grecaptcha: typeof window.grecaptcha?.enterprise?.execute === 'function',
        counts: {
          inputs: document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]').length,
          buttons: document.querySelectorAll('button, [role="button"]').length,
        },
        inputs,
        buttons,
        formHtml: form ? form.outerHTML.slice(0, 20000) : null,
      };
    },
  });

  if (injected?.result) return injected.result;
  return { error: 'NO_INJECTION_RESULT: the scan returned nothing' };
}

// ─── Generating through Flow's own composer ─────────────────
//
// Since Google's frontend build of 2026-09-22 every captcha-gated RPC --
// ogiZ0b image, eb1hJf video, SPrCad export -- answers
// PUBLIC_ERROR_UNUSUAL_ACTIVITY when we send it ourselves, while the same
// account in the same tab generates fine when the button is clicked. The
// calls that carry no captcha (jwpduf polling, Zzl0ze project media, as29s
// media urls) were never affected and still work.
//
// It is not the payload and it is not the token's name. Measured against the
// live endpoint: our f.req matches the composer's slot for slot, the site key
// and action match, a token minted per captcha slot fails the same way, and
// the failure reproduces from a signed-in browser on a home connection. The
// assessment is now bound to something the page supplies on its own submit
// path and that grecaptcha.enterprise.execute in the MAIN world cannot
// reproduce. Upstream reached the same conclusion from three independent
// reproductions (crisng95/flowkit#58); the fix there is to stop sending these
// calls at all and let the app send them.
//
// So this types the prompt into the composer and clicks Generate, and the
// result is read afterwards from the project listing, which needs no captcha.
//
// The clicks go through chrome.debugger rather than element.click(), and that
// is the load-bearing part: a synthetic click does nothing here at all -- no
// request is issued, the composer keeps its text. Only a trusted event submits,
// and CDP's Input domain is the only way an extension can raise one.

const CDP_VERSION = '1.3';

// Where things are on Flow's page. The agent sends its own copy with every
// call (agent/ui_selectors.json, overridable from the data folder without a
// rebuild); these are only for a call that arrives without one.
const UI_DEFAULTS = {
  // The visible one is taken (the last on the page): Flow's session panel can
  // leave another, hidden, prompt box in the page.
  editor: 'div.ProseMirror, [contenteditable="true"][role="textbox"], textarea',
  generateButton: 'button[aria-label="Start generation"]',
  // While Flow works on a submit, a Stop button sits where Generate was.
  stopButton: 'button[aria-label="Stop"]',
  // Flow's Agent mode, on when pressed. It answers a prompt with its own
  // settings (shape, count, model) and hides the composer's, so it is turned off.
  agentToggle: 'button.agent-mode-chip',
  menuTriggers: 'button, [role="button"], [role="combobox"], [aria-haspopup]',
  menuOptions: '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"], [role="tab"], button, li',
  errorRegions: '[role="alert"], [role="status"], [aria-live], [data-state="error"]',
  errorWords: 'unusual activity|something went wrong|couldn.t generate|could not generate|failed to generate|generation failed|violat|against our policies|policy violation|quota|limit reached|try again later|not available in your',
  // Ingredients stay in the prompt box after a submit; this empties it.
  clearPromptButton: 'button[aria-label="Clear prompt"]',
  // The "+" by the prompt box: a picker of the project's media with a search
  // box. A row clicked there attaches it, and a chip shows in the box.
  addMediaButton: 'button[aria-label="Add ingredients to the prompt box"]',
  assetSearch: 'input[aria-label="Search assets"]',
  assetList: 'flow-add-menu-asset-list',
  assetRow: '.asset-item-container',
  ingredientChip: 'flow-ingredient-chip',
  uploadWords: 'upload media',
  // One generation slot in the results grid: a percent while it renders,
  // then the picture or the clip. The element stays from one to the other.
  tile: 'flow-tile-container',
  tileVideo: 'flow-video-tile video',
  tileImage: 'flow-image-tile img.image',
};

function uiSelectors(given) {
  return { ...UI_DEFAULTS, ...(given && typeof given === 'object' ? given : {}) };
}

// ─── Acting like a person ───────────────────────────────────
//
// Flow's page sends the request, so reCAPTCHA scores the session the page is
// in -- and how the clicks and keys arrive is part of that session. A pointer
// that teleports to the exact centre of a button and presses and releases in
// the same millisecond, every time, is a pattern no person makes. So the
// pointer travels a curved path from where it last was, lands somewhere inside
// the control rather than its centre, and holds the button for as long as a
// finger does. The ranges are ours, chosen to sit inside what people do.

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pause = (lo, hi) => sleep(Math.round(rand(lo, hi)));

/** Last pointer position per tab, so each move starts where the last ended. */
const pointerAt = new Map();

/** Ease in and out: slow off the mark, fast in the middle, slow onto the target. */
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

async function humanMove(target, x, y) {
  const from = pointerAt.get(target.tabId) || { x: x + rand(-250, 250), y: y + rand(-180, 180) };
  // Two control points off the straight line make the path a gentle curve.
  const bend = () => ({ x: rand(-80, 80), y: rand(-60, 60) });
  const b1 = bend();
  const b2 = bend();
  const c1 = { x: from.x + (x - from.x) * 0.3 + b1.x, y: from.y + (y - from.y) * 0.3 + b1.y };
  const c2 = { x: from.x + (x - from.x) * 0.7 + b2.x, y: from.y + (y - from.y) * 0.7 + b2.y };
  const steps = Math.round(rand(8, 26));
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    const u = 1 - t;
    const px = u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * x;
    const py = u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * y;
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: Math.round(px), y: Math.round(py) });
    await pause(8, 22);
  }
  pointerAt.set(target.tabId, { x, y });
}

/** A trusted click somewhere inside `box`, reached by moving there first. */
async function humanClick(target, box) {
  const x = box.left + box.w * rand(0.3, 0.7);
  const y = box.top + box.h * rand(0.35, 0.65);
  await humanMove(target, x, y);
  await pause(50, 150);
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await pause(60, 140);
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

async function pressKey(target, key, { code = key, keyCode = 0, modifiers = 0, text, commands } = {}) {
  const down = { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers };
  if (text) down.text = text;
  if (commands) down.commands = commands;
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', down);
  await pause(35, 95);
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent',
    { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
}

// ─── One debugger session per run, not per click ────────────
//
// Attaching shows Chrome's "being debugged" bar and resizes the page under it,
// and doing that around every action is itself a rhythm. So it is attached
// once and let go only after the tab has been idle for a while.

// Long enough to outlast a generation: the answer to the page's own submit is
// read through this session (see "What Flow's own answers say" below).
const DEBUGGER_IDLE_MS = 360_000;
const attached = new Map(); // tabId -> idle timer

chrome.debugger.onDetach.addListener((source) => {
  clearTimeout(attached.get(source.tabId));
  attached.delete(source.tabId);
  pointerAt.delete(source.tabId);
  watchedRequests.delete(source.tabId);
});

// ─── What Flow's own answers say ────────────────────────────
//
// When the page submits, Google answers it with the new pictures' addresses.
// Reading that answer is how a picture is known to be done the moment it is:
// the project listing lags or misses it, and Flow's tiles are minified markup
// that changes. Read through the debugger's network view, which only watches --
// nothing is added to the page.

// Flow's own host, and the storage bucket some answers sign instead.
const MEDIA_URL_RE = /https:\/\/(?:flow-content\.google|storage\.googleapis\.com\/[A-Za-z0-9_\-.]+)\/image\/[A-Za-z0-9_\-]+(?:\?[^"'\s\\<>\]]*)?/g;
const watchedRequests = new Map(); // tabId -> Set(requestId)
const answeredImages = []; // { url, at }, newest last, bounded
// What the page asked Google lately and how many pictures each answer named,
// so a picture nobody saw finish can be traced to where it was missed.
const networkSeen = []; // { at, url, status, found }, newest last, bounded
// Google's own verdicts in those answers (PUBLIC_ERROR_...), with when they
// came. A failed tile reads the same words every time, so the words cannot say
// whether a failure is this picture's; the time of the answer can.
const answeredCodes = []; // { code, at }, newest last, bounded
const CODE_RE = /PUBLIC_ERROR_[A-Z_]+/g;

// The answer is JSON inside JSON, so its escapes come doubled: \\u003d is "=".
const unescapeBody = (text) =>
  text.replace(/\\+u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\+\//g, '/');

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (method === 'Network.responseReceived') {
    const url = params?.response?.url || '';
    // Every call the page's code makes, not only batchexecute: where Flow
    // sends the generate has moved before and will again.
    if (params?.type === 'XHR' || params?.type === 'Fetch') {
      if (!watchedRequests.has(tabId)) watchedRequests.set(tabId, new Set());
      watchedRequests.get(tabId).add(params.requestId);
      networkSeen.push({ at: Date.now(), url: url.split('?')[0].slice(0, 160),
                         status: params.response?.status, found: 0, requestId: params.requestId });
      if (networkSeen.length > 60) networkSeen.splice(0, networkSeen.length - 60);
    }
  } else if (method === 'Network.loadingFinished') {
    const watched = watchedRequests.get(tabId);
    if (!watched?.has(params.requestId)) return;
    watched.delete(params.requestId);
    try {
      const { body = '', base64Encoded } = await chrome.debugger.sendCommand(
        source, 'Network.getResponseBody', { requestId: params.requestId });
      const text = unescapeBody(base64Encoded ? atob(body) : body);
      const found = text.match(MEDIA_URL_RE) || [];
      const seen = networkSeen.find((n) => n.requestId === params.requestId);
      if (seen) seen.found = found.length;
      for (const url of found) {
        if (!answeredImages.some((a) => a.url.split('?')[0] === url.split('?')[0])) {
          answeredImages.push({ url, at: Date.now() });
        }
      }
      if (answeredImages.length > 400) answeredImages.splice(0, answeredImages.length - 400);
      for (const code of new Set(text.match(CODE_RE) || [])) answeredCodes.push({ code, at: Date.now() });
      if (answeredCodes.length > 100) answeredCodes.splice(0, answeredCodes.length - 100);
    } catch {
      // The body is gone (navigated away, or too large to keep): nothing to read.
    }
  }
});

async function withDebugger(tabId, body) {
  const target = { tabId };
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach(target, CDP_VERSION);
      await chrome.debugger.sendCommand(target, 'Network.enable', {}).catch(() => {});
    } catch (e) {
      // Already attached -- by DevTools open on this tab, or a run of ours
      // that the service worker lost track of across a restart.
      if (!String(e?.message || e).includes('Another debugger')) {
        return { error: `DEBUGGER_ATTACH_FAILED: ${e?.message || e}` };
      }
    }
  }
  clearTimeout(attached.get(tabId));
  attached.set(tabId, null);
  try {
    return await body(target);
  } finally {
    attached.set(tabId, setTimeout(() => {
      attached.delete(tabId);
      pointerAt.delete(tabId);
      chrome.debugger.detach(target).catch(() => {});
    }, DEBUGGER_IDLE_MS));
  }
}

// ─── Reading the page ───────────────────────────────────────

/**
 * Where the composer and the Generate button are, and whether it is ready.
 *
 * Read immediately before each click rather than once: the composer grows as
 * text is typed into it and the button moves down the page with it.
 */
/**
 * Every prompt-box-like element on the page, in a line for the agent's log:
 * which one the composer is when Flow's layout changes is read from this.
 */
async function promptBoxesOnPage(tabId) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const els = [...document.querySelectorAll('[contenteditable], textarea, input[type="text"], [role="textbox"]')];
      const focused = document.activeElement;
      return els.slice(0, 8).map((e) => {
        const r = e.getBoundingClientRect();
        const label = e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('data-placeholder')
          || (e.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')) || '';
        const cls = String(e.className || '').split(/\s+/).slice(0, 3).join('.');
        const text = String(e.value ?? e.innerText ?? '').trim();
        return `${e.tagName.toLowerCase()}${cls ? '.' + cls : ''}[ce=${e.getAttribute('contenteditable') || '-'}`
          + ` label="${label.slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`
          + ` text=${text.length}${e === focused || e.contains(focused) ? ' FOCUSED' : ''}]`;
      }).join(' | ') + ` (focus on ${focused ? focused.tagName.toLowerCase() + '.' + String(focused.className || '').split(/\s+/)[0] : 'nothing'})`;
    },
  }).catch((e) => [{ result: `unread: ${e?.message || e}` }]);
  return out?.result || 'none found';
}

async function composerBox(tabId, ui) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [ui.editor, ui.generateButton, ui.stopButton],
    func: (editorSel, buttonSel, stopSel) => {
      const editor = (() => { const seen = [...document.querySelectorAll(editorSel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); return seen[seen.length - 1] || document.querySelector(editorSel); })();
      const button = document.querySelector(buttonSel);
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.x, top: r.y, w: r.width, h: r.height };
      };
      const stop = [...document.querySelectorAll(stopSel)].some((el) => el.getBoundingClientRect().width > 0);
      // Tiles still working, each showing a percent ("45%") on its own.
      const working = [...document.querySelectorAll('div, span')].filter((d) =>
        /^\s*\d{1,3}\s*%\s*$/.test(d.textContent || '') && !d.querySelector('div, span')
        && d.getBoundingClientRect().width > 0).length;
      return {
        editor: box(editor),
        button: box(button),
        ready: !!button && !button.disabled,
        text: editor ? String(editor.value ?? editor.innerText ?? '').trim() : null,
        stop,
        working,
      };
    },
  });
  return out?.result || null;
}

/**
 * Error messages showing on the page: alert regions, and any small element
 * whose own words read like a failure. Leaf-sized only, so a paragraph that
 * merely mentions "policy" in Flow's help text is not taken for one. Each
 * message with how many places show it.
 */
async function pageErrorCounts(tabId, ui) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [ui.errorRegions, ui.errorWords],
    func: (regionSel, words) => {
      const re = new RegExp(words, 'i');
      const matched = new Set();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const textOf = (el) => (el.innerText || '').trim().replace(/\s+/g, ' ');
      const consider = (el) => {
        const text = textOf(el);
        if (text && text.length < 300 && re.test(text) && visible(el)) matched.add(el);
      };
      document.querySelectorAll(regionSel).forEach(consider);
      document.querySelectorAll('div, span, p').forEach((el) => {
        if (el.childElementCount <= 2) consider(el);
      });
      // One per failed tile: an element holding another that matched is the
      // same message twice. Counted, because every failed tile reads the same.
      const counts = {};
      for (const el of matched) {
        if ([...matched].some((o) => o !== el && el.contains(o))) continue;
        const text = textOf(el).slice(0, 200);
        counts[text] = (counts[text] || 0) + 1;
      }
      return counts;
    },
  });
  return out?.result || {};
}

/** Picture addresses showing in the tab: Flow's tiles, read as a person sees them. */
async function pageImages(tabId) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const urls = new Set();
      document.querySelectorAll('img, source, video').forEach((el) => {
        for (const v of [el.currentSrc, el.src, el.getAttribute('src'), el.poster]) {
          if (v && /flow-content\.google\/image\/|storage\.googleapis\.com\/[^/]+\/image\//.test(v)) urls.add(v);
        }
      });
      return [...urls];
    },
  });
  // And every picture Google's answers to this browser have named.
  return [...(out?.result || []), ...answeredImages.map((a) => a.url)];
}

const mediaIdOf = (url) => url.split('/image/')[1].split('?')[0];

/**
 * Every picture-sized image on the page, whatever its address: a signed link,
 * a redirect through Flow, or a blob the page made. Read when the addresses
 * above miss a picture a person can plainly see -- Flow changes how it shows
 * them more often than what it shows. Icons and avatars are too small to count.
 */
async function pageTiles(tabId) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      // A tile still working shows a percent ("45%") and no picture yet; a
      // finished one holds an img with a src. That is the whole signal -- the
      // same one a person reads off the grid.
      const working = (el) => {
        for (let up = el.parentElement, i = 0; up && i < 4; up = up.parentElement, i++) {
          if ([...up.querySelectorAll('div, span')].some((d) => /^\s*\d{1,3}\s*%\s*$/.test(d.textContent || ''))) return true;
        }
        return false;
      };
      const srcs = [];
      document.querySelectorAll('img').forEach((el) => {
        const src = el.currentSrc || el.src;
        if (!src) return;
        // Big enough to be a picture, by its pixels or by the space it takes:
        // a tab in the background may not have decoded it yet.
        const box = el.getBoundingClientRect();
        const big = (el.naturalWidth >= 200 && el.naturalHeight >= 200) || (box.width >= 120 && box.height >= 120);
        if (!big || working(el)) return;
        const key = src.startsWith('data:') ? src.slice(0, 200) : src;
        if (!srcs.includes(key)) srcs.push(key);
      });
      // Tiles Flow is still working on: a percent ("45%") on its own.
      const busy = [...document.querySelectorAll('div, span')].filter((d) => {
        if (!/^\s*\d{1,3}\s*%\s*$/.test(d.textContent || '')) return false;
        const r = d.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !d.querySelector('div, span');
      }).length;
      return { srcs, url: location.href, working: busy };
    },
  });
  return out?.result || { srcs: [], url: '' };
}

/** One tile's picture, fetched by the page itself, as a data: URL. */
async function tileImage(tabId, src) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [src],
    func: async (want) => {
      const el = [...document.querySelectorAll('img')].find(
        (i) => (i.currentSrc || i.src) === want || (i.currentSrc || i.src).startsWith(want));
      // Since 2026-10-30 17:07 the grid's tiles are small and load "=s512-rw"
      // previews (382x512 for a 3:4 picture) that never grow. The same link
      // ending in "=s0" is the picture at full size (896x1200), measured.
      const full = (u) => u.replace(/=s\d+(-[a-z]+)?(?=\?|$)/, '=s0');
      try {
        const res = await fetch(full(el ? (el.currentSrc || el.src) : want), { credentials: 'include' });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const blob = await res.blob();
        if (!blob.type.startsWith('image/')) return { error: `not a picture: ${blob.type}` };
        // Its real size, so a preview is not taken for the picture: after a
        // reload Flow's tiles load through flow.google.com/asb/ links, and a
        // portrait one there is 286x512 where the picture is 768x1376.
        const { width, height } = await createImageBitmap(blob).catch(() => ({}));
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ dataUrl: reader.result, width, height });
          reader.onerror = () => resolve({ error: 'unreadable' });
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        return { error: String(e?.message || e) };
      }
    },
  });
  return out?.result || { error: 'no answer from the page' };
}

/**
 * Pick `wanted` among the composer's settings -- the model, the shape, the
 * count, or Image over Video.
 *
 * Done by the words on screen rather than by Flow's markup, which is minified
 * and changes. As measured on 2026-10-28: the settings sit behind one button by
 * the prompt box ("🍌 Nano Banana 2.1 crop_portrait x1", labelled "Settings
 * trigger"), which opens a panel where the shape, the count and Image/Video are
 * radios and the model is a dropdown of its own ("Select model family") holding
 * menu items. So the panel is opened, `wanted` is clicked if it shows, and
 * otherwise the control in the panel showing one of `family` (every value that
 * setting can take) is opened and `wanted` picked from it.
 *
 * Picked is read off the page: the radio is checked, or the dropdown names it.
 * The chip by the prompt box is not trusted for it -- it shows the shape only as
 * an icon name ("crop_9_16"). Answers true, or why not.
 */
async function pickInMenu(target, tabId, ui, wanted, family) {
  const find = async (mode) => {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [mode, wanted, family, ui.menuTriggers, ui.menuOptions],
      func: (how, want, names, triggerSel, optionSel) => {
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 ? { left: r.x, top: r.y, w: r.width, h: r.height } : null;
        };
        // Icon-only controls carry their words in aria-label or title.
        const text = (el) => ((el.innerText || el.textContent || '').trim()
          || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ');
        const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // The name as words of its own: "Nano Banana 2" is not in "Nano Banana
        // 2.1", and "9:16" is in "crop_9_16 9:16".
        const named = (t, n) => new RegExp(`(^|[\\s(])${esc(n)}($|[\\s)])`).test(t);
        if (how === 'trigger') {
          // A dropdown that shows the current choice. One that opens a menu is
          // preferred, so the model's own dropdown wins over the chip by the
          // prompt box, which names the model too.
          let best = null;
          for (const el of document.querySelectorAll(triggerSel)) {
            const t = text(el);
            if (t.length > 80 || !names.some((n) => named(t, n))) continue;
            const b = box(el);
            const rank = el.hasAttribute('aria-haspopup') ? 0 : 1;
            if (b && (!best || rank < best.rank)) best = { box: b, current: t, already: named(t, want), rank };
          }
          return best;
        }
        // The option's own words may run on ("🍌 Nano Banana Pro", "crop_9_16
        // 9:16"); the shortest such text is the option itself rather than a
        // panel that holds it. Only a radio, menu item or the like: the chip by
        // the prompt box is a plain button that names the model and the count
        // too, and clicking it is opening the panel, not picking.
        let best = null;
        for (const el of document.querySelectorAll(optionSel)) {
          const t = text(el);
          if (!el.hasAttribute('role') || t.length > 60 || !named(t, want)) continue;
          const b = box(el);
          if (b && (!best || t.length < best.len)) {
            best = { box: b, len: t.length, checked: el.getAttribute('aria-checked') };
          }
        }
        // checked: 'true', 'false', or null for an item that keeps no state.
        return best && { box: best.box, checked: best.checked };
      },
    });
    return out?.result || null;
  };
  const close = async () => {
    await pressKey(target, 'Escape', { keyCode: 27 });
    await pause(200, 400);
  };

  // The panel, opened by the button by the prompt box -- unless it is open.
  let option = await find('option');
  if (!option) {
    const settings = await composerSettingsButton(tabId, ui);
    if (!settings) {
      const seen = await visibleControls(tabId, ui);
      return `no settings button by the prompt box; on screen: ${seen.join(' | ')}`;
    }
    await humanClick(target, settings);
    await pause(500, 1000);
    option = await find('option');
  }

  if (option) {
    // Shown in the panel as a choice of its own: a radio.
    if (option.checked !== 'true') {
      await humanClick(target, option.box);
      await pause(300, 700);
      option = await find('option');
    }
    await close();
    // A menu item that closed its menu, or keeps no state, was picked by the click.
    return !option || option.checked !== 'false' || `"${wanted}" did not stay selected`;
  }

  // Behind a dropdown in the panel.
  const trigger = await find('trigger');
  if (!trigger) {
    const seen = await visibleControls(tabId, ui);
    await close();
    return `no control showing any of ${family.join(', ')}; on screen: ${seen.join(' | ')}`;
  }
  if (trigger.already) {
    await close();
    return true;
  }
  await humanClick(target, trigger.box);
  await pause(400, 900);
  option = await find('option');
  if (!option) {
    const seen = await visibleControls(tabId, ui);
    await close();
    await close();
    return `"${wanted}" was not in the menu; on screen: ${seen.join(' | ')}`;
  }
  await humanClick(target, option.box);
  await pause(300, 700);
  const after = await find('trigger');
  await close();
  return after && after.already ? true : `the control still shows "${after?.current || '?'}"`;
}

/**
 * Turn Flow's Agent mode off, as a person would: one click on its chip.
 *
 * With it on, a prompt goes to Flow's agent, which makes pictures with its own
 * settings (16:9, two at a time, its own model) and keeps the composer's
 * hidden; the composer's prompt box goes away while it works. It stays on
 * across reloads. Answers true, or why not.
 */
/**
 * Close Flow's session panel on the right, so the prompt goes in the composer
 * at the bottom centre. Measured 2026-11-08: with the panel open the prompt
 * typed in it never took (COMPOSER_REJECTED_PROMPT: it holds ""); with the
 * panel closed the centred composer generated. The panel's close button is
 * told apart from any other "close" by where it is -- the right part of the
 * window -- and by sharing a container with a prompt box. True when no such
 * panel is showing (any more).
 */
async function closeSessionPanel(target, tabId, ui) {
  const find = async () => {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [ui.editor],
      func: (editorSel) => {
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const isClose = (b) => /^close\b/i.test(b.getAttribute('aria-label') || '')
          || /^close$/i.test((b.innerText || '').trim());
        for (const b of document.querySelectorAll('button, [role="button"]')) {
          if (!visible(b) || !isClose(b)) continue;
          const r = b.getBoundingClientRect();
          if (r.x < window.innerWidth * 0.55) continue;
          let scope = b;
          for (let i = 0; scope && i < 10; i++, scope = scope.parentElement) {
            const ed = [...scope.querySelectorAll(editorSel)].find(visible);
            if (ed) return { left: r.x, top: r.y, w: r.width, h: r.height };
          }
        }
        return null;
      },
    }).catch(() => [{ result: null }]);
    return out?.result || null;
  };
  const button = await find();
  if (!button) return true;
  await humanClick(target, button);
  await pause(800, 1500);
  return (await find()) ? 'the session panel stayed open' : true;
}

async function agentModeOff(target, tabId, ui) {
  const find = async () => {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [ui.agentToggle],
      func: (sel) => {
        const chips = [...document.querySelectorAll(sel), ...[...document.querySelectorAll('button')]
          .filter((b) => (b.innerText || '').trim() === 'Agent')];
        const on = chips.find((el) => el.getAttribute('aria-pressed') === 'true'
          && el.getBoundingClientRect().width > 0);
        if (!on) return null;
        const r = on.getBoundingClientRect();
        return { left: r.x, top: r.y, w: r.width, h: r.height };
      },
    }).catch(() => [{ result: null }]);
    return out?.result || null;
  };
  const chip = await find();
  if (!chip) return true;
  await humanClick(target, chip);
  await pause(500, 1000);
  return (await find()) ? 'Agent mode stayed on' : true;
}

/** The words of every control on screen, so a failed pick says what it saw. */
async function visibleControls(tabId, ui) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [ui.menuOptions],
    func: (sel) => {
      const seen = [];
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const t = ((el.innerText || '').trim() || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').slice(0, 40);
        if (t && !seen.includes(t)) seen.push(t);
        if (seen.length >= 40) break;
      }
      return seen;
    },
  }).catch(() => [{ result: [] }]);
  return out?.result || [];
}

/**
 * The button by the prompt box that opens the generation settings, if any:
 * one close to the editor whose words or label speak of settings, the model
 * or the shape, or that shows an output count ("x2").
 */
async function composerSettingsButton(tabId, ui) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [ui.editor, ui.menuTriggers],
    func: (editorSel, triggerSel) => {
      const editor = (() => { const seen = [...document.querySelectorAll(editorSel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); return seen[seen.length - 1] || document.querySelector(editorSel); })();
      if (!editor) return null;
      let scope = editor;
      for (let i = 0; i < 6 && scope.parentElement; i++) scope = scope.parentElement;
      const words = /setting|tune|option|model|aspect|ratio|config|banana|imagen|^\s*x\s*\d|\d\s*x\s*$|×/i;
      for (const el of scope.querySelectorAll(triggerSel)) {
        const t = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
        if (/start generation|send|submit|attach|upload|add/i.test(t) || !words.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.height) return { left: r.x, top: r.y, w: r.width, h: r.height };
      }
      return null;
    },
  }).catch(() => [{ result: null }]);
  return out?.result || null;
}

const MODEL_LABELS = ['Nano Banana Pro', 'Nano Banana 2.1', 'Nano Banana 2 Lite', 'Nano Banana 2', 'Imagen'];
const VIDEO_MODEL_LABELS = ['Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Veo 3.1 - Lite', 'Veo 3.1', 'Veo 3', 'Veo 2'];
const ASPECT_LABELS = ['16:9', '9:16', '1:1', '3:4', '4:3'];
const KIND_LABELS = ['Image', 'Video'];
// Video's two ways in, as measured: Frames starts the clip from a picture,
// Ingredients composes it from up to three.
const VIDEO_MODE_LABELS = ['Frames', 'Ingredients'];
/** The clip lengths Flow offers for a video: radios, as measured 2026-10-30. */
const DURATION_LABELS = ['4s', '6s', '8s', '10s'];
const COUNT_LABELS = ['x1', 'x2', 'x3', 'x4'];

// ─── References: attaching pictures to the prompt ───────────
//
// The agent puts each reference into the project first (an upload that needs
// no captcha) under a name of its own, so here it is only found in the "+"
// picker by that name and clicked, the way a person reuses an upload. When the
// agent could not upload it, the bytes come along and go in through Flow's own
// file input instead.

/** Where the first visible element matching `sel` is, optionally only one whose words hold `text`. */
async function boxOf(tabId, sel, { text = '', within = '' } = {}) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [sel, text, within],
    func: (s, words, scopeSel) => {
      const scopes = scopeSel ? [...document.querySelectorAll(scopeSel)] : [document];
      const want = words.toLowerCase();
      for (const scope of scopes) {
        for (const el of scope.querySelectorAll(s)) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const t = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
          if (want && !t.includes(want)) continue;
          return { left: r.x, top: r.y, w: r.width, h: r.height };
        }
      }
      return null;
    },
  }).catch(() => [{ result: null }]);
  return out?.result || null;
}

async function countOf(tabId, sel) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [sel],
    func: (s) => document.querySelectorAll(s).length,
  }).catch(() => [{ result: 0 }]);
  return out?.result || 0;
}

/** Wait up to `ms` for `check` to answer something truthy. */
async function waitUntil(check, ms, every = 250) {
  const until = Date.now() + ms;
  for (;;) {
    const got = await check();
    if (got || Date.now() > until) return got;
    await sleep(every);
  }
}

/** Empty the prompt box of text and ingredients an earlier prompt left. */
async function clearComposer(target, tabId, ui) {
  const clear = await boxOf(tabId, ui.clearPromptButton);
  if (!clear) return false;
  await humanClick(target, clear);
  await pause(300, 700);
  return true;
}

/** The picker open, its search box showing. */
/** Where the Frames-mode button worded exactly `words` is ("Start", "End"). */
async function frameSlot(tabId, words) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [words.toLowerCase()],
    func: (want) => {
      for (const el of document.querySelectorAll('button, [role="button"]')) {
        if ((el.innerText || '').trim().toLowerCase() !== want) continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.height) return { left: r.x, top: r.y, w: r.width, h: r.height };
      }
      return null;
    },
  }).catch(() => [{ result: null }]);
  return out?.result || null;
}

/**
 * How many pictures the prompt box holds: ingredient chips, and pictures in
 * the composer itself -- a Frames clip's start frame shows there, not as a chip.
 */
async function attachedCount(tabId, ui) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [ui.ingredientChip, ui.editor, ui.assetList],
    func: (chipSel, editorSel, listSel) => {
      const chips = document.querySelectorAll(chipSel).length;
      const editor = (() => { const seen = [...document.querySelectorAll(editorSel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); return seen[seen.length - 1] || document.querySelector(editorSel); })();
      let scope = editor;
      for (let i = 0; scope && i < 8 && scope.parentElement; i++) scope = scope.parentElement;
      const pictures = scope ? [...scope.querySelectorAll('img')]
        .filter((img) => !img.closest(chipSel) && !img.closest(listSel) && !img.closest('.cdk-overlay-container')
          && img.getBoundingClientRect().width > 0).length : 0;
      return chips + pictures;
    },
  }).catch(() => [{ result: 0 }]);
  return out?.result || 0;
}

async function openPicker(target, tabId, ui) {
  if (await boxOf(tabId, ui.assetSearch)) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    // In Frames mode there is no "+": the clip's first frame is its own
    // button, worded "Start" (measured 2026-10-30).
    const plus = await boxOf(tabId, ui.addMediaButton) || await frameSlot(tabId, 'Start');
    if (!plus) return false;
    await humanClick(target, plus);
    // A first click can land while another overlay closes and only raise a tooltip.
    if (await waitUntil(() => boxOf(tabId, ui.assetSearch), 3000)) return true;
  }
  return false;
}

/**
 * Search the picker for `name`, click the row, and see a chip appear. With
 * `exact`, only a row whose title is `name` itself counts: a caption Flow wrote
 * can be the start of another's.
 */
async function pickAsset(target, tabId, ui, name, waitMs, exact = false) {
  const search = await boxOf(tabId, ui.assetSearch);
  if (!search) return false;
  await humanClick(target, search);
  await pause(120, 300);
  await typePrompt(target, name);
  const row = await waitUntil(
    () => (exact ? titledRow(tabId, ui, name) : boxOf(tabId, ui.assetRow, { text: name, within: ui.assetList })),
    waitMs, 500);
  if (!row) return false;
  const chips = await attachedCount(tabId, ui);
  await humanClick(target, row);
  return !!(await waitUntil(async () => (await attachedCount(tabId, ui)) > chips, 4000));
}

/** Where the one picker row titled exactly `title` is; null when none or several. */
async function titledRow(tabId, ui, title) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [title.trim().toLowerCase(), ui.assetList, ui.assetRow],
    func: (want, listSel, rowSel) => {
      const list = document.querySelector(listSel);
      if (!list) return null;
      const rows = [...list.querySelectorAll(rowSel)].filter((row) => {
        const t = (row.querySelector('.asset-title')?.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
        // A long title is cut short on screen, ending in an ellipsis.
        const cut = t.endsWith('…') ? t.slice(0, -1).trim() : '';
        return t === want || (cut.length >= 12 && want.length > cut.length && want.startsWith(cut));
      });
      if (rows.length !== 1) return null;
      const r = rows[0].getBoundingClientRect();
      return r.width && r.height ? { left: r.x, top: r.y, w: r.width, h: r.height } : null;
    },
  }).catch(() => [{ result: null }]);
  return out?.result || null;
}

/**
 * Every row of the open "+" picker as the page has it: its words, the
 * addresses of its pictures, its data attributes and the start of its markup.
 * The list is scrolled to its end so rows drawn only when seen are read too.
 */
async function pickerRows(tabId, ui) {
  const seen = new Map();
  for (let i = 0; i < 20; i++) {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [ui.assetList, ui.assetRow],
      func: (listSel, rowSel) => {
        const list = document.querySelector(listSel);
        if (!list) return { gone: true, rows: [] };
        const rows = [...list.querySelectorAll(rowSel)].map((row) => {
          const data = {};
          for (const el of [row, ...row.querySelectorAll('*')]) {
            for (const a of el.attributes) {
              if (a.name.startsWith('data-') || a.name === 'aria-label' || a.name === 'title' || a.name === 'alt') {
                data[`${el.tagName.toLowerCase()}.${a.name}`] = a.value.slice(0, 200);
              }
            }
          }
          const srcs = [...row.querySelectorAll('img, video, source')].map((el) => el.currentSrc || el.src || '');
          const bg = [row, ...row.querySelectorAll('*')].map((el) => getComputedStyle(el).backgroundImage)
            .filter((b) => b && b !== 'none');
          return { text: (row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200), srcs, bg, data,
            html: row.outerHTML.slice(0, 1500) };
        });
        const scroller = [list, ...list.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 4);
        const end = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
        if (scroller && !end) scroller.scrollTop += scroller.clientHeight * 0.8;
        return { rows, end };
      },
    }).catch((e) => [{ result: { gone: true, rows: [], why: String(e?.message || e) } }]);
    const got = out?.result || { gone: true, rows: [] };
    for (const r of got.rows) seen.set(r.html, r);
    if (got.gone || got.end) break;
    await pause(400, 700);
  }
  return [...seen.values()];
}

/**
 * A diagnostic: the project's "+" picker as it is now -- every row, then the
 * rows a search for `search` leaves -- and which rows hold each of `mediaIds`.
 * With `durations`, also the words of the Video settings (the clip lengths).
 * Nothing is generated; the picker is closed again.
 */
async function uiProbePicker({ projectId = null, search = '', mediaIds = [], durations = false,
  reload = false, selectors = null } = {}) {
  if (uiSubmit) return { error: `COMPOSER_BUSY: a submit is at "${uiStepName}"` };
  const ui = uiSelectors(selectors);
  holdFlowTab();
  try {
    if (!(await queryFlowTabs()).length) {
      const created = await openTab({ url: projectId ? projectUrl(projectId) : FLOW_HOME, active: false });
      await waitForTabLoad(created.id, 30000).catch(() => {});
      await pause(2500, 4500);
    }
    await ensureFlowTabOnProject(projectId);
    const tabs = await queryFlowTabs();
    const candidate = (projectId && tabs.find((t) => (t.url || '').includes(projectId)))
      || tabs.find((t) => !t.discarded) || tabs[0];
    if (!candidate) return { error: 'NO_FLOW_TAB' };
    const tab = await reviveTabIfNeeded(candidate);
    if (!tab) return { error: 'FLOW_TAB_DISCARDED' };
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    if (reload) {
      const loaded = waitForTabLoad(tab.id, 30000);
      await chrome.tabs.reload(tab.id);
      await loaded.catch(() => {});
      await pause(2500, 4500);
    }
    return await withDebugger(tab.id, async (target) => {
      const report = { tabUrl: tab.url };
      if (!(await openPicker(target, tab.id, ui))) return { ...report, error: 'the "+" picker did not open' };
      await pause(1500, 2000);
      report.rows = await pickerRows(tab.id, ui);
      const holding = (rows) => Object.fromEntries(mediaIds.map((id) => [id,
        rows.map((r, i) => (JSON.stringify(r).toLowerCase().includes(String(id).toLowerCase()) ? i : -1))
          .filter((i) => i >= 0)]));
      report.holding = holding(report.rows);
      if (search) {
        const box = await boxOf(tab.id, ui.assetSearch);
        if (box) {
          await humanClick(target, box);
          await pause(120, 300);
          await typePrompt(target, search);
          await pause(2500, 3000);
          report.searched = await pickerRows(tab.id, ui);
          report.searchedHolding = holding(report.searched);
        }
      }
      await pressKey(target, 'Escape', { keyCode: 27 });
      await pause(300, 600);
      if (durations) {
        report.kindVideo = await pickInMenu(target, tab.id, ui, 'Video', KIND_LABELS);
        const settings = await composerSettingsButton(tab.id, ui);
        if (settings) {
          await humanClick(target, settings);
          await pause(700, 1000);
          report.videoSettings = await visibleControls(tab.id, ui);
          const [out] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: () => [...document.querySelectorAll('[role]')]
              .filter((el) => el.getBoundingClientRect().width > 0)
              .map((el) => `${el.getAttribute('role')}:${(el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40)}`)
              .filter((t, i, all) => /\d\s*s\b|sec|second|duration|length/i.test(t) && all.indexOf(t) === i),
          }).catch(() => [{ result: [] }]);
          report.durationControls = out?.result || [];
          await pressKey(target, 'Escape', { keyCode: 27 });
          await pause(300, 600);
        }
        // The composer's controls in Frames mode, where a clip starts from a picture.
        report.framesMode = await pickInMenu(target, tab.id, ui, 'Frames', VIDEO_MODE_LABELS);
        await pause(800, 1200);
        const [btns] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          args: [ui.editor],
          func: (editorSel) => {
            const editor = (() => { const seen = [...document.querySelectorAll(editorSel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); return seen[seen.length - 1] || document.querySelector(editorSel); })();
            let scope = editor || document.body;
            for (let i = 0; editor && i < 8 && scope.parentElement; i++) scope = scope.parentElement;
            return [...scope.querySelectorAll('button, [role="button"], input[type="file"]')]
              .filter((el) => el.getBoundingClientRect().width > 0 || el.type === 'file')
              .map((el) => `${el.tagName.toLowerCase()} aria="${el.getAttribute('aria-label') || ''}" text="${(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50)}"`)
              .slice(0, 60);
          },
        }).catch((e) => [{ result: String(e?.message || e) }]);
        report.framesControls = btns?.result;
        report.framesPicker = await openPicker(target, tab.id, ui);
        if (report.framesPicker) {
          report.framesRows = (await pickerRows(tab.id, ui)).length;
          await pressKey(target, 'Escape', { keyCode: 27 });
          await pause(300, 600);
        }
        report.kindImage = await pickInMenu(target, tab.id, ui, 'Image', KIND_LABELS);
      }
      return report;
    });
  } finally {
    releaseFlowTab();
  }
}

/**
 * Hold the next click on a file input and hand it these bytes instead of
 * opening the system's file dialog -- which nothing could answer in this
 * browser. Installed once per page, in the page's own world, where Flow's
 * file input lives.
 */
async function armUpload(tabId, ref) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [ref.dataUrl, ref.name, ref.mime || 'image/jpeg'],
    func: (dataUrl, filename, mimeType) => {
      if (!window.__vpsUpload) {
        const nativeClick = HTMLInputElement.prototype.click;
        window.__vpsUpload = { file: null };
        HTMLInputElement.prototype.click = function (...args) {
          const pending = window.__vpsUpload.file;
          if (this.type !== 'file' || !pending) return nativeClick.apply(this, args);
          window.__vpsUpload.file = null;
          const transfer = new DataTransfer();
          transfer.items.add(pending);
          this.files = transfer.files;
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return undefined;
        };
      }
      const bytes = atob(String(dataUrl).split(',').pop());
      const buffer = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
      window.__vpsUpload.file = new File([buffer], filename, { type: mimeType });
      return true;
    },
  }).catch((e) => [{ result: String(e?.message || e) }]);
  return out?.result === true || out?.result;
}

/**
 * Attach one reference to the prompt box. `ref` is { name } for a picture
 * already in the project, with { dataUrl, mime } when it has to be uploaded
 * here. Answers true, or why not.
 */
async function attachReference(target, tabId, ui, ref) {
  if (!(await openPicker(target, tabId, ui))) return 'the "+" picker did not open';
  if (ref.inProject) {
    // Made in this project: picked by the title Flow shows it under, never
    // uploaded again. Not there: the agent uploads it and asks again.
    const picked = await pickAsset(target, tabId, ui, ref.name, 8000, true);
    if (await boxOf(tabId, ui.assetSearch)) await pressKey(target, 'Escape', { keyCode: 27 });
    return picked || `MEDIA_NOT_FOUND: "${ref.name}" is not in the "+" picker`;
  }
  if (await pickAsset(target, tabId, ui, ref.name, 8000)) {
    if (await boxOf(tabId, ui.assetSearch)) await pressKey(target, 'Escape', { keyCode: 27 });
    return true;
  }
  if (!ref.dataUrl) {
    await pressKey(target, 'Escape', { keyCode: 27 });
    return `"${ref.name}" is not in the project's media`;
  }
  const armed = await armUpload(tabId, ref);
  if (armed !== true) return `could not prepare the upload: ${armed}`;
  const upload = await boxOf(tabId, '[role="button"], button, [role="menuitem"]', { text: ui.uploadWords });
  if (!upload) return 'no "Upload media" in the picker';
  const chips = await attachedCount(tabId, ui);
  await humanClick(target, upload);
  // Flow attaches a fresh upload itself, or lists it once it has gone up.
  const done = await waitUntil(async () => {
    if ((await attachedCount(tabId, ui)) > chips) return true;
    return !!(await boxOf(tabId, ui.assetRow, { text: ref.name, within: ui.assetList }));
  }, 180_000, 1000);
  if (!done) return `"${ref.name}" did not finish uploading`;
  const attached = (await attachedCount(tabId, ui)) > chips
    || (await pickAsset(target, tabId, ui, ref.name, 5000));
  if (await boxOf(tabId, ui.assetSearch)) await pressKey(target, 'Escape', { keyCode: 27 });
  return attached || `"${ref.name}" uploaded but would not attach`;
}

// ─── Tiles: which results are whose ─────────────────────────
//
// A submit adds placeholder tiles to the grid at once, and the element stays
// from the percent to the finished picture or clip. So the tiles that were not
// there before a submit are that prompt's, and are marked with its job: the
// result is then read off its own tiles, never guessed from the project, and
// two prompts can render at the same time without taking each other's.

/** Mark every tile now on the page as seen. Answers how many there are. */
async function markTilesSeen(tabId, ui) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [ui.tile],
    func: (sel) => {
      const tiles = [...document.querySelectorAll(sel)];
      tiles.forEach((t) => t.setAttribute('data-vps-seen', '1'));
      return tiles.length;
    },
  }).catch(() => [{ result: -1 }]);
  return out?.result ?? -1;
}

/** Give the tiles that appeared since markTilesSeen to `jobId`. Answers how many. */
async function claimNewTiles(tabId, ui, jobId) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [ui.tile, jobId],
    func: (sel, job) => {
      // Still working, too: a finished tile Flow re-rendered is new to the
      // page but not this prompt's; a new one starts as a placeholder -- a
      // percent, a queue note, or nothing in it yet (a clip's may show its
      // start frame while it works).
      const working = (t) => [...t.querySelectorAll('div, span')].some((d) => !d.childElementCount
        && /^\s*\d{1,3}\s*%\s*$|queue|waiting|starting/i.test(d.textContent || ''));
      const filled = (t) => [...t.querySelectorAll('img, video')].some((m) => (m.currentSrc || m.src)
        && m.getBoundingClientRect().width >= 120);
      const fresh = [...document.querySelectorAll(sel)].filter((t) => !t.hasAttribute('data-vps-seen')
        && (working(t) || !filled(t)));
      fresh.forEach((t) => {
        t.setAttribute('data-vps-seen', '1');
        t.setAttribute('data-vps-job', job);
      });
      return fresh.length;
    },
  }).catch(() => [{ result: 0 }]);
  return out?.result || 0;
}

/**
 * The state of `jobId`'s tiles: per tile, its percent, the picture or clip
 * once there, every id-shaped string the tile carries (its media id), and any
 * failure words it shows.
 */
async function jobTiles(tabId, ui, jobId) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [ui.tile, ui.tileVideo, ui.tileImage, ui.errorWords, jobId],
    func: (sel, videoSel, imageSel, words, job) => {
      const errorRe = new RegExp(words, 'i');
      const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
      return [...document.querySelectorAll(sel)]
        .filter((t) => t.getAttribute('data-vps-job') === job)
        .map((tile) => {
          const video = [...tile.querySelectorAll(videoSel)].find((v) => v.currentSrc || v.src);
          const image = [...tile.querySelectorAll(imageSel)].find((i) => i.currentSrc || i.src);
          const pct = [...tile.querySelectorAll('div, span')].find(
            (d) => !d.childElementCount && /^\s*\d{1,3}\s*%\s*$/.test(d.textContent || ''));
          const text = (tile.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 300);
          const ids = new Set();
          for (const el of [tile, ...tile.querySelectorAll('*')]) {
            for (const a of el.attributes) {
              for (const m of a.value.match(uuidRe) || []) ids.add(m.toLowerCase());
            }
          }
          // A clip's tile shows a still until its <video> loads; the still
          // says the clip is there, and its media id is in the tile.
          const clip = tile.querySelector('flow-video-tile');
          const still = clip && [...clip.querySelectorAll('img')].find((i) => i.currentSrc || i.src);
          return {
            percent: pct ? parseInt(pct.textContent, 10) : null,
            clip: !!clip,
            still: still ? (still.currentSrc || still.src) : null,
            video: video ? (video.currentSrc || video.src) : null,
            poster: video ? video.poster || null : null,
            image: image ? (image.currentSrc || image.src) : null,
            error: !video && !image && !still && errorRe.test(text) ? text : null,
            queued: !pct && /queue|waiting|starting/i.test(text),
            ids: [...ids],
          };
        });
    },
  }).catch(() => [{ result: null }]);
  return out?.result;
}

/** The prompt as it is typed: one line, single spaces (Enter would submit). */
const promptLine = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/**
 * Put `prompt` in the composer in one go (Input.insertText), as the Automation
 * project does -- chosen over key-by-key typing for speed (2026-11-08).
 * Select-all first, so what an earlier attempt left is replaced.
 */
async function typePrompt(target, prompt) {
  const mac = /Mac/.test(navigator.platform);
  await pressKey(target, 'a', { code: 'KeyA', keyCode: 65, modifiers: mac ? 4 : 2, commands: ['selectAll'] });
  await pause(80, 200);
  await chrome.debugger.sendCommand(target, 'Input.insertText', { text: promptLine(prompt) });
}

/**
 * Pick the model and shape, type a prompt into Flow's composer, and submit.
 *
 * Says whether the submit went in, what could be picked, and which error
 * messages the page was already showing -- so the agent, watching for the
 * result, does not take an old message for this attempt's. What it produced is
 * read from the project listing afterwards, by the agent.
 *
 * Paced like a person: a pause before the prompt box and another before
 * submitting, and the submit is the Enter key most times and the button the
 * rest. A page with no composer -- left on the project list, or stuck -- is
 * reloaded once before giving up.
 */
/*
 * One submit at a time, each one bounded. The agent stops waiting for an
 * answer at 240s and tries again; without this the second try started while
 * the first was still clicking in the same tab, and a step that never
 * returned (a frozen tab, a page that never loaded) held the composer for
 * good. Each step is reported to the agent's log as it starts, so a submit
 * that hangs says where.
 */
const UI_SUBMIT_LIMIT_MS = 200_000;
let uiSubmit = null; // { done: Promise, since: ms }
let uiStepName = '';

function uiStep(name) {
  uiStepName = name;
  sendToAgent({ type: 'ui_step', step: name });
}

/** How long one submit may take: more for each reference, most for one uploaded here. */
function submitLimitMs(params) {
  const refs = Array.isArray(params?.references) ? params.references : [];
  return UI_SUBMIT_LIMIT_MS + refs.reduce((ms, r) => ms + (r?.dataUrl ? 200_000 : 40_000), 0);
}

async function uiGenerateOnce(params) {
  const limitMs = submitLimitMs(params);
  if (uiSubmit && Date.now() - uiSubmit.since < uiSubmit.limitMs + 60_000) {
    return { error: `COMPOSER_BUSY: the previous submit is still at "${uiStepName}"` };
  }
  holdFlowTab();
  const work = uiGenerateImage(params).catch((e) => ({ error: `UI_ERROR at "${uiStepName}": ${e?.message || e}` }));
  const mine = { done: work, since: Date.now(), limitMs };
  uiSubmit = mine;
  work.finally(() => {
    if (uiSubmit === mine) uiSubmit = null;
    releaseFlowTab();
  });
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ error: `COMPOSER_STUCK at "${uiStepName}" after ${limitMs / 1000}s` }), limitMs);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `kind` is 'image' or 'video'; a video starts from its references as Frames
 * (one picture, its first frame) or Ingredients (up to three). `references`
 * are attached before the prompt is typed. With a `jobId`, the tiles the
 * submit adds are marked as that job's and `tiles` says how many; the agent
 * then reads the result off them (uiJobTiles). `reloadFirst` reloads the tab
 * before anything, after the agent saw a submit fail without a word.
 */
async function uiGenerateImage({
  projectId = null, prompt = '', model = null, aspect = null, selectors = null,
  kind = 'image', videoMode = null, references = [], jobId = null, reloadFirst = false, seconds = null,
} = {}) {
  if (!prompt.trim()) return { error: 'EMPTY_PROMPT' };
  // One line: a new line typed into the box is a paragraph (or a submit) and
  // the box then held only the first line of a clip's labelled prompt.
  prompt = prompt.replace(/\s*\n\s*/g, ' ').trim();
  const ui = uiSelectors(selectors);
  const video = kind === 'video';

  // The tab is closed between runs to save CPU, so the first job after a
  // quiet spell opens it again -- on the job's project, as a person would.
  uiStep('opening the Flow tab');
  if (!(await queryFlowTabs()).length) {
    const created = await openTab({ url: projectId ? projectUrl(projectId) : FLOW_HOME, active: false });
    await waitForTabLoad(created.id, 30000).catch(() => {});
    await pause(2500, 4500);
  }
  uiStep('moving the tab to the project');
  await ensureFlowTabOnProject(projectId);
  const tabs = await queryFlowTabs();
  // The tab that was just moved to this job's project: with two Flow tabs
  // open, taking any live one typed one website's prompt into another's project.
  const candidate = (projectId && tabs.find((t) => (t.url || '').includes(projectId)))
    || tabs.find((t) => !t.discarded) || tabs[0];
  if (!candidate) return { error: 'NO_FLOW_TAB' };
  const tab = await reviveTabIfNeeded(candidate);
  if (!tab) return { error: 'FLOW_TAB_DISCARDED' };
  composerTabId = tab.id;
  // In front, as a person's tab is: a tab left behind can be frozen by the
  // browser, and every step on its page then waits for ever.
  uiStep('bringing the tab to the front');
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  if (reloadFirst) {
    // The last submit's tiles all went blank with no message from Flow; a
    // fresh page is what clears that, as it would for a person.
    uiStep('reloading the tab after a silent failure');
    const loaded = waitForTabLoad(tab.id, 30000);
    await chrome.tabs.reload(tab.id);
    await loaded.catch(() => {});
    await pause(2500, 4500);
  }
  uiStep('checking the page language');
  // The page is driven by its English button names ("Start generation", "Add
  // ingredients to the prompt box"). A Google account in another language
  // shows Flow in that language, and every one of them would be missed; said
  // plainly here rather than as a button that "could not be found".
  const lang = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => document.documentElement.lang || navigator.language || '',
  }).then((r) => String(r?.[0]?.result || '')).catch(() => '');
  if (lang && !/^en\b/i.test(lang)) {
    return { error: `FLOW_NOT_ENGLISH: Flow shows in "${lang}". Set this Google account's language to English (myaccount.google.com/language), then try again` };
  }
  uiStep('finding the prompt box');

  let box = await composerBox(tab.id, ui);
  if (!box || !box.editor) {
    const loaded = waitForTabLoad(tab.id, 30000);
    await chrome.tabs.reload(tab.id);
    await loaded.catch(() => {});
    await pause(2000, 4000);
    box = await composerBox(tab.id, ui);
    if (!box || !box.editor) return { error: 'NO_COMPOSER: the tab is not on a project page' };
  }
  const before = await pageErrorCounts(tab.id, ui);
  const imagesBefore = (await pageImages(tab.id).catch(() => [])).map(mediaIdOf);
  const tilesBefore = (await pageTiles(tab.id).catch(() => ({ srcs: [] }))).srcs;
  const sent = async (picked, submittedAt) => {
    // Placeholders show at once; the ones that were not there before are this
    // prompt's. None after a while: Flow's grid changed, and the agent falls
    // back to reading the project for what is new.
    let tiles = 0;
    if (jobId) {
      uiStep('marking this prompt\'s tiles');
      await waitUntil(async () => {
        tiles += await claimNewTiles(tab.id, ui, jobId);
        return tiles > 0;
      }, 20000, 500);
    }
    return {
      ok: true, submitted: true, picked, pageErrors: Object.keys(before), pageErrorCounts: before,
      pageImages: imagesBefore, pageTiles: tilesBefore, tabUrl: tab.url, tiles,
      // On this worker's clock, which is the one answeredCodes are stamped with.
      submittedAt, now: Date.now() };
  };

  return withDebugger(tab.id, async (target) => {
    const picked = {};
    uiStep('closing the session panel');
    picked.panelClosed = await closeSessionPanel(target, tab.id, ui);
    uiStep('turning Agent mode off');
    picked.agentOff = await agentModeOff(target, tab.id, ui);
    // One result per prompt: x2 spends twice for a second one nobody takes.
    uiStep(video ? 'picking a clip, one per prompt' : 'picking a picture, one per prompt');
    picked.kind = await pickInMenu(target, tab.id, ui, video ? 'Video' : 'Image', KIND_LABELS);
    if (video) {
      const mode = videoMode || (references.length === 1 ? 'Frames' : 'Ingredients');
      picked.videoMode = await pickInMenu(target, tab.id, ui, mode, VIDEO_MODE_LABELS);
      if (seconds) {
        uiStep(`picking a ${seconds}s clip`);
        picked.seconds = await pickInMenu(target, tab.id, ui, `${seconds}s`, DURATION_LABELS);
      }
    }
    picked.count = await pickInMenu(target, tab.id, ui, 'x1', COUNT_LABELS);
    uiStep('picking the model');
    if (model) {
      const family = video ? VIDEO_MODEL_LABELS : MODEL_LABELS;
      picked.model = await pickInMenu(target, tab.id, ui, model,
        family.includes(model) ? family : [model, ...family]);
    }
    uiStep('picking the shape');
    if (aspect) picked.aspect = await pickInMenu(target, tab.id, ui, aspect, ASPECT_LABELS);

    // What the last prompt left in the box -- its ingredients above all --
    // would ride along with this one.
    uiStep('clearing the prompt box');
    picked.cleared = await clearComposer(target, tab.id, ui);
    for (let i = 0; i < references.length; i++) {
      uiStep(`attaching reference ${i + 1} of ${references.length}`);
      picked[`reference${i + 1}`] = await attachReference(target, tab.id, ui, references[i]);
      await pause(400, 1200);
    }
    // A picture sent by its media id and not found: the agent uploads it and
    // asks again, so nothing is submitted without it.
    const missing = references.map((_, i) => picked[`reference${i + 1}`])
      .find((r) => typeof r === 'string' && r.startsWith('MEDIA_NOT_FOUND'));
    if (missing) {
      await clearComposer(target, tab.id, ui);
      return { error: missing };
    }
    // Every reference or none: a scene made without one of its pictures is
    // not the scene asked for, and nothing has been spent yet.
    const notAttached = references.map((_, i) => picked[`reference${i + 1}`]).find((r) => r !== true);
    if (references.length && notAttached !== undefined) {
      await clearComposer(target, tab.id, ui);
      return { error: `REFERENCES_NOT_ATTACHED: ${notAttached}` };
    }

    // Focus by clicking it, not by calling focus(): ProseMirror places the
    // caret from the pointer event, and text inserted without a caret goes
    // nowhere.
    await pause(1000, 3500);
    // Turning Agent mode off, or a menu, can open the panel again.
    picked.panelClosedAgain = await closeSessionPanel(target, tab.id, ui);
    box = await composerBox(tab.id, ui);
    if (!box?.editor) return { error: 'NO_COMPOSER: it went away while picking settings' };
    uiStep('typing the prompt');
    await humanClick(target, box.editor);
    await pause(150, 400);
    await typePrompt(target, prompt);

    box = await composerBox(tab.id, ui);
    if (promptLine(box?.text) !== promptLine(prompt)) {
      const seen = await promptBoxesOnPage(tab.id);
      return { error: `COMPOSER_REJECTED_PROMPT: it holds ${JSON.stringify((box?.text || '').slice(0, 80))}; boxes on the page: ${seen}` };
    }

    // The button enables on the editor's own change event, which lands a
    // frame or two after the insert.
    for (let i = 0; i < 20 && !box?.ready; i++) {
      await sleep(100);
      box = await composerBox(tab.id, ui);
    }
    if (!box?.ready) return { error: 'GENERATE_DISABLED: the composer did not accept the prompt' };

    uiStep('submitting');
    if (jobId) await markTilesSeen(tab.id, ui);
    await pause(800, 3000);
    // Submitted is the composer going empty again, or -- when Flow keeps the
    // prompt ("Clear prompt on submit" off) or hides the box while it works --
    // a Stop button where Generate was, or one more tile showing a percent.
    // Clicking again on any of those would stop the picture or make a second.
    const workingBefore = box.working || 0;
    const submittedAt = Date.now();
    const cleared = async (tries) => {
      for (let i = 0; i < tries; i++) {
        await sleep(200);
        const after = await composerBox(tab.id, ui);
        if (after && (after.text === '' || after.stop || after.working > workingBefore)) return true;
      }
      return false;
    };
    // Enter first most times; if Enter only made a new line, the button.
    if (Math.random() < 0.8) {
      await pressKey(target, 'Enter', { keyCode: 13, text: '\r' });
      if (await cleared(10)) return await sent(picked, submittedAt);
      box = await composerBox(tab.id, ui);
      if (box?.text && promptLine(box.text) !== promptLine(prompt)) {
        await typePrompt(target, prompt); // undo the new line Enter made
        box = await composerBox(tab.id, ui);
      }
    }
    if (!box?.button) return { error: 'SUBMIT_NOT_ACCEPTED: no Generate button' };
    await humanClick(target, box.button);
    if (await cleared(30)) return await sent(picked, submittedAt);
    return { error: 'SUBMIT_NOT_ACCEPTED: the prompt is still in the composer' };
  });
}

/** Pictures showing on the Flow page now. */
/** The tab the last picture was typed into, so its result is read there. */
let composerTabId = null;
async function composerTab() {
  const tabs = await queryFlowTabs();
  return tabs.find((t) => t.id === composerTabId) || tabs.find((t) => !t.discarded);
}

/**
 * A read of the page that cannot wait for ever. The browser freezes a tab it
 * is not showing, and a script sent into a frozen tab never comes back: every
 * read while the picture was being made hung on it. So the tab is put in front
 * first, and a read that still does not answer brings it forward again and is
 * tried once more.
 */
const READ_LIMIT_MS = 10000;
async function awake(tab) {
  if (!tab.active || tab.frozen) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
}
async function readAwake(tab, read, fallback) {
  const once = () => Promise.race([
    read().catch(() => fallback),
    sleep(READ_LIMIT_MS).then(() => 'TIMED_OUT'),
  ]);
  await awake(tab);
  let out = await once();
  if (out === 'TIMED_OUT') {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    out = await once();
  }
  return out === 'TIMED_OUT' ? fallback : out;
}

async function uiPageImages() {
  const tab = await composerTab();
  if (!tab) return { images: [], tiles: [], tabUrl: null, codes: answeredCodes.slice(-20), now: Date.now() };
  const tiles = await readAwake(tab, () => pageTiles(tab.id), { srcs: [], url: tab.url });
  return {
    images: await readAwake(tab, () => pageImages(tab.id), []),
    tiles: tiles.srcs,
    tabUrl: tiles.url,
    working: tiles.working || 0,
    network: networkSeen.slice(-8).map(({ url, status, found }) => ({ url, status, found })),
    answered: answeredImages.length,
    codes: answeredCodes.slice(-20),
    now: Date.now(),
  };
}

/** The picture of one tile on the Flow page, as a data: URL. */
async function uiTileImage({ src = '' } = {}) {
  const tab = await composerTab();
  if (!tab) return { error: 'NO_FLOW_TAB' };
  const inPage = await tileImage(tab.id, src).catch((e) => ({ error: String(e?.message || e) }));
  if (inPage.dataUrl || !/^https:/.test(src)) return inPage;
  // A picture on another host can refuse the page's fetch (no CORS); this
  // worker holds the host permission and the same cookies, so it can read it.
  try {
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) return { error: `${inPage.error}; worker HTTP ${res.status}` };
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return { error: `not a picture: ${blob.type}` };
    const { width, height } = await createImageBitmap(blob).catch(() => ({}));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { dataUrl: `data:${blob.type};base64,${btoa(bin)}`, width, height };
  } catch (e) {
    return { error: `${inPage.error}; worker: ${e?.message || e}` };
  }
}

/**
 * A job's tiles as they are now. `found: false` when none carry its mark any
 * more -- a reload, or Flow drawing its grid anew -- so the agent knows to look
 * for the result another way.
 */
async function uiJobTiles({ jobId = '', selectors = null } = {}) {
  const tab = await composerTab();
  if (!tab) return { error: 'NO_FLOW_TAB' };
  const ui = uiSelectors(selectors);
  const tiles = await readAwake(tab, () => jobTiles(tab.id, ui, jobId), null);
  if (!Array.isArray(tiles)) return { error: 'the page did not answer' };
  return { found: tiles.length > 0, tiles, codes: answeredCodes.slice(-20), now: Date.now() };
}

/** Error messages on the Flow page now, less the ones in `ignore`. */
async function uiPageErrors({ ignore = [], before = null, selectors = null } = {}) {
  const tab = await composerTab();
  if (!tab) return { errors: [] };
  const counts = await readAwake(tab, () => pageErrorCounts(tab.id, uiSelectors(selectors)), {});
  // With the counts from before the submit, a message is new when more tiles
  // show it than did then -- the same words on a new failed tile count.
  if (before && typeof before === 'object') {
    return { errors: Object.keys(counts).filter((e) => counts[e] > (before[e] || 0)), counts };
  }
  return { errors: Object.keys(counts).filter((e) => !ignore.includes(e)), counts };
}

async function handleBatchRpc(msg) {
  const { id, params } = msg;
  const { rpcid, freq, captchaAction, match, projectId } = params || {};

  if (!rpcid || !freq) {
    sendToAgent({ id, status: 400, error: 'INVALID_BATCH_RPC' });
    return;
  }

  // The same hold the api_request path takes: a batch call needs the Flow tab
  // for the whole of its run, and the idle close must not take it away midway.
  holdFlowTab();
  setState('running');

  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;
  // Polls and lookups run constantly; only the generates earn a row in the log.
  const visible = hasCaptcha;
  if (visible) {
    addRequestLog({
      id, type: `RPC:${rpcid}`, time: new Date().toISOString(),
      status: 'processing', error: null, outputUrl: null, url: rpcid,
      payloadSummary: String(freq).slice(0, 200),
    });
  }

  try {
    const cmd = { id, rpcid, freq, captchaAction, match, projectId: projectId || null };
    const out = captchaAction
      ? await takeCaptchaTurn(() => runBatchRpc(cmd))
      : await runBatchRpc(cmd);
    if (out.error) {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = out.error; }
      if (visible) updateRequestLog(id, { status: 'failed', error: out.error });
      sendToAgent({ id, status: 502, error: out.error });
    } else {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      if (visible) {
        updateRequestLog(id, {
          status: 'success', httpStatus: out.status,
          responseSummary: (out.text || '').slice(0, 300),
        });
      }
      sendToAgent({ id, status: out.status, data: out.text });
    }
  } catch (e) {
    const err = e?.message || 'BATCH_RPC_FAILED';
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = err; }
    if (visible) updateRequestLog(id, { status: 'failed', error: err });
    sendToAgent({ id, status: 500, error: err });
  } finally {
    releaseFlowTab();
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

async function handleApiRequest(msg) {
  // Claimed before anything can await, so a request arriving while the idle
  // alarm is deciding cannot lose its tab underneath it.
  holdFlowTab();
  try {
    // Best effort. Every downstream step already copes with a missing tab --
    // the captcha path has its own recovery and the token path reopens -- so a
    // failure here is not worth failing the request over.
    await ensureFlowTab();
    return await sendApiRequest(msg);
  } finally {
    releaseFlowTab();
  }
}

async function sendApiRequest(msg) {
  const { id, params } = msg;
  const { url, method, headers, body, captchaAction } = params;

  if (!url) {
    sendToAgent({ id, error: 'MISSING_URL' });
    return;
  }

  if (!url.startsWith('https://aisandbox-pa.googleapis.com/')) {
    sendToAgent({ id, error: 'INVALID_URL' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;

  const logId = id;
  const logType = _classifyApiUrl(url);
  if (_VISIBLE_TYPES.has(logType)) {
    const payloadSummary = body ? JSON.stringify(body).slice(0, 200) : null;
    addRequestLog({ id: logId, type: logType, time: new Date().toISOString(), status: 'processing', error: null, outputUrl: null, url, payloadSummary });
  }

  try {
    // Step 0: reCAPTCHA exists on a project page and not on the project list.
    if (captchaAction) await ensureFlowTabOnProject();

    // Step 1: Solve captcha if needed
    let captchaToken = null;
    if (captchaAction) {
      const captchaResult = await solveCaptcha(id, captchaAction);
      captchaToken = captchaResult?.token || null;
      if (!captchaToken) {
        // Cannot proceed without captcha — API will 403
        const err = captchaResult?.error || 'CAPTCHA_FAILED';
        console.error(`[FlowAgent] Captcha failed for ${captchaAction}: ${err}`);
        sendToAgent({ id, status: 403, error: `CAPTCHA_FAILED: ${err}` });
        if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `CAPTCHA_FAILED: ${err}`; }
        chrome.storage.local.set({ metrics });
        updateRequestLog(logId, { status: 'failed', error: `CAPTCHA_FAILED: ${err}` });
        setState('idle');
        return;
      }
    }

    // Step 2: Inject captcha token into body
    let finalBody = body;
    if (captchaToken && finalBody) {
      finalBody = JSON.parse(JSON.stringify(finalBody)); // deep clone
      if (finalBody.clientContext?.recaptchaContext) {
        finalBody.clientContext.recaptchaContext.token = captchaToken;
      }
      if (finalBody.requests && Array.isArray(finalBody.requests)) {
        for (const req of finalBody.requests) {
          if (req.clientContext?.recaptchaContext) {
            req.clientContext.recaptchaContext.token = captchaToken;
          }
        }
      }
    }

    // Step 3: Use flowKey for auth
    // Hydrate first — after a service-worker revival the token is in storage
    // but not yet in memory, and failing here would report NO_FLOW_KEY for a
    // token we actually hold.
    await ensureHydrated();

    let activeFlowKey = flowKey;
    if (!activeFlowKey) {
      // Re-read storage directly rather than via ensureHydrated(), whose
      // cached promise would keep returning the same empty result.
      console.warn('[FlowAgent] No token in memory — re-reading storage');
      await reloadFromStorage();
      activeFlowKey = flowKey;
    }
    if (!activeFlowKey) {
      // Genuinely absent, not merely forgotten: reload the Flow tab to capture
      // a fresh one instead of failing the request outright.
      console.warn('[FlowAgent] Still no token — reloading Flow tab');
      if (await refreshFlowToken('on-demand')) {
        activeFlowKey = flowKey;
      }
    }

    if (!activeFlowKey) {
      sendToAgent({ id, status: 503, error: 'NO_FLOW_KEY' });
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = 'NO_FLOW_KEY'; }
      chrome.storage.local.set({ metrics });
      updateRequestLog(logId, { status: 'failed', error: 'NO_FLOW_KEY' });
      setState('idle');
      return;
    }

    const send = async (bodyToSend) => {
      const fetchHeaders = { ...(headers || {}) };
      fetchHeaders['authorization'] = `Bearer ${flowKey || activeFlowKey}`;

      const res = await fetch(url, {
        method: method || 'POST',
        headers: fetchHeaders,
        credentials: 'include',
        body: method === 'GET' ? undefined : JSON.stringify(bodyToSend),
      });

      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { res, text, parsed };
    };

    // Step 4: Make the API call from browser context
    let _retriedAuth = false;
    let { res: response, text: responseText, parsed: responseData } = await send(finalBody);

    // Step 5: A rejected score is recoverable — reset the session and re-send.
    // Only worth doing for a request that carried a captcha in the first place.
    for (
      let attempt = 0;
      captchaAction &&
      attempt < RECAPTCHA_REJECT_MAX_RETRIES &&
      isRecaptchaRejection(response.status, responseData);
      attempt++
    ) {
      updateRequestLog(logId, {
        status: 'processing',
        error: 'reCAPTCHA rejected — resetting session',
      });

      if (!(await resetCaptchaSession(captchaAction))) break;

      const retryCaptcha = await solveCaptcha(id, captchaAction);
      if (!retryCaptcha?.token) {
        console.error('[FlowAgent] No captcha after session reset:', retryCaptcha?.error);
        break;
      }

      // Rebuild the body around the new token rather than mutating the old
      // one, so a partially rewritten payload can never be sent.
      let retryBody = JSON.parse(JSON.stringify(body));
      if (retryBody.clientContext?.recaptchaContext) {
        retryBody.clientContext.recaptchaContext.token = retryCaptcha.token;
      }
      if (Array.isArray(retryBody.requests)) {
        for (const req of retryBody.requests) {
          if (req.clientContext?.recaptchaContext) {
            req.clientContext.recaptchaContext.token = retryCaptcha.token;
          }
        }
      }

      console.log('[FlowAgent] Re-sending with a fresh captcha after session reset');
      ({ res: response, text: responseText, parsed: responseData } = await send(retryBody));

      if (response.ok) {
        metrics.recaptchaRecovered = (metrics.recaptchaRecovered || 0) + 1;
        console.log('[FlowAgent] Recovered from reCAPTCHA rejection');
      }
    }

    // Step 6: A 401 means the bearer expired between capture and send. The
    // pre-flight checks above cannot catch it — the token is present, just no
    // longer valid — so this is the only place it can be recovered. Reload the
    // Flow tab for a fresh one and send the same body again, once.
    if (response.status === 401 && !_retriedAuth) {
      _retriedAuth = true;
      console.warn('[FlowAgent] 401 — token expired, refreshing and re-sending');
      updateRequestLog(logId, { status: 'processing', error: '401 — refreshing token' });

      if (await refreshFlowToken('on-demand')) {
        metrics.authRecovered = (metrics.authRecovered || 0) + 1;
        ({ res: response, text: responseText, parsed: responseData } = await send(finalBody));
        if (response.ok) console.log('[FlowAgent] Recovered from 401');
      } else {
        console.error('[FlowAgent] 401 and the tab reload produced no new token');
      }
    }

    sendToAgent({
      id,
      status: response.status,
      data: responseData,
    });

    const responseSummary = responseText ? responseText.slice(0, 300) : null;
    if (response.ok) {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      updateRequestLog(logId, { status: 'success', httpStatus: response.status, responseSummary });
    } else {
      // Name it, so the run log says why rather than "API_403". The agent
      // keys its retry decision on this text.
      const label = isRecaptchaRejection(response.status, responseData)
        ? 'RECAPTCHA_REJECTED: score too low after a session reset'
        : `API_${response.status}`;
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = label; }
      updateRequestLog(logId, { status: 'failed', error: label, httpStatus: response.status, responseSummary });
    }
  } catch (e) {
    sendToAgent({
      id,
      status: 500,
      error: e.message || 'API_REQUEST_FAILED',
    });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message; }
    updateRequestLog(logId, { status: 'failed', error: e.message || 'API_REQUEST_FAILED' });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

// ─── State & Popup ──────────────────────────────────────────

function setState(newState) {
  state = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors = { idle: '#22c55e', running: '#f59e0b', off: '#6b7280' };
  chrome.action.setBadgeText({ text: badges[state] || '' });
  chrome.action.setBadgeBackgroundColor({ color: colors[state] || '#000' });
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'STATUS') {
    reply({
      connected: ws?.readyState === WebSocket.OPEN,
      agentConnected: ws?.readyState === WebSocket.OPEN,
      flowKeyPresent: !!flowKey,
      manualDisconnect,
      tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      metrics: {
        requestCount: metrics.requestCount,
        successCount: metrics.successCount,
        failedCount: metrics.failedCount,
        lastError: metrics.lastError,
      },
      state,
    });
  }

  if (msg.type === 'DISCONNECT') {
    manualDisconnect = true;
    if (ws) ws.close();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT') {
    manualDisconnect = false;
    connectToAgent();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'REQUEST_LOG') {
    reply({ log: requestLog });
    return true;
  }

  if (msg.type === 'TAB_AUDIT') {
    reply({ audit: tabAudit, lastCreatedAt: _lastFlowTabCreatedAt });
    return true;
  }

  if (msg.type === 'OPEN_FLOW_TAB') {
    chrome.tabs.query({
      url: FLOW_TAB_URLS,
    }).then((tabs) => {
      if (tabs.length) {
        chrome.tabs.update(tabs[0].id, { active: true });
        reply({ ok: true, tabId: tabs[0].id });
      } else {
        // User-initiated from the popup — deliberately not gated by the
        // cooldown, but recorded so the audit trail stays complete.
        recordTabEvent('created', 'user-popup', { url: FLOW_HOME });
        chrome.tabs.create({ url: FLOW_HOME })
          .then((tab) => reply({ ok: true, tabId: tab.id }))
          .catch((e) => reply({ error: e.message }));
      }
    }).catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_TOKEN') {
    captureTokenFromFlowTab()
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'TEST_CAPTCHA') {
    solveCaptcha(`test-${Date.now()}`, msg.pageAction || 'IMAGE_GENERATION')
      .then((r) => reply(r))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'TRPC_MEDIA_URLS') {
    handleTrpcMediaUrls(msg.trpcUrl, msg.body);
    reply({ ok: true });
    return true;
  }

  return true;
});

// ─── TRPC Media URL Extractor ──────────────────────────────

function handleTrpcMediaUrls(trpcUrl, bodyText) {
  try {
    // Extract all fresh GCS signed URLs
    const urlRegex = /https:\/\/storage\.googleapis\.com\/ai-sandbox-videofx\/(?:image|video)\/[0-9a-f-]{36}\?[^"'\s]+/g;
    const matches = bodyText.match(urlRegex) || [];
    if (!matches.length) return;

    // Deduplicate and parse
    const urlMap = {};
    for (const rawUrl of matches) {
      // Unescape JSON-escaped URLs
      const url = rawUrl.replace(/\\u0026/g, '&').replace(/\\/g, '');
      const mediaMatch = url.match(/\/(image|video)\/([0-9a-f-]{36})\?/);
      if (mediaMatch) {
        const [, mediaType, mediaId] = mediaMatch;
        // Keep last occurrence (freshest)
        urlMap[mediaId] = { mediaType, url, mediaId };
      }
    }

    const entries = Object.values(urlMap);
    if (!entries.length) return;

    console.log(`[FlowAgent] Captured ${entries.length} fresh media URLs from TRPC`);
    // URL refresh is silent — don't show in request log

    // Forward to agent for DB update
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'media_urls_refresh',
        urls: entries,
      }));
    }
  } catch (e) {
    console.error('[FlowAgent] Failed to extract TRPC media URLs:', e);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Human-like Telemetry ──────────────────────────────────
// Periodically send tracking events to Google's analytics endpoints
// to mimic normal browser behavior.

const _UA = navigator.userAgent;
let _telemetrySessionId = `;${Date.now()}`;

function _rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function _buildBatchLogPayload() {
  const events = [];
  const types = ['FLOW_IMAGE_LATENCY', 'FLOW_VIDEO_LATENCY'];
  const count = _rand(1, 3);
  for (let i = 0; i < count; i++) {
    events.push({
      event: types[_rand(0, types.length - 1)],
      eventProperties: [
        { key: 'CURRENT_TIME_MS', doubleValue: Date.now() },
        { key: 'DURATION_MS', doubleValue: _rand(150, 800) },
        { key: 'USER_AGENT', stringValue: _UA },
        { key: 'IS_DESKTOP', booleanValue: true },
      ],
      eventMetadata: { sessionId: _telemetrySessionId },
      eventTime: new Date().toISOString(),
    });
  }
  return { appEvents: events };
}

function _buildFrontendEventsPayload() {
  const eventTypes = [
    'FLOW_IMAGE_LATENCY', 'FLOW_VIDEO_LATENCY', 'GRID_SCROLL_DEPTH',
    'FLOW_PROJECT_OPEN', 'FLOW_SCENE_VIEW',
  ];
  const count = _rand(1, 4);
  const events = [];
  for (let i = 0; i < count; i++) {
    const et = eventTypes[_rand(0, eventTypes.length - 1)];
    const params = {
      USER_AGENT: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: _UA },
      IS_DESKTOP: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'true' },
    };
    if (et.includes('LATENCY')) {
      params.CURRENT_TIME_MS = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: String(Date.now()) };
      params.DURATION_MS = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: String(_rand(100, 600)) };
    }
    if (et === 'GRID_SCROLL_DEPTH') {
      params.MEDIA_GENERATION_PAYGATE_TIER = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'PAYGATE_TIER_TWO' };
    }
    events.push({
      eventType: et,
      metadata: {
        sessionId: _telemetrySessionId,
        createTime: new Date().toISOString(),
        additionalParams: params,
      },
    });
  }
  return { events };
}

async function sendTelemetry() {
  if (!flowKey || state === 'off') return;

  const headers = {
    'Content-Type': 'text/plain;charset=UTF-8',
    'authorization': `Bearer ${flowKey}`,
  };

  // Telemetry is silent — don't show in request log
  try {
    if (Math.random() < 0.5) {
      await fetch(`https://aisandbox-pa.googleapis.com/v1:batchLog`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify(_buildBatchLogPayload()),
      });
    } else {
      await fetch(`https://aisandbox-pa.googleapis.com/v1/flow:batchLogFrontendEvents`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify(_buildFrontendEventsPayload()),
      });
    }
  } catch {}
}

// Send telemetry at random intervals (45-120s) to look organic
function scheduleTelemetry() {
  const delay = _rand(45, 120) * 1000;
  setTimeout(async () => {
    await sendTelemetry();
    scheduleTelemetry(); // reschedule with new random interval
  }, delay);
}

// Refresh session ID every ~30min like a real user
setInterval(() => { _telemetrySessionId = `;${Date.now()}`; }, _rand(25, 35) * 60 * 1000);

scheduleTelemetry();

console.log('[FlowAgent] Extension loaded');


// ─── Signing in to Google from the platform ─────────────────
//
// The agent drives the sign-in; this only opens the page, reports which step
// Google is showing, and puts the cursor in a field. The typing itself is done
// by the agent as real keystrokes on the display (xdotool), because Google's
// sign-in page tells a script setting a value from a person typing.

// Google's own entry point. A ServiceLogin link with a continue= for Flow is
// refused with a 400 ("malformed"), so the sign-in starts plain and the tab is
// sent to Flow once Google lets it through.
const GOOGLE_LOGIN_URL = 'https://accounts.google.com/';
const FLOW_AFTER_LOGIN = 'https://labs.google/fx/tools/flow';
let loginTabId = null;

async function loginTab() {
  if (loginTabId !== null) {
    try { return await chrome.tabs.get(loginTabId); } catch { loginTabId = null; }
  }
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => (t.url || '').startsWith('https://accounts.google.com/')) || null;
}

async function googleLoginStep({ action, selector = '', email = '' } = {}) {
  try {
    if (action === 'open') {
      let tab = await loginTab();
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true, url: GOOGLE_LOGIN_URL });
      } else {
        tab = await chrome.tabs.create({ url: GOOGLE_LOGIN_URL, active: true });
      }
      loginTabId = tab.id;
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true, tabId: tab.id };
    }

    const tab = await loginTab();
    if (!tab) return { step: 'no_tab' };
    const url = tab.url || tab.pendingUrl || '';
    // Past the sign-in: Google shows the account page (or Flow). Send it to Flow.
    if (/^https:\/\/(myaccount\.google\.com|labs\.google|flow\.google\.com)\//.test(url)) {
      if (!/labs\.google|flow\.google\.com/.test(url)) {
        await chrome.tabs.update(tab.id, { url: FLOW_AFTER_LOGIN });
      }
      loginTabId = null;
      return { step: 'done', url };
    }
    if (!url.startsWith('https://accounts.google.com/')) return { step: 'unknown', url };
    await chrome.tabs.update(tab.id, { active: true });

    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [action, selector, email],
      func: (act, sel, mail) => {
        // offsetParent is null for fields inside Google's fixed-position layout,
        // so visibility is read from the box itself.
        const visible = (el) => {
          if (!el || el.disabled || el.getAttribute('aria-hidden') === 'true' || el.name === 'hiddenPassword') return false;
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        const q = (s) => [...document.querySelectorAll(s)].find(visible) || null;

        if (act === 'focus') {
          const el = q(sel);
          if (!el) return { ok: false };
          el.focus();
          el.select && el.select();
          return { ok: true };
        }
        if (act === 'choose') {
          // The account chooser: pick the account, or "Use another account".
          const rows = [...document.querySelectorAll('[data-identifier]')];
          const mine = rows.find((r) => (r.getAttribute('data-identifier') || '').toLowerCase() === mail.toLowerCase());
          const other = [...document.querySelectorAll('li, div[role="link"]')]
            .find((el) => /use another account/i.test(el.textContent || ''));
          (mine || other)?.click();
          return { ok: !!(mine || other) };
        }

        const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
        const error = [...document.querySelectorAll('[aria-live="assertive"], [aria-live="polite"]')]
          .map((e) => (e.innerText || '').trim()).filter(Boolean).join(' ').slice(0, 200);

        let step = 'unknown';
        if (/browser or app may not be secure|couldn.t sign you in|couldn't sign you in/i.test(text)) step = 'blocked';
        else if (q('input[name="ca"], #captchaimg')) step = 'captcha';
        else if (q('input[type="email"], #identifierId, input[name="identifier"]')) step = 'email';
        else if (q('input[type="password"], input[name="Passwd"]')) step = 'password';
        else if (q('input[name="totpPin"], #totpPin, input[name="idvPin"], #idvPin, input[name="Pin"], input[type="tel"]')) step = 'code';
        else if (/check your phone|google sent a notification|tap yes|open the gmail app/i.test(text)) step = 'phone';
        else if (document.querySelector('[data-identifier]')) step = 'chooser';
        else if (/verify it.s you|choose how you want to sign in|try another way/i.test(text)) step = 'verify';
        return { step, url: location.href, error, text: text.slice(0, 300) };
      },
    });
    return injected?.result || { step: 'unknown' };
  } catch (e) {
    return { step: 'unknown', error: String(e?.message || e) };
  }
}


// ─── A new Flow project for a freshly signed-in account ─────
//
// Presses Flow's own "New project" button on the home page and reads the new
// project's id off the address bar -- the same thing a person does by hand.
// Found by its words rather than a selector, because Flow's markup is
// minified and changes without notice.

async function waitForTab(tabId, test, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && test(tab)) return tab;
    await sleep(1000);
  }
  return null;
}

async function createFlowProject() {
  try {
    const tabs = await queryFlowTabs();
    let tab = tabs[0];
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true, url: FLOW_HOME });
    } else {
      tab = await chrome.tabs.create({ url: FLOW_HOME, active: true });
    }
    // Home loaded, and not bounced to a sign-in page.
    const home = await waitForTab(tab.id, (t) => t.status === 'complete' && isFlowUrl(t.url) && !(t.url || '').includes('/project/'), 30000);
    if (!home) return { error: 'Flow did not open (is the account signed in?)' };

    const deadline = Date.now() + 30000;
    let clicked = false;
    while (!clicked && Date.now() < deadline) {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const words = /^\s*(\+\s*)?new project\s*$/i;
          const candidates = [...document.querySelectorAll('button, a, [role="button"]')];
          const el = candidates.find((c) => words.test(c.innerText || c.textContent || '')
            || words.test(c.getAttribute('aria-label') || ''));
          if (!el) return false;
          el.click();
          return true;
        },
      }).catch(() => [{ result: false }]);
      clicked = !!res?.result;
      if (!clicked) await sleep(1500);
    }
    if (!clicked) return { error: 'Could not find the "New project" button on Flow.' };

    const opened = await waitForTab(tab.id, (t) => /\/project\/[^/?#]+/.test(t.url || ''), 30000);
    if (!opened) return { error: 'Flow did not open the new project.' };
    const id = /\/project\/([^/?#]+)/.exec(opened.url)[1];
    return { ok: true, projectId: id };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
