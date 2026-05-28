import type {
  AudioFormat,
  AudioQuality,
  DownloaderSearchResult,
  Env,
  JobStatus,
} from './types';
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
  verifyDownloadToken,
} from './utils';

interface SearchRequestBody {
  query: string;
  source?: string;
}

interface DownloadRequestBody {
  url: string;
  source?: string;
  format?: AudioFormat;
  quality?: AudioQuality;
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

interface PreferencesPayload {
  key?: string;
  language?: string;
}

interface TelegramInfoCache {
  username: string;
  deepLink: string;
  downloadLink: string;
}

interface JobRecord {
  id: string;
  url: string;
  source: string;
  format: string;
  quality: string;
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

const AUDIO_FORMATS: AudioFormat[] = ['mp3', 'flac', 'ogg', 'm4a', 'opus', 'wav'];
const AUDIO_QUALITIES: AudioQuality[] = ['320', '256', '192', '128', '96', 'best', 'lossless'];
const SUPPORTED_LANGUAGES = new Set(['en', 'bg']);
const SSE_POLL_INTERVAL_MS = 1500;
const SSE_MAX_DURATION_MS = 5 * 60 * 1000;
const INVIDIOUS_DEFAULT_BASE_URL = 'https://inv.nadeko.net';
const INVIDIOUS_FALLBACK_BASE_URLS = [
  'https://invidious.f5.si',
  'https://inv.thepixora.com',
  'https://yt.chocolatemoo53.com',
];

export async function downloadRouter(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return optionsResponse(request, env);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace('/api', '');

  if (path === '/health' && request.method === 'GET') {
    return jsonOk(request, env, { ok: true, service: 'sounddrop-worker' });
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

  if (path === '/download' && request.method === 'POST') {
    return handleDownload(request, env);
  }

  if (path === '/playlist/resolve' && request.method === 'POST') {
    return handlePlaylistResolve(request, env);
  }

  if (path === '/playlist/queue' && request.method === 'POST') {
    return handlePlaylistQueue(request, env);
  }

  const jobEventsMatch = path.match(/^\/job\/([0-9a-f-]{36})\/events$/i);
  if (jobEventsMatch && request.method === 'GET') {
    return handleJobEvents(request, env, jobEventsMatch[1]!);
  }

  const jobStatusMatch = path.match(/^\/job\/([0-9a-f-]{36})$/i);
  if (jobStatusMatch && request.method === 'GET') {
    return handleJobStatus(request, env, jobStatusMatch[1]!);
  }

  if (path === '/history' && request.method === 'GET') {
    return handleHistory(request, env);
  }

  if (path === '/formats' && request.method === 'GET') {
    return handleFormats(request, env);
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
  const cacheTtl = readEnvInt(env.SEARCH_CACHE_TTL_SECONDS, 180);
  const cacheKey = `search:${source}:${query.toLowerCase()}`;

  const cached = await env.CACHE.get(cacheKey, { type: 'json' }) as { results: DownloaderSearchResult[] } | null;
  if (cached?.results) {
    return jsonOk(request, env, { results: cached.results, cached: true });
  }

  let upstreamResults: DownloaderSearchResult[] | null = null;
  try {
    const response = await fetch(`${env.DOWNLOADER_API_URL}/internal/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.DOWNLOADER_API_KEY,
      },
      body: JSON.stringify({ query, source, limit: 8 }),
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

  await env.CACHE.put(cacheKey, JSON.stringify({ results }), { expirationTtl: cacheTtl });
  return jsonOk(request, env, { results, cached: false });
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

  const format = AUDIO_FORMATS.includes(body.format ?? 'mp3') ? (body.format ?? 'mp3') : 'mp3';
  const quality = AUDIO_QUALITIES.includes(body.quality ?? '320') ? (body.quality ?? '320') : '320';
  const source = normalizeSource(body.source ?? detectSourceFromUrl(url));
  const fingerprint = await createJobFingerprint(url, format, quality);
  const dedupeKey = `dedupe:${fingerprint}`;

  const dedupeTtl = readEnvInt(env.DOWNLOAD_DEDUPE_TTL_SECONDS, 120);
  const existing = await getExistingJobByFingerprint(env, fingerprint, dedupeTtl);
  if (existing) {
    return jsonOk(request, env, {
      jobId: existing.id,
      status: existing.status,
      deduped: true,
    }, 202);
  }

  const jobId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO download_jobs (
      id, url, source, format, quality, status, attempts, fingerprint, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(jobId, url, source, format, quality, fingerprint).run();

  await env.DOWNLOAD_QUEUE.send({
    id: jobId,
    url,
    source,
    format,
    quality,
    fingerprint,
    requestedAt: new Date().toISOString(),
  });

  await env.CACHE.put(dedupeKey, jobId, { expirationTtl: dedupeTtl });

  return jsonOk(request, env, {
    jobId,
    status: 'queued',
    deduped: false,
  }, 202);
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
  if (!isPlaylistUrl(playlistUrl)) {
    return jsonError(request, env, 'INVALID_PLAYLIST_URL', 'URL is not recognized as a playlist', 400);
  }

  const source = normalizeSource(body.source ?? detectSourceFromUrl(playlistUrl));
  const resolved = await fetchPlaylistResolve(env, playlistUrl, source);
  if (!resolved || !Array.isArray(resolved.tracks)) {
    return jsonError(request, env, 'PLAYLIST_RESOLVE_FAILED', 'Playlist provider failed', 502, true);
  }

  return jsonOk(request, env, {
    title: resolved.title ?? 'Playlist',
    source: resolved.source ?? source,
    total: Number(resolved.total ?? resolved.tracks.length),
    tracks: resolved.tracks,
  });
}

async function handlePlaylistQueue(request: Request, env: Env): Promise<Response> {
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
  if (!isPlaylistUrl(playlistUrl)) {
    return jsonError(request, env, 'INVALID_PLAYLIST_URL', 'URL is not recognized as a playlist', 400);
  }

  const format = AUDIO_FORMATS.includes(body.format ?? 'mp3') ? (body.format ?? 'mp3') : 'mp3';
  const quality = AUDIO_QUALITIES.includes(body.quality ?? '320') ? (body.quality ?? '320') : '320';
  const source = normalizeSource(body.source ?? detectSourceFromUrl(playlistUrl));

  const resolved = await fetchPlaylistResolve(env, playlistUrl, source);
  if (!resolved || !Array.isArray(resolved.tracks)) {
    return jsonError(request, env, 'PLAYLIST_RESOLVE_FAILED', 'Playlist provider failed', 502, true);
  }
  if (resolved.tracks.length === 0) {
    return jsonError(request, env, 'PLAYLIST_EMPTY', 'No tracks found in playlist', 400);
  }

  const dedupeTtl = readEnvInt(env.DOWNLOAD_DEDUPE_TTL_SECONDS, 120);
  let accepted = 0;
  let deduped = 0;
  let ready = 0;
  const queuedJobIds: string[] = [];

  for (const track of resolved.tracks) {
    const trackUrl = String(track.url ?? '').trim();
    if (!isValidUrl(trackUrl)) {
      continue;
    }

    const trackSource = normalizeSource(track.source || detectSourceFromUrl(trackUrl) || source);
    const fingerprint = await createJobFingerprint(trackUrl, format, quality);
    const dedupeKey = `dedupe:${fingerprint}`;
    const existing = await getExistingJobByFingerprint(env, fingerprint, dedupeTtl);
    if (existing) {
      deduped += 1;
      if (existing.status === 'done') {
        ready += 1;
      }
      queuedJobIds.push(existing.id);
      continue;
    }

    const jobId = crypto.randomUUID();
    const title = String(track.title ?? '').trim() || 'Unknown Title';
    const artist = String(track.artist ?? '').trim() || 'Unknown Artist';

    await env.DB.prepare(
      `INSERT INTO download_jobs (
        id, url, source, format, quality, status, attempts, fingerprint, title, artist, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(jobId, trackUrl, trackSource, format, quality, fingerprint, title, artist).run();

    await env.DOWNLOAD_QUEUE.send({
      id: jobId,
      url: trackUrl,
      source: trackSource,
      format,
      quality,
      fingerprint,
      requestedAt: new Date().toISOString(),
    });

    await env.CACHE.put(dedupeKey, jobId, { expirationTtl: dedupeTtl });
    accepted += 1;
    queuedJobIds.push(jobId);
  }

  return jsonOk(request, env, {
    playlist_title: resolved.title ?? 'Playlist',
    source: resolved.source ?? source,
    total: resolved.tracks.length,
    accepted,
    deduped,
    ready,
    queued: accepted + deduped,
    job_ids: queuedJobIds.slice(0, 100),
  }, 202);
}

async function getExistingJobByFingerprint(
  env: Env,
  fingerprint: string,
  dedupeTtlSeconds: number,
): Promise<ExistingFingerprintJob | null> {
  const dedupeKey = `dedupe:${fingerprint}`;
  const existingJobId = await env.CACHE.get(dedupeKey);
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
       AND status IN ('queued', 'processing', 'done')
     ORDER BY
       CASE status
         WHEN 'done' THEN 0
         WHEN 'processing' THEN 1
         ELSE 2
       END,
       finished_at DESC,
       created_at DESC
     LIMIT 1`,
  ).bind(fingerprint).first<ExistingFingerprintJob>();

  if (!fromDb?.id) {
    return null;
  }

  await env.CACHE.put(dedupeKey, fromDb.id, { expirationTtl: dedupeTtlSeconds });
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
        const downloadUrl = await buildDownloadUrl(request, env, String(row.id));
        return { ...row, download_url: downloadUrl };
      }
      return { ...row, download_url: null };
    }),
  );

  return jsonOk(request, env, {
    history,
    total: countRow?.total ?? history.length,
    limit,
    offset,
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

async function handleTelegramInfo(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_BOT_TOKEN.trim()) {
    return jsonOk(request, env, { available: false });
  }

  const cacheKey = 'telegram:info';
  const cached = await env.CACHE.get(cacheKey, { type: 'json' }) as TelegramInfoCache | null;
  if (cached?.username && cached.deepLink) {
    return jsonOk(request, env, {
      available: true,
      ...cached,
    });
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    if (!response.ok) {
      const details = await response.text();
      console.warn(`Telegram getMe failed (${response.status}): ${details.slice(0, 240)}`);
      return jsonOk(request, env, { available: false });
    }

    const payload = await response.json() as {
      ok?: boolean;
      result?: { username?: string };
    };
    const username = payload.result?.username?.trim();
    if (!payload.ok || !username) {
      return jsonOk(request, env, { available: false });
    }

    const info: TelegramInfoCache = {
      username,
      deepLink: `https://t.me/${username}`,
      downloadLink: `https://t.me/${username}?start=download`,
    };
    await env.CACHE.put(cacheKey, JSON.stringify(info), { expirationTtl: 60 * 60 });

    return jsonOk(request, env, {
      available: true,
      ...info,
    });
  } catch (error) {
    console.error('Telegram info fetch failed', error);
    return jsonOk(request, env, { available: false });
  }
}

async function handlePreferencesGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get('key')?.trim() ?? '';
  if (!isValidSyncKey(key)) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'Sync key is invalid', 400);
  }

