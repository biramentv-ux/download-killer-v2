import type { Env } from './types';
import { validateUrlPolicy } from './utils';

export interface MediaCandidate {
  id?: string;
  title?: string;
  artist?: string;
  album?: string | null;
  duration?: number | null;
  source?: string;
  url?: string;
  thumbnail?: string | null;
}

export interface MediaReference {
  title?: string;
  artist?: string;
  album?: string | null;
  duration?: number | null;
  source?: string;
}

export interface RankedCandidate extends MediaCandidate {
  score: number;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
}

interface UrlInspection {
  ok: boolean;
  requested_url: string;
  final_url: string;
  redirects: string[];
  status: number;
  method: 'HEAD' | 'GET_RANGE';
  filename: string;
  content_type: string;
  content_length: number | null;
  size_text: string;
  supports_ranges: boolean;
  category: 'audio' | 'video' | 'image' | 'archive' | 'document' | 'binary' | 'unknown';
  etag: string | null;
  last_modified: string | null;
  cache_control: string | null;
  warnings: string[];
}

const MAX_REDIRECTS = 5;
const INSPECT_TIMEOUT_MS = 12_000;
const MAX_CANDIDATES = 40;

function jsonResponse(request: Request, payload: unknown, status = 200): Response {
  const origin = request.headers.get('Origin') ?? '*';
  return Response.json(payload, {
    status,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
    },
  });
}

function errorResponse(request: Request, code: string, message: string, status: number): Response {
  return jsonResponse(request, { error: { code, message, retryable: status >= 500 } }, status);
}

async function readJson<T>(request: Request): Promise<T | null> {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(length) && length > 128 * 1024) return null;
  try {
    return await request.json() as T;
  } catch {
    return null;
  }
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(feat(?:uring)?|ft|with)\.?\s+[^([\]-]+/g, ' ')
    .replace(/[([{].*?(remaster(?:ed)?|live|official|video|audio|lyrics?|version|edit|mix).*?[)\]}]/g, ' ')
    .replace(/\b(remaster(?:ed)?|official video|official audio|lyrics?|music video|audio only)\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizeText(value).split(' ').filter((token) => token.length > 1));
}

function jaccard(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function bigramDice(left: string, right: string): number {
  const a = normalizeText(left).replace(/\s+/g, '');
  const b = normalizeText(right).replace(/\s+/g, '');
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < a.length - 1; index += 1) {
    const pair = a.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const pair = b.slice(index, index + 2);
    const count = counts.get(pair) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(pair, count - 1);
    }
  }
  return (2 * overlap) / ((a.length - 1) + (b.length - 1));
}

function textSimilarity(left: string, right: string): number {
  return (jaccard(left, right) * 0.58) + (bigramDice(left, right) * 0.42);
}

