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
        holdFlowTab();
        try {
          sendToAgent({ id: msg.id, result: await uiGenerateImage(msg.params || {}) });
        } finally {
          releaseFlowTab();
        }
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

/** Run `body` with the debugger attached, and always detach afterwards. */
async function withDebugger(tabId, body) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, CDP_VERSION);
  } catch (e) {
    // Already attached -- by a previous run that died, or by DevTools being
    // open on this tab. Neither is ours to steal.
    return { error: `DEBUGGER_ATTACH_FAILED: ${e?.message || e}` };
  }
  try {
    return await body(target);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

/** One trusted click at viewport coordinates. */
async function trustedClick(target, x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent',
    { type: 'mousePressed', ...base });
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent',
    { type: 'mouseReleased', ...base });
}

/**
 * Where the composer and the Generate button are, and whether it is ready.
 *
 * Read immediately before each click rather than once: the composer grows as
 * text is typed into it and the button moves down the page with it.
 */
async function composerBox(tabId) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const editor = document.querySelector('div.ProseMirror');
      const button = document.querySelector('button[aria-label="Start generation"]');
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      };
      return {
        editor: box(editor),
        button: box(button),
        ready: !!button && !button.disabled,
        text: editor ? editor.innerText.trim() : null,
      };
    },
  });
  return out?.result || null;
}

/**
 * Put `prompt` in the composer.
 *
 * insertText through execCommand rather than assigning textContent: the
 * composer is a ProseMirror editor and keeps its own document, so text set
 * on the node is text the editor does not know it has -- the button stays
 * disabled and a submit sends nothing. selectAll first, so a prompt left over
 * from an attempt that failed is replaced rather than appended to.
 */
async function typePrompt(tabId, prompt) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [prompt],
    func: (text) => {
      const editor = document.querySelector('div.ProseMirror');
      if (!editor) return { error: 'NO_COMPOSER' };
      editor.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      return { text: editor.innerText.trim() };
    },
  });
  return out?.result || { error: 'NO_INJECTION_RESULT' };
}

/**
 * Type a prompt into Flow's composer and press Generate.
 *
 * Says only whether the submit went in. What it produced is read from the
 * project listing afterwards, by the agent -- that call carries no captcha,
 * so it is the half of this that never broke.
 */
async function uiGenerateImage({ projectId = null, prompt = '' } = {}) {
  if (!prompt.trim()) return { error: 'EMPTY_PROMPT' };

  await ensureFlowTabOnProject(projectId);
  const tabs = await queryFlowTabs();
  const candidate = tabs.find((t) => !t.discarded) || tabs[0];
  if (!candidate) return { error: 'NO_FLOW_TAB' };
  const tab = await reviveTabIfNeeded(candidate);
  if (!tab) return { error: 'FLOW_TAB_DISCARDED' };

  // The composer only exists on a project page. A tab that landed on the
  // project list or Flow's 404 has none, and clicking where it would be
  // clicks the page behind it.
  let box = await composerBox(tab.id);
  if (!box || !box.editor) return { error: 'NO_COMPOSER: the tab is not on a project page' };

  return withDebugger(tab.id, async (target) => {
    // Focus by clicking it, not by calling focus(): ProseMirror places the
    // caret from the pointer event, and text inserted without a caret goes
    // nowhere.
    await trustedClick(target, box.editor.x, box.editor.y);
    const typed = await typePrompt(tab.id, prompt);
    if (typed.error) return typed;
    if (typed.text !== prompt.trim()) {
      return { error: `COMPOSER_REJECTED_PROMPT: it holds ${JSON.stringify((typed.text || '').slice(0, 80))}` };
    }

    // The button enables on the editor's own change event, which lands a
    // frame or two after the insert.
    for (let i = 0; i < 20; i++) {
      box = await composerBox(tab.id);
      if (box?.ready) break;
      await sleep(100);
    }
    if (!box?.ready) return { error: 'GENERATE_DISABLED: the composer did not accept the prompt' };

    await trustedClick(target, box.button.x, box.button.y);

    // Submitted is the composer going empty again. Without this a caller can
    // start polling the listing before Flow has sent anything.
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      const after = await composerBox(tab.id);
      if (after && after.text === '') return { ok: true, submitted: true };
    }
    return { error: 'SUBMIT_NOT_ACCEPTED: the prompt is still in the composer' };
  });
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
