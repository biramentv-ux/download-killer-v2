import { describe, expect, it } from 'vitest';
import { mergeAndRankSourceResults, sourceCatalog, type UnifiedSourceResult } from './source_discovery';

function result(overrides: Partial<UnifiedSourceResult>): UnifiedSourceResult {
  return {
    id: 'id',
    title: 'Open Track',
    artist: 'Artist',
    duration: 120,
    source: 'youtube',
    url: 'https://example.com/audio',
    delivery: 'resolver',
    downloadable: true,
    rights_notice: 'Authorized content only',
    ...overrides,
  };
}

describe('source discovery v18', () => {
  it('exposes more than the original six source families', () => {
    const catalog = sourceCatalog({ AUDIUS_API_KEY: 'configured', JAMENDO_CLIENT_ID: 'configured' });
    expect(catalog.length).toBeGreaterThanOrEqual(12);
    expect(catalog.find((item) => item.id === 'internet_archive')?.mode).toBe('direct');
    expect(catalog.find((item) => item.id === 'wikimedia_commons')?.mode).toBe('direct');
    expect(catalog.find((item) => item.id === 'musicbrainz')?.mode).toBe('metadata');
    expect(catalog.find((item) => item.id === 'audius')?.enabled).toBe(true);
    expect(catalog.find((item) => item.id === 'jamendo')?.enabled).toBe(true);
  });

  it('keeps direct authorized files ahead of metadata-only rows and removes duplicates', () => {
    const rows = mergeAndRankSourceResults([
      result({ id: 'metadata', delivery: 'metadata', downloadable: false, source: 'musicbrainz', url: 'https://musicbrainz.org/recording/1' }),
      result({ id: 'resolver', delivery: 'resolver', source: 'youtube', url: 'https://youtube.com/watch?v=1' }),
      result({ id: 'direct', delivery: 'direct', source: 'internet_archive', url: 'https://archive.org/download/item/song.mp3' }),
      result({ id: 'direct-copy', delivery: 'direct', source: 'internet_archive', url: 'https://archive.org/download/item/song.mp3' }),
    ], 10);
    expect(rows.map((row) => row.id)).toEqual(['direct', 'resolver', 'metadata']);
  });
});
