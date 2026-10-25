import { spawn } from 'node:child_process';
import { setPriority } from 'node:os';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Every reel leaves tagged and converted as standard HD video (BT.709, limited
 * range). Built from photos and Flow clips, the output carried mixed colour
 * tags -- an SD matrix, HD primaries and the sRGB transfer of a still image --
 * and Facebook refused such reels through Buffer ("unable to process the
 * media") while taking the same reel with clean tags.
 */
const BT709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

/**
 * Join the scene clips into the reel.
 *
 * One ffmpeg run: every clip scaled and padded to 1080x1920 at 30 fps with
 * its own sound kept, concatenated in order, and the call to action drawn
 * over the last two seconds. ffmpeg is a command, not a service -- it runs
 * for the seconds this takes and exits, so there is nothing to keep up or
 * shut down between reels.
 */
export async function assembleReel(
  clipPaths: string[],
  outPath: string,
  options: { ctaText: string; ffmpeg?: string },
): Promise<void> {
  if (clipPaths.length === 0) throw new Error('There are no clips to assemble.');
  mkdirSync(dirname(outPath), { recursive: true });

  const inputs = clipPaths.flatMap((p) => ['-i', p]);
  const norm = clipPaths
    .map(
      (_, i) =>
        `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
        `pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v${i}];` +
        `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`,
    )
    .join(';');
  const concat =
    clipPaths.map((_, i) => `[v${i}][a${i}]`).join('') +
    `concat=n=${clipPaths.length}:v=1:a=1[vc][ac]`;

  const cta = options.ctaText.trim();
  const from = Math.max(0, clipPaths.length * 10 - 2);
  // Read from a file, not written inline: an apostrophe in the caption
  // ("it's in the comments") ended drawtext's quoted text= and failed the reel.
  const ctaFile = `${outPath}.cta.txt`;
  if (cta) writeFileSync(ctaFile, cta);
  const text = cta
    ? `;[vc]drawtext=${fontArg()}textfile='${escapeDrawtext(ctaFile)}':fontcolor=white:fontsize=64:` +
      `box=1:boxcolor=black@0.5:boxborderw=24:x=(w-text_w)/2:y=h-260:enable='gte(t,${from})'[vout]`
    : ';[vc]copy[vout]';

  const args = [
    '-y', ...inputs,
    '-filter_complex', `${norm};${concat}${text}`,
    '-map', '[vout]', '-map', '[ac]',
    '-c:v', 'libx264', ...BT709, '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    outPath,
  ];

  try {
    await run(options.ffmpeg ?? 'ffmpeg', args);
  } finally {
    if (cta) rmSync(ctaFile, { force: true });
  }
}

/**
 * A font file drawtext can open, named outright. Without one it asks
 * fontconfig for "Sans", which on a slim container finds nothing and fails
 * the whole assembly. The DejaVu paths are where Alpine and Debian put it;
 * FFMPEG_FONT overrides for anywhere else.
 */
function fontArg(): string {
  const candidates = [
    process.env.FFMPEG_FONT,
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    'C:/Windows/Fonts/arialbd.ttf',
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  return found ? `fontfile='${escapeDrawtext(found)}':` : '';
}

/** How long the hook stays on a one-clip reel, from frame 0. */
export const HOOK_SECONDS = 3;

/**
 * The words shown over a one-clip reel's opening: the dish's own name, the
 * part of the title before any colon or dash.
 */
export function hookFromTitle(title: string): string {
  return title.split(/\s*[:|–—]\s*|\s+-\s+/)[0]!.replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** One spoken word and when it is said, in seconds from the start of the clip. */
export interface WordTiming {
  w: string;
  start: number;
  end: number;
}

/**
 * The spoken words as on-screen captions: one word at a time, big, centred,
 * white with a black outline -- the style the most-watched recipe reels use.
 * Each word stays up until the next one is said, unless the voice pauses.
 * Returns [text, from, to] for each word worth showing.
 */
export function captionWords(words: readonly WordTiming[]): [string, number, number][] {
  const out: [string, number, number][] = [];
  const clean = words
    .map((x) => ({ ...x, w: x.w.replace(/[^\p{L}\p{N}'’%°-]/gu, '').toUpperCase() }))
    .filter((x) => x.w && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end >= x.start);
  clean.forEach((x, i) => {
    const next = clean[i + 1];
    // Off just before the next word comes on, so two words never share a frame.
    const to = next && next.start - x.end < 0.6 ? next.start - 0.04 : x.end + 0.25;
    out.push([x.w.slice(0, 20), Math.max(0, x.start), Math.max(x.start + 0.12, to)]);
  });
  return out;
}

/**
 * A video as Facebook and Instagram Reels want it: 1080x1920, 30 fps, H.264
 * High + AAC, moov first, and no extra boxes.
 *
 * Flow's clips come as 720x1280 at 24 fps with a Content Credentials "uuid"
 * box ahead of the movie header; Buffer handed one of those to Facebook and
 * got "Facebook was unable to process the media". A file ffmpeg wrote fresh
 * carries none of that.
 */
export async function normalizeForSocial(
  video: Buffer,
  ffmpeg = 'ffmpeg',
  hook = '',
  spoken: readonly WordTiming[] = [],
): Promise<Buffer> {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'reelnorm-'));
  const input = join(dir, 'in.mp4');
  const output = join(dir, 'out.mp4');
  try {
    writeFileSync(input, video);
    let vf = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p';
    // The hook: the dish's name, on screen from the very first frame, so a
    // viewer knows what this is before the two-second mark where most leave.
    const words = hook.trim();
    if (words) {
      const file = join(dir, 'hook.txt');
      writeFileSync(file, wrapWords(words, 18));
      vf +=
        `,drawtext=${fontArg()}textfile='${escapeDrawtext(file)}':fontcolor=white:fontsize=78:line_spacing=14:` +
        `box=1:boxcolor=black@0.45:boxborderw=28:x=(w-text_w)/2:y=h*0.14:` +
        `enable='between(t,0,${HOOK_SECONDS})'`;
    }
    // "Did you know" reels: the voice on screen, word by word.
    captionWords(spoken).forEach(([word, from, to], i) => {
      const file = join(dir, `w${i}.txt`);
      writeFileSync(file, word);
      vf +=
        `,drawtext=${fontArg()}textfile='${escapeDrawtext(file)}':fontcolor=white:fontsize=120:` +
        `borderw=7:bordercolor=black:shadowcolor=black@0.5:shadowx=0:shadowy=6:` +
        `x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${from.toFixed(3)},${to.toFixed(3)})'`;
    });
    await run(ffmpeg, [
      '-y', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', vf,
      '-c:v', 'libx264', ...BT709, '-profile:v', 'high', '-preset', 'veryfast', '-crf', '20', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
      '-map_metadata', '-1', '-movflags', '+faststart',
      output,
    ]);
    return readFileSync(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** drawtext reads : and ' and \ as syntax; a caption may contain any of them. */
function escapeDrawtext(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '%%');
}

