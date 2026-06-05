import type { AudioFormat, AudioQuality, DownloadJob, Env } from './types';
import {
  createJobFingerprint,
  detectSourceFromUrl,
  getClientAddress,
  isValidUrl,
  jsonError,
  jsonOk,
  normalizeSource,
  parseJson,
  rateLimit,
  readEnvInt,
  sha256Hex,
  validateDownloadUrlPolicy,
} from './utils';
import { hashAndCachePrivateUrl, resolvePrivateUrl } from './security';
import { enqueueHistoryEvent } from './history';
import { recordTelemetry } from './telemetry';
import { ensureDownloadJobMetadataSchema } from './schema';

export type Recurrence = 'daily' | 'weekly' | 'monthly' | null;
type ScheduleStatus = 'pending' | 'triggered' | 'cancelled' | 'done';

interface ScheduledDownload {
  id: string;
  url: string;
  title: string | null;
  artist: string | null;
  thumbnail: string | null;
  source: string;
  format: AudioFormat;
  quality: AudioQuality;
  sync_key: string;
  scheduled_at: string;
  recurrence: Recurrence;
  wifi_only: number;
  status: ScheduleStatus;
  last_triggered: string | null;
  next_run: string | null;
  job_id: string | null;
  created_at: string;
  updated_at: string;
}

interface CreateScheduleBody {
  url?: string;
  title?: string;
  artist?: string;
  thumbnail?: string;
  source?: string;
  format?: string;
  quality?: string;
  syncKey?: string;
  sync_key?: string;
  scheduledAt?: string;
  scheduled_at?: string;
  recurrence?: Recurrence;
  wifiOnly?: boolean;
  wifi_only?: boolean;
}

interface UpdateScheduleBody {
  syncKey?: string;
  sync_key?: string;
  scheduledAt?: string;
  scheduled_at?: string;
  recurrence?: Recurrence;
  wifiOnly?: boolean;
  wifi_only?: boolean;
}

const SCHEDULER_LOCK_KEY = 'scheduler:lock';
const FORMATS: AudioFormat[] = ['mp3', 'flac', 'ogg', 'm4a', 'opus', 'wav'];
const QUALITIES: AudioQuality[] = ['320', '256', '192', '128', '96', 'best', 'lossless'];

export async function handleCreateSchedule(request: Request, env: Env): Promise<Response> {
  await ensureDownloadJobMetadataSchema(env);
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `schedule-create:${ip}`, 20, 60);
  if (rl.limited) return jsonError(request, env, 'RATE_LIMITED', 'Too many schedule requests', 429, true);

  const body = await parseJson<CreateScheduleBody>(request);
  const url = String(body?.url ?? '').trim();
  const syncKey = normalizeSyncKey(body?.syncKey ?? body?.sync_key);
  const scheduledAtRaw = String(body?.scheduledAt ?? body?.scheduled_at ?? '').trim();
  if (!url || !syncKey || !scheduledAtRaw) {
    return jsonError(request, env, 'INVALID_SCHEDULE', 'url, syncKey and scheduledAt are required', 400);
  }
  if (!isValidUrl(url)) return jsonError(request, env, 'INVALID_URL', 'URL must be HTTP or HTTPS', 400);
  const policy = validateDownloadUrlPolicy(url, env);
  if (!policy.allowed) {
    return jsonError(request, env, policy.code ?? 'URL_BLOCKED', policy.message ?? 'URL is blocked', 400);
  }

  const scheduledAt = new Date(scheduledAtRaw);
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
    return jsonError(request, env, 'INVALID_SCHEDULE_TIME', 'scheduledAt must be a future ISO8601 datetime', 400);
  }

  const recurrence = normalizeRecurrence(body?.recurrence ?? null);
  const source = normalizeSource(body?.source ?? detectSourceFromUrl(url));
  const format = normalizeFormat(body?.format);
  const quality = normalizeQuality(body?.quality, format);
  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO scheduled_downloads (
       id, url, title, artist, thumbnail, source, format, quality, sync_key,
       scheduled_at, recurrence, wifi_only, status, next_run, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(
    id,
    await hashAndCachePrivateUrl(env, 'schedule', id, url),
    normalizeOptionalText(body?.title, 240),
    normalizeOptionalText(body?.artist, 240),
    normalizeOptionalText(body?.thumbnail, 1000),
    source,
    format,
    quality,
    syncKey,
    scheduledAt.toISOString(),
    recurrence,
    body?.wifiOnly || body?.wifi_only ? 1 : 0,
    scheduledAt.toISOString(),
  ).run();

  await recordTelemetry(env, { event: 'scheduled_download_created', status: '201', source });
  return jsonOk(request, env, {
    schedule_id: id,
    scheduled_at: scheduledAt.toISOString(),
    recurrence,
    wifi_only: Boolean(body?.wifiOnly || body?.wifi_only),
    source,
    format,
    quality,
  }, 201);
}

