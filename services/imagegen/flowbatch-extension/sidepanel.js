// Side panel: gathers the queue, settings and reference library, hands them to
// the content script in the active Flow tab, and shows what it reports back.

const FB = self.FlowBatch;
const $ = (id) => document.getElementById(id);

const SETTING_FIELDS = [
  'mode', 'model', 'aspectRatio', 'outputCount', 'videoLength', 'quality',
  'folder', 'prefix', 'autoRename', 'maxInFlight', 'retries', 'delayMin', 'delayMax',
  'timeoutMinutes', 'maxImagesPerPrompt', 'attachAll', 'chain', 'zoomOut',
];

let library = [];
let imported = [];
let runItems = [];

// ─── small helpers ────────────────────────────────────────────

function fillSelect(id, options, blankLabel) {
  const select = $(id);
  select.replaceChildren();
  if (blankLabel) select.append(new Option(blankLabel, ''));
  for (const option of options) {
    const [value, label] = Array.isArray(option) ? option : [option, option];
    select.append(new Option(label, value));
  }
}

const readFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

const baseName = (name) => name.replace(/\.[^/.]+$/, '');

function showLog(message, level = 'info') {
  const log = $('log');
  log.textContent += `${new Date().toLocaleTimeString()} ${level.toUpperCase()} ${message}\n`;
  log.scrollTop = log.scrollHeight;
}

// ─── tabs ─────────────────────────────────────────────────────

for (const tab of document.querySelectorAll('.tabs button')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tabs button')) other.setAttribute('aria-selected', String(other === tab));
    for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
  });
}

// ─── settings and selectors ───────────────────────────────────

function readSettings() {
  const settings = {};
  for (const id of SETTING_FIELDS) {
    const el = $(id);
    if (el.type === 'checkbox') settings[id] = el.checked;
    else if (el.type === 'number') settings[id] = Number(el.value) || 0;
    else settings[id] = el.value;
  }
  settings.split = document.querySelector('input[name="split"]:checked').value;
  settings.delayMax = Math.max(settings.delayMax, settings.delayMin);
  settings.outputCount = Math.max(1, settings.outputCount);
  settings.maxInFlight = Math.max(1, settings.maxInFlight);
  return settings;
}

const saveSettings = () => chrome.storage.local.set({ settings: readSettings(), queueText: $('prompts').value });