  const stored = await env.CACHE.get(`prefs:${key}`, { type: 'json' }) as { language?: string } | null;
  const language = normalizeLanguage(stored?.language);

  return jsonOk(request, env, {
    key,
    language,
  });
}

async function handlePreferencesPost(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<PreferencesPayload>(request);
  const key = body?.key?.trim() ?? '';
  if (!isValidSyncKey(key)) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'Sync key is invalid', 400);
  }

  const language = normalizeLanguage(body?.language);
  const payload = { language, updated_at: new Date().toISOString() };
  await env.CACHE.put(`prefs:${key}`, JSON.stringify(payload), { expirationTtl: 31536000 });

  return jsonOk(request, env, {
    ok: true,
    key,
    language,
  });
}

async function handleFileDownload(request: Request, env: Env, token: string): Promise<Response> {
  const payload = await verifyDownloadToken(token, env.DOWNLOAD_TOKEN_SECRET);
  if (!payload) {
    return jsonError(request, env, 'INVALID_TOKEN', 'Download token is invalid or expired', 401);
  }

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

  const ext = (job.format ?? 'bin').toLowerCase();
  const filename = formatFileName(job.title ?? 'track', job.artist ?? 'sounddrop', ext);

  if (job.r2_key && env.FILES) {
    const object = await env.FILES.get(job.r2_key);
    if (!object || !object.body) {
      return jsonError(request, env, 'FILE_NOT_FOUND', 'File not found', 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('content-disposition', `attachment; filename="${filename}"`);

    return new Response(object.body, {
      status: 200,
      headers,
    });
  }

  if (!job.result_url) {
    return jsonError(request, env, 'FILE_UNAVAILABLE', 'File is not available', 404);
  }

  const normalizedResultUrl = normalizeDownloaderUrl(job.result_url, env.DOWNLOADER_API_URL);
  let upstream: Response;
  try {
    const upstreamHeaders = buildDownloaderHeaders(normalizedResultUrl, env);
    upstream = await fetch(normalizedResultUrl, upstreamHeaders ? { headers: upstreamHeaders } : undefined);
  } catch (error) {
    console.error('File upstream request failed', error);
    return jsonError(request, env, 'FILE_FETCH_FAILED', 'Unable to fetch file', 502, true);
  }
  if (!upstream.ok || !upstream.body) {
    const details = await upstream.text();
    return jsonError(request, env, 'FILE_FETCH_FAILED', `Unable to fetch file: ${details}`, 502, true);
  }

  const headers = new Headers();
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream');
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) {
    headers.set('content-length', contentLength);
  }
  headers.set('content-disposition', `attachment; filename="${filename}"`);

  return new Response(upstream.body, {
    status: 200,
    headers,
  });
}

async function getJobRecord(env: Env, jobId: string): Promise<JobRecord | null> {
  return env.DB.prepare(
    `SELECT id, url, source, format, quality, status, attempts,
            result_url, r2_key, title, artist, duration, file_size,
            content_hash, error_code, error_message, created_at, updated_at, finished_at
     FROM download_jobs
     WHERE id = ?`,
  ).bind(jobId).first<JobRecord>();
}

async function hydrateJobRecord(request: Request, env: Env, row: JobRecord): Promise<Record<string, unknown>> {
  let downloadUrl: string | null = null;
  if (row.status === 'done' && (row.r2_key || row.result_url)) {
    downloadUrl = await buildDownloadUrl(request, env, row.id);
  }

  return {
    ...row,
    download_url: downloadUrl,
  };
}

async function buildDownloadUrl(request: Request, env: Env, jobId: string): Promise<string> {
  const ttl = readEnvInt(env.DOWNLOAD_TOKEN_TTL_SECONDS, 3600);
  const token = await createDownloadToken(
    {
      jobId,
      exp: Math.floor(Date.now() / 1000) + ttl,
    },
    env.DOWNLOAD_TOKEN_SECRET,
  );

  const base = new URL(request.url);
  return `${base.origin}/api/file/${encodeURIComponent(token)}`;
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
): Promise<PlaylistResolveResponse | null> {
  try {
    const response = await fetch(`${env.DOWNLOADER_API_URL}/internal/playlist/resolve`, {
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
    if (!response.ok) {
      const details = await response.text();
      console.warn(`Playlist resolve upstream failed (${response.status}): ${details.slice(0, 240)}`);
      return null;
    }
    return await response.json<PlaylistResolveResponse>();
  } catch (error) {
    console.error('Playlist resolve request failed', error);
    return null;
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
    return false;
  } catch {
    return false;
  }
}

function isValidSyncKey(value: string): boolean {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(value);
}

function normalizeLanguage(raw: string | undefined): 'en' | 'bg' {
  const normalized = (raw ?? 'en').trim().toLowerCase();
  if (SUPPORTED_LANGUAGES.has(normalized)) {
    return normalized as 'en' | 'bg';
  }
  return 'en';
}

function buildDownloaderHeaders(targetUrl: string, env: Env): Record<string, string> | null {
  const normalizedBase = env.DOWNLOADER_API_URL.replace(/\/+$/g, '');
  if (!targetUrl.startsWith(normalizedBase)) {
    return null;
  }

  return {
    'X-API-Key': env.DOWNLOADER_API_KEY,
  };
}

function normalizeDownloaderUrl(rawUrl: string, downloaderBaseUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
    if (!localHosts.has(parsed.hostname.toLowerCase())) {
      return rawUrl;
    }

    const base = new URL(downloaderBaseUrl.replace(/\/+$/g, ''));
    return `${base.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return rawUrl;
  }
}
