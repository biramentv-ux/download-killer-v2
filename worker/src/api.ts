import type {
  AudioFormat,
  AudioQuality,
  DownloadJob,
  DownloaderSearchResult,
  Env,
  JobStatus,
} from './types';
import {
  buildDownloaderHeaders,
  fetchDownloaderWithFailover,
  getConfiguredOrigins,
  listOriginStates,
  normalizeDownloaderUrl,
} from './origins';
import { buildOpsSummary, recordTelemetry } from './telemetry';
import { enqueueHistoryEvent } from './history';
import { ensurePlaylistWorkflowSchema } from './schema';
import {
  corsHeaders,
  createDownloadToken,
  createJobFingerprint,
  detectSourceFromUrl,
  formatFileName,
  getClientAddress,
  isValidUrl,
  jsonError,
  jsonOk,
  normalizeSource,
  optionsResponse,
  parseJson,
  rateLimit,
  readEnvInt,
  sha256HexBytes,
  verifyDownloadToken,
  validateUrlPolicy,
} from './utils';

interface SearchRequestBody {
  query: string;
  source?: string;
}

interface PreviewRequestBody {
  query?: string;
  url?: string;
  source?: string;
}

interface MetadataLookupRequestBody {
  query?: string;
  title?: string;
  artist?: string;
  limit?: number;
}

interface DownloadRequestBody {
  url: string;
  source?: string;
  format?: AudioFormat;
  quality?: AudioQuality;
}

interface SmartFormatRequestBody {
  device?: string;
  user_agent?: string;
  connection?: string;
  output?: string;
}

interface SharedQueueRequestBody {
  key?: string;
  url?: string;
  source?: string;
  format?: AudioFormat;
  quality?: AudioQuality;
  title?: string;
  artist?: string;
  added_by?: string;
}

interface QueuedDownloadResult {
  jobId: string;
  status: JobStatus;
  deduped: boolean;
  source: string;
  format: AudioFormat;
  quality: AudioQuality;
}

interface PlaylistRequestBody {
  url: string;
  source?: string;
  format?: AudioFormat;
  quality?: AudioQuality;
}

interface PlaylistTrack {
  title: string;
  artist: string;
  source: string;
  url: string;
}

interface PlaylistResolveResponse {
  title: string;
  source: string;
  total: number;
  tracks: PlaylistTrack[];
}

interface PlaylistResolveResult {
  payload: PlaylistResolveResponse | null;
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
}

interface DownloaderPlaylistWorkflowStartPayload {
  workflowId: string;
  playlistUrl: string;
  source: string;
  format: AudioFormat;
  quality: AudioQuality;
}

interface PreferencesPayload {
  key?: string;
  language?: string;
  source?: string;
  format?: string;
  quality?: string;
  download_directory?: string;
  telegram_link_mode?: string;
  base_revision?: number;
  client_updated_at?: string;
  client_id?: string;
}

interface TelegramInfoCache {
  username: string;
  deepLink: string;
  downloadLink: string;
}

interface OpsReplayRequestBody {
  job_ids?: string[];
  workflow_id?: string;
  replay_failed_recent?: boolean;
  include_queued?: boolean;
  limit?: number;
}

interface JobRecord {
  id: string;
  url: string;
  source: string;
  format: string;
  quality: string;
  fingerprint: string | null;
  status: JobStatus;
  attempts: number;
  result_url: string | null;
  r2_key: string | null;
  title: string | null;
  artist: string | null;
  duration: number | null;
  file_size: number | null;
  content_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface ExistingFingerprintJob {
  id: string;
  status: JobStatus;
}

interface PlaylistWorkflowRecord {
  workflow_id: string;
  source_url: string;
  source: string;
  status: JobStatus;
  phase: string;
  total_tracks: number;
  queued_count: number;
  processing_count: number;
  done_count: number;
  failed_count: number;
  deduped_count: number;
  control_state?: string | null;
  archive_status?: string | null;
  archive_url?: string | null;
  archive_error?: string | null;
  archive_finished_at?: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface PlaylistWorkflowRollup {
  total_links: number;
  queued_count: number;
  processing_count: number;
  done_count: number;
  failed_count: number;
  deduped_count: number;
}

interface PreferencesState {
  language: 'en' | 'bg' | 'es' | 'ru' | 'de';
  source: string;
  format: AudioFormat;
  quality: AudioQuality;
  download_directory: string;
  telegram_link_mode: 'bot' | 'download';
  revision: number;
  field_updated_at: {
    language: string;
    source: string;
    format: string;
    quality: string;
    download_directory: string;
    telegram_link_mode: string;
  };
  last_writer: string;
  updated_at: string;
}

type PreferenceField =
  | 'language'
  | 'source'
  | 'format'
  | 'quality'
  | 'download_directory'
  | 'telegram_link_mode';

type OpsRole = 'none' | 'viewer' | 'operator' | 'admin';

interface OpsAuthContext {
  role: OpsRole;
  tokenId: string;
}

interface ReleaseArtifactEntry {
  id: 'desktop_windows' | 'desktop_macos' | 'extension_chrome' | 'extension_firefox';
  filename: string;
  path: string;
  url: string;
  sha256: string;
  bytes: number;
  version: string;
  minimum_supported: string;
  platform: 'windows' | 'macos' | 'extension';
}

const AUDIO_FORMATS: AudioFormat[] = ['mp3', 'flac', 'ogg', 'm4a', 'opus', 'wav'];
const AUDIO_QUALITIES: AudioQuality[] = ['320', '256', '192', '128', '96', 'best', 'lossless'];
const SUPPORTED_LANGUAGES = new Set(['en', 'bg', 'es', 'ru', 'de']);
const SSE_POLL_INTERVAL_MS = 1500;
const SSE_MAX_DURATION_MS = 5 * 60 * 1000;
const INVIDIOUS_DEFAULT_BASE_URL = 'https://inv.nadeko.net';
const INVIDIOUS_FALLBACK_BASE_URLS = [
  'https://invidious.f5.si',
  'https://inv.thepixora.com',
  'https://yt.chocolatemoo53.com',
];
const PREFERENCE_FIELDS: PreferenceField[] = [
  'language',
  'source',
  'format',
  'quality',
  'download_directory',
  'telegram_link_mode',
];
const RELEASE_ARTIFACTS: Array<{
  id: ReleaseArtifactEntry['id'];
  filename: string;
  path: string;
  platform: ReleaseArtifactEntry['platform'];
}> = [
  {
    id: 'desktop_windows',
    filename: 'DyrakArmyDesktop.exe',
    path: '/downloads/DyrakArmyDesktop.exe',
    platform: 'windows',
  },
  {
    id: 'desktop_macos',
    filename: 'DyrakArmyDesktop-macOS.zip',
    path: '/downloads/DyrakArmyDesktop-macOS.zip',
    platform: 'macos',
  },
  {
    id: 'extension_chrome',
    filename: 'DyrakArmy-Extension-Chrome.zip',
    path: '/downloads/DyrakArmy-Extension-Chrome.zip',
    platform: 'extension',
  },
  {
    id: 'extension_firefox',
    filename: 'DyrakArmy-Extension-Firefox.zip',
    path: '/downloads/DyrakArmy-Extension-Firefox.zip',
    platform: 'extension',
  },
];
let preferencesSchemaReady: Promise<void> | null = null;
let sharedQueueSchemaReady: Promise<void> | null = null;
const OPS_ROLE_ORDER: Record<Exclude<OpsRole, 'none'>, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

export async function downloadRouter(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return optionsResponse(request, env);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace('/api', '');

  if (path === '/health' && request.method === 'GET') {
    return jsonOk(request, env, { ok: true, service: 'dyrakarmy-worker' });
  }

  if (path === '/runtime-config' && request.method === 'GET') {
    return handleRuntimeConfig(request, env);
  }

  if (path === '/updates' && request.method === 'GET') {
    return handleUpdates(request, env);
  }

  if (path === '/recommend-format' && request.method === 'POST') {
    return handleRecommendFormat(request, env);
  }

  if (path === '/shared-queue' && request.method === 'GET') {
    return handleSharedQueueGet(request, env);
  }

  if (path === '/shared-queue' && request.method === 'POST') {
    return handleSharedQueuePost(request, env);
  }

  if (path === '/releases/manifest' && request.method === 'GET') {
    return handleReleaseManifest(request, env);
  }

  if (path === '/ops/summary' && request.method === 'GET') {
    return handleOpsSummary(request, env);
  }

  if (path === '/ops/replay' && request.method === 'POST') {
    return handleOpsReplay(request, env);
  }

  if (path === '/telegram/info' && request.method === 'GET') {
    return handleTelegramInfo(request, env);
  }

  if (path === '/preferences' && request.method === 'GET') {
    return handlePreferencesGet(request, env);
  }

  if (path === '/preferences' && request.method === 'POST') {
    return handlePreferencesPost(request, env);
  }

  if (path === '/search' && request.method === 'POST') {
    return handleSearch(request, env);
  }

  if (path === '/preview' && request.method === 'POST') {
    return handlePreview(request, env);
  }

  if (path === '/metadata/lookup' && request.method === 'POST') {
    return handleMetadataLookup(request, env);
  }

  if (path === '/download' && request.method === 'POST') {
    return handleDownload(request, env);
  }

  if (path === '/playlist/resolve' && request.method === 'POST') {
    return handlePlaylistResolve(request, env);
  }

  if (path === '/playlist/queue' && request.method === 'POST') {
    return handlePlaylistQueue(request, env);
  }

  if (path === '/batch/pause-all' && request.method === 'POST') {
    return handleBatchPauseAll(request, env);
  }

  if (path === '/batch/resume-all' && request.method === 'POST') {
    return handleBatchResumeAll(request, env);
  }

  const playlistWorkflowMatch = path.match(/^\/playlist\/workflow\/([0-9a-f-]{36})$/i);
  if (playlistWorkflowMatch && request.method === 'GET') {
    return handlePlaylistWorkflowStatus(request, env, playlistWorkflowMatch[1]!);
  }

  const playlistWorkflowPauseMatch = path.match(/^\/playlist\/workflow\/([0-9a-f-]{36})\/pause$/i);
  if (playlistWorkflowPauseMatch && request.method === 'POST') {
    return handlePlaylistWorkflowControl(request, env, playlistWorkflowPauseMatch[1]!, 'pause');
  }

  const playlistWorkflowResumeMatch = path.match(/^\/playlist\/workflow\/([0-9a-f-]{36})\/resume$/i);
  if (playlistWorkflowResumeMatch && request.method === 'POST') {
    return handlePlaylistWorkflowControl(request, env, playlistWorkflowResumeMatch[1]!, 'resume');
  }

  const playlistWorkflowCancelMatch = path.match(/^\/playlist\/workflow\/([0-9a-f-]{36})\/cancel$/i);
  if (playlistWorkflowCancelMatch && request.method === 'POST') {
    return handlePlaylistWorkflowControl(request, env, playlistWorkflowCancelMatch[1]!, 'cancel');
  }

  const playlistWorkflowZipMatch = path.match(/^\/playlist\/workflow\/([0-9a-f-]{36})\/zip$/i);
  if (playlistWorkflowZipMatch && request.method === 'POST') {
    return handlePlaylistWorkflowZip(request, env, playlistWorkflowZipMatch[1]!);
  }

  const jobEventsMatch = path.match(/^\/job\/([0-9a-f-]{36})\/events$/i);
  if (jobEventsMatch && request.method === 'GET') {
    return handleJobEvents(request, env, jobEventsMatch[1]!);
  }

  const jobPauseMatch = path.match(/^\/job\/([0-9a-f-]{36})\/pause$/i);
  if (jobPauseMatch && request.method === 'POST') {
    return handleJobControl(request, env, jobPauseMatch[1]!, 'pause');
  }

  const jobResumeMatch = path.match(/^\/job\/([0-9a-f-]{36})\/resume$/i);
  if (jobResumeMatch && request.method === 'POST') {
    return handleJobControl(request, env, jobResumeMatch[1]!, 'resume');
  }

  const jobStatusMatch = path.match(/^\/job\/([0-9a-f-]{36})$/i);
  if (jobStatusMatch && request.method === 'GET') {
    return handleJobStatus(request, env, jobStatusMatch[1]!);
  }

  if (path === '/history' && request.method === 'GET') {
    return handleHistory(request, env);
  }

  if (path === '/stats' && request.method === 'GET') {
    return handleStats(request, env);
  }

  if (path === '/formats' && request.method === 'GET') {
    return handleFormats(request, env);
  }

  if (path === '/archive' && request.method === 'GET') {
    return handleArchiveList(request, env);
  }

  if (path === '/archive/browse' && request.method === 'GET') {
    return handleArchiveBrowse(request, env);
  }

  const archiveFileMatch = path.match(/^\/archive\/file\/([a-f0-9]{64})$/i);
  if (archiveFileMatch && request.method === 'GET') {
    return handleArchiveFile(request, env, archiveFileMatch[1]!);
  }

  if (path.startsWith('/file/') && request.method === 'GET') {
    const token = decodeURIComponent(path.replace('/file/', ''));
    return handleFileDownload(request, env, token);
  }

  return jsonError(request, env, 'NOT_FOUND', 'API endpoint not found', 404);
}

async function handleSearch(request: Request, env: Env): Promise<Response> {
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `search:${ip}`, 30, 60);
  if (rl.limited) {
    return jsonError(request, env, 'RATE_LIMITED', 'Too many search requests', 429, true);
  }

  const body = await parseJson<SearchRequestBody>(request);
  if (!body?.query?.trim()) {
    return jsonError(request, env, 'INVALID_QUERY', 'Query is required', 400);
  }

  const source = normalizeSource(body.source);
  const query = body.query.trim();
  if (isValidUrl(query)) {
    const policy = validateUrlPolicy(query, env);
    if (!policy.allowed) {
      return jsonError(request, env, policy.code ?? 'URL_BLOCKED', policy.message ?? 'URL is blocked', 400);
    }
  }
  const cacheTtl = readEnvInt(env.SEARCH_CACHE_TTL_SECONDS, 180);
  const cacheKey = `search:${source}:${query.toLowerCase()}`;

  let cached: { results: DownloaderSearchResult[] } | null = null;
  try {
    cached = await env.CACHE.get(cacheKey, { type: 'json' }) as { results: DownloaderSearchResult[] } | null;
  } catch (error) {
    console.warn('Search cache read failed', error);
  }
  if (cached?.results) {
    return jsonOk(request, env, { results: cached.results, cached: true });
  }

  let upstreamResults: DownloaderSearchResult[] | null = null;
  try {
    const startedAt = Date.now();
    const failover = await fetchDownloaderWithFailover(env, '/internal/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.DOWNLOADER_API_KEY,
      },
      body: JSON.stringify({ query, source, limit: 8 }),
    });
    const response = failover.response;
    await recordTelemetry(env, {
      event: 'downloader_search',
      status: String(response.status),
      source,
      origin: failover.origin.baseUrl,
      latency_ms: Date.now() - startedAt,
      code: failover.switched ? 'FAILOVER_SWITCHED' : 'PRIMARY_OK',
    });
    if (response.ok) {
      const payload = await response.json() as { results?: DownloaderSearchResult[] } | DownloaderSearchResult[];
      upstreamResults = Array.isArray(payload) ? payload : (payload.results ?? []);
    } else {
      console.warn(`Search upstream failed with ${response.status}. Falling back to Invidious.`);
    }
  } catch (error) {
    console.error('Search upstream request failed. Falling back to Invidious.', error);
  }

  let results = upstreamResults;
  if (!results || results.length === 0) {
    results = await searchViaInvidious(query, 8, env);
  }
  if (!results || results.length === 0) {
    return jsonError(request, env, 'SEARCH_FAILED', 'Search provider failed', 502, true);
  }

  try {
    await env.CACHE.put(cacheKey, JSON.stringify({ results }), { expirationTtl: cacheTtl });
  } catch (error) {
    console.warn('Search cache write skipped', error);
  }
  return jsonOk(request, env, { results, cached: false });
}

