import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageClient } from '../src/integrations/images.js';

/**
 * Waiting on the image service.
 *
 * The service retries a job that failed for a passing reason: it goes back to
 * PENDING with the last error written on it. The platform used to read that
 * note and give up on the spot, which cancelled the retry from the outside --
 * the job went on to succeed in a queue nobody was watching.
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client() {
  return new ImageClient({ baseUrl: 'https://img.test', apiKey: 'k', pollIntervalMs: 0, maxAttempts: 5 });
}

afterEach(() => vi.unstubAllGlobals());

describe('waiting for an image job', () => {
  it('keeps waiting while a job is being retried, even with the last error written on it', async () => {
    const polls = [
      { status: 'PENDING', error: 'INJECTION_FAILED: TypeError: Failed to fetch', image_url: null },
      { status: 'PROCESSING', error: 'INJECTION_FAILED: TypeError: Failed to fetch', image_url: null },
      { status: 'COMPLETED', error: null, image_url: 'https://cdn/out.webp' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => json({ job_id: 'j', ...polls.shift() })));

    await expect(client().waitForCompletion('j')).resolves.toBe('https://cdn/out.webp');
  });

  it('stops as soon as the service says the job is finished failing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      json({ job_id: 'j', status: 'FAILED', error: 'INVALID_ARGUMENT', image_url: null }),
    ));

    await expect(client().waitForCompletion('j')).rejects.toThrow(/FAILED: INVALID_ARGUMENT/);
  });

  it('still gives up when the attempts run out, and says what the last try hit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      json({ job_id: 'j', status: 'PENDING', error: 'HTTP 503', image_url: null }),
    ));

    await expect(client().waitForCompletion('j')).rejects.toThrow(/did not complete.*HTTP 503/s);
  });
});

describe('an image that follows a photo', () => {
  it('sends the reference urls only when there are any', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ job_id: 'J1' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new ImageClient({ baseUrl: 'http://img', apiKey: 'k', pollIntervalMs: 1, maxAttempts: 1 });

    await client.submit('soup', 'VERTICAL');
    await client.submit('the same soup', 'VERTICAL', { referenceUrls: ['https://a/f.webp'] });

    expect(bodies[0]).not.toHaveProperty('reference_urls');
    expect(bodies[1]).toMatchObject({ reference_urls: ['https://a/f.webp'] });
    vi.unstubAllGlobals();
  });
});
