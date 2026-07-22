import { downloadRouter } from './api';
import type { DownloaderSearchResult, Env } from './types';

type ExtendedEnv = Env & {
  AUDIUS_API_KEY?: string;
  JAMENDO_CLIENT_ID?: string;
  SOURCE_SEARCH_LIMIT?: string;
};

type SourceMode = 'resolver' | 'direct' | 'metadata';

export type SourceCatalogEntry = {
  id: string;
  label: string;
  mode: SourceMode;
  enabled: boolean;
  requires_key: boolean;
  rights: string;
};

export type UnifiedSourceResult = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  thumbnail?: string;
  source: string;
  url: string;
  year?: number;
  delivery: SourceMode;
  downloadable: boolean;
  license?: string;
  rights_notice: string;
};

const RESOLVER_SOURCES = ['youtube', 'spotify', 'soundcloud', 'deezer', 'apple', 'podcast'] as const;
const OPEN_SOURCES = ['internet_archive', 'wikimedia_commons', 'audius', 'jamendo', 'musicbrainz'] as const;
const RIGHTS_NOTICE = 'Use only public-domain, Creative Commons, artist-authorized or user-owned media.';

export function sourceCatalog(env: Pick<ExtendedEnv, 'AUDIUS_API_KEY' | 'JAMENDO_CLIENT_ID'>): SourceCatalogEntry[] {
  return [
    { id: 'youtube', label: 'YouTube / YouTube Music', mode: 'resolver', enabled: true, requires_key: false, rights: RIGHTS_NOTICE },
    { id: 'spotify', label: 'Spotify metadata resolver', mode: 'resolver', enabled: true, requires_key: false, rights: RIGHTS_NOTICE },
    { id: 'soundcloud', label: 'SoundCloud', mode: 'resolver', enabled: true, requires_key: false, rights: RIGHTS_NOTICE },
    { id: 'deezer', label: 'Deezer metadata resolver', mode: 'resolver', enabled: true, requires_key: false, rights: RIGHTS_NOTICE },
    { id: 'apple', label: 'Apple Music / iTunes metadata resolver', mode: 'resolver', enabled: true, requires_key: false, rights: RIGHTS_NOTICE },
    { id: 'podcast', label: 'Podcast / RSS', mode: 'resolver', enabled: true, requires_key: false, rights: RIGHTS_NOTICE },
    { id: 'internet_archive', label: 'Internet Archive audio', mode: 'direct', enabled: true, requires_key: false, rights: 'License and access terms are taken from each archive item.' },
    { id: 'wikimedia_commons', label: 'Wikimedia Commons audio', mode: 'direct', enabled: true, requires_key: false, rights: 'Each result includes its Commons license metadata.' },
    { id: 'audius', label: 'Audius Open Audio Protocol', mode: 'resolver', enabled: Boolean(env.AUDIUS_API_KEY), requires_key: true, rights: 'Only tracks explicitly exposed by the Audius API and permitted by their uploader.' },
    { id: 'jamendo', label: 'Jamendo licensed catalog', mode: 'direct', enabled: Boolean(env.JAMENDO_CLIENT_ID), requires_key: true, rights: 'Jamendo license information must remain attached to the selected track.' },
    { id: 'direct', label: 'Direct authorized audio URL', mode: 'direct', enabled: true, requires_key: false, rights: RIGHTS_NOTICE },
    { id: 'musicbrainz', label: 'MusicBrainz metadata', mode: 'metadata', enabled: true, requires_key: false, rights: 'Metadata enrichment only; MusicBrainz does not supply audio files.' },
  ];
}

