// Waiting for a prompt's tiles to finish, then saving what they produced:
// the file Flow serves, or an upscaled copy through the tile's own menu.
(() => {
  const FB = self.FlowBatch;
  const C = FB.core;

  const slug = (text) =>
    text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'prompt';

  // Poll until every tile is a result or has been judged failed. Returns the
  // tiles that produced something.
  async function waitForTiles(tiles, item, onProgress) {
    const s = C.selectors();
    const deadline = Date.now() + C.settings().timeoutMinutes * 60000;
    const errorRe = new RegExp(s.errorText, 'i');
    let idleRounds = new Map();

    while (Date.now() < deadline) {
      await C.wait(2000);

      const pageProblem = C.findAll(s.errorContainer).map((el) => el.textContent.trim()).find((text) => text && errorRe.test(text));
      const states = tiles.map((tile) => (tile.isConnected ? FB.tiles.tileState(tile) : null));
      if (states.some((state) => !state)) throw new Error('A result tile left the page (Flow re-rendered the grid)');

      let failed = 0;
      states.forEach((state, i) => {
        // No percentage and no media for several rounds: Flow dropped the tile.
        const idle = !state.hasResource && state.percent === 0 && !C.findAll(s.tileOnQueue, tiles[i]).length;
        idleRounds.set(i, idle ? (idleRounds.get(i) || 0) + 1 : 0);
        if (idleRounds.get(i) >= 15) failed += 1;
      });

      const ready = states.filter((state) => state.hasResource).length;
      onProgress(Math.round(states.reduce((sum, state) => sum + state.percent, 0) / states.length));

      if (ready + failed >= tiles.length) {
        if (ready === 0) throw Object.assign(new Error(pageProblem ? `Flow reported: ${pageProblem.slice(0, 160)}` : 'Every tile failed'), { reload: !pageProblem });
        return tiles.filter((_, i) => states[i].hasResource);
      }
      if (pageProblem && ready === 0 && !FB.tiles.anyGenerating()) throw new Error(`Flow reported: ${pageProblem.slice(0, 160)}`);
    }
    throw new Error(`Nothing finished within ${C.settings().timeoutMinutes} minutes`);
  }

  const QUALITY_KEY = {
    original: 'qualityOriginalOption',
    720: 'quality720Option',
    1080: 'quality1080Option',
    '2k': 'quality2KOption',
    '4k': 'quality4KOption',
  };

  // Download one tile through its hover menu at a chosen quality.
  async function downloadViaMenu(tile, quality, retries) {
    const s = C.selectors();
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // Hovering raises a hotbar; it may sit outside the tile's own element.
        await C.hover(tile);
        const more =
          C.find(s.moreOptionsButtonInHoverTile, tile) ||
          (await C.waitFor(s.moreOptionsButtonInHoverTile, 3000, 'the tile menu button'));
        await C.click(more, 'the tile menu');
        await C.click(await C.waitFor(s.downloadButtonInHoverTile, 4000, 'the download entry'), 'the download entry');

        const option = await C.waitFor(s[QUALITY_KEY[quality]], 4000, `the ${quality} option`);
        if (C.isDisabled(option)) {
          // 4K shows as disabled with an Upgrade prompt on plans without it.
          throw Object.assign(new Error(`The ${quality} option is disabled for this account`), { permanent: true });
        }
        await C.click(option, `${quality} option`);
        return;
      } catch (err) {
        if (err instanceof C.Cancelled) throw err;
        lastError = err;
        C.log('warn', `Menu download attempt ${attempt}/${retries} failed: ${err.message}`);
        await C.pressKey('Escape').catch(() => {});
        await C.pressKey('Escape').catch(() => {});
        if (err.permanent) break;
        await C.wait(1000);
      }
    }
    throw lastError;
  }

  function saveInPage(src, name) {
    const a = document.createElement('a');
    a.href = src;
    a.download = name.split('/').pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Save a prompt's finished tiles. Returns the file names started.
  async function saveTiles(tiles, item, index) {
    const settings = C.settings();
    const quality = item.quality;
    if (quality === 'none') return [];

    const folder = settings.folder.replace(/^\/+|\/+$/g, '');
    const base = `${settings.prefix}${String(index + 1).padStart(3, '0')}_${slug(item.prompt)}`;
    const files = [];

    // Through the tile's own menu. "Original size" is the real file; the other
    // entries are Flow's upscales. If the menu cannot be driven, "original"
    // can still fall back to the address on the page.
    const direct = [];
    if (settings.autoRename) await C.ask({ type: 'SET_NAMING', folder, base, many: tiles.length > 1 });
    try {
      for (let i = 0; i < tiles.length; i++) {
        try {
          await downloadViaMenu(tiles[i], quality, 3);
          files.push(`${base}${tiles.length > 1 ? `_${String.fromCharCode(97 + i)}` : ''} (${quality})`);
          await C.wait(800);
        } catch (err) {
          if (err instanceof C.Cancelled || quality !== 'original' || err.permanent) throw err;
          C.log('warn', `Tile ${i + 1}: menu download failed, trying the file address instead`);
          direct.push(i);
        }
      }
    } finally {
      // Keep the rename rule a while: the browser names a download after it starts.
      setTimeout(() => chrome.runtime.sendMessage({ type: 'CLEAR_NAMING', base }).catch(() => {}), 60000);
    }

    for (const i of direct) {
      const resource = FB.tiles.resourceOf(tiles[i]);
      if (!resource) continue;
      if (!resource.src) throw new Error('Could not download through the tile menu, and the tile exposes no file address');
      const ext = resource.kind === 'video' ? 'mp4' : 'png';
      const name = settings.autoRename
        ? `${folder ? `${folder}/` : ''}${base}${tiles.length > 1 ? `_${String.fromCharCode(97 + i)}` : ''}.${ext}`
        : `${folder ? `${folder}/` : ''}${resource.src.split('/').pop().split('?')[0] || `${base}.${ext}`}`;
      if (/^https?:/i.test(resource.src)) await C.ask({ type: 'DOWNLOAD', url: resource.src, filename: name });
      else saveInPage(resource.src, name);
      files.push(name);
      await C.wait(400);
    }
    return files;
  }

  // For chaining: the picture the next prompt should start from. A video gives
  // its last frame and an image gives itself; the side panel (an extension page
  // allowed to read Google's media hosts) does the decoding.
  async function frameFrom(tile) {
    const resource = FB.tiles.resourceOf(tile);
    if (!resource) return null;
    // A video still showing only its thumbnail gives that picture: the first
    // frame, not the last, so say so.
    const url = resource.src || resource.thumbnail;
    if (!/^https?:/i.test(url || '')) return null;
    if (!resource.src) C.log('warn', 'Chaining from a video thumbnail (its first frame), not the last frame');
    const reply = await chrome.runtime.sendMessage({ type: 'FETCH_FRAME', url, kind: resource.src ? resource.kind : 'image' });
    if (!reply?.ok) {
      C.log('warn', `Could not read a frame for chaining${reply?.error ? `: ${reply.error}` : ' (is the side panel open?)'}`);
      return null;
    }
    return { name: `frame-${Date.now()}.jpg`, dataUrl: reply.dataUrl };
  }

  FB.download = { waitForTiles, saveTiles, frameFrom, slug };
})();
