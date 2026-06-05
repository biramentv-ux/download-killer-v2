export type SourceId =
  | 'youtube'
  | 'youtube_music'
  | 'soundcloud'
  | 'deezer'
  | 'tidal'
  | 'qobuz'
  | 'bandcamp'
  | 'spotify'
  | 'apple'
  | 'amazon';

export interface SourceAttempt {
  source: SourceId;
  started_at: string;
  ended_at?: string;
  success: boolean;
  error?: string;
  result_url?: string;
}

export interface FallbackJobSnapshot {
  originalUrl: string;
  title?: string | null;
  artist?: string | null;
  sourceAttempts: SourceAttempt[];
}

export const SOURCE_LABELS: Record<SourceId, string> = {
  youtube: 'YouTube',
  youtube_music: 'YouTube Music',
  soundcloud: 'SoundCloud',
  deezer: 'Deezer',
  tidal: 'Tidal',
  qobuz: 'Qobuz',
  bandcamp: 'Bandcamp',
  spotify: 'Spotify',
  apple: 'Apple Music',
  amazon: 'Amazon Music',
};

const FALLBACK_CHAINS: Record<SourceId, SourceId[]> = {
  spotify: ['youtube_music', 'youtube', 'deezer', 'soundcloud', 'tidal'],
  apple: ['youtube_music', 'youtube', 'deezer', 'tidal', 'qobuz'],
  amazon: ['youtube_music', 'youtube', 'deezer', 'soundcloud'],
  youtube: ['youtube_music', 'soundcloud', 'deezer', 'tidal'],
  youtube_music: ['youtube', 'soundcloud', 'deezer', 'tidal'],
  soundcloud: ['youtube', 'youtube_music', 'deezer'],
  deezer: ['youtube_music', 'youtube', 'tidal', 'qobuz'],
  tidal: ['qobuz', 'deezer', 'youtube_music', 'youtube'],
  qobuz: ['tidal', 'deezer', 'youtube_music'],
  bandcamp: ['youtube', 'soundcloud'],
};

export function detectFallbackSource(raw: string): SourceId {
  const value = raw.toLowerCase();
  const exact = normalizeFallbackSource(value);
  if (exact) return exact;
  if (value.includes('open.spotify.com') || value.includes('spotify.com')) return 'spotify';
  if (value.includes('music.apple.com') || value.includes('itunes.apple.com')) return 'apple';
  if (value.includes('music.amazon.com') || value.includes('amazon.com/music')) return 'amazon';
  if (value.includes('music.youtube.com')) return 'youtube_music';
  if (value.includes('youtube.com') || value.includes('youtu.be') || value.startsWith('ytsearch')) return 'youtube';
  if (value.includes('soundcloud.com') || value.startsWith('scsearch')) return 'soundcloud';
  if (value.includes('deezer.com')) return 'deezer';
  if (value.includes('tidal.com')) return 'tidal';
  if (value.includes('qobuz.com')) return 'qobuz';
  if (value.includes('bandcamp.com')) return 'bandcamp';
  return 'youtube';
}

export function normalizeFallbackSource(raw: string | undefined): SourceId | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  return Object.prototype.hasOwnProperty.call(SOURCE_LABELS, value) ? value as SourceId : null;
}

export function getNextFallbackSource(job: FallbackJobSnapshot): SourceId | null {
  const origin = detectFallbackSource(job.originalUrl);
  const chain = FALLBACK_CHAINS[origin] ?? FALLBACK_CHAINS.youtube;
  const tried = new Set(job.sourceAttempts.map((attempt) => attempt.source));
  for (const source of chain) {
    if (!tried.has(source)) return source;
  }
  return null;
}

export function buildFallbackTarget(
  originalUrl: string,
  targetSource: SourceId,
  title?: string | null,
  artist?: string | null,
): string {
  const origin = detectFallbackSource(originalUrl);
  if (origin === targetSource && /^https?:\/\//i.test(originalUrl)) return originalUrl;

  const query = buildSearchQuery(title, artist, originalUrl);
  const encoded = encodeURIComponent(query);
  switch (targetSource) {
    case 'youtube':
      return `ytsearch1:${query}`;
    case 'youtube_music':
      return `ytmsearch1:${query}`;
    case 'soundcloud':
      return `scsearch1:${query}`;
    case 'deezer':
      return `https://deezer.com/search/${encoded}`;
    case 'tidal':
      return `https://listen.tidal.com/search?q=${encoded}`;
    case 'qobuz':
      return `https://www.qobuz.com/search?q=${encoded}`;
    case 'bandcamp':
      return `https://bandcamp.com/search?q=${encoded}`;
    default:
      return `ytsearch1:${query}`;
  }
}

export function parseSourceAttempts(raw: string | null | undefined): SourceAttempt[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SourceAttempt[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((attempt) => ({
        source: normalizeFallbackSource(String(attempt?.source ?? '')) ?? 'youtube',
        started_at: safeIso(attempt?.started_at),
        ended_at: attempt?.ended_at ? safeIso(attempt.ended_at) : undefined,
        success: Boolean(attempt?.success),
        error: typeof attempt?.error === 'string' ? attempt.error.slice(0, 500) : undefined,
        result_url: typeof attempt?.result_url === 'string' ? attempt.result_url.slice(0, 2000) : undefined,
      }))
      .slice(-25);
  } catch {
    return [];
  }
}

export function appendStartedAttempt(attempts: SourceAttempt[], source: SourceId, now = new Date().toISOString()): SourceAttempt[] {
  return [...attempts, { source, started_at: now, success: false }].slice(-25);
}

export function markAttemptResult(
  attempts: SourceAttempt[],
  source: SourceId,
  success: boolean,
  error?: string,
  resultUrl?: string,
): SourceAttempt[] {
  const copy = attempts.slice(-25);
  const latestIndex = findLastIndex(copy, (attempt) => attempt.source === source && !attempt.ended_at);
  const index = latestIndex >= 0 ? latestIndex : copy.length - 1;
  if (index >= 0 && copy[index]) {
    copy[index] = {
      ...copy[index],
      ended_at: new Date().toISOString(),
      success,
      error: error ? error.slice(0, 500) : undefined,
      result_url: resultUrl ? resultUrl.slice(0, 2000) : undefined,
    };
  }
  return copy;
}

function buildSearchQuery(title?: string | null, artist?: string | null, fallback?: string): string {
  const query = [artist, title]
    .map((part) => String(part ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' - ');
  if (query) return query.slice(0, 220);
  return String(fallback ?? 'music').replace(/^https?:\/\//i, '').replace(/[/?#=&_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220) || 'music';
}

function safeIso(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}