async function handlePreview(request: Request, env: Env): Promise<Response> {
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `preview:${ip}`, 20, 60);
  if (rl.limited) {
    return jsonError(request, env, 'RATE_LIMITED', 'Too many preview requests', 429, true);
  }

  const body = await parseJson<PreviewRequestBody>(request);
  const query = String(body?.url || body?.query || '').trim();
  if (!query) {
    return jsonError(request, env, 'INVALID_PREVIEW_QUERY', 'Preview query or URL is required', 400);
  }
  if (query.length > 2000) {
    return jsonError(request, env, 'INVALID_PREVIEW_QUERY', 'Preview query is too long', 400);
  }
  if (isValidUrl(query)) {
    const policy = validateUrlPolicy(query, env);
    if (!policy.allowed) {
      return jsonError(request, env, policy.code ?? 'URL_BLOCKED', policy.message ?? 'URL is blocked', 400);
    }
  }

  const source = normalizeSource(body?.source);
  try {
    const startedAt = Date.now();
    const failover = await fetchDownloaderWithFailover(env, '/internal/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.DOWNLOADER_API_KEY,
      },
      body: JSON.stringify({ query, source }),
    });
    await recordTelemetry(env, {
      event: 'downloader_preview',
      status: String(failover.response.status),
      source,
      origin: failover.origin.baseUrl,
      latency_ms: Date.now() - startedAt,
      code: failover.switched ? 'FAILOVER_SWITCHED' : 'PRIMARY_OK',
    });

    if (!failover.response.ok) {
      const details = await failover.response.text();
      return jsonError(request, env, 'PREVIEW_FAILED', details.slice(0, 240) || 'Preview provider failed', 502, true);
    }

    const payload = await failover.response.json() as Record<string, unknown>;
    return jsonOk(request, env, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(request, env, 'PREVIEW_UNREACHABLE', `Preview provider is unreachable: ${message.slice(0, 160)}`, 502, true);
  }
}

async function handleMetadataLookup(request: Request, env: Env): Promise<Response> {
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `metadata:${ip}`, 20, 60);
  if (rl.limited) {
    return jsonError(request, env, 'RATE_LIMITED', 'Too many metadata lookup requests', 429, true);
  }

  const body = await parseJson<MetadataLookupRequestBody>(request);
  const query = String(body?.query || [body?.artist, body?.title].filter(Boolean).join(' ')).trim();
  if (query.length < 2) {
    return jsonError(request, env, 'INVALID_METADATA_QUERY', 'Metadata query is required', 400);
  }

  const limit = Math.max(1, Math.min(10, Number.parseInt(String(body?.limit ?? '6'), 10) || 6));
  const cacheKey = `metadata:${query.toLowerCase()}:${limit}`;
  try {
    const cached = await env.CACHE.get(cacheKey, { type: 'json' }) as Record<string, unknown> | null;
    if (cached) {
      return jsonOk(request, env, { ...cached, cached: true });
    }
  } catch {
    // Cache is opportunistic.
  }

  try {
    const startedAt = Date.now();
    const failover = await fetchDownloaderWithFailover(env, '/internal/metadata/lookup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.DOWNLOADER_API_KEY,
      },
      body: JSON.stringify({ query, limit }),
    });
    await recordTelemetry(env, {
      event: 'metadata_lookup',
      status: String(failover.response.status),
      origin: failover.origin.baseUrl,
      latency_ms: Date.now() - startedAt,
      code: failover.switched ? 'FAILOVER_SWITCHED' : 'PRIMARY_OK',
    });

    if (!failover.response.ok) {
      const details = await failover.response.text();
      return jsonError(request, env, 'METADATA_LOOKUP_FAILED', details.slice(0, 240) || 'Metadata lookup failed', 502, true);
    }

    const payload = await failover.response.json() as Record<string, unknown>;
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 3600 });
    } catch {
      // Cache is opportunistic.
    }
    return jsonOk(request, env, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(request, env, 'METADATA_LOOKUP_UNREACHABLE', `Metadata lookup is unreachable: ${message.slice(0, 160)}`, 502, true);
  }
}

async function handleDownload(request: Request, env: Env): Promise<Response> {
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `download:${ip}`, 10, 60);
  if (rl.limited) {
    return jsonError(request, env, 'RATE_LIMITED', 'Too many download requests', 429, true);
  }

  const body = await parseJson<DownloadRequestBody>(request);
  if (!body?.url?.trim()) {
    return jsonError(request, env, 'INVALID_URL', 'URL is required', 400);
  }

  const url = body.url.trim();
  if (!isValidUrl(url)) {
    return jsonError(request, env, 'INVALID_URL', 'URL must be HTTP or HTTPS', 400);
  }
  const policy = validateUrlPolicy(url, env);
  if (!policy.allowed) {
    return jsonError(request, env, policy.code ?? 'URL_BLOCKED', policy.message ?? 'URL is blocked', 400);
  }

  const queued = await queueDownloadJob(env, {
    url,
    source: body.source,
    format: body.format,
    quality: body.quality,
  });

  return jsonOk(request, env, {
    jobId: queued.jobId,
    status: queued.status,
    deduped: queued.deduped,
  }, 202);
}

async function handleRecommendFormat(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<SmartFormatRequestBody>(request);
  const profileText = [
    body?.device,
    body?.output,
    body?.connection,
    body?.user_agent,
  ].map((value) => String(value ?? '').toLowerCase()).join(' ');

  let profile = 'desktop';
  let format: AudioFormat = 'mp3';
  let quality: AudioQuality = '320';
  let reason = 'Balanced compatibility for browser, desktop and mobile playback.';

  if (/\b(homepod|hifi|hi-fi|dac|studio|lossless|audiophile)\b/.test(profileText)) {
    profile = 'hi_fi';
    format = 'flac';
    quality = 'lossless';
    reason = 'Lossless output detected; FLAC preserves source quality.';
  } else if (/\b(carplay|android auto|car|auto|vehicle|bluetooth car)\b/.test(profileText)) {
    profile = 'car';
    format = 'mp3';
    quality = '320';
    reason = 'Car systems have the broadest support for MP3 320.';
  } else if (/\b(airpods|earbuds|buds|headphones|iphone|ipad|ios)\b/.test(profileText)) {
    profile = 'airpods';
    format = 'opus';
    quality = '256';
    reason = 'OPUS 256 gives strong quality with efficient mobile storage.';
  } else if (/\b(cellular|mobile data|save data|slow|metered|low bandwidth)\b/.test(profileText)) {
    profile = 'low_bandwidth';
    format = 'opus';
    quality = '128';
    reason = 'OPUS 128 reduces transfer size while keeping acceptable quality.';
  }

  await recordTelemetry(env, {
    event: 'smart_format_recommended',
    status: '200',
    code: profile,
  });

  return jsonOk(request, env, {
    profile,
    format,
    quality,
    reason,
    alternatives: [
      { profile: 'universal', format: 'mp3', quality: '320' },
      { profile: 'mobile', format: 'opus', quality: '256' },
      { profile: 'lossless', format: 'flac', quality: 'lossless' },
    ],
  });
}

async function handleSharedQueuePost(request: Request, env: Env): Promise<Response> {
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `shared-queue:${ip}`, 20, 60);
  if (rl.limited) {
    return jsonError(request, env, 'RATE_LIMITED', 'Too many shared queue requests', 429, true);
  }

  const body = await parseJson<SharedQueueRequestBody>(request);
  const key = String(body?.key ?? '').trim();
  if (!isValidSyncKey(key)) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'A valid sync key is required', 400);
  }

  const url = String(body?.url ?? '').trim();
  if (!isValidUrl(url)) {
    return jsonError(request, env, 'INVALID_URL', 'URL must be HTTP or HTTPS', 400);
  }
  const policy = validateUrlPolicy(url, env);
  if (!policy.allowed) {
    return jsonError(request, env, policy.code ?? 'URL_BLOCKED', policy.message ?? 'URL is blocked', 400);
  }

  const queued = await queueDownloadJob(env, {
    url,
    source: body?.source,
    format: body?.format,
    quality: body?.quality,
    title: body?.title,
    artist: body?.artist,
  });

  await ensureSharedQueueTable(env);
  const itemId = crypto.randomUUID();
  const title = String(body?.title ?? '').trim() || null;
  const artist = String(body?.artist ?? '').trim() || null;
  const addedBy = String(body?.added_by ?? '').trim().slice(0, 80) || null;
  await env.DB.prepare(
    `INSERT INTO shared_queue_items (
      id, sync_key, job_id, url, source, format, quality, title, artist, added_by, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(itemId, key, queued.jobId, url, queued.source, queued.format, queued.quality, title, artist, addedBy, queued.status).run();

  await recordTelemetry(env, {
    event: 'shared_queue_item_added',
    status: '202',
    source: queued.source,
    code: queued.deduped ? 'DEDUPED' : 'QUEUED',
  });

  return jsonOk(request, env, {
    item: {
      id: itemId,
      job_id: queued.jobId,
      url,
      source: queued.source,
      format: queued.format,
      quality: queued.quality,
      title,
      artist,
      added_by: addedBy,
      status: queued.status,
    },
    jobId: queued.jobId,
    status: queued.status,
    deduped: queued.deduped,
  }, 202);
}

async function handleSharedQueueGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = String(url.searchParams.get('key') ?? '').trim();
  if (!isValidSyncKey(key)) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'A valid sync key is required', 400);
  }

  const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
  await ensureSharedQueueTable(env);
  const rows = await env.DB.prepare(
    `SELECT
       s.id, s.job_id, s.url, s.source, s.format, s.quality, s.title, s.artist, s.added_by,
       s.status AS shared_status, s.created_at, s.updated_at,
       j.status AS job_status, j.error_code, j.error_message, j.result_url, j.r2_key, j.file_size, j.finished_at
     FROM shared_queue_items s
     LEFT JOIN download_jobs j ON j.id = s.job_id
     WHERE s.sync_key = ?
     ORDER BY s.created_at DESC
     LIMIT ?`,
  ).bind(key, limit).all<Record<string, unknown>>();

  const items = await Promise.all((rows.results ?? []).map(async (row) => {
    const status = String(row.job_status ?? row.shared_status ?? 'queued');
    const hasDownloadTarget =
      (typeof row.r2_key === 'string' && row.r2_key.length > 0)
      || (typeof row.result_url === 'string' && row.result_url.length > 0);
    const downloadUrl = status === 'done' && hasDownloadTarget
      ? await buildDownloadUrl(request, env, String(row.job_id))
      : null;
    const streamUrl = downloadUrl
      ? await buildStreamUrl(request, env, String(row.job_id))
      : null;
    return {
      id: row.id,
      job_id: row.job_id,
      url: row.url,
      source: row.source,
      format: row.format,
      quality: row.quality,
      title: row.title,
      artist: row.artist,
      added_by: row.added_by,
      status,
      error_code: row.error_code,
      error_message: row.error_message,
      file_size: row.file_size,
      download_url: downloadUrl,
      stream_url: streamUrl,
      created_at: row.created_at,
      updated_at: row.updated_at,
      finished_at: row.finished_at,
    };
  }));

  return jsonOk(request, env, {
    items,
    total: items.length,
    limit,
    sync_key: key,
    realtime: {
      mode: 'poll',
      interval_ms: 5000,
    },
  });
}

async function queueDownloadJob(
  env: Env,
  input: {
    url: string;
    source?: string;
    format?: AudioFormat;
    quality?: AudioQuality;
    title?: string;
    artist?: string;
  },
): Promise<QueuedDownloadResult> {
  const url = input.url.trim();
  const format = normalizeAudioFormat(input.format, 'mp3');
  const quality = normalizeAudioQuality(input.quality, format, format === 'flac' || format === 'wav' ? 'lossless' : '320');
  const source = normalizeSource(input.source ?? detectSourceFromUrl(url));
  const fingerprint = await createJobFingerprint(url, format, quality);
  const dedupeKey = `dedupe:${fingerprint}`;

  const dedupeTtl = readEnvInt(env.DOWNLOAD_DEDUPE_TTL_SECONDS, 120);
  const existing = await getExistingJobByFingerprint(env, fingerprint, dedupeTtl);
  if (existing) {
    await enqueueHistoryEvent(env, {
      jobId: existing.id,
      event: 'deduped',
      status: existing.status,
      source,
      detail: fingerprint,
    });
    await recordTelemetry(env, {
      event: 'download_deduped',
      status: '202',
      source,
    });
    return { jobId: existing.id, status: existing.status, deduped: true, source, format, quality };
  }

  const jobId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO download_jobs (
      id, url, source, format, quality, status, attempts, fingerprint, title, artist, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(jobId, url, source, format, quality, fingerprint, input.title ?? null, input.artist ?? null).run();

  await env.DOWNLOAD_QUEUE.send({
    id: jobId,
    url,
    source,
    format,
    quality,
    fingerprint,
    requestedAt: new Date().toISOString(),
  });

  try {
    await env.CACHE.put(dedupeKey, jobId, { expirationTtl: dedupeTtl });
  } catch (error) {
    console.warn('Download dedupe cache write skipped', error);
  }
  await recordTelemetry(env, {
    event: 'download_queued',
    status: '202',
    source,
  });
  await enqueueHistoryEvent(env, {
    jobId,
    event: 'queued',
    status: 'queued',
    source,
  });

  return { jobId, status: 'queued', deduped: false, source, format, quality };
}

async function handlePlaylistResolve(request: Request, env: Env): Promise<Response> {
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `playlist-resolve:${ip}`, 10, 60);
  if (rl.limited) {
    return jsonError(request, env, 'RATE_LIMITED', 'Too many playlist resolve requests', 429, true);
  }

  const body = await parseJson<PlaylistRequestBody>(request);
  if (!body?.url?.trim()) {
    return jsonError(request, env, 'INVALID_URL', 'Playlist URL is required', 400);
  }
  const playlistUrl = body.url.trim();
  if (!isValidUrl(playlistUrl)) {
    return jsonError(request, env, 'INVALID_URL', 'URL must be HTTP or HTTPS', 400);
  }
  const policy = validateUrlPolicy(playlistUrl, env);
  if (!policy.allowed) {
    return jsonError(request, env, policy.code ?? 'URL_BLOCKED', policy.message ?? 'URL is blocked', 400);
  }
  if (!isPlaylistUrl(playlistUrl)) {
    return jsonError(request, env, 'INVALID_PLAYLIST_URL', 'URL is not recognized as a playlist', 400);
  }

  const source = normalizeSource(body.source ?? detectSourceFromUrl(playlistUrl));
  const resolved = await fetchPlaylistResolve(env, playlistUrl, source);
  if (!resolved.payload || !Array.isArray(resolved.payload.tracks)) {
    return jsonError(
      request,
      env,
      resolved.errorCode ?? 'PLAYLIST_RESOLVE_FAILED',
      resolved.errorMessage ?? 'Playlist provider failed',
      502,
      resolved.retryable,
    );
  }

  return jsonOk(request, env, {
    title: resolved.payload.title ?? 'Playlist',
    source: resolved.payload.source ?? source,
    total: Number(resolved.payload.total ?? resolved.payload.tracks.length),
    tracks: resolved.payload.tracks,
  });
}

async function handlePlaylistQueue(request: Request, env: Env): Promise<Response> {
  await ensurePlaylistWorkflowSchema(env);
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `playlist-queue:${ip}`, 5, 60);
  if (rl.limited) {
    return jsonError(request, env, 'RATE_LIMITED', 'Too many playlist queue requests', 429, true);
  }

  const body = await parseJson<PlaylistRequestBody>(request);
  if (!body?.url?.trim()) {
    return jsonError(request, env, 'INVALID_URL', 'Playlist URL is required', 400);
  }
  const playlistUrl = body.url.trim();
  if (!isValidUrl(playlistUrl)) {
    return jsonError(request, env, 'INVALID_URL', 'URL must be HTTP or HTTPS', 400);
  }
  const policy = validateUrlPolicy(playlistUrl, env);
  if (!policy.allowed) {
    return jsonError(request, env, policy.code ?? 'URL_BLOCKED', policy.message ?? 'URL is blocked', 400);
  }
  if (!isPlaylistUrl(playlistUrl)) {
    return jsonError(request, env, 'INVALID_PLAYLIST_URL', 'URL is not recognized as a playlist', 400);
  }

  const format = AUDIO_FORMATS.includes(body.format ?? 'mp3') ? (body.format ?? 'mp3') : 'mp3';
  const quality = AUDIO_QUALITIES.includes(body.quality ?? '320') ? (body.quality ?? '320') : '320';
  const source = normalizeSource(body.source ?? detectSourceFromUrl(playlistUrl));

  const resolved = await fetchPlaylistResolve(env, playlistUrl, source);
  if (!resolved.payload || !Array.isArray(resolved.payload.tracks)) {
    return jsonError(
      request,
      env,
      resolved.errorCode ?? 'PLAYLIST_RESOLVE_FAILED',
      resolved.errorMessage ?? 'Playlist provider failed',
      502,
      resolved.retryable,
    );
  }
  if (resolved.payload.tracks.length === 0) {
    return jsonError(request, env, 'PLAYLIST_EMPTY', 'No tracks found in playlist', 400);
  }

  const requestedTotalTracks = resolved.payload.tracks.length;
  const maxQueueTracks = Math.max(1, Math.min(500, readEnvInt(env.PLAYLIST_QUEUE_MAX_TRACKS, 120)));
  const queueTracks = requestedTotalTracks > maxQueueTracks
    ? resolved.payload.tracks.slice(0, maxQueueTracks)
    : resolved.payload.tracks;
  const truncatedCount = Math.max(0, requestedTotalTracks - queueTracks.length);

  const dedupeTtl = readEnvInt(env.DOWNLOAD_DEDUPE_TTL_SECONDS, 120);
  const workflowId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO playlist_workflows (
      workflow_id, source_url, source, status, phase, total_tracks,
      queued_count, processing_count, done_count, failed_count, deduped_count,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'processing', 'resolving', 0, 0, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(workflowId, playlistUrl, source).run();
  await maybeStartDownloaderPlaylistWorkflow(env, {
    workflowId,
    playlistUrl,
    source,
    format,
    quality,
  });

  let accepted = 0;
  let deduped = 0;
  let ready = 0;
  let failed = 0;
  const queuedJobIds: string[] = [];
  const batchSize = 50;
  const pendingQueueBatch: Array<{ body: DownloadJob }> = [];

  for (let index = 0; index < queueTracks.length; index += 1) {
    const track = queueTracks[index]!;
    const trackUrl = String(track.url ?? '').trim();
    if (!isValidUrl(trackUrl)) {
      failed += 1;
    } else if (!validateUrlPolicy(trackUrl, env).allowed) {
      failed += 1;
    } else {
      const trackSource = normalizeSource(track.source || detectSourceFromUrl(trackUrl) || source);
      const fingerprint = await createJobFingerprint(trackUrl, format, quality);
      const dedupeKey = `dedupe:${fingerprint}`;
      const existing = await getExistingJobByFingerprint(env, fingerprint, dedupeTtl);
      if (existing) {
        deduped += 1;
        if (existing.status === 'done') {
          ready += 1;
        } else if (existing.status === 'failed') {
          failed += 1;
        }
        await env.DB.prepare(
          `INSERT OR IGNORE INTO playlist_workflow_jobs (workflow_id, job_id, is_deduped)
           VALUES (?, ?, 1)`,
        ).bind(workflowId, existing.id).run();
        await enqueueHistoryEvent(env, {
          jobId: existing.id,
          event: 'deduped',
          status: existing.status,
          source: trackSource,
          detail: workflowId,
        });
        queuedJobIds.push(existing.id);
      } else {
        const jobId = crypto.randomUUID();
        const title = String(track.title ?? '').trim() || 'Unknown Title';
        const artist = String(track.artist ?? '').trim() || 'Unknown Artist';

        await env.DB.prepare(
          `INSERT INTO download_jobs (
            id, url, source, format, quality, status, attempts, fingerprint, title, artist, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        ).bind(jobId, trackUrl, trackSource, format, quality, fingerprint, title, artist).run();

        pendingQueueBatch.push({
          body: {
          id: jobId,
          url: trackUrl,
          source: trackSource,
          format,
          quality,
          fingerprint,
          requestedAt: new Date().toISOString(),
        },
        });

        await env.DB.prepare(
          `INSERT OR IGNORE INTO playlist_workflow_jobs (workflow_id, job_id, is_deduped)
           VALUES (?, ?, 0)`,
        ).bind(workflowId, jobId).run();

        try {
          await env.CACHE.put(dedupeKey, jobId, { expirationTtl: dedupeTtl });
        } catch (error) {
          console.warn('Playlist dedupe cache write skipped', error);
        }
        await enqueueHistoryEvent(env, {
          jobId,
          event: 'queued',
          status: 'queued',
          source: trackSource,
          detail: workflowId,
        });
        accepted += 1;
        queuedJobIds.push(jobId);
      }
    }

    if ((index + 1) % batchSize === 0 || index + 1 === queueTracks.length) {
      await flushDownloadQueueBatch(env, pendingQueueBatch);
      const rollup = await syncPlaylistWorkflowRollup(env, workflowId, queueTracks.length);
      await recordTelemetry(env, {
        event: 'workflow_batch_progress',
        status: '200',
        source,
        value: rollup.done_count + rollup.failed_count + rollup.processing_count + rollup.queued_count,
      });
    }
  }

  await flushDownloadQueueBatch(env, pendingQueueBatch);
  const totalTracks = queueTracks.length;
  const rollup = await syncPlaylistWorkflowRollup(env, workflowId, totalTracks);
  const finalStatus = deriveWorkflowStatus(rollup, totalTracks);
  const finalPhase = deriveWorkflowPhase(finalStatus, rollup);

  await recordTelemetry(env, {
    event: finalStatus === 'failed' ? 'workflow_failed' : 'workflow_launched',
    status: finalStatus === 'failed' ? '500' : '202',
    source,
    value: totalTracks,
  });

  return jsonOk(request, env, {
    workflow_id: workflowId,
    status: finalStatus,
    phase: finalPhase,
    playlist_title: resolved.payload.title ?? 'Playlist',
    source: resolved.payload.source ?? source,
    total: totalTracks,
    requested_total: requestedTotalTracks,
    truncated: truncatedCount > 0,
    truncated_count: truncatedCount,
    accepted,
    deduped,
    ready,
    failed,
    queued: accepted + deduped,
    job_ids: queuedJobIds.slice(0, 100),
  }, 202);
}