function durationSimilarity(reference: number | null | undefined, candidate: number | null | undefined): number {
  const ref = Number(reference ?? 0);
  const value = Number(candidate ?? 0);
  if (!Number.isFinite(ref) || !Number.isFinite(value) || ref <= 0 || value <= 0) return 0.55;
  const tolerance = Math.max(8, ref * 0.1);
  return Math.max(0, 1 - (Math.abs(ref - value) / tolerance));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

export function rankMediaCandidates(reference: MediaReference, candidates: MediaCandidate[]): RankedCandidate[] {
  const refTitle = String(reference.title ?? '');
  const refArtist = String(reference.artist ?? '');
  const refAlbum = String(reference.album ?? '');
  const refSource = normalizeText(reference.source ?? '');

  const ranked: RankedCandidate[] = candidates.slice(0, MAX_CANDIDATES).map((candidate): RankedCandidate => {
    const titleScore = textSimilarity(refTitle, String(candidate.title ?? ''));
    const artistScore = textSimilarity(refArtist, String(candidate.artist ?? ''));
    const albumScore = refAlbum && candidate.album ? textSimilarity(refAlbum, String(candidate.album)) : 0.55;
    const timeScore = durationSimilarity(reference.duration, candidate.duration);
    const candidateSource = normalizeText(candidate.source ?? '');
    const sourceMultiplier = refSource && candidateSource === refSource ? 0.55 : 1;
    const exactTitle = normalizeText(refTitle) !== '' && normalizeText(refTitle) === normalizeText(candidate.title ?? '');
    const exactArtist = normalizeText(refArtist) !== '' && normalizeText(refArtist) === normalizeText(candidate.artist ?? '');

    let weighted = (titleScore * 0.5) + (artistScore * 0.27) + (timeScore * 0.16) + (albumScore * 0.07);
    weighted *= sourceMultiplier;
    if (exactTitle) weighted += 0.04;
    if (exactArtist) weighted += 0.03;
    const score = clampScore(weighted);
    const confidence: RankedCandidate['confidence'] = score >= 82 ? 'high' : score >= 62 ? 'medium' : 'low';
    const reasons: string[] = [];
    if (exactTitle) reasons.push('exact-title');
    else if (titleScore >= 0.8) reasons.push('strong-title');
    if (exactArtist) reasons.push('exact-artist');
    else if (artistScore >= 0.78) reasons.push('strong-artist');
    if (timeScore >= 0.85) reasons.push('duration-close');
    if (albumScore >= 0.82 && refAlbum) reasons.push('album-close');
    if (refSource && candidateSource !== refSource) reasons.push('alternate-source');

    return { ...candidate, score, confidence, reasons };
  });

  return ranked.sort((left, right) => right.score - left.score);
}

export function parseContentDispositionFilename(header: string | null, fallbackUrl: string): string {
  if (header) {
    const encoded = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
    if (encoded) {
      try {
        return sanitizeFilename(decodeURIComponent(encoded.replace(/^['"]|['"]$/g, '')));
      } catch {
        // Continue with regular filename parsing.
      }
    }
    const regular = header.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
    const filename = regular?.[1] ?? regular?.[2];
    if (filename) return sanitizeFilename(filename.trim().replace(/^['"]|['"]$/g, ''));
  }
  try {
    const path = new URL(fallbackUrl).pathname;
    const finalSegment = path.split('/').filter(Boolean).pop() ?? 'download';
    return sanitizeFilename(decodeURIComponent(finalSegment));
  } catch {
    return 'download';
  }
}

function sanitizeFilename(value: string): string {
  const safe = String(value || 'download')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 180);
  return safe || 'download';
}

function categoryFor(contentType: string): UrlInspection['category'] {
  const value = contentType.toLowerCase();
  if (value.startsWith('audio/')) return 'audio';
  if (value.startsWith('video/')) return 'video';
  if (value.startsWith('image/')) return 'image';
  if (value.includes('zip') || value.includes('rar') || value.includes('7z') || value.includes('tar')) return 'archive';
  if (value.startsWith('text/') || value.includes('pdf') || value.includes('document') || value.includes('json') || value.includes('xml')) return 'document';
  if (value === 'application/octet-stream') return 'binary';
  return value ? 'binary' : 'unknown';
}

function formatBytes(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value < 0) return 'unknown';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function contentLengthFrom(response: Response): number | null {
  const range = response.headers.get('Content-Range');
  const total = range?.match(/\/(\d+)$/)?.[1];
  const raw = total ?? response.headers.get('Content-Length');
  const value = Number(raw ?? Number.NaN);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function cancelBody(response: Response | null): void {
  if (response?.body) void response.body.cancel();
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = INSPECT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function inspectPublicUrl(rawUrl: string, env: Env): Promise<UrlInspection> {
  let currentUrl = rawUrl;
  const redirects: string[] = [];
  const warnings: string[] = [];
  let response: Response | null = null;
  let method: UrlInspection['method'] = 'HEAD';

  for (let index = 0; index <= MAX_REDIRECTS; index += 1) {
    const policy = validateUrlPolicy(currentUrl, env);
    if (!policy.allowed) throw new Error(policy.message ?? 'URL is blocked by policy');

    try {
      response = await fetchWithTimeout(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { Accept: '*/*', 'User-Agent': 'Download-Killer-Media-Lab/1.0' },
      });
      method = 'HEAD';
    } catch {
      response = null;
    }

    if (!response || [400, 403, 405, 429, 500, 501].includes(response.status)) {
      cancelBody(response);
      response = await fetchWithTimeout(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: '*/*', Range: 'bytes=0-0', 'User-Agent': 'Download-Killer-Media-Lab/1.0' },
      });
      method = 'GET_RANGE';
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      cancelBody(response);
      if (!location) throw new Error('Redirect response did not include a Location header');
      if (index === MAX_REDIRECTS) throw new Error('Too many redirects');
      currentUrl = new URL(location, currentUrl).toString();
      redirects.push(currentUrl);
      continue;
    }
    break;
  }

  if (!response) throw new Error('Unable to inspect URL');
  const contentType = (response.headers.get('Content-Type') ?? '').split(';')[0]?.trim() ?? '';
  const contentLength = contentLengthFrom(response);
  const supportsRanges = response.status === 206 || /\bbytes\b/i.test(response.headers.get('Accept-Ranges') ?? '');
  const filename = parseContentDispositionFilename(response.headers.get('Content-Disposition'), currentUrl);
  if (method === 'GET_RANGE' && response.status === 200 && contentLength == null) warnings.push('origin-ignored-range-request');
  if (!contentType) warnings.push('content-type-missing');
  if (contentLength == null) warnings.push('content-length-unknown');
  cancelBody(response);

  return {
    ok: response.ok || response.status === 206,
    requested_url: rawUrl,
    final_url: currentUrl,
    redirects,
    status: response.status,
    method,
    filename,
    content_type: contentType || 'unknown',
    content_length: contentLength,
    size_text: formatBytes(contentLength),
    supports_ranges: supportsRanges,
    category: categoryFor(contentType),
    etag: response.headers.get('ETag'),
    last_modified: response.headers.get('Last-Modified'),
    cache_control: response.headers.get('Cache-Control'),
    warnings,
  };
}

export async function handleMediaLabApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/media-lab/')) return null;
  if (request.method === 'OPTIONS') return jsonResponse(request, { ok: true }, 204);

  if (url.pathname === '/api/media-lab/inspect' && request.method === 'POST') {
    const body = await readJson<{ url?: string }>(request);
    const rawUrl = String(body?.url ?? '').trim();
    if (!rawUrl) return errorResponse(request, 'URL_REQUIRED', 'url is required', 400);
    const policy = validateUrlPolicy(rawUrl, env);
    if (!policy.allowed) return errorResponse(request, 'URL_BLOCKED', policy.message ?? 'URL is blocked', 400);
    try {
      return jsonResponse(request, { ok: true, inspection: await inspectPublicUrl(rawUrl, env) });
    } catch (error) {
      return errorResponse(request, 'INSPECTION_FAILED', error instanceof Error ? error.message : String(error), 502);
    }
  }

  if (url.pathname === '/api/media-lab/rank' && request.method === 'POST') {
    const body = await readJson<{ reference?: MediaReference; candidates?: MediaCandidate[] }>(request);
    const reference = body?.reference;
    const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
    if (!reference || !String(reference.title ?? '').trim()) {
      return errorResponse(request, 'REFERENCE_REQUIRED', 'reference.title is required', 400);
    }
    if (!candidates.length) return errorResponse(request, 'CANDIDATES_REQUIRED', 'candidates are required', 400);
    return jsonResponse(request, { ok: true, reference, results: rankMediaCandidates(reference, candidates) });
  }

  if (url.pathname === '/api/media-lab/about' && request.method === 'GET') {
    return jsonResponse(request, {
      ok: true,
      features: ['url-inspection', 'range-detection', 'metadata-preview', 'cross-source-ranking'],
      inspirations: [
        { project: 'SaveHere', license: 'Apache-2.0', url: 'https://github.com/gudarzi/SaveHere' },
        { project: 'FluentDL', license: 'MIT', url: 'https://github.com/DerekYang2/FluentDL' },
      ],
    });
  }

  return errorResponse(request, 'NOT_FOUND', 'Media Lab endpoint not found', 404);
}
