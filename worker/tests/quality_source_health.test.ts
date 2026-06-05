import { describe, expect, it } from 'vitest';

import { calculateQualityScore } from '../src/metadataQuality';
import { classifySourceError, handleRecommendSource } from '../src/sourceHealth';
import type { Env } from '../src/types';

class MemoryKv {
  private data = new Map<string, string>();

  async get(key: string, options?: unknown): Promise<unknown> {
    const value = this.data.get(key) ?? null;
    if (value === null) return null;
    if (typeof options === 'object' && options && (options as { type?: string }).type === 'json') {
      return JSON.parse(value);
    }
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

function envWithKv(kv: MemoryKv): Env {
  return {
    CACHE: kv as unknown as KVNamespace,
    DB: {} as D1Database,
    DOWNLOAD_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_SECRET_TOKEN: '',
    DOWNLOADER_API_URL: 'https://downloader.example',
    DOWNLOADER_API_KEY: 'test',
    DOWNLOAD_TOKEN_SECRET: 'secret',
  } as Env;
}

describe('metadata quality scoring', () => {
  it('grades complete lossless metadata as high quality', () => {
    const score = calculateQualityScore({
      id: 'job-1',
      title: 'Clean Track',
      artist: 'Known Artist',
      album: 'Known Album',
      genre: 'Electronic',
      release_year: '2026',
      track_number: 1,
      format: 'flac',
      quality: 'lossless',
      file_size: 48_000_000,
      duration: 240,
      thumbnail_url: 'https://img.example/maxresdefault.jpg',
      status: 'done',
    });

    expect(score.total).toBeGreaterThanOrEqual(90);
    expect(score.grade).toBe('A');
    expect(score.breakdown.thumbnail).toBe(25);
  });

  it('flags noisy low bitrate metadata', () => {
    const score = calculateQualityScore({
      id: 'job-2',
      title: 'TRACK TITLE (Official Video)',
      artist: 'ArtistVEVO',
      album: null,
      genre: null,
      release_year: null,
      track_number: null,
      format: 'mp3',
      quality: '96',
      file_size: 500_000,
      duration: 180,
      thumbnail_url: null,
      status: 'done',
    });

    expect(score.grade).not.toBe('A');
    expect(score.issues.join(' ')).toContain('No album artwork');
    expect(score.issues.join(' ')).toContain('low quality');
  });
});

describe('source health helpers', () => {
  it('classifies common provider failures', () => {
    expect(classifySourceError('429 too many requests')).toBe('rate_limited');
    expect(classifySourceError('Sign in to confirm you are not a bot')).toBe('blocked');
    expect(classifySourceError('504 Gateway Timeout')).toBe('server_error');
  });

  it('recommends a non-blocked source for a format', async () => {
    const kv = new MemoryKv();
    await kv.put('source_health:youtube', JSON.stringify({
      source: 'youtube',
      status: 'blocked',
      successRate: 0.1,
      avgResponseMs: 9000,
      totalAttempts: 10,
      failedAttempts: 9,
      backoffUntil: new Date(Date.now() + 60_000).toISOString(),
      errorBreakdown: { blocked: 9 },
      updatedAt: new Date().toISOString(),
    }));
    await kv.put('source_health:youtube_music', JSON.stringify({
      source: 'youtube_music',
      status: 'healthy',
      successRate: 0.95,
      avgResponseMs: 400,
      totalAttempts: 10,
      failedAttempts: 0,
      errorBreakdown: {},
      updatedAt: new Date().toISOString(),
    }));

    const response = await handleRecommendSource(
      new Request('https://dyrakarmy.online/api/health/recommend?format=opus&quality=256'),
      envWithKv(kv),
    );
    const payload = await response.json() as { recommended: string };
    expect(response.status).toBe(200);
    expect(payload.recommended).toBe('youtube_music');
  });
});
