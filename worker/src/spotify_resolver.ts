import { handleSourceDiscoveryApi, type UnifiedSourceResult } from './source_discovery';
import type { Env } from './types';

export type SpotifyResolverEnv = Env & {
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_RESOLVER_AUTO_THRESHOLD?: string;
  SPOTIFY_RESOLVER_REVIEW_THRESHOLD?: string;
  TELEGRAM_BOT_API_BASE?: string;
  SOURCE_SEARCH_LIMIT?: string;
  AUDIUS_API_KEY?: string;
  JAMENDO_CLIENT_ID?: string;
};

export type SpotifyTrackMetadata = {
  spotify_id: string;
  title: string;
  artists: string[];
  artist: string;
  duration_ms: number;
  album?: string;
  release_date?: string;
  isrc?: string;
  image_url?: string;
  preview_url?: string;
  playback_url: string;
  metadata_source: 'spotify_web_api' | 'spotify_oembed';
};

export type SpotifyResolverCandidate = UnifiedSourceResult & {
  score: number;
  authorized: boolean;
  score_breakdown: {
    title: number;
    artist: number;
    duration: number;
    rights_trust: number;
    penalty: number;
  };
  warnings: string[];
};

export type SpotifyResolverDecision = {
  action: 'download' | 'review' | 'playback';
  metadata: SpotifyTrackMetadata;
  candidates: SpotifyResolverCandidate[];
  selected?: SpotifyResolverCandidate;
  thresholds: { auto: number; review: number };
  reason: string;
  safety: {
    spotify_stream_download: false;
    drm_or_key_extraction: false;
    authorized_external_sources_only: true;
  };
};

type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: { id?: number; type?: string };
    from?: { id?: number; first_name?: string };
    text?: string;
  };
};

const SPOTIFY_TRACK_RE = /(?:https?:\/\/open\.spotify\.com\/track\/|spotify:track:)([A-Za-z0-9]+)/i;
const NEGATIVE_VARIANTS = ['cover', 'karaoke', 'remix', 'live', 'slowed', 'reverb', 'nightcore', 'instrumental', 'sped up', '8d'];
const EXPLICIT_RIGHTS = [
  'creativecommons.org',
  'creative commons',
  'public domain',
  'cc-by',
  'cc by',
  'cc0',
  'attribution',
  'artist-authorized',
  'artist authorized',
  'downloadable by uploader',
];
const DENIED_RIGHTS = ['all rights reserved', 'standard youtube license', 'fair use', 'no derivative', 'no-derivatives'];

export function extractSpotifyTrackUrl(value: string): string | null {
  const match = String(value || '').match(SPOTIFY_TRACK_RE);
  return match?.[1] ? `https://open.spotify.com/track/${match[1]}` : null;
}

function spotifyTrackId(value: string): string | null {
  return String(value || '').match(SPOTIFY_TRACK_RE)?.[1] || null;
}

function clampInt(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(minimum, Math.min(maximum, safe));
}