async function flushDownloadQueueBatch(
  env: Env,
  pending: Array<{ body: DownloadJob }>,
): Promise<void> {
  if (!pending.length) return;

  const queueBinding = env.DOWNLOAD_QUEUE as Queue<DownloadJob>;
  const batch = pending.splice(0, pending.length);
  if (typeof queueBinding.sendBatch === 'function') {
    await queueBinding.sendBatch(batch);
    return;
  }

  for (const entry of batch) {
    await queueBinding.send(entry.body);
  }
}

async function handlePlaylistWorkflowStatus(request: Request, env: Env, workflowId: string): Promise<Response> {
  await ensurePlaylistWorkflowSchema(env);
  await syncPlaylistWorkflowRollup(env, workflowId);
  let row: PlaylistWorkflowRecord | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT workflow_id, source_url, source, status, phase, total_tracks, queued_count, processing_count,
              done_count, failed_count, deduped_count, control_state, archive_status, archive_url, archive_error,
              archive_finished_at, error_code, error_message, created_at, updated_at, finished_at
       FROM playlist_workflows
       WHERE workflow_id = ?`,
    ).bind(workflowId).first<PlaylistWorkflowRecord>();
  } catch {
    row = await env.DB.prepare(
      `SELECT workflow_id, source_url, source, status, phase, total_tracks, queued_count, processing_count,
              done_count, failed_count, deduped_count, error_code, error_message, created_at, updated_at, finished_at
       FROM playlist_workflows
       WHERE workflow_id = ?`,
    ).bind(workflowId).first<PlaylistWorkflowRecord>();
  }

  if (!row) {
    return jsonError(request, env, 'WORKFLOW_NOT_FOUND', 'Playlist workflow not found', 404);
  }

  return jsonOk(request, env, {
    workflow: row,
  });
}

type WorkflowControlAction = 'pause' | 'resume' | 'cancel';

async function handlePlaylistWorkflowControl(
  request: Request,
  env: Env,
  workflowId: string,
  action: WorkflowControlAction,
): Promise<Response> {
  await ensurePlaylistWorkflowSchema(env);
  const row = await env.DB.prepare(
    `SELECT workflow_id, source, status
     FROM playlist_workflows
     WHERE workflow_id = ?`,
  ).bind(workflowId).first<{ workflow_id: string; source: string; status: JobStatus }>();

  if (!row) {
    return jsonError(request, env, 'WORKFLOW_NOT_FOUND', 'Playlist workflow not found', 404);
  }

  try {
    if (action === 'pause') {
      await env.DB.prepare(
        `UPDATE playlist_workflows
         SET control_state = 'paused',
             phase = 'paused',
             updated_at = CURRENT_TIMESTAMP
         WHERE workflow_id = ?`,
      ).bind(workflowId).run();
    } else if (action === 'resume') {
      await env.DB.prepare(
        `UPDATE playlist_workflows
         SET control_state = 'active',
             phase = CASE
                      WHEN status IN ('done', 'failed') THEN phase
                      ELSE 'queued_tracks'
                    END,
             status = CASE
                       WHEN status IN ('done', 'failed') THEN status
                       ELSE 'processing'
                      END,
             updated_at = CURRENT_TIMESTAMP
         WHERE workflow_id = ?`,
      ).bind(workflowId).run();

      const replayCount = await replayQueuedWorkflowJobs(env, workflowId);
      await recordTelemetry(env, {
        event: 'workflow_resumed',
        status: '200',
        source: row.source,
        value: replayCount,
      });
    } else {
      await env.DB.prepare(
        `UPDATE playlist_workflows
         SET control_state = 'cancelled',
             status = CASE
                       WHEN status = 'done' THEN 'done'
                       ELSE 'failed'
                     END,
             phase = 'cancelled',
             error_code = 'WORKFLOW_CANCELLED',
             error_message = 'Cancelled by user',
             finished_at = CASE
                            WHEN status = 'done' THEN finished_at
                            ELSE CURRENT_TIMESTAMP
                           END,
             updated_at = CURRENT_TIMESTAMP
         WHERE workflow_id = ?`,
      ).bind(workflowId).run();

      await env.DB.prepare(
        `UPDATE download_jobs
         SET status = CASE
                       WHEN status IN ('done', 'failed') THEN status
                       ELSE 'failed'
                     END,
             error_code = CASE
                           WHEN status IN ('done', 'failed') THEN error_code
                           ELSE 'WORKFLOW_CANCELLED'
                         END,
             error_message = CASE
                              WHEN status IN ('done', 'failed') THEN error_message
                              ELSE 'Cancelled by user'
                            END,
             finished_at = CASE
                            WHEN status IN ('done', 'failed') THEN finished_at
                            ELSE CURRENT_TIMESTAMP
                          END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id IN (
           SELECT job_id FROM playlist_workflow_jobs WHERE workflow_id = ?
         )`,
      ).bind(workflowId).run();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(
      request,
      env,
      'SCHEMA_OUTDATED',
      `Playlist control requires the latest schema migration (${message.slice(0, 180)})`,
      500,
      false,
    );
  }

  await notifyDownloaderWorkflowControl(env, workflowId, action);
  await syncPlaylistWorkflowRollup(env, workflowId);

  let updated: PlaylistWorkflowRecord | null = null;
  try {
    updated = await env.DB.prepare(
      `SELECT workflow_id, source_url, source, status, phase, total_tracks, queued_count, processing_count,
              done_count, failed_count, deduped_count, control_state, archive_status, archive_url, archive_error,
              archive_finished_at, error_code, error_message, created_at, updated_at, finished_at
       FROM playlist_workflows
       WHERE workflow_id = ?`,
    ).bind(workflowId).first<PlaylistWorkflowRecord>();
  } catch {
    updated = await env.DB.prepare(
      `SELECT workflow_id, source_url, source, status, phase, total_tracks, queued_count, processing_count,
              done_count, failed_count, deduped_count, error_code, error_message, created_at, updated_at, finished_at
       FROM playlist_workflows
       WHERE workflow_id = ?`,
    ).bind(workflowId).first<PlaylistWorkflowRecord>();
  }

  await recordTelemetry(env, {
    event: action === 'cancel' ? 'workflow_cancelled' : action === 'pause' ? 'workflow_paused' : 'workflow_resumed',
    status: '200',
    source: row.source,
  });

  return jsonOk(request, env, {
    ok: true,
    action,
    workflow: updated,
  });
}

async function handlePlaylistWorkflowZip(request: Request, env: Env, workflowId: string): Promise<Response> {
  await ensurePlaylistWorkflowSchema(env);
  const row = await env.DB.prepare(
    `SELECT workflow_id, source, status, phase
     FROM playlist_workflows
     WHERE workflow_id = ?`,
  ).bind(workflowId).first<{ workflow_id: string; source: string; status: JobStatus; phase: string }>();
  if (!row) {
    return jsonError(request, env, 'WORKFLOW_NOT_FOUND', 'Playlist workflow not found', 404);
  }

  try {
    await env.DB.prepare(
      `UPDATE playlist_workflows
       SET archive_status = 'building',
           archive_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE workflow_id = ?`,
    ).bind(workflowId).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(
      request,
      env,
      'SCHEMA_OUTDATED',
      `Playlist ZIP export requires latest schema migration (${message.slice(0, 180)})`,
      500,
      false,
    );
  }

  const doneRows = await env.DB.prepare(
    `SELECT j.id, j.title, j.artist, j.format
     FROM playlist_workflow_jobs wj
     JOIN download_jobs j ON j.id = wj.job_id
     WHERE wj.workflow_id = ?
       AND j.status = 'done'
     ORDER BY wj.created_at ASC`,
  ).bind(workflowId).all<{
    id: string;
    title: string | null;
    artist: string | null;
    format: string | null;
  }>();

  const files = await Promise.all((doneRows.results ?? []).map(async (rowItem) => ({
    job_id: rowItem.id,
    title: rowItem.title ?? 'Track',
    artist: rowItem.artist ?? 'Unknown',
    format: rowItem.format ?? 'mp3',
    download_url: await buildDownloadUrl(request, env, rowItem.id),
  })));

  if (files.length === 0) {
    await env.DB.prepare(
      `UPDATE playlist_workflows
       SET archive_status = 'failed',
           archive_error = 'No completed files are available for archive.',
           updated_at = CURRENT_TIMESTAMP
       WHERE workflow_id = ?`,
    ).bind(workflowId).run();
    return jsonError(request, env, 'WORKFLOW_ARCHIVE_EMPTY', 'No completed files available for ZIP', 400);
  }

  try {
    const startedAt = Date.now();
    const failover = await fetchDownloaderWithFailover(env, '/internal/playlist/zip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.DOWNLOADER_API_KEY,
      },
      body: JSON.stringify({
        workflow_id: workflowId,
        source: row.source,
        files,
      }),
    });
    const response = failover.response;
    if (!response.ok) {
      const details = await response.text();
      await env.DB.prepare(
        `UPDATE playlist_workflows
         SET archive_status = 'failed',
             archive_error = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE workflow_id = ?`,
      ).bind(details.slice(0, 400), workflowId).run();
      return jsonError(request, env, 'WORKFLOW_ARCHIVE_FAILED', details || 'ZIP build failed', 502, true);
    }

    const payload = await response.json() as {
      download_url?: string;
      filename?: string;
      file_size?: number;
    };

    const archiveUrl = normalizeDownloaderUrl(String(payload.download_url ?? ''), env);
    if (!archiveUrl) {
      throw new Error('ZIP response missing download_url');
    }

    await env.DB.prepare(
      `UPDATE playlist_workflows
       SET archive_status = 'ready',
           archive_url = ?,
           archive_error = NULL,
           archive_finished_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE workflow_id = ?`,
    ).bind(archiveUrl, workflowId).run();

    await recordTelemetry(env, {
      event: 'workflow_archive_ready',
      status: String(response.status),
      source: row.source,
      origin: failover.origin.baseUrl,
      latency_ms: Date.now() - startedAt,
      value: files.length,
    });

    return jsonOk(request, env, {
      ok: true,
      workflow_id: workflowId,
      archive_status: 'ready',
      archive_url: archiveUrl,
      archive_filename: payload.filename ?? `${workflowId}.zip`,
      archive_file_size: payload.file_size ?? 0,
      file_count: files.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(
      `UPDATE playlist_workflows
       SET archive_status = 'failed',
           archive_error = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE workflow_id = ?`,
    ).bind(message.slice(0, 400), workflowId).run();
    return jsonError(request, env, 'WORKFLOW_ARCHIVE_FAILED', message, 502, true);
  }
}

async function handleBatchPauseAll(request: Request, env: Env): Promise<Response> {
  await ensurePlaylistWorkflowSchema(env);
  const result = await env.DB.prepare(
    `UPDATE playlist_workflows
     SET control_state = 'paused',
         phase = 'paused',
         updated_at = CURRENT_TIMESTAMP
     WHERE COALESCE(control_state, 'active') = 'active'
       AND status IN ('queued', 'processing')`,
  ).run();

  await recordTelemetry(env, {
    event: 'batch_pause_all',
    status: '200',
    value: result.meta?.changes ?? 0,
  });

  return jsonOk(request, env, {
    ok: true,
    paused_workflows: result.meta?.changes ?? 0,
  });
}

async function handleBatchResumeAll(request: Request, env: Env): Promise<Response> {
  await ensurePlaylistWorkflowSchema(env);
  const rows = await env.DB.prepare(
    `SELECT workflow_id
     FROM playlist_workflows
     WHERE COALESCE(control_state, 'active') = 'paused'
       AND status IN ('queued', 'processing')`,
  ).all<{ workflow_id: string }>();

  let resumed = 0;
  let replayed = 0;
  for (const row of rows.results ?? []) {
    await env.DB.prepare(
      `UPDATE playlist_workflows
       SET control_state = 'active',
           phase = 'queued_tracks',
           status = 'processing',
           updated_at = CURRENT_TIMESTAMP
       WHERE workflow_id = ?`,
    ).bind(row.workflow_id).run();
    replayed += await replayQueuedWorkflowJobs(env, row.workflow_id);
    await notifyDownloaderWorkflowControl(env, row.workflow_id, 'resume');
    resumed += 1;
  }

  await recordTelemetry(env, {
    event: 'batch_resume_all',
    status: '200',
    value: replayed,
  });

  return jsonOk(request, env, {
    ok: true,
    resumed_workflows: resumed,
    replayed_jobs: replayed,
  });
}

async function handleJobControl(
  request: Request,
  env: Env,
  jobId: string,
  action: 'pause' | 'resume',
): Promise<Response> {
  const row = await getJobRecord(env, jobId);
  if (!row) {
    return jsonError(request, env, 'JOB_NOT_FOUND', 'Job not found', 404);
  }

  if (action === 'pause') {
    if (row.status !== 'queued') {
      return jsonError(request, env, 'JOB_NOT_PAUSABLE', 'Only queued jobs can be paused safely', 409);
    }
    await env.DB.prepare(
      `UPDATE download_jobs
       SET status = 'paused',
           error_code = 'JOB_PAUSED',
           error_message = 'Paused by user',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).bind(jobId).run();
    await enqueueHistoryEvent(env, {
      jobId,
      event: 'paused',
      status: 'paused',
      source: row.source,
    });
    const updated = await getJobRecord(env, jobId);
    return jsonOk(request, env, { ok: true, action, job: updated ? await hydrateJobRecord(request, env, updated) : null });
  }

  if (!['paused', 'failed', 'queued'].includes(row.status)) {
    return jsonError(request, env, 'JOB_NOT_RESUMABLE', 'Only paused, failed or queued jobs can be resumed', 409);
  }

  const format = normalizeAudioFormat(row.format, 'mp3');
  const quality = normalizeAudioQuality(row.quality, format, '320');
  const fingerprint = row.fingerprint ?? await createJobFingerprint(row.url, format, quality);

  await env.DB.prepare(
    `UPDATE download_jobs
     SET status = 'queued',
         attempts = 0,
         error_code = NULL,
         error_message = NULL,
         finished_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(jobId).run();

  await env.DOWNLOAD_QUEUE.send({
    id: row.id,
    url: row.url,
    source: row.source,
    format,
    quality,
    fingerprint,
    requestedAt: new Date().toISOString(),
  });

  await enqueueHistoryEvent(env, {
    jobId,
    event: 'resumed',
    status: 'queued',
    source: row.source,
  });

  const updated = await getJobRecord(env, jobId);
  return jsonOk(request, env, { ok: true, action, job: updated ? await hydrateJobRecord(request, env, updated) : null });
}

async function replayQueuedWorkflowJobs(env: Env, workflowId: string): Promise<number> {
  const queuedRows = await env.DB.prepare(
    `SELECT j.id, j.url, j.source, j.format, j.quality, j.fingerprint, j.created_at
     FROM playlist_workflow_jobs wj
     JOIN download_jobs j ON j.id = wj.job_id
     WHERE wj.workflow_id = ?
       AND j.status IN ('queued', 'paused')`,
  ).bind(workflowId).all<{
    id: string;
    url: string;
    source: string;
    format: AudioFormat;
    quality: AudioQuality;
    fingerprint: string;
    created_at: string;
  }>();

  let sent = 0;
  for (const row of queuedRows.results ?? []) {
    await env.DOWNLOAD_QUEUE.send({
      id: row.id,
      url: row.url,
      source: row.source,
      format: row.format,
      quality: row.quality,
      fingerprint: row.fingerprint,
      requestedAt: row.created_at,
    });
    sent += 1;
  }
  return sent;
}

function toInt(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) return 0;
  return Number(value ?? 0);
}

function deriveWorkflowStatus(rollup: PlaylistWorkflowRollup, totalTracks: number): JobStatus {
  if (totalTracks <= 0) return 'failed';
  const accounted = rollup.done_count + rollup.failed_count;
  if (accounted >= totalTracks) {
    return rollup.done_count > 0 ? 'done' : 'failed';
  }
  if (rollup.queued_count > 0 || rollup.processing_count > 0) {
    return 'processing';
  }
  return rollup.done_count > 0 ? 'done' : 'failed';
}

function deriveWorkflowPhase(status: JobStatus, rollup: PlaylistWorkflowRollup): string {
  if (status === 'done') return 'finalized';
  if (status === 'failed') return 'failed';
  if (rollup.processing_count > 0) return 'processing_batches';
  return 'queued_tracks';
}

async function syncPlaylistWorkflowRollup(
  env: Env,
  workflowId: string,
  totalTracksOverride?: number,
): Promise<PlaylistWorkflowRollup> {
  await ensurePlaylistWorkflowSchema(env);
  let rollup:
    | {
      total_links: number | null;
      queued_count: number | null;
      processing_count: number | null;
      done_count: number | null;
      failed_count: number | null;
      deduped_count: number | null;
    }
    | null = null;
  try {
    rollup = await env.DB.prepare(
      `SELECT
         COUNT(*) AS total_links,
         SUM(CASE WHEN j.status IN ('queued', 'paused') THEN 1 ELSE 0 END) AS queued_count,
         SUM(CASE WHEN j.status = 'processing' THEN 1 ELSE 0 END) AS processing_count,
         SUM(CASE WHEN j.status = 'done' THEN 1 ELSE 0 END) AS done_count,
         SUM(CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
         SUM(CASE WHEN wj.is_deduped = 1 THEN 1 ELSE 0 END) AS deduped_count
       FROM playlist_workflow_jobs wj
       LEFT JOIN download_jobs j ON j.id = wj.job_id
       WHERE wj.workflow_id = ?`,
    ).bind(workflowId).first<{
      total_links: number | null;
      queued_count: number | null;
      processing_count: number | null;
      done_count: number | null;
      failed_count: number | null;
      deduped_count: number | null;
    }>();
  } catch {
    const fallback = await env.DB.prepare(
      `SELECT queued_count, processing_count, done_count, failed_count, deduped_count, total_tracks
       FROM playlist_workflows
       WHERE workflow_id = ?`,
    ).bind(workflowId).first<{
      queued_count: number | null;
      processing_count: number | null;
      done_count: number | null;
      failed_count: number | null;
      deduped_count: number | null;
      total_tracks: number | null;
    }>();
    rollup = {
      total_links: fallback?.total_tracks ?? 0,
      queued_count: fallback?.queued_count ?? 0,
      processing_count: fallback?.processing_count ?? 0,
      done_count: fallback?.done_count ?? 0,
      failed_count: fallback?.failed_count ?? 0,
      deduped_count: fallback?.deduped_count ?? 0,
    };
  }

  const normalized: PlaylistWorkflowRollup = {
    total_links: toInt(rollup?.total_links),
    queued_count: toInt(rollup?.queued_count),
    processing_count: toInt(rollup?.processing_count),
    done_count: toInt(rollup?.done_count),
    failed_count: toInt(rollup?.failed_count),
    deduped_count: toInt(rollup?.deduped_count),
  };

  let controlRow: { control_state: string | null } | null = null;
  try {
    controlRow = await env.DB.prepare(
      `SELECT control_state
       FROM playlist_workflows
       WHERE workflow_id = ?`,
    ).bind(workflowId).first<{ control_state: string | null }>();
  } catch {
    controlRow = null;
  }
  const controlState = String(controlRow?.control_state ?? '').trim().toLowerCase();
  const totalTracks = totalTracksOverride ?? normalized.total_links;
  let status = deriveWorkflowStatus(normalized, totalTracks);
  let phase = deriveWorkflowPhase(status, normalized);
  if (controlState === 'paused') {
    status = 'queued';
    phase = 'paused';
  }
  if (controlState === 'cancelled') {
    status = 'failed';
    phase = 'cancelled';
  }

  await env.DB.prepare(
    `UPDATE playlist_workflows
     SET status = ?,
     phase = ?,
         total_tracks = ?,
         queued_count = ?,
         processing_count = ?,
         done_count = ?,
         failed_count = ?,
         deduped_count = ?,
         updated_at = CURRENT_TIMESTAMP,
         finished_at = CASE WHEN ? IN ('done', 'failed') THEN CURRENT_TIMESTAMP ELSE finished_at END
     WHERE workflow_id = ?`,
  ).bind(
    status,
    phase,
    totalTracks,
    normalized.queued_count,
    normalized.processing_count,
    normalized.done_count,
    normalized.failed_count,
    normalized.deduped_count,
    status,
    workflowId,
  ).run();

  return normalized;
}

async function getExistingJobByFingerprint(
  env: Env,
  fingerprint: string,
  dedupeTtlSeconds: number,
): Promise<ExistingFingerprintJob | null> {
  const dedupeKey = `dedupe:${fingerprint}`;
  let existingJobId: string | null = null;
  try {
    existingJobId = await env.CACHE.get(dedupeKey);
  } catch (error) {
    console.warn('Dedupe cache read skipped', error);
  }
  if (existingJobId) {
    const cached = await env.DB.prepare(
      `SELECT id, status
       FROM download_jobs
       WHERE id = ?
       LIMIT 1`,
    ).bind(existingJobId).first<ExistingFingerprintJob>();
    if (cached?.id) {
      return cached;
    }
  }

  const fromDb = await env.DB.prepare(
    `SELECT id, status
     FROM download_jobs
     WHERE fingerprint = ?
       AND status IN ('queued', 'processing', 'paused', 'done')
     ORDER BY
       CASE status
         WHEN 'done' THEN 0
         WHEN 'processing' THEN 1
         WHEN 'paused' THEN 2
         ELSE 3
       END,
       finished_at DESC,
       created_at DESC
     LIMIT 1`,
  ).bind(fingerprint).first<ExistingFingerprintJob>();

  if (!fromDb?.id) {
    return null;
  }

  try {
    await env.CACHE.put(dedupeKey, fromDb.id, { expirationTtl: dedupeTtlSeconds });
  } catch (error) {
    console.warn('Dedupe cache write skipped', error);
  }
  return fromDb;
}

async function handleJobStatus(request: Request, env: Env, jobId: string): Promise<Response> {
  const row = await getJobRecord(env, jobId);
  if (!row) {
    return jsonError(request, env, 'JOB_NOT_FOUND', 'Job not found', 404);
  }

  return jsonOk(request, env, { job: await hydrateJobRecord(request, env, row) });
}

async function handleJobEvents(request: Request, env: Env, jobId: string): Promise<Response> {
  const initial = await getJobRecord(env, jobId);
  if (!initial) {
    return jsonError(request, env, 'JOB_NOT_FOUND', 'Job not found', 404);
  }

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = async (event: string, payload: unknown): Promise<void> => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    await writer.write(encoder.encode(chunk));
  };

  const sendComment = async (value: string): Promise<void> => {
    await writer.write(encoder.encode(`: ${value}\n\n`));
  };

  void (async () => {
    let lastSerialized = '';
    const startedAt = Date.now();

    try {
      await writer.write(encoder.encode('retry: 2000\n\n'));

      while (Date.now() - startedAt < SSE_MAX_DURATION_MS) {
        const row = await getJobRecord(env, jobId);
        if (!row) {
          await sendEvent('error', { code: 'JOB_NOT_FOUND', message: 'Job not found' });
          break;
        }

        const hydrated = await hydrateJobRecord(request, env, row);
        const serialized = JSON.stringify(hydrated);
        if (serialized !== lastSerialized) {
          await sendEvent('job', hydrated);
          lastSerialized = serialized;
        } else {
          await sendComment('keep-alive');
        }

        if (row.status === 'done' || row.status === 'failed') {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, SSE_POLL_INTERVAL_MS));
      }
    } catch (error) {
      console.error('SSE stream error', error);
      await sendEvent('error', { code: 'SSE_STREAM_ERROR', message: 'Job stream failed' });
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      ...corsHeaders(request, env),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

async function handleHistory(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '20', 10)));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10));

  const rows = await env.DB.prepare(
    `SELECT id, source, format, quality, status, title, artist, duration, file_size, result_url, r2_key, content_hash, created_at
     FROM download_jobs
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<Record<string, unknown>>();

  const countRow = await env.DB.prepare('SELECT COUNT(*) AS total FROM download_jobs').first<{ total: number }>();

  const history = await Promise.all(
    (rows.results ?? []).map(async (row) => {
      const hasDownloadTarget =
        (typeof row.r2_key === 'string' && row.r2_key.length > 0)
        || (typeof row.result_url === 'string' && row.result_url.length > 0);

      if (row.status === 'done' && hasDownloadTarget) {
        const available = await isDownloadTargetAvailable(env, row);
        const downloadUrl = available ? await buildDownloadUrl(request, env, String(row.id)) : null;
        const streamUrl = downloadUrl ? await buildStreamUrl(request, env, String(row.id)) : null;
        return {
          ...row,
          download_url: downloadUrl,
          stream_url: streamUrl,
          download_available: Boolean(downloadUrl),
          stream_available: Boolean(streamUrl),
        };
      }
      return { ...row, download_url: null, stream_url: null, download_available: false, stream_available: false };
    }),
  );

  return jsonOk(request, env, {
    history,
    total: countRow?.total ?? history.length,
    limit,
    offset,
  });
}

async function handleStats(request: Request, env: Env): Promise<Response> {
  const summary = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
       SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
       SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(COALESCE(file_size, 0)) AS total_size_bytes,
       AVG(CASE WHEN duration IS NOT NULL AND duration > 0 THEN duration ELSE NULL END) AS avg_duration
     FROM download_jobs`,
  ).first<{
    total: number | null;
    queued: number | null;
    processing: number | null;
    paused: number | null;
    done: number | null;
    failed: number | null;
    total_size_bytes: number | null;
    avg_duration: number | null;
  }>();

  const byFormat = await env.DB.prepare(
    `SELECT format, COUNT(*) AS count
     FROM download_jobs
     GROUP BY format
     ORDER BY count DESC, format ASC`,
  ).all<{ format: string; count: number }>();

  const bySource = await env.DB.prepare(
    `SELECT source, COUNT(*) AS count
     FROM download_jobs
     GROUP BY source
     ORDER BY count DESC, source ASC`,
  ).all<{ source: string; count: number }>();

  const recent = await env.DB.prepare(
    `SELECT id, source, format, quality, status, title, artist, file_size, created_at
     FROM download_jobs
     ORDER BY created_at DESC
     LIMIT 8`,
  ).all<{
    id: string;
    source: string;
    format: string;
    quality: string;
    status: string;
    title: string | null;
    artist: string | null;
    file_size: number | null;
    created_at: string;
  }>();

  const totalSizeBytes = Number(summary?.total_size_bytes ?? 0);
  return jsonOk(request, env, {
    total: Number(summary?.total ?? 0),
    queued: Number(summary?.queued ?? 0),
    processing: Number(summary?.processing ?? 0),
    paused: Number(summary?.paused ?? 0),
    done: Number(summary?.done ?? 0),
    failed: Number(summary?.failed ?? 0),
    total_size_bytes: totalSizeBytes,
    total_size_mb: Math.round((totalSizeBytes / 1048576) * 10) / 10,
    avg_duration: Math.round(Number(summary?.avg_duration ?? 0)),
    by_format: byFormat.results ?? [],
    by_source: bySource.results ?? [],
    recent: recent.results ?? [],
  });
}

function handleFormats(request: Request, env: Env): Response {
  return jsonOk(request, env, {
    formats: [
      { id: 'mp3', label: 'MP3', lossy: true },
      { id: 'm4a', label: 'M4A', lossy: true },
      { id: 'ogg', label: 'OGG', lossy: true },
      { id: 'opus', label: 'OPUS', lossy: true },
      { id: 'flac', label: 'FLAC', lossy: false },
      { id: 'wav', label: 'WAV', lossy: false },
    ],
    qualities: [
      { id: 'lossless', label: 'Lossless', formats: ['flac', 'wav'] },
      { id: 'best', label: 'Best', formats: ['mp3', 'm4a', 'ogg', 'opus', 'flac', 'wav'] },
      { id: '320', label: '320 kbps', formats: ['mp3', 'm4a'] },
      { id: '256', label: '256 kbps', formats: ['mp3', 'm4a', 'ogg', 'opus'] },
      { id: '192', label: '192 kbps', formats: ['mp3', 'ogg', 'opus'] },
      { id: '128', label: '128 kbps', formats: ['mp3', 'ogg', 'opus'] },
      { id: '96', label: '96 kbps', formats: ['opus'] },
    ],
  });
}

async function handleArchiveList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const query = String(url.searchParams.get('q') ?? '').trim().slice(0, 160);
  const limit = Math.max(1, Math.min(300, Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const refresh = url.searchParams.get('refresh') === '1';
  const upstreamPath = `/internal/archive?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}${refresh ? '&refresh=true' : ''}`;

  try {
    const startedAt = Date.now();
    const failover = await fetchDownloaderWithFailover(env, upstreamPath, {
      method: 'GET',
      headers: {
        'X-API-Key': env.DOWNLOADER_API_KEY,
      },
    });
    await recordTelemetry(env, {
      event: 'archive_list',
      status: String(failover.response.status),
      origin: failover.origin.baseUrl,
      latency_ms: Date.now() - startedAt,
      code: failover.switched ? 'FAILOVER_SWITCHED' : 'PRIMARY_OK',
    });

    if (!failover.response.ok) {
      const details = await failover.response.text();
      return jsonError(request, env, 'ARCHIVE_FAILED', details.slice(0, 240) || 'Archive provider failed', 502, true);
    }

    const payload = await failover.response.json() as {
      tracks?: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    };
    const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
    const rewritten = tracks.map((track) => ({
      ...track,
      stream_url: `/api/archive/file/${encodeURIComponent(String(track.id ?? ''))}`,
    }));
    return jsonOk(request, env, {
      tracks: rewritten,
      total: Number(payload.total ?? rewritten.length),
      limit: Number(payload.limit ?? limit),
      offset: Number(payload.offset ?? offset),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(request, env, 'ARCHIVE_UNREACHABLE', `Archive provider is unreachable: ${message.slice(0, 160)}`, 502, true);
  }
}

async function handleArchiveBrowse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const query = String(url.searchParams.get('q') ?? '').trim().slice(0, 160);
  const path = String(url.searchParams.get('path') ?? '').trim().slice(0, 320);
  const limit = Math.max(1, Math.min(300, Number.parseInt(url.searchParams.get('limit') ?? '120', 10) || 120));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const params = new URLSearchParams({
    query,
    path,
    limit: String(limit),
    offset: String(offset),
  });
  const upstreamPath = `/internal/archive/browse?${params.toString()}`;

  try {
    const startedAt = Date.now();
    const failover = await fetchDownloaderWithFailover(env, upstreamPath, {
      method: 'GET',
      headers: {
        'X-API-Key': env.DOWNLOADER_API_KEY,
      },
    });
    await recordTelemetry(env, {
      event: 'archive_browse',
      status: String(failover.response.status),
      origin: failover.origin.baseUrl,
      latency_ms: Date.now() - startedAt,
      code: failover.switched ? 'FAILOVER_SWITCHED' : 'PRIMARY_OK',
    });

    if (!failover.response.ok) {
      const details = await failover.response.text();
      return jsonError(request, env, 'ARCHIVE_BROWSE_FAILED', details.slice(0, 240) || 'Archive browse provider failed', 502, true);
    }

    const payload = await failover.response.json() as {
      items?: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
      path?: string;
      parent_path?: string | null;
    };
    const items = Array.isArray(payload.items) ? payload.items : [];
    const rewritten = items.map((item) => {
      const id = String(item.id ?? '');
      const kind = String(item.kind ?? '');
      const hasFileStream = id && (kind === 'audio' || kind === 'image');
      return {
        ...item,
        stream_url: hasFileStream ? `/api/archive/file/${encodeURIComponent(id)}` : null,
      };
    });
    return jsonOk(request, env, {
      items: rewritten,
      total: Number(payload.total ?? rewritten.length),
      limit: Number(payload.limit ?? limit),
      offset: Number(payload.offset ?? offset),
      path: String(payload.path ?? path),
      parent_path: typeof payload.parent_path === 'string' ? payload.parent_path : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(request, env, 'ARCHIVE_BROWSE_UNREACHABLE', `Archive browser is unreachable: ${message.slice(0, 160)}`, 502, true);
  }
}

async function handleArchiveFile(request: Request, env: Env, fileId: string): Promise<Response> {
  const headers: Record<string, string> = {
    'X-API-Key': env.DOWNLOADER_API_KEY,
  };
  const range = request.headers.get('range');
  if (range) headers.Range = range;
  const ifRange = request.headers.get('if-range');
  if (ifRange) headers['If-Range'] = ifRange;

  try {
    const failover = await fetchDownloaderWithFailover(env, `/internal/archive/files/${encodeURIComponent(fileId)}`, {
      method: 'GET',
      headers,
    });
    const upstream = failover.response;
    await recordTelemetry(env, {
      event: 'archive_file',
      status: String(upstream.status),
      origin: failover.origin.baseUrl,
      code: failover.switched ? 'FAILOVER_SWITCHED' : 'PRIMARY_OK',
    });

    if (!upstream.ok || !upstream.body) {
      const details = await upstream.text();
      return jsonError(request, env, 'ARCHIVE_FILE_FAILED', details.slice(0, 240) || 'Archive file is unavailable', upstream.status === 404 ? 404 : 502, true);
    }

    const responseHeaders = new Headers(corsHeaders(request, env));
    for (const name of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'etag',
      'last-modified',
      'cache-control',
    ]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    const upstreamDisposition = upstream.headers.get('content-disposition');
    responseHeaders.set(
      'content-disposition',
      upstreamDisposition ? upstreamDisposition.replace(/^attachment/i, 'inline') : 'inline',
    );

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(request, env, 'ARCHIVE_FILE_UNREACHABLE', `Archive file provider is unreachable: ${message.slice(0, 160)}`, 502, true);
  }
}

function resolvePublicBaseUrl(request: Request, env: Env): string {
  const configured = (env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/g, '');
  if (configured) return configured;
  const requestUrl = new URL(request.url);
  return requestUrl.origin;
}

function normalizeVersionTag(raw: string | undefined, fallback: string): string {
  const value = String(raw ?? '').trim();
  return /^[0-9]+(?:\.[0-9]+){1,2}$/.test(value) ? value : fallback;
}

function readReleaseManifestCacheTtl(env: Env): number {
  return readEnvInt(env.RELEASE_MANIFEST_CACHE_TTL_SECONDS, 600);
}

function buildReleaseManifestPayloadWithoutSignature(
  base: string,
  env: Env,
  artifacts: ReleaseArtifactEntry[],
): Record<string, unknown> {
  const channel = String(env.RELEASE_CHANNEL ?? 'stable').trim() || 'stable';
  return {
    schema: 1,
    channel,
    generated_at: new Date().toISOString(),
    artifacts,
  };
}

function toArrayBufferFromBase64(raw: string): ArrayBuffer {
  const cleaned = raw.replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function extractPkcs8Base64FromInput(raw: string): string {
  const trimmed = raw.trim();
  const pemMatch = trimmed.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
  if (pemMatch?.[1]) {
    return pemMatch[1].replace(/\s+/g, '');
  }
  return trimmed.replace(/\s+/g, '');
}

function toBase64Url(bytes: ArrayBuffer): string {
  const normalized = new Uint8Array(bytes);
  let binary = '';
  for (const value of normalized) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

async function maybeSignReleasePayload(
  payload: Record<string, unknown>,
  env: Env,
): Promise<{ algorithm: string; key_id: string; signature: string; signed_payload_hash: string } | null> {
  const rawKey = String(env.RELEASE_SIGNING_PRIVATE_KEY_PKCS8_BASE64 ?? '').trim();
  if (!rawKey) {
    return null;
  }
  try {
    const normalizedKey = extractPkcs8Base64FromInput(rawKey);
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      toArrayBufferFromBase64(normalizedKey),
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    const serialized = stableStringify(payload);
    const data = new TextEncoder().encode(serialized);
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data);
    return {
      algorithm: 'Ed25519',
      key_id: String(env.RELEASE_SIGNING_KEY_ID ?? 'primary').trim() || 'primary',
      signature: toBase64Url(signature),
      signed_payload_hash: await sha256HexBytes(data),
    };
  } catch (error) {
    console.error('Release manifest signing failed', error);
    return null;
  }
}

async function buildReleaseArtifacts(base: string, env: Env): Promise<ReleaseArtifactEntry[]> {
  const minDesktopWindows = normalizeVersionTag(env.MIN_CLIENT_DESKTOP_WINDOWS, '7.2.0');
  const minDesktopMacos = normalizeVersionTag(env.MIN_CLIENT_DESKTOP_MACOS, '7.2.0');
  const minExtension = normalizeVersionTag(env.MIN_CLIENT_EXTENSION, '1.0.0');
  const latestDesktopWindows = normalizeVersionTag(env.LATEST_DESKTOP_WINDOWS_VERSION, minDesktopWindows);
  const latestDesktopMacos = normalizeVersionTag(env.LATEST_DESKTOP_MACOS_VERSION, minDesktopMacos);
  const latestExtension = normalizeVersionTag(env.LATEST_EXTENSION_VERSION, minExtension);
  const versionByArtifact: Record<ReleaseArtifactEntry['id'], { latest: string; minimum: string }> = {
    desktop_windows: { latest: latestDesktopWindows, minimum: minDesktopWindows },
    desktop_macos: { latest: latestDesktopMacos, minimum: minDesktopMacos },
    extension_chrome: { latest: latestExtension, minimum: minExtension },
    extension_firefox: { latest: latestExtension, minimum: minExtension },
  };

  const out: ReleaseArtifactEntry[] = [];
  for (const artifact of RELEASE_ARTIFACTS) {
    try {
      const request = new Request(`https://assets.local${artifact.path}`);
      const response = await env.ASSETS.fetch(request);
      if (!response.ok) {
        continue;
      }
      const bytes = await response.arrayBuffer();
      const meta = versionByArtifact[artifact.id];
      out.push({
        id: artifact.id,
        filename: artifact.filename,
        path: artifact.path,
        url: `${base}${artifact.path}`,
        sha256: await sha256HexBytes(bytes),
        bytes: bytes.byteLength,
        version: meta.latest,
        minimum_supported: meta.minimum,
        platform: artifact.platform,
      });
    } catch (error) {
      console.error(`Release artifact hashing failed for ${artifact.path}`, error);
    }
  }

  return out;
}

