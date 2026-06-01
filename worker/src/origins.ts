import type { Env } from './types';
import { readEnvInt } from './utils';

export interface DownloaderOrigin {
  id: string;
  baseUrl: string;
  priority: number;
}

export interface OriginHealthState {
  circuit: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  lastOkAt: number | null;
  lastFailureAt: number | null;
  lastLatencyMs: number | null;
  cooldownUntil: number | null;
  updatedAt: number;
}

export interface OriginProbeResult {
  origin: string;
  ok: boolean;
  status: number;
  latency_ms: number;
  circuit: OriginHealthState['circuit'];
  consecutive_failures: number;
  error?: string;
}

export interface FetchFailoverResult {
  origin: DownloaderOrigin;
  response: Response;
  attempt: number;
  switched: boolean;
}

interface OriginsJsonEntry {
  id?: string;
  base_url?: string;
  priority?: number;
}

const HEALTH_KEY_PREFIX = 'origin:health:';
const DEFAULT_TIMEOUT_MS = 9000;
const DEFAULT_FAIL_THRESHOLD = 3;
const DEFAULT_RECOVERY_SECONDS = 45;

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/g, '');
}

function kvKeyForOrigin(baseUrl: string): string {
  return `${HEALTH_KEY_PREFIX}${encodeURIComponent(baseUrl.toLowerCase())}`;
}

function getOriginTimeoutMs(env: Env): number {
  return readEnvInt(env.ORIGIN_HEALTH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
}

function getFailThreshold(env: Env): number {
  return readEnvInt(env.ORIGIN_FAIL_THRESHOLD, DEFAULT_FAIL_THRESHOLD);
}

function getRecoverySeconds(env: Env): number {
  return readEnvInt(env.ORIGIN_RECOVERY_SECONDS, DEFAULT_RECOVERY_SECONDS);
}

function parseOriginsJson(raw: string | undefined): DownloaderOrigin[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as Array<string | OriginsJsonEntry>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry, index) => {
        if (typeof entry === 'string') {
          return {
            id: `origin-${index + 1}`,
            baseUrl: normalizeBaseUrl(entry.trim()),
            priority: index,
          } satisfies DownloaderOrigin;
        }
        if (!entry || typeof entry !== 'object') return null;
        const base = String(entry.base_url ?? '').trim();
        if (!base) return null;
        return {
          id: String(entry.id ?? `origin-${index + 1}`),
          baseUrl: normalizeBaseUrl(base),
          priority: Number.isFinite(entry.priority) ? Number(entry.priority) : index,
        } satisfies DownloaderOrigin;
      })
      .filter((origin): origin is DownloaderOrigin => Boolean(origin && origin.baseUrl));
  } catch {
    return [];
  }
}

function parseEnvOrigin(raw: string | undefined, id: string, priority: number): DownloaderOrigin[] {
  const value = String(raw ?? '').trim();
  if (!value) return [];
  return [{
    id,
    baseUrl: normalizeBaseUrl(value),
    priority,
  }];
}

export function getConfiguredOrigins(env: Env): DownloaderOrigin[] {
  const parsed = [
    ...parseOriginsJson(env.DOWNLOADER_ORIGINS_JSON),
    ...parseEnvOrigin(env.DOWNLOADER_BACKUP_API_URL, 'env-backup', 900),
    ...parseEnvOrigin(env.DOWNLOADER_TERTIARY_API_URL, 'env-tertiary', 950),
  ];
  const fallbackRaw = String(env.DOWNLOADER_API_URL ?? '').trim();
  const fallback = fallbackRaw
    ? [{
      id: 'legacy-primary',
      baseUrl: normalizeBaseUrl(fallbackRaw),
      priority: 1000,
    } satisfies DownloaderOrigin]
    : [];

  const all = [...parsed, ...fallback];
  const deduped = new Map<string, DownloaderOrigin>();
  for (const origin of all) {
    const key = origin.baseUrl.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, origin);
  }
  return [...deduped.values()].sort((a, b) => a.priority - b.priority);
}

