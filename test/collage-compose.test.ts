import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { composeCollage, gridFor } from '../src/collage/compose.js';

/** A small solid-colour JPEG, standing in for a generated step photograph. */
function swatch(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 60, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
}

describe('gridFor', () => {
  it('lays out the three step counts Settings offers as near-square grids', () => {
    expect(gridFor(6)).toEqual({ columns: 3, rows: 2 });
    expect(gridFor(9)).toEqual({ columns: 3, rows: 3 });
    expect(gridFor(12)).toEqual({ columns: 4, rows: 3 });
  });
});

describe('composeCollage', () => {
  it('produces one JPEG sized for the grid, with no watermark by default', async () => {
    const images = await Promise.all([
      swatch({ r: 255, g: 0, b: 0 }),
      swatch({ r: 0, g: 255, b: 0 }),
      swatch({ r: 0, g: 0, b: 255 }),
      swatch({ r: 255, g: 255, b: 0 }),
      swatch({ r: 0, g: 255, b: 255 }),
      swatch({ r: 255, g: 0, b: 255 }),
    ]);
    const out = await composeCollage(images);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    // 3 columns x 500px tiles + 4 gutters of 6px = 1524; 2 rows + 3 gutters = 1018.
    expect(meta.width).toBe(1524);
    expect(meta.height).toBe(1018);
  });

  it('only composites a watermark layer when one is asked for', async () => {
    const images = await Promise.all([
      swatch({ r: 10, g: 10, b: 10 }),
      swatch({ r: 20, g: 20, b: 20 }),
      swatch({ r: 30, g: 30, b: 30 }),
    ]);

    const plain = await composeCollage(images);
    const marked = await composeCollage(images, { watermark: 'example.com' });

    // Same canvas size either way; the watermark changes pixels, not shape.
    const plainMeta = await sharp(plain).metadata();
    const markedMeta = await sharp(marked).metadata();
    expect(markedMeta.width).toBe(plainMeta.width);
    expect(markedMeta.height).toBe(plainMeta.height);
    expect(marked.equals(plain)).toBe(false);

    const blank = await composeCollage(images, { watermark: '   ' });
    expect(blank.equals(plain)).toBe(true);
  });

  it('refuses an empty image list', async () => {
    await expect(composeCollage([])).rejects.toThrow();
  });
});
