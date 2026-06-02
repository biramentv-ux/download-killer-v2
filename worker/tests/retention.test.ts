import { describe, expect, it } from 'vitest';

import { shouldRunRetentionCleanup } from '../src/retention';

describe('retention cron selector', () => {
  it('runs on daily wall-clock cron only', () => {
    expect(shouldRunRetentionCleanup('17 3 * * *')).toBe(true);
    expect(shouldRunRetentionCleanup('*/5 * * * *')).toBe(false);
    expect(shouldRunRetentionCleanup('* * * * *')).toBe(false);
    expect(shouldRunRetentionCleanup(undefined)).toBe(false);
  });
});
