import type { ApiErrorBody, AudioFormat, AudioQuality, Env } from './types';

export interface RateLimitResult {
  limited: boolean;
  remaining: number;
  resetAt: number;
}

export interface DownloadTokenPayload {
  jobId: string;
  exp: number;
}

const encoder = new TextEncoder();

export function readEnvInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

export function normalizeSource(input: string | undefined): string {
  const value = (input ?? 'all').trim().toLowerCase();
  if (!value) return 'all';
  return value;
}

export function detectSourceFromUrl(rawUrl: string): string {
  const lower = rawUrl.toLowerCase();
  if (lower.includes('youtube.com') || lower.includes('youtu.be') || lower.includes('music.youtube.com')) return 'youtube';
  if (lower.includes('spotify.com')) return 'spotify';
  if (lower.includes('soundcloud.com')) return 'soundcloud';
  if (lower.includes('deezer.com')) return 'deezer';
  if (lower.includes('music.apple.com') || lower.includes('itunes.apple.com')) return 'apple';
  return 'unknown';
}

export function isValidUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getAllowedOrigin(request: Request, env: Env): string {
  const origin = request.headers.get('Origin');
  const configured = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!origin) return configured[0] ?? '*';
  if (configured.length === 0) return '*';
  return configured.includes(origin) ? origin : (configured[0] ?? '*');
}

export function corsHeaders(request: Request, env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': getAllowedOrigin(request, env),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function jsonOk(request: Request, env: Env, data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      ...corsHeaders(request, env),
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export function jsonError(
  request: Request,
  env: Env,
  code: string,
  message: string,
  status = 400,
  retryable = false,
): Response {
  const payload: ApiErrorBody = { error: { code, message, retryable } };
  return Response.json(payload, {
    status,
    headers: {
      ...corsHeaders(request, env),
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export function optionsResponse(request: Request, env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, env),
  });
}

export async function parseJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function getClientAddress(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
}

export async function rateLimit(
  cache: KVNamespace,
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const kvKey = `rl:${key}`;
  const now = Date.now();
  try {
    const current = await cache.get(kvKey, { type: 'json' }) as { count: number; resetAt: number } | null;
    if (current && current.resetAt > now) {
      if (current.count >= maxRequests) {
        return { limited: true, remaining: 0, resetAt: current.resetAt };
      }

      const nextCount = current.count + 1;
      const ttl = Math.max(60, Math.ceil((current.resetAt - now) / 1000));
      await cache.put(kvKey, JSON.stringify({ count: nextCount, resetAt: current.resetAt }), { expirationTtl: ttl });

      return {
        limited: false,
        remaining: Math.max(0, maxRequests - nextCount),
        resetAt: current.resetAt,
      };
    }

    const resetAt = now + windowSeconds * 1000;
    await cache.put(kvKey, JSON.stringify({ count: 1, resetAt }), { expirationTtl: Math.max(60, windowSeconds) });

    return {
      limited: false,
      remaining: Math.max(0, maxRequests - 1),
      resetAt,
    };
  } catch (error) {
    // Fail-open when KV quota/rate limits are hit so API endpoints remain available.
    console.error(`Rate limit KV fallback for ${kvKey}`, error);
    return {
      limited: false,
      remaining: Math.max(0, maxRequests - 1),
      resetAt: now + windowSeconds * 1000,
    };
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  const bytes = new Uint8Array(digest);
  return [...bytes].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export async function sha256HexBytes(input: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const normalized = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest('SHA-256', normalized.buffer);
  const digestBytes = new Uint8Array(digest);
  return [...digestBytes].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export async function createJobFingerprint(url: string, format: AudioFormat, quality: AudioQuality): Promise<string> {
  const canonical = `${url.trim()}|${format}|${quality}`;
  return sha256Hex(canonical);
}

function base64UrlEncode(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - input.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(signature);
}

export async function createDownloadToken(payload: DownloadTokenPayload, secret: string): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${header}.${body}`;
  const signature = base64UrlEncode(await hmacSha256(secret, unsigned));
  return `${unsigned}.${signature}`;
}

export async function verifyDownloadToken(token: string, secret: string): Promise<DownloadTokenPayload | null> {
  const [header, body, signature] = token.split('.');
  if (!header || !body || !signature) return null;

  const unsigned = `${header}.${body}`;
  const expected = base64UrlEncode(await hmacSha256(secret, unsigned));
  if (expected !== signature) return null;

  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(body));
    const payload = JSON.parse(decoded) as DownloadTokenPayload;
    if (!payload.jobId || !payload.exp) return null;
    if (payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function formatFileName(title: string, artist: string, ext: string): string {
  const raw = `${artist} - ${title}`.trim();
  const safeBase = raw.replace(/[^a-zA-Z0-9\-_\.\s]/g, '').replace(/\s+/g, ' ').trim() || 'download';
  return `${safeBase}.${ext}`;
}
