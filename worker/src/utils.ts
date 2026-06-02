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

export interface UrlPolicyResult {
  allowed: boolean;
  code?: string;
  message?: string;
  host?: string;
}

export interface RequestThreatResult {
  blocked: boolean;
  code?: string;
  message?: string;
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
  if (lower.includes('spotify.com')) {
    if (lower.includes('/show/') || lower.includes('/episode/')) return 'podcast';
    return 'spotify';
  }
  if (lower.includes('podcasts.apple.com') || lower.includes('/podcast/') || lower.includes('/show/')) return 'podcast';
  if (lower.includes('soundcloud.com')) return 'soundcloud';
  if (lower.includes('deezer.com')) return 'deezer';
  if (lower.includes('music.apple.com') || lower.includes('itunes.apple.com')) return 'apple';
  if (lower.includes('/feed') || lower.includes('rss') || lower.endsWith('.xml')) return 'podcast';
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

export function validateUrlPolicy(raw: string, env: Env): UrlPolicyResult {
  return validateUrlPolicyWithAllowlist(raw, env, env.URL_ALLOWLIST);
}

export function validateDownloadUrlPolicy(raw: string, env: Env): UrlPolicyResult {
  const allowlist = env.DOWNLOAD_URL_ALLOWLIST ?? DEFAULT_DOWNLOAD_ALLOWED_DOMAINS.join(',');
  return validateUrlPolicyWithAllowlist(raw, env, allowlist);
}

function validateUrlPolicyWithAllowlist(raw: string, env: Env, allowlistRaw: string | undefined): UrlPolicyResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { allowed: false, code: 'INVALID_URL', message: 'URL is invalid' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, code: 'INVALID_URL', message: 'Only HTTP and HTTPS URLs are allowed' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) {
    return { allowed: false, code: 'INVALID_URL', message: 'URL host is required' };
  }

  if (isPrivateOrLocalHost(host)) {
    return {
      allowed: false,
      code: 'URL_BLOCKED',
      message: 'Local and private network URLs are blocked',
      host,
    };
  }

  const allowlist = parseDomainList(allowlistRaw);
  if (allowlist.length > 0 && !allowlist.some((rule) => domainMatches(host, rule))) {
    return {
      allowed: false,
      code: 'URL_NOT_ALLOWLISTED',
      message: 'This URL is not on the allowed domain list',
      host,
    };
  }

  const blocklist = [
    ...DEFAULT_BLOCKED_DOMAINS,
    ...parseDomainList(env.URL_BLOCKLIST),
  ];
  if (blocklist.some((rule) => domainMatches(host, rule))) {
    return {
      allowed: false,
      code: 'URL_BLOCKED',
      message: 'This URL is blocked by domain policy',
      host,
    };
  }

  return { allowed: true, host };
}

export function detectRequestThreat(request: Request): RequestThreatResult {
  const parsed = new URL(request.url);
  const path = parsed.pathname.toLowerCase();
  const query = parsed.search.slice(1).toLowerCase();
  const userAgent = request.headers.get('user-agent')?.toLowerCase() ?? '';

  if (containsPathTraversal(path) || containsPathTraversal(query)) {
    return {
      blocked: true,
      code: 'PATH_TRAVERSAL_BLOCKED',
      message: 'Path traversal patterns are blocked',
    };
  }

  const isSensitiveApi = path === '/api/search' || path.startsWith('/api/job/');
  if (isSensitiveApi && containsSqlInjectionProbe(query)) {
    return {
      blocked: true,
      code: 'SQLI_BLOCKED',
      message: 'SQL injection probe blocked',
    };
  }

  if (path.startsWith('/api/') && containsScraperUserAgent(userAgent)) {
    return {
      blocked: true,
      code: 'SCRAPER_UA_BLOCKED',
      message: 'Automated scraping clients are blocked for API routes',
    };
  }

  return { blocked: false };
}

const DEFAULT_DOWNLOAD_ALLOWED_DOMAINS = [
  'youtube.com',
  '*.youtube.com',
  'youtu.be',
  'spotify.com',
  '*.spotify.com',
  'spotify.link',
  'soundcloud.com',
  '*.soundcloud.com',
  'deezer.com',
  '*.deezer.com',
  'music.apple.com',
  '*.music.apple.com',
  'podcasts.apple.com',
  '*.podcasts.apple.com',
  'itunes.apple.com',
  '*.itunes.apple.com',
  'rss.com',
  '*.rss.com',
  'anchor.fm',
  '*.anchor.fm',
  'simplecast.com',
  '*.simplecast.com',
  'buzzsprout.com',
  '*.buzzsprout.com',
  'podbean.com',
  '*.podbean.com',
  'libsyn.com',
  '*.libsyn.com',
  'megaphone.fm',
  '*.megaphone.fm',
  'omny.fm',
  '*.omny.fm',
  'transistor.fm',
  '*.transistor.fm',
];

