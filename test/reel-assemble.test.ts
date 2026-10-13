import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleReel } from '../src/reels/assemble.js';

/**
 * Joining the scene clips into one reel. The real ffmpeg is used where it is
 * installed (it ships in the platform image); elsewhere only the failure
 * message is checked.
 */

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';

const ffmpegAvailable = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!ffmpegAvailable)('assembling a reel', () => {
  let dir: string;

  const clip = (name: string, seconds: number, size: string) => {
    const path = join(dir, name);
    execFileSync(
      FFMPEG,
      ['-y', '-f', 'lavfi', '-i', `color=c=blue:s=${size}:d=${seconds}`, '-f', 'lavfi', '-i',
        `sine=f=440:d=${seconds}`, '-shortest', '-pix_fmt', 'yuv420p', path],
      { stdio: 'ignore' },
    );
    return path;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'asm-'));
  });

  it('joins clips of different sizes into one portrait file with the CTA on the end', async () => {
    const a = clip('a.mp4', 1, '720x1280');
    const b = clip('b.mp4', 1, '640x640');
    const out = join(dir, 'out.mp4');

    await assembleReel([a, b], out, { ctaText: "La recette complète : it's in the comments", ffmpeg: FFMPEG });

    expect(statSync(out).size).toBeGreaterThan(0);
    const probe = execFileSync(FFPROBE, [
      '-v', 'error', '-show_entries', 'stream=width,height:format=duration', '-of', 'csv=p=0', out,
    ]).toString();
    expect(probe).toContain('1080,1920');
    const duration = Number(probe.trim().split('\n').pop());
    expect(duration).toBeGreaterThan(1.8);
  }, 60_000);

  it('says what ffmpeg said when a clip is unreadable', async () => {
    await expect(
      assembleReel([join(dir, 'missing.mp4')], join(dir, 'x.mp4'), { ctaText: '', ffmpeg: FFMPEG }),
    ).rejects.toThrow(/missing\.mp4/);
  });
});

describe('assembling without ffmpeg', () => {
  it('fails with a sentence a person can act on', async () => {
    await expect(
      assembleReel(['a.mp4'], join(tmpdir(), 'o.mp4'), { ctaText: '', ffmpeg: 'no-such-ffmpeg-binary' }),
    ).rejects.toThrow(/ffmpeg/i);
  });

  it('refuses an empty reel', async () => {
    await expect(assembleReel([], 'o.mp4', { ctaText: '' })).rejects.toThrow(/no clips/i);
  });
});
