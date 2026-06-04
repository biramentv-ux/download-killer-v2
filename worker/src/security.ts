import type { Env } from './types';
import { isValidUrl, readEnvInt, sha256Hex } from './utils';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_PRIVATE_URL_TTL_SECONDS = 60 * 60;
const DEFAULT_HMAC_MAX_SKEW_SECONDS = 5 * 60;
const DEFAULT_KV_CLEANUP_PREFIXES = ['url:', 'result:', 'private-url:', 'tg:url:', 'tg:result:'];

export function isSha256Hex(value: string | null | undefined): boolean {
  return /^[a-f0-9]{64}$/i.test(String(value ?? '').trim());
}

export async function hashPrivateUrl(url: string): Promise<string> {
  return sha256Hex(url.trim());
}

export async function hashAndCachePrivateUrl(
  env: Env,
  scope: 'job' | 'workflow' | 'shared',
  id: string,
  url: string,
): Promise<string> {
  const normalized = url.trim();
  if (!isValidUrl(normalized)) {
    throw new Error('Cannot cache invalid URL');
  }

  const hash = await hashPrivateUrl(normalized);
  const ttl = readEnvInt(env.PRIVATE_URL_TTL_SECONDS, DEFAULT_PRIVATE_URL_TTL_SECONDS);
  try {
    await Promise.all([
      env.CACHE.put(`url:${scope}:${id}`, normalized, { expirationTtl: ttl }),
      env.CACHE.put(`url:hash:${hash}`, normalized, { expirationTtl: ttl }),
    ]);
  } catch (error) {
    // D1 must never store private URLs. If KV quota is exhausted, keep the
    // anonymized hash and let queue messages carry the short-lived plaintext.
    console.warn('Private URL cache write skipped', error);
  }
  return hash;
}

export async function refreshPrivateUrlCache(
  env: Env,
  scope: 'job' | 'workflow' | 'shared',
  id: string,
  url: string,
): Promise<string> {
  return hashAndCachePrivateUrl(env, scope, id, url);
}

export async function resolvePrivateUrl(
  env: Env,
  scope: 'job' | 'workflow' | 'shared',
  id: string,
  storedValue?: string | null,
): Promise<string | null> {
  const stored = String(storedValue ?? '').trim();
  if (isValidUrl(stored)) return stored;

  const byId = await env.CACHE.get(`url:${scope}:${id}`);
  if (byId && isValidUrl(byId)) return byId;

  if (isSha256Hex(stored)) {
    const byHash = await env.CACHE.get(`url:hash:${stored}`);
    if (byHash && isValidUrl(byHash)) return byHash;
  }

  return null;
}

export async function safeUrlHash(storedValue: string | null | undefined): Promise<string | null> {
  const stored = String(storedValue ?? '').trim();
  if (!stored) return null;
  if (isSha256Hex(stored)) return stored.toLowerCase();
  if (isValidUrl(stored)) return hashPrivateUrl(stored);
  return stored;
}

export async function verifyTelegramWebhookToken(token: string | null, env: Env): Promise<boolean> {
  const provided = String(token ?? '').trim();
  if (!provided) return false;

  const requireJwt = env.TELEGRAM_WEBHOOK_REQUIRE_JWT === '1';
  if (provided.split('.').length === 3) {
    const verified = await verifyJwt(provided, env);
    if (verified) return true;
    if (requireJwt) return false;
  }

  if (requireJwt) return false;
  const expected = String(env.TELEGRAM_SECRET_TOKEN ?? '').trim();
  return Boolean(expected) && timingSafeEqual(provided, expected);
}

export async function verifyExternalHmacRequest(
  request: Request,
  bodyText: string,
  env: Env,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const secret = String(env.WEBHOOK_HMAC_SECRET ?? '').trim();
  if (!secret) {
    return { ok: false, code: 'HMAC_NOT_CONFIGURED', message: 'Webhook HMAC secret is not configured' };
  }

  const timestamp = String(request.headers.get('X-DyrakArmy-Timestamp') ?? '').trim();
  const signature = normalizeSignature(request.headers.get('X-DyrakArmy-Signature'));
  if (!timestamp || !signature) {
    return { ok: false, code: 'HMAC_MISSING', message: 'Missing HMAC timestamp or signature' };
  }

  const timestampMs = Number.parseInt(timestamp, 10) * 1000;
  const maxSkewMs = readEnvInt(env.WEBHOOK_HMAC_MAX_SKEW_SECONDS, DEFAULT_HMAC_MAX_SKEW_SECONDS) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > maxSkewMs) {
    return { ok: false, code: 'HMAC_EXPIRED', message: 'Webhook signature timestamp is outside the allowed window' };
  }

  const expected = await hmacSha256Hex(secret, `${timestamp}.${bodyText}`);
  if (!timingSafeEqual(signature, expected)) {
    return { ok: false, code: 'HMAC_INVALID', message: 'Webhook signature is invalid' };
  }

  return { ok: true };
}