function readSelectors() {
  try {
    const parsed = JSON.parse($('selectors').value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return { ...FB.DEFAULT_SELECTORS, ...parsed };
  } catch (err) {
    throw new Error(`Selectors are not valid JSON (${err.message})`);
  }
}

// ─── library ──────────────────────────────────────────────────

function renderLibrary() {
  $('library').replaceChildren(
    ...library.map((image) => {
      const li = document.createElement('li');
      const media = document.createElement(/^data:video/.test(image.dataUrl) ? 'video' : 'img');
      media.src = image.dataUrl;
      const label = document.createElement('span');
      label.textContent = baseName(image.name);
      label.title = image.name;
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.title = 'Remove';
      remove.addEventListener('click', async () => {
        library = library.filter((other) => other.id !== image.id);
        await chrome.storage.local.set({ library });
        renderLibrary();
      });
      li.append(media, label, remove);
      return li;
    }),
  );
}

$('addImages').addEventListener('click', () => $('imageFiles').click());
$('imageFiles').addEventListener('change', async (event) => {
  for (const file of event.target.files) {
    library.push({ id: crypto.randomUUID(), name: file.name, dataUrl: await readFile(file) });
  }
  event.target.value = '';
  await chrome.storage.local.set({ library });
  renderLibrary();
});

// ─── prompts and CSV ──────────────────────────────────────────

function parseLines() {
  const { split } = readSettings();
  const chunks = split === 'blank' ? $('prompts').value.split(/\n\s*\n/) : $('prompts').value.split('\n');
  return chunks.map((chunk) => chunk.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function updateCount() {
  const n = imported.length || parseLines().length;
  $('promptCount').textContent = n ? `${n} prompt${n === 1 ? '' : 's'}` : '';
}

// RFC 4180-ish: quoted fields may hold commas, quotes ("") and newlines.
function parseDelimited(text) {
  const first = text.split('\n', 1)[0];
  const delimiter = first.split('\t').length > first.split(',').length ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"', i++);
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) (row.push(field), (field = ''));
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

const COLUMN = {
  prompt: 'prompt', text: 'prompt',
  mode: 'mode', model: 'model',
  aspect: 'aspectRatio', aspectratio: 'aspectRatio', ratio: 'aspectRatio',
  count: 'outputCount', outputcount: 'outputCount', outputs: 'outputCount',
  length: 'videoLength', videolength: 'videoLength', duration: 'videoLength',
  quality: 'quality', images: 'images', image: 'images',
  characters: 'characters', character: 'characters', chain: 'chain',
};

const MODE_ALIASES = {
  texttovideo: 'textToVideo', t2v: 'textToVideo',
  imagetovideo: 'imageToVideo', framestovideo: 'imageToVideo', i2v: 'imageToVideo',
  componentstovideo: 'componentsToVideo', ingredientstovideo: 'componentsToVideo',
  texttoimage: 'textToImage', t2i: 'textToImage',
  imagetoimage: 'imageToImage', i2i: 'imageToImage',
};

const list = (value) => String(value || '').split(/[;|]/).map((part) => part.trim()).filter(Boolean);
const truthy = (value) => /^(1|true|yes|y|x)$/i.test(String(value || '').trim());

function rowsToItems(rows) {
  const header = rows[0].map((cell) => COLUMN[cell.trim().toLowerCase().replace(/[\s_-]/g, '')] || null);
  if (!header.includes('prompt')) throw new Error('The first row needs a "prompt" column');

  return rows.slice(1).map((cells) => {
    const row = {};
    header.forEach((key, i) => key && (row[key] = (cells[i] || '').trim()));
    return row;
  }).filter((row) => row.prompt);
}

// Settings give every value a prompt does not set itself.
function buildItem(row, settings) {
  const mode = MODE_ALIASES[String(row.mode || '').toLowerCase().replace(/[\s_→>-]/g, '')] || settings.mode;
  return {
    prompt: row.prompt.replace(/\s+/g, ' ').trim(),
    mode,
    model: row.model || settings.model,
    aspectRatio: row.aspectRatio || settings.aspectRatio,
    outputCount: Number(row.outputCount) || settings.outputCount,
    videoLength: row.videoLength ? String(parseInt(row.videoLength, 10)) : settings.videoLength,
    quality: row.quality ? row.quality.toLowerCase().replace('p', '') : settings.quality,
    imageNames: list(row.images),
    characters: list(row.characters),
    chain: row.chain !== undefined ? truthy(row.chain) : settings.chain,
    attachAll: settings.attachAll,
  };
}

$('importCsv').addEventListener('click', () => $('csvFile').click());
$('csvFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    imported = rowsToItems(parseDelimited(await file.text()));
    if (!imported.length) throw new Error('No rows with a prompt');
    $('importInfo').textContent = `${imported.length} rows from ${file.name}`;
    $('clearImport').hidden = false;
  } catch (err) {
    imported = [];
    $('importInfo').textContent = err.message;
  }
  updateCount();
});

$('clearImport').addEventListener('click', () => {
  imported = [];
  $('importInfo').textContent = '';
  $('clearImport').hidden = true;
  updateCount();
});

// ─── the Flow tab ─────────────────────────────────────────────

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id !== undefined ? tab : null;
}

async function toTab(message) {
  const tab = await activeTab();
  if (!tab) throw new Error('No active tab');
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    throw new Error('Open a Flow project tab and reload it, then try again');
  }
}

function setRunning(running) {
  $('start').disabled = running;
  $('stop').disabled = !running;
}

