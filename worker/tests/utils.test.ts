import { describe, expect, it } from 'vitest';

import {
  createDownloadToken,
  createJobFingerprint,
  validateUrlPolicy,
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

describe('utils url policy', () => {
  it('blocks local network targets', () => {
    const env = {} as never;
    expect(validateUrlPolicy('http://127.0.0.1:8787/file', env).allowed).toBe(false);
    expect(validateUrlPolicy('http://192.168.1.5/file', env).allowed).toBe(false);
  });

  it('honors blocklist domains', () => {
    const env = { URL_BLOCKLIST: 'bad.example,*.evil.test' } as never;
    expect(validateUrlPolicy('https://bad.example/a', env).allowed).toBe(false);
    expect(validateUrlPolicy('https://x.evil.test/a', env).allowed).toBe(false);
    expect(validateUrlPolicy('https://youtube.com/watch?v=x', env).allowed).toBe(true);
  });

  it('honors allowlist domains', () => {
    const env = { URL_ALLOWLIST: 'youtube.com,*.spotify.com' } as never;
    expect(validateUrlPolicy('https://www.youtube.com/watch?v=x', env).allowed).toBe(true);
    expect(validateUrlPolicy('https://open.spotify.com/track/x', env).allowed).toBe(true);
    expect(validateUrlPolicy('https://example.com/x', env).allowed).toBe(false);
  });
});