async function getReleaseManifest(base: string, env: Env): Promise<Record<string, unknown>> {
  const channel = String(env.RELEASE_CHANNEL ?? 'stable').trim() || 'stable';
  const cacheKey = `release:manifest:${channel}`;
  const cached = await env.CACHE.get(cacheKey, { type: 'json' }) as Record<string, unknown> | null;
  if (cached && typeof cached === 'object') {
    return cached;
  }

  const artifacts = await buildReleaseArtifacts(base, env);
  const payload = buildReleaseManifestPayloadWithoutSignature(base, env, artifacts);
  const signature = await maybeSignReleasePayload(payload, env);
  const manifest = {
    ...payload,
    signature: signature ?? {
      algorithm: 'none',
      key_id: '',
      signature: '',
      signed_payload_hash: '',
    },
    signed: Boolean(signature),
  };
  try {
    await env.CACHE.put(cacheKey, JSON.stringify(manifest), { expirationTtl: readReleaseManifestCacheTtl(env) });
  } catch {
    // best effort only
  }
  return manifest;
}

function buildUpdatesPayload(base: string, env: Env): Record<string, unknown> {
  const minDesktopWindows = normalizeVersionTag(env.MIN_CLIENT_DESKTOP_WINDOWS, '7.2.0');
  const minDesktopMacos = normalizeVersionTag(env.MIN_CLIENT_DESKTOP_MACOS, '7.2.0');
  const minMobileExpo = normalizeVersionTag(env.MIN_CLIENT_MOBILE_EXPO, '1.0.0');
  const minExtension = normalizeVersionTag(env.MIN_CLIENT_EXTENSION, '1.0.0');
  const latestDesktopWindows = normalizeVersionTag(env.LATEST_DESKTOP_WINDOWS_VERSION, minDesktopWindows);
  const latestDesktopMacos = normalizeVersionTag(env.LATEST_DESKTOP_MACOS_VERSION, minDesktopMacos);
  const latestMobileExpo = normalizeVersionTag(env.LATEST_MOBILE_EXPO_VERSION, minMobileExpo);
  const latestExtension = normalizeVersionTag(env.LATEST_EXTENSION_VERSION, minExtension);
  const channel = String(env.RELEASE_CHANNEL ?? 'stable').trim() || 'stable';

  return {
    channel,
    generated_at: new Date().toISOString(),
    desktop_windows: {
      minimum_supported: minDesktopWindows,
      latest: latestDesktopWindows,
      download_url: `${base}/downloads/DyrakArmyDesktop.exe`,
    },
    desktop_macos: {
      minimum_supported: minDesktopMacos,
      latest: latestDesktopMacos,
      download_url: `${base}/downloads/DyrakArmyDesktop-macOS.zip`,
    },
    mobile_expo: {
      minimum_supported: minMobileExpo,
      latest: latestMobileExpo,
      update_url: `${base}/`,
    },
    extension: {
      minimum_supported: minExtension,
      latest: latestExtension,
      chrome_zip_url: `${base}/downloads/DyrakArmy-Extension-Chrome.zip`,
      firefox_zip_url: `${base}/downloads/DyrakArmy-Extension-Firefox.zip`,
    },
    manifest_url: `${base}/api/releases/manifest`,
  };
}