export async function handleListSchedules(request: Request, env: Env): Promise<Response> {
  await ensureDownloadJobMetadataSchema(env);
  const url = new URL(request.url);
  const syncKey = normalizeSyncKey(url.searchParams.get('syncKey') ?? url.searchParams.get('sync_key'));
  const status = String(url.searchParams.get('status') ?? 'pending').toLowerCase();
  if (!syncKey) return jsonError(request, env, 'INVALID_SYNC_KEY', 'syncKey is required', 400);

  const query = status === 'all'
    ? `SELECT * FROM scheduled_downloads WHERE sync_key = ? ORDER BY next_run ASC, created_at DESC LIMIT 200`
    : `SELECT * FROM scheduled_downloads WHERE sync_key = ? AND status = ? ORDER BY next_run ASC, created_at DESC LIMIT 200`;
  const { results } = status === 'all'
    ? await env.DB.prepare(query).bind(syncKey).all<ScheduledDownload>()
    : await env.DB.prepare(query).bind(syncKey, status).all<ScheduledDownload>();

  return jsonOk(request, env, {
    schedules: results.map(sanitizeSchedule),
    total: results.length,
  });
}

export async function handleUpdateSchedule(request: Request, env: Env, id: string): Promise<Response> {
  await ensureDownloadJobMetadataSchema(env);
  const body = await parseJson<UpdateScheduleBody>(request);
  const url = new URL(request.url);
  const syncKey = normalizeSyncKey(body?.syncKey ?? body?.sync_key ?? url.searchParams.get('syncKey') ?? url.searchParams.get('sync_key'));
  if (!syncKey) return jsonError(request, env, 'INVALID_SYNC_KEY', 'syncKey is required', 400);

  const updates: string[] = [];
  const binds: Array<string | number | null> = [];
  const scheduledAtRaw = body?.scheduledAt ?? body?.scheduled_at;
  if (scheduledAtRaw) {
    const d = new Date(scheduledAtRaw);
    if (!Number.isFinite(d.getTime()) || d.getTime() <= Date.now()) {
      return jsonError(request, env, 'INVALID_SCHEDULE_TIME', 'scheduledAt must be a future ISO8601 datetime', 400);
    }
    updates.push('scheduled_at = ?', 'next_run = ?', "status = 'pending'");
    binds.push(d.toISOString(), d.toISOString());
  }
  if (body?.recurrence !== undefined) {
    updates.push('recurrence = ?');
    binds.push(normalizeRecurrence(body.recurrence));
  }
  if (body?.wifiOnly !== undefined || body?.wifi_only !== undefined) {
    updates.push('wifi_only = ?');
    binds.push(body.wifiOnly || body.wifi_only ? 1 : 0);
  }
  if (!updates.length) return jsonError(request, env, 'NO_UPDATES', 'Nothing to update', 400);

  binds.push(id, syncKey);
  const result = await env.DB.prepare(
    `UPDATE scheduled_downloads
     SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND sync_key = ?`,
  ).bind(...binds).run();
  if ((result.meta as { changes?: number } | undefined)?.changes === 0) {
    return jsonError(request, env, 'SCHEDULE_NOT_FOUND', 'Schedule not found', 404);
  }
  return jsonOk(request, env, { ok: true, schedule_id: id });
}

export async function handleCancelSchedule(request: Request, env: Env, id: string): Promise<Response> {
  await ensureDownloadJobMetadataSchema(env);
  const url = new URL(request.url);
  const syncKey = normalizeSyncKey(url.searchParams.get('syncKey') ?? url.searchParams.get('sync_key'));
  if (!syncKey) return jsonError(request, env, 'INVALID_SYNC_KEY', 'syncKey is required', 400);
  const result = await env.DB.prepare(
    `UPDATE scheduled_downloads
     SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND sync_key = ?`,
  ).bind(id, syncKey).run();
  if ((result.meta as { changes?: number } | undefined)?.changes === 0) {
    return jsonError(request, env, 'SCHEDULE_NOT_FOUND', 'Schedule not found', 404);
  }
  return jsonOk(request, env, { ok: true, cancelled: id });
}

