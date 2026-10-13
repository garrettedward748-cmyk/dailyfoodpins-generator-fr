import { describe, expect, it } from 'vitest';
import {
  EXTENSION_MISSING,
  SIGNED_OUT,
  imageServiceProblemFrom,
} from '../src/core/image-service-health.js';

/**
 * `connected: false` is what the image service says whenever Chrome is
 * stopped for want of work, which is most of the day. It was read as "sign in
 * again" and told people so all day long while they were signed in.
 */
describe('imageServiceProblemFrom', () => {
  it('says nothing while Chrome is stopped because nothing is queued', () => {
    const status = { connected: false, chrome: { wanted_running: false, always_on: false } };
    expect(imageServiceProblemFrom(status, { watchdog: { needs_human: false } }, 5)).toBeNull();
  });

  it('says nothing while the extension is connected', () => {
    expect(imageServiceProblemFrom({ connected: true }, null, 0)).toBeNull();
  });

  it('reports a signed-out browser only when the watchdog has seen the wall', () => {
    const walled = { watchdog: { needs_human: true, reason: 'Google signed this browser out.' } };
    expect(imageServiceProblemFrom({ connected: true }, walled, 0)).toBe(SIGNED_OUT);
  });

  it('waits a poll before calling a missing extension a problem', () => {
    const status = { connected: false, chrome: { wanted_running: true } };
    expect(imageServiceProblemFrom(status, null, 1)).toBeNull();
    expect(imageServiceProblemFrom(status, null, 2)).toBe(EXTENSION_MISSING);
  });

  it('treats a service that does not report Chrome as one where Chrome is always up', () => {
    expect(imageServiceProblemFrom({ connected: false }, null, 2)).toBe(EXTENSION_MISSING);
  });
});
