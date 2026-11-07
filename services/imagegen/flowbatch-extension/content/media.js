// Reference media: uploading an image (or reusing one already in Flow's
// library), mentioning it or a character inside the prompt, and scanning for
// the account's characters.
(() => {
  const FB = self.FlowBatch;
  const C = FB.core;

  const baseName = (name) => name.replace(/\.[^/.]+$/, '');
  const isVideoFile = (image) => /^data:video\//.test(image.dataUrl) || /\.(mp4|webm|mov|avi|mkv|3gp|flv|wmv)$/i.test(image.name);

  // Search the open picker for a file by name and click the first hit.
  async function searchAndSelect(name, settleMs = 500) {
    const s = C.selectors();
    const input = C.find(s.searchUploadedImage);
    if (input) {
      await C.click(input, 'the media search box');
      C.setInputValue(input, name);
      await C.wait(settleMs);
    }
    // The list refreshes a moment after typing; give it a few seconds before
    // deciding the file is not there (and uploading it again).
    let hit = null;
    for (let i = 0; i < 8 && !hit; i++) {
      hit = C.find(C.fill(s.firstFoundedItemSelector, { filename: name }));
      if (!hit) await C.wait(500);
    }
    if (!hit) return false;
    return pickItem(hit, name);
  }

  const chipCount = () => C.findAll(C.selectors().ingredientChip).length;

  // Click a library row and confirm it attached: an ingredient chip appears.
  async function pickItem(hit, name) {
    const before = chipCount();
    await C.click(hit, `library item ${name}`);
    for (let i = 0; i < 16; i++) {
      if (chipCount() > before) return true;
      await C.wait(250);
    }
    C.log('warn', `Clicked "${name}" but no ingredient was added`);
    return false;
  }

  async function openPicker(image) {
    const s = C.selectors();
    // A first click can land while another menu is closing and only raise a
    // tooltip. Confirm the menu opened (its search box is there), else click again.
    // aria-expanded says whether it is open: clicking an open menu would close it.
    const expanded = () => C.find(s.addImageButton)?.getAttribute('aria-expanded') === 'true';
    if (!expanded()) await C.clickSelector(s.addImageButton, 'the add-media button');
    const opened = await C.waitFor(s.searchUploadedImage, 3000, 'the media search box').then(() => true, () => false);
    if (!opened) {
      if (!expanded()) await C.clickSelector(s.addImageButton, 'the add-media button (retry)');
      await C.waitFor(s.searchUploadedImage, 6000, 'the media search box');
    }
    // Wide layout has category tabs; the narrow dialog has none, and "All" still
    // finds a file by name, so a missing tab is fine.
    await C.clickIfPresent(isVideoFile(image) ? s.selectUploadVideoType : s.selectUploadImageType, 'the media type');
    if (await C.clickIfPresent(s.sortOptionsButton, 'the sort menu')) {
      await C.clickIfPresent(s.sortLatestOption, 'the "latest" sort');
    }
  }

  // Attach `image` ({ name, dataUrl }) as a reference. Reuses an upload of the
  // same name that is already in the library.
  async function attachImage(image) {
    const s = C.selectors();
    const name = baseName(image.name);

    const startChips = chipCount();
    document.documentElement.setAttribute('data-fb-upload', 'true');
    try {
      await openPicker(image);
      if (await searchAndSelect(name)) return true;

      await C.clickSelector(s.uploadMediaButton, 'the upload button');
      const mime = (image.dataUrl.match(/^data:([^;]+);/) || [])[1] || 'image/jpeg';
      document.dispatchEvent(new CustomEvent('FB_UPLOAD_FILE', { detail: { dataUrl: image.dataUrl, filename: image.name, mimeType: mime } }));
      await C.wait(2000);

      // Videos ask for consent the first time; accepting closes the picker.
      if (await C.clickIfPresent(s.agreeTermUploadedVideoButton, 'the upload terms')) {
        await C.wait(1000);
        await openPicker(image);
      }

      const limit = 180;
      for (let waited = 0; waited < limit; waited++) {
        await C.wait(1000);
        if (chipCount() > startChips) return true; // Flow attached the new file itself
        const hit = C.find(C.fill(s.firstFoundedItemSelector, { filename: name }));
        if (hit) return pickItem(hit, name);
        if (waited % 10 === 9) C.log('info', `Waiting for "${name}" to finish uploading (${waited + 1}s)`);
      }
      return false;
    } finally {
      document.documentElement.removeAttribute('data-fb-upload');
    }
  }

  // ─── mentions ───────────────────────────────────────────────

  // Where `names` occur in `text`, longest first, no overlaps. Case-folded
  // only where folding keeps the length (a few scripts change it).
  const fold = (text) => Array.from(text, (ch) => (ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch)).join('');

  function findMentions(text, names) {
    const haystack = fold(text);
    const spans = [];
    names.forEach((name, nameIndex) => {
      const needle = fold(name);
      if (!needle) return;
      for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
        spans.push({ index: at, length: needle.length, nameIndex });
      }
    });
    spans.sort((a, b) => a.index - b.index || b.length - a.length);

    const kept = [];
    let end = 0;
    for (const span of spans) {
      if (span.index < end) continue;
      kept.push(span);
      end = span.index + span.length;
    }
    return kept;
  }

  // Type "@" in the composer. Flow opens the same asset picker as the "+" button
  // with its search box ready; choosing a row puts a mention chip in the prompt
  // and attaches the ingredient (mentioning one that is already attached adds
  // no second ingredient). Works for characters too: they are in the "All" list.
  async function mention(name, kind) {
    const s = C.selectors();
    const mentions = () => C.findAll(s.mentionChip).length;
    const before = mentions();

    await C.pressKey('@');
    const input = await C.waitFor(s.searchUploadedImage, 5000, 'the mention search box');
    await C.click(input, 'the mention search box');
    C.setInputValue(input, name);

    let hit = null;
    for (let i = 0; i < 8 && !hit; i++) {
      await C.wait(500);
      hit = C.find(C.fill(s.firstFoundedItemSelector, { filename: name }));
    }
    if (!hit) {
      C.log('warn', `No library match for @${name} (${kind})`);
      // Close the picker and drop the "@" it was opened with.
      await C.pressKey('Escape');
      await C.wait(300);
      await C.pressKey('Backspace');
      return false;
    }

    await C.click(hit, `mention ${name}`);
    for (let i = 0; i < 12; i++) {
      if (mentions() > before) return true;
      await C.wait(250);
    }
    C.log('warn', `Selected "${name}" but no mention appeared`);
    return false;
  }

  FB.media = { attachImage, findMentions, mention, baseName, isVideoFile };

  // ─── characters ─────────────────────────────────────────────

  // The names under Flow's Characters tab, or none if the page has no such tab.
  FB.scanCharacters = async (selectors) => {
    C.state.scanSelectors = selectors;
    try {
      const tab = C.find(selectors.charactersTabButton);
      if (!tab) return [];
      await C.click(tab, 'the Characters tab');
      await C.waitFor(selectors.charactersNameSelector, 5000, 'the character list');
      const names = C.findAll(selectors.charactersNameSelector).map(
        (el) => el.getAttribute('alt') || el.getAttribute('data-name') || C.textOf(el),
      );
      return [...new Set(names.filter(Boolean))];
    } finally {
      C.state.scanSelectors = null;
      await C.ask({ type: 'DETACH' }).catch(() => {});
    }
  };
})();
