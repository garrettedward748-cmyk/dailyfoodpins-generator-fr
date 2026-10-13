import { describe, expect, it } from 'vitest';
import { isTransient, planRetry, type RetryPolicy } from '../src/core/retry.js';

/**
 * The whole value of automatic retries is in what they refuse to retry.
 *
 * Retrying a wrong API token costs a publishing slot and buries the real error
 * under a second copy of itself, so the permanent cases matter more here than
 * the transient ones.
 */

const POLICY: RetryPolicy = { enabled: true, maxAttempts: 2, delayMinutes: 15 };
const NOW = new Date('2026-08-28T12:00:00Z');

describe('classifying a failure', () => {
  it.each([
    'HTTP 429: rate limited',
    'HTTP 502: bad gateway',
    'Image service unreachable — no images can be generated until it is back.',
    'fetch failed',
    'connect ECONNRESET 10.0.0.4:8100',
    'The operation was aborted due to timeout',
    'No Ollama endpoint could serve "gemma4:31b" — tried 3 endpoint(s): a, b, c. Last error: HTTP 429',
  ])('retries %s', (error) => {
    expect(isTransient(error)).toBe(true);
  });

  it.each([
    'HTTP 401: unauthorized',
    'HTTP 403: forbidden',
    'HTTP 404: not found',
    'HTTP 422: validation failed on field title',
    'Invalid API key for this site',
    'Assembled article has no title; the parts did not merge as expected.',
    'Pin description came back empty',
    'Spy source rejected: not a recipe',
    // No key exists for that model. Waiting does not create one.
    'No Ollama endpoint could serve "gemma4:31b" — no enabled endpoint serves model "gemma4:31b". Add one in Settings.',
  ])('does not retry %s', (error) => {
    expect(isTransient(error)).toBe(false);
  });

  it('treats an empty error as not retryable', () => {
    expect(isTransient('')).toBe(false);
  });

  it('retries a rejected reCAPTCHA score even though it arrives as a 403', () => {
    // The score belongs to the browser session at that moment, not the
    // request. The image service reloads its Flow tab and tries again on its
    // own, so the run is worth resuming once that has had a chance to work.
    // Treated as permanent, one low score killed a run outright.
    expect(
      isTransient(
        "Image job abc failed with status FAILED: {'code': 403, " +
          "'message': 'reCAPTCHA evaluation failed'}",
      ),
    ).toBe(true);
  });

  it('retries it even when the message is worded as an HTTP 403', () => {
    expect(isTransient('HTTP 403: RECAPTCHA_REJECTED: score too low')).toBe(true);
  });

  it('still refuses a 403 that has nothing to do with reCAPTCHA', () => {
    expect(isTransient('HTTP 403: forbidden — wrong site token')).toBe(false);
  });

  it('lets a permanent phrase win over a transient one in the same message', () => {
    // The words that make this transient are all present; the 401 is what it
    // actually is.
    expect(isTransient('HTTP 401: authentication failed, please try again later')).toBe(false);
  });
});

describe('planning a retry', () => {
  it('schedules a transient failure', () => {
    const decision = planRetry('HTTP 429: rate limited', 0, POLICY, NOW);

    expect(decision.retry).toBe(true);
    expect(decision.retryAfter).toBe('2026-08-28T12:15:00.000Z');
  });

  it('backs off further on each attempt', () => {
    const first = planRetry('HTTP 429', 0, POLICY, NOW);
    const second = planRetry('HTTP 429', 1, POLICY, NOW);

    expect(first.retryAfter).toBe('2026-08-28T12:15:00.000Z');
    expect(second.retryAfter).toBe('2026-08-28T12:30:00.000Z');
  });

  it('stops once the attempts are spent, and says why', () => {
    const decision = planRetry('HTTP 429', 2, POLICY, NOW);

    expect(decision.retry).toBe(false);
    expect(decision.retryAfter).toBeNull();
    expect(decision.reason).toContain('giving up');
  });

  it('refuses a permanent failure however many attempts are left', () => {
    const decision = planRetry('HTTP 401: unauthorized', 0, POLICY, NOW);

    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain('identically');
  });

  it('does nothing when the policy is off', () => {
    const decision = planRetry('HTTP 429', 0, { ...POLICY, enabled: false }, NOW);
    expect(decision.retry).toBe(false);
  });

  it('treats zero attempts as off rather than as unlimited', () => {
    const decision = planRetry('HTTP 429', 0, { ...POLICY, maxAttempts: 0 }, NOW);
    expect(decision.retry).toBe(false);
  });
});
