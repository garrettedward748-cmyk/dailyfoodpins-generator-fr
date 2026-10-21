import type { WordTiming } from './assemble.js';

/**
 * When each word of a reel's voice is said, from the captions service
 * (services/captions: faster-whisper on the CPU, next to this container).
 *
 * The service only hears the audio, so it is sent the video's own bytes and
 * the language the voice is in. Anything wrong -- no service configured, the
 * service down, an answer that is not a list -- is an error the caller turns
 * into "no captions", never into a reel that does not go out.
 */
export const CAPTIONS_LANG = process.env.CAPTIONS_LANG || 'fr';

export async function fetchWordTimings(
  video: Buffer,
  base = process.env.CAPTIONS_URL || '',
  lang = CAPTIONS_LANG,
): Promise<WordTiming[]> {
  if (!base) throw new Error('No captions service is set (CAPTIONS_URL).');
  const res = await fetch(`${base.replace(/\/+$/, '')}/words?lang=${encodeURIComponent(lang)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(video),
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await res.json().catch(() => ({}))) as { words?: unknown; error?: string };
  if (!res.ok) throw new Error(`The captions service answered HTTP ${res.status}: ${body.error ?? 'no detail'}`);
  if (!Array.isArray(body.words)) throw new Error('The captions service sent no word list.');
  return (body.words as Record<string, unknown>[])
    .map((x) => ({ w: String(x.w ?? ''), start: Number(x.start), end: Number(x.end) }))
    .filter((x) => x.w && Number.isFinite(x.start) && Number.isFinite(x.end));
}