export async function runSchedulerCron(env: Env): Promise<{ due: number; triggered: number; failed: number }> {
  await ensureDownloadJobMetadataSchema(env);
  const lock = await env.CACHE.get(SCHEDULER_LOCK_KEY);
  if (lock) return { due: 0, triggered: 0, failed: 0 };
  await env.CACHE.put(SCHEDULER_LOCK_KEY, '1', { expirationTtl: 30 });

  try {
    const now = new Date().toISOString();
    const limit = Math.max(1, Math.min(100, readEnvInt(env.SCHEDULER_MAX_DUE_PER_TICK, 50)));
    const { results: due } = await env.DB.prepare(
      `SELECT * FROM scheduled_downloads
       WHERE status = 'pending' AND next_run <= ?
       ORDER BY next_run ASC
       LIMIT ?`,
    ).bind(now, limit).all<ScheduledDownload>();

    let triggered = 0;
    let failed = 0;
    for (const schedule of due) {
      try {
        await triggerScheduledDownload(env, schedule);
        triggered += 1;
      } catch (error) {
        failed += 1;
        await recordTelemetry(env, {
          event: 'scheduled_download_failed',
          status: '500',
          source: schedule.source,
          code: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
        });
      }
    }
    return { due: due.length, triggered, failed };
  } finally {
    await env.CACHE.delete(SCHEDULER_LOCK_KEY).catch(() => undefined);
  }
}

async function triggerScheduledDownload(env: Env, schedule: ScheduledDownload): Promise<void> {
  const originalUrl = await readScheduledOriginalUrl(env, schedule);
  const jobId = crypto.randomUUID();
  const format = normalizeFormat(schedule.format);
  const quality = normalizeQuality(schedule.quality, format);
  const source = normalizeSource(schedule.source || detectSourceFromUrl(originalUrl));
  const fingerprint = await createJobFingerprint(originalUrl, format, quality);
  const urlHash = await hashAndCachePrivateUrl(env, 'job', jobId, originalUrl);
  const requestedAt = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO download_jobs (
       id, url, source, format, quality, status, attempts, fingerprint,
       sync_key, title, artist, thumbnail_url, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(
    jobId,
    urlHash,
    source,
    format,
    quality,
    fingerprint,
    schedule.sync_key,
    schedule.title,
    schedule.artist,
    schedule.thumbnail,
  ).run();

  const job: DownloadJob = {
    id: jobId,
    url: originalUrl,
    source,
    format,
    quality,
    fingerprint,
    syncKey: schedule.sync_key,
    requestedAt,
  };
  await env.DOWNLOAD_QUEUE.send(job);

  const nextRun = calculateNextRun(schedule.recurrence);
  await env.DB.prepare(
    `UPDATE scheduled_downloads
     SET status = ?, last_triggered = ?, next_run = ?, job_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(nextRun ? 'pending' : 'triggered', requestedAt, nextRun, jobId, schedule.id).run();

  await enqueueHistoryEvent(env, {
    jobId,
    event: 'queued',
    status: 'queued',
    source,
    detail: `scheduled:${schedule.id}`,
  });
  await recordTelemetry(env, { event: 'scheduled_download_triggered', status: '202', source });
}

function calculateNextRun(recurrence: Recurrence): string | null {
  if (!recurrence) return null;
  const next = new Date();
  if (recurrence === 'daily') next.setDate(next.getDate() + 1);
  if (recurrence === 'weekly') next.setDate(next.getDate() + 7);
  if (recurrence === 'monthly') next.setMonth(next.getMonth() + 1);
  return next.toISOString();
}

async function readScheduledOriginalUrl(env: Env, schedule: ScheduledDownload): Promise<string> {
  const cached = await resolvePrivateUrl(env, 'schedule', schedule.id, schedule.url);
  if (cached && isValidUrl(cached)) return cached;
  if (isValidUrl(schedule.url)) return schedule.url;
  return schedule.url;
}

function sanitizeSchedule(row: ScheduledDownload): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    thumbnail: row.thumbnail,
    source: row.source,
    format: row.format,
    quality: row.quality,
    scheduled_at: row.scheduled_at,
    recurrence: row.recurrence,
    wifi_only: Boolean(row.wifi_only),
    status: row.status,
    last_triggered: row.last_triggered,
    next_run: row.next_run,
    job_id: row.job_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeSyncKey(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim();
  return normalized.length >= 6 && normalized.length <= 96 ? normalized : null;
}

function normalizeRecurrence(value: string | null | undefined): Recurrence {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'daily' || normalized === 'weekly' || normalized === 'monthly') return normalized;
  return null;
}

function normalizeFormat(value: string | undefined): AudioFormat {
  const normalized = String(value ?? 'mp3').trim().toLowerCase();
  return FORMATS.includes(normalized as AudioFormat) ? normalized as AudioFormat : 'mp3';
}

function normalizeQuality(value: string | undefined, format: AudioFormat): AudioQuality {
  const fallback: AudioQuality = format === 'flac' || format === 'wav' ? 'lossless' : '320';
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return QUALITIES.includes(normalized as AudioQuality) ? normalized as AudioQuality : fallback;
}

function normalizeOptionalText(value: string | undefined, maxLength: number): string | null {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}