function handleUpdates(request: Request, env: Env): Response {
  const base = resolvePublicBaseUrl(request, env);
  void recordTelemetry(env, {
    event: 'updates_read',
    status: '200',
  });
  return jsonOk(request, env, buildUpdatesPayload(base, env));
}

async function handleReleaseManifest(request: Request, env: Env): Promise<Response> {
  const base = resolvePublicBaseUrl(request, env);
  const manifest = await getReleaseManifest(base, env);
  await recordTelemetry(env, {
    event: 'release_manifest_read',
    status: '200',
  });
  return jsonOk(request, env, manifest);
}

async function handleRuntimeConfig(request: Request, env: Env): Promise<Response> {
  const base = resolvePublicBaseUrl(request, env);
  const telegram = await resolveTelegramInfo(env);
  const updates = buildUpdatesPayload(base, env);

  const payload = {
    api_base: `${base}/api`,
    public_base: base,
    downloader_origins: getConfiguredOrigins(env).map((origin) => ({
      id: origin.id,
      base_url: origin.baseUrl,
      priority: origin.priority,
    })),
    downloads: {
      windows_exe: `${base}/downloads/DyrakArmyDesktop.exe`,
      macos_portable: `${base}/downloads/DyrakArmyDesktop-macOS.zip`,
      extension_chrome: `${base}/downloads/DyrakArmy-Extension-Chrome.zip`,
      extension_firefox: `${base}/downloads/DyrakArmy-Extension-Firefox.zip`,
    },
    telegram: telegram?.available ? {
      available: true,
      deep_link: telegram.deepLink,
      download_link: telegram.downloadLink,
    } : { available: false },
    supported_languages: ['en', 'bg', 'es', 'ru', 'de'],
    supported_sources: ['all', 'youtube', 'spotify', 'soundcloud', 'deezer', 'apple', 'podcast'],
    default_language: 'en',
    features: {
      sse_job_events: true,
      playlist_workflows: true,
      origin_failover: true,
      ops_summary: true,
      global_content_hash_cache: Boolean(env.FILES),
      playlist_control: true,
      playlist_zip_export: true,
      preference_sync_v2: true,
      ops_replay: true,
      admin_panel_v2: true,
      update_channel_v1: true,
      signed_release_manifest_v1: true,
      smart_format_auto_selector: true,
      shared_queue: true,
      offline_cache_warming: true,
      archive_browser_v2: true,
    },
    client_min_versions: {
      web: (env.MIN_CLIENT_WEB ?? '7.0.0').trim(),
      desktop_windows: (env.MIN_CLIENT_DESKTOP_WINDOWS ?? '7.2.0').trim(),
      desktop_macos: (env.MIN_CLIENT_DESKTOP_MACOS ?? '7.2.0').trim(),
      mobile_expo: (env.MIN_CLIENT_MOBILE_EXPO ?? '1.0.0').trim(),
      extension: (env.MIN_CLIENT_EXTENSION ?? '1.0.0').trim(),
    },
    preference_defaults: {
      language: 'en',
      source: 'all',
      format: 'mp3',
      quality: '320',
      download_directory: '',
      telegram_link_mode: 'bot',
    },
    updates,
    release_manifest_url: `${base}/api/releases/manifest`,
    generated_at: new Date().toISOString(),
  };

  await recordTelemetry(env, {
    event: 'runtime_config_read',
    status: '200',
  });
  return jsonOk(request, env, payload);
}

