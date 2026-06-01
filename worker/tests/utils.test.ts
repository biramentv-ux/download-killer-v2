import { describe, expect, it } from 'vitest';

import {
  createDownloadToken,
  createJobFingerprint,
  verifyDownloadToken,
} from '../src/utils';

describe('utils token helpers', () => {
  it('creates and verifies token', async () => {
    const token = await createDownloadToken({
      jobId: 'job-1',
      exp: Math.floor(Date.now() / 1000) + 60,
    }, 'secret');

    const payload = await verifyDownloadToken(token, 'secret');
    expect(payload?.jobId).toBe('job-1');
    expect(payload?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects invalid signature', async () => {
    const token = await createDownloadToken({
      jobId: 'job-1',
      exp: Math.floor(Date.now() / 1000) + 60,
    }, 'secret');

    const payload = await verifyDownloadToken(token, 'different-secret');
    expect(payload).toBeNull();
  });
});

describe('utils fingerprint', () => {
  it('returns deterministic fingerprint', async () => {
    const left = await createJobFingerprint('https://example.com/x', 'mp3', '320');
    const right = await createJobFingerprint('https://example.com/x', 'mp3', '320');
    expect(left).toHaveLength(64);
    expect(left).toBe(right);
  });
});