export async function handleSourceDiscoveryApi(request: Request, env: ExtendedEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/sources' && request.method === 'GET') {
    const sources = sourceCatalog(env);
    return json({
      ok: true,
      version: '18.0.0',
      sources,
      enabled: sources.filter((source) => source.enabled).length,
      rights_notice: RIGHTS_NOTICE,
    }, 200, 'public, max-age=300');
  }

  if (url.pathname !== '/api/search/multi') return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== 'POST') return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed', 405, request);

  const body = await request.json().catch(() => null) as { query?: unknown; sources?: unknown; limit?: unknown } | null;
  const query = String(body?.query || '').trim();
  if (query.length < 2 || query.length > 240) return jsonError('INVALID_QUERY', 'A query between 2 and 240 characters is required', 400, request);

  const maxLimit = clamp(Number(env.SOURCE_SEARCH_LIMIT || 36), 12, 60, 36);
  const limit = clamp(Number(body?.limit || maxLimit), 1, maxLimit, maxLimit);
  const requested = normalizeRequestedSources(body?.sources, env);
  const providerTasks: Array<Promise<{ provider: string; results: UnifiedSourceResult[] }>> = [];

  for (const source of RESOLVER_SOURCES) {
    if (requested.has(source)) providerTasks.push(searchExistingResolver(request, env, query, source));
  }
  if (requested.has('internet_archive')) providerTasks.push(searchInternetArchive(query, Math.min(6, limit)));
  if (requested.has('wikimedia_commons')) providerTasks.push(searchWikimediaCommons(query, Math.min(8, limit)));
  if (requested.has('musicbrainz')) providerTasks.push(searchMusicBrainz(query, Math.min(10, limit)));
  if (requested.has('jamendo') && env.JAMENDO_CLIENT_ID) providerTasks.push(searchJamendo(query, Math.min(10, limit), env.JAMENDO_CLIENT_ID));
  if (requested.has('audius') && env.AUDIUS_API_KEY) providerTasks.push(searchAudius(query, Math.min(10, limit), env.AUDIUS_API_KEY));

  const settled = await Promise.allSettled(providerTasks);
  const providers: Record<string, { ok: boolean; count: number; error?: string }> = {};
  const all: UnifiedSourceResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      providers[outcome.value.provider] = { ok: true, count: outcome.value.results.length };
      all.push(...outcome.value.results);
    } else {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      const provider = providerNameFromError(reason);
      providers[provider] = { ok: false, count: 0, error: reason.slice(0, 180) };
    }
  }

  const results = mergeAndRankSourceResults(all, limit);
  return new Response(JSON.stringify({
    ok: true,
    query,
    results,
    total: results.length,
    providers,
    source_catalog: sourceCatalog(env),
    rights_notice: RIGHTS_NOTICE,
  }), {
    status: 200,
    headers: { ...cors(request), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function mergeAndRankSourceResults(results: UnifiedSourceResult[], limit: number): UnifiedSourceResult[] {
  const seen = new Set<string>();
  const deliveryWeight: Record<SourceMode, number> = { direct: 0, resolver: 1, metadata: 2 };
  return [...results]
    .filter((item) => item.title && item.url)
    .sort((a, b) => deliveryWeight[a.delivery] - deliveryWeight[b.delivery] || Number(b.downloadable) - Number(a.downloadable))
    .filter((item) => {
      const key = `${normalizeText(item.title)}|${normalizeText(item.artist)}|${canonicalResultUrl(item.url)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, limit));
}

async function searchExistingResolver(
  request: Request,
  env: ExtendedEnv,
  query: string,
  source: string,
): Promise<{ provider: string; results: UnifiedSourceResult[] }> {
  const internal = new Request(new URL('/api/search', request.url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: request.headers.get('Origin') || new URL(request.url).origin,
      'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') || 'source-discovery',
    },
    body: JSON.stringify({ query, source }),
  });
  const response = await downloadRouter(internal, env);
  if (!response.ok) throw new Error(`${source}: resolver returned HTTP ${response.status}`);
  const payload = await response.json() as { results?: DownloaderSearchResult[] } | DownloaderSearchResult[];
  const rows = Array.isArray(payload) ? payload : payload.results || [];
  return {
    provider: source,
    results: rows.map((row) => ({
      id: String(row.id || `${source}:${row.url}`),
      title: String(row.title || 'Untitled'),
      artist: String(row.artist || 'Unknown artist'),
      album: row.album,
      duration: Number(row.duration || 0),
      thumbnail: row.thumbnail,
      source: String(row.source || source),
      url: String(row.url || ''),
      year: row.year,
      delivery: 'resolver',
      downloadable: true,
      rights_notice: RIGHTS_NOTICE,
    })),
  };
}

async function searchMusicBrainz(query: string, limit: number): Promise<{ provider: string; results: UnifiedSourceResult[] }> {
  const url = new URL('https://musicbrainz.org/ws/2/recording/');
  url.searchParams.set('query', query);
  url.searchParams.set('fmt', 'json');
  url.searchParams.set('limit', String(limit));
  const payload = await fetchJson<{ recordings?: Array<Record<string, unknown>> }>(url, {
    headers: { 'User-Agent': 'DyrakArmy/18.0 (https://dyrakarmy.eu)' },
  }, 12000, 'musicbrainz');
  return {
    provider: 'musicbrainz',
    results: (payload.recordings || []).map((row) => {
      const credits = Array.isArray(row['artist-credit']) ? row['artist-credit'] as Array<Record<string, unknown>> : [];
      const artist = credits.map((credit) => String(credit.name || '')).filter(Boolean).join('') || 'Unknown artist';
      const id = String(row.id || '');
      return {
        id: `musicbrainz:${id}`,
        title: String(row.title || 'Untitled'),
        artist,
        duration: Math.round(Number(row.length || 0) / 1000),
        source: 'musicbrainz',
        url: `https://musicbrainz.org/recording/${encodeURIComponent(id)}`,
        year: Number.parseInt(String(row['first-release-date'] || '').slice(0, 4), 10) || undefined,
        delivery: 'metadata' as const,
        downloadable: false,
        license: 'MusicBrainz metadata',
        rights_notice: 'Metadata enrichment only; select an authorized audio result from another provider.',
      };
    }),
  };
}

async function searchInternetArchive(query: string, limit: number): Promise<{ provider: string; results: UnifiedSourceResult[] }> {
  const searchUrl = new URL('https://archive.org/advancedsearch.php');
  searchUrl.searchParams.set('q', `mediatype:audio AND (${query})`);
  for (const field of ['identifier', 'title', 'creator', 'licenseurl']) searchUrl.searchParams.append('fl[]', field);
  searchUrl.searchParams.set('rows', String(Math.min(limit, 6)));
  searchUrl.searchParams.set('page', '1');
  searchUrl.searchParams.set('output', 'json');
  const search = await fetchJson<{ response?: { docs?: Array<Record<string, unknown>> } }>(searchUrl, {}, 14000, 'internet_archive');
  const docs = search.response?.docs || [];
  const results: UnifiedSourceResult[] = [];

  await Promise.all(docs.map(async (doc) => {
    const identifier = String(doc.identifier || '');
    if (!identifier) return;
    const metadataUrl = new URL(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
    const metadata = await fetchJson<{ metadata?: Record<string, unknown>; files?: Array<Record<string, unknown>> }>(metadataUrl, {}, 14000, 'internet_archive');
    const file = selectArchiveAudioFile(metadata.files || []);
    if (!file) return;
    const name = String(file.name || '');
    const creator = firstText(metadata.metadata?.creator ?? doc.creator) || 'Internet Archive';
    const title = firstText(metadata.metadata?.title ?? doc.title) || name;
    const license = firstText(metadata.metadata?.licenseurl ?? doc.licenseurl) || 'Check item rights statement';
    results.push({
      id: `internet_archive:${identifier}:${name}`,
      title,
      artist: creator,
      duration: parseDuration(file.length),
      source: 'internet_archive',
      url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodePath(name)}`,
      delivery: 'direct',
      downloadable: true,
      license,
      rights_notice: 'Verify the Internet Archive item license before processing or redistributing the file.',
    });
  }));
  return { provider: 'internet_archive', results };
}

async function searchWikimediaCommons(query: string, limit: number): Promise<{ provider: string; results: UnifiedSourceResult[] }> {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrsearch', `filetype:audio ${query}`);
  url.searchParams.set('gsrnamespace', '6');
  url.searchParams.set('gsrlimit', String(limit));
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|mime|extmetadata');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');
  const payload = await fetchJson<{ query?: { pages?: Record<string, Record<string, unknown>> } }>(url, {}, 14000, 'wikimedia_commons');
  const pages = Object.values(payload.query?.pages || {});
  const results = pages.flatMap((page) => {
    const info = Array.isArray(page.imageinfo) ? (page.imageinfo[0] as Record<string, unknown> | undefined) : undefined;
    const mime = String(info?.mime || '');
    const directUrl = String(info?.url || '');
    if (!directUrl || !mime.startsWith('audio/')) return [];
    const ext = isRecord(info?.extmetadata) ? info.extmetadata : {};
    const title = stripFilePrefix(firstText(readMetadataValue(ext, 'ObjectName')) || String(page.title || 'Commons audio'));
    const artist = stripHtml(firstText(readMetadataValue(ext, 'Artist')) || 'Wikimedia Commons contributor');
    const license = firstText(readMetadataValue(ext, 'LicenseShortName')) || 'Check Commons file page';
    return [{
      id: `wikimedia:${String(page.pageid || directUrl)}`,
      title,
      artist,
      duration: 0,
      source: 'wikimedia_commons',
      url: directUrl,
      thumbnail: String(info?.thumburl || '') || undefined,
      delivery: 'direct' as const,
      downloadable: true,
      license,
      rights_notice: 'Keep the author and license attribution supplied by Wikimedia Commons.',
    }];
  });
  return { provider: 'wikimedia_commons', results };
}

async function searchJamendo(query: string, limit: number, clientId: string): Promise<{ provider: string; results: UnifiedSourceResult[] }> {
  const url = new URL('https://api.jamendo.com/v3.0/tracks/');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('search', query);
  url.searchParams.set('include', 'musicinfo');
  url.searchParams.set('audioformat', 'mp32');
  const payload = await fetchJson<{ results?: Array<Record<string, unknown>> }>(url, {}, 12000, 'jamendo');
  return {
    provider: 'jamendo',
    results: (payload.results || []).map((row) => ({
      id: `jamendo:${String(row.id || row.audiodownload || row.audio)}`,
      title: String(row.name || 'Untitled'),
      artist: String(row.artist_name || 'Unknown artist'),
      album: String(row.album_name || '') || undefined,
      duration: Number(row.duration || 0),
      thumbnail: String(row.image || '') || undefined,
      source: 'jamendo',
      url: String(row.audiodownload || row.audio || row.shareurl || ''),
      year: Number.parseInt(String(row.releasedate || '').slice(0, 4), 10) || undefined,
      delivery: row.audiodownload || row.audio ? 'direct' : 'metadata',
      downloadable: Boolean(row.audiodownload || row.audio),
      license: String(row.license_ccurl || row.license_ccurl || 'Jamendo license'),
      rights_notice: 'Respect the Jamendo license and attribution shown for this track.',
    })),
  };
}

async function searchAudius(query: string, limit: number, apiKey: string): Promise<{ provider: string; results: UnifiedSourceResult[] }> {
  const url = new URL('https://api.audius.co/v1/tracks/search');
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('app_name', 'DyrakArmy');
  const payload = await fetchJson<{ data?: Array<Record<string, unknown>> }>(url, {
    headers: { 'x-api-key': apiKey },
  }, 12000, 'audius');
  return {
    provider: 'audius',
    results: (payload.data || []).map((row) => {
      const user = isRecord(row.user) ? row.user : {};
      const artwork = isRecord(row.artwork) ? row.artwork : {};
      const permalink = String(row.permalink || '');
      return {
        id: `audius:${String(row.id || permalink)}`,
        title: String(row.title || 'Untitled'),
        artist: String(user.name || user.handle || 'Audius artist'),
        duration: Number(row.duration || 0),
        thumbnail: String(artwork['480x480'] || artwork['150x150'] || '') || undefined,
        source: 'audius',
        url: permalink.startsWith('http') ? permalink : `https://audius.co${permalink.startsWith('/') ? '' : '/'}${permalink}`,
        delivery: 'resolver' as const,
        downloadable: Boolean(row.is_downloadable),
        license: 'Uploader-controlled Audius track',
        rights_notice: 'Process only tracks whose uploader permits downloading or that you own.',
      };
    }),
  };
}

function normalizeRequestedSources(raw: unknown, env: ExtendedEnv): Set<string> {
  const enabled = new Set(sourceCatalog(env).filter((source) => source.enabled && source.id !== 'direct').map((source) => source.id));
  if (!Array.isArray(raw) || raw.length === 0) return enabled;
  const requested = new Set(raw.map((item) => String(item || '').trim().toLowerCase()).filter((item) => enabled.has(item)));
  return requested.size ? requested : enabled;
}

function selectArchiveAudioFile(files: Array<Record<string, unknown>>): Record<string, unknown> | null {
  const supported = /\.(mp3|ogg|opus|flac|wav|m4a)$/i;
  return files
    .filter((file) => supported.test(String(file.name || '')) && !/metadata|spectrogram|thumbnail/i.test(String(file.name || '')))
    .sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0] || null;
}

async function fetchJson<T>(url: URL, init: RequestInit, timeoutMs: number, provider: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.toString(), { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${provider}: HTTP ${response.status}`);
    return await response.json() as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${provider}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

function providerNameFromError(message: string): string {
  const candidate = message.split(':', 1)[0]?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return candidate || 'unknown';
}

function canonicalResultUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value;
  }
}

function normalizeText(value: string): string {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9а-я]+/gi, ' ').trim();
}

function parseDuration(value: unknown): number {
  const text = String(value || '').trim();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text));
  const parts = text.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0));
}

function firstText(value: unknown): string {
  if (Array.isArray(value)) return firstText(value[0]);
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function readMetadataValue(metadata: Record<string, unknown>, key: string): unknown {
  const row = metadata[key];
  return isRecord(row) && 'value' in row ? row.value : row;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripFilePrefix(value: string): string {
  return value.replace(/^File:/i, '').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
}

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function json(payload: unknown, status = 200, cacheControl = 'no-store'): Response {
  return Response.json(payload, { status, headers: { 'Cache-Control': cacheControl } });
}

function jsonError(code: string, message: string, status: number, request: Request): Response {
  return new Response(JSON.stringify({ error: { code, message, retryable: status >= 500 } }), {
    status,
    headers: { ...cors(request), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
