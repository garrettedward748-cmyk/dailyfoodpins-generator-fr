/**
 * Client for the image service's Gemini prompts.
 *
 * Gemini runs in the image service's Chrome, signed in to the same Google account as Flow, through
 * the Gemini Chat extension. The service queues a prompt, the extension answers it in Gemini's own
 * page, and this polls for the reply -- the same submit-and-poll shape as ImageClient, for the same
 * reason: an answer takes seconds to minutes, and the poll is bounded so a stuck prompt fails
 * instead of hanging the run that asked.
 */

export interface GeminiFile {
  name: string;
  mime: string;
  base64: string;
}

export interface GeminiAsk {
  prompt: string;
  files?: GeminiFile[];
  /** The Google account to ask as, by email; empty for the browser's default account. */
  account?: string;
  /** A temporary chat keeps automated prompts out of the account's chat history. */
  temporary?: boolean;
  /** Whether pictures in the reply come back as data, not only as addresses. */
  images?: boolean;
  /** The whole budget: the browser starting, the page loading and Gemini answering. */
  timeoutS?: number;
}

export interface GeminiImage {
  url: string;
  alt: string;
  mime?: string;
  data_base64?: string;
}

export interface GeminiReply {
  conversation_id: string | null;
  text: string;
  markdown: string;
  code_blocks: { language: string; code: string }[];
  links: { url: string; text: string }[];
  images: GeminiImage[];
  /** The account Gemini answered as, when the page showed it. */
  account?: string;
}

export interface GeminiJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  result: GeminiReply | null;
  error: string | null;
}

export interface GeminiStatus {
  extension_connected: boolean;
  queued: number;
  running: number;
  last_success_at: string | null;
  last_error: string | null;
}

/**
 * Why a prompt failed, with the page's own code when it gave one:
 * NOT_SIGNED_IN and WRONG_ACCOUNT need a person on the Browser page; the rest are worth a retry.
 */
export class GeminiError extends Error {
  constructor(
    message: string,
    readonly code = 'ERROR',
  ) {
    super(message);
    this.name = 'GeminiError';
  }

  /** "NOT_SIGNED_IN: Gemini is open but..." -> code NOT_SIGNED_IN, the rest as the message. */
  static from(reason: string): GeminiError {
    const m = /^([A-Z_]{3,30}): (.*)$/s.exec(reason.trim());
    return m ? new GeminiError(m[2]!, m[1]) : new GeminiError(reason);
  }
}

export interface GeminiClientOptions {
  baseUrl: string;
  apiKey: string;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_S = 300;

export class GeminiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GeminiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private async call<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
    const response = await this.fetchImpl(this.url(path), {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': this.options.apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let detail = text.slice(0, 200);
      try {
        detail = String((JSON.parse(text) as { detail?: unknown }).detail ?? detail);
      } catch {
        /* not JSON: keep the text */
      }
      const code = response.status === 404 ? 'GONE' : response.status === 401 || response.status === 403 ? 'KEY' : 'SERVICE';
      throw new GeminiError(`The image service answered HTTP ${response.status}${detail ? `: ${detail}` : ''}`, code);
    }
    return (await response.json()) as T;
  }

  /** Queue a prompt; returns its id. */
  async submit(ask: GeminiAsk): Promise<string> {
    const job = await this.call<GeminiJob>('/v1/gemini/jobs', {
      method: 'POST',
      body: JSON.stringify({
        prompt: ask.prompt,
        files: ask.files ?? [],
        account: ask.account ?? '',
        temporary: ask.temporary ?? true,
        images: ask.images ?? true,
        timeout_s: Math.min(1800, Math.max(60, Math.round(ask.timeoutS ?? DEFAULT_TIMEOUT_S))),
      }),
    });
    return job.id;
  }

  job(id: string): Promise<GeminiJob> {
    return this.call<GeminiJob>(`/v1/gemini/jobs/${encodeURIComponent(id)}`);
  }

  status(): Promise<GeminiStatus> {
    return this.call<GeminiStatus>('/v1/gemini/status', {}, 5_000);
  }

  /** Queue a prompt and wait for its reply. Throws GeminiError on failure or when time runs out. */
  async ask(ask: GeminiAsk): Promise<GeminiReply> {
    const id = await this.submit(ask);
    const interval = this.options.pollIntervalMs ?? 2_000;
    // The service enforces the prompt's own deadline; this one only covers the service going quiet.
    const deadline = Date.now() + (ask.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000 + 30_000;
    let misses = 0;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      let job: GeminiJob;
      try {
        job = await this.job(id);
        misses = 0;
      } catch (err) {
        // A restarted service has forgotten the prompt: no point waiting for it.
        if (err instanceof GeminiError && err.code === 'GONE') throw err;
        if (++misses >= 5) throw err;
        continue;
      }
      if (job.status === 'done' && job.result) return job.result;
      if (job.status === 'failed') throw GeminiError.from(job.error ?? 'Gemini failed without saying why');
    }
    throw new GeminiError('Gemini did not answer in time', 'TIMEOUT');
  }
}
