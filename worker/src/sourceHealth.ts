import type { Env } from './types';
import { getClientAddress, jsonError, jsonOk, rateLimit } from './utils';

export type SourceStatus = 'healthy' | 'degraded' | 'blocked' | 'unknown';

export interface SourceHealth {
  source: string;
  status: SourceStatus;
  successRate: number;
  avgResponseMs: number;
  totalAttempts: number;
  failedAttempts: number;
  lastSuccess?: string;
  lastFailure?: string;
  lastError?: string;
  backoffUntil?: string;
  errorBreakdown: Record<string, number>;
  updatedAt: string;
}

export interface SourceAttemptRecord {
  source: string;
  success: boolean;
  responseMs: number;
  error?: string;
  errorType?: string;
  timestamp?: string;
}

interface NormalizedSourceAttemptRecord extends SourceAttemptRecord {
  source: string;
  errorType: string;
  timestamp: string;
}

const ALL_SOURCES = [
  'youtube',
  'youtube_music',
  'soundcloud',
  'spotify',
  'deezer',
  'tidal',
  'qobuz',
  'apple',
  'amazon',
  'bandcamp',
  'podcast',
];

const SOURCE_HEALTH_TTL_SECONDS = 3_600;
const ALPHA = 0.2;

export function classifySourceError(error: string): string {
  if (/429|rate.?limit|quota/i.test(error)) return 'rate_limited';
  if (/403|blocked|sign in to confirm|not a bot/i.test(error)) return 'blocked';
  if (/404|not found/i.test(error)) return 'not_found';
  if (/500|502|503|504|bad gateway/i.test(error)) return 'server_error';
  if (/timeout|timed out|abort/i.test(error)) return 'timeout';
  if (/unavailable/i.test(error)) return 'unavailable';
  if (/private|restricted/i.test(error)) return 'restricted';
  return 'other';
}

export function recordSourceAttempt(attempt: SourceAttemptRecord, env: Env): void {
  const normalized = normalizeSourceId(attempt.source);
  const timestamp = attempt.timestamp ?? new Date().toISOString();
  const errorType = attempt.errorType ?? classifySourceError(attempt.error ?? '');

  try {
    env.ANALYTICS?.writeDataPoint({
      blobs: [
        'source_attempt',
        normalized,
        attempt.success ? 'success' : 'failure',
        errorType,
        (attempt.error ?? '').slice(0, 96),
      ],
      doubles: [Math.max(0, Math.round(attempt.responseMs)), attempt.success ? 1 : 0],
      indexes: [normalized],
    });
  } catch {
    // Analytics is best effort.
  }

  updateSourceHealthKV({
    ...attempt,
    source: normalized,
    timestamp,
    errorType,
  }, env).catch(() => undefined);
}

export async function handleSourcesHealth(request: Request, env: Env): Promise<Response> {
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `source-health:${ip}`, 60, 60);
  if (rl.limited) return jsonError(request, env, 'RATE_LIMITED', 'Too many source health requests', 429, true);

  const healths = await Promise.all(ALL_SOURCES.map((source) => readHealth(env, source)));
  const sorted = healths.sort((a, b) => statusPriority(a.status) - statusPriority(b.status));
  return jsonOk(request, env, {
    overall: computeOverallStatus(sorted),
    sources: sorted,
    recommendations: buildRecommendations(sorted),
    updated_at: new Date().toISOString(),
  });
}

export async function handleSourceDetail(request: Request, env: Env, source: string): Promise<Response> {
  const normalized = normalizeSourceId(source);
  if (!ALL_SOURCES.includes(normalized)) {
    return jsonError(request, env, 'UNKNOWN_SOURCE', 'Unknown source', 404);
  }
  const health = await readHealth(env, normalized);
  const backedOff = Boolean(health.backoffUntil && new Date(health.backoffUntil).getTime() > Date.now());
  return jsonOk(request, env, {
    ...health,
    is_backed_off: backedOff,
    time_until_retry_seconds: backedOff
      ? Math.max(0, Math.round((new Date(health.backoffUntil!).getTime() - Date.now()) / 1000))
      : 0,
  });
}

export async function resetSourceHealth(env: Env, source: string): Promise<SourceHealth | null> {
  const normalized = normalizeSourceId(source);
  if (!ALL_SOURCES.includes(normalized)) return null;
  const next = defaultHealth(normalized);
  next.status = 'healthy';
  next.successRate = 0.8;
  next.updatedAt = new Date().toISOString();
  await env.CACHE.put(sourceHealthKey(normalized), JSON.stringify(next), { expirationTtl: SOURCE_HEALTH_TTL_SECONDS });
  return next;
}

export async function handleRecommendSource(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const format = String(url.searchParams.get('format') ?? 'mp3').trim().toLowerCase();
  const quality = String(url.searchParams.get('quality') ?? '320').trim().toLowerCase();
  const candidates = getFormatCandidates(format);
  const healths = await Promise.all(candidates.map((source) => readHealth(env, source)));
  const now = Date.now();
  const viable = candidates
    .map((source, index) => ({ source, health: healths[index] ?? defaultHealth(source) }))
    .filter(({ health }) => {
      if (health.status !== 'blocked') return true;
      return health.backoffUntil ? new Date(health.backoffUntil).getTime() <= now : false;
    })
    .sort((a, b) => scoreHealthForRecommendation(b.health) - scoreHealthForRecommendation(a.health));

  return jsonOk(request, env, {
    recommended: viable[0]?.source ?? candidates[0],
    alternatives: viable.slice(1).map((entry) => entry.source),
    format,
    quality,
  });
}

