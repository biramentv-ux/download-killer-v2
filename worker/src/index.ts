/**
 * DyrakArmy Worker
 * Public API + queue consumer + Telegram webhook
 */

import { downloadRouter, getDownloadWebhookForSyncKey, isPrivacyModeEnabledForSyncKey } from './api';
import { enqueueHistoryEvent, processHistoryEventBatch } from './history';
import { ensureDeadLetterSchema, ensurePlaylistWorkflowSchema } from './schema';
import {
  backfillTelegramChannelPublishes,
  handleTelegramUpdate,
  notifyTelegramComplete,
  notifyTelegramFailure,
  publishTelegramChannelDownload,
} from './telegram';
import type { DownloadJob, DownloaderDownloadResult, Env, JobHistoryEvent, JobStatus } from './types';
import { createDownloadToken, detectRequestThreat, jsonError, optionsResponse, readEnvInt, sha256Hex, sha256HexBytes } from './utils';
import {
  buildDownloaderHeaders,
  fetchDownloaderWithFailover,
  normalizeDownloaderUrl,
  probeDownloaderOrigins,
} from './origins';
import { evaluateOpsAlerts, recordSmokeProbeResult, recordTelemetry } from './telemetry';
import { cleanupStaleKvKeys, hmacSha256Hex, resolvePrivateUrl } from './security';
import { calculateQueueRetryDelayFromEnv } from './retry';
import { cleanupExpiredJobsAndFiles, shouldRunRetentionCleanup } from './retention';
import { runReleaseRadarChecks } from './releaseRadar';
import { runSchedulerCron } from './scheduler';
import { classifySourceError, recordSourceAttempt } from './sourceHealth';

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

function getPublicBaseUrl(env: Env): string {
  return String(env.PUBLIC_BASE_URL ?? 'https://dyrakarmy.online').trim().replace(/\/+$/g, '') || 'https://dyrakarmy.online';
}

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

      if (pathname.startsWith('/share/')) {
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
    const scheduler = await runSchedulerCron(env).catch((error) => {
      console.warn('Scheduled downloads cron failed', error);
      return { due: 0, triggered: 0, failed: 1 };
    });
    const releaseRadar = await runReleaseRadarChecks(env).catch((error) => {
      console.warn('Release Radar scheduled check failed', error);
      return { checked: 0, notified: 0 };
    });
    const telegramBackfillPublished = await backfillTelegramChannelPublishes(env);

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
        `release_radar_checked=${releaseRadar.checked}`,
        `release_radar_notified=${releaseRadar.notified}`,
        `scheduler_due=${scheduler.due}`,
        `scheduler_triggered=${scheduler.triggered}`,
        `scheduler_failed=${scheduler.failed}`,
        `telegram_channel_backfill=${telegramBackfillPublished}`,
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
          audio_normalized = ?,
          normalization_mode = ?,
          normalization_target_lufs = ?,
          audio_analysis = ?,
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
    result.audio_normalized ? 1 : 0,
    result.normalization_mode ?? job.normalizationMode ?? 'off',
    result.normalization_target_lufs ?? job.normalizationTargetLufs ?? null,
    result.audio_analysis ? JSON.stringify(result.audio_analysis) : null,
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
  await notifyDownloadWebhook(job, result, env, {
    r2Key,
    contentHash,
  });

  await applyPrivacyModeAfterSuccess(job, result, env, {
    normalizedDownloadUrl,
    r2Key,
    contentHash,
  });
}

