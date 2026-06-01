import type { Env } from './types';

export interface TelemetryEvent {
  event: string;
  status?: string;
  code?: string;
  source?: string;
  origin?: string;
  retryable?: boolean;
  latency_ms?: number;
  queue_backlog?: number;
  value?: number;
  at?: number;
}

interface AlertPayload {
  key: string;
  ttlSeconds: number;
  text: string;
}

const OPS_WINDOW_SECONDS = 24 * 60 * 60;
const OPS_HOURLY_WINDOW_SECONDS = 60 * 60;
const OPS_DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const DEFAULT_QUEUE_BACKLOG_ALERT = 250;
const DEFAULT_SMOKE_ALERT_COOLDOWN_SECONDS = 5 * 60;
const DEFAULT_SMOKE_CONSECUTIVE_ALERT_THRESHOLD = 2;
const DEFAULT_SMOKE_FAILURES_1H_ALERT_THRESHOLD = 2;
const SMOKE_KNOWN_SOURCES = ['youtube', 'spotify'] as const;

const COUNTERS = {
  reqOk1h: 'ops:req:ok:1h',
  reqFail5xx1h: 'ops:req:5xx:1h',
  reqOk24h: 'ops:req:ok:24h',
  reqFail5xx24h: 'ops:req:5xx:24h',
  queueRetry1h: 'ops:queue:retry:1h',
  queueFailed1h: 'ops:queue:failed:1h',
  workflowFailed1h: 'ops:wf:failed:1h',
  downloaderUnreachable1h: 'ops:origin:down:1h',
  smokeFailed1h: 'ops:smoke:failed:1h',
} as const;

function nowMs(): number {
  return Date.now();
}