function readOpsTokenFromRequest(request: Request): string {
  const tokenHeader = request.headers.get('Authorization') ?? '';
  if (!tokenHeader.startsWith('Bearer ')) return '';
  return tokenHeader.slice('Bearer '.length).trim();
}

function maskTokenId(token: string): string {
  if (!token) return 'anonymous';
  if (token.length <= 10) return `${token.slice(0, 2)}***`;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function resolveOpsAuthContext(request: Request, env: Env): OpsAuthContext {
  const token = readOpsTokenFromRequest(request);
  if (!token) return { role: 'none', tokenId: 'anonymous' };

  const adminToken = String(env.OPS_ADMIN_TOKEN ?? '').trim();
  const operatorToken = String(env.OPS_OPERATOR_TOKEN ?? '').trim();
  const readToken = String(env.OPS_READ_TOKEN ?? '').trim();

  if (adminToken && token === adminToken) return { role: 'admin', tokenId: maskTokenId(token) };
  if (operatorToken && token === operatorToken) return { role: 'operator', tokenId: maskTokenId(token) };
  if (readToken && token === readToken) return { role: 'viewer', tokenId: maskTokenId(token) };

  return { role: 'none', tokenId: maskTokenId(token) };
}

function hasOpsRole(context: OpsAuthContext, required: Exclude<OpsRole, 'none'>): boolean {
  if (context.role === 'none') return false;
  return OPS_ROLE_ORDER[context.role] >= OPS_ROLE_ORDER[required];
}

async function ensureOpsAuditTable(env: Env): Promise<void> {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS ops_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      role TEXT NOT NULL,
      token_id TEXT,
      ip TEXT,
      status TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ops_audit_created ON ops_audit_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ops_audit_action ON ops_audit_events(action, created_at DESC);`,
  );
}

async function writeOpsAuditEvent(
  env: Env,
  request: Request,
  action: string,
  context: OpsAuthContext,
  status: 'allowed' | 'denied' | 'limited' | 'success' | 'failed',
  details: string | Record<string, unknown>,
): Promise<void> {
  try {
    const requestUrl = new URL(request.url);
    const detailsPayload = typeof details === 'string'
      ? { message: details }
      : details;
    const serializedDetails = JSON.stringify({
      method: request.method,
      path: requestUrl.pathname,
      ip: getClientAddress(request),
      cf_ray: request.headers.get('cf-ray') ?? '',
      ...detailsPayload,
    }).slice(0, 500);

    await ensureOpsAuditTable(env);
    await env.DB.prepare(
      `INSERT INTO ops_audit_events (action, role, token_id, ip, status, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      action,
      context.role,
      context.tokenId,
      getClientAddress(request),
      status,
      serializedDetails,
    ).run();
  } catch {
    // do not fail main flow if audit insert fails
  }
}

function readOpsReplayRateLimit(env: Env): number {
  return readEnvInt(env.OPS_REPLAY_RATE_LIMIT_PER_MINUTE, 12);
}

function readOpsReplayRateLimitByRole(env: Env, role: OpsRole): number {
  if (role === 'admin') {
    return readEnvInt(
      env.OPS_REPLAY_RATE_LIMIT_ADMIN_PER_MINUTE,
      Math.max(1, readOpsReplayRateLimit(env) * 2),
    );
  }
  if (role === 'operator') {
    return readEnvInt(env.OPS_REPLAY_RATE_LIMIT_OPERATOR_PER_MINUTE, readOpsReplayRateLimit(env));
  }
  return readOpsReplayRateLimit(env);
}

function readOpsReplayIpRateLimit(env: Env): number {
  return readEnvInt(env.OPS_REPLAY_RATE_LIMIT_IP_PER_MINUTE, 30);
}

function readOpsReplayMaxTargetsForRole(env: Env, role: OpsRole): number {
  if (role === 'admin') {
    return readEnvInt(env.OPS_REPLAY_MAX_TARGETS_ADMIN, 200);
  }
  if (role === 'operator') {
    return readEnvInt(env.OPS_REPLAY_MAX_TARGETS_OPERATOR, 60);
  }
  return 1;
}

async function handleOpsSummary(request: Request, env: Env): Promise<Response> {
  const auth = resolveOpsAuthContext(request, env);
  if (!hasOpsRole(auth, 'viewer')) {
    await writeOpsAuditEvent(env, request, 'ops_summary', auth, 'denied', 'missing_or_invalid_token');
    return jsonError(request, env, 'FORBIDDEN', 'Missing or invalid ops token', 403);
  }
  await writeOpsAuditEvent(env, request, 'ops_summary', auth, 'allowed', 'summary_read');

  const summary = await buildOpsSummary(env);
  const origins = await listOriginStates(env);
  const recentWorkflows = await env.DB.prepare(
    `SELECT workflow_id, status, phase, control_state, total_tracks, queued_count, processing_count,
            done_count, failed_count, deduped_count, archive_status, updated_at, finished_at
     FROM playlist_workflows
     ORDER BY datetime(updated_at) DESC
     LIMIT 30`,
  ).all<{
    workflow_id: string;
    status: string;
    phase: string;
    control_state: string | null;
    total_tracks: number | null;
    queued_count: number | null;
    processing_count: number | null;
    done_count: number | null;
    failed_count: number | null;
    deduped_count: number | null;
    archive_status: string | null;
    updated_at: string | null;
    finished_at: string | null;
  }>().catch(() => ({ results: [] }));
  const failedJobs = await env.DB.prepare(
    `SELECT id, source, format, quality, attempts, error_code, error_message, updated_at
     FROM download_jobs
     WHERE status = 'failed'
     ORDER BY datetime(updated_at) DESC
     LIMIT 40`,
  ).all<{
    id: string;
    source: string;
    format: string;
    quality: string;
    attempts: number | null;
    error_code: string | null;
    error_message: string | null;
    updated_at: string | null;
  }>().catch(() => ({ results: [] }));
  const queueSamples = await env.DB.prepare(
    `SELECT id, status, source, format, quality, attempts, created_at, updated_at
     FROM download_jobs
     WHERE status IN ('queued', 'processing')
     ORDER BY datetime(created_at) ASC
     LIMIT 40`,
  ).all<{
    id: string;
    status: string;
    source: string;
    format: string;
    quality: string;
    attempts: number | null;
    created_at: string | null;
    updated_at: string | null;
  }>().catch(() => ({ results: [] }));
  const recentAudit = await env.DB.prepare(
    `SELECT id, action, role, token_id, ip, status, details, created_at
     FROM ops_audit_events
     ORDER BY datetime(created_at) DESC
     LIMIT 40`,
  ).all<{
    id: number;
    action: string;
    role: string;
    token_id: string | null;
    ip: string | null;
    status: string;
    details: string | null;
    created_at: string | null;
  }>().catch(() => ({ results: [] }));
  return jsonOk(request, env, {
    ...summary,
    ops_auth: { role: auth.role },
    ops_policy: {
      replay_rate_limit_per_minute: {
        operator: readOpsReplayRateLimitByRole(env, 'operator'),
        admin: readOpsReplayRateLimitByRole(env, 'admin'),
        ip: readOpsReplayIpRateLimit(env),
      },
      replay_max_targets: {
        operator: readOpsReplayMaxTargetsForRole(env, 'operator'),
        admin: readOpsReplayMaxTargetsForRole(env, 'admin'),
      },
      include_queued_requires_role: 'admin',
      replay_failed_recent_requires_role: 'admin',
    },
    origins,
    recent_workflows: recentWorkflows.results ?? [],
    failed_jobs: failedJobs.results ?? [],
    queue_samples: queueSamples.results ?? [],
    ops_audit: recentAudit.results ?? [],
  });
}

async function handleOpsReplay(request: Request, env: Env): Promise<Response> {
  const auth = resolveOpsAuthContext(request, env);
  const clientIp = getClientAddress(request);
  if (!hasOpsRole(auth, 'operator')) {
    await writeOpsAuditEvent(env, request, 'ops_replay', auth, 'denied', {
      reason: 'requires_operator',
    });
    return jsonError(request, env, 'FORBIDDEN', 'Missing or invalid ops token', 403);
  }

  const body = await parseJson<OpsReplayRequestBody>(request);
  const includeQueued = Boolean(body?.include_queued);
  if (auth.role !== 'admin' && includeQueued) {
    await writeOpsAuditEvent(env, request, 'ops_replay', auth, 'denied', {
      reason: 'include_queued_requires_admin',
      role: auth.role,
    });
    return jsonError(request, env, 'FORBIDDEN', 'include_queued requires admin role', 403);
  }
  if (auth.role !== 'admin' && body?.replay_failed_recent) {
    await writeOpsAuditEvent(env, request, 'ops_replay', auth, 'denied', {
      reason: 'replay_failed_recent_requires_admin',
      role: auth.role,
    });
    return jsonError(request, env, 'FORBIDDEN', 'replay_failed_recent requires admin role', 403);
  }

  const replayRate = await rateLimit(
    env.CACHE,
    `ops-replay:actor:${auth.role}:${auth.tokenId}`,
    readOpsReplayRateLimitByRole(env, auth.role),
    60,
  );
  const ipRate = await rateLimit(
    env.CACHE,
    `ops-replay:ip:${clientIp}`,
    readOpsReplayIpRateLimit(env),
    60,
  );
  if (replayRate.limited || ipRate.limited) {
    await writeOpsAuditEvent(env, request, 'ops_replay', auth, 'limited', {
      actor_reset_at: replayRate.resetAt,
      actor_limited: replayRate.limited,
      ip_limited: ipRate.limited,
      ip_reset_at: ipRate.resetAt,
      role: auth.role,
    });
    return jsonError(request, env, 'RATE_LIMITED', 'Too many replay requests', 429, true);
  }

  const requestedLimit = Number(body?.limit ?? 25);
  const roleMaxTargets = readOpsReplayMaxTargetsForRole(env, auth.role);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(roleMaxTargets, Math.trunc(requestedLimit)))
    : 25;

  const replayableStatuses: JobStatus[] = includeQueued
    ? ['failed', 'queued']
    : ['failed'];

  const validJobId = (value: string): boolean => /^[0-9a-f-]{36}$/i.test(value);
  const requestedIds = new Set<string>();

  for (const item of body?.job_ids ?? []) {
    const id = String(item ?? '').trim().toLowerCase();
    if (validJobId(id)) requestedIds.add(id);
    if (requestedIds.size >= limit) break;
  }

  const workflowId = String(body?.workflow_id ?? '').trim().toLowerCase();
  if (workflowId) {
    const workflowRows = await env.DB.prepare(
      `SELECT j.id
       FROM playlist_workflow_jobs wj
       JOIN download_jobs j ON j.id = wj.job_id
       WHERE wj.workflow_id = ?
         AND j.status IN (${replayableStatuses.map(() => '?').join(', ')})
       ORDER BY datetime(j.updated_at) DESC
       LIMIT ?`,
    ).bind(workflowId, ...replayableStatuses, limit).all<{ id: string }>();
    for (const row of workflowRows.results ?? []) {
      const id = String(row.id ?? '').toLowerCase();
      if (validJobId(id)) requestedIds.add(id);
      if (requestedIds.size >= limit) break;
    }
  }

  if (body?.replay_failed_recent && requestedIds.size < limit) {
    const recentRows = await env.DB.prepare(
      `SELECT id
       FROM download_jobs
       WHERE status = 'failed'
         AND datetime(updated_at) >= datetime('now', '-1 hour')
       ORDER BY datetime(updated_at) DESC
       LIMIT ?`,
    ).bind(limit).all<{ id: string }>();
    for (const row of recentRows.results ?? []) {
      const id = String(row.id ?? '').toLowerCase();
      if (validJobId(id)) requestedIds.add(id);
      if (requestedIds.size >= limit) break;
    }
  }

  if (requestedIds.size === 0) {
    await writeOpsAuditEvent(env, request, 'ops_replay', auth, 'failed', {
      reason: 'no_replay_targets',
      role: auth.role,
      requested_limit: requestedLimit,
      enforced_limit: limit,
    });
    return jsonError(request, env, 'NO_REPLAY_TARGETS', 'No replay targets selected', 400);
  }

  const candidates = await env.DB.prepare(
    `SELECT id, url, source, format, quality, fingerprint, chat_id, message_id, created_at, status
     FROM download_jobs
     WHERE id IN (${Array.from(requestedIds).map(() => '?').join(', ')})`,
  ).bind(...Array.from(requestedIds)).all<{
    id: string;
    url: string;
    source: string;
    format: string;
    quality: string;
    fingerprint: string | null;
    chat_id: number | null;
    message_id: number | null;
    created_at: string | null;
    status: JobStatus;
  }>();

  let replayed = 0;
  let skipped = 0;
  const replayedIds: string[] = [];
  const skippedIds: string[] = [];

  for (const row of candidates.results ?? []) {
    const rowStatus = String(row.status ?? '').toLowerCase() as JobStatus;
    if (!replayableStatuses.includes(rowStatus)) {
      skipped += 1;
      skippedIds.push(row.id);
      continue;
    }

    const format = AUDIO_FORMATS.includes(row.format as AudioFormat) ? (row.format as AudioFormat) : 'mp3';
    const quality = AUDIO_QUALITIES.includes(row.quality as AudioQuality) ? (row.quality as AudioQuality) : '320';
    const source = normalizeSource(row.source || detectSourceFromUrl(row.url));
    const fingerprint = row.fingerprint || await createJobFingerprint(row.url, format, quality);

    await env.DB.prepare(
      `UPDATE download_jobs
       SET status = 'queued',
           error_code = NULL,
           error_message = NULL,
           finished_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).bind(row.id).run();

    await env.DOWNLOAD_QUEUE.send({
      id: row.id,
      url: row.url,
      source,
      format,
      quality,
      fingerprint,
      chatId: row.chat_id ?? undefined,
      messageId: row.message_id ?? undefined,
      requestedAt: new Date().toISOString(),
    });

    replayed += 1;
    replayedIds.push(row.id);
  }

  await recordTelemetry(env, {
    event: 'queue_replay_manual',
    status: replayed > 0 ? '200' : '400',
    code: `replayed=${replayed};skipped=${skipped}`,
    value: replayed,
  });
  await writeOpsAuditEvent(
    env,
    request,
    'ops_replay',
    auth,
    replayed > 0 ? 'success' : 'failed',
    {
      role: auth.role,
      requested: requestedIds.size,
      replayed,
      skipped,
      include_queued: includeQueued,
      workflow_id: workflowId || null,
      requested_limit: requestedLimit,
      enforced_limit: limit,
      max_targets_for_role: roleMaxTargets,
    },
  );

  return jsonOk(request, env, {
    ok: true,
    role: auth.role,
    requested: requestedIds.size,
    replayed,
    skipped,
    replayed_ids: replayedIds,
    skipped_ids: skippedIds,
  });
}

async function resolveTelegramInfo(env: Env): Promise<{ available: boolean; username?: string; deepLink?: string; downloadLink?: string }> {
  const configuredUsername = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '');
  if (configuredUsername) {
    return {
      available: true,
      username: configuredUsername,
      deepLink: `https://t.me/${configuredUsername}`,
      downloadLink: `https://t.me/${configuredUsername}?start=download`,
    };
  }

  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return { available: false };
  }
  const cacheKey = 'telegram:info';
  try {
    const cached = await env.CACHE.get(cacheKey, { type: 'json' }) as TelegramInfoCache | null;
    if (cached?.username && cached.deepLink) {
      return {
        available: true,
        ...cached,
      };
    }
  } catch {
    // ignore cache parse issues and continue with live fetch
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    if (!response.ok) {
      const details = await response.text();
      console.warn(`Telegram getMe failed (${response.status}): ${details.slice(0, 240)}`);
      return { available: false };
    }

    const payload = await response.json() as {
      ok?: boolean;
      result?: { username?: string };
    };
    const username = payload.result?.username?.trim();
    if (!payload.ok || !username) {
      return { available: false };
    }

    const info: TelegramInfoCache = {
      username,
      deepLink: `https://t.me/${username}`,
      downloadLink: `https://t.me/${username}?start=download`,
    };
    await env.CACHE.put(cacheKey, JSON.stringify(info), { expirationTtl: 60 * 60 });

    return {
      available: true,
      ...info,
    };
  } catch (error) {
    console.error('Telegram info fetch failed', error);
    return { available: false };
  }
}

