// Entry point: answers the side panel and resumes a batch that reloaded the page.
(() => {
  const FB = self.FlowBatch;
  const C = FB.core;
  if (FB.mainLoaded) return;
  FB.mainLoaded = true;

  // How many elements each selector finds right now. Templates are skipped
  // because they need a value to mean anything.
  function countSelectors(selectors) {
    const counts = {};
    for (const [name, selector] of Object.entries(selectors)) {
      if (!selector || name === 'progressText' || name === 'errorText' || /\{\w+\}/.test(selector)) continue;
      counts[name] = C.findAll(selector).length;
    }
    counts.tiles = FB.tiles.listTiles().length;
    counts.generatingNow = FB.tiles.anyGenerating();
    return counts;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg?.type) {
      case 'PING':
        reply({ ok: true, url: location.href, running: C.state.job?.state === 'running' });
        return false;

      case 'TEST_SELECTORS':
        C.state.scanSelectors = msg.selectors;
        try {
          reply({ ok: true, counts: countSelectors(msg.selectors) });
        } finally {
          C.state.scanSelectors = null;
        }
        return false;

      case 'SCAN_PAGE':
        reply({ ok: true, scan: FB.scanPage() });
        return false;

      case 'SCAN_CHARACTERS':
        FB.scanCharacters(msg.selectors)
          .then((names) => reply({ ok: true, names }))
          .catch((err) => reply({ ok: false, error: err.message }));
        return true;

      case 'START':
        if (C.state.job?.state === 'running') {
          reply({ ok: false, error: 'A batch is already running in this tab' });
          return false;
        }
        FB.queue.start({ items: msg.items, settings: msg.settings, selectors: msg.selectors, library: msg.library || [], runId: msg.runId });
        reply({ ok: true });
        return false;

      case 'STOP':
        if (C.state.job) C.state.job.cancelled = true;
        reply({ ok: true });
        return false;

      default:
        return false;
    }
  });

  FB.queue.resumeIfAny().catch(() => {});
})();