function normalizeText(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('bg-BG')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSimilarity(left: string, right: string): number {
  const a = new Set(normalizeText(left).split(' ').filter(Boolean));
  const b = new Set(normalizeText(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

function levenshtein(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length] || 0;
}

export function spotifyTextSimilarity(left: string, right: string): number {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  const maxLength = Math.max([...a].length, [...b].length);
  const edit = maxLength ? 1 - levenshtein(a, b) / maxLength : 0;
  const token = tokenSimilarity(a, b);
  const containment = a.includes(b) || b.includes(a) ? 0.94 : 0;
  return Math.max(0, Math.min(1, edit, Number.POSITIVE_INFINITY), token, containment);
}

export function hasExplicitSpotifyResolverRights(license?: string, rightsNotice?: string): boolean {
  const combined = `${license || ''} ${rightsNotice || ''}`.toLocaleLowerCase('en-US');
  if (DENIED_RIGHTS.some((marker) => combined.includes(marker))) return false;
  return EXPLICIT_RIGHTS.some((marker) => combined.includes(marker));
}

function variantPenalty(metadata: SpotifyTrackMetadata, candidate: UnifiedSourceResult): { penalty: number; warnings: string[] } {
  const target = normalizeText(`${metadata.title} ${metadata.artist}`);
  const actual = normalizeText(`${candidate.title} ${candidate.artist}`);
  const warnings: string[] = [];
  let penalty = 0;
  for (const marker of NEGATIVE_VARIANTS) {
    if (actual.includes(marker) && !target.includes(marker)) {
      penalty += 12;
      warnings.push(`variant:${marker}`);
    }
  }
  return { penalty: Math.min(36, penalty), warnings };
}

export function scoreSpotifyResolverCandidate(
  metadata: SpotifyTrackMetadata,
  candidate: UnifiedSourceResult,
): SpotifyResolverCandidate {
  const title = Math.round(45 * spotifyTextSimilarity(metadata.title, candidate.title));
  const artist = Math.round(30 * spotifyTextSimilarity(metadata.artist, candidate.artist));
  let duration = 3;
  const candidateDurationMs = Math.max(0, Math.round(Number(candidate.duration || 0) * 1000));
  if (metadata.duration_ms > 0 && candidateDurationMs > 0) {
    const delta = Math.abs(metadata.duration_ms - candidateDurationMs);
    duration = delta <= 1_500 ? 15 : delta <= 3_000 ? 13 : delta <= 6_000 ? 10 : delta <= 12_000 ? 5 : 0;
  }

  const authorized = candidate.downloadable
    && hasExplicitSpotifyResolverRights(candidate.license, candidate.rights_notice);
  const providerTrust: Record<string, number> = {
    jamendo: 10,
    internet_archive: 9,
    wikimedia_commons: 9,
    soundcloud: 7,
    youtube: 6,
    audius: 6,
  };
  const rightsTrust = authorized ? (providerTrust[candidate.source] || 4) : 0;
  const variant = variantPenalty(metadata, candidate);
  let penalty = variant.penalty;
  const warnings = [...variant.warnings];
  if (!authorized) warnings.push('rights:not-explicit');
  if (!candidate.downloadable) {
    warnings.push('not-downloadable');
    penalty += 20;
  }
  const score = Math.max(0, Math.min(100, title + artist + duration + rightsTrust - penalty));

  return {
    ...candidate,
    score,
    authorized,
    score_breakdown: { title, artist, duration, rights_trust: rightsTrust, penalty },
    warnings,
  };
}

export function chooseSpotifyResolverDecision(
  metadata: SpotifyTrackMetadata,
  candidates: UnifiedSourceResult[],
  autoThreshold = 88,
  reviewThreshold = 76,
): SpotifyResolverDecision {
  const ranked = candidates
    .map((candidate) => scoreSpotifyResolverCandidate(metadata, candidate))
    .sort((left, right) => right.score - left.score || Number(right.authorized) - Number(left.authorized));
  const selected = ranked[0];
  const safety = {
    spotify_stream_download: false as const,
    drm_or_key_extraction: false as const,
    authorized_external_sources_only: true as const,
  };

  if (selected?.authorized && selected.downloadable && selected.score >= autoThreshold) {
    return {
      action: 'download',
      metadata,
      candidates: ranked,
      selected,
      thresholds: { auto: autoThreshold, review: reviewThreshold },
      reason: 'Authorized source exceeded the automatic confidence threshold.',
      safety,
    };
  }
  if (selected && selected.score >= reviewThreshold) {
    return {
      action: 'review',
      metadata,
      candidates: ranked,
      selected,
      thresholds: { auto: autoThreshold, review: reviewThreshold },
      reason: 'A possible match was found, but it requires user review or clearer rights metadata.',
      safety,
    };
  }
  return {
    action: 'playback',
    metadata,
    candidates: ranked,
    selected,
    thresholds: { auto: autoThreshold, review: reviewThreshold },
    reason: 'No authorized candidate reached the minimum confidence threshold.',
    safety,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function spotifyClientToken(env: SpotifyResolverEnv): Promise<string | null> {
  const clientId = String(env.SPOTIFY_CLIENT_ID || '').trim();
  const clientSecret = String(env.SPOTIFY_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const response = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  });
  if (!response.ok) throw new Error(`Spotify token endpoint returned HTTP ${response.status}`);
  const payload = await response.json() as { access_token?: string };
  return String(payload.access_token || '').trim() || null;
}

function metaContent(page: string, property: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = page.match(pattern);
    if (match?.[1]) return match[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
  }
  return '';
}

async function fetchSpotifyMetadata(value: string, env: SpotifyResolverEnv): Promise<SpotifyTrackMetadata> {
  const spotifyId = spotifyTrackId(value);
  if (!spotifyId) throw new Error('A Spotify track URL or URI is required');
  const playbackUrl = `https://open.spotify.com/track/${spotifyId}`;

  try {
    const token = await spotifyClientToken(env);
    if (token) {
      const response = await fetchWithTimeout(`https://api.spotify.com/v1/tracks/${encodeURIComponent(spotifyId)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Spotify track endpoint returned HTTP ${response.status}`);
      const payload = await response.json() as Record<string, unknown>;
      const artists = Array.isArray(payload.artists)
        ? payload.artists.map((item) => String((item as Record<string, unknown>).name || '').trim()).filter(Boolean)
        : [];
      const album = payload.album && typeof payload.album === 'object' ? payload.album as Record<string, unknown> : {};
      const images = Array.isArray(album.images) ? album.images as Array<Record<string, unknown>> : [];
      const externalIds = payload.external_ids && typeof payload.external_ids === 'object'
        ? payload.external_ids as Record<string, unknown>
        : {};
      return {
        spotify_id: spotifyId,
        title: String(payload.name || 'Unknown Title').trim(),
        artists: artists.length ? artists : ['Unknown Artist'],
        artist: artists.length ? artists.join(', ') : 'Unknown Artist',
        duration_ms: Math.max(0, Number(payload.duration_ms || 0)),
        album: String(album.name || '').trim() || undefined,
        release_date: String(album.release_date || '').trim() || undefined,
        isrc: String(externalIds.isrc || '').trim() || undefined,
        image_url: String(images[0]?.url || '').trim() || undefined,
        preview_url: String(payload.preview_url || '').trim() || undefined,
        playback_url: playbackUrl,
        metadata_source: 'spotify_web_api',
      };
    }
  } catch (error) {
    console.warn('Spotify Web API metadata unavailable; using public metadata fallback', error);
  }

  let title = 'Unknown Title';
  let artist = 'Unknown Artist';
  let imageUrl = '';
  let previewUrl = '';
  try {
    const response = await fetchWithTimeout(`https://open.spotify.com/oembed?url=${encodeURIComponent(playbackUrl)}`);
    if (response.ok) {
      const payload = await response.json() as Record<string, unknown>;
      title = String(payload.title || title).trim();
      imageUrl = String(payload.thumbnail_url || '').trim();
    }
  } catch {}
  try {
    const response = await fetchWithTimeout(playbackUrl, { headers: { Accept: 'text/html' } });
    if (response.ok) {
      const page = await response.text();
      const description = metaContent(page, 'og:description');
      const parts = description.split(/[·•]/).map((part) => part.trim()).filter(Boolean);
      if (parts[0]) artist = parts[0];
      const preview = page.match(/"audioPreview"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/);
      if (preview?.[1]) previewUrl = preview[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    }
  } catch {}

  return {
    spotify_id: spotifyId,
    title,
    artists: [artist],
    artist,
    duration_ms: 0,
    image_url: imageUrl || undefined,
    preview_url: previewUrl || undefined,
    playback_url: playbackUrl,
    metadata_source: 'spotify_oembed',
  };
}

async function searchSpotifyCandidates(
  request: Request,
  env: SpotifyResolverEnv,
  metadata: SpotifyTrackMetadata,
): Promise<UnifiedSourceResult[]> {
  const internal = new Request(new URL('/api/search/multi', request.url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: request.headers.get('Origin') || new URL(request.url).origin,
      'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') || 'spotify-resolver',
    },
    body: JSON.stringify({
      query: `${metadata.artist} ${metadata.title}`,
      sources: [
        'internet_archive',
        'wikimedia_commons',
        'jamendo',
        'audius',
        'soundcloud',
        'youtube',
        'musicbrainz',
      ],
      limit: 36,
    }),
  });
  const response = await handleSourceDiscoveryApi(internal, env);
  if (!response || !response.ok) return [];
  const payload = await response.json() as { results?: UnifiedSourceResult[] };
  return Array.isArray(payload.results) ? payload.results : [];
}

export async function resolveSpotifyReference(
  request: Request,
  env: SpotifyResolverEnv,
  spotifyUrl: string,
): Promise<SpotifyResolverDecision> {
  const metadata = await fetchSpotifyMetadata(spotifyUrl, env);
  const candidates = await searchSpotifyCandidates(request, env, metadata);
  const auto = clampInt(env.SPOTIFY_RESOLVER_AUTO_THRESHOLD, 88, 80, 99);
  const review = clampInt(env.SPOTIFY_RESOLVER_REVIEW_THRESHOLD, 76, 60, auto - 1);
  return chooseSpotifyResolverDecision(metadata, candidates, auto, review);
}

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('Origin');
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  };
}

export async function handleSpotifyResolverApi(
  request: Request,
  env: SpotifyResolverEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/spotify/resolve') return null;
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request),
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', retryable: false } }, { status: 405 });
  }
  const body = await request.json().catch(() => null) as { url?: unknown } | null;
  const spotifyUrl = extractSpotifyTrackUrl(String(body?.url || ''));
  if (!spotifyUrl) {
    return new Response(JSON.stringify({ error: { code: 'SPOTIFY_TRACK_REQUIRED', message: 'A Spotify track URL is required', retryable: false } }), {
      status: 400,
      headers: corsHeaders(request),
    });
  }
  try {
    const decision = await resolveSpotifyReference(request, env, spotifyUrl);
    return new Response(JSON.stringify({ ok: true, ...decision }), { status: 200, headers: corsHeaders(request) });
  } catch (error) {
    return new Response(JSON.stringify({
      error: {
        code: 'SPOTIFY_RESOLVER_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    }), { status: 502, headers: corsHeaders(request) });
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index]! ^ b[index]!;
  return mismatch === 0;
}

async function telegramRequest(
  method: string,
  payload: Record<string, unknown>,
  env: SpotifyResolverEnv,
): Promise<boolean> {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return false;
  const base = String(env.TELEGRAM_BOT_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
  const response = await fetchWithTimeout(`${base}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 20_000);
  const result = await response.json().catch(() => ({})) as { ok?: boolean };
  return response.ok && result.ok === true;
}

function telegramFallbackText(decision: SpotifyResolverDecision): string {
  const selected = decision.selected;
  const scoreLine = selected
    ? `\n🔎 Най-близък кандидат: ${selected.source} · ${selected.score}%`
    : '';
  const reason = decision.action === 'review'
    ? 'Намерено е възможно съвпадение, но правата или точността не са достатъчни за автоматично сваляне.'
    : 'Не е намерен разрешен аудиоизточник с достатъчно висока точност.';
  return [
    '🎧 Spotify песента е разпозната',
    '',
    `${decision.metadata.artist} — ${decision.metadata.title}`,
    decision.metadata.duration_ms > 0 ? `⏱ ${Math.round(decision.metadata.duration_ms / 1000)} сек.` : '',
    '',
    reason,
    scoreLine,
    '',
    'Spotify се използва за метаданни и възпроизвеждане. Не се извлича или декриптира Spotify аудиопоток.',
  ].filter(Boolean).join('\n');
}

export async function handleSpotifyTelegramResolverWebhook(
  request: Request,
  env: SpotifyResolverEnv,
): Promise<{ response?: Response; request?: Request } | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/telegram/webhook' || request.method !== 'POST') return null;
  const providedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!constantTimeEqual(providedSecret, String(env.TELEGRAM_SECRET_TOKEN || ''))) return null;

  const rawBody = await request.text();
  let update: TelegramUpdate;
  try {
    update = JSON.parse(rawBody) as TelegramUpdate;
  } catch {
    return null;
  }
  const message = update.message;
  const chatId = Number(message?.chat?.id || 0);
  if (!message || message.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0) return null;
  const spotifyUrl = extractSpotifyTrackUrl(String(message.text || ''));
  if (!spotifyUrl) return null;

  let decision: SpotifyResolverDecision;
  try {
    decision = await resolveSpotifyReference(request, env, spotifyUrl);
  } catch (error) {
    await telegramRequest('sendMessage', {
      chat_id: chatId,
      text: `⚠️ Spotify метаданните временно не са достъпни.\n\n${error instanceof Error ? error.message : String(error)}`,
      reply_markup: { inline_keyboard: [[{ text: '▶️ Отвори в Spotify', url: spotifyUrl }]] },
    }, env);
    return { response: Response.json({ ok: true, spotify_resolver: 'metadata-unavailable' }) };
  }

  if (decision.action === 'download' && decision.selected) {
    const rewritten: TelegramUpdate = {
      ...update,
      message: {
        ...message,
        text: decision.selected.url,
      },
    };
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    headers.set('X-DyrakArmy-Spotify-Reference', decision.metadata.spotify_id);
    headers.set('X-DyrakArmy-Resolver-Confidence', String(decision.selected.score));
    return {
      request: new Request(request.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(rewritten),
      }),
    };
  }

  const keyboard: Array<Array<Record<string, string>>> = [
    [{ text: '▶️ Отвори в Spotify', url: decision.metadata.playback_url }],
  ];
  if (decision.selected?.url) {
    keyboard.push([{ text: `🔎 Прегледай кандидат ${decision.selected.score}%`, url: decision.selected.url }]);
  }
  const publicBase = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (publicBase.startsWith('https://')) {
    keyboard.push([{ text: '🌐 Отвори DyrakArmy', url: `${publicBase}/telegram/` }]);
  }

  await telegramRequest('sendMessage', {
    chat_id: chatId,
    text: telegramFallbackText(decision),
    disable_web_page_preview: false,
    reply_markup: { inline_keyboard: keyboard },
  }, env);
  return {
    response: Response.json({
      ok: true,
      spotify_resolver: decision.action,
      confidence: decision.selected?.score || 0,
      queued: false,
    }),
  };
}
