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
import { ensureDownloadJobMetadataSchema, ensurePlaylistWorkflowSchema, ensureSyncKeyClaimsSchema } from './schema';
import {
  hashAndCachePrivateUrl,
  resolvePrivateUrl,
  safeUrlHash,
  verifyExternalHmacRequest,
} from './security';
import {
  corsHeaders,
  createDownloadToken,
  createJobFingerprint,
  detectSourceFromUrl,
  formatPlaylistRelPath,
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
  sha256Hex,
  sha256HexBytes,
  verifyDownloadToken,
  validateDownloadUrlPolicy,
  validateUrlPolicy,
} from './utils';
import {
  backfillTelegramChannelPublishes,
  getTelegramChannelPublishStatus,
} from './telegram';
import {
  handleReleaseRadarDelete,
  handleReleaseRadarGet,
  handleReleaseRadarPost,
} from './releaseRadar';

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

interface SharePreviewRequestBody {
  job_id?: string;
}

interface DownloadRequestBody {
  url: string;
  source?: string;
  format?: AudioFormat;
  quality?: AudioQuality;
  sync_key?: string;
  client_id?: string;
}

interface OpsTelegramChannelBackfillRequestBody {
  limit?: number;
}

interface SyncClaimRequestBody {
  key?: string;
  email?: string;
  turnstile_token?: string;
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
  mobileVariantJobId?: string;
  mobileVariantStatus?: JobStatus;
  mobileVariantDeduped?: boolean;
}

