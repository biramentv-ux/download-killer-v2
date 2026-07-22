import { initializeTelegramStorageSchema } from './telegram_schema';
import type { AudioFormat, AudioQuality, DownloadJob, Env } from './types';

export type ArchiveReconcileEnv = Env & {
  TELEGRAM_STORAGE_ENABLED?: string;
  TELEGRAM_DOWNLOAD_CHANNEL_ID?: string;
  TELEGRAM_ARCHIVE_RECONCILE_BATCH?: string;
  TELEGRAM_ARCHIVE_RECONCILE_RETRY_MINUTES?: string;
  OPS_ADMIN_TOKEN?: string;
};

type BackfillRow = {
  id: string;
  url: string;
  source: string;
  format: AudioFormat;
  quality: AudioQuality;
  fingerprint: string | null;
  parent_job_id: string | null;
  variant_role: 'primary' | 'mobile' | null;
  sync_key: string | null;
  playlist_folder: string | null;
  playlist_index: number | null;
  local_relpath: string | null;
  chat_id: number | null;
  created_at: string;
};

type ReconcileStatus = {
  enabled: boolean;
  channel_configured: boolean;
  completed_jobs: number;
  archived_jobs: number;
  missing_jobs: number;
  pending_backfill: number;
};

const schemaReady = new WeakMap<object, Promise<void>>();

