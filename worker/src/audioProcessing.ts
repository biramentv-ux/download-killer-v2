export type AudioNormalizationMode = 'off' | 'replaygain' | 'ebu_r128';

export interface AudioAnalysis {
  codec?: string | null;
  container?: string | null;
  bit_rate?: number | null;
  bit_rate_kbps?: number | null;
  sample_rate?: number | null;
  channels?: number | null;
  duration?: number | null;
  loudness_lufs?: number | null;
  loudness_range_lu?: number | null;
  dynamic_range_db?: number | null;
  true_peak_dbfs?: number | null;
  mean_volume_db?: number | null;
  max_volume_db?: number | null;
}

export interface AudioComparisonResult {
  winner: 'left' | 'right' | 'tie';
  score: {
    left: number;
    right: number;
    delta: number;
  };
  deltas: {
    bit_rate_kbps: number | null;
    sample_rate: number | null;
    dynamic_range_db: number | null;
    loudness_lufs: number | null;
    true_peak_dbfs: number | null;
  };
  summary: string;
  notes: string[];
}

export function normalizeAudioNormalizationMode(raw: unknown): AudioNormalizationMode {
  const value = String(raw ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (value === 'replaygain' || value === 'replay_gain') return 'replaygain';
  if (value === 'ebu_r128' || value === 'r128' || value === 'loudnorm') return 'ebu_r128';
  return 'off';
}

export function normalizeNormalizationTargetLufs(raw: unknown, mode: AudioNormalizationMode): number | null {
  if (mode === 'off') return null;
  const fallback = mode === 'replaygain' ? -18 : -14;
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(-10, Math.max(-24, Math.round(parsed * 10) / 10));
}

export function normalizeAudioAnalysis(raw: unknown): AudioAnalysis | null {
  if (!raw) return null;
  let source: unknown = raw;
  if (typeof raw === 'string') {
    try {
      source = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!source || typeof source !== 'object') return null;
  const record = source as Record<string, unknown>;
  const bitRate = finiteNumber(record.bit_rate);
  const bitRateKbps = finiteNumber(record.bit_rate_kbps)
    ?? (bitRate ? Math.round(bitRate / 1000) : null);

  return {
    codec: stringOrNull(record.codec),
    container: stringOrNull(record.container),
    bit_rate: bitRate,
    bit_rate_kbps: bitRateKbps,
    sample_rate: finiteNumber(record.sample_rate),
    channels: finiteNumber(record.channels),
    duration: finiteNumber(record.duration),
    loudness_lufs: finiteNumber(record.loudness_lufs),
    loudness_range_lu: finiteNumber(record.loudness_range_lu),
    dynamic_range_db: finiteNumber(record.dynamic_range_db),
    true_peak_dbfs: finiteNumber(record.true_peak_dbfs),
    mean_volume_db: finiteNumber(record.mean_volume_db),
    max_volume_db: finiteNumber(record.max_volume_db),
  };
}

export function compareAudioAnalyses(leftRaw: unknown, rightRaw: unknown): AudioComparisonResult {
  const left = normalizeAudioAnalysis(leftRaw);
  const right = normalizeAudioAnalysis(rightRaw);
  const leftScore = scoreAudioAnalysis(left);
  const rightScore = scoreAudioAnalysis(right);
  const delta = Math.round((rightScore - leftScore) * 10) / 10;
  const winner = Math.abs(delta) < 2 ? 'tie' : delta > 0 ? 'right' : 'left';
  const notes: string[] = [];

  const bitrateDelta = diffNumber(right?.bit_rate_kbps, left?.bit_rate_kbps);
  if (bitrateDelta !== null && Math.abs(bitrateDelta) >= 32) {
    notes.push(`${bitrateDelta > 0 ? 'Right' : 'Left'} has higher bitrate by ${Math.abs(bitrateDelta)} kbps.`);
  }

  const drDelta = diffNumber(right?.dynamic_range_db, left?.dynamic_range_db);
  if (drDelta !== null && Math.abs(drDelta) >= 1) {
    notes.push(`${drDelta > 0 ? 'Right' : 'Left'} keeps wider dynamic range by ${Math.abs(round1(drDelta))} dB.`);
  }

  const peakDelta = diffNumber(right?.true_peak_dbfs, left?.true_peak_dbfs);
  if (peakDelta !== null && Math.abs(peakDelta) >= 1) {
    notes.push(`${peakDelta > 0 ? 'Right' : 'Left'} peaks closer to 0 dBFS by ${Math.abs(round1(peakDelta))} dB.`);
  }

  if (!notes.length) {
    notes.push('Both versions are close by the available bitrate, sample-rate and loudness metrics.');
  }

  return {
    winner,
    score: {
      left: round1(leftScore),
      right: round1(rightScore),
      delta,
    },
    deltas: {
      bit_rate_kbps: bitrateDelta,
      sample_rate: diffNumber(right?.sample_rate, left?.sample_rate),
      dynamic_range_db: drDelta === null ? null : round1(drDelta),
      loudness_lufs: diffNumber(right?.loudness_lufs, left?.loudness_lufs),
      true_peak_dbfs: peakDelta === null ? null : round1(peakDelta),
    },
    summary: winner === 'tie'
      ? 'Versions are effectively tied by the available quality metrics.'
      : `${winner === 'right' ? 'Right' : 'Left'} version looks better by the available quality metrics.`,
    notes,
  };
}

function scoreAudioAnalysis(analysis: AudioAnalysis | null): number {
  if (!analysis) return 0;
  const kbps = analysis.bit_rate_kbps ?? 0;
  const sampleRate = analysis.sample_rate ?? 0;
  const channels = analysis.channels ?? 0;
  const dynamicRange = analysis.dynamic_range_db ?? analysis.loudness_range_lu ?? 0;
  const peak = analysis.true_peak_dbfs ?? analysis.max_volume_db ?? null;
  const loudness = analysis.loudness_lufs ?? null;

  const bitrateScore = Math.min(35, kbps <= 0 ? 0 : (kbps / 320) * 35);
  const sampleRateScore = sampleRate >= 96_000 ? 15 : sampleRate >= 48_000 ? 14 : sampleRate >= 44_100 ? 12 : sampleRate > 0 ? 8 : 0;
  const channelScore = channels >= 2 ? 10 : channels === 1 ? 6 : 0;
  const dynamicsScore = Math.min(25, Math.max(0, ((dynamicRange - 4) / 10) * 25));
  const peakScore = peak === null ? 5 : peak <= -0.5 && peak >= -6 ? 10 : peak > -0.5 ? 5 : 7;
  const loudnessScore = loudness === null ? 5 : loudness <= -10 && loudness >= -23 ? 5 : 2;

  return Math.max(0, Math.min(100, bitrateScore + sampleRateScore + channelScore + dynamicsScore + peakScore + loudnessScore));
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function diffNumber(right: number | null | undefined, left: number | null | undefined): number | null {
  if (right === null || right === undefined || left === null || left === undefined) return null;
  if (!Number.isFinite(right) || !Number.isFinite(left)) return null;
  return round1(right - left);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