function run(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    // Lowest priority. The container is capped at a few cores, and an encode
    // takes all of them: at normal priority the web UI waited behind ffmpeg and
    // every page took seconds. Niced, the UI answers first and the reel only
    // uses what is left -- it finishes barely later.
    if (child.pid) {
      try {
        setPriority(child.pid, 19);
      } catch {
        // Not allowed on this host: the encode runs at normal priority.
      }
    }
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', (err) =>
      reject(
        new Error(
          `ffmpeg could not be started (${err.message}). It ships in the platform image; ` +
            'on a local checkout, install ffmpeg.',
        ),
      ),
    );
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const tail = stderr.trim().split('\n').slice(-6).join('\n');
      reject(new Error(`ffmpeg failed (exit ${code}):\n${tail}`));
    });
  });
}

/* -------------------------------------------------------------------------
 * Clip + steps: the one Flow clip, then the recipe's own photos
 * ---------------------------------------------------------------------- */

export interface MixedReelInput {
  /** The Flow clip: the opening, shown as it is. */
  clip: string;
  /** Short words over the first seconds of the clip. */
  hook: string;
  /** The method photos, in order, each with a few words. */
  steps: { image: string; caption: string }[];
  /** The finished dish, blurred behind the call to action. */
  endImage: string;
  cta: string;
  /** One music track under the whole reel. Optional. */
  music?: string;
  /** Where the caption text files are written. */
  workDir: string;
}

/** Seconds each photo is on screen, the cross-fade, and the end card. */
export const MIX = { step: 2.8, fade: 0.4, end: 3, maxClip: 10 } as const;

/**
 * One reel from one clip and the article's photos.
 *
 * The clip opens -- it is the part that stops the scroll -- with a few words
 * on it. Then each method photo, slowly zooming, with its step in large
 * letters, cross-faded one into the next, and an end card with the call to
 * action in the middle of the screen, above where Facebook draws its buttons
 * and caption. One music track runs under all of it, lower while the clip
 * has its own sound. Every picture is a real photo of this dish, so nothing
 * changes set or vanishes between shots.
 */
