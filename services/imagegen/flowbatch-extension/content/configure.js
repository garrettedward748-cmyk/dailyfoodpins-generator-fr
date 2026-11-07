// Putting Flow's settings menu into the state a prompt asks for: mode, aspect
// ratio, number of results, model and clip length. The menu is only opened
// when a value differs from what is already set, and a radio that already
// reports aria-checked is left alone.
(() => {
  const FB = self.FlowBatch;
  const C = FB.core;

  // What this job has put (or found) on the page. Cleared on a page reload.
  let applied = {};
  FB.resetConfigured = () => {
    applied = {};
  };

  const MODE_OPTION = {
    textToVideo: 'textToVideoModeOption',
    imageToVideo: 'imageToVideoModeOption',
    componentsToVideo: 'componentToVideoModeOption',
  };

  // The chip names some ratios by shape rather than by number.
  const RATIO_WORDS = { landscape: '4:3', square: '1:1', portrait: '3:4' };

  const isChecked = (el) => el.getAttribute('aria-checked') === 'true';

  // Select a templated option unless it is already selected. Returns whether
  // the page now has it; a miss is reported but does not stop the batch.
  async function pick(template, values, what) {
    const selector = C.fill(template, values);
    const option = C.find(selector) || (await C.waitFor(selector, 3000, what).catch(() => null));
    if (!option) {
      C.log('warn', `Could not find ${what}`);
      return false;
    }
    if (isChecked(option)) return true;
    await C.click(option, what);
    return true;
  }

  // The trigger chip spells out the current setup, e.g. "🍌 Nano Banana 2.1
  // crop_16_9 x2". Take what it says as already applied.
  function seedFromTrigger() {
    const trigger = C.find(C.selectors().configButton);
    if (!trigger) return;
    const text = C.textOf(trigger);

    const ratio = text.match(/crop_(\d+)_(\d+)/);
    const word = text.match(/crop_(landscape|square|portrait)/);
    const count = text.match(/\bx(\d+)\b/);
    // Image mode names the model ("Nano Banana 2.1 crop_9_16 x4"); video mode
    // names the clip instead ("Video · 720p · 8s crop_9_16 x4").
    const video = text.match(/^Video\b.*?(\d+)s\b/);
    const model = video ? '' : text.replace(/crop_.*$/, '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (video && applied.videoLength === undefined) applied.videoLength = video[1];

    if (applied.aspectRatio === undefined) {
      if (ratio) applied.aspectRatio = `${ratio[1]}:${ratio[2]}`;
      else if (word) applied.aspectRatio = RATIO_WORDS[word[1]];
    }
    if (count && applied.outputCount === undefined) applied.outputCount = count[1];
    if (model && applied.model === undefined) applied.model = model;
  }

  // Any open popover counts as the menu: Flow's menus are popper or dialog
  // layers. The Image/Video radios are matched by English text, so with Flow
  // in another language, or after a redesign, the menu can be open with them
  // unrecognised -- each setting below then warns on its own and the prompt
  // still goes out, rather than the whole job failing here.
  const LAYERS = '[role="menu"], [role="dialog"], [role="listbox"], [data-radix-popper-content-wrapper]';
  const layerOpen = () => [...document.querySelectorAll(LAYERS)].some(C.isVisible);

  // What the page shows a person, short: for an error that has to say why.
  function describe(s) {
    const trigger = C.find(s.configButton);
    const inLayers = [...document.querySelectorAll(LAYERS)]
      .filter(C.isVisible)
      .flatMap((layer) => [...layer.querySelectorAll('button, [role="radio"], [role="tab"], [role="menuitem"], [role="option"]')])
      .filter(C.isVisible)
      .map((el) => C.labelOf(el).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 15);
    return [
      `button: "${trigger ? C.textOf(trigger).replace(/\s+/g, ' ').trim().slice(0, 60) : 'not found'}"`,
      `page ${window.innerWidth}x${window.innerHeight}`,
      `zoom ${window.devicePixelRatio}`,
      document.hasFocus() ? 'focused' : 'not focused',
      inLayers.length ? `open menu shows: ${inLayers.join(' | ')}` : 'no menu layer on the page',
    ].join('; ');
  }

  // The first click can land while another overlay is still closing, or
  // before a page that has just loaded answers clicks. The menu is open once
  // its radios exist (or any menu layer does); if not, click again -- after a
  // look, since a second click on an open menu would close it.
  async function openMenu(s) {
    const isOpen = () => C.find(s.selectImageMode) || C.find(s.selectVideoMode);
    if (isOpen()) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      await C.clickSelector(s.configButton, 'the settings button');
      for (let i = 0; i < 12; i++) {
        if (isOpen()) return;
        await C.wait(250);
      }
      if (layerOpen()) {
        C.log('warn', `Settings menu open but its Image/Video choices were not recognised (${describe(s)})`);
        return;
      }
      await C.pressKey('Escape').catch(() => {});
      await C.wait(1000 + attempt * 1000);
    }
    throw new Error(`The settings menu did not open (${describe(s)})`);
  }

  async function configure(item) {
    const s = C.selectors();
    seedFromTrigger();
    const wanted = {
      mode: item.mode,
      aspectRatio: item.aspectRatio,
      outputCount: item.outputCount,
      model: item.model,
      videoLength: FB.isVideoMode(item.mode) ? item.videoLength : '',
    };

    const changed = Object.keys(wanted).filter((key) => wanted[key] && applied[key] !== String(wanted[key]));
    if (!changed.length) return;

    await openMenu(s);

    const done = {};

    if (changed.includes('mode')) {
      const group = FB.isVideoMode(item.mode) ? s.selectVideoMode : s.selectImageMode;
      const radio = C.find(group);
      if (radio) {
        if (!isChecked(radio)) await C.click(radio, 'the output type');
        await C.wait(400);
        const option = MODE_OPTION[item.mode];
        const sub = option && C.find(s[option]);
        if (sub && !isChecked(sub)) await C.click(sub, 'the mode option');
        done.mode = true;
      } else C.log('warn', 'Could not find the output type switch');
    }
    if (changed.includes('aspectRatio')) {
      done.aspectRatio = await pick(s.aspectRatioTemplate, { aspectRatio: item.aspectRatio }, `aspect ratio ${item.aspectRatio}`);
    }
    if (changed.includes('outputCount')) {
      done.outputCount = await pick(s.outputCountTemplate, { outputCount: item.outputCount }, `output count ${item.outputCount}`);
    }
    if (changed.includes('model')) {
      const picker = C.find(s.modelSelectButton);
      if (picker) {
        await C.click(picker, 'the model picker');
        await C.wait(400);
        done.model = await pick(s.modelTemplate, { model: item.model }, `model ${item.model}`);
      } else C.log('warn', 'Could not find the model picker');
    }
    if (changed.includes('videoLength')) {
      done.videoLength = await pick(s.videoLengthTemplate, { videoLength: item.videoLength }, `clip length ${item.videoLength}s`);
    }

    // The chip has no open/closed state to click; Escape closes the overlay.
    await C.pressKey('Escape').catch(() => {});
    await C.wait(600);

    for (const key of changed) if (done[key]) applied[key] = String(wanted[key]);
  }

  FB.configure = configure;
})();
