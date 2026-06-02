/**
 * DyrakArmy v7 Worker
 * Public API + queue consumer + Telegram webhook
 */

import { downloadRouter } from './api';
import { enqueueHistoryEvent, processHistoryEventBatch } from './history';
import { ensureDeadLetterSchema, ensurePlaylistWorkflowSchema } from './schema';
import {
  handleTelegramUpdate,
  notifyTelegramComplete,
  notifyTelegramFailure,
  publishTelegramChannelDownload,
} from './telegram';
import type { DownloadJob, DownloaderDownloadResult, Env, JobHistoryEvent, JobStatus } from './types';
import { detectRequestThreat, jsonError, optionsResponse, sha256HexBytes } from './utils';
import {
  buildDownloaderHeaders,
  fetchDownloaderWithFailover,
  normalizeDownloaderUrl,
  probeDownloaderOrigins,
} from './origins';
import { evaluateOpsAlerts, recordSmokeProbeResult, recordTelemetry } from './telemetry';
import { cleanupStaleKvKeys, resolvePrivateUrl } from './security';
import { calculateQueueRetryDelayFromEnv } from './retry';
import { cleanupExpiredJobsAndFiles, shouldRunRetentionCleanup } from './retention';

const MAX_QUEUE_RETRIES = 5;
const INVIDIOUS_DEFAULT_BASE_URL = 'https://inv.nadeko.net';
const INVIDIOUS_FALLBACK_BASE_URLS = [
  'https://invidious.f5.si',
  'https://inv.thepixora.com',
  'https://yt.chocolatemoo53.com',
];
const ORIGIN_WARMUP_PATH = '/health';
const SMOKE_DEFAULT_SPOTIFY_URL = 'https://open.spotify.com/track/5msPBVPfpNMt36L9hsPD0B';
const SMOKE_DEFAULT_YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return optionsResponse(request, env);
    }

    try {
      const threat = detectRequestThreat(request);
      if (threat.blocked) {
        return jsonError(
          request,
          env,
          threat.code ?? 'REQUEST_BLOCKED',
          threat.message ?? 'Request blocked by security policy',
          403,
        );
      }

      if (pathname === '/telegram/webhook') {
        return handleTelegramUpdate(request, env);
      }

      if (pathname.startsWith('/api/')) {
        return downloadRouter(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error('Unhandled fetch error', error);
      return jsonError(request, env, 'INTERNAL_ERROR', 'Internal server error', 500, true);
    }
  },

  async queue(batch: MessageBatch<DownloadJob | JobHistoryEvent>, env: Env): Promise<void> {
    const queueName = String((batch as unknown as { queue?: string }).queue ?? '');
    const firstBody = batch.messages[0]?.body as Partial<JobHistoryEvent> | undefined;
    if (queueName.includes('history') || firstBody?.kind === 'history_event') {
      await processHistoryEventBatch(
        env,
        batch.messages.map((message) => message.body as JobHistoryEvent),
      );
      for (const message of batch.messages) message.ack();
      return;
    }

    for (const message of batch.messages) {
      const job = message.body as DownloadJob;
      const attempts = Number((message as unknown as { attempts?: number }).attempts ?? 1);

      const currentStatus = await getJobCurrentStatus(job.id, env);
      if (currentStatus === 'paused') {
        await enqueueHistoryEvent(env, {
          jobId: job.id,
          event: 'paused',
          status: 'paused',
          source: job.source,
          detail: 'Queue message acknowledged while job is paused',
        });
        message.ack();
        continue;
      }
      if (currentStatus === 'done' || currentStatus === 'failed') {
        message.ack();
        continue;
      }

      const control = await getWorkflowControlForJob(job.id, env);
      if (control === 'paused') {
        await recordTelemetry(env, {
          event: 'workflow_job_deferred',
          status: '200',
          source: job.source,
          code: 'WORKFLOW_PAUSED',
        });
        message.ack();
        continue;
      }
      if (control === 'cancelled') {
        await markFailed(job.id, env, attempts, 'WORKFLOW_CANCELLED', 'Cancelled by playlist supervisor', true);
        await recordTelemetry(env, {
          event: 'workflow_job_cancelled',
          status: '200',
          source: job.source,
          code: 'WORKFLOW_CANCELLED',
        });
        message.ack();
        continue;
      }

      try {
        await processDownloadJob(job, env, attempts);
        await recordTelemetry(env, {
          event: 'queue_processed',
          status: '200',
          source: job.source,
        });
        message.ack();
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        console.error(`Job ${job.id} failed at attempt ${attempts}`, error);

        if (attempts >= MAX_QUEUE_RETRIES) {
          await markFailed(job.id, env, attempts, 'QUEUE_JOB_FAILED', errorText, true);
          await recordTelemetry(env, {
            event: 'queue_failed',
            status: '500',
            code: 'QUEUE_JOB_FAILED',
            source: job.source,
          });
          message.ack();
        } else {
          const retryDelaySeconds = calculateQueueRetryDelayFromEnv(env, attempts);
          await markFailed(job.id, env, attempts, 'QUEUE_RETRY', errorText, false);
          await recordTelemetry(env, {
            event: 'queue_retry',
            status: '503',
            code: 'QUEUE_RETRY',
            source: job.source,
            value: retryDelaySeconds,
          });
          message.retry({ delaySeconds: retryDelaySeconds });
        }
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const startedAt = Date.now();
    const probeResults = await probeDownloaderOrigins(env);
    for (const probe of probeResults) {
      await recordTelemetry(env, {
        event: 'origin_probe',
        status: String(probe.status),
        origin: probe.origin,
        latency_ms: probe.latency_ms,
      });
    }

    // Warm path for free-tier origin services.
    try {
      await fetchDownloaderWithFailover(env, ORIGIN_WARMUP_PATH);
    } catch (error) {
      await recordTelemetry(env, {
        event: 'origin_probe',
        status: '0',
        code: `WARMUP_FAILED:${error instanceof Error ? error.message : String(error)}`,
      });
    }

    await runDownloaderSmokeChecks(env);

    await evaluateOpsAlerts(env);
    const cleanup = await cleanupStaleKvKeys(env);
    const retention = shouldRunRetentionCleanup(controller.cron)
      ? await cleanupExpiredJobsAndFiles(env)
      : null;
    await recordTelemetry(env, {
      event: 'scheduled_tick',
      status: '200',
      latency_ms: Date.now() - startedAt,
      code: [
        controller.cron,
        `kv_cleanup_scanned=${cleanup.scanned}`,
        `kv_cleanup_deleted=${cleanup.deleted}`,
        retention
          ? `retention_jobs=${retention.jobs_deleted};retention_r2=${retention.r2_keys_deleted}`
          : 'retention_skipped=cron',
      ].join(';'),
    });
  },
} satisfies ExportedHandler<Env, DownloadJob | JobHistoryEvent>;

async function getJobCurrentStatus(jobId: string, env: Env): Promise<JobStatus | null> {
  try {
    const row = await env.DB.prepare('SELECT status FROM download_jobs WHERE id = ? LIMIT 1')
      .bind(jobId)
      .first<{ status: JobStatus }>();
    return row?.status ?? null;
  } catch {
    return null;
  }
}

async function processDownloadJob(job: DownloadJob, env: Env, attempts: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE download_jobs
     SET status = 'processing', attempts = ?, error_code = NULL, error_message = NULL, finished_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(attempts, job.id).run();
  await enqueueHistoryEvent(env, {
    jobId: job.id,
    event: 'processing',
    status: 'processing',
    source: job.source,
  });

  let result: DownloaderDownloadResult | null = null;
  const internalAttemptErrors: string[] = [];
  for (const variant of buildInternalAttemptVariants(job)) {
    try {
      result = await downloadViaInternalService(job, env, variant);
      break;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      internalAttemptErrors.push(`${variant.source}/${variant.quality}: ${reason}`);
    }
  }

  if (!result) {
    console.error('Internal downloader failed. Falling back to Invidious.');
    try {
      result = await downloadViaInvidious(job, env);
    } catch (fallbackError) {
      const fallbackErrorText = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`internal=${internalAttemptErrors.join(' || ')}; fallback=${fallbackErrorText}`);
    }
  }

  let contentHash: string | null = null;
  let r2Key: string | null = null;
  const normalizedDownloadUrl = normalizeDownloaderUrl(result.download_url, env);

  if (env.FILES) {
    const streamHeaders = buildDownloaderHeaders(normalizedDownloadUrl, env);
    const streamResponse = await fetch(normalizedDownloadUrl, streamHeaders ? { headers: streamHeaders } : undefined);

    if (!streamResponse.ok || !streamResponse.body) {
      const details = await streamResponse.text();
      throw new Error(`Unable to fetch converted file (${streamResponse.status}): ${details}`);
    }

    const fileBuffer = await streamResponse.arrayBuffer();
    contentHash = await sha256HexBytes(fileBuffer);
    r2Key = `objects/${contentHash}.${job.format}`;

    const existing = await env.FILES.head(r2Key);
    if (!existing) {
      await env.FILES.put(r2Key, fileBuffer, {
        httpMetadata: {
          contentType: result.mime_type ?? streamResponse.headers.get('content-type') ?? 'application/octet-stream',
          contentDisposition: `attachment; filename="${result.filename ?? `${job.id}.${job.format}`}"`,
        },
      });
    }
  }

  await env.DB.prepare(
    `UPDATE download_jobs
     SET status = 'done',
         source = ?,
         result_url = ?,
         r2_key = ?,
         content_hash = ?,
         title = ?,
         artist = ?,
         duration = ?,
         file_size = ?,
         updated_at = CURRENT_TIMESTAMP,
         finished_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(
    result.source ?? job.source,
    normalizedDownloadUrl,
    r2Key,
    contentHash,
    result.title,
    result.artist,
    result.duration,
    result.file_size,
    job.id,
  ).run();
  await enqueueHistoryEvent(env, {
    jobId: job.id,
    event: 'done',
    status: 'done',
    source: result.source ?? job.source,
  });

  if (job.chatId && job.messageId) {
    await notifyTelegramComplete(job, result, env);
  }
  try {
    await publishTelegramChannelDownload(job, result, env);
  } catch (error) {
    console.warn('Telegram channel publish skipped', error);
  }
}

function buildInternalAttemptVariants(
  job: DownloadJob,
): Array<{ source: string; quality: DownloadJob['quality'] }> {
  const sourceCandidates = new Set<string>([job.source]);
  if (job.source !== 'youtube') {
    sourceCandidates.add('youtube');
  }
  if (job.source === 'unknown' || job.source === 'all') {
    sourceCandidates.add('youtube');
  }

  const qualityCandidates = new Set<DownloadJob['quality']>([job.quality]);
  if (job.quality !== 'best') qualityCandidates.add('best');
  if (job.format === 'flac' || job.format === 'wav') {
    qualityCandidates.add('lossless');
  }

  const variants: Array<{ source: string; quality: DownloadJob['quality'] }> = [];
  for (const source of sourceCandidates) {
    for (const quality of qualityCandidates) {
      variants.push({ source, quality });
    }
  }
  return variants;
}

async function markFailed(
  jobId: string,
  env: Env,
  attempts: number,
  errorCode: string,
  errorMessage: string,
  terminal: boolean,
): Promise<void> {
  const status = terminal ? 'failed' : 'queued';
  const finishedAtExpr = terminal ? 'CURRENT_TIMESTAMP' : 'NULL';

  await env.DB.prepare(
    `UPDATE download_jobs
     SET status = ?,
         attempts = ?,
         error_code = ?,
         error_message = ?,
         updated_at = CURRENT_TIMESTAMP,
         finished_at = ${finishedAtExpr}
     WHERE id = ?`,
  ).bind(status, attempts, errorCode, errorMessage.slice(0, 2000), jobId).run();
  await enqueueHistoryEvent(env, {
    jobId,
    event: terminal ? 'failed' : 'queued',
    status,
    detail: `${errorCode}: ${errorMessage}`.slice(0, 1000),
  });

  if (!terminal) {
    return;
  }

  const row = await env.DB.prepare(
    `SELECT id, chat_id, message_id, url, source, format, quality, fingerprint, created_at
     FROM download_jobs WHERE id = ?`,
  ).bind(jobId).first<{
    id: string;
    chat_id: number | null;
    message_id: number | null;
    url: string;
    source: string;
    format: DownloadJob['format'];
    quality: DownloadJob['quality'];
    fingerprint: string;
    created_at: string;
  }>();

  try {
    await recordDeadLetterJob(env, {
      jobId,
      source: row?.source ?? null,
      format: row?.format ?? null,
      quality: row?.quality ?? null,
      attempts,
      errorCode,
      errorMessage,
    });
  } catch (error) {
    console.warn(`Dead-letter audit insert skipped for job ${jobId}`, error);
  }

  if (row?.chat_id && row.message_id) {
    const originalUrl = await resolvePrivateUrl(env, 'job', row.id, row.url);
    await notifyTelegramFailure(
      {
        id: row.id,
        url: originalUrl ?? '',
        source: row.source,
        format: row.format,
        quality: row.quality,
        fingerprint: row.fingerprint,
        chatId: row.chat_id,
        messageId: row.message_id,
        requestedAt: row.created_at,
      },
      errorMessage,
      env,
    );
  }
}

async function recordDeadLetterJob(
  env: Env,
  input: {
    jobId: string;
    source: string | null;
    format: string | null;
    quality: string | null;
    attempts: number;
    errorCode: string;
    errorMessage: string;
  },
): Promise<void> {
  await ensureDeadLetterSchema(env);
  await env.DB.prepare(
    `INSERT INTO dead_letter_jobs (
       job_id, source, format, quality, attempts, error_code, error_message, queue_name
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.jobId,
    input.source,
    input.format,
    input.quality,
    input.attempts,
    input.errorCode,
    input.errorMessage.slice(0, 2000),
    'sounddrop-downloads',
  ).run();
}

async function downloadViaInternalService(
  job: DownloadJob,
  env: Env,
  variant?: { source?: string; quality?: DownloadJob['quality'] },
): Promise<DownloaderDownloadResult> {
  const source = variant?.source ?? job.source;
  const quality = variant?.quality ?? job.quality;
  const startedAt = Date.now();
  const failover = await fetchDownloaderWithFailover(env, '/internal/download', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': env.DOWNLOADER_API_KEY,
    },
    body: JSON.stringify({
      job_id: job.id,
      url: job.url,
      source,
      format: job.format,
      quality,
      parent_job_id: job.parentJobId,
      variant_role: job.variantRole ?? 'primary',
      sync_key: job.syncKey,
      playlist_folder: job.playlistFolder,
      playlist_index: job.playlistIndex,
      local_relpath: job.localRelpath,
    }),
  });
  const response = failover.response;

  await recordTelemetry(env, {
    event: 'downloader_internal_download',
    status: String(response.status),
    origin: failover.origin.baseUrl,
    source,
    latency_ms: Date.now() - startedAt,
    code: failover.switched ? `FAILOVER_SWITCHED:${quality}` : `PRIMARY_OK:${quality}`,
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Downloader API failed (${response.status}): ${details}`);
  }

  const result = await response.json<DownloaderDownloadResult>();
  if (!result.download_url) {
    throw new Error('Downloader API did not return download_url');
  }

  return result;
}

async function runDownloaderSmokeChecks(env: Env): Promise<void> {
  const smokeSource = [
    { source: 'youtube', url: (env.SMOKE_TEST_YOUTUBE_URL ?? SMOKE_DEFAULT_YOUTUBE_URL).trim() },
    { source: 'spotify', url: (env.SMOKE_TEST_SPOTIFY_URL ?? SMOKE_DEFAULT_SPOTIFY_URL).trim() },
  ];
  const format = (env.SMOKE_TEST_FORMAT ?? 'mp3').trim();
  const quality = (env.SMOKE_TEST_QUALITY ?? 'best').trim();

  for (const smoke of smokeSource) {
    if (!smoke.url) continue;
    try {
      const startedAt = Date.now();
      const failover = await fetchDownloaderWithFailover(env, '/internal/smoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': env.DOWNLOADER_API_KEY,
        },
        body: JSON.stringify({
          url: smoke.url,
          source: smoke.source,
          format,
          quality,
        }),
      });
      let code = 'SMOKE_OK';
      if (!failover.response.ok) {
        const details = await failover.response.text();
        code = `SMOKE_FAILED:${details.slice(0, 160)}`;
      }

      await recordSmokeProbeResult(
        env,
        smoke.source,
        failover.response.status,
        code,
        {
          origin: failover.origin.baseUrl,
          latency_ms: Date.now() - startedAt,
        },
      );
    } catch (error) {
      await recordSmokeProbeResult(
        env,
        smoke.source,
        0,
        `SMOKE_FAILED:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function getWorkflowControlForJob(
  jobId: string,
  env: Env,
): Promise<'active' | 'paused' | 'cancelled'> {
  try {
    await ensurePlaylistWorkflowSchema(env);
    const row = await env.DB.prepare(
      `SELECT COALESCE(w.control_state, 'active') AS control_state
       FROM playlist_workflow_jobs wj
       JOIN playlist_workflows w ON w.workflow_id = wj.workflow_id
       WHERE wj.job_id = ?
       ORDER BY
         CASE LOWER(COALESCE(w.control_state, 'active'))
           WHEN 'cancelled' THEN 0
           WHEN 'paused' THEN 1
           ELSE 2
         END
       LIMIT 1`,
    ).bind(jobId).first<{ control_state: string | null }>();
    const normalized = String(row?.control_state ?? 'active').trim().toLowerCase();
    if (normalized === 'cancelled') return 'cancelled';
    if (normalized === 'paused') return 'paused';
  } catch {
    // Ignore control checks when table isn't available.
  }
  return 'active';
}

async function downloadViaInvidious(job: DownloadJob, env: Env): Promise<DownloaderDownloadResult> {
  const videoUrl = await resolveToYouTubeUrl(job.url, env);
  const videoId = extractYouTubeVideoId(videoUrl);
  if (!videoId) {
    throw new Error('Unable to resolve a playable YouTube video');
  }

  for (const base of getInvidiousBaseUrls(env)) {
    try {
      const response = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`);
      if (!response.ok) {
        const details = await response.text();
        console.warn(`Invidious video endpoint ${base} failed (${response.status}): ${details.slice(0, 240)}`);
        continue;
      }

      const raw = await response.text();
      const payload = JSON.parse(raw) as {
        title?: string;
        author?: string;
        lengthSeconds?: number;
        adaptiveFormats?: Array<{
          url?: string;
          type?: string;
          bitrate?: string;
          clen?: string;
        }>;
      };

      const audioCandidates = (payload.adaptiveFormats ?? [])
        .filter((entry) => typeof entry.url === 'string' && typeof entry.type === 'string' && entry.type.includes('audio/'))
        .map((entry) => ({
          url: entry.url as string,
          type: entry.type as string,
          bitrate: Number(entry.bitrate ?? 0),
          size: Number(entry.clen ?? 0),
        }))
        .sort((a, b) => b.bitrate - a.bitrate);

      const bestAudio = audioCandidates[0];
      if (!bestAudio) {
        console.warn(`Invidious ${base} returned no playable audio streams`);
        continue;
      }

      const mimeType = bestAudio.type.split(';')[0]?.trim() || 'application/octet-stream';
      const extension = mimeTypeToExtension(mimeType);
      const proxyUrl = buildInvidiousProxyAudioUrl(base, videoId, bestAudio.url);

      return {
        download_url: proxyUrl,
        title: payload.title ?? videoId,
        artist: payload.author ?? 'Unknown artist',
        duration: Number(payload.lengthSeconds ?? 0),
        file_size: Number.isFinite(bestAudio.size) ? bestAudio.size : 0,
        source: 'youtube',
        resolved_url: videoUrl,
        fallback_used: true,
        mime_type: mimeType,
        filename: `${videoId}.${extension}`,
      };
    } catch (error) {
      console.warn(`Invidious parser failed on ${base}`, error);
    }
  }

  throw new Error('All Invidious fallback instances failed for this video');
}

async function resolveToYouTubeUrl(inputUrl: string, env: Env): Promise<string> {
  const directVideoId = extractYouTubeVideoId(inputUrl);
  if (directVideoId) {
    return `https://www.youtube.com/watch?v=${directVideoId}`;
  }

  const metadataTitle = await extractBestSearchHint(inputUrl);
  const query = metadataTitle || inputUrl;
  for (const base of getInvidiousBaseUrls(env)) {
    try {
      const searchUrl = new URL(`${base}/api/v1/search`);
      searchUrl.searchParams.set('q', query);
      searchUrl.searchParams.set('type', 'video');
      searchUrl.searchParams.set('sort', 'relevance');
      searchUrl.searchParams.set('page', '1');

      const response = await fetch(searchUrl.toString());
      if (!response.ok) {
        continue;
      }

      const raw = await response.text();
      const rows = JSON.parse(raw) as Array<{ type?: string; videoId?: string }>;
      const firstVideo = rows.find((row) => row.type === 'video' && typeof row.videoId === 'string' && row.videoId.length > 0);
      if (firstVideo?.videoId) {
        return `https://www.youtube.com/watch?v=${firstVideo.videoId}`;
      }
    } catch {
      // try next instance
    }
  }

  throw new Error('No fallback YouTube mirror found for input URL');
}

async function extractBestSearchHint(targetUrl: string): Promise<string | null> {
  const oembedTitle = await extractOEmbedTitle(targetUrl);
  if (oembedTitle) return oembedTitle;
  return extractOgTitle(targetUrl);
}

async function extractOEmbedTitle(targetUrl: string): Promise<string | null> {
  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return null;
  }

  const host = parsedTarget.hostname.toLowerCase();
  const providers: string[] = [];
  if (host.includes('spotify.com') || host.endsWith('spotify.link')) {
    providers.push(`https://open.spotify.com/oembed?url=${encodeURIComponent(targetUrl)}`);
  }
  if (host.includes('soundcloud.com')) {
    providers.push(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(targetUrl)}`);
  }

  for (const providerUrl of providers) {
    try {
      const response = await fetch(providerUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DyrakArmy/8.0; +https://dyrakarmy.online)',
        },
      });
      if (!response.ok) continue;
      const payload = await response.json() as { title?: string };
      const title = String(payload.title ?? '').trim();
      if (title) return title.slice(0, 240);
    } catch {
      // try next provider
    }
  }

  return null;
}

async function extractOgTitle(targetUrl: string): Promise<string | null> {
  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DyrakArmy/7.0; +https://dyrakarmy.online)',
      },
    });
    if (!response.ok) return null;

    const html = await response.text();
    const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (!ogMatch?.[1]) return null;

    return decodeHtmlEntities(ogMatch[1]).trim();
  } catch {
    return null;
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractYouTubeVideoId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id ? id.slice(0, 11) : null;
    }

    if (host.endsWith('youtube.com')) {
      const fromQuery = url.searchParams.get('v');
      if (fromQuery) return fromQuery.slice(0, 11);

      const parts = url.pathname.split('/').filter(Boolean);
      const shortsIndex = parts.findIndex((part) => part === 'shorts' || part === 'embed');
      if (shortsIndex >= 0 && parts[shortsIndex + 1]) {
        return parts[shortsIndex + 1]!.slice(0, 11);
      }
    }
  } catch {
    return null;
  }

  return null;
}

function mimeTypeToExtension(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mpeg')) return 'mp3';
  return 'bin';
}

function extractItagFromStreamUrl(streamUrl: string): string | null {
  try {
    const parsed = new URL(streamUrl);
    const fromQuery = parsed.searchParams.get('itag');
    if (fromQuery) return fromQuery;
    const match = streamUrl.match(/[?&]itag=(\d+)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function buildInvidiousProxyAudioUrl(base: string, videoId: string, streamUrl: string): string {
  const itag = extractItagFromStreamUrl(streamUrl);
  if (!itag) return streamUrl;
  const url = new URL(`${base}/latest_version`);
  url.searchParams.set('id', videoId);
  url.searchParams.set('itag', itag);
  url.searchParams.set('local', 'true');
  return url.toString();
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