async function handleTelegramInfo(request: Request, env: Env): Promise<Response> {
  const info = await resolveTelegramInfo(env);
  return jsonOk(request, env, info);
}

async function ensurePreferencesTable(env: Env): Promise<void> {
  if (preferencesSchemaReady) {
    await preferencesSchemaReady;
    return;
  }

  preferencesSchemaReady = (async () => {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS user_preferences (sync_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_user_preferences_updated ON user_preferences(updated_at DESC)',
    ).run();
  })();

  try {
    await preferencesSchemaReady;
  } catch (error) {
    preferencesSchemaReady = null;
    throw error;
  }
}

async function ensureSharedQueueTable(env: Env): Promise<void> {
  if (sharedQueueSchemaReady) {
    await sharedQueueSchemaReady;
    return;
  }

  sharedQueueSchemaReady = (async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS shared_queue_items (
        id TEXT PRIMARY KEY,
        sync_key TEXT NOT NULL,
        job_id TEXT,
        url TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        format TEXT NOT NULL DEFAULT 'mp3',
        quality TEXT NOT NULL DEFAULT '320',
        title TEXT,
        artist TEXT,
        added_by TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_shared_queue_sync_created ON shared_queue_items(sync_key, created_at DESC)',
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_shared_queue_job ON shared_queue_items(job_id)',
    ).run();
  })();

  try {
    await sharedQueueSchemaReady;
  } catch (error) {
    sharedQueueSchemaReady = null;
    throw error;
  }
}

async function readPreferencesFromD1(env: Env, key: string): Promise<PreferencesState | null> {
  try {
    await ensurePreferencesTable(env);
    const sessionCapableDb = env.DB as D1Database & { withSession?: (constraint?: string) => D1Database };
    const db = typeof sessionCapableDb.withSession === 'function'
      ? sessionCapableDb.withSession('first-primary')
      : env.DB;
    const row = await db.prepare(
      `SELECT payload FROM user_preferences WHERE sync_key = ? ORDER BY updated_at DESC LIMIT 1`,
    ).bind(key).first<{ payload: string | null }>();
    if (!row?.payload) return null;
    const parsed = JSON.parse(row.payload) as PreferencesState;
    return normalizePreferencesState(parsed);
  } catch (error) {
    console.error('readPreferencesFromD1 failed', error);
    return null;
  }
}

async function writePreferencesToD1(env: Env, key: string, payload: PreferencesState): Promise<void> {
  await ensurePreferencesTable(env);
  const serialized = JSON.stringify(payload);
  try {
    await env.DB.prepare(
      `INSERT INTO user_preferences (sync_key, payload, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(sync_key) DO UPDATE SET
         payload = excluded.payload,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(key, serialized).run();
    return;
  } catch (upsertError) {
    console.warn('writePreferencesToD1 upsert failed, falling back to delete+insert', upsertError);
  }

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM user_preferences WHERE sync_key = ?`).bind(key),
    env.DB.prepare(
      `INSERT INTO user_preferences (sync_key, payload, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
    ).bind(key, serialized),
  ]);
}

async function loadPreferencesState(env: Env, key: string): Promise<PreferencesState | null> {
  try {
    const fromKv = await env.CACHE.get(`prefs:${key}`, { type: 'json' }) as PreferencesState | null;
    if (fromKv) return normalizePreferencesState(fromKv);
  } catch {
    // fall through to D1
  }
  return readPreferencesFromD1(env, key);
}

async function persistPreferencesState(env: Env, key: string, payload: PreferencesState): Promise<void> {
  let d1Error: unknown = null;
  try {
    await writePreferencesToD1(env, key, payload);
  } catch (error) {
    d1Error = error;
    console.error('persistPreferencesState D1 write failed', error);
  }

  try {
    await env.CACHE.put(`prefs:${key}`, JSON.stringify(payload), { expirationTtl: 31536000 });
  } catch (kvError) {
    if (d1Error) {
      console.error('persistPreferencesState KV write failed after D1 failure', kvError);
      throw d1Error;
    }
    console.warn('persistPreferencesState KV write failed; D1 write already succeeded', kvError);
  }

  if (d1Error) {
    try {
      const check = await readPreferencesFromD1(env, key);
      if (check) return;
    } catch {
      // ignored: preserve original failure
    }
    throw d1Error;
  }
}

async function handlePreferencesGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get('key')?.trim() ?? '';
  if (!isValidSyncKey(key)) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'Sync key is invalid', 400);
  }

  const stored = await loadPreferencesState(env, key);
  const normalized = normalizePreferencesState(stored);

  return jsonOk(request, env, {
    key,
    ...normalized,
    server_time: new Date().toISOString(),
  });
}

async function handlePreferencesPost(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<PreferencesPayload>(request);
  const key = body?.key?.trim() ?? '';
  if (!isValidSyncKey(key)) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'Sync key is invalid', 400);
  }

  const existing = await loadPreferencesState(env, key);
  const current = normalizePreferencesState(existing);
  const hasOwn = (field: keyof PreferencesPayload): boolean =>
    Boolean(body && Object.prototype.hasOwnProperty.call(body, field));
  const baseRevision = normalizePreferenceRevision(body?.base_revision);
  const clientUpdatedMs = parseIsoMs(body?.client_updated_at) || Date.now();
  const clientUpdatedAt = new Date(clientUpdatedMs).toISOString();
  const clientId = normalizeClientId(
    body?.client_id
      ?? request.headers.get('X-DyrakArmy-Client')
      ?? '',
  );
  const staleWrite = baseRevision < current.revision;

  const next: PreferencesState = {
    ...current,
    field_updated_at: { ...current.field_updated_at },
  };
  const appliedFields: PreferenceField[] = [];
  const rejectedFields: PreferenceField[] = [];
  let changed = false;

  const applyField = (field: PreferenceField, incomingRaw: string | undefined): void => {
    const fieldUpdatedAtMs = parseIsoMs(current.field_updated_at[field]);
    if (staleWrite && clientUpdatedMs < fieldUpdatedAtMs) {
      rejectedFields.push(field);
      return;
    }

    if (field === 'language') {
      const value = normalizeLanguage(incomingRaw);
      if (value !== next.language) {
        next.language = value;
        changed = true;
      }
    } else if (field === 'source') {
      const value = normalizePreferenceSource(incomingRaw);
      if (value !== next.source) {
        next.source = value;
        changed = true;
      }
    } else if (field === 'format') {
      const value = normalizeAudioFormat(incomingRaw, next.format);
      if (value !== next.format) {
        next.format = value;
        changed = true;
      }
    } else if (field === 'quality') {
      const value = normalizeAudioQuality(incomingRaw, next.format, next.quality);
      if (value !== next.quality) {
        next.quality = value;
        changed = true;
      }
    } else if (field === 'download_directory') {
      const value = normalizeDownloadDirectory(incomingRaw);
      if (value !== next.download_directory) {
        next.download_directory = value;
        changed = true;
      }
    } else if (field === 'telegram_link_mode') {
      const value = normalizeTelegramLinkMode(incomingRaw);
      if (value !== next.telegram_link_mode) {
        next.telegram_link_mode = value;
        changed = true;
      }
    }

    next.field_updated_at[field] = clientUpdatedAt;
    appliedFields.push(field);
  };

  for (const field of PREFERENCE_FIELDS) {
    if (!hasOwn(field as keyof PreferencesPayload)) continue;
    const incomingRaw = String((body as Record<string, unknown>)[field] ?? '');
    applyField(field, incomingRaw);
  }

  const normalizedQuality = normalizeAudioQuality(next.quality, next.format, next.quality);
  if (normalizedQuality !== next.quality) {
    next.quality = normalizedQuality;
    next.field_updated_at.quality = clientUpdatedAt;
    if (!appliedFields.includes('quality')) appliedFields.push('quality');
    changed = true;
  }

  if (changed) {
    next.updated_at = clientUpdatedAt;
    next.revision = Math.max(current.revision + 1, baseRevision + 1, 1);
    next.last_writer = clientId;
    try {
      await persistPreferencesState(env, key, next);
    } catch {
      return jsonError(request, env, 'PREFERENCES_UNAVAILABLE', 'Preference sync store is temporarily unavailable', 503, true);
    }
  } else {
    next.updated_at = current.updated_at;
    next.revision = Math.max(current.revision, 1);
  }

  return jsonOk(request, env, {
    ok: true,
    key,
    ...next,
    applied_fields: appliedFields,
    rejected_fields: rejectedFields,
    conflict: rejectedFields.length > 0,
    stale_write: staleWrite,
    server_time: new Date().toISOString(),
  });
}

async function handleFileDownload(request: Request, env: Env, token: string): Promise<Response> {
  const payload = await verifyDownloadToken(token, env.DOWNLOAD_TOKEN_SECRET);
  if (!payload) {
    return jsonError(request, env, 'INVALID_TOKEN', 'Download token is invalid or expired', 401);
  }
  const accessUrl = new URL(request.url);
  const inline = accessUrl.searchParams.get('inline') === '1';
  const rangeHeader = request.headers.get('range');

  const job = await env.DB.prepare(
    `SELECT title, artist, format, r2_key, result_url FROM download_jobs WHERE id = ?`,
  ).bind(payload.jobId).first<{
    title: string | null;
    artist: string | null;
    format: string | null;
    r2_key: string | null;
    result_url: string | null;
  }>();
  if (!job) {
    return jsonError(request, env, 'JOB_NOT_FOUND', 'Job not found', 404);
  }

  const fallbackExt = (job.format ?? 'bin').toLowerCase();
  const fallbackFilename = formatFileName(job.title ?? 'track', job.artist ?? 'dyrakarmy', fallbackExt);

  if (job.r2_key && env.FILES) {
    const head = await env.FILES.head(job.r2_key);
    if (!head) {
      return jsonError(request, env, 'FILE_NOT_FOUND', 'File not found', 404);
    }

    const byteRange = parseByteRangeHeader(rangeHeader, head.size);
    if (byteRange === 'invalid') {
      return new Response(null, {
        status: 416,
        headers: {
          'accept-ranges': 'bytes',
          'content-range': `bytes */${head.size}`,
        },
      });
    }

    const object = await env.FILES.get(
      job.r2_key,
      byteRange ? { range: { offset: byteRange.offset, length: byteRange.length } } : undefined,
    );
    if (!object || !object.body) {
      return jsonError(request, env, 'FILE_NOT_FOUND', 'File not found', 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('accept-ranges', 'bytes');
    headers.set('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${fallbackFilename}"`);
    if (byteRange) {
      headers.set('content-range', `bytes ${byteRange.offset}-${byteRange.end}/${byteRange.total}`);
      headers.set('content-length', String(byteRange.length));
    } else {
      headers.set('content-length', String(head.size));
    }

    return new Response(object.body, {
      status: byteRange ? 206 : 200,
      headers,
    });
  }

  if (!job.result_url) {
    return jsonError(request, env, 'FILE_UNAVAILABLE', 'File is not available', 404);
  }

  const normalizedResultUrl = normalizeDownloaderUrl(job.result_url, env);
  let upstream: Response;
  try {
    const parsed = new URL(normalizedResultUrl);
    if (parsed.pathname.startsWith('/internal/files/')) {
      const proxyHeaders: Record<string, string> = {
        'X-API-Key': env.DOWNLOADER_API_KEY,
      };
      if (rangeHeader) proxyHeaders.Range = rangeHeader;
      const failover = await fetchDownloaderWithFailover(
        env,
        `${parsed.pathname}${parsed.search}`,
        {
          method: 'GET',
          headers: proxyHeaders,
        },
      );
      upstream = failover.response;
      await recordTelemetry(env, {
        event: 'downloader_file_proxy',
        status: String(upstream.status),
        origin: failover.origin.baseUrl,
        code: failover.switched ? 'FAILOVER_SWITCHED' : 'PRIMARY_OK',
      });
    } else {
      const upstreamHeaders = buildDownloaderHeaders(normalizedResultUrl, env);
      const headers = new Headers(upstreamHeaders ?? undefined);
      if (rangeHeader) headers.set('Range', rangeHeader);
      upstream = await fetch(normalizedResultUrl, upstreamHeaders || rangeHeader ? { headers } : undefined);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error('File upstream request failed', reason);
    return jsonError(request, env, 'FILE_FETCH_FAILED', `Unable to fetch file: ${reason.slice(0, 180)}`, 502, true);
  }
  if (!upstream.ok || !upstream.body) {
    const details = await upstream.text();
    return jsonError(request, env, 'FILE_FETCH_FAILED', `Unable to fetch file: ${details}`, 502, true);
  }

  const headers = new Headers();
  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
  headers.set('content-type', contentType);
  headers.set('accept-ranges', upstream.headers.get('accept-ranges') ?? 'bytes');
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) {
    headers.set('content-length', contentLength);
  }
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) {
    headers.set('content-range', contentRange);
  }
  const extFromMime = mimeTypeToExtension(contentType);
  const filename = formatFileName(job.title ?? 'track', job.artist ?? 'dyrakarmy', extFromMime || fallbackExt);
  headers.set('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`);

  return new Response(upstream.body, {
    status: upstream.status === 206 ? 206 : 200,
    headers,
  });
}

async function getJobRecord(env: Env, jobId: string): Promise<JobRecord | null> {
  return env.DB.prepare(
    `SELECT id, url, source, format, quality, status, attempts,
            result_url, r2_key, title, artist, duration, file_size,
            fingerprint, content_hash, error_code, error_message, created_at, updated_at, finished_at
     FROM download_jobs
     WHERE id = ?`,
  ).bind(jobId).first<JobRecord>();
}

async function hydrateJobRecord(request: Request, env: Env, row: JobRecord): Promise<Record<string, unknown>> {
  let downloadUrl: string | null = null;
  let streamUrl: string | null = null;
  if (row.status === 'done' && (row.r2_key || row.result_url)) {
    const available = await isDownloadTargetAvailable(env, row);
    downloadUrl = available ? await buildDownloadUrl(request, env, row.id) : null;
    streamUrl = available ? await buildStreamUrl(request, env, row.id) : null;
  }

  return {
    ...row,
    download_url: downloadUrl,
    stream_url: streamUrl,
    download_available: Boolean(downloadUrl),
    stream_available: Boolean(streamUrl),
  };
}

async function buildDownloadUrl(request: Request, env: Env, jobId: string): Promise<string> {
  return buildFileAccessUrl(request, env, jobId, false);
}

async function buildStreamUrl(request: Request, env: Env, jobId: string): Promise<string> {
  return buildFileAccessUrl(request, env, jobId, true);
}

async function buildFileAccessUrl(
  request: Request,
  env: Env,
  jobId: string,
  inline: boolean,
): Promise<string> {
  const ttl = readEnvInt(env.DOWNLOAD_TOKEN_TTL_SECONDS, 3600);
  const token = await createDownloadToken(
    {
      jobId,
      exp: Math.floor(Date.now() / 1000) + ttl,
    },
    env.DOWNLOAD_TOKEN_SECRET,
  );

  const base = new URL(request.url);
  const suffix = inline ? '?inline=1' : '';
  return `${base.origin}/api/file/${encodeURIComponent(token)}${suffix}`;
}

type ParsedByteRange = {
  offset: number;
  end: number;
  length: number;
  total: number;
};

