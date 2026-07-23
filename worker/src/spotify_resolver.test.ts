import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSourceResult } from './source_discovery';

const mocks = vi.hoisted(() => ({
  results: [] as UnifiedSourceResult[],
  sourceDiscovery: vi.fn(),
}));

vi.mock('./source_discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source_discovery')>();
  return {
    ...actual,
    handleSourceDiscoveryApi: mocks.sourceDiscovery,
  };
});

import {
  chooseSpotifyResolverDecision,
  extractSpotifyTrackUrl,
  handleSpotifyTelegramResolverWebhook,
  hasExplicitSpotifyResolverRights,
  scoreSpotifyResolverCandidate,
  spotifyTextSimilarity,
  type SpotifyResolverEnv,
  type SpotifyTrackMetadata,
} from './spotify_resolver';

const SPOTIFY_URL = 'https://open.spotify.com/track/0xCX7a8DSq9idNOaAVI375';

function metadata(): SpotifyTrackMetadata {
  return {
    spotify_id: '0xCX7a8DSq9idNOaAVI375',
    title: 'Темна ли е мъгла паднала',
    artists: ['Slavi Trifonov', 'Ku-Ku Band', 'Nina Nikolina'],
    artist: 'Slavi Trifonov, Ku-Ku Band, Nina Nikolina',
    duration_ms: 228_226,
    album: 'Roma e necha',
    playback_url: SPOTIFY_URL,
    metadata_source: 'spotify_web_api',
  };
}

function candidate(overrides: Partial<UnifiedSourceResult> = {}): UnifiedSourceResult {
  return {
    id: 'archive:track',
    title: 'Тъмна ли е мъгла паднала',
    artist: 'Slavi Trifonov, Ku-Ku Band, Nina Nikolina',
    album: 'Roma e necha',
    duration: 228,
    source: 'internet_archive',
    url: 'https://archive.org/download/example/track.flac',
    delivery: 'direct',
    downloadable: true,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    rights_notice: 'Creative Commons Attribution',
    ...overrides,
  };
}

function env(overrides: Partial<SpotifyResolverEnv> = {}): SpotifyResolverEnv {
  return {
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    TELEGRAM_SECRET_TOKEN: 'test-webhook-secret',
    DOWNLOADER_API_URL: 'http://127.0.0.1:8081',
    DOWNLOADER_API_KEY: 'test-downloader-key',
    DOWNLOAD_TOKEN_SECRET: 'test-download-token',
    PUBLIC_BASE_URL: 'https://dyrakarmy-dyrakarmy-platform.hf.space',
    ...overrides,
  } as SpotifyResolverEnv;
}

function webhookRequest(text: string): Request {
  return new Request('https://space.example/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret',
    },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 2,
        chat: { id: 12345, type: 'private' },
        from: { id: 12345, first_name: 'Test' },
        text,
      },
    }),
  });
}

beforeEach(() => {
  mocks.results = [];
  mocks.sourceDiscovery.mockReset();
  mocks.sourceDiscovery.mockImplementation(async () => Response.json({ ok: true, results: mocks.results }));
  vi.restoreAllMocks();
});

describe('Spotify multi-source confidence resolver', () => {
  it('extracts canonical Spotify track URLs from URL and URI input', () => {
    expect(extractSpotifyTrackUrl(`${SPOTIFY_URL}?si=test`)).toBe(SPOTIFY_URL);
    expect(extractSpotifyTrackUrl('spotify:track:0xCX7a8DSq9idNOaAVI375')).toBe(SPOTIFY_URL);
    expect(extractSpotifyTrackUrl('https://open.spotify.com/album/example')).toBeNull();
  });

  it('keeps the Bulgarian Темна/Тъмна spelling variant highly similar', () => {
    expect(spotifyTextSimilarity('Темна ли е мъгла паднала', 'Тъмна ли е мъгла паднала')).toBeGreaterThan(0.9);
  });

  it('automatically selects only an authorized high-confidence match', () => {
    const scored = scoreSpotifyResolverCandidate(metadata(), candidate());
    expect(scored.score).toBeGreaterThanOrEqual(88);
    expect(scored.authorized).toBe(true);
    const decision = chooseSpotifyResolverDecision(metadata(), [candidate()]);
    expect(decision.action).toBe('download');
    expect(decision.selected?.source).toBe('internet_archive');
  });

  it('never auto-selects a result with generic or denied rights', () => {
    const row = candidate({
      source: 'youtube',
      delivery: 'resolver',
      license: 'Standard YouTube License',
      rights_notice: 'All rights reserved',
    });
    const scored = scoreSpotifyResolverCandidate(metadata(), row);
    expect(scored.authorized).toBe(false);
    expect(chooseSpotifyResolverDecision(metadata(), [row]).action).not.toBe('download');
    expect(hasExplicitSpotifyResolverRights(row.license, row.rights_notice)).toBe(false);
  });

  it('penalizes cover/live/remix variants not present in the Spotify target', () => {
    const exact = scoreSpotifyResolverCandidate(metadata(), candidate());
    const variant = scoreSpotifyResolverCandidate(metadata(), candidate({ title: 'Темна ли е мъгла паднала live cover remix' }));
    expect(variant.score).toBeLessThan(exact.score);
    expect(variant.warnings.some((warning) => warning.startsWith('variant:'))).toBe(true);
  });

  it('returns Spotify playback in Telegram without creating a failed job when no source qualifies', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/oembed?')) {
        return Response.json({ title: 'Темна ли е мъгла паднала', thumbnail_url: 'https://image.example/cover.jpg' });
      }
      if (url === SPOTIFY_URL) {
        return new Response('<meta property="og:description" content="Slavi Trifonov · Song">', { status: 200 });
      }
      if (url.includes('/sendMessage')) return Response.json({ ok: true, result: { message_id: 10 } });
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await handleSpotifyTelegramResolverWebhook(webhookRequest(SPOTIFY_URL), env());
    expect(result?.response).toBeDefined();
    const payload = await result!.response!.json() as Record<string, unknown>;
    expect(payload.spotify_resolver).toBe('playback');
    expect(payload.queued).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/sendMessage'))).toBe(true);
  });

  it('rewrites Telegram to the authorized external source when confidence is high', async () => {
    mocks.results = [candidate()];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('accounts.spotify.com/api/token')) return Response.json({ access_token: 'spotify-token' });
      if (url.includes('api.spotify.com/v1/tracks/')) {
        return Response.json({
          id: '0xCX7a8DSq9idNOaAVI375',
          name: 'Темна ли е мъгла паднала',
          duration_ms: 228226,
          artists: [
            { name: 'Slavi Trifonov' },
            { name: 'Ku-Ku Band' },
            { name: 'Nina Nikolina' },
          ],
          album: { name: 'Roma e necha', release_date: '1999', images: [] },
          external_ids: {},
          preview_url: null,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await handleSpotifyTelegramResolverWebhook(
      webhookRequest(SPOTIFY_URL),
      env({ SPOTIFY_CLIENT_ID: 'client-id', SPOTIFY_CLIENT_SECRET: 'client-secret' }),
    );
    expect(result?.response).toBeUndefined();
    expect(result?.request).toBeDefined();
    const rewritten = await result!.request!.json() as { message?: { text?: string } };
    expect(rewritten.message?.text).toBe(candidate().url);
    expect(result!.request!.headers.get('X-DyrakArmy-Resolver-Confidence')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/sendMessage'))).toBe(false);
  });
});
