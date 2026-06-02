import { describe, expect, it } from 'vitest';

import {
  calculateQueueRetryBaseDelaySeconds,
  calculateQueueRetryDelaySeconds,
} from '../src/retry';

describe('queue retry backoff', () => {
  it('uses exponential base delays with a 15 minute cap', () => {
    expect(calculateQueueRetryBaseDelaySeconds(1)).toBe(30);
    expect(calculateQueueRetryBaseDelaySeconds(2)).toBe(60);
    expect(calculateQueueRetryBaseDelaySeconds(3)).toBe(120);
    expect(calculateQueueRetryBaseDelaySeconds(4)).toBe(240);
    expect(calculateQueueRetryBaseDelaySeconds(5)).toBe(480);
    expect(calculateQueueRetryBaseDelaySeconds(6)).toBe(900);
    expect(calculateQueueRetryBaseDelaySeconds(20)).toBe(900);
  });

  it('adds bounded positive jitter before the cap', () => {
    expect(calculateQueueRetryDelaySeconds(1, { random: () => 0 })).toBe(30);
    expect(calculateQueueRetryDelaySeconds(1, { random: () => 1 })).toBe(36);
    expect(calculateQueueRetryDelaySeconds(3, { random: () => 0 })).toBe(120);
    expect(calculateQueueRetryDelaySeconds(3, { random: () => 1 })).toBe(144);
  });

  it('jitters capped retries without exceeding the maximum delay', () => {
    expect(calculateQueueRetryDelaySeconds(6, { random: () => 0 })).toBe(720);
    expect(calculateQueueRetryDelaySeconds(6, { random: () => 1 })).toBe(900);
    expect(calculateQueueRetryDelaySeconds(50, { random: () => 1 })).toBe(900);
  });

  it('can disable jitter for deterministic operations', () => {
    expect(calculateQueueRetryDelaySeconds(4, { jitterPercent: 0, random: () => 1 })).toBe(240);
  });
});
