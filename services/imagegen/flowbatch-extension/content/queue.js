// The batch runner. Two loops share a job: one submits prompts (keeping at most
// `maxInFlight` rendering at once), the other watches each submitted prompt's
// tiles, saves the results and, for chained prompts, hands a frame on.
(() => {
  const FB = self.FlowBatch;
  const C = FB.core;

  const RECOVERY_KEY = 'FB_RECOVERY';
  const RECOVERY_MAX_AGE = 60 * 60 * 1000;

  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };

  // ─── reporting ──────────────────────────────────────────────

  function publish(job) {
    C.emit('STATUS', {
      state: job.state,
      total: job.items.length,
      inFlight: job.inFlight,
      results: job.results.map(({ index, status, attempts, files, sources, error, percent }) => ({ index, status, attempts, files, sources, error, percent })),
      // Which run this is, so a listener can tell its own batch from another.
      runId: job.runId || null,
    });
  }

  const resultFor = (job, index) => job.results.find((r) => r.index === index);

  // ─── recovery ───────────────────────────────────────────────

  async function saveRecovery(job) {
    const remaining = job.items.map((_, i) => i).filter((i) => !['done', 'failed'].includes(resultFor(job, i)?.status));
    await chrome.storage.local.set({
      [RECOVERY_KEY]: {
        at: Date.now(),
        runId: job.runId,
        items: job.items,
        settings: job.settings,
        selectors: job.selectors,
        results: job.results.filter((r) => r.status === 'done' || r.status === 'failed'),
        remaining,
      },
    });
  }

  const clearRecovery = () => chrome.storage.local.remove(RECOVERY_KEY).catch(() => {});

  // ─── one prompt ─────────────────────────────────────────────

  // Everything a prompt needs beyond its own text, resolved at the moment it runs.
  function prepare(job, index) {
    const base = job.items[index];
    const item = { ...base, images: [], extraImages: [] };

    if (base.chain && index > 0 && job.frames[index - 1]) {
      item.extraImages.push(job.frames[index - 1]);
      item.mode = FB.isVideoMode(job.items[index - 1].mode) ? 'imageToVideo' : 'imageToImage';
    }
    item.images = FB.generate.imagesFor(
      { ...item, imageNames: base.imageNames || [], attachAll: base.attachAll, maxImages: job.settings.maxImagesPerPrompt },
      job.library,
    );
    return item;
  }

  async function submitOne(job, index) {
    const result = resultFor(job, index);
    for (;;) {
      result.attempts += 1;
      result.status = 'submitting';
      publish(job);

      // A chained prompt starts from the previous one's finished output.
      if (job.items[index].chain && index > 0) await job.done[index - 1].promise;
      C.throwIfCancelled();

      try {
        const item = prepare(job, index);
        const tiles = await C.withUi(() => FB.generate.startPrompt(item));
        result.status = 'rendering';
        result.item = item;
        job.inFlight += 1;
        job.watchQueue.push({ index, tiles, item });
        C.log('info', `#${index + 1} submitted (${tiles.length} tile${tiles.length === 1 ? '' : 's'})`);
        publish(job);
        return;
      } catch (err) {
        if (err instanceof C.Cancelled) throw err;
        result.error = err.message;
        C.log('warn', `#${index + 1} attempt ${result.attempts}: ${err.message}`);
        if (result.attempts > job.settings.retries) {
          result.status = 'failed';
          job.done[index].resolve(null);
          publish(job);
          return;
        }
        await C.wait(3000);
      }
    }
  }

  async function submitLoop(job) {
    for (const index of job.pending) {
      C.throwIfCancelled();
      while (job.inFlight >= job.settings.maxInFlight) await C.wait(500);

      if (job.submitted > 0) {
        const seconds = C.between(job.settings.delayMin, job.settings.delayMax);
        C.log('info', `Waiting ${seconds.toFixed(0)}s before the next prompt`);
        await C.wait(seconds * 1000);
      }
      job.submitted += 1;
      await submitOne(job, index);
    }
    job.submitDone = true;
  }

  // ─── watching ───────────────────────────────────────────────

  async function watchOne(job, entry) {
    const { index, tiles, item } = entry;
    const result = resultFor(job, index);
    try {
      const ready = await FB.download.waitForTiles(tiles, item, (percent) => {
        result.percent = percent;
        publish(job);
      });
      // Where each finished result is served from: the agent bridge matches
      // these against the project listing to know which media is this prompt's.
      result.sources = ready.map((tile) => FB.tiles.resourceOf(tile)?.src).filter(Boolean);
      result.files = await C.withUi(() => FB.download.saveTiles(ready, item, index));

      if (job.items[index + 1]?.chain) {
        const frame = await FB.download.frameFrom(ready[0]);
        if (frame) job.frames[index] = frame;
      }
      result.status = 'done';
      delete result.error;
      C.log('info', `#${index + 1} done`);
    } catch (err) {
      if (err instanceof C.Cancelled) throw err;
      result.error = err.message;
      C.log('warn', `#${index + 1}: ${err.message}`);

      if (err.reload) {
        // Every tile failed with no message from Flow: a reload usually clears it.
        job.inFlight -= 1;
        job.pending.length = 0;
        result.status = 'queued';
        await saveRecovery(job);
        C.log('info', 'Reloading the page and resuming');
        location.reload();
        await new Promise(() => {});
      }
      result.status = 'failed';
    }
    job.inFlight -= 1;
    job.done[index].resolve(job.frames[index] || null);
    publish(job);
  }

  async function watchLoop(job) {
    for (;;) {
      C.throwIfCancelled();
      const entry = job.watchQueue.shift();
      if (entry) {
        await watchOne(job, entry);
        continue;
      }
      if (job.submitDone && job.inFlight === 0) return;
      await C.wait(500);
    }
  }

  // ─── the job ────────────────────────────────────────────────

  async function run(job) {
    try {
      if (job.settings.zoomOut) await C.ask({ type: 'FIT_ZOOM', cssWidth: 1000, innerWidth: window.innerWidth }).catch(() => {});
      await Promise.all([submitLoop(job), watchLoop(job)]);
      await clearRecovery();
      job.state = job.results.some((r) => r.status === 'failed') ? 'finished-with-errors' : 'finished';
    } catch (err) {
      if (err instanceof C.Cancelled) {
        for (const r of job.results) if (['submitting', 'rendering', 'queued'].includes(r.status)) r.status = 'stopped';
        job.state = 'stopped';
      } else {
        job.state = 'error';
        C.log('error', err.message);
      }
    }
    await C.ask({ type: 'RESTORE_ZOOM' }).catch(() => {});
    await C.ask({ type: 'DETACH' }).catch(() => {});
    publish(job);
  }

  function create({ items, settings, selectors, library, resumeIndexes, doneResults, runId }) {
    const job = {
      runId: runId || null,
      items,
      settings,
      selectors,
      library,
      state: 'running',
      cancelled: false,
      results: items.map((_, index) => ({ index, status: 'queued', attempts: 0 })),
      pending: resumeIndexes || items.map((_, i) => i),
      watchQueue: [],
      frames: [],
      done: items.map(() => deferred()),
      inFlight: 0,
      submitted: 0,
      submitDone: false,
    };
    for (const prior of doneResults || []) {
      Object.assign(resultFor(job, prior.index), prior);
      job.done[prior.index].resolve(null);
    }
    C.state.job = job;
    FB.resetConfigured();
    return job;
  }

  function start(spec) {
    const job = create(spec);
    publish(job);
    run(job);
    return job;
  }

  // Pick up a batch that reloaded the page on purpose.
  async function resumeIfAny() {
    const stored = (await chrome.storage.local.get([RECOVERY_KEY, 'library']))[RECOVERY_KEY];
    if (!stored) return;
    await clearRecovery();
    if (Date.now() - stored.at > RECOVERY_MAX_AGE || !stored.remaining.length) return;

    const library = (await chrome.storage.local.get('library')).library || [];
    await C.sleep(3000);
    C.log('info', `Resuming ${stored.remaining.length} prompt(s) after the reload`);
    start({
      items: stored.items,
      settings: stored.settings,
      selectors: stored.selectors,
      library,
      resumeIndexes: stored.remaining,
      doneResults: stored.results,
      runId: stored.runId,
    });
  }

  FB.queue = { start, resumeIfAny };
})();