export async function cleanupStaleKvKeys(env: Env): Promise<{ scanned: number; deleted: number }> {
  const prefixes = (env.KV_CLEANUP_PREFIXES ?? DEFAULT_KV_CLEANUP_PREFIXES.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const maxKeys = readEnvInt(env.KV_CLEANUP_MAX_KEYS, 500);

  let scanned = 0;
  let deleted = 0;
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const page = await env.CACHE.list({ prefix, cursor, limit: Math.min(1000, Math.max(1, maxKeys - scanned)) });
      for (const key of page.keys) {
        scanned += 1;
        const expiration = (key as { expiration?: number }).expiration;
        if (!expiration) {
          await env.CACHE.delete(key.name);
          deleted += 1;
        }
        if (scanned >= maxKeys) return { scanned, deleted };
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && scanned < maxKeys);
  }

  return { scanned, deleted };
}

async function verifyJwt(token: string, env: Env): Promise<boolean> {
  const [rawHeader, rawPayload, signature] = token.split('.');
  if (!rawHeader || !rawPayload || !signature) return false;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(decoder.decode(base64UrlDecode(rawHeader))) as Record<string, unknown>;
    payload = JSON.parse(decoder.decode(base64UrlDecode(rawPayload))) as Record<string, unknown>;
  } catch {
    return false;
  }

  const alg = String(header.alg ?? '');
  const unsigned = `${rawHeader}.${rawPayload}`;
  let signatureOk = false;
  if (alg === 'HS256') {
    const secret = String(env.TELEGRAM_WEBHOOK_JWT_SECRET ?? '').trim();
    if (!secret) return false;
    signatureOk = timingSafeEqual(signature, base64UrlEncode(await hmacSha256(secret, unsigned)));
  } else if (alg === 'RS256') {
    signatureOk = await verifyAsymmetricJwtSignature(
      env.TELEGRAM_WEBHOOK_JWT_PUBLIC_JWK,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      unsigned,
      signature,
    );
  } else if (alg === 'ES256') {
    signatureOk = await verifyAsymmetricJwtSignature(
      env.TELEGRAM_WEBHOOK_JWT_PUBLIC_JWK,
      { name: 'ECDSA', namedCurve: 'P-256' },
      unsigned,
      signature,
      { name: 'ECDSA', hash: 'SHA-256' },
    );
  }

  if (!signatureOk) return false;
  return verifyJwtClaims(payload);
}

function verifyJwtClaims(payload: Record<string, unknown>): boolean {
  const now = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp ?? 0);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const nbf = payload.nbf === undefined ? null : Number(payload.nbf);
  if (nbf !== null && Number.isFinite(nbf) && nbf > now + 30) return false;

  const aud = payload.aud === undefined ? 'telegram-webhook' : String(payload.aud);
  const iss = payload.iss === undefined ? 'dyrakarmy' : String(payload.iss);
  return aud === 'telegram-webhook' && iss === 'dyrakarmy';
}

async function verifyAsymmetricJwtSignature(
  jwkRaw: string | undefined,
  importAlgorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams,
  unsigned: string,
  signature: string,
  verifyAlgorithm?: AlgorithmIdentifier | EcdsaParams,
): Promise<boolean> {
  const jwkText = String(jwkRaw ?? '').trim();
  if (!jwkText) return false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      JSON.parse(jwkText) as JsonWebKey,
      importAlgorithm,
      false,
      ['verify'],
    );
    const signatureBytes = base64UrlDecode(signature);
    const dataBytes = encoder.encode(unsigned);
    return crypto.subtle.verify(
      verifyAlgorithm ?? importAlgorithm,
      key,
      toArrayBuffer(signatureBytes),
      toArrayBuffer(dataBytes),
    );
  } catch {
    return false;
  }
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const bytes = await hmacSha256(secret, message);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function normalizeSignature(value: string | null): string {
  return String(value ?? '').trim().replace(/^sha256=/i, '').toLowerCase();
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = '';
  for (const b of value) binary += String.fromCharCode(b);
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}
