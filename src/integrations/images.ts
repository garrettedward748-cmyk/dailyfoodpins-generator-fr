import { createLogger, errorMessage } from '../lib/logger.js';
import { readLocalMedia } from './media-store.js';

const log = createLogger('images');

/**
 * Image generation service client.
 *
 * The previous implementation polled /v1/jobs/{id} in an n8n loop that tested
 * only `status === "COMPLETED"`. Any other value — including "FAILED" — took
 * the false branch, waited 15 seconds and polled again, forever. A failed
 * image job hung the execution permanently.
 *
 * This client bounds the loop and treats a reported failure as a failure.
 */

export interface ImageJob {
  job_id: string;
  status: string;
  image_url: string | null;
  /** Populated for video jobs; the same URL also arrives as image_url. */
  video_url?: string | null;
  image_expires_at: string | null;
  error: string | null;
  prompt?: string;
}

export interface ImageClientOptions {
  baseUrl: string;
  apiKey: string;
  pollIntervalMs: number;
  maxAttempts: number;
  /**
   * Called on every poll while a job is still queued or running. An article run
   * passes the run lock's heartbeat: an image held up behind a reel or an
   * account switch used to leave the run silent long enough for the stall check
   * to call it abandoned and fail it, while it was only waiting.
   */
  onWait?: () => void;
  /**
   * The Flow project to generate into, resolved per site.
   *
   * Sent with the request rather than configured on the image service, because
   * the service is shared by every site and each site has its own project. It
   * was previously an environment variable on that container, which meant the
   * value in Settings never reached it at all.
   */
  projectId?: string;
  /**
   * Which image model, as chosen in Settings: a model key, or 'auto'.
   *
   * Sent with every request so the choice on the page is the choice the
   * service makes. Omitted when it is 'auto' or unset, which the service
   * treats the same way.
   */
  imageModel?: string;
}

export class ImageGenerationError extends Error {
  constructor(message: string, readonly jobId?: string) {
    super(message);
    this.name = 'ImageGenerationError';
  }
}

/**
 * A dropped connection to the image service, not an answer from it: Node's
 * "fetch failed", a reset, a timeout. Seen when the service restarts or is busy
 * starting Chrome -- one of these used to fail the whole article mid-images.
 */
export function isNetworkBlip(err: unknown): boolean {
  if (err instanceof ImageGenerationError) return false;
  const text = `${(err as Error)?.name ?? ''} ${(err as Error)?.message ?? ''} ${String((err as { cause?: unknown })?.cause ?? '')}`.toLowerCase();
  return /fetch failed|econnreset|econnrefused|etimedout|socket hang up|other side closed|timeouterror|aborterror|network/.test(text);
}

/** How long the service may be unreachable before an image is given up on. */
const BLIP_TOLERANCE_MS = 3 * 60_000;

const TERMINAL_FAILURES = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED']);