async function refreshTabState() {
  const pill = $('tabState');
  try {
    const reply = await toTab({ type: 'PING' });
    const inProject = /\/project\//.test(reply.url);
    pill.textContent = reply.running ? 'running' : inProject ? 'Flow project' : 'Flow (open a project)';
    pill.className = `pill ${inProject ? 'ok' : ''}`;
    $('notOnFlow').hidden = true;
    setRunning(reply.running);
  } catch {
    pill.textContent = 'not on Flow';
    pill.className = 'pill bad';
    $('notOnFlow').hidden = false;
    setRunning(false);
  }
}

// ─── running ──────────────────────────────────────────────────

async function start() {
  try {
    const settings = readSettings();
    const items = imported.length ? imported.map((row) => buildItem(row, settings)) : parseLines().map((prompt) => buildItem({ prompt }, settings));
    if (!items.length) throw new Error('Add at least one prompt');

    const selectors = readSelectors();
    // Only the images some prompt names or mentions travel with the batch.
    const send = library.filter((image) => {
      const name = baseName(image.name).toLowerCase();
      return settings.attachAll || items.some((item) => item.prompt.toLowerCase().includes(name) || item.imageNames.some((n) => baseName(n).toLowerCase() === name));
    });

    await saveSettings();
    await chrome.storage.local.set({ selectors });

    const reply = await toTab({ type: 'START', items, settings, selectors, library: send });
    if (!reply?.ok) throw new Error(reply?.error || 'The tab did not start the batch');

    runItems = items;
    $('results').replaceChildren();
    setRunning(true);
    showLog(`Started ${items.length} prompt(s)`);
  } catch (err) {
    $('summary').textContent = err.message;
  }
}

const STATE_TEXT = {
  running: 'Running',
  finished: 'Finished',
  'finished-with-errors': 'Finished with errors',
  stopped: 'Stopped',
  error: 'Stopped on an error',
};

function render({ state, total, inFlight, results }) {
  const finished = results.filter((r) => r.status === 'done' || r.status === 'failed').length;
  $('barFill').style.width = `${total ? (finished / total) * 100 : 0}%`;
  $('summary').textContent = `${STATE_TEXT[state] || state} — ${finished}/${total}${state === 'running' ? `, ${inFlight} rendering` : ''}`;

  $('results').replaceChildren(
    ...results.filter((r) => r.status !== 'queued').map((r) => {
      const li = document.createElement('li');
      li.className = r.status;
      li.textContent = (runItems[r.index]?.prompt || `Prompt ${r.index + 1}`).slice(0, 70);
      const note = document.createElement('small');
      if (r.status === 'failed') note.textContent = `${r.error || 'failed'} (${r.attempts} attempt${r.attempts === 1 ? '' : 's'})`;
      else if (r.status === 'done') note.textContent = `${r.files?.length ?? 0} file(s)`;
      else note.textContent = r.status === 'rendering' && r.percent ? `rendering ${r.percent}%` : r.status;
      li.append(note);
      return li;
    }),
  );
  setRunning(state === 'running');
}

// ─── reading a frame for chaining ─────────────────────────────

const once = (target, event, ms = 20000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), ms);
    target.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true });
    target.addEventListener('error', () => (clearTimeout(timer), reject(new Error('Media failed to load'))), { once: true });
  });

function toJpeg(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(source, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.92);
}

