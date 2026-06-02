import type { Env } from './types';
import { readEnvInt } from './utils';

const DEFAULT_RETRY_BASE_SECONDS = 30;
const DEFAULT_RETRY_MAX_SECONDS = 15 * 60;
const DEFAULT_RETRY_JITTER_PERCENT = 20;

export interface RetryDelayOptions {
  baseSeconds?: number;
  maxSeconds?: number;
  jitterPercent?: number;
  random?: () => number;
}

export function calculateQueueRetryBaseDelaySeconds(attempts: number, options: RetryDelayOptions = {}): number {
  const attempt = Math.max(1, Math.floor(attempts || 1));
  const baseSeconds = normalizePositiveInt(options.baseSeconds, DEFAULT_RETRY_BASE_SECONDS);
  const maxSeconds = normalizePositiveInt(options.maxSeconds, DEFAULT_RETRY_MAX_SECONDS);
  const exponent = Math.min(20, attempt - 1);
  return Math.min(maxSeconds, baseSeconds * (2 ** exponent));
}

export function calculateQueueRetryDelaySeconds(attempts: number, options: RetryDelayOptions = {}): number {
  const baseDelay = calculateQueueRetryBaseDelaySeconds(attempts, options);
  const baseSeconds = normalizePositiveInt(options.baseSeconds, DEFAULT_RETRY_BASE_SECONDS);
  const maxSeconds = normalizePositiveInt(options.maxSeconds, DEFAULT_RETRY_MAX_SECONDS);
  const jitterPercent = Math.min(75, Math.max(0, Math.floor(options.jitterPercent ?? DEFAULT_RETRY_JITTER_PERCENT)));
  if (jitterPercent <= 0) return baseDelay;

  const random = options.random ?? Math.random;
  const safeRandom = Math.min(1, Math.max(0, Number(random()) || 0));
  const jitterRatio = jitterPercent / 100;
  const minDelay = baseDelay >= maxSeconds
    ? Math.max(baseSeconds, Math.floor(maxSeconds * (1 - jitterRatio)))
    : baseDelay;
  const maxDelay = baseDelay >= maxSeconds
    ? maxSeconds
    : Math.min(maxSeconds, Math.ceil(baseDelay * (1 + jitterRatio)));

  return Math.max(baseSeconds, Math.min(maxSeconds, Math.round(minDelay + ((maxDelay - minDelay) * safeRandom))));
}

export function calculateQueueRetryDelayFromEnv(env: Env, attempts: number): number {
  return calculateQueueRetryDelaySeconds(attempts, {
    baseSeconds: readEnvInt(env.QUEUE_RETRY_BASE_SECONDS, DEFAULT_RETRY_BASE_SECONDS),
    maxSeconds: readEnvInt(env.QUEUE_RETRY_MAX_SECONDS, DEFAULT_RETRY_MAX_SECONDS),
    jitterPercent: readEnvInt(env.QUEUE_RETRY_JITTER_PERCENT, DEFAULT_RETRY_JITTER_PERCENT),
  });
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}