const DEFAULT_BLOCKED_DOMAINS = [
  'localhost',
  'local',
  '*.local',
  '*.localhost',
  '*.onion',
];

function parseDomainList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function domainMatches(host: string, rule: string): boolean {
  const normalized = rule.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === '*') return true;
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === normalized || host.endsWith(`.${normalized}`);
}

const PATH_TRAVERSAL_PATTERNS = [
  '../',
  '..\\',
  '..%2f',
  '..%5c',
  '%2e%2e',
  '%252e%252e',
];

function containsPathTraversal(value: string): boolean {
  return PATH_TRAVERSAL_PATTERNS.some((pattern) => value.includes(pattern));
}

const SQLI_PROBE_PATTERNS = [
  'union select',
  'union%20select',
  'information_schema',
  ' or 1=1',
  '%20or%201=1',
  "' or '",
  '%27%20or%20%27',
  'sleep(',
  'benchmark(',
];

function containsSqlInjectionProbe(value: string): boolean {
  return SQLI_PROBE_PATTERNS.some((pattern) => value.includes(pattern));
}

const SCRAPER_USER_AGENT_PATTERNS = [
  'python-requests',
  'scrapy',
  'go-http-client',
  'java/',
  'okhttp',
  'libwww-perl',
  'httpclient',
  'aiohttp',
  'node-fetch',
];

function containsScraperUserAgent(value: string): boolean {
  return SCRAPER_USER_AGENT_PATTERNS.some((pattern) => value.includes(pattern));
}

function isPrivateOrLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^169\.254(?:\.\d{1,3}){2}$/.test(host)) return true;
  const private172 = host.match(/^172\.(\d{1,3})(?:\.\d{1,3}){2}$/);
  if (private172) {
    const second = Number(private172[1]);
    return second >= 16 && second <= 31;
  }
  return false;
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
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With,X-DyrakArmy-Timestamp,X-DyrakArmy-Signature',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function jsonOk(request: Request, env: Env, data: unknown, status = 200): Response {
  return jsonResponse(request, env, data, status);
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
  return jsonResponse(request, env, payload, status);
}

function jsonResponse(request: Request, env: Env, payload: unknown, status: number): Response {
  const headers = new Headers({
    ...corsHeaders(request, env),
    'Content-Type': 'application/json; charset=utf-8',
  });
  const body = JSON.stringify(payload);
  const compressed = maybeCompressJsonBody(request, body, headers);

  return new Response(compressed, {
    status,
    headers,
  });
}

function maybeCompressJsonBody(request: Request, body: string, headers: Headers): BodyInit {
  const acceptEncoding = request.headers.get('Accept-Encoding')?.toLowerCase() ?? '';
  appendVary(headers, 'Accept-Encoding');

  if (acceptEncoding.includes('br')) {
    const stream = tryCompressionStream('br', body);
    if (stream) {
      headers.set('Content-Encoding', 'br');
      return stream;
    }
  }

  if (acceptEncoding.includes('gzip')) {
    const stream = tryCompressionStream('gzip', body);
    if (stream) {
      headers.set('Content-Encoding', 'gzip');
      return stream;
    }
  }

  return body;
}

function tryCompressionStream(format: string, body: string): ReadableStream<Uint8Array> | null {
  try {
    if (typeof CompressionStream === 'undefined') return null;
    const stream = new CompressionStream(format as CompressionFormat);
    return new Blob([body]).stream().pipeThrough(stream);
  } catch {
    return null;
  }
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get('Vary');
  if (!current) {
    headers.set('Vary', value);
    return;
  }
  const parts = current.split(',').map((part) => part.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) {
    headers.set('Vary', `${current}, ${value}`);
  }
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

export function sanitizePathComponent(value: string, fallback = 'Folder'): string {
  const safe = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 96);
  return safe || fallback;
}

export function formatPlaylistRelPath(
  playlistTitle: string,
  index: number,
  title: string,
  artist: string,
  ext: string,
  totalTracks = 99,
): { folder: string; filename: string; relpath: string } {
  const folder = sanitizePathComponent(playlistTitle || 'Playlist', 'Playlist');
  const digits = Math.max(2, String(Math.max(1, totalTracks)).length);
  const prefix = String(Math.max(1, index)).padStart(digits, '0');
  const safeArtist = sanitizePathComponent(artist || 'Unknown Artist', 'Unknown Artist');
  const safeTitle = sanitizePathComponent(title || `Track ${index}`, `Track ${index}`);
  const safeExt = sanitizePathComponent(ext || 'mp3', 'mp3').replace(/\./g, '') || 'mp3';
  const filename = `${prefix} - ${safeArtist} - ${safeTitle}.${safeExt}`;
  return {
    folder,
    filename,
    relpath: `${folder}/${filename}`,
  };
}
