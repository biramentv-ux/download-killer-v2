import { describe, expect, it } from 'vitest';

import {
  createDownloadToken,
  createJobFingerprint,
  detectRequestThreat,
  formatPlaylistRelPath,
  validateDownloadUrlPolicy,
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

  it('restricts download URLs to supported media domains by default', () => {
    const env = {} as never;
    expect(validateDownloadUrlPolicy('https://www.youtube.com/watch?v=x', env).allowed).toBe(true);
    expect(validateDownloadUrlPolicy('https://open.spotify.com/track/x', env).allowed).toBe(true);
    expect(validateDownloadUrlPolicy('https://soundcloud.com/artist/track', env).allowed).toBe(true);
    expect(validateDownloadUrlPolicy('https://example.com/arbitrary.bin', env).allowed).toBe(false);
  });

  it('supports an explicit download URL allowlist override', () => {
    const env = { DOWNLOAD_URL_ALLOWLIST: 'media.example' } as never;
    expect(validateDownloadUrlPolicy('https://media.example/file.mp3', env).allowed).toBe(true);
    expect(validateDownloadUrlPolicy('https://www.youtube.com/watch?v=x', env).allowed).toBe(false);
  });
});

describe('utils request threat detection', () => {
  it('blocks path traversal probes in query strings', () => {
    const threat = detectRequestThreat(new Request('https://dyrakarmy.online/api/search?file=../secret'));
    expect(threat.blocked).toBe(true);
    expect(threat.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  it('blocks SQL injection probes on sensitive API routes', () => {
    const threat = detectRequestThreat(new Request('https://dyrakarmy.online/api/search?q=1%20union%20select%20password'));
    expect(threat.blocked).toBe(true);
    expect(threat.code).toBe('SQLI_BLOCKED');
  });

  it('blocks common scraping user agents on API routes', () => {
    const threat = detectRequestThreat(new Request('https://dyrakarmy.online/api/formats', {
      headers: { 'User-Agent': 'python-requests/2.32' },
    }));
    expect(threat.blocked).toBe(true);
    expect(threat.code).toBe('SCRAPER_UA_BLOCKED');
  });
});

describe('utils playlist paths', () => {
  it('builds stable structured playlist paths', () => {
    expect(formatPlaylistRelPath('My Playlist', 3, 'Song / One', 'Artist:Name', 'mp3', 120)).toEqual({
      folder: 'My Playlist',
      filename: '003 - Artist Name - Song One.mp3',
      relpath: 'My Playlist/003 - Artist Name - Song One.mp3',
    });
  });
});