export async function assembleMixedReel(input: MixedReelInput, outPath: string, ffmpeg = 'ffmpeg'): Promise<void> {
  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(input.workDir, { recursive: true });
  const probe = await probeMedia(input.clip, ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'));
  const clipLen = Math.max(2, Math.min(MIX.maxClip, probe.duration || MIX.maxClip) - 0.25);
  const T = MIX.fade;
  const n = input.steps.length;
  const total = clipLen + n * MIX.step + MIX.end - (n + 1) * T;

  const textFile = (name: string, text: string, width: number) => {
    const path = join(input.workDir, `${name}.txt`);
    writeFileSync(path, wrapWords(text, width));
    return `textfile='${escapeDrawtext(path)}'`;
  };
  const font = fontArg();
  const title = (file: string, size: number, y: string, from: number, to: number) =>
    `drawtext=${font}${file}:fontcolor=white:fontsize=${size}:line_spacing=14:` +
    `box=1:boxcolor=black@0.45:boxborderw=28:x=(w-text_w)/2:y=${y}:` +
    `enable='between(t,${from},${to})':alpha='min(1,(t-${from})/0.3)'`;

  const args: string[] = ['-y', '-i', input.clip];
  for (const s of input.steps) args.push('-loop', '1', '-framerate', '30', '-t', String(MIX.step), '-i', s.image);
  args.push('-loop', '1', '-framerate', '30', '-t', String(MIX.end), '-i', input.endImage);
  const musicIndex = input.music ? n + 2 : -1;
  if (input.music) args.push('-stream_loop', '-1', '-i', input.music);

  const fill = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1';
  const parts: string[] = [];
  const hook = input.hook.trim();
  parts.push(
    `[0:v]${fill},fps=30,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,trim=0:${clipLen},setpts=PTS-STARTPTS` +
      (hook ? `,${title(textFile('hook', hook, 20), 76, 'h*0.14', 0.3, Math.min(3.8, clipLen - 0.5))}` : '') +
      '[s0]',
  );
  input.steps.forEach((step, i) => {
    const frames = Math.round(MIX.step * 30);
    // Alternate zooming in and out so the photos do not all move the same way.
    const zoom = i % 2 === 0 ? `1+0.12*on/${frames}` : `1.12-0.12*on/${frames}`;
    const caption = step.caption.trim();
    parts.push(
      `[${i + 1}:v]scale=1350:2400:force_original_aspect_ratio=increase,crop=1350:2400,` +
        `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30,` +
        `setsar=1,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,trim=0:${MIX.step},setpts=PTS-STARTPTS` +
        (caption ? `,${title(textFile(`step${i + 1}`, caption, 18), 80, 'h*0.14', 0.25, MIX.step)}` : '') +
        `[s${i + 1}]`,
    );
  });
  parts.push(
    `[${n + 1}:v]${fill},boxblur=24:2,eq=brightness=-0.18,fps=30,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,trim=0:${MIX.end},setpts=PTS-STARTPTS,` +
      `drawtext=${font}${textFile('cta', input.cta.trim() || 'La recette complète dans la légende', 16)}:fontcolor=white:fontsize=92:` +
      `line_spacing=18:box=1:boxcolor=black@0.35:boxborderw=40:x=(w-text_w)/2:y=(h-text_h)/2-120:` +
      `alpha='min(1,t/0.4)'[s${n + 1}]`,
  );

  // Cross-fade each part into the next.
  let last = 's0';
  let length = clipLen;
  for (let i = 1; i <= n + 1; i++) {
    const partLen = i <= n ? MIX.step : MIX.end;
    const out = i === n + 1 ? 'vout' : `x${i}`;
    parts.push(`[${last}][s${i}]xfade=transition=fade:duration=${T}:offset=${(length - T).toFixed(3)}[${out}]`);
    last = out;
    length += partLen - T;
  }

  // Sound: the clip's own, faded out as it ends, then the music under all.
  const clipAudio = probe.hasAudio
    ? `[0:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${clipLen},asetpts=PTS-STARTPTS,` +
      `afade=t=out:st=${Math.max(0, clipLen - 0.5)}:d=0.5,apad,atrim=0:${total.toFixed(3)}[ca]`
    : `anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(3)}[ca]`;
  parts.push(clipAudio);
  if (musicIndex >= 0) {
    parts.push(
      `[${musicIndex}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `volume='if(lt(t,${clipLen - 0.5}),${probe.hasAudio ? 0.18 : 0.7},0.7)':eval=frame,` +
        `afade=t=in:d=0.8,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5[mu]`,
    );
    parts.push('[ca][mu]amix=inputs=2:duration=first:dropout_transition=0,volume=2[aout]');
  } else {
    parts.push('[ca]anull[aout]');
  }

  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-t', total.toFixed(3),
    '-c:v', 'libx264', ...BT709, '-preset', 'veryfast', '-crf', '20', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    outPath,
  );
  await run(ffmpeg, args);
}

/** Words broken into lines of about `width` characters, for drawtext. */
export function wrapWords(text: string, width: number): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (line && (line + ' ' + word).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/** How long a video is and whether it has sound. */
function probeMedia(path: string, ffprobe: string): Promise<{ duration: number; hasAudio: boolean }> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.on('data', (c) => (out += String(c)));
    child.on('error', () => resolve({ duration: 0, hasAudio: true }));
    child.on('close', () => {
      try {
        const data = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type?: string }[] };
        resolve({
          duration: Number(data.format?.duration) || 0,
          hasAudio: (data.streams ?? []).some((s) => s.codec_type === 'audio'),
        });
      } catch {
        resolve({ duration: 0, hasAudio: true });
      }
    });
  });
}

/* -------------------------------------------------------------------------
 * Process reels
 * ---------------------------------------------------------------------- */

/** The last moment of a clip, as a JPEG: what the next clip is filmed from. */
export async function lastFrame(clipPath: string, ffmpeg = 'ffmpeg'): Promise<Buffer> {
  const out = join(dirname(clipPath), `${clipPath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')}-last.jpg`);
  await run(ffmpeg, ['-y', '-sseof', '-0.4', '-i', clipPath, '-frames:v', '1', '-q:v', '2', out]);
  return readFileSync(out);
}

/** How much of each clip a process reel keeps. */
export const PROCESS_CUT = { start: 0.4, hook: 2, shot: 2.8 } as const;

/**
 * Join process clips the way the reels they copy are cut: only the first
 * seconds of each clip -- where the action is clean, before a generated
 * clip starts to drift -- in hard cuts, the first one shorter as the hook.
 * The clips' own cooking sound stays; the music, when there is one, runs
 * under all of it. No text: the recipe link is in the post.
 */
export async function assembleProcessReel(
  clipPaths: string[],
  outPath: string,
  options: { music?: string; ffmpeg?: string } = {},
): Promise<void> {
  if (clipPaths.length === 0) throw new Error('There are no clips to assemble.');
  mkdirSync(dirname(outPath), { recursive: true });
  const ffmpeg = options.ffmpeg ?? 'ffmpeg';
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
  const probes = await Promise.all(clipPaths.map((p) => probeMedia(p, ffprobe)));

  const args: string[] = ['-y'];
  clipPaths.forEach((p) => args.push('-i', p));
  const musicIndex = options.music ? clipPaths.length : -1;
  if (options.music) args.push('-stream_loop', '-1', '-i', options.music);

  const parts: string[] = [];
  let total = 0;
  clipPaths.forEach((_, i) => {
    const want = i === 0 ? PROCESS_CUT.hook : PROCESS_CUT.shot;
    const dur = probes[i]!.duration || 8;
    const start = Math.min(PROCESS_CUT.start, Math.max(0, dur - want));
    const len = Math.max(0.5, Math.min(want, dur - start));
    const end = start + len;
    total += len;
    parts.push(
      `[${i}:v]trim=${start.toFixed(3)}:${end.toFixed(3)},setpts=PTS-STARTPTS,` +
        `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v${i}]`,
    );
    parts.push(
      probes[i]!.hasAudio
        ? `[${i}:a]atrim=${start.toFixed(3)}:${end.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,` +
            `afade=t=in:d=0.05,afade=t=out:st=${Math.max(0, len - 0.08).toFixed(3)}:d=0.08[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=0:${len.toFixed(3)}[a${i}]`,
    );
  });
  parts.push(`${clipPaths.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${clipPaths.length}:v=1:a=1[vout][ca]`);
  if (musicIndex >= 0) {
    parts.push(
      `[${musicIndex}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `volume=0.5,afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, total - 1.2).toFixed(3)}:d=1.2[mu]`,
    );
    parts.push('[ca]volume=0.8[cq];[cq][mu]amix=inputs=2:duration=first:dropout_transition=0,volume=2[aout]');
  } else {
    parts.push('[ca]anull[aout]');
  }

  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', ...BT709, '-preset', 'veryfast', '-crf', '20', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    outPath,
  );
  await run(ffmpeg, args);
}
