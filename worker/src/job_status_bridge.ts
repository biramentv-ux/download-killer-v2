import type { Env } from './types';
import {
  corsHeaders,
  createDownloadToken,
  getClientAddress,
  rateLimit,
  readEnvInt,
} from './utils';

interface JobStatusRow {
  id: string;
  source: string;
  format: string;
  quality: string;
  status: string;
  title: string | null;
  artist: string | null;
  duration: number | null;
  file_size: number | null;
  result_url: string | null;
  r2_key: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export function matchJobStatusRequest(request: Request): string | null {
  if (request.method !== 'GET') return null;
  const match = new URL(request.url).pathname.match(/^\/api\/job\/([0-9a-f-]{36})$/i);
  return match?.[1] ?? null;
}

export function configuredJobStatusLimit(env: Env): number {
  return Math.max(30, Math.min(600, readEnvInt(env.JOB_STATUS_RATE_LIMIT_PER_MINUTE, 120)));
}

function json(request: Request, env: Env, payload: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(corsHeaders(request, env));
  headers.set('Cache-Control', 'no-store');
  if (extraHeaders) {
    const additions = new Headers(extraHeaders);
    additions.forEach((value, key) => headers.set(key, value));
  }
  return Response.json(payload, { status, headers });
}

export async function handleJobStatusBridge(request: Request, env: Env): Promise<Response | null> {
  const jobId = matchJobStatusRequest(request);
  if (!jobId) return null;

  const ip = getClientAddress(request);
  const limit = configuredJobStatusLimit(env);
  const rate = await rateLimit(env.CACHE, `job-status-v2:${jobId}:${ip}`, limit, 60);
  if (rate.limited) {
    const retryAfter = Math.max(2, Math.ceil((rate.resetAt - Date.now()) / 1000));
    return json(
      request,
      env,
      { error: { code: 'RATE_LIMITED', message: 'Status checks are temporarily limited', retryable: true } },
      429,
      {
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
      },
    );
  }

  const row = await env.DB.prepare(
    `SELECT id, source, format, quality, status, title, artist, duration, file_size,
            result_url, r2_key, error_code, error_message, created_at, updated_at, finished_at
     FROM download_jobs
     WHERE id = ?
     LIMIT 1`,
  ).bind(jobId).first<JobStatusRow>();

  if (!row) {
    return json(
      request,
      env,
      { error: { code: 'JOB_NOT_FOUND', message: 'Job not found', retryable: false } },
      404,
    );
  }

  const hasDownloadTarget = Boolean(row.result_url || row.r2_key);
  let downloadUrl: string | null = null;
  if (row.status === 'done' && hasDownloadTarget) {
    const ttl = readEnvInt(env.DOWNLOAD_TOKEN_TTL_SECONDS, 3600);
    const token = await createDownloadToken(
      { jobId: row.id, exp: Math.floor(Date.now() / 1000) + ttl },
      env.DOWNLOAD_TOKEN_SECRET,
    );
    const publicBase = String(env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/+$/, '');
    downloadUrl = `${publicBase}/api/file/${encodeURIComponent(token)}`;
  }

  return json(request, env, {
    job: {
      id: row.id,
      source: row.source,
      format: row.format,
      quality: row.quality,
      status: row.status,
      title: row.title,
      artist: row.artist,
      duration: row.duration,
      file_size: row.file_size,
      error_code: row.error_code,
      error_message: row.error_message,
      download_url: downloadUrl,
      download_available: Boolean(downloadUrl),
      created_at: row.created_at,
      updated_at: row.updated_at,
      finished_at: row.finished_at,
      polling: {
        recommended_interval_ms: 6000,
        rate_limit_per_minute: limit,
      },
    },
  }, 200, {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(Math.max(0, rate.remaining)),
  });
}