function nowIso(): string {
  return new Date().toISOString();
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function clampText(raw: string, max = 300): string {
  return raw.length > max ? `${raw.slice(0, max - 3)}...` : raw;
}

async function incrementCounter(cache: KVNamespace, key: string, ttlSeconds: number, delta = 1): Promise<number> {
  try {
    const current = Number.parseInt((await cache.get(key)) ?? '0', 10);
    const next = Number.isFinite(current) ? current + delta : delta;
    await cache.put(key, String(next), { expirationTtl: ttlSeconds });
    return next;
  } catch {
    return 0;
  }
}

async function getCounter(cache: KVNamespace, key: string): Promise<number> {
  try {
    const current = Number.parseInt((await cache.get(key)) ?? '0', 10);
    return Number.isFinite(current) ? current : 0;
  } catch {
    return 0;
  }
}

async function setLastEvent(cache: KVNamespace, event: TelemetryEvent): Promise<void> {
  try {
    const payload = { ...event, at: event.at ?? nowMs() };
    await cache.put('ops:last:event', JSON.stringify(payload), { expirationTtl: OPS_WINDOW_SECONDS });
  } catch {
    // best effort only
  }
}

function writeAnalytics(env: Env, event: TelemetryEvent): void {
  try {
    env.ANALYTICS?.writeDataPoint({
      blobs: [
        event.event,
        event.status ?? '',
        event.code ?? '',
        event.source ?? '',
        event.origin ?? '',
      ],
      doubles: [
        Number(event.latency_ms ?? 0),
        Number(event.queue_backlog ?? 0),
        Number(event.value ?? 1),
      ],
      indexes: [event.source ?? event.event],
    });
  } catch {
    // best effort only
  }
}

export async function recordTelemetry(env: Env, event: TelemetryEvent): Promise<void> {
  writeAnalytics(env, event);
  await setLastEvent(env.CACHE, event);

  try {
    const statusNum = Number(event.status ?? 0);
    if (statusNum >= 200 && statusNum < 500) {
      await incrementCounter(env.CACHE, COUNTERS.reqOk1h, OPS_HOURLY_WINDOW_SECONDS);
      await incrementCounter(env.CACHE, COUNTERS.reqOk24h, OPS_DAILY_WINDOW_SECONDS);
    } else if (statusNum >= 500 || event.code?.includes('FAILED')) {
      await incrementCounter(env.CACHE, COUNTERS.reqFail5xx1h, OPS_HOURLY_WINDOW_SECONDS);
      await incrementCounter(env.CACHE, COUNTERS.reqFail5xx24h, OPS_DAILY_WINDOW_SECONDS);
    }

    if (event.event === 'queue_retry') {
      await incrementCounter(env.CACHE, COUNTERS.queueRetry1h, OPS_HOURLY_WINDOW_SECONDS);
    }
    if (event.event === 'queue_failed') {
      await incrementCounter(env.CACHE, COUNTERS.queueFailed1h, OPS_HOURLY_WINDOW_SECONDS);
    }
    if (event.event === 'workflow_failed') {
      await incrementCounter(env.CACHE, COUNTERS.workflowFailed1h, OPS_HOURLY_WINDOW_SECONDS);
    }
    if (event.event === 'origin_probe' && event.status === '0') {
      await incrementCounter(env.CACHE, COUNTERS.downloaderUnreachable1h, OPS_HOURLY_WINDOW_SECONDS);
    }
    if (event.event === 'downloader_smoke' && (event.status !== '200' || event.code?.includes('FAILED'))) {
      await incrementCounter(env.CACHE, COUNTERS.smokeFailed1h, OPS_HOURLY_WINDOW_SECONDS);
    }
  } catch {
    // best effort only
  }
}

async function sendTelegramAlert(env: Env, text: string): Promise<void> {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken || !env.OPS_ALERT_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.OPS_ALERT_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch {
    // best effort only
  }
}

async function sendAlertIfNotMuted(env: Env, payload: AlertPayload): Promise<void> {
  try {
    const mutedKey = `ops:alert:mute:${payload.key}`;
    const muted = await env.CACHE.get(mutedKey);
    if (muted) return;

    await sendTelegramAlert(env, payload.text);
    await env.CACHE.put(mutedKey, '1', { expirationTtl: payload.ttlSeconds });
  } catch {
    // best effort only
  }
}

export async function recordSmokeProbeResult(
  env: Env,
  source: string,
  status: number | string,
  code: string,
  options?: { origin?: string; latency_ms?: number },
): Promise<void> {
  const statusText = String(status);
  const isFailure = statusText !== '200' || code.includes('SMOKE_FAILED');
  const normalizedSource = String(source || 'unknown').toLowerCase();
  const cooldown = readPositiveInt(env.OPS_SMOKE_ALERT_COOLDOWN_SECONDS, DEFAULT_SMOKE_ALERT_COOLDOWN_SECONDS);
  const consecutiveThreshold = readPositiveInt(
    env.OPS_SMOKE_CONSECUTIVE_ALERT_THRESHOLD,
    DEFAULT_SMOKE_CONSECUTIVE_ALERT_THRESHOLD,
  );
  const consecutiveKey = `ops:smoke:consecutive:${normalizedSource}`;
  const lastCodeKey = `ops:smoke:last_code:${normalizedSource}`;
  const stateKey = `ops:smoke:state:${normalizedSource}`;

  await recordTelemetry(env, {
    event: 'downloader_smoke',
    status: statusText,
    source: normalizedSource,
    origin: options?.origin,
    latency_ms: options?.latency_ms,
    code,
  });

  if (isFailure) {
    try {
      const previous = Number.parseInt((await env.CACHE.get(consecutiveKey)) ?? '0', 10);
      const next = Number.isFinite(previous) ? previous + 1 : 1;
      await env.CACHE.put(consecutiveKey, String(next), { expirationTtl: OPS_DAILY_WINDOW_SECONDS });
      await env.CACHE.put(lastCodeKey, clampText(code, 220), { expirationTtl: OPS_DAILY_WINDOW_SECONDS });
      await env.CACHE.put(stateKey, JSON.stringify({
        source: normalizedSource,
        status: statusText,
        code: clampText(code, 220),
        consecutive_failures: next,
        healthy: false,
        at: nowIso(),
        origin: options?.origin ?? '',
        latency_ms: Number(options?.latency_ms ?? 0),
      }), { expirationTtl: OPS_DAILY_WINDOW_SECONDS });
      if (next >= consecutiveThreshold) {
        await sendAlertIfNotMuted(env, {
          key: `smoke_source_failed:${normalizedSource}`,
          ttlSeconds: cooldown,
          text: `DyrakArmy alert: smoke failure on ${normalizedSource} (consecutive=${next}, status=${statusText}) at ${nowIso()} | ${clampText(code, 180)}`,
        });
      }
    } catch {
      // best effort only
    }
    return;
  }

  try {
    const previous = Number.parseInt((await env.CACHE.get(consecutiveKey)) ?? '0', 10);
    if (Number.isFinite(previous) && previous > 0) {
      const lastCode = (await env.CACHE.get(lastCodeKey)) ?? 'SMOKE_FAILED';
      await sendAlertIfNotMuted(env, {
        key: `smoke_source_recovered:${normalizedSource}`,
        ttlSeconds: Math.max(120, Math.floor(cooldown / 2)),
        text: `DyrakArmy recovery: smoke recovered on ${normalizedSource} after ${previous} failures at ${nowIso()} (last=${clampText(lastCode, 160)})`,
      });
    }
    await env.CACHE.put(consecutiveKey, '0', { expirationTtl: OPS_DAILY_WINDOW_SECONDS });
    await env.CACHE.put(stateKey, JSON.stringify({
      source: normalizedSource,
      status: statusText,
      code: clampText(code, 220),
      consecutive_failures: 0,
      healthy: true,
      at: nowIso(),
      origin: options?.origin ?? '',
      latency_ms: Number(options?.latency_ms ?? 0),
    }), { expirationTtl: OPS_DAILY_WINDOW_SECONDS });
  } catch {
    // best effort only
  }
}

export async function evaluateOpsAlerts(env: Env): Promise<void> {
  const fail5xx = await getCounter(env.CACHE, COUNTERS.reqFail5xx1h);
  const queueRetries = await getCounter(env.CACHE, COUNTERS.queueRetry1h);
  const originDown = await getCounter(env.CACHE, COUNTERS.downloaderUnreachable1h);
  const workflowFailed = await getCounter(env.CACHE, COUNTERS.workflowFailed1h);
  const smokeFailed = await getCounter(env.CACHE, COUNTERS.smokeFailed1h);
  const smokeFailuresThreshold = readPositiveInt(
    env.OPS_SMOKE_FAILURES_1H_ALERT_THRESHOLD,
    DEFAULT_SMOKE_FAILURES_1H_ALERT_THRESHOLD,
  );
  const backlogRow = await env.DB.prepare(
    `SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing
     FROM download_jobs`,
  ).first<{ queued: number | null; processing: number | null }>();

  const queuedNow = Number(backlogRow?.queued ?? 0) || 0;
  const processingNow = Number(backlogRow?.processing ?? 0) || 0;
  const backlogNow = queuedNow + processingNow;
  const backlogThresholdRaw = Number.parseInt(env.OPS_QUEUE_BACKLOG_THRESHOLD ?? String(DEFAULT_QUEUE_BACKLOG_ALERT), 10);
  const backlogThreshold = Number.isFinite(backlogThresholdRaw) && backlogThresholdRaw > 0
    ? backlogThresholdRaw
    : DEFAULT_QUEUE_BACKLOG_ALERT;

  if (fail5xx >= 15) {
    await sendAlertIfNotMuted(env, {
      key: 'high_5xx',
      ttlSeconds: 15 * 60,
      text: `DyrakArmy alert: high 5xx rate (${fail5xx} errors / 1h) at ${nowIso()}`,
    });
  }

  if (originDown >= 3) {
    await sendAlertIfNotMuted(env, {
      key: 'origin_down',
      ttlSeconds: 10 * 60,
      text: `DyrakArmy alert: downloader origin unreachable (${originDown} probe failures / 1h) at ${nowIso()}`,
    });
  }

  if (smokeFailed >= smokeFailuresThreshold) {
    await sendAlertIfNotMuted(env, {
      key: 'smoke_failed',
      ttlSeconds: 10 * 60,
      text: `DyrakArmy alert: downloader smoke checks failing (${smokeFailed} / 1h; threshold=${smokeFailuresThreshold}) at ${nowIso()}`,
    });
  }

  if (backlogNow >= backlogThreshold) {
    await sendAlertIfNotMuted(env, {
      key: 'queue_backlog',
      ttlSeconds: 10 * 60,
      text: `DyrakArmy alert: queue backlog high (${backlogNow} queued+processing; threshold=${backlogThreshold}) at ${nowIso()}`,
    });
  }

  if (queueRetries >= 30) {
    await sendAlertIfNotMuted(env, {
      key: 'queue_retry_spike',
      ttlSeconds: 10 * 60,
      text: `DyrakArmy alert: queue retry spike (${queueRetries} retries / 1h) at ${nowIso()}`,
    });
  }

  if (workflowFailed >= 10) {
    await sendAlertIfNotMuted(env, {
      key: 'workflow_fail_burst',
      ttlSeconds: 15 * 60,
      text: `DyrakArmy alert: playlist workflow failures (${workflowFailed} / 1h) at ${nowIso()}`,
    });
  }
}

export async function buildOpsSummary(env: Env): Promise<Record<string, unknown>> {
  const [reqOk1h, req5xx1h, reqOk24h, req5xx24h, qRetry, qFailed, wfFailed, originDown, smokeFailed] = await Promise.all([
    getCounter(env.CACHE, COUNTERS.reqOk1h),
    getCounter(env.CACHE, COUNTERS.reqFail5xx1h),
    getCounter(env.CACHE, COUNTERS.reqOk24h),
    getCounter(env.CACHE, COUNTERS.reqFail5xx24h),
    getCounter(env.CACHE, COUNTERS.queueRetry1h),
    getCounter(env.CACHE, COUNTERS.queueFailed1h),
    getCounter(env.CACHE, COUNTERS.workflowFailed1h),
    getCounter(env.CACHE, COUNTERS.downloaderUnreachable1h),
    getCounter(env.CACHE, COUNTERS.smokeFailed1h),
  ]);

  const backlogRow = await env.DB.prepare(
    `SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN status = 'failed' AND datetime(updated_at) >= datetime('now', '-1 hour') THEN 1 ELSE 0 END) AS failed_1h
     FROM download_jobs`,
  ).first<{ queued: number | null; processing: number | null; failed_1h: number | null }>();

  const wfRow = await env.DB.prepare(
    `SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
     FROM playlist_workflows`,
  ).first<{ queued: number | null; processing: number | null; failed: number | null; done: number | null }>().catch(() => null);

  const topErrors = await env.DB.prepare(
    `SELECT error_code, COUNT(*) AS count
     FROM download_jobs
     WHERE error_code IS NOT NULL
       AND error_code != ''
       AND datetime(updated_at) >= datetime('now', '-1 day')
     GROUP BY error_code
     ORDER BY count DESC
     LIMIT 8`,
  ).all<{ error_code: string | null; count: number | null }>().catch(() => ({ results: [] }));

  const lastEventRaw = await env.CACHE.get('ops:last:event', { type: 'json' }) as TelemetryEvent | null;
  const smokeSourcesRaw = await Promise.all(
    SMOKE_KNOWN_SOURCES.map(async (source) => {
      const payload = await env.CACHE.get(`ops:smoke:state:${source}`, { type: 'json' }) as Record<string, unknown> | null;
      return payload ? { source, ...payload } : { source, healthy: null };
    }),
  );

  return {
    generated_at: nowIso(),
    requests_1h: {
      ok: reqOk1h,
      error_5xx: req5xx1h,
    },
    requests_24h: {
      ok: reqOk24h,
      error_5xx: req5xx24h,
    },
    queue_1h: {
      retries: qRetry,
      terminal_failed: qFailed,
      queued_now: backlogRow?.queued ?? 0,
      processing_now: backlogRow?.processing ?? 0,
      failed_recent: backlogRow?.failed_1h ?? 0,
    },
    downloader_1h: {
      probe_failures: originDown,
      smoke_failures: smokeFailed,
      smoke_sources: smokeSourcesRaw,
    },
    workflows_1h: {
      failed_events: wfFailed,
      queued_now: wfRow?.queued ?? 0,
      processing_now: wfRow?.processing ?? 0,
      failed_now: wfRow?.failed ?? 0,
      done_now: wfRow?.done ?? 0,
    },
    top_error_codes_24h: (topErrors.results ?? []).map((row) => ({
      code: row.error_code ?? 'unknown',
      count: row.count ?? 0,
    })),
    last_event: lastEventRaw
      ? {
        ...lastEventRaw,
        code: lastEventRaw.code ? clampText(lastEventRaw.code, 120) : undefined,
      }
      : null,
  };
}
