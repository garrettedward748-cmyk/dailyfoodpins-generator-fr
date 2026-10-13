/**
 * Which failures are worth trying again on their own.
 *
 * A failed run used to sit untouched until someone opened it and pressed
 * Resume. Most of the failures that actually happen are not decisions the
 * system made — a rate limit, the image service restarting, a socket dropped
 * mid-upload. Those are worth one automatic retry a few minutes later, and
 * nothing about them needs a person.
 *
 * The failures that do need a person are the ones where retrying produces the
 * identical failure: a wrong API token, a site rejecting the payload, a model
 * that does not exist. Retrying those wastes a publishing slot and buries the
 * real error under a second copy of itself.
 *
 * Pure and string-based on purpose: the errors arrive here already flattened
 * to text by `errorMessage`, having crossed a step boundary, and the class of
 * the original exception is long gone by then.
 */

/** Patterns that mean "the world was briefly unavailable". */
const TRANSIENT = [
  // HTTP status codes, as they appear in our own error text.
  /\bHTTP 408\b/i,
  /\bHTTP 425\b/i,
  /\bHTTP 429\b/i,
  /\bHTTP 5\d\d\b/,
  /\bstatus 5\d\d\b/i,

  // Rate limiting, however it is worded.
  /rate limit/i,
  /too many requests/i,
  /\bquota\b/i,
  /overloaded/i,

  // Sockets and DNS.
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /\bENOTFOUND\b/,
  /\bEPIPE\b/,
  /\bEHOSTUNREACH\b/,
  /socket hang up/i,
  /network|fetch failed/i,

  // Timeouts and aborts.
  /timed? ?out/i,
  /\baborted\b/i,
  /operation was aborted/i,

  // Our own services saying "not yet".
  /unreachable/i,
  /temporarily/i,
  /try again/i,
  /is restarting/i,
  /not connected/i,

  // Every LLM key was tried and every one refused. Worth trying again — that
  // is what a rate-limited pool looks like. The other shape of this error,
  // "no enabled endpoint serves model X. Add one in Settings", is deliberately
  // not matched: no amount of waiting adds a key.
  /tried \d+ endpoint/i,
];

/**
 * Patterns that mean "this will fail identically next time".
 *
 * Checked first, because several of these also contain words the transient
 * list matches — "HTTP 401: authentication failed, please try again" is not
 * something to try again.
 */
const PERMANENT = [
  /\bHTTP 40[013457]\b/,
  /\bHTTP 41[0-9]\b/,
  /\bHTTP 422\b/,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /invalid (api )?(key|token|credential)/i,
  /authentication failed/i,
  /\bnot found\b/i,
  /does not exist/i,
  /no such/i,
  /validation (failed|error)/i,
  /is not valid JSON/i,
  /spy source rejected/i,
  /has no title/i,
  /came back empty/i,
];

/**
 * A rejected reCAPTCHA score, which is transient however it is worded.
 *
 * Checked before everything else because it arrives as a 403, and 403 is in
 * the permanent list for good reasons that do not apply here. The score is a
 * property of the browser session at that moment — the image service reloads
 * its Flow tab and tries again on its own — so the run is worth resuming once
 * that has had a chance to take effect. Treating it as permanent meant one low
 * score killed a run outright, which is the failure this exists to stop.
 */
const RECAPTCHA = /recaptcha/i;

export function isTransient(error: string): boolean {
  const text = (error ?? '').trim();
  if (text === '') return false;

  if (RECAPTCHA.test(text)) return true;
  if (PERMANENT.some((pattern) => pattern.test(text))) return false;
  return TRANSIENT.some((pattern) => pattern.test(text));
}

export interface RetryPolicy {
  enabled: boolean;
  /** Automatic attempts allowed after the first failure. */
  maxAttempts: number;
  delayMinutes: number;
}

export interface RetryDecision {
  retry: boolean;
  reason: string;
  /** When the retry becomes due, as an ISO string. Null when not retrying. */
  retryAfter: string | null;
}

/**
 * Should this failed run be tried again, and when?
 *
 * `attempts` is how many automatic retries have already been spent, so the
 * first failure of a fresh run arrives here with 0.
 */
export function planRetry(
  error: string,
  attempts: number,
  policy: RetryPolicy,
  now: Date,
): RetryDecision {
  const no = (reason: string): RetryDecision => ({ retry: false, reason, retryAfter: null });

  if (!policy.enabled) return no('Automatic retries are off');
  if (policy.maxAttempts <= 0) return no('Automatic retries are off');

  if (attempts >= policy.maxAttempts) {
    return no(`Already retried ${attempts} time(s); giving up and leaving it for you`);
  }

  if (!isTransient(error)) {
    return no('The error looks like it would happen again identically');
  }

  // Back off further on each attempt, so a service that is properly down is
  // not hammered on a fixed cadence.
  const minutes = policy.delayMinutes * Math.pow(2, attempts);
  const due = new Date(now.getTime() + minutes * 60_000);

  return {
    retry: true,
    reason: `Transient failure; retrying in ${minutes} minute(s)`,
    retryAfter: due.toISOString(),
  };
}