export async function handleTelegramArchiveReconcileApi(
  request: Request,
  env: ArchiveReconcileEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/telegram/archive/reconcile' && url.pathname !== '/api/telegram/archive/reconcile/status') return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });

  if (request.method === 'GET') {
    return json(request, { ok: true, ...(await getTelegramArchiveReconcileStatus(env)) });
  }

  if (request.method !== 'POST') return jsonError(request, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  if (!isAdminRequest(request, env)) return jsonError(request, 401, 'UNAUTHORIZED', 'OPS admin authorization is required');

  const body = await request.json().catch(() => ({})) as { limit?: unknown };
  const result = await runTelegramArchiveReconcile(env, clamp(Number(body.limit || 0), 1, 100, configuredBatch(env)));
  return json(request, { ok: true, ...result }, 202);
}

export async function runTelegramArchiveReconcile(
  env: ArchiveReconcileEnv,
  requestedLimit = configuredBatch(env),
): Promise<{ queued: number; skipped: number; status: ReconcileStatus }> {
  await ensureArchiveReconcileSchema(env);
  const status = await getTelegramArchiveReconcileStatus(env);
  if (!status.enabled || !status.channel_configured) return { queued: 0, skipped: status.missing_jobs, status };

  const limit = clamp(requestedLimit, 1, 100, configuredBatch(env));
  const retryMinutes = clamp(Number(env.TELEGRAM_ARCHIVE_RECONCILE_RETRY_MINUTES || 30), 5, 1440, 30);
  const rows = await env.DB.prepare(`
    SELECT d.id, d.url, d.source, d.format, d.quality, d.fingerprint,
           d.parent_job_id, d.variant_role, d.sync_key, d.playlist_folder,
           d.playlist_index, d.local_relpath, d.chat_id, d.created_at
    FROM download_jobs d
    LEFT JOIN telegram_media_objects m ON m.job_id = d.id
    LEFT JOIN telegram_archive_backfill b ON b.job_id = d.id
    WHERE d.status = 'done'
      AND (d.result_url IS NOT NULL OR d.r2_key IS NOT NULL)
      AND m.id IS NULL
      AND (b.job_id IS NULL OR b.queued_at <= datetime('now', ?))
    ORDER BY COALESCE(d.finished_at, d.updated_at, d.created_at) ASC
    LIMIT ?
  `).bind(`-${retryMinutes} minutes`, limit).all<BackfillRow>();

  let queued = 0;
  let skipped = 0;
  for (const row of rows.results || []) {
    try {
      const job = buildArchiveReconcileJob(row);
      await env.DOWNLOAD_QUEUE.send(job);
      await env.DB.prepare(`
        INSERT INTO telegram_archive_backfill (job_id, queued_at, attempts, last_error)
        VALUES (?, CURRENT_TIMESTAMP, 1, NULL)
        ON CONFLICT(job_id) DO UPDATE SET
          queued_at = CURRENT_TIMESTAMP,
          attempts = telegram_archive_backfill.attempts + 1,
          last_error = NULL
      `).bind(row.id).run();
      queued += 1;
    } catch (error) {
      skipped += 1;
      await env.DB.prepare(`
        INSERT INTO telegram_archive_backfill (job_id, queued_at, attempts, last_error)
        VALUES (?, CURRENT_TIMESTAMP, 1, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          queued_at = CURRENT_TIMESTAMP,
          attempts = telegram_archive_backfill.attempts + 1,
          last_error = excluded.last_error
      `).bind(row.id, String(error instanceof Error ? error.message : error).slice(0, 500)).run().catch(() => undefined);
    }
  }

  return { queued, skipped, status: await getTelegramArchiveReconcileStatus(env) };
}

export async function getTelegramArchiveReconcileStatus(env: ArchiveReconcileEnv): Promise<ReconcileStatus> {
  await ensureArchiveReconcileSchema(env);
  const row = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM download_jobs WHERE status = 'done') AS completed_jobs,
      (SELECT COUNT(DISTINCT job_id) FROM telegram_media_objects) AS archived_jobs,
      (SELECT COUNT(*)
         FROM download_jobs d
         LEFT JOIN telegram_media_objects m ON m.job_id = d.id
        WHERE d.status = 'done'
          AND (d.result_url IS NOT NULL OR d.r2_key IS NOT NULL)
          AND m.id IS NULL) AS missing_jobs,
      (SELECT COUNT(*) FROM telegram_archive_backfill) AS pending_backfill
  `).first<Record<string, number>>();
  return {
    enabled: storageEnabled(env),
    channel_configured: Boolean(String(env.TELEGRAM_DOWNLOAD_CHANNEL_ID || '').trim()),
    completed_jobs: Number(row?.completed_jobs || 0),
    archived_jobs: Number(row?.archived_jobs || 0),
    missing_jobs: Number(row?.missing_jobs || 0),
    pending_backfill: Number(row?.pending_backfill || 0),
  };
}

export function buildArchiveReconcileJob(row: BackfillRow): DownloadJob {
  return {
    id: row.id,
    url: row.url,
    source: row.source || 'unknown',
    format: row.format,
    quality: row.quality,
    fingerprint: row.fingerprint || row.id,
    parentJobId: row.parent_job_id || undefined,
    variantRole: row.variant_role || undefined,
    syncKey: row.sync_key || undefined,
    playlistFolder: row.playlist_folder || undefined,
    playlistIndex: Number.isFinite(row.playlist_index) ? Number(row.playlist_index) : undefined,
    localRelpath: row.local_relpath || undefined,
    chatId: Number.isFinite(row.chat_id) ? Number(row.chat_id) : undefined,
    requestedAt: row.created_at || new Date().toISOString(),
  };
}

async function ensureArchiveReconcileSchema(env: ArchiveReconcileEnv): Promise<void> {
  const dbKey = env.DB as unknown as object;
  let pending = schemaReady.get(dbKey);
  if (!pending) {
    pending = (async () => {
      await initializeTelegramStorageSchema(env.DB);
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS telegram_archive_backfill (
          job_id TEXT PRIMARY KEY,
          queued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        )
      `).run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tg_archive_backfill_queued ON telegram_archive_backfill(queued_at)').run();
      await env.DB.prepare(`
        DELETE FROM telegram_archive_backfill
        WHERE job_id IN (SELECT job_id FROM telegram_media_objects)
      `).run();
    })().catch((error) => {
      schemaReady.delete(dbKey);
      throw error;
    });
    schemaReady.set(dbKey, pending);
  }
  await pending;
}

function storageEnabled(env: ArchiveReconcileEnv): boolean {
  return String(env.TELEGRAM_STORAGE_ENABLED || '1') !== '0';
}

function configuredBatch(env: ArchiveReconcileEnv): number {
  return clamp(Number(env.TELEGRAM_ARCHIVE_RECONCILE_BATCH || 10), 1, 100, 10);
}

function isAdminRequest(request: Request, env: ArchiveReconcileEnv): boolean {
  const expected = String(env.OPS_ADMIN_TOKEN || '');
  const provided = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim() || '';
  return Boolean(expected && provided && constantTimeEqual(expected, provided));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function cors(request: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    Vary: 'Origin',
  };
}

function json(request: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors(request), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function jsonError(request: Request, status: number, code: string, message: string): Response {
  return json(request, { error: { code, message, retryable: status >= 500 } }, status);
}
