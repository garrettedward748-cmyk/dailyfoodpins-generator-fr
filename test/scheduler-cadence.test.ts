import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../src/scheduler/index.js';
import type { Settings } from '../src/settings.js';

/**
 * "Check every (minutes)" takes effect when it is saved.
 *
 * It used to be read once at boot into a setInterval, so a change on the
 * Settings page did nothing until the container restarted -- and a site set
 * to post every 5 minutes kept posting every 15, because nobody was looking
 * in between.
 */

function fakeSettings(values: Record<string, number>): Settings {
  return {
    getNumber: (key: string) => values[key] ?? 0,
    get: () => '',
    getBool: () => false,
  } as unknown as Settings;
}

describe('scheduler cadence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('follows the setting as it changes, without a restart', async () => {
    const values = { tick_minutes: 15, retention_days: 30 };
    const ticks: number[] = [];
    const scheduler = new Scheduler(fakeSettings(values), Buffer.alloc(32), async () => {
      ticks.push(Date.now());
    });

    scheduler.start();
    // The first check comes shortly after boot, not a whole period later.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ticks).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(ticks).toHaveLength(2);

    // Someone saves 1 minute. The next check is a minute away, not fourteen.
    values.tick_minutes = 1;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ticks).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ticks).toHaveLength(4);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(ticks).toHaveLength(4);
  });

  it('never runs faster than once a minute, whatever is typed', async () => {
    const ticks: number[] = [];
    const scheduler = new Scheduler(
      fakeSettings({ tick_minutes: 0, retention_days: 30 }),
      Buffer.alloc(32),
      async () => {
        ticks.push(Date.now());
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000 + 30_000);
    expect(ticks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ticks).toHaveLength(2);
    scheduler.stop();
  });
});
