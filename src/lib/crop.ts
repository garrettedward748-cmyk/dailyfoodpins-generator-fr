import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A tall image cut to Facebook's 4:5 feed shape (1080x1350).
 *
 * 'center' for a photo -- the dish sits in the middle of the frame, so the
 * window is taken from there. 'top' for the pin graphic, whose title sits in
 * its upper third. An image already wider than 4:5 is only scaled.
 */
export async function cropForFacebookFeed(image: Buffer, anchor: 'center' | 'top' = 'center'): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'fbcrop-'));
  try {
    const input = join(dir, 'in');
    const output = join(dir, 'out.jpg');
    await writeFile(input, image);
    await run('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', input,
      '-vf',
      anchor === 'top'
        ? "crop=iw:'min(ih,iw*5/4)':0:0,scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350:0:0"
        : "crop=iw:'min(ih,iw*5/4)',scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350",
      '-frames:v', '1', '-q:v', '3', output,
    ]);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The whole image on Facebook's 4:5 feed shape (1080x1350), nothing cut.
 *
 * For the pin graphic: 2:3 is taller than the feed shows, and cutting it lost
 * either its title or half the dish. Here it is scaled to fit the height and
 * the strips left and right are filled with a blurred, darkened copy of itself.
 */
export async function fitForFacebookFeed(image: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'fbfit-'));
  try {
    const input = join(dir, 'in');
    const output = join(dir, 'out.jpg');
    await writeFile(input, image);
    await run('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', input,
      '-filter_complex',
      '[0:v]split=2[a][b];' +
        '[a]scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350,boxblur=40:3,eq=brightness=-0.06[bg];' +
        '[b]scale=1080:1350:force_original_aspect_ratio=decrease[fg];' +
        '[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuvj420p',
      '-frames:v', '1', '-q:v', '3', output,
    ]);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