interface PlaylistRequestBody {
  url: string;
  source?: string;
  format?: AudioFormat;
  quality?: AudioQuality;
  sync_key?: string;
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

interface ArtistDiscographyRequestBody {
  artist?: string;
  source?: string;
  format?: AudioFormat;
  quality?: AudioQuality;
  sync_key?: string;
  limit?: number;
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
  privacy_mode?: boolean;
  base_revision?: number;
  client_updated_at?: string;
  client_id?: string;
}

interface HistoryImportBody {
  key?: string;
  items?: Array<Record<string, unknown>>;
}

interface HistoryRequeueBody {
  job_id?: string;
  format?: AudioFormat;
  quality?: AudioQuality;
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
  parent_job_id: string | null;
  variant_role: string | null;
  sync_key: string | null;
  playlist_folder: string | null;
  playlist_index: number | null;
  local_relpath: string | null;
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
  archive_r2_key?: string | null;
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
  privacy_mode: boolean;
  revision: number;
  field_updated_at: {
    language: string;
    source: string;
    format: string;
    quality: string;
    download_directory: string;
    telegram_link_mode: string;
    privacy_mode: string;
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
  | 'telegram_link_mode'
  | 'privacy_mode';

type OpsRole = 'none' | 'viewer' | 'operator' | 'admin';

interface OpsAuthContext {
  role: OpsRole;
  tokenId: string;
}

interface ReleaseArtifactEntry {
  id:
    | 'desktop_windows'
    | 'desktop_macos'
    | 'desktop_linux_x64'
    | 'desktop_linux_arm64'
    | 'mobile_ios'
    | 'mobile_android'
    | 'extension_chrome'
    | 'extension_firefox';
  filename: string;
  path: string;
  url: string;
  sha256: string;
  bytes: number;
  version: string;
  minimum_supported: string;
  platform: 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'extension';
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
  'privacy_mode',
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
    id: 'desktop_linux_x64',
    filename: 'DyrakArmyDesktop-linux-x64.zip',
    path: '/downloads/DyrakArmyDesktop-linux-x64.zip',
    platform: 'linux',
  },
  {
    id: 'desktop_linux_arm64',
    filename: 'DyrakArmyDesktop-linux-arm64.zip',
    path: '/downloads/DyrakArmyDesktop-linux-arm64.zip',
    platform: 'linux',
  },
  {
    id: 'mobile_ios',
    filename: 'DyrakArmy-Mobile-iOS-Expo.zip',
    path: '/downloads/DyrakArmy-Mobile-iOS-Expo.zip',
    platform: 'ios',
  },
  {
    id: 'mobile_android',
    filename: 'DyrakArmy-Mobile-Android-Expo.zip',
    path: '/downloads/DyrakArmy-Mobile-Android-Expo.zip',
    platform: 'android',
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

  if (path === '/webhooks/external/ping' && request.method === 'POST') {
    return handleSignedWebhookPing(request, env);
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

  if (path === '/ops/telegram-channel' && request.method === 'GET') {
    return handleOpsTelegramChannelStatus(request, env);
  }

  if (path === '/ops/telegram-channel/backfill' && request.method === 'POST') {
    return handleOpsTelegramChannelBackfill(request, env);
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

  if (path === '/sync/claim' && request.method === 'POST') {
    return handleSyncClaim(request, env);
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

  if (path === '/share/preview' && request.method === 'POST') {
    return handleSharePreview(request, env);
  }

  const shareCardMatch = path.match(/^\/share\/card\/([^/]+)\.svg$/i);
  if (shareCardMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    return handleShareCard(request, env, decodeURIComponent(shareCardMatch[1]!));
  }

  const sharePageMatch = path.match(/^\/share\/([^/]+)$/i);
  if (sharePageMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    return handleSharePage(request, env, decodeURIComponent(sharePageMatch[1]!));
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

  if (path === '/artist/discography/queue' && request.method === 'POST') {
    return handleArtistDiscographyQueue(request, env);
  }

  if (path === '/release-radar' && request.method === 'GET') {
    return handleReleaseRadarGet(request, env);
  }

  if (path === '/release-radar' && request.method === 'POST') {
    return handleReleaseRadarPost(request, env);
  }

  if (path === '/release-radar' && request.method === 'DELETE') {
    return handleReleaseRadarDelete(request, env);
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

  const playlistWorkflowArchiveMatch = path.match(/^\/playlist\/workflow\/([0-9a-f-]{36})\/archive$/i);
  if (playlistWorkflowArchiveMatch && request.method === 'GET') {
    return handlePlaylistWorkflowArchiveDownload(request, env, playlistWorkflowArchiveMatch[1]!);
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

  if (path === '/history/export' && request.method === 'GET') {
    return handleHistoryExport(request, env);
  }

  if (path === '/history/import' && request.method === 'POST') {
    return handleHistoryImport(request, env);
  }

  if (path === '/history/requeue' && request.method === 'POST') {
    return handleHistoryRequeue(request, env);
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

  if (path === '/archive/pack' && request.method === 'POST') {
    return handleArchivePack(request, env);
  }

  const archiveFileMatch = path.match(/^\/archive\/file\/([a-f0-9]{64})$/i);
  if (archiveFileMatch && request.method === 'GET') {
    return handleArchiveFile(request, env, archiveFileMatch[1]!);
  }

  const archivePackedFileMatch = path.match(/^\/archive\/packed\/([^/]+)$/i);
  if (archivePackedFileMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    return handleArchivePackedFile(request, env, decodeURIComponent(archivePackedFileMatch[1]!));
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

async function handleSharePreview(request: Request, env: Env): Promise<Response> {
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `share-preview:${ip}`, 20, 60);
  if (rl.limited) {
    return jsonError(request, env, 'RATE_LIMITED', 'Too many share preview requests', 429, true);
  }

  const body = await parseJson<SharePreviewRequestBody>(request);
  const jobId = String(body?.job_id ?? '').trim();
  if (!isUuid(jobId)) {
    return jsonError(request, env, 'INVALID_JOB_ID', 'A valid job_id is required', 400);
  }

  const row = await getShareJobRecord(env, jobId);
  if (!row) {
    return jsonError(request, env, 'JOB_NOT_FOUND', 'Job was not found', 404);
  }

  const ttl = readEnvInt(env.SHARE_TOKEN_TTL_SECONDS, 7 * 24 * 60 * 60);
  const token = await createShareToken(jobId, Math.floor(Date.now() / 1000) + ttl, env.DOWNLOAD_TOKEN_SECRET);
  const base = resolvePublicBaseUrl(request, env);
  const shareUrl = `${base}/share/${encodeURIComponent(token)}`;
  const cardImageUrl = `${base}/api/share/card/${encodeURIComponent(token)}.svg`;

  return jsonOk(request, env, {
    share_url: shareUrl,
    card_image_url: cardImageUrl,
    title: shareTitle(row),
    description: shareDescription(row),
    expires_in_seconds: ttl,
  });
}

async function handleSharePage(request: Request, env: Env, token: string): Promise<Response> {
  const payload = await verifyShareToken(token, env.DOWNLOAD_TOKEN_SECRET);
  if (!payload?.shareJobId) {
    return htmlResponse('<!doctype html><title>DyrakArmy Share</title><p>Invalid or expired share link.</p>', 404);
  }
  const row = await getShareJobRecord(env, payload.shareJobId);
  if (!row) {
    return htmlResponse('<!doctype html><title>DyrakArmy Share</title><p>Shared track was not found.</p>', 404);
  }

  const base = resolvePublicBaseUrl(request, env);
  const title = shareTitle(row);
  const description = shareDescription(row);
  const cardImageUrl = `${base}/api/share/card/${encodeURIComponent(token)}.svg`;
  const appUrl = `${base}/?tab=history`;
  const hasDownloadTarget = row.status === 'done' && Boolean(row.r2_key || row.result_url);
  const downloadAvailable = hasDownloadTarget ? await isDownloadTargetAvailable(env, row) : false;
  const downloadUrl = downloadAvailable ? await buildDownloadUrl(request, env, row.id) : null;

  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtmlText(title)}</title>
  <meta name="description" content="${escapeHtmlText(description)}">
  <meta property="og:type" content="music.song">
  <meta property="og:site_name" content="DyrakArmy">
  <meta property="og:title" content="${escapeHtmlText(title)}">
  <meta property="og:description" content="${escapeHtmlText(description)}">
  <meta property="og:image" content="${escapeHtmlText(cardImageUrl)}">
  <meta property="og:url" content="${escapeHtmlText(new URL(request.url).toString())}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtmlText(title)}">
  <meta name="twitter:description" content="${escapeHtmlText(description)}">
  <meta name="twitter:image" content="${escapeHtmlText(cardImageUrl)}">
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#02040c;color:#d9e8ff;font-family:Arial,sans-serif}
    main{width:min(720px,calc(100% - 32px));padding:34px;border:1px solid rgba(0,247,168,.35);border-radius:24px;background:linear-gradient(145deg,rgba(7,15,34,.96),rgba(21,6,37,.94));box-shadow:0 24px 60px rgba(0,0,0,.45)}
    img{width:100%;border-radius:18px;border:1px solid rgba(255,255,255,.12)}
    a{display:inline-block;margin:18px 10px 0 0;padding:12px 16px;border-radius:999px;background:#00f7a8;color:#03150f;text-decoration:none;font-weight:700}
    a.secondary{background:transparent;color:#93c7ff;border:1px solid rgba(147,199,255,.45)}
  </style>
</head>
<body>
  <main>
    <img src="${escapeHtmlText(cardImageUrl)}" alt="${escapeHtmlText(title)} preview card">
    <h1>${escapeHtmlText(title)}</h1>
    <p>${escapeHtmlText(description)}</p>
    <a href="${escapeHtmlText(appUrl)}">Open DyrakArmy</a>
    ${downloadUrl ? `<a class="secondary" href="${escapeHtmlText(downloadUrl)}">Download file</a>` : ''}
  </main>
</body>
</html>`);
}

async function handleShareCard(request: Request, env: Env, token: string): Promise<Response> {
  const payload = await verifyShareToken(token, env.DOWNLOAD_TOKEN_SECRET);
  if (!payload?.shareJobId) {
    return new Response('Invalid share token', { status: 404 });
  }
  const row = await getShareJobRecord(env, payload.shareJobId);
  if (!row) {
    return new Response('Shared track was not found', { status: 404 });
  }

  const title = truncateForCard(shareTitle(row), 62);
  const description = truncateForCard(shareDescription(row), 92);
  const status = `${String(row.format || '').toUpperCase()} ${row.quality || ''} / ${row.status}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#02040c"/>
      <stop offset="48%" stop-color="#150625"/>
      <stop offset="100%" stop-color="#042b32"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" x2="1">
      <stop offset="0%" stop-color="#00f7a8"/>
      <stop offset="100%" stop-color="#00d0ff"/>
    </linearGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="16" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="110" cy="90" r="170" fill="#00f7a8" opacity=".18" filter="url(#glow)"/>
  <circle cx="1110" cy="520" r="220" fill="#00d0ff" opacity=".18" filter="url(#glow)"/>
  <rect x="72" y="70" width="1056" height="490" rx="36" fill="rgba(7,15,34,.78)" stroke="rgba(133,171,255,.28)"/>
  <text x="110" y="145" fill="#00f7a8" font-family="Arial, sans-serif" font-size="38" font-weight="700">DyrakArmy</text>
  <text x="110" y="260" fill="#d9e8ff" font-family="Arial, sans-serif" font-size="58" font-weight="800">${escapeSvgText(title)}</text>
  <text x="112" y="330" fill="#93a9d2" font-family="Arial, sans-serif" font-size="30">${escapeSvgText(description)}</text>
  <rect x="110" y="405" width="390" height="66" rx="33" fill="url(#accent)"/>
  <text x="145" y="449" fill="#03150f" font-family="Arial, sans-serif" font-size="28" font-weight="700">${escapeSvgText(status)}</text>
  <text x="110" y="520" fill="#7e94c0" font-family="Arial, sans-serif" font-size="25">Listen, download and sync through dyrakarmy.online</text>
</svg>`;

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
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
  const policy = validateDownloadUrlPolicy(url, env);
  if (!policy.allowed) {
    return jsonError(request, env, policy.code ?? 'URL_BLOCKED', policy.message ?? 'URL is blocked', 400);
  }

  const syncKey = normalizeOptionalSyncKey(body.sync_key);
  if (body.sync_key && !syncKey) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'Sync key is invalid', 400);
  }

  const queued = await queueDownloadJob(env, {
    url,
    source: body.source,
    format: body.format,
    quality: body.quality,
    syncKey,
  });

  return jsonOk(request, env, {
    jobId: queued.jobId,
    status: queued.status,
    deduped: queued.deduped,
    mobile_variant_job_id: queued.mobileVariantJobId ?? null,
    mobile_variant_status: queued.mobileVariantStatus ?? null,
    mobile_variant_deduped: queued.mobileVariantDeduped ?? false,
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

async function handleSignedWebhookPing(request: Request, env: Env): Promise<Response> {
  const bodyText = await request.text();
  const verification = await verifyExternalHmacRequest(request, bodyText, env);
  if (!verification.ok) {
    return jsonError(request, env, verification.code, verification.message, 401);
  }

  await recordTelemetry(env, {
    event: 'external_webhook_verified',
    status: '200',
    code: 'HMAC_OK',
  });

  return jsonOk(request, env, {
    ok: true,
    verified: true,
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
  const policy = validateDownloadUrlPolicy(url, env);
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
    syncKey: key,
  });

  await ensureSharedQueueTable(env);
  const itemId = crypto.randomUUID();
  const sharedUrlHash = await hashAndCachePrivateUrl(env, 'shared', itemId, url);
  const title = String(body?.title ?? '').trim() || null;
  const artist = String(body?.artist ?? '').trim() || null;
  const addedBy = String(body?.added_by ?? '').trim().slice(0, 80) || null;
  await env.DB.prepare(
    `INSERT INTO shared_queue_items (
      id, sync_key, job_id, url, source, format, quality, title, artist, added_by, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(itemId, key, queued.jobId, sharedUrlHash, queued.source, queued.format, queued.quality, title, artist, addedBy, queued.status).run();

  if (queued.mobileVariantJobId) {
    const mobileItemId = crypto.randomUUID();
    const mobileUrlHash = await hashAndCachePrivateUrl(env, 'shared', mobileItemId, url);
    await env.DB.prepare(
      `INSERT INTO shared_queue_items (
        id, sync_key, job_id, url, source, format, quality, title, artist, added_by, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'mp3', '128', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(
      mobileItemId,
      key,
      queued.mobileVariantJobId,
      mobileUrlHash,
      queued.source,
      title ? `${title} (mobile 128)` : 'Mobile MP3 128',
      artist,
      addedBy,
      queued.mobileVariantStatus ?? 'queued',
    ).run();
  }

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
      url: null,
      url_hash: sharedUrlHash,
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
    mobile_variant_job_id: queued.mobileVariantJobId ?? null,
    mobile_variant_status: queued.mobileVariantStatus ?? null,
    mobile_variant_deduped: queued.mobileVariantDeduped ?? false,
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
       j.status AS job_status, j.error_code, j.error_message, j.result_url, j.r2_key, j.file_size, j.finished_at,
       j.parent_job_id, j.variant_role, j.playlist_folder, j.playlist_index, j.local_relpath
     FROM shared_queue_items s
     LEFT JOIN download_jobs j ON j.id = s.job_id
     WHERE s.sync_key = ?
     ORDER BY s.created_at DESC
     LIMIT ?`,
  ).bind(key, limit).all<Record<string, unknown>>();

  const items = await Promise.all((rows.results ?? []).map(async (row) => {
    const status = String(row.job_status ?? row.shared_status ?? 'queued');
    const urlHash = await safeUrlHash(String(row.url ?? ''));
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
      url: null,
      url_hash: urlHash,
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
      parent_job_id: row.parent_job_id,
      variant_role: row.variant_role,
      playlist_folder: row.playlist_folder,
      playlist_index: row.playlist_index,
      local_relpath: row.local_relpath,
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
    syncKey?: string | null;
    parentJobId?: string | null;
    variantRole?: 'primary' | 'mobile';
    playlistFolder?: string | null;
    playlistIndex?: number | null;
    localRelpath?: string | null;
  },
): Promise<QueuedDownloadResult> {
  await ensureDownloadJobMetadataSchema(env);
  const url = input.url.trim();
  const format = normalizeAudioFormat(input.format, 'mp3');
  const quality = normalizeAudioQuality(input.quality, format, format === 'flac' || format === 'wav' ? 'lossless' : '320');
  const source = normalizeSource(input.source ?? detectSourceFromUrl(url));
  const fingerprint = await createJobFingerprint(url, format, quality);
  const dedupeKey = `dedupe:${fingerprint}`;
  const syncKey = normalizeOptionalSyncKey(input.syncKey ?? undefined);
  const variantRole = input.variantRole ?? 'primary';
  const parentJobId = input.parentJobId ?? null;
  const playlistFolder = input.playlistFolder ?? null;
  const playlistIndex = Number.isFinite(input.playlistIndex ?? NaN) ? Number(input.playlistIndex) : null;
  const localRelpath = input.localRelpath ?? null;

  const dedupeTtl = readEnvInt(env.DOWNLOAD_DEDUPE_TTL_SECONDS, 120);
  const existing = await getExistingJobByFingerprint(env, fingerprint, dedupeTtl);
  if (existing) {
    if (isValidUrl(url)) {
      await hashAndCachePrivateUrl(env, 'job', existing.id, url);
    }
    await env.DB.prepare(
      `UPDATE download_jobs
       SET sync_key = COALESCE(sync_key, ?),
           playlist_folder = COALESCE(playlist_folder, ?),
           playlist_index = COALESCE(playlist_index, ?),
           local_relpath = COALESCE(local_relpath, ?),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).bind(syncKey, playlistFolder, playlistIndex, localRelpath, existing.id).run();
    const mobileVariant = await maybeQueueMobileVariant(env, {
      sourceUrl: url,
      source,
      parentJobId: existing.id,
      syncKey,
      title: input.title,
      artist: input.artist,
      playlistFolder,
      playlistIndex,
      localRelpath,
      requestedFormat: format,
      variantRole,
    });
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
    return {
      jobId: existing.id,
      status: existing.status,
      deduped: true,
      source,
      format,
      quality,
      mobileVariantJobId: mobileVariant?.jobId,
      mobileVariantStatus: mobileVariant?.status,
      mobileVariantDeduped: mobileVariant?.deduped,
    };
  }

  const jobId = crypto.randomUUID();
  const urlHash = isValidUrl(url)
    ? await hashAndCachePrivateUrl(env, 'job', jobId, url)
    : await sha256Hex(url);

  await env.DB.prepare(
    `INSERT INTO download_jobs (
      id, url, source, format, quality, status, attempts, fingerprint,
      parent_job_id, variant_role, sync_key, playlist_folder, playlist_index, local_relpath,
      title, artist, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(
    jobId,
    urlHash,
    source,
    format,
    quality,
    fingerprint,
    parentJobId,
    variantRole,
    syncKey,
    playlistFolder,
    playlistIndex,
    localRelpath,
    input.title ?? null,
    input.artist ?? null,
  ).run();

  await env.DOWNLOAD_QUEUE.send({
    id: jobId,
    url,
    source,
    format,
    quality,
    fingerprint,
    parentJobId: parentJobId ?? undefined,
    variantRole,
    syncKey: syncKey ?? undefined,
    playlistFolder: playlistFolder ?? undefined,
    playlistIndex: playlistIndex ?? undefined,
    localRelpath: localRelpath ?? undefined,
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

  const mobileVariant = await maybeQueueMobileVariant(env, {
    sourceUrl: url,
    source,
    parentJobId: jobId,
    syncKey,
    title: input.title,
    artist: input.artist,
    playlistFolder,
    playlistIndex,
    localRelpath,
    requestedFormat: format,
    variantRole,
  });

  return {
    jobId,
    status: 'queued',
    deduped: false,
    source,
    format,
    quality,
    mobileVariantJobId: mobileVariant?.jobId,
    mobileVariantStatus: mobileVariant?.status,
    mobileVariantDeduped: mobileVariant?.deduped,
  };
}

async function maybeQueueMobileVariant(
  env: Env,
  input: {
    sourceUrl: string;
    source: string;
    parentJobId: string;
    syncKey: string | null;
    title?: string;
    artist?: string;
    playlistFolder?: string | null;
    playlistIndex?: number | null;
    localRelpath?: string | null;
    requestedFormat: AudioFormat;
    variantRole: 'primary' | 'mobile';
  },
): Promise<QueuedDownloadResult | null> {
  if (env.AUTO_MOBILE_VARIANT_ENABLED === '0') return null;
  if (input.variantRole === 'mobile') return null;
  if (input.requestedFormat !== 'flac') return null;
  if (!input.syncKey) return null;

  const mobileFormat = normalizeAudioFormat(env.MOBILE_VARIANT_FORMAT, 'mp3');
  const mobileQuality = normalizeAudioQuality(env.MOBILE_VARIANT_QUALITY, mobileFormat, '128');
  if (mobileFormat !== 'mp3' || mobileQuality !== '128') {
    // Keep mobile sync deterministic and store-efficient unless explicitly changed in code.
    return null;
  }

  const existingChild = await env.DB.prepare(
    `SELECT id, status FROM download_jobs
     WHERE parent_job_id = ? AND variant_role = 'mobile' AND format = 'mp3' AND quality = '128'
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(input.parentJobId).first<ExistingFingerprintJob>();
  if (existingChild) {
    await env.DB.prepare(
      `UPDATE download_jobs
       SET sync_key = COALESCE(sync_key, ?),
           playlist_folder = COALESCE(playlist_folder, ?),
           playlist_index = COALESCE(playlist_index, ?),
           local_relpath = COALESCE(local_relpath, ?),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).bind(input.syncKey, input.playlistFolder ?? null, input.playlistIndex ?? null, input.localRelpath ?? null, existingChild.id).run();
    return {
      jobId: existingChild.id,
      status: existingChild.status,
      deduped: true,
      source: input.source,
      format: 'mp3',
      quality: '128',
    };
  }

  const queued = await queueDownloadJob(env, {
    url: input.sourceUrl,
    source: input.source,
    format: 'mp3',
    quality: '128',
    title: input.title ? `${input.title} (mobile 128)` : 'Mobile MP3 128',
    artist: input.artist,
    syncKey: input.syncKey,
    parentJobId: input.parentJobId,
    variantRole: 'mobile',
    playlistFolder: input.playlistFolder,
    playlistIndex: input.playlistIndex,
    localRelpath: input.localRelpath,
  });

  await recordTelemetry(env, {
    event: 'mobile_variant_queued',
    status: '202',
    source: input.source,
    code: queued.deduped ? 'DEDUPED' : 'QUEUED',
  });

  return queued;
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
  const policy = validateDownloadUrlPolicy(playlistUrl, env);
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
  await ensureDownloadJobMetadataSchema(env);
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
  const policy = validateDownloadUrlPolicy(playlistUrl, env);
  if (!policy.allowed) {
    return jsonError(request, env, policy.code ?? 'URL_BLOCKED', policy.message ?? 'URL is blocked', 400);
  }
  if (!isPlaylistUrl(playlistUrl)) {
    return jsonError(request, env, 'INVALID_PLAYLIST_URL', 'URL is not recognized as a playlist', 400);
  }

  const format = AUDIO_FORMATS.includes(body.format ?? 'mp3') ? (body.format ?? 'mp3') : 'mp3';
  const quality = AUDIO_QUALITIES.includes(body.quality ?? '320') ? (body.quality ?? '320') : '320';
  const source = normalizeSource(body.source ?? detectSourceFromUrl(playlistUrl));
  const syncKey = normalizeOptionalSyncKey(body.sync_key);
  if (body.sync_key && !syncKey) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'Sync key is invalid', 400);
  }

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
  const playlistUrlHash = await hashAndCachePrivateUrl(env, 'workflow', workflowId, playlistUrl);
  const playlistTitle = resolved.payload.title ?? 'Playlist';
  const playlistFolder = formatPlaylistRelPath(playlistTitle, 1, 'Track', 'Artist', format, queueTracks.length).folder;

  await env.DB.prepare(
    `INSERT INTO playlist_workflows (
      workflow_id, source_url, source, status, phase, total_tracks,
      queued_count, processing_count, done_count, failed_count, deduped_count,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'processing', 'resolving', 0, 0, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(workflowId, playlistUrlHash, source).run();
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
    } else if (!validateDownloadUrlPolicy(trackUrl, env).allowed) {
      failed += 1;
    } else {
      const trackSource = normalizeSource(track.source || detectSourceFromUrl(trackUrl) || source);
      const fingerprint = await createJobFingerprint(trackUrl, format, quality);
      const dedupeKey = `dedupe:${fingerprint}`;
      const title = String(track.title ?? '').trim() || 'Unknown Title';
      const artist = String(track.artist ?? '').trim() || 'Unknown Artist';
      const pathInfo = formatPlaylistRelPath(playlistFolder, index + 1, title, artist, format, queueTracks.length);
      const existing = await getExistingJobByFingerprint(env, fingerprint, dedupeTtl);
      if (existing) {
        await hashAndCachePrivateUrl(env, 'job', existing.id, trackUrl);
        await env.DB.prepare(
          `UPDATE download_jobs
           SET sync_key = COALESCE(sync_key, ?),
               playlist_folder = COALESCE(playlist_folder, ?),
               playlist_index = COALESCE(playlist_index, ?),
               local_relpath = COALESCE(local_relpath, ?),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        ).bind(syncKey, pathInfo.folder, index + 1, pathInfo.relpath, existing.id).run();
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
        const mobilePathInfo = formatPlaylistRelPath(playlistFolder, index + 1, title, artist, 'mp3', queueTracks.length);
        await maybeQueueMobileVariant(env, {
          sourceUrl: trackUrl,
          source: trackSource,
          parentJobId: existing.id,
          syncKey,
          title,
          artist,
          playlistFolder: mobilePathInfo.folder,
          playlistIndex: index + 1,
          localRelpath: mobilePathInfo.relpath,
          requestedFormat: format,
          variantRole: 'primary',
        });
        queuedJobIds.push(existing.id);
      } else {
        const jobId = crypto.randomUUID();
        const trackUrlHash = await hashAndCachePrivateUrl(env, 'job', jobId, trackUrl);

        await env.DB.prepare(
          `INSERT INTO download_jobs (
            id, url, source, format, quality, status, attempts, fingerprint,
            parent_job_id, variant_role, sync_key, playlist_folder, playlist_index, local_relpath,
            title, artist, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, NULL, 'primary', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        ).bind(
          jobId,
          trackUrlHash,
          trackSource,
          format,
          quality,
          fingerprint,
          syncKey,
          pathInfo.folder,
          index + 1,
          pathInfo.relpath,
          title,
          artist,
        ).run();

        pendingQueueBatch.push({
          body: {
          id: jobId,
          url: trackUrl,
          source: trackSource,
          format,
          quality,
          fingerprint,
          syncKey: syncKey ?? undefined,
          variantRole: 'primary',
          playlistFolder: pathInfo.folder,
          playlistIndex: index + 1,
          localRelpath: pathInfo.relpath,
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
        const mobilePathInfo = formatPlaylistRelPath(playlistFolder, index + 1, title, artist, 'mp3', queueTracks.length);
        await maybeQueueMobileVariant(env, {
          sourceUrl: trackUrl,
          source: trackSource,
          parentJobId: jobId,
          syncKey,
          title,
          artist,
          playlistFolder: mobilePathInfo.folder,
          playlistIndex: index + 1,
          localRelpath: mobilePathInfo.relpath,
          requestedFormat: format,
          variantRole: 'primary',
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

async function handleArtistDiscographyQueue(request: Request, env: Env): Promise<Response> {
  await ensurePlaylistWorkflowSchema(env);
  await ensureDownloadJobMetadataSchema(env);
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `artist-discography:${ip}`, 3, 60);
  if (rl.limited) {
    return jsonError(request, env, 'RATE_LIMITED', 'Too many artist discography requests', 429, true);
  }

  const body = await parseJson<ArtistDiscographyRequestBody>(request);
  const artist = normalizeArtistQuery(body?.artist);
  if (!artist) {
    return jsonError(request, env, 'INVALID_ARTIST', 'Artist name is required', 400);
  }
  const format = AUDIO_FORMATS.includes(body?.format ?? 'mp3') ? (body?.format ?? 'mp3') : 'mp3';
  const quality = AUDIO_QUALITIES.includes(body?.quality ?? '320') ? (body?.quality ?? '320') : '320';
  const source = normalizeSource(body?.source || 'youtube');
  const syncKey = normalizeOptionalSyncKey(body?.sync_key);
  if (body?.sync_key && !syncKey) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'Sync key is invalid', 400);
  }

  const configuredMax = Math.max(1, Math.min(500, readEnvInt(env.ARTIST_DISCOGRAPHY_MAX_TRACKS, 100)));
  const limit = Math.max(1, Math.min(configuredMax, Number.parseInt(String(body?.limit ?? configuredMax), 10) || configuredMax));
  const resolved = await fetchArtistDiscography(env, artist, source, limit);
  if (!resolved.payload || !Array.isArray(resolved.payload.tracks)) {
    return jsonError(
      request,
      env,
      resolved.errorCode ?? 'ARTIST_DISCOGRAPHY_FAILED',
      resolved.errorMessage ?? 'Artist discography provider failed',
      502,
      resolved.retryable,
    );
  }
  if (!resolved.payload.tracks.length) {
    return jsonError(request, env, 'ARTIST_DISCOGRAPHY_EMPTY', 'No tracks found for this artist', 404);
  }

  const workflowId = crypto.randomUUID();
  const workflowSource = `artist:${artist}`;
  const workflowSourceHash = await sha256Hex(workflowSource);
  const tracks = resolved.payload.tracks.slice(0, limit);
  const playlistTitle = resolved.payload.title || `${artist} Discography`;
  const playlistFolder = formatPlaylistRelPath(playlistTitle, 1, 'Track', artist, format, tracks.length).folder;

  await env.DB.prepare(
    `INSERT INTO playlist_workflows (
      workflow_id, source_url, source, status, phase, total_tracks,
      queued_count, processing_count, done_count, failed_count, deduped_count,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'processing', 'queued', 0, 0, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(workflowId, workflowSourceHash, 'artist').run();

  let accepted = 0;
  let deduped = 0;
  let failed = 0;
  const jobIds: string[] = [];

  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]!;
    const title = String(track.title || '').trim() || `Track ${index + 1}`;
    const trackArtist = String(track.artist || '').trim() || artist;
    const target = String(track.url || '').trim();
    if (!isAllowedDiscographyTarget(target, env)) {
      failed += 1;
      continue;
    }

    const pathInfo = formatPlaylistRelPath(playlistFolder, index + 1, title, trackArtist, format, tracks.length);
    const queued = await queueDownloadJob(env, {
      url: target,
      source: track.source || 'youtube',
      format,
      quality,
      title,
      artist: trackArtist,
      syncKey,
      playlistFolder: pathInfo.folder,
      playlistIndex: index + 1,
      localRelpath: pathInfo.relpath,
    });
    jobIds.push(queued.jobId);
    if (queued.deduped) {
      deduped += 1;
    } else {
      accepted += 1;
    }
    await env.DB.prepare(
      `INSERT OR IGNORE INTO playlist_workflow_jobs (workflow_id, job_id, is_deduped)
       VALUES (?, ?, ?)`,
    ).bind(workflowId, queued.jobId, queued.deduped ? 1 : 0).run();
  }

  const rollup = await syncPlaylistWorkflowRollup(env, workflowId, tracks.length);
  const finalStatus = deriveWorkflowStatus(rollup, tracks.length);
  const finalPhase = deriveWorkflowPhase(finalStatus, rollup);

  await recordTelemetry(env, {
    event: 'artist_discography_queued',
    status: finalStatus === 'failed' ? '500' : '202',
    source,
    value: tracks.length,
    code: artist,
  });

  return jsonOk(request, env, {
    workflow_id: workflowId,
    status: finalStatus,
    phase: finalPhase,
    playlist_title: playlistTitle,
    artist,
    source: resolved.payload.source || source,
    total: tracks.length,
    accepted,
    deduped,
    failed,
    queued: accepted + deduped,
    job_ids: jobIds.slice(0, 100),
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
              done_count, failed_count, deduped_count, control_state, archive_status, archive_url, archive_r2_key, archive_error,
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
    workflow: await sanitizePlaylistWorkflow(row),
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
              done_count, failed_count, deduped_count, control_state, archive_status, archive_url, archive_r2_key, archive_error,
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
    workflow: updated ? await sanitizePlaylistWorkflow(updated) : null,
  });
}

async function sanitizePlaylistWorkflow(row: PlaylistWorkflowRecord): Promise<Record<string, unknown>> {
  const { source_url: sourceUrl, ...safeRow } = row;
  delete (safeRow as { archive_r2_key?: unknown }).archive_r2_key;
  return {
    ...safeRow,
    source_url: null,
    source_url_hash: await safeUrlHash(sourceUrl),
  };
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

    let servedArchiveUrl = archiveUrl;
    let archiveR2Key: string | null = null;
    try {
      const stored = await persistWorkflowArchiveToR2(env, workflowId, archiveUrl, payload.filename ?? `${workflowId}.zip`);
      if (stored) {
        archiveR2Key = stored.r2Key;
        servedArchiveUrl = `${resolvePublicBaseUrl(request, env)}/api/playlist/workflow/${workflowId}/archive`;
      }
    } catch (error) {
      console.warn('Workflow archive R2 persistence skipped', error);
    }

    await env.DB.prepare(
      `UPDATE playlist_workflows
       SET archive_status = 'ready',
           archive_url = ?,
           archive_r2_key = ?,
           archive_error = NULL,
           archive_finished_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE workflow_id = ?`,
    ).bind(servedArchiveUrl, archiveR2Key, workflowId).run();

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
      archive_url: servedArchiveUrl,
      archive_r2_cached: Boolean(archiveR2Key),
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

async function persistWorkflowArchiveToR2(
  env: Env,
  workflowId: string,
  archiveUrl: string,
  filename: string,
): Promise<{ r2Key: string; fileSize: number } | null> {
  if (!env.FILES) return null;

  const normalizedArchiveUrl = normalizeDownloaderUrl(archiveUrl, env);
  const archiveHeaders = buildDownloaderHeaders(normalizedArchiveUrl, env);
  const response = await fetch(normalizedArchiveUrl, archiveHeaders ? { headers: archiveHeaders } : undefined);
  if (!response.ok || !response.body) {
    const details = await response.text();
    throw new Error(`Archive fetch failed (${response.status}): ${details.slice(0, 180)}`);
  }

  const buffer = await response.arrayBuffer();
  const hash = await sha256HexBytes(buffer);
  const r2Key = `archives/${workflowId}/${hash}.zip`;
  const existing = await env.FILES.head(r2Key);
  if (!existing) {
    await env.FILES.put(r2Key, buffer, {
      httpMetadata: {
        contentType: response.headers.get('content-type') ?? 'application/zip',
        contentDisposition: `attachment; filename="${sanitizeArchiveFilename(filename)}"`,
      },
    });
  }

  return { r2Key, fileSize: buffer.byteLength };
}

async function handlePlaylistWorkflowArchiveDownload(
  request: Request,
  env: Env,
  workflowId: string,
): Promise<Response> {
  await ensurePlaylistWorkflowSchema(env);
  const row = await env.DB.prepare(
    `SELECT workflow_id, archive_status, archive_url, archive_r2_key
     FROM playlist_workflows
     WHERE workflow_id = ?`,
  ).bind(workflowId).first<{
    workflow_id: string;
    archive_status: string | null;
    archive_url: string | null;
    archive_r2_key: string | null;
  }>();

  if (!row) {
    return jsonError(request, env, 'WORKFLOW_NOT_FOUND', 'Playlist workflow not found', 404);
  }
  if (row.archive_status !== 'ready') {
    return jsonError(request, env, 'WORKFLOW_ARCHIVE_NOT_READY', 'Playlist archive is not ready', 409, true);
  }

  const fallbackFilename = `${workflowId}.zip`;
  if (row.archive_r2_key && env.FILES) {
    const object = await env.FILES.get(row.archive_r2_key);
    if (!object || !object.body) {
      return jsonError(request, env, 'WORKFLOW_ARCHIVE_MISSING', 'Playlist archive file is missing', 404, true);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('content-type', headers.get('content-type') ?? 'application/zip');
    headers.set('content-disposition', `attachment; filename="${fallbackFilename}"`);

    return new Response(object.body, {
      status: 200,
      headers,
    });
  }

  if (!row.archive_url) {
    return jsonError(request, env, 'WORKFLOW_ARCHIVE_MISSING', 'Playlist archive URL is missing', 404, true);
  }

  const normalizedArchiveUrl = normalizeDownloaderUrl(row.archive_url, env);
  const archiveHeaders = buildDownloaderHeaders(normalizedArchiveUrl, env);
  const upstream = await fetch(normalizedArchiveUrl, archiveHeaders ? { headers: archiveHeaders } : undefined);
  if (!upstream.ok || !upstream.body) {
    const details = await upstream.text();
    return jsonError(request, env, 'WORKFLOW_ARCHIVE_FETCH_FAILED', details || 'Unable to fetch playlist archive', 502, true);
  }

  const headers = new Headers();
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/zip');
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) headers.set('content-length', contentLength);
  headers.set('content-disposition', `attachment; filename="${fallbackFilename}"`);

  return new Response(upstream.body, {
    status: 200,
    headers,
  });
}

function sanitizeArchiveFilename(filename: string): string {
  const cleaned = String(filename || 'playlist.zip')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned.toLowerCase().endsWith('.zip') ? cleaned : `${cleaned || 'playlist'}.zip`;
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
  const originalUrl = await resolvePrivateUrl(env, 'job', row.id, row.url);
  if (!originalUrl) {
    return jsonError(request, env, 'URL_EXPIRED', 'Original URL expired from private cache; create a new download request', 410);
  }
  const fingerprint = row.fingerprint ?? await createJobFingerprint(originalUrl, format, quality);

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
    url: originalUrl,
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
    const originalUrl = await resolvePrivateUrl(env, 'job', row.id, row.url);
    if (!originalUrl) {
      await env.DB.prepare(
        `UPDATE download_jobs
         SET status = 'failed',
             error_code = 'URL_EXPIRED',
             error_message = 'Original URL expired from private cache',
             updated_at = CURRENT_TIMESTAMP,
             finished_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).bind(row.id).run();
      continue;
    }
    await env.DOWNLOAD_QUEUE.send({
      id: row.id,
      url: originalUrl,
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
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `job-status:${jobId}:${ip}`, 10, 60);
  if (rl.limited) {
    return jsonError(request, env, 'RATE_LIMITED', 'Too many status requests for this job', 429, true);
  }

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
  await ensureDownloadJobMetadataSchema(env);
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '20', 10)));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10));
  const syncKey = normalizeOptionalSyncKey(url.searchParams.get('sync_key'));
  if (url.searchParams.has('sync_key') && !syncKey) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'Sync key is invalid', 400);
  }

  const selectSql =
    `SELECT id, source, format, quality, status, title, artist, duration, file_size,
            result_url, r2_key, content_hash, parent_job_id, variant_role, sync_key,
            playlist_folder, playlist_index, local_relpath, created_at
     FROM download_jobs`;
  const whereSql = syncKey ? ' WHERE sync_key = ?' : '';
  const orderSql = ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  const rows = syncKey
    ? await env.DB.prepare(`${selectSql}${whereSql}${orderSql}`).bind(syncKey, limit, offset).all<Record<string, unknown>>()
    : await env.DB.prepare(`${selectSql}${orderSql}`).bind(limit, offset).all<Record<string, unknown>>();

  const countRow = syncKey
    ? await env.DB.prepare('SELECT COUNT(*) AS total FROM download_jobs WHERE sync_key = ?').bind(syncKey).first<{ total: number }>()
    : await env.DB.prepare('SELECT COUNT(*) AS total FROM download_jobs').first<{ total: number }>();

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

async function handleHistoryExport(request: Request, env: Env): Promise<Response> {
  await ensureDownloadJobMetadataSchema(env);
  const url = new URL(request.url);
  const exportFormat = (url.searchParams.get('format') ?? 'json').trim().toLowerCase();
  const limit = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '500', 10)));
  const syncKey = normalizeOptionalSyncKey(url.searchParams.get('sync_key') ?? url.searchParams.get('key'));
  if ((url.searchParams.has('sync_key') || url.searchParams.has('key')) && !syncKey) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'Sync key is invalid', 400);
  }

  const selectSql =
    `SELECT id, source, format, quality, status, title, artist, duration, file_size,
            result_url, r2_key, content_hash, parent_job_id, variant_role, sync_key,
            playlist_folder, playlist_index, local_relpath, created_at, finished_at
     FROM download_jobs`;
  const whereSql = syncKey ? ' WHERE sync_key = ?' : '';
  const orderSql = ' ORDER BY created_at DESC LIMIT ?';
  const rows = syncKey
    ? await env.DB.prepare(`${selectSql}${whereSql}${orderSql}`).bind(syncKey, limit).all<Record<string, unknown>>()
    : await env.DB.prepare(`${selectSql}${orderSql}`).bind(limit).all<Record<string, unknown>>();

  const items = await Promise.all((rows.results ?? []).map(async (row) => {
    let downloadUrl: string | null = null;
    let streamUrl: string | null = null;
    if (row.status === 'done' && ((typeof row.r2_key === 'string' && row.r2_key) || (typeof row.result_url === 'string' && row.result_url))) {
      const available = await isDownloadTargetAvailable(env, row);
      downloadUrl = available ? await buildDownloadUrl(request, env, String(row.id)) : null;
      streamUrl = available ? await buildStreamUrl(request, env, String(row.id)) : null;
    }
    return {
      id: row.id,
      title: row.title ?? null,
      artist: row.artist ?? null,
      source: row.source,
      format: row.format,
      quality: row.quality,
      status: row.status,
      duration: row.duration ?? null,
      file_size: row.file_size ?? null,
      content_hash: row.content_hash ?? null,
      parent_job_id: row.parent_job_id ?? null,
      variant_role: row.variant_role ?? null,
      playlist_folder: row.playlist_folder ?? null,
      playlist_index: row.playlist_index ?? null,
      local_relpath: row.local_relpath ?? null,
      created_at: row.created_at ?? null,
      finished_at: row.finished_at ?? null,
      download_url: downloadUrl,
      stream_url: streamUrl,
      download_available: Boolean(downloadUrl),
      stream_available: Boolean(streamUrl),
    };
  }));

  if (exportFormat === 'csv') {
    const headers = [
      'id',
      'title',
      'artist',
      'source',
      'format',
      'quality',
      'status',
      'duration',
      'file_size',
      'content_hash',
      'playlist_folder',
      'playlist_index',
      'local_relpath',
      'created_at',
      'finished_at',
      'download_url',
      'stream_url',
    ];
    const csv = [
      headers.join(','),
      ...items.map((item) => headers.map((key) => csvEscape((item as Record<string, unknown>)[key])).join(',')),
    ].join('\n');
    return new Response(csv, {
      headers: {
        ...corsHeaders(request, env),
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${historyExportFilename('csv')}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return jsonOk(request, env, {
    exported_at: new Date().toISOString(),
    format: 'json',
    total: items.length,
    items,
  });
}

async function handleHistoryImport(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<HistoryImportBody>(request);
  const key = String(body?.key ?? '').trim();
  if (!isValidSyncKey(key)) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'Sync key is invalid', 400);
  }
  const rawItems = Array.isArray(body?.items) ? body.items : [];
  if (!rawItems.length) {
    return jsonError(request, env, 'HISTORY_IMPORT_EMPTY', 'No history items supplied', 400);
  }

  await ensureImportedHistoryTable(env);
  const now = new Date().toISOString();
  const items = rawItems.slice(0, 1000).map((item) => sanitizeImportedHistoryItem(item, key, now));
  let imported = 0;
  for (const item of items) {
    await env.DB.prepare(
      `INSERT INTO imported_history_items
         (id, sync_key, original_job_id, title, artist, source, format, quality, status,
          duration, file_size, content_hash, download_url, stream_url, created_at, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         sync_key = excluded.sync_key,
         title = excluded.title,
         artist = excluded.artist,
         source = excluded.source,
         format = excluded.format,
         quality = excluded.quality,
         status = excluded.status,
         duration = excluded.duration,
         file_size = excluded.file_size,
         content_hash = excluded.content_hash,
         download_url = excluded.download_url,
         stream_url = excluded.stream_url,
         imported_at = excluded.imported_at`,
    ).bind(
      item.id,
      item.syncKey,
      item.originalJobId,
      item.title,
      item.artist,
      item.source,
      item.format,
      item.quality,
      item.status,
      item.duration,
      item.fileSize,
      item.contentHash,
      item.downloadUrl,
      item.streamUrl,
      item.createdAt,
      item.importedAt,
    ).run();
    imported += 1;
  }

  return jsonOk(request, env, {
    ok: true,
    imported,
    skipped: Math.max(0, rawItems.length - imported),
  });
}

async function handleHistoryRequeue(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<HistoryRequeueBody>(request);
  const jobId = String(body?.job_id ?? '').trim();
  if (!isUuid(jobId)) {
    return jsonError(request, env, 'INVALID_JOB_ID', 'Job id is invalid', 400);
  }

  const row = await getJobRecord(env, jobId);
  if (!row) {
    return jsonError(request, env, 'JOB_NOT_FOUND', 'Job not found', 404);
  }

  const originalUrl = await resolvePrivateUrl(env, 'job', row.id, row.url);
  if (!originalUrl) {
    return jsonError(request, env, 'SOURCE_URL_EXPIRED', 'Original source URL is no longer available for requeue', 410);
  }

  const format = normalizeAudioFormat(body?.format, row.format as AudioFormat);
  const quality = normalizeAudioQuality(body?.quality, format, row.quality as AudioQuality);
  const queued = await queueDownloadJob(env, {
    url: originalUrl,
    source: row.source,
    format,
    quality,
    syncKey: row.sync_key ?? undefined,
    title: row.title ?? undefined,
    artist: row.artist ?? undefined,
  });

  return jsonOk(request, env, {
    ok: true,
    requeued_from: row.id,
    job_id: queued.jobId,
    status: queued.status,
    deduped: queued.deduped,
    format: queued.format,
    quality: queued.quality,
  }, 202);
}

async function ensureImportedHistoryTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS imported_history_items (
       id              TEXT PRIMARY KEY,
       sync_key        TEXT NOT NULL,
       original_job_id TEXT,
       title           TEXT,
       artist          TEXT,
       source          TEXT NOT NULL DEFAULT 'unknown',
       format          TEXT NOT NULL DEFAULT 'mp3',
       quality         TEXT NOT NULL DEFAULT '320',
       status          TEXT NOT NULL DEFAULT 'done',
       duration        INTEGER,
       file_size       INTEGER,
       content_hash    TEXT,
       download_url    TEXT,
       stream_url      TEXT,
       created_at      TEXT,
       imported_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_imported_history_sync ON imported_history_items(sync_key, imported_at DESC)',
  ).run();
}

function sanitizeImportedHistoryItem(
  item: Record<string, unknown>,
  syncKey: string,
  importedAt: string,
): {
  id: string;
  syncKey: string;
  originalJobId: string | null;
  title: string | null;
  artist: string | null;
  source: string;
  format: AudioFormat;
  quality: AudioQuality;
  status: string;
  duration: number | null;
  fileSize: number | null;
  contentHash: string | null;
  downloadUrl: string | null;
  streamUrl: string | null;
  createdAt: string | null;
  importedAt: string;
} {
  const originalJobId = isUuid(String(item.id ?? '')) ? String(item.id) : null;
  const requestedFormat = normalizeAudioFormat(String(item.format ?? ''), 'mp3');
  return {
    id: originalJobId ? `${syncKey}:${originalJobId}` : `${syncKey}:${crypto.randomUUID()}`,
    syncKey,
    originalJobId,
    title: nullableHistoryText(item.title, 180),
    artist: nullableHistoryText(item.artist, 180),
    source: normalizeSource(String(item.source ?? 'unknown')),
    format: requestedFormat,
    quality: normalizeAudioQuality(String(item.quality ?? ''), requestedFormat, '320'),
    status: safeHistoryText(item.status, 32) || 'done',
    duration: safeNullableNumber(item.duration),
    fileSize: safeNullableNumber(item.file_size),
    contentHash: nullableHistoryText(item.content_hash, 128),
    downloadUrl: safePublicUrl(item.download_url),
    streamUrl: safePublicUrl(item.stream_url),
    createdAt: nullableHistoryText(item.created_at, 64),
    importedAt,
  };
}

function csvEscape(value: unknown): string {
  if (value === null || typeof value === 'undefined') return '';
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function historyExportFilename(ext: 'json' | 'csv'): string {
  const date = new Date().toISOString().slice(0, 10);
  return `dyrakarmy-history-${date}.${ext}`;
}

function safeHistoryText(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function nullableHistoryText(value: unknown, max: number): string | null {
  const text = safeHistoryText(value, max);
  return text || null;
}

function safeNullableNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safePublicUrl(value: unknown): string | null {
  const text = safeHistoryText(value, 2048);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
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

async function handleArchivePack(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{
    file_ids?: unknown;
    archive_format?: unknown;
    title?: unknown;
  }>(request);
  const rawIds = Array.isArray(body?.file_ids) ? body.file_ids : [];
  const fileIds = rawIds
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter((value, index, arr) => /^[a-f0-9]{64}$/.test(value) && arr.indexOf(value) === index)
    .slice(0, 200);
  if (!fileIds.length) {
    return jsonError(request, env, 'ARCHIVE_PACK_EMPTY', 'Select at least one archive file', 400);
  }

  const archiveFormat = String(body?.archive_format ?? '7z').trim().toLowerCase() === 'zip' ? 'zip' : '7z';
  const title = String(body?.title ?? 'telegram-selected').trim().slice(0, 120) || 'telegram-selected';

  try {
    const startedAt = Date.now();
    const failover = await fetchDownloaderWithFailover(env, '/internal/archive/pack', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.DOWNLOADER_API_KEY,
      },
      body: JSON.stringify({
        file_ids: fileIds,
        archive_format: archiveFormat,
        title,
      }),
    });
    const response = failover.response;
    await recordTelemetry(env, {
      event: 'archive_pack',
      status: String(response.status),
      origin: failover.origin.baseUrl,
      latency_ms: Date.now() - startedAt,
      code: failover.switched ? 'FAILOVER_SWITCHED' : 'PRIMARY_OK',
    });
    if (!response.ok) {
      const details = await response.text();
      return jsonError(request, env, 'ARCHIVE_PACK_FAILED', details.slice(0, 240) || 'Archive pack failed', 502, true);
    }
    const payload = await response.json() as {
      filename?: string;
      file_size?: number;
      file_count?: number;
      archive_format?: string;
      requested_format?: string;
      fallback_used?: boolean;
    };
    const filename = safePackedArchiveFilename(String(payload.filename ?? ''));
    if (!filename) {
      return jsonError(request, env, 'ARCHIVE_PACK_BAD_FILENAME', 'Archive pack returned invalid filename', 502, true);
    }
    return jsonOk(request, env, {
      download_url: `${resolvePublicBaseUrl(request, env)}/api/archive/packed/${encodeURIComponent(filename)}`,
      filename,
      file_size: Number(payload.file_size ?? 0),
      file_count: Number(payload.file_count ?? fileIds.length),
      archive_format: String(payload.archive_format ?? archiveFormat),
      requested_format: String(payload.requested_format ?? archiveFormat),
      fallback_used: Boolean(payload.fallback_used),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(request, env, 'ARCHIVE_PACK_UNREACHABLE', `Archive pack provider is unreachable: ${message.slice(0, 160)}`, 502, true);
  }
}

async function handleArchivePackedFile(request: Request, env: Env, rawFilename: string): Promise<Response> {
  const filename = safePackedArchiveFilename(rawFilename);
  if (!filename) {
    return jsonError(request, env, 'ARCHIVE_PACKED_FILE_INVALID', 'Invalid archive filename', 400);
  }

  const headers: Record<string, string> = {
    'X-API-Key': env.DOWNLOADER_API_KEY,
  };
  const range = request.headers.get('range');
  if (range) headers.Range = range;
  try {
    const failover = await fetchDownloaderWithFailover(env, `/internal/files/${encodeURIComponent(filename)}`, {
      method: 'GET',
      headers,
    });
    const upstream = failover.response;
    await recordTelemetry(env, {
      event: 'archive_packed_file',
      status: String(upstream.status),
      origin: failover.origin.baseUrl,
      code: failover.switched ? 'FAILOVER_SWITCHED' : 'PRIMARY_OK',
    });
    if (!upstream.ok || !upstream.body) {
      const details = await upstream.text();
      return jsonError(request, env, 'ARCHIVE_PACKED_FILE_FAILED', details.slice(0, 240) || 'Packed archive is unavailable', upstream.status === 404 ? 404 : 502, true);
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
    responseHeaders.set('content-disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(request, env, 'ARCHIVE_PACKED_FILE_UNREACHABLE', `Packed archive provider is unreachable: ${message.slice(0, 160)}`, 502, true);
  }
}

function safePackedArchiveFilename(raw: string): string | null {
  const decoded = raw.trim();
  const leaf = decoded.split(/[\\/]/).pop() ?? '';
  if (!leaf || leaf.includes('..')) return null;
  if (!/^[a-zA-Z0-9._\-\s]+\.(zip|7z)$/i.test(leaf)) return null;
  return leaf;
}

function resolvePublicBaseUrl(request: Request, env: Env): string {
  const configured = (env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/g, '');
  if (configured) return configured;
  const requestUrl = new URL(request.url);
  return requestUrl.origin;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

interface ShareTokenPayload {
  shareJobId: string;
  exp: number;
}

const apiTextEncoder = new TextEncoder();
const apiTextDecoder = new TextDecoder();

function apiBase64UrlEncode(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? apiTextEncoder.encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function apiBase64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - input.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function apiHmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    apiTextEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, apiTextEncoder.encode(message)));
}

async function createShareToken(jobId: string, exp: number, secret: string): Promise<string> {
  const header = apiBase64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = apiBase64UrlEncode(JSON.stringify({ shareJobId: jobId, exp }));
  const unsigned = `${header}.${body}`;
  const signature = apiBase64UrlEncode(await apiHmacSha256(secret, unsigned));
  return `${unsigned}.${signature}`;
}

async function verifyShareToken(token: string, secret: string): Promise<ShareTokenPayload | null> {
  const [header, body, signature] = token.split('.');
  if (!header || !body || !signature) return null;
  const unsigned = `${header}.${body}`;
  const expected = apiBase64UrlEncode(await apiHmacSha256(secret, unsigned));
  if (expected !== signature) return null;
  try {
    const payload = JSON.parse(apiTextDecoder.decode(apiBase64UrlDecode(body))) as Partial<ShareTokenPayload>;
    if (!payload.shareJobId || !payload.exp || payload.exp * 1000 <= Date.now()) return null;
    return { shareJobId: String(payload.shareJobId), exp: Number(payload.exp) };
  } catch {
    return null;
  }
}

function normalizeArtistQuery(raw: string | undefined): string {
  const value = String(raw ?? '')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length < 2 || value.length > 200) return '';
  return value;
}

function isYtDlpSearchTarget(value: string): boolean {
  return /^ytsearch(?:\d{0,2})?:[^\r\n]{2,300}$/i.test(value);
}

function isAllowedDiscographyTarget(value: string, env: Env): boolean {
  if (isYtDlpSearchTarget(value)) return true;
  if (!isValidUrl(value)) return false;
  return validateDownloadUrlPolicy(value, env).allowed;
}

type ShareJobRecord = Pick<
  JobRecord,
  'id' | 'source' | 'format' | 'quality' | 'status' | 'title' | 'artist' | 'duration' | 'file_size' | 'result_url' | 'r2_key' | 'created_at'
>;

async function getShareJobRecord(env: Env, jobId: string): Promise<ShareJobRecord | null> {
  return env.DB.prepare(
    `SELECT id, source, format, quality, status, title, artist, duration, file_size, result_url, r2_key, created_at
     FROM download_jobs
     WHERE id = ?
     LIMIT 1`,
  ).bind(jobId).first<ShareJobRecord>();
}

function shareTitle(row: ShareJobRecord): string {
  const artist = String(row.artist || 'Unknown Artist').trim();
  const title = String(row.title || 'Unknown Track').trim();
  return `${artist} - ${title}`;
}

function shareDescription(row: ShareJobRecord): string {
  const format = String(row.format || '').toUpperCase();
  const quality = String(row.quality || '').trim();
  const source = String(row.source || 'unknown').trim();
  const status = String(row.status || 'queued').trim();
  const parts = [source, format && quality ? `${format} ${quality}` : format || quality, status]
    .filter(Boolean);
  return `Shared from DyrakArmy: ${parts.join(' / ')}`;
}

function escapeHtmlText(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeSvgText(value: string): string {
  return escapeHtmlText(value).replace(/\n/g, ' ');
}

function truncateForCard(value: string, max: number): string {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1)).trim()}…` : clean;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
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
  const minMobileExpo = normalizeVersionTag(env.MIN_CLIENT_MOBILE_EXPO, '1.0.0');
  const minExtension = normalizeVersionTag(env.MIN_CLIENT_EXTENSION, '1.0.0');
  const latestDesktopWindows = normalizeVersionTag(env.LATEST_DESKTOP_WINDOWS_VERSION, minDesktopWindows);
  const latestDesktopMacos = normalizeVersionTag(env.LATEST_DESKTOP_MACOS_VERSION, minDesktopMacos);
  const latestMobileExpo = normalizeVersionTag(env.LATEST_MOBILE_EXPO_VERSION, minMobileExpo);
  const latestExtension = normalizeVersionTag(env.LATEST_EXTENSION_VERSION, minExtension);
  const versionByArtifact: Record<ReleaseArtifactEntry['id'], { latest: string; minimum: string }> = {
    desktop_windows: { latest: latestDesktopWindows, minimum: minDesktopWindows },
    desktop_macos: { latest: latestDesktopMacos, minimum: minDesktopMacos },
    desktop_linux_x64: { latest: latestDesktopWindows, minimum: minDesktopWindows },
    desktop_linux_arm64: { latest: latestDesktopWindows, minimum: minDesktopWindows },
    mobile_ios: { latest: latestMobileExpo, minimum: minMobileExpo },
    mobile_android: { latest: latestMobileExpo, minimum: minMobileExpo },
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
    desktop_linux: {
      minimum_supported: minDesktopWindows,
      latest: latestDesktopWindows,
      x64_url: `${base}/downloads/DyrakArmyDesktop-linux-x64.zip`,
      arm64_url: `${base}/downloads/DyrakArmyDesktop-linux-arm64.zip`,
    },
    mobile_expo: {
      minimum_supported: minMobileExpo,
      latest: latestMobileExpo,
      update_url: `${base}/`,
      ios_package_url: `${base}/downloads/DyrakArmy-Mobile-iOS-Expo.zip`,
      android_package_url: `${base}/downloads/DyrakArmy-Mobile-Android-Expo.zip`,
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
      linux_x64_portable: `${base}/downloads/DyrakArmyDesktop-linux-x64.zip`,
      linux_arm64_portable: `${base}/downloads/DyrakArmyDesktop-linux-arm64.zip`,
      mobile_ios_package: `${base}/downloads/DyrakArmy-Mobile-iOS-Expo.zip`,
      mobile_android_package: `${base}/downloads/DyrakArmy-Mobile-Android-Expo.zip`,
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
      ops_telegram_channel: true,
      admin_panel_v2: true,
      update_channel_v1: true,
      signed_release_manifest_v1: true,
      smart_format_auto_selector: true,
      shared_queue: true,
      offline_cache_warming: true,
      archive_browser_v2: true,
      sync_key_claims: true,
    },
    sync_key_claim: {
      endpoint: `${base}/api/sync/claim`,
      email_required: env.SYNC_KEY_EMAIL_REQUIRED === '1',
      turnstile_required: env.SYNC_KEY_TURNSTILE_REQUIRED === '1',
      turnstile_site_key: String(env.SYNC_KEY_TURNSTILE_SITE_KEY ?? '').trim() || null,
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

async function handleOpsTelegramChannelStatus(request: Request, env: Env): Promise<Response> {
  const auth = resolveOpsAuthContext(request, env);
  if (!hasOpsRole(auth, 'viewer')) {
    await writeOpsAuditEvent(env, request, 'ops_telegram_channel_status', auth, 'denied', 'missing_or_invalid_token');
    return jsonError(request, env, 'FORBIDDEN', 'Missing or invalid ops token', 403);
  }

  const status = await getTelegramChannelPublishStatus(env);
  await writeOpsAuditEvent(env, request, 'ops_telegram_channel_status', auth, 'allowed', {
    channel_configured: Boolean(status.channel_id),
    pending_backfill_count: status.pending_backfill_count,
  });

  return jsonOk(request, env, {
    ok: true,
    role: auth.role,
    telegram_channel: status,
  });
}

async function handleOpsTelegramChannelBackfill(request: Request, env: Env): Promise<Response> {
  const auth = resolveOpsAuthContext(request, env);
  if (!hasOpsRole(auth, 'admin')) {
    await writeOpsAuditEvent(env, request, 'ops_telegram_channel_backfill', auth, 'denied', {
      reason: 'requires_admin',
    });
    return jsonError(request, env, 'FORBIDDEN', 'Missing or invalid ops admin token', 403);
  }

  const body = await parseJson<OpsTelegramChannelBackfillRequestBody>(request);
  const requestedLimit = Number(body?.limit ?? 25);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(100, Math.trunc(requestedLimit)))
    : 25;
  const published = await backfillTelegramChannelPublishes(env, limit);
  const status = await getTelegramChannelPublishStatus(env);

  await recordTelemetry(env, {
    event: 'telegram_channel_backfill_manual',
    status: '200',
    code: `published=${published};limit=${limit}`,
    value: published,
  });
  await writeOpsAuditEvent(env, request, 'ops_telegram_channel_backfill', auth, 'success', {
    requested_limit: requestedLimit,
    enforced_limit: limit,
    published,
    pending_backfill_count: status.pending_backfill_count,
  });

  return jsonOk(request, env, {
    ok: true,
    role: auth.role,
    requested_limit: requestedLimit,
    limit,
    published,
    telegram_channel: status,
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
    const originalUrl = await resolvePrivateUrl(env, 'job', row.id, row.url);
    if (!originalUrl) {
      skipped += 1;
      skippedIds.push(row.id);
      await env.DB.prepare(
        `UPDATE download_jobs
         SET status = 'failed',
             error_code = 'URL_EXPIRED',
             error_message = 'Original URL expired from private cache',
             updated_at = CURRENT_TIMESTAMP,
             finished_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).bind(row.id).run();
      continue;
    }
    const source = normalizeSource(row.source || detectSourceFromUrl(originalUrl));
    const fingerprint = row.fingerprint || await createJobFingerprint(originalUrl, format, quality);

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
      url: originalUrl,
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

async function handleSyncClaim(request: Request, env: Env): Promise<Response> {
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `sync-claim:${ip}`, 5, 60);
  if (rl.limited) {
    return jsonError(request, env, 'RATE_LIMITED', 'Too many sync claim requests', 429, true);
  }

  const body = await parseJson<SyncClaimRequestBody>(request);
  const providedKey = normalizeOptionalSyncKey(body?.key);
  if (body?.key && !providedKey) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'Sync key is invalid', 400);
  }

  const email = normalizeEmail(body?.email);
  if (body?.email && !email) {
    return jsonError(request, env, 'INVALID_EMAIL', 'Email address is invalid', 400);
  }
  if (env.SYNC_KEY_EMAIL_REQUIRED === '1' && !email) {
    return jsonError(request, env, 'EMAIL_REQUIRED', 'Email address is required to claim a sync key', 400);
  }

  let turnstileVerified = false;
  if (env.SYNC_KEY_TURNSTILE_REQUIRED === '1' || body?.turnstile_token) {
    const token = String(body?.turnstile_token ?? '').trim();
    if (!token) {
      return jsonError(request, env, 'CAPTCHA_REQUIRED', 'Captcha token is required to claim a sync key', 400);
    }
    const verified = await verifyTurnstileToken(env, token, ip);
    if (!verified) {
      return jsonError(request, env, 'CAPTCHA_FAILED', 'Captcha verification failed', 400);
    }
    turnstileVerified = true;
  }

  const key = providedKey ?? generateSyncKey();
  const emailHash = email ? await sha256Hex(email) : null;
  const ipHash = await sha256Hex(ip);

  await ensureSyncKeyClaimsSchema(env);
  await env.DB.prepare(
    `INSERT INTO sync_key_claims (
       sync_key, email_hash, turnstile_verified, ip_hash, created_at, updated_at, last_claimed_at
     ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(sync_key) DO UPDATE SET
       email_hash = COALESCE(excluded.email_hash, sync_key_claims.email_hash),
       turnstile_verified = MAX(sync_key_claims.turnstile_verified, excluded.turnstile_verified),
       ip_hash = excluded.ip_hash,
       updated_at = CURRENT_TIMESTAMP,
       last_claimed_at = CURRENT_TIMESTAMP`,
  ).bind(key, emailHash, turnstileVerified ? 1 : 0, ipHash).run();

  await recordTelemetry(env, {
    event: 'sync_key_claimed',
    status: '200',
    code: emailHash ? 'EMAIL_HASHED' : 'NO_EMAIL',
  });

  return jsonOk(request, env, {
    key,
    claimed: true,
    email_bound: Boolean(emailHash),
    turnstile_verified: turnstileVerified,
  });
}

function normalizeEmail(input: string | null | undefined): string | null {
  const value = String(input ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

function generateSyncKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `sd${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`.slice(0, 32);
}

async function verifyTurnstileToken(env: Env, token: string, ip: string): Promise<boolean> {
  const secret = String(env.SYNC_KEY_TURNSTILE_SECRET ?? '').trim();
  if (!secret) return false;

  const form = new FormData();
  form.set('secret', secret);
  form.set('response', token);
  if (ip && ip !== 'unknown') form.set('remoteip', ip);

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    if (!response.ok) return false;
    const payload = await response.json<{ success?: boolean }>();
    return payload.success === true;
  } catch {
    return false;
  }
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

export async function isPrivacyModeEnabledForSyncKey(env: Env, syncKey: string | undefined | null): Promise<boolean> {
  const key = String(syncKey ?? '').trim();
  if (!isValidSyncKey(key)) return false;
  try {
    const stored = await loadPreferencesState(env, key);
    return normalizePreferencesState(stored).privacy_mode;
  } catch {
    return false;
  }
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
    } else if (field === 'privacy_mode') {
      const value = normalizeBooleanPreference(incomingRaw);
      if (value !== next.privacy_mode) {
        next.privacy_mode = value;
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

  const jobRecord = await getJobRecord(env, payload.jobId);
  if (!jobRecord) {
    return jsonError(request, env, 'JOB_NOT_FOUND', 'Job not found', 404);
  }
  const job = {
    title: jobRecord.title,
    artist: jobRecord.artist,
    format: jobRecord.format,
    r2_key: jobRecord.r2_key,
    result_url: jobRecord.result_url,
  };

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
  await ensureDownloadJobMetadataSchema(env);
  const row = await env.DB.prepare(
    `SELECT id, url, source, format, quality, status, attempts,
            parent_job_id, variant_role, sync_key, playlist_folder, playlist_index, local_relpath,
            result_url, r2_key, title, artist, duration, file_size,
            fingerprint, content_hash, error_code, error_message, created_at, updated_at, finished_at
     FROM download_jobs
     WHERE id = ?`,
  ).bind(jobId).first<JobRecord>();
  if (row) return row;
  return getPrivacyJobSnapshot(env, jobId);
}

async function getPrivacyJobSnapshot(env: Env, jobId: string): Promise<JobRecord | null> {
  const snapshot = await env.CACHE.get(`privacy-job:${jobId}`, { type: 'json' }) as Record<string, unknown> | null;
  if (!snapshot || String(snapshot.id ?? '') !== jobId || snapshot.status !== 'done') return null;
  const now = new Date().toISOString();
  return {
    id: jobId,
    url: '',
    source: safeSnapshotString(snapshot.source, 'unknown'),
    format: safeSnapshotString(snapshot.format, 'mp3'),
    quality: safeSnapshotString(snapshot.quality, '320'),
    status: 'done',
    attempts: Math.max(1, Number(snapshot.attempts ?? 1) || 1),
    parent_job_id: safeNullableSnapshotString(snapshot.parent_job_id),
    variant_role: safeSnapshotString(snapshot.variant_role, 'primary'),
    sync_key: safeNullableSnapshotString(snapshot.sync_key),
    playlist_folder: safeNullableSnapshotString(snapshot.playlist_folder),
    playlist_index: Number.isFinite(Number(snapshot.playlist_index)) ? Number(snapshot.playlist_index) : null,
    local_relpath: safeNullableSnapshotString(snapshot.local_relpath),
    result_url: safeNullableSnapshotString(snapshot.result_url),
    r2_key: safeNullableSnapshotString(snapshot.r2_key),
    title: safeNullableSnapshotString(snapshot.title),
    artist: safeNullableSnapshotString(snapshot.artist),
    duration: Number.isFinite(Number(snapshot.duration)) ? Number(snapshot.duration) : null,
    file_size: Number.isFinite(Number(snapshot.file_size)) ? Number(snapshot.file_size) : null,
    fingerprint: safeNullableSnapshotString(snapshot.fingerprint),
    content_hash: safeNullableSnapshotString(snapshot.content_hash),
    error_code: null,
    error_message: null,
    created_at: safeSnapshotString(snapshot.created_at, now),
    updated_at: safeSnapshotString(snapshot.updated_at, now),
    finished_at: safeNullableSnapshotString(snapshot.finished_at) ?? now,
  };
}

function safeSnapshotString(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function safeNullableSnapshotString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

async function hydrateJobRecord(request: Request, env: Env, row: JobRecord): Promise<Record<string, unknown>> {
  let downloadUrl: string | null = null;
  let streamUrl: string | null = null;
  if (row.status === 'done' && (row.r2_key || row.result_url)) {
    const available = await isDownloadTargetAvailable(env, row);
    downloadUrl = available ? await buildDownloadUrl(request, env, row.id) : null;
    streamUrl = available ? await buildStreamUrl(request, env, row.id) : null;
  }
  const { url: storedUrl, ...safeRow } = row;

  return {
    ...safeRow,
    url: null,
    url_hash: await safeUrlHash(storedUrl),
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

async function fetchArtistDiscography(
  env: Env,
  artist: string,
  source: string,
  limit: number,
): Promise<PlaylistResolveResult> {
  try {
    const startedAt = Date.now();
    const failover = await fetchDownloaderWithFailover(env, '/internal/artist/discography', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.DOWNLOADER_API_KEY,
      },
      body: JSON.stringify({
        artist,
        source,
        limit,
      }),
    });
    const response = failover.response;
    await recordTelemetry(env, {
      event: 'downloader_artist_discography',
      status: String(response.status),
      source,
      origin: failover.origin.baseUrl,
      latency_ms: Date.now() - startedAt,
      code: failover.switched ? 'FAILOVER_SWITCHED' : 'PRIMARY_OK',
    });
    if (!response.ok) {
      const details = await response.text();
      return {
        payload: null,
        errorCode: 'ARTIST_DISCOGRAPHY_FAILED',
        errorMessage: details.slice(0, 240) || 'Artist discography provider failed',
        retryable: response.status >= 500,
      };
    }
    const payload = await response.json<PlaylistResolveResponse>();
    if (!payload || !Array.isArray(payload.tracks)) {
      return {
        payload: null,
        errorCode: 'ARTIST_DISCOGRAPHY_INVALID_PAYLOAD',
        errorMessage: 'Artist discography provider returned an invalid payload',
        retryable: true,
      };
    }
    return {
      payload,
      retryable: false,
    };
  } catch (error) {
    console.error('Artist discography request failed', error);
    return {
      payload: null,
      errorCode: 'ARTIST_DISCOGRAPHY_UNREACHABLE',
      errorMessage: 'Artist discography provider is temporarily unreachable',
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
    if ((host.endsWith('youtube.com') || host.endsWith('youtu.be')) && (
      path.startsWith('/@')
      || path.startsWith('/channel/')
      || path.startsWith('/c/')
      || path.startsWith('/user/')
    )) {
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

function normalizeOptionalSyncKey(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim();
  return normalized && isValidSyncKey(normalized) ? normalized : null;
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
    privacy_mode: updatedAt,
  };

  return {
    language: normalizeLanguage(raw?.language),
    source: normalizePreferenceSource(raw?.source),
    format,
    quality: normalizeAudioQuality(raw?.quality, format, '320'),
    download_directory: normalizeDownloadDirectory(raw?.download_directory),
    telegram_link_mode: normalizeTelegramLinkMode(raw?.telegram_link_mode),
    privacy_mode: normalizeBooleanPreference(raw?.privacy_mode),
    revision: Math.max(0, normalizePreferenceRevision(raw?.revision)),
    field_updated_at: {
      language: isoFromMs(parseIsoMs(baseFieldTimes.language), updatedAt),
      source: isoFromMs(parseIsoMs(baseFieldTimes.source), updatedAt),
      format: isoFromMs(parseIsoMs(baseFieldTimes.format), updatedAt),
      quality: isoFromMs(parseIsoMs(baseFieldTimes.quality), updatedAt),
      download_directory: isoFromMs(parseIsoMs(baseFieldTimes.download_directory), updatedAt),
      telegram_link_mode: isoFromMs(parseIsoMs(baseFieldTimes.telegram_link_mode), updatedAt),
      privacy_mode: isoFromMs(parseIsoMs(baseFieldTimes.privacy_mode), updatedAt),
    },
    last_writer: normalizeClientId(raw?.last_writer),
    updated_at: updatedAt,
  };
}

function normalizeBooleanPreference(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  const value = String(raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}
