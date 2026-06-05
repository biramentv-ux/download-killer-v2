import { describe, expect, it } from 'vitest';

import {
  compareAudioAnalyses,
  normalizeAudioAnalysis,
  normalizeAudioNormalizationMode,
  normalizeNormalizationTargetLufs,
} from '../src/audioProcessing';

describe('audio processing helpers', () => {
  it('normalizes supported audio normalization modes', () => {
    expect(normalizeAudioNormalizationMode('off')).toBe('off');
    expect(normalizeAudioNormalizationMode('replay-gain')).toBe('replaygain');
    expect(normalizeAudioNormalizationMode('R128')).toBe('ebu_r128');
    expect(normalizeAudioNormalizationMode('unexpected')).toBe('off');
  });

  it('clamps LUFS target only when normalization is enabled', () => {
    expect(normalizeNormalizationTargetLufs(-30, 'ebu_r128')).toBe(-24);
    expect(normalizeNormalizationTargetLufs(-8, 'replaygain')).toBe(-10);
    expect(normalizeNormalizationTargetLufs(undefined, 'replaygain')).toBe(-18);
    expect(normalizeNormalizationTargetLufs(-14, 'off')).toBeNull();
  });

  it('parses downloader analysis JSON and derives bitrate kbps', () => {
    const analysis = normalizeAudioAnalysis(JSON.stringify({
      codec: 'flac',
      bit_rate: 9216000,
      sample_rate: 192000,
      channels: 2,
    }));

    expect(analysis?.codec).toBe('flac');
    expect(analysis?.bit_rate_kbps).toBe(9216);
    expect(analysis?.sample_rate).toBe(192000);
  });

  it('selects the higher quality side by bitrate and dynamic range', () => {
    const comparison = compareAudioAnalyses(
      {
        codec: 'mp3',
        bit_rate_kbps: 128,
        sample_rate: 44100,
        channels: 2,
        dynamic_range_db: 5,
        loudness_lufs: -9,
      },
      {
        codec: 'flac',
        bit_rate_kbps: 900,
        sample_rate: 48000,
        channels: 2,
        dynamic_range_db: 12,
        loudness_lufs: -14,
      },
    );

    expect(comparison.winner).toBe('right');
    expect(comparison.score.right).toBeGreaterThan(comparison.score.left);
    expect(comparison.deltas.bit_rate_kbps).toBe(772);
  });
});