async function readHealthState(env: Env, baseUrl: string): Promise<OriginHealthState> {
  const key = kvKeyForOrigin(baseUrl);
  try {
    const state = await env.CACHE.get(key, { type: 'json' }) as OriginHealthState | null;
    if (state) return state;
  } catch {
    // Health state is advisory only. Downloader calls must keep working if KV is exhausted.
  }
  return {
    circuit: 'closed',
    consecutiveFailures: 0,
    lastOkAt: null,
    lastFailureAt: null,
    lastLatencyMs: null,
    cooldownUntil: null,
    updatedAt: Date.now(),
  };
}

async function writeHealthState(env: Env, baseUrl: string, state: OriginHealthState): Promise<void> {
  const key = kvKeyForOrigin(baseUrl);
  try {
    await env.CACHE.put(key, JSON.stringify(state), { expirationTtl: 7 * 24 * 60 * 60 });
  } catch {
    // Best effort only. KV daily limits should not break search/download/file proxy paths.
  }
}

function shouldSkipByCircuit(state: OriginHealthState): boolean {
  if (state.circuit !== 'open') return false;
  if (!state.cooldownUntil) return false;
  return Date.now() < state.cooldownUntil;
}

async function markSuccess(env: Env, origin: DownloaderOrigin, latencyMs: number): Promise<OriginHealthState> {
  const now = Date.now();
  const next: OriginHealthState = {
    circuit: 'closed',
    consecutiveFailures: 0,
    lastOkAt: now,
    lastFailureAt: null,
    lastLatencyMs: latencyMs,
    cooldownUntil: null,
    updatedAt: now,
  };
  await writeHealthState(env, origin.baseUrl, next);
  return next;
}

async function markFailure(
  env: Env,
  origin: DownloaderOrigin,
  latencyMs: number | null,
  previous?: OriginHealthState,
): Promise<OriginHealthState> {
  const threshold = getFailThreshold(env);
  const recoverySeconds = getRecoverySeconds(env);
  const prev = previous ?? await readHealthState(env, origin.baseUrl);
  const now = Date.now();
  const failures = prev.consecutiveFailures + 1;
  const shouldOpen = failures >= threshold;
  const next: OriginHealthState = {
    circuit: shouldOpen ? 'open' : prev.circuit,
    consecutiveFailures: failures,
    lastOkAt: prev.lastOkAt,
    lastFailureAt: now,
    lastLatencyMs: latencyMs,
    cooldownUntil: shouldOpen ? now + (recoverySeconds * 1000) : prev.cooldownUntil,
    updatedAt: now,
  };
  await writeHealthState(env, origin.baseUrl, next);
  return next;
}

function withTimeout(requestPromise: Promise<Response>, timeoutMs: number): Promise<Response> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<Response>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([requestPromise, timeout]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });
}

async function selectOriginsByCircuit(env: Env): Promise<DownloaderOrigin[]> {
  const origins = getConfiguredOrigins(env);
  if (origins.length <= 1) return origins;

  const withState = await Promise.all(origins.map(async (origin) => ({
    origin,
    state: await readHealthState(env, origin.baseUrl),
  })));

  const available = withState
    .filter((item) => !shouldSkipByCircuit(item.state))
    .map((item) => item.origin);
  const blocked = withState
    .filter((item) => shouldSkipByCircuit(item.state))
    .map((item) => item.origin);

  return [...available, ...blocked];
}