async function updateSourceHealthKV(attempt: NormalizedSourceAttemptRecord, env: Env): Promise<void> {
  const key = sourceHealthKey(attempt.source);
  const existing = await env.CACHE.get(key, { type: 'json' }) as SourceHealth | null;
  const health = existing ?? defaultHealth(attempt.source);
  health.totalAttempts += 1;
  health.avgResponseMs = Math.round(
    ALPHA * Math.max(0, attempt.responseMs) + (1 - ALPHA) * (health.avgResponseMs || Math.max(0, attempt.responseMs)),
  );
  health.updatedAt = new Date().toISOString();

  if (attempt.success) {
    health.lastSuccess = attempt.timestamp;
    health.successRate = Math.min(1, ALPHA * 1 + (1 - ALPHA) * health.successRate);
  } else {
    health.failedAttempts += 1;
    health.lastFailure = attempt.timestamp;
    health.lastError = attempt.error;
    health.successRate = Math.max(0, (1 - ALPHA) * health.successRate);
    health.errorBreakdown[attempt.errorType] = (health.errorBreakdown[attempt.errorType] ?? 0) + 1;
  }

  health.status = determineStatus(health);
  if (health.status === 'blocked') {
    const shouldSetBackoff = !health.backoffUntil || new Date(health.backoffUntil).getTime() <= Date.now();
    if (shouldSetBackoff) {
      const minutes = calculateBackoffMinutes(health.errorBreakdown);
      health.backoffUntil = new Date(Date.now() + minutes * 60_000).toISOString();
    }
  } else {
    delete health.backoffUntil;
  }

  await env.CACHE.put(key, JSON.stringify(health), { expirationTtl: SOURCE_HEALTH_TTL_SECONDS });
}

async function readHealth(env: Env, source: string): Promise<SourceHealth> {
  const normalized = normalizeSourceId(source);
  const health = await env.CACHE.get(sourceHealthKey(normalized), { type: 'json' }) as SourceHealth | null;
  return health ?? defaultHealth(normalized);
}

function sourceHealthKey(source: string): string {
  return `source_health:${source}`;
}

function defaultHealth(source: string): SourceHealth {
  return {
    source,
    status: 'unknown',
    successRate: 1,
    avgResponseMs: 0,
    totalAttempts: 0,
    failedAttempts: 0,
    errorBreakdown: {},
    updatedAt: new Date().toISOString(),
  };
}

function determineStatus(health: SourceHealth): SourceStatus {
  if (health.totalAttempts < 3) return 'unknown';
  if (health.successRate >= 0.8) return 'healthy';
  if (health.successRate >= 0.5) return 'degraded';
  return 'blocked';
}

function calculateBackoffMinutes(errors: Record<string, number>): number {
  const total = Object.values(errors).reduce((sum, value) => sum + value, 0);
  return Math.min(40, 5 * Math.pow(2, Math.floor(total / 5)));
}

function computeOverallStatus(sources: SourceHealth[]): SourceStatus {
  const known = sources.filter((source) => source.status !== 'unknown');
  if (!known.length) return 'unknown';
  const healthy = known.filter((source) => source.status === 'healthy').length;
  const ratio = healthy / known.length;
  if (ratio >= 0.7) return 'healthy';
  if (ratio >= 0.4) return 'degraded';
  return 'blocked';
}

function buildRecommendations(sources: SourceHealth[]): string[] {
  const recs: string[] = [];
  const blocked = sources.filter((source) => source.status === 'blocked');
  const degraded = sources.filter((source) => source.status === 'degraded');
  if (blocked.length) recs.push(`${blocked.map((source) => source.source).join(', ')} rate limited or blocked; use fallback sources.`);
  if (degraded.length) recs.push(`${degraded.map((source) => source.source).join(', ')} degraded; prefer alternatives until recovery.`);
  if (!blocked.length && !degraded.length) recs.push('All tracked sources are operating normally or do not have enough data yet.');
  return recs;
}

function getFormatCandidates(format: string): string[] {
  const candidates: Record<string, string[]> = {
    flac: ['qobuz', 'tidal', 'deezer', 'youtube_music'],
    wav: ['qobuz', 'tidal', 'deezer', 'youtube_music'],
    opus: ['youtube', 'youtube_music'],
    ogg: ['spotify', 'youtube'],
    m4a: ['apple', 'amazon', 'youtube_music'],
    mp3: ['youtube', 'youtube_music', 'soundcloud', 'deezer'],
  };
  return candidates[format] ?? candidates.mp3!;
}

function scoreHealthForRecommendation(health: SourceHealth): number {
  const statusScore = health.status === 'healthy'
    ? 1
    : health.status === 'unknown'
      ? 0.8
      : health.status === 'degraded'
        ? 0.5
        : 0.1;
  const latencyPenalty = Math.min(0.3, health.avgResponseMs / 10_000);
  return statusScore + health.successRate - latencyPenalty;
}

function normalizeSourceId(source: string): string {
  return String(source || 'unknown').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_') || 'unknown';
}

function statusPriority(status: SourceStatus): number {
  if (status === 'blocked') return 0;
  if (status === 'degraded') return 1;
  if (status === 'healthy') return 2;
  return 3;
}