// Fetched from here, not the page: an extension page may read Google's media
// hosts without CORS, and a canvas fed from it is not tainted.
async function frameOf(url, kind) {
  const blob = await (await fetch(url)).blob();
  if (kind === 'image') {
    const bitmap = await createImageBitmap(blob);
    try {
      return toJpeg(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = objectUrl;
    await once(video, 'loadedmetadata');
    video.currentTime = Math.max(0, (video.duration || 0) - 0.05);
    await once(video, 'seeked');
    return toJpeg(video, video.videoWidth, video.videoHeight);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'STATUS') render(msg.data);
  else if (msg?.type === 'LOG') showLog(msg.data.message, msg.data.level);
  else if (msg?.type === 'FETCH_FRAME') {
    frameOf(msg.url, msg.kind)
      .then((dataUrl) => reply({ ok: true, dataUrl }))
      .catch((err) => reply({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

// ─── tools ────────────────────────────────────────────────────

$('scanPage').addEventListener('click', async () => {
  try {
    const { scan } = await toTab({ type: 'SCAN_PAGE' });
    $('scanOutput').value = JSON.stringify(scan, null, 1);
  } catch (err) {
    $('scanOutput').value = err.message;
  }
});

$('copyScan').addEventListener('click', () => navigator.clipboard.writeText($('scanOutput').value).catch(() => {}));

$('saveSelectors').addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ selectors: readSelectors() });
    $('testOutput').textContent = 'Saved';
  } catch (err) {
    $('testOutput').textContent = err.message;
  }
});

$('resetSelectors').addEventListener('click', async () => {
  await chrome.storage.local.remove('selectors');
  $('selectors').value = JSON.stringify(FB.DEFAULT_SELECTORS, null, 2);
  $('testOutput').textContent = 'Reset to defaults';
});

$('testSelectors').addEventListener('click', async () => {
  try {
    const reply = await toTab({ type: 'TEST_SELECTORS', selectors: readSelectors() });
    $('testOutput').textContent = Object.entries(reply.counts).map(([name, count]) => `${name}: ${count}`).join('\n');
  } catch (err) {
    $('testOutput').textContent = err.message;
  }
});

$('scanCharacters').addEventListener('click', async () => {
  $('characterInfo').textContent = 'Scanning…';
  try {
    const reply = await toTab({ type: 'SCAN_CHARACTERS', selectors: readSelectors() });
    if (!reply.ok) throw new Error(reply.error);
    $('characterInfo').textContent = reply.names.length
      ? 'Click a name to add it to the prompts. A prompt that contains a name mentions that character.'
      : 'No characters found on this page.';
    $('characters').replaceChildren(
      ...reply.names.map((name) => {
        const chip = document.createElement('button');
        chip.textContent = name;
        chip.addEventListener('click', () => {
          const box = $('prompts');
          box.value += `${box.value && !box.value.endsWith('\n') ? ' ' : ''}${name}`;
          saveSettings();
          updateCount();
        });
        return chip;
      }),
    );
  } catch (err) {
    $('characterInfo').textContent = err.message;
  }
});

// ─── start-up ─────────────────────────────────────────────────

async function load() {
  fillSelect('mode', FB.MODES);
  fillSelect('model', FB.MODELS, 'Leave as is');
  fillSelect('aspectRatio', FB.RATIOS, 'Leave as is');
  fillSelect('videoLength', FB.LENGTHS.map((n) => [n, `${n}s`]), 'Leave as is');
  fillSelect('quality', FB.QUALITIES);

  const stored = await chrome.storage.local.get(['settings', 'selectors', 'library', 'queueText']);
  const settings = { ...FB.DEFAULT_SETTINGS, ...stored.settings };
  for (const id of SETTING_FIELDS) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!settings[id];
    else el.value = settings[id];
  }
  document.querySelector(`input[name="split"][value="${settings.split}"]`).checked = true;
  $('prompts').value = stored.queueText || '';
  $('selectors').value = JSON.stringify({ ...FB.DEFAULT_SELECTORS, ...stored.selectors }, null, 2);
  library = stored.library || [];
  renderLibrary();
  updateCount();
}

$('start').addEventListener('click', start);
$('stop').addEventListener('click', () => toTab({ type: 'STOP' }).catch(() => {}));

for (const id of [...SETTING_FIELDS, 'prompts']) $(id).addEventListener('input', () => (saveSettings(), updateCount()));
for (const el of document.querySelectorAll('input[name="split"]')) el.addEventListener('change', () => (saveSettings(), updateCount()));

chrome.tabs.onActivated.addListener(refreshTabState);
chrome.tabs.onUpdated.addListener((_id, change) => change.status === 'complete' && refreshTabState());

load().then(refreshTabState);