async function notifyDownloadWebhook(
  job: DownloadJob,
  result: DownloaderDownloadResult,
  env: Env,
  snapshot: {
    r2Key: string | null;
    contentHash: string | null;
  },
): Promise<void> {
  if (!job.syncKey) return;
  const config = await getDownloadWebhookForSyncKey(env, job.syncKey);
  if (!config.enabled || !config.url) return;

  const ttl = readEnvInt(env.DOWNLOAD_TOKEN_TTL_SECONDS, 3600);
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const token = await createDownloadToken(
    {
      jobId: job.id,
      exp: expiresAt,
    },
    env.DOWNLOAD_TOKEN_SECRET,
  );
  const base = getPublicBaseUrl(env);
  const downloadUrl = `${base}/api/file/${encodeURIComponent(token)}`;
  const streamUrl = `${downloadUrl}?inline=1`;
  const deliveryId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const payload = {
    event: 'download.done',
    delivery_id: deliveryId,
    timestamp,
    job: {
      id: job.id,
      status: 'done',
      source: result.source ?? job.source,
      format: job.format,
      quality: job.quality,
      title: result.title ?? null,
      artist: result.artist ?? null,
      duration: result.duration ?? null,
      file_size: result.file_size ?? null,
      audio_normalized: Boolean(result.audio_normalized),
      normalization_mode: result.normalization_mode ?? job.normalizationMode ?? 'off',
      normalization_target_lufs: result.normalization_target_lufs ?? job.normalizationTargetLufs ?? null,
      content_hash: snapshot.contentHash,
      r2_cached: Boolean(snapshot.r2Key),
      requested_at: job.requestedAt,
      finished_at: timestamp,
    },
    download: {
      url: downloadUrl,
      stream_url: streamUrl,
      expires_at: new Date(expiresAt * 1000).toISOString(),
    },
    sync: {
      key_hash: await sha256Hex(job.syncKey),
    },
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'DyrakArmy-Webhook/1.0',
    'x-dyrakarmy-event': 'download.done',
    'x-dyrakarmy-delivery': deliveryId,
    'x-dyrakarmy-timestamp': String(Math.floor(Date.now() / 1000)),
  };
  const signatureSecret = String(env.DOWNLOAD_WEBHOOK_HMAC_SECRET ?? env.WEBHOOK_HMAC_SECRET ?? '').trim();
  if (signatureSecret) {
    headers['x-dyrakarmy-signature'] = `sha256=${await hmacSha256Hex(signatureSecret, `${headers['x-dyrakarmy-timestamp']}.${body}`)}`;
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(15000, readEnvInt(env.DOWNLOAD_WEBHOOK_TIMEOUT_MS, 5000)));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    await recordTelemetry(env, {
      event: 'download_webhook_sent',
      status: String(response.status),
      source: result.source ?? job.source,
      code: response.ok ? 'WEBHOOK_OK' : 'WEBHOOK_HTTP_ERROR',
      value: response.ok ? 1 : 0,
    });
    if (!response.ok) {
      console.warn(`Download webhook failed for ${job.id}: ${response.status}`);
    }
  } catch (error) {
    console.warn('Download webhook skipped', error);
    await recordTelemetry(env, {
      event: 'download_webhook_sent',
      status: '0',
      source: result.source ?? job.source,
      code: 'WEBHOOK_DELIVERY_FAILED',
      value: 0,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function applyPrivacyModeAfterSuccess(
  job: DownloadJob,
  result: DownloaderDownloadResult,
  env: Env,
  snapshot: {
    normalizedDownloadUrl: string | null;
    r2Key: string | null;
    contentHash: string | null;
  },
): Promise<void> {
  if (!job.syncKey) return;
  const enabled = await isPrivacyModeEnabledForSyncKey(env, job.syncKey);
  if (!enabled) return;

  const ttl = Math.max(3600, readEnvInt(env.DOWNLOAD_TOKEN_TTL_SECONDS, 3600));
  const now = new Date().toISOString();
  await env.CACHE.put(`privacy-job:${job.id}`, JSON.stringify({
    id: job.id,
    source: result.source ?? job.source,
    format: job.format,
    quality: job.quality,
    status: 'done',
    attempts: 1,
    parent_job_id: null,
    variant_role: 'primary',
    sync_key: job.syncKey,
    playlist_folder: null,
    playlist_index: null,
    local_relpath: null,
    result_url: snapshot.normalizedDownloadUrl,
    r2_key: snapshot.r2Key,
    title: result.title ?? null,
    artist: result.artist ?? null,
    duration: result.duration ?? null,
    file_size: result.file_size ?? null,
    audio_normalized: result.audio_normalized ? 1 : 0,
    normalization_mode: result.normalization_mode ?? job.normalizationMode ?? 'off',
    normalization_target_lufs: result.normalization_target_lufs ?? job.normalizationTargetLufs ?? null,
    audio_analysis: result.audio_analysis ? JSON.stringify(result.audio_analysis) : null,
    fingerprint: job.fingerprint,
    content_hash: snapshot.contentHash,
    created_at: job.requestedAt,
    updated_at: now,
    finished_at: now,
  }), { expirationTtl: ttl });

  await env.DB.prepare('DELETE FROM job_history_events WHERE job_id = ?').bind(job.id).run().catch(() => undefined);
  await env.DB.prepare('DELETE FROM playlist_workflow_jobs WHERE job_id = ?').bind(job.id).run().catch(() => undefined);
  await env.DB.prepare('DELETE FROM shared_queue_items WHERE job_id = ?').bind(job.id).run().catch(() => undefined);
  await env.DB.prepare('DELETE FROM telegram_channel_publishes WHERE job_id = ?').bind(job.id).run().catch(() => undefined);
  await env.DB.prepare('DELETE FROM download_jobs WHERE id = ?').bind(job.id).run();
  await recordTelemetry(env, {
    event: 'privacy_job_deleted',
    status: '200',
    source: result.source ?? job.source,
    code: 'PRIVACY_MODE',
  });
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
        normalize_audio: job.normalizeAudio ?? false,
        normalization_mode: job.normalizationMode ?? 'off',
        normalization_target_lufs: job.normalizationTargetLufs ?? null,
      }),
    }).catch((error) => {
      const classified = classifyDownloaderOriginError(error, source);
      recordSourceAttempt({
        source,
        success: false,
        responseMs: Date.now() - startedAt,
        error: classified.message,
        errorType: classifySourceError(classified.message),
      }, env);
      throw classified;
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
    recordSourceAttempt({
      source,
      success: false,
      responseMs: Date.now() - startedAt,
      error: `Downloader API failed (${response.status}): ${details}`,
      errorType: classifySourceError(details),
    }, env);
    throw new Error(`Downloader API failed (${response.status}): ${details}`);
  }

  const result = await response.json<DownloaderDownloadResult>();
  if (!result.download_url) {
    recordSourceAttempt({
      source,
      success: false,
      responseMs: Date.now() - startedAt,
      error: 'Downloader API did not return download_url',
      errorType: 'invalid_response',
    }, env);
    throw new Error('Downloader API did not return download_url');
  }

  recordSourceAttempt({
    source,
    success: true,
    responseMs: Date.now() - startedAt,
  }, env);

  return result;
}

function classifyDownloaderOriginError(error: unknown, source: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const isYoutube = source === 'youtube' || normalized.includes('[youtube]') || normalized.includes('youtube/');
  const genericRender502 = normalized.includes('status=502') || normalized.includes('error code: 502');
  if (isYoutube && genericRender502 && !normalized.includes('not a bot') && !normalized.includes('sign in to confirm')) {
    return new Error(
      `${message}; YOUTUBE_ORIGIN_BOT_GATED: Render origin is blocked by YouTube bot-check.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
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
