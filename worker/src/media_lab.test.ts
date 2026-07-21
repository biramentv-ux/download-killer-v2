import { describe, expect, it } from 'vitest';
import { parseContentDispositionFilename, rankMediaCandidates } from './media_lab';

describe('rankMediaCandidates', () => {
  it('ranks the closest cross-source match first', () => {
    const results = rankMediaCandidates(
      {
        title: 'Midnight Signal',
        artist: 'Neon Array',
        album: 'Night Systems',
        duration: 241,
        source: 'spotify',
      },
      [
        {
          id: 'weak',
          title: 'Signal in the Morning Live',
          artist: 'Another Artist',
          album: 'Concert',
          duration: 319,
          source: 'youtube',
          url: 'https://example.com/weak',
        },
        {
          id: 'strong',
          title: 'Midnight Signal (Official Audio)',
          artist: 'Neon Array',
          album: 'Night Systems',
          duration: 243,
          source: 'youtube',
          url: 'https://example.com/strong',
        },
      ],
    );

    expect(results[0]?.id).toBe('strong');
    expect(results[0]?.score).toBeGreaterThanOrEqual(80);
    expect(results[0]?.confidence).toBe('high');
    expect(results[0]?.reasons).toContain('alternate-source');
  });

  it('penalizes a large duration mismatch', () => {
    const [close, far] = rankMediaCandidates(
      { title: 'Same Song', artist: 'Same Artist', duration: 200, source: 'spotify' },
      [
        { id: 'close', title: 'Same Song', artist: 'Same Artist', duration: 202, source: 'youtube' },
        { id: 'far', title: 'Same Song', artist: 'Same Artist', duration: 520, source: 'youtube' },
      ],
    );

    expect(close?.id).toBe('close');
    expect((close?.score ?? 0)).toBeGreaterThan(far?.score ?? 0);
  });
});

describe('parseContentDispositionFilename', () => {
  it('decodes RFC 5987 filename values', () => {
    expect(parseContentDispositionFilename(
      "attachment; filename*=UTF-8''Neon%20Array%20-%20Signal.flac",
      'https://example.com/download',
    )).toBe('Neon Array - Signal.flac');
  });

  it('falls back to the final URL segment and sanitizes it', () => {
    expect(parseContentDispositionFilename(null, 'https://example.com/audio/My%20Track.mp3'))
      .toBe('My Track.mp3');
  });
});