function parseByteRangeHeader(value: string | null, total: number): ParsedByteRange | 'invalid' | null {
  if (!value) return null;
  const normalized = value.trim();
  const match = normalized.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || !Number.isFinite(total) || total <= 0) return 'invalid';

  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  if (!startRaw && !endRaw) return 'invalid';

  let offset: number;
  let end: number;
  if (!startRaw) {
    const suffixLength = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'invalid';
    offset = Math.max(total - suffixLength, 0);
    end = total - 1;
  } else {
    offset = Number.parseInt(startRaw, 10);
    end = endRaw ? Number.parseInt(endRaw, 10) : total - 1;
    if (!Number.isFinite(offset) || !Number.isFinite(end)) return 'invalid';
    if (offset < 0 || offset >= total || end < offset) return 'invalid';
    end = Math.min(end, total - 1);
  }

  return {
    offset,
    end,
    length: end - offset + 1,
    total,
  };
}

async function isDownloadTargetAvailable(
  env: Env,
  row: { r2_key?: unknown; result_url?: unknown },
): Promise<boolean> {
  const r2Key = typeof row.r2_key === 'string' ? row.r2_key : '';
  if (r2Key) {
    return Boolean(env.FILES);
  }

  const resultUrlRaw = typeof row.result_url === 'string' ? row.result_url : '';
  if (!resultUrlRaw) return false;
  const normalized = normalizeDownloaderUrl(resultUrlRaw, env);

  try {
    const parsed = new URL(normalized);
    if (parsed.pathname.startsWith('/internal/files/')) {
      const states = await listOriginStates(env);
      if (!states.length) return false;
      return states.some((item) => {
        const circuit = String(item.state?.circuit ?? 'closed').toLowerCase();
        const cooldownUntil = Number(item.state?.cooldownUntil ?? 0);
        return circuit !== 'open' || cooldownUntil <= Date.now();
      });
    }

    const host = parsed.hostname.toLowerCase();
    if (host.endsWith('googlevideo.com')) {
      const expiresAt = Number(parsed.searchParams.get('expire') ?? '0');
      if (Number.isFinite(expiresAt) && expiresAt > 0) {
        const now = Math.floor(Date.now() / 1000);
        if (expiresAt <= now + 15) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function getInvidiousBaseUrl(env: Env): string {
  return (env.INVIDIOUS_BASE_URL ?? INVIDIOUS_DEFAULT_BASE_URL).replace(/\/+$/g, '');
}

function getInvidiousBaseUrls(env: Env): string[] {
  const configured = getInvidiousBaseUrl(env);
  const merged = [configured, ...INVIDIOUS_FALLBACK_BASE_URLS]
    .map((url) => url.replace(/\/+$/g, ''))
    .filter(Boolean);
  return [...new Set(merged)];
}

function pickThumbnail(entry: { videoThumbnails?: Array<{ quality?: string; url?: string }> }): string | undefined {
  const thumbnails = entry.videoThumbnails ?? [];
  if (!thumbnails.length) return undefined;
  const preferred = thumbnails.find((thumb) => thumb.quality?.toLowerCase().includes('medium'));
  return preferred?.url ?? thumbnails[0]?.url;
}

function toYouTubeVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function extractYouTubePlaylistId(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const list = parsed.searchParams.get('list');
    if (list) return list.trim();
    if (parsed.pathname.toLowerCase().includes('/playlist/')) {
      const fromPath = parsed.pathname.split('/').filter(Boolean).pop();
      if (fromPath) return fromPath.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function mimeTypeToExtension(mimeType: string): string {
  const value = String(mimeType || '').toLowerCase();
  if (value.includes('audio/webm')) return 'webm';
  if (value.includes('audio/mp4') || value.includes('audio/m4a')) return 'm4a';
  if (value.includes('audio/ogg')) return 'ogg';
  if (value.includes('audio/mpeg')) return 'mp3';
  if (value.includes('audio/flac')) return 'flac';
  if (value.includes('audio/wav') || value.includes('audio/x-wav')) return 'wav';
  return 'bin';
}

async function searchViaInvidious(query: string, limit: number, env: Env): Promise<DownloaderSearchResult[]> {
  for (const base of getInvidiousBaseUrls(env)) {
    try {
      const url = new URL(`${base}/api/v1/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('type', 'video');
      url.searchParams.set('sort', 'relevance');
      url.searchParams.set('page', '1');

      const response = await fetch(url.toString());
      if (!response.ok) {
        console.warn(`Invidious search failed with ${response.status} on ${base}`);
        continue;
      }

      const text = await response.text();
      let payload: Array<{
        type?: string;
        videoId?: string;
        title?: string;
        author?: string;
        lengthSeconds?: number;
        published?: number;
        videoThumbnails?: Array<{ quality?: string; url?: string }>;
      }>;

      try {
        payload = JSON.parse(text) as Array<{
          type?: string;
          videoId?: string;
          title?: string;
          author?: string;
          lengthSeconds?: number;
          published?: number;
          videoThumbnails?: Array<{ quality?: string; url?: string }>;
        }>;
      } catch {
        console.warn(`Invidious search returned non-JSON payload on ${base}`);
        continue;
      }

      const normalized = payload
        .filter((entry) => entry.type === 'video' && typeof entry.videoId === 'string' && entry.videoId.length > 0)
        .slice(0, limit)
        .map((entry) => ({
          id: entry.videoId!,
          title: entry.title ?? 'Unknown title',
          artist: entry.author ?? 'Unknown artist',
          duration: Number(entry.lengthSeconds ?? 0),
          thumbnail: pickThumbnail(entry),
          source: 'youtube',
          url: toYouTubeVideoUrl(entry.videoId!),
          year: entry.published ? new Date(entry.published * 1000).getUTCFullYear() : undefined,
        }));

      if (normalized.length > 0) {
        return normalized;
      }
    } catch (error) {
      console.error(`Invidious search fallback failed on ${base}`, error);
    }
  }

  return [];
}

async function fetchPlaylistResolve(
  env: Env,
  playlistUrl: string,
  source: string,
): Promise<PlaylistResolveResult> {
  try {
    const startedAt = Date.now();
    const failover = await fetchDownloaderWithFailover(env, '/internal/playlist/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.DOWNLOADER_API_KEY,
      },
      body: JSON.stringify({
        url: playlistUrl,
        source,
      }),
    });
    const response = failover.response;
    await recordTelemetry(env, {
      event: 'downloader_playlist_resolve',
      status: String(response.status),
      source,
      origin: failover.origin.baseUrl,
      latency_ms: Date.now() - startedAt,
      code: failover.switched ? 'FAILOVER_SWITCHED' : 'PRIMARY_OK',
    });
    if (!response.ok) {
      const details = await response.text();
      const fallback = await resolvePlaylistViaInvidious(playlistUrl, source, env);
      if (fallback) {
        await recordTelemetry(env, {
          event: 'playlist_resolve_fallback',
          status: '200',
          source,
          code: 'INVIDIOUS_PLAYLIST_FALLBACK',
        });
        return {
          payload: fallback,
          retryable: false,
        };
      }
      const code = details.toLowerCase().includes('spotify playlist extraction needs')
        ? 'SPOTIFY_PLAYLIST_AUTH_REQUIRED'
        : 'PLAYLIST_RESOLVE_FAILED';
      const retryable = response.status >= 500 && code !== 'SPOTIFY_PLAYLIST_AUTH_REQUIRED';
      console.warn(`Playlist resolve upstream failed (${response.status}): ${details.slice(0, 240)}`);
      return {
        payload: null,
        errorCode: code,
        errorMessage: details.slice(0, 240) || 'Playlist provider failed',
        retryable,
      };
    }
    const payload = await response.json<PlaylistResolveResponse>();
    if (!payload || !Array.isArray(payload.tracks)) {
      const fallback = await resolvePlaylistViaInvidious(playlistUrl, source, env);
      if (fallback) {
        await recordTelemetry(env, {
          event: 'playlist_resolve_fallback',
          status: '200',
          source,
          code: 'INVIDIOUS_PLAYLIST_FALLBACK',
        });
        return {
          payload: fallback,
          retryable: false,
        };
      }
      return {
        payload: null,
        errorCode: 'PLAYLIST_RESOLVE_INVALID_PAYLOAD',
        errorMessage: 'Playlist provider returned an invalid payload',
        retryable: true,
      };
    }
    return {
      payload,
      retryable: false,
    };
  } catch (error) {
    console.error('Playlist resolve request failed', error);
    const fallback = await resolvePlaylistViaInvidious(playlistUrl, source, env);
    if (fallback) {
      await recordTelemetry(env, {
        event: 'playlist_resolve_fallback',
        status: '200',
        source,
        code: 'INVIDIOUS_PLAYLIST_FALLBACK',
      });
      return {
        payload: fallback,
        retryable: false,
      };
    }
    return {
      payload: null,
      errorCode: 'PLAYLIST_RESOLVE_REQUEST_FAILED',
      errorMessage: 'Playlist provider is temporarily unreachable',
      retryable: true,
    };
  }
}

async function resolvePlaylistViaInvidious(
  playlistUrl: string,
  source: string,
  env: Env,
): Promise<PlaylistResolveResponse | null> {
  const playlistId = extractYouTubePlaylistId(playlistUrl);
  if (!playlistId) return null;
  if (source !== 'youtube' && source !== 'all' && source !== 'unknown') return null;

  for (const base of getInvidiousBaseUrls(env)) {
    try {
      const endpoint = `${base}/api/v1/playlists/${encodeURIComponent(playlistId)}`;
      const response = await fetch(endpoint);
      if (!response.ok) continue;
      const payload = await response.json() as {
        title?: string;
        playlistId?: string;
        videos?: Array<{
          title?: string;
          author?: string;
          videoId?: string;
        }>;
      };
      const videos = Array.isArray(payload.videos) ? payload.videos : [];
      const tracks = videos
        .filter((entry) => typeof entry.videoId === 'string' && entry.videoId.length > 0)
        .map((entry) => ({
          title: String(entry.title ?? 'Unknown title'),
          artist: String(entry.author ?? 'Unknown artist'),
          source: 'youtube',
          url: toYouTubeVideoUrl(String(entry.videoId)),
        }));
      if (!tracks.length) continue;
      return {
        title: String(payload.title ?? 'Playlist'),
        source: 'youtube',
        total: tracks.length,
        tracks,
      };
    } catch {
      // try next Invidious instance
    }
  }

  return null;
}

async function maybeStartDownloaderPlaylistWorkflow(
  env: Env,
  payload: DownloaderPlaylistWorkflowStartPayload,
): Promise<void> {
  try {
    const startedAt = Date.now();
    const failover = await fetchDownloaderWithFailover(env, '/internal/playlist/workflow/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.DOWNLOADER_API_KEY,
      },
      body: JSON.stringify({
        workflow_id: payload.workflowId,
        url: payload.playlistUrl,
        source: payload.source,
        format: payload.format,
        quality: payload.quality,
        batch_size: 50,
      }),
    });
    await recordTelemetry(env, {
      event: 'downloader_playlist_workflow_start',
      status: String(failover.response.status),
      source: payload.source,
      origin: failover.origin.baseUrl,
      latency_ms: Date.now() - startedAt,
      code: failover.switched ? 'FAILOVER_SWITCHED' : 'PRIMARY_OK',
    });
  } catch (error) {
    await recordTelemetry(env, {
      event: 'downloader_playlist_workflow_start',
      status: '0',
      source: payload.source,
      code: `FAILED:${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    });
  }
}

async function notifyDownloaderWorkflowControl(
  env: Env,
  workflowId: string,
  action: WorkflowControlAction,
): Promise<void> {
  try {
    const startedAt = Date.now();
    const failover = await fetchDownloaderWithFailover(env, `/internal/playlist/workflow/${encodeURIComponent(workflowId)}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.DOWNLOADER_API_KEY,
      },
    });
    await recordTelemetry(env, {
      event: 'downloader_playlist_workflow_control',
      status: String(failover.response.status),
      origin: failover.origin.baseUrl,
      latency_ms: Date.now() - startedAt,
      code: action,
    });
  } catch (error) {
    await recordTelemetry(env, {
      event: 'downloader_playlist_workflow_control',
      status: '0',
      code: `${action}:FAILED:${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    });
  }
}

function isPlaylistUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();

    if (host.endsWith('youtube.com') && url.searchParams.get('list')) {
      return true;
    }
    if (path.includes('playlist')) {
      return true;
    }
    if (path.includes('/sets/')) {
      return true;
    }
    if (host.includes('podcasts.apple.com')) {
      return true;
    }
    if (host.endsWith('spotify.com') && path.includes('/show/')) {
      return true;
    }
    if (path.endsWith('.xml') || path.endsWith('.rss') || path.endsWith('.atom') || path.includes('/feed') || path.includes('rss')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isValidSyncKey(value: string): boolean {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(value);
}

function normalizeLanguage(raw: string | undefined): 'en' | 'bg' | 'es' | 'ru' | 'de' {
  const normalized = (raw ?? 'en').trim().toLowerCase();
  if (SUPPORTED_LANGUAGES.has(normalized)) {
    return normalized as 'en' | 'bg' | 'es' | 'ru' | 'de';
  }
  return 'en';
}

function normalizeAudioFormat(raw: string | undefined, fallback: AudioFormat = 'mp3'): AudioFormat {
  const candidate = String(raw ?? '').trim().toLowerCase();
  return AUDIO_FORMATS.includes(candidate as AudioFormat) ? (candidate as AudioFormat) : fallback;
}

function normalizeAudioQuality(
  raw: string | undefined,
  format: AudioFormat,
  fallback: AudioQuality = '320',
): AudioQuality {
  const candidate = String(raw ?? '').trim().toLowerCase();
  if (format === 'flac' || format === 'wav') {
    if (candidate === 'lossless' || candidate === 'best') return candidate as AudioQuality;
    if (fallback === 'lossless' || fallback === 'best') return fallback;
    return 'lossless';
  }
  return AUDIO_QUALITIES.includes(candidate as AudioQuality) ? (candidate as AudioQuality) : fallback;
}

function normalizePreferenceSource(raw: string | undefined): string {
  const source = normalizeSource(raw);
  if (source === 'unknown') return 'all';
  return source || 'all';
}

function normalizeDownloadDirectory(raw: string | undefined): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  return value.slice(0, 240);
}

function normalizeTelegramLinkMode(raw: string | undefined): 'bot' | 'download' {
  return String(raw ?? '').trim().toLowerCase() === 'download' ? 'download' : 'bot';
}

function parseIsoMs(raw: string | undefined): number {
  const parsed = Date.parse(String(raw ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoFromMs(value: number, fallback: string): string {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return new Date(value).toISOString();
}

function normalizePreferenceRevision(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function normalizeClientId(raw: string | undefined): string {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return 'unknown';
  return value.replace(/[^a-z0-9_-]/g, '').slice(0, 64) || 'unknown';
}

function normalizePreferencesState(raw: PreferencesState | null | undefined): PreferencesState {
  const fallbackIso = new Date(0).toISOString();
  const updatedAtMs = parseIsoMs(raw?.updated_at);
  const updatedAt = isoFromMs(updatedAtMs, fallbackIso);
  const format = normalizeAudioFormat(raw?.format, 'mp3');
  const baseFieldTimes = raw?.field_updated_at ?? {
    language: updatedAt,
    source: updatedAt,
    format: updatedAt,
    quality: updatedAt,
    download_directory: updatedAt,
    telegram_link_mode: updatedAt,
  };

  return {
    language: normalizeLanguage(raw?.language),
    source: normalizePreferenceSource(raw?.source),
    format,
    quality: normalizeAudioQuality(raw?.quality, format, '320'),
    download_directory: normalizeDownloadDirectory(raw?.download_directory),
    telegram_link_mode: normalizeTelegramLinkMode(raw?.telegram_link_mode),
    revision: Math.max(0, normalizePreferenceRevision(raw?.revision)),
    field_updated_at: {
      language: isoFromMs(parseIsoMs(baseFieldTimes.language), updatedAt),
      source: isoFromMs(parseIsoMs(baseFieldTimes.source), updatedAt),
      format: isoFromMs(parseIsoMs(baseFieldTimes.format), updatedAt),
      quality: isoFromMs(parseIsoMs(baseFieldTimes.quality), updatedAt),
      download_directory: isoFromMs(parseIsoMs(baseFieldTimes.download_directory), updatedAt),
      telegram_link_mode: isoFromMs(parseIsoMs(baseFieldTimes.telegram_link_mode), updatedAt),
    },
    last_writer: normalizeClientId(raw?.last_writer),
    updated_at: updatedAt,
  };
}
