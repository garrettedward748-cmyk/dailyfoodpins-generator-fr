// The results grid. A "tile" is one generation slot: a placeholder with a
// percentage while it renders, then a video or image. With `outputItems` set
// the page's own tile elements are used; without it, tiles are derived from the
// media and percentage text on screen.
(() => {
  const FB = self.FlowBatch;
  const C = FB.core;

  const percentRe = () => {
    try {
      return new RegExp(C.selectors().progressText);
    } catch {
      return /^\d{1,3}%$/;
    }
  };

  const isMedia = (el) => el.matches?.('video, img');

  const mediaIn = (tile) => {
    const s = C.selectors();
    const videos = C.findAll(s.outputVideo, tile).filter((el) => el.currentSrc || el.src);
    // Small on purpose: a portrait result in a narrow grid is under 100px wide.
    const images = C.findAll(s.outputImage, tile).filter((el) => {
      const r = el.getBoundingClientRect();
      return (el.currentSrc || el.src) && r.width >= 40 && r.height >= 40;
    });
    return { videos, images };
  };

  // The largest ancestor of `el` that holds no other tile's content.
  function climb(el, stopsAt) {
    let node = el;
    while (node.parentElement && node.parentElement !== stopsAt) {
      const parent = node.parentElement;
      const rival = [...parent.querySelectorAll('video, img')].filter((m) => !node.contains(m) && m.getBoundingClientRect().width >= 120);
      const rivalPct = [...parent.querySelectorAll('div,span')].filter(
        (p) => !node.contains(p) && p.childElementCount === 0 && percentRe().test(p.textContent.trim()),
      );
      if (rival.length || rivalPct.length || parent === document.body) break;
      node = parent;
    }
    return node;
  }

  function listTiles() {
    const s = C.selectors();
    if (s.outputItems) return C.findAll(s.outputItems);

    const seeds = [];
    for (const el of document.querySelectorAll('video, img')) {
      const r = el.getBoundingClientRect();
      if ((el.currentSrc || el.src) && r.width >= 120 && r.height >= 60 && C.isVisible(el)) seeds.push(el);
    }
    for (const el of document.querySelectorAll('div,span')) {
      if (el.childElementCount === 0 && percentRe().test(el.textContent.trim()) && C.isVisible(el)) seeds.push(el);
    }

    const tiles = [];
    for (const seed of seeds) {
      const tile = climb(seed);
      if (!tiles.includes(tile)) tiles.push(tile);
    }
    return tiles.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  function tileState(tile) {
    const { videos, images } = mediaIn(tile);
    const leaves = [...tile.querySelectorAll('div,span')].filter(
      (el) => el.childElementCount === 0 && percentRe().test(el.textContent.trim()),
    );
    const queued = C.findAll(C.selectors().tileOnQueue, tile).length > 0;
    const percent = leaves.length ? parseInt(leaves[0].textContent, 10) : 0;
    const hasResource = videos.length > 0 || images.length > 0;
    return {
      videos,
      images,
      hasResource,
      generating: leaves.length > 0 || queued || !hasResource,
      percent: hasResource ? 100 : percent,
    };
  }

  // A tile's result, preferring video. A video tile shows only a thumbnail
  // until its <video> loads, and the thumbnail's address is a picture, not the
  // clip: then `src` is null and the clip can only be saved through the tile menu.
  const resourceOf = (tile) => {
    const { videos, images } = mediaIn(tile);
    const video = videos.find((el) => el.tagName === 'VIDEO') || videos[0];
    if (video) {
      const playable = video.tagName === 'VIDEO';
      return { src: playable ? video.currentSrc || video.src : null, kind: 'video', thumbnail: playable ? null : video.src, el: video };
    }
    const image = images[0];
    return image ? { src: image.currentSrc || image.src, kind: 'image', el: image } : null;
  };

  // Is anything on the page still rendering?
  const anyGenerating = () => listTiles().some((tile) => tileState(tile).generating);

  FB.tiles = { listTiles, tileState, resourceOf, anyGenerating, isMedia };
})();
