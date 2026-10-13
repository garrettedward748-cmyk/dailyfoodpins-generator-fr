import sharp from 'sharp';

/**
 * The process-collage image: N still photographs laid into one grid, the
 * shape the reference brief asked for — a tidy wall of process shots with a
 * thin white gutter between cells, and the site's own address stamped twice
 * so a grid that gets re-shared still points back here.
 *
 * Kept deliberately simple next to the reel pipeline: a collage is a bonus
 * post, not the article itself, so there is no storyboard engine here, just
 * "how many columns for N images" and "paste them onto a canvas".
 */

/** One cell of the grid, after every photograph is made the same shape. */
const TILE_SIZE = 500;
/** Thin white gutter between cells, matching the reference image's look. */
const GUTTER = 6;

/**
 * Columns and rows for a grid of `count` cells, as close to square as it
 * gets. 6 -> 3x2, 9 -> 3x3, 12 -> 4x3: the three step counts Settings offers.
 * Any other count still lays out sensibly, it just may leave the last row
 * short.
 */
export function gridFor(count: number): { columns: number; rows: number } {
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  return { columns, rows };
}

/** One text label, as an SVG turned into a PNG sharp can composite. */
async function watermarkLayer(text: string, width: number): Promise<Buffer> {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const height = 40;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(0,0,0,0)" />
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
          font-family="sans-serif" font-size="22" font-weight="600"
          fill="rgba(255,255,255,0.78)" stroke="rgba(0,0,0,0.35)" stroke-width="0.5">${escaped}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export interface ComposeCollageOptions {
  /**
   * The text to stamp twice (near the top third and near the bottom), the
   * way the reference image repeats its brand name. Omitted, or empty,
   * means no watermark at all — the step itself decides that from
   * `collage_watermark`, this function just does what it is told.
   */
  watermark?: string;
}

/**
 * Lay the given image buffers into a square-ish grid and return one JPEG.
 *
 * Every tile is resized and cover-cropped to the same square size first, so
 * a portrait ingredients shot and a landscape overhead pan shot sit in the
 * grid the same size — exactly what the reference collage does.
 */
export async function composeCollage(images: Buffer[], options: ComposeCollageOptions = {}): Promise<Buffer> {
  if (images.length === 0) throw new Error('composeCollage needs at least one image.');

  const { columns, rows } = gridFor(images.length);
  const canvasWidth = columns * TILE_SIZE + (columns + 1) * GUTTER;
  const canvasHeight = rows * TILE_SIZE + (rows + 1) * GUTTER;

  const tiles = await Promise.all(
    images.map((buf) => sharp(buf).resize(TILE_SIZE, TILE_SIZE, { fit: 'cover' }).jpeg().toBuffer()),
  );

  const composites: { input: Buffer; left: number; top: number }[] = tiles.map((tile, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    return {
      input: tile,
      left: GUTTER + col * (TILE_SIZE + GUTTER),
      top: GUTTER + row * (TILE_SIZE + GUTTER),
    };
  });

  const watermark = options.watermark?.trim();
  if (watermark) {
    const layer = await watermarkLayer(watermark, canvasWidth);
    // Once near the top third, once near the bottom, as the reference image
    // does — a grid screenshot-shared without credit still carries the site.
    composites.push(
      { input: layer, left: 0, top: Math.round(canvasHeight / 3) - 20 },
      { input: layer, left: 0, top: canvasHeight - 60 },
    );
  }

  return sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(composites)
    .jpeg({ quality: 88 })
    .toBuffer();
}