export async function fetchDownloaderWithFailover(
  env: Env,
  path: string,
  init?: RequestInit,
): Promise<FetchFailoverResult> {
  const origins = await selectOriginsByCircuit(env);
  if (origins.length === 0) {
    throw new Error('No configured downloader origins');
  }

  const timeoutMs = getOriginTimeoutMs(env);
  let lastError: string | null = null;

  for (let index = 0; index < origins.length; index += 1) {
    const origin = origins[index]!;
    const state = await readHealthState(env, origin.baseUrl);
    if (state.circuit === 'open' && !shouldSkipByCircuit(state)) {
      state.circuit = 'half-open';
      await writeHealthState(env, origin.baseUrl, state);
    }

    const target = `${origin.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const started = Date.now();

    try {
      const response = await withTimeout(fetch(target, init), timeoutMs);
      const latency = Date.now() - started;

      if (response.ok) {
        await markSuccess(env, origin, latency);
        return {
          origin,
          response,
          attempt: index + 1,
          switched: index > 0,
        };
      }

      const failedState = await markFailure(env, origin, latency, state);
      lastError = `origin=${origin.baseUrl} status=${response.status} circuit=${failedState.circuit}`;
    } catch (error) {
      const latency = Date.now() - started;
      const failedState = await markFailure(env, origin, latency, state);
      const errorText = error instanceof Error ? error.message : String(error);
      lastError = `origin=${origin.baseUrl} error=${errorText} circuit=${failedState.circuit}`;
    }
  }

  throw new Error(lastError ?? 'No downloader origin succeeded');
}

export async function probeDownloaderOrigins(env: Env): Promise<OriginProbeResult[]> {
  const origins = getConfiguredOrigins(env);
  const timeoutMs = getOriginTimeoutMs(env);
  const results: OriginProbeResult[] = [];

  for (const origin of origins) {
    const started = Date.now();
    const state = await readHealthState(env, origin.baseUrl);
    if (state.circuit === 'open' && !shouldSkipByCircuit(state)) {
      state.circuit = 'half-open';
      await writeHealthState(env, origin.baseUrl, state);
    }

    try {
      const response = await withTimeout(fetch(`${origin.baseUrl}/health`), timeoutMs);
      const latencyMs = Date.now() - started;
      if (response.ok) {
        const next = await markSuccess(env, origin, latencyMs);
        results.push({
          origin: origin.baseUrl,
          ok: true,
          status: response.status,
          latency_ms: latencyMs,
          circuit: next.circuit,
          consecutive_failures: next.consecutiveFailures,
        });
      } else {
        const next = await markFailure(env, origin, latencyMs, state);
        results.push({
          origin: origin.baseUrl,
          ok: false,
          status: response.status,
          latency_ms: latencyMs,
          circuit: next.circuit,
          consecutive_failures: next.consecutiveFailures,
          error: `status ${response.status}`,
        });
      }
    } catch (error) {
      const latencyMs = Date.now() - started;
      const next = await markFailure(env, origin, latencyMs, state);
      results.push({
        origin: origin.baseUrl,
        ok: false,
        status: 0,
        latency_ms: latencyMs,
        circuit: next.circuit,
        consecutive_failures: next.consecutiveFailures,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export function normalizeDownloaderUrl(rawUrl: string, env: Env): string {
  try {
    const parsed = new URL(rawUrl);
    const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
    if (!localHosts.has(parsed.hostname.toLowerCase())) {
      return rawUrl;
    }

    const firstOrigin = getConfiguredOrigins(env)[0];
    if (!firstOrigin) return rawUrl;
    const base = new URL(firstOrigin.baseUrl);
    return `${base.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return rawUrl;
  }
}

export function buildDownloaderHeaders(targetUrl: string, env: Env): Record<string, string> | null {
  const targetOrigin = (() => {
    try {
      return new URL(targetUrl).origin.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (!targetOrigin) return null;

  const allowedOrigins = new Set(getConfiguredOrigins(env).map((origin) => {
    try {
      return new URL(origin.baseUrl).origin.toLowerCase();
    } catch {
      return '';
    }
  }));
  if (!allowedOrigins.has(targetOrigin)) return null;

  return {
    'X-API-Key': env.DOWNLOADER_API_KEY,
  };
}

export async function listOriginStates(env: Env): Promise<Array<{
  id: string;
  base_url: string;
  state: OriginHealthState;
}>> {
  const origins = getConfiguredOrigins(env);
  const rows: Array<{ id: string; base_url: string; state: OriginHealthState }> = [];
  for (const origin of origins) {
    rows.push({
      id: origin.id,
      base_url: origin.baseUrl,
      state: await readHealthState(env, origin.baseUrl),
    });
  }
  return rows;
}