export class ImageClient {
  constructor(private readonly options: ImageClientOptions) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.options.apiKey,
    };
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  /**
   * Submit a generation request and return the job id.
   *
   * `referenceUrls` are public photos the image should follow -- the article's
   * own feature image when a reel scene wants a fresh view of the same dish.
   * Sent only when there are any, so an article image is the same request it
   * always was.
   */
  async submit(
    prompt: string,
    orientation = 'VERTICAL',
    options: { referenceUrls?: string[] } = {},
  ): Promise<string> {
    // The service unreachable for a moment is retried, not a failed article.
    const started = Date.now();
    for (;;) {
      try {
        return await this.submitOnce(prompt, orientation, options);
      } catch (err) {
        if (!isNetworkBlip(err) || Date.now() - started > BLIP_TOLERANCE_MS) throw err;
        log.warn(`image service unreachable (${(err as Error).message}); trying again in 10s`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  }

  private async submitOnce(
    prompt: string,
    orientation: string,
    options: { referenceUrls?: string[] },
  ): Promise<string> {
    const response = await fetch(this.url('/v1/generate'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        prompt,
        orientation,
        ...(options.referenceUrls?.length ? { reference_urls: options.referenceUrls } : {}),
        // Omitted rather than sent empty, so the service falls back to its own
        // configured project instead of being told to use nothing.
        ...(this.options.projectId ? { project_id: this.options.projectId } : {}),
        ...(this.options.imageModel && this.options.imageModel !== 'auto'
          ? { image_model: this.options.imageModel }
          : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ImageGenerationError(
        `Image generation request failed: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    }

    const json = (await response.json()) as { job_id?: string };
    if (!json.job_id) {
      throw new ImageGenerationError('Image service did not return a job_id');
    }
    return json.job_id;
  }

  /**
   * Queue a video built from reference images.
   *
   * Same job table and the same `poll` as an image, so nothing downstream has
   * to know which kind it is waiting on -- only that it takes minutes rather
   * than seconds, which is the caller's business, not this method's.
   *
   * The reference URLs are ordinary public image URLs. The service uploads
   * each one to Flow at generation time, which is what lets an article of any
   * age become a video without having stored a Flow media id for it.
   */
  async submitVideo(input: {
    prompt: string;
    referenceUrls: string[];
    /** The presenter's character and voice in the Flow project, when the scene has them. */
    characterMediaId?: string;
    voiceMediaId?: string;
    projectId?: string;
    orientation?: string;
  }): Promise<string> {
    const response = await fetch(this.url('/v1/generate-video'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        prompt: fitVideoPrompt(input.prompt),
        reference_urls: input.referenceUrls,
        ...(input.characterMediaId ? { character_media_id: input.characterMediaId } : {}),
        ...(input.voiceMediaId ? { voice_media_id: input.voiceMediaId } : {}),
        orientation: input.orientation ?? 'VERTICAL',
        ...(input.projectId ? { project_id: input.projectId } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ImageGenerationError(
        `Video generation request failed: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    }

    const json = (await response.json()) as { job_id?: string };
    if (!json.job_id) {
      throw new ImageGenerationError('Image service did not return a job_id for the video');
    }
    return json.job_id;
  }

  async poll(jobId: string): Promise<ImageJob> {
    const response = await fetch(this.url(`/v1/jobs/${jobId}`), {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new ImageGenerationError(
        `Polling job ${jobId} failed: HTTP ${response.status}`,
        jobId,
      );
    }
    return (await response.json()) as ImageJob;
  }

  /**
   * Wait for a job to complete. Bounded by maxAttempts, and a reported
   * failure ends the wait immediately instead of retrying it forever.
   */
  async waitForCompletion(jobId: string): Promise<string> {
    const { maxAttempts, pollIntervalMs } = this.options;
    let lastNote: string | null = null;

    let unreachableSince: number | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let job: ImageJob;
      try {
        job = await this.poll(jobId);
        unreachableSince = null;
      } catch (err) {
        // The job lives in the service, not in this connection: a poll that
        // could not get through is asked again, for a few minutes, before the
        // image is given up on.
        if (!isNetworkBlip(err)) throw err;
        unreachableSince ??= Date.now();
        if (Date.now() - unreachableSince > BLIP_TOLERANCE_MS) throw err;
        log.warn(`polling job ${jobId}: service unreachable (${(err as Error).message}); asking again`);
        await new Promise((r) => setTimeout(r, Math.max(pollIntervalMs, 5_000)));
        continue;
      }
      const status = (job.status ?? '').toUpperCase();

      if (status === 'COMPLETED') {
        if (!job.image_url) {
          throw new ImageGenerationError(
            `Job ${jobId} reported COMPLETED but returned no image_url`,
            jobId,
          );
        }
        log.debug(`Job ${jobId} completed after ${attempt} poll(s)`);
        return job.image_url;
      }

      if (TERMINAL_FAILURES.has(status)) {
        throw new ImageGenerationError(
          `Image job ${jobId} failed with status ${status}: ${job.error ?? 'no detail given'}`,
          jobId,
        );
      }

      // A job that is still queued or running with an error written on it is
      // a job the service is retrying: it went back to PENDING with the last
      // failure noted. That used to end the wait here, which cancelled the
      // retry from the outside -- the job went on to succeed in a queue nobody
      // was watching, and the run failed on the note. The note is worth a log
      // line and a mention if the wait runs out; the status decides.
      if (job.error && job.error !== lastNote) {
        lastNote = job.error;
        log.warn(`Job ${jobId} is being retried by the image service after: ${job.error}`);
      }

      if (attempt < maxAttempts) {
        try {
          this.options.onWait?.();
        } catch {
          /* a missed heartbeat is not worth failing the image over */
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    }

    const waited = Math.round((maxAttempts * pollIntervalMs) / 1000);
    throw new ImageGenerationError(
      `Image job ${jobId} did not complete within ${waited}s (${maxAttempts} attempts). ` +
        'Raise the limit in Settings → Images if generation is legitimately slow.' +
        (lastNote ? ` The last attempt the service made hit: ${lastNote}` : ''),
      jobId,
    );
  }

  /** Download a generated image into memory. */
  async download(imageUrl: string): Promise<{ data: Buffer; contentType: string }> {
    // A social-only account's pictures are on this platform: read, not fetched.
    const local = readLocalMedia(imageUrl);
    if (local) return local;
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      throw new ImageGenerationError(`Downloading image failed: HTTP ${response.status}`);
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'image/webp',
    };
  }

  /** Submit, wait, and download in one call. */
  async generate(
    prompt: string,
    orientation = 'VERTICAL',
    options: { referenceUrls?: string[] } = {},
  ): Promise<{
    jobId: string;
    imageUrl: string;
    data: Buffer;
    contentType: string;
  }> {
    const jobId = await this.submit(prompt, orientation, options);
    const imageUrl = await this.waitForCompletion(jobId);
    const { data, contentType } = await this.download(imageUrl);
    return { jobId, imageUrl, data, contentType };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await fetch(this.url('/v1/jobs/health-probe'), {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      // 404 for an unknown job still proves the service and key are working.
      return { ok: response.status < 500 };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}

/** The video service rejects a prompt longer than this (HTTP 422 string_too_long). */
export const VIDEO_PROMPT_MAX = 5000;

/**
 * Keep a video prompt under the service's limit.
 *
 * First the free win: trailing spaces and runs of blank lines. Only if it is
 * still too long is the end cut, at a line break, so no sentence is sent half
 * written. A cut prompt still films; a rejected one films nothing.
 */
export function fitVideoPrompt(prompt: string, max = VIDEO_PROMPT_MAX): string {
  let out = prompt.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length <= max) return out;
  const cut = out.slice(0, max);
  const lastBreak = cut.lastIndexOf('\n');
  out = (lastBreak > max * 0.8 ? cut.slice(0, lastBreak) : cut).trim();
  console.warn(`[video] prompt was ${prompt.length} characters; cut to ${out.length} to fit the ${max} limit`);
  return out;
}
