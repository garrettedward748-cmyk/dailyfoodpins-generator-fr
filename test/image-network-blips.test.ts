import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageClient, isNetworkBlip } from '../src/integrations/images.js';

afterEach(() => vi.unstubAllGlobals());

const client = () =>
  new ImageClient({ baseUrl: 'http://imagegen', apiKey: 'k', pollIntervalMs: 1, maxAttempts: 10 } as never);

describe('a dropped connection to the image service', () => {
  it('is told apart from an answer', () => {
    expect(isNetworkBlip(new TypeError('fetch failed'))).toBe(true);
    expect(isNetworkBlip(new Error('Image job x failed with status FAILED: boom'))).toBe(false);
  });

  it('does not fail an image that is still being made', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls === 2) throw new TypeError('fetch failed');
      const body = calls < 3 ? { status: 'PROCESSING' } : { status: 'COMPLETED', image_url: 'https://img/x.jpg' };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const waiting = client().waitForCompletion('job-1');
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(waiting).resolves.toBe('https://img/x.jpg');
    vi.useRealTimers();
  });
});
