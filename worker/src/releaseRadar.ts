import { fetchDownloaderWithFailover } from './origins';
import { recordTelemetry } from './telemetry';
import type { Env } from './types';
import { getClientAddress, jsonError, jsonOk, parseJson, rateLimit, readEnvInt } from './utils';

interface ReleaseRadarCreateBody {
  sync_key?: string;
  artist?: string;
  source?: string;
  chat_id?: number;
}

interface ReleaseRadarDeleteBody {
  id?: string;
  sync_key?: string;
}

interface ReleaseRadarArtistRow {
  id: string;
  sync_key: string | null;
  chat_id: number | null;
  artist: string;
  source: string;
  last_seen_key: string | null;
  last_seen_title: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
}

interface DiscographyTrack {
  title?: string;
  artist?: string;
  source?: string;
  url?: string;
}

let releaseRadarSchemaReady: Promise<void> | null = null;

export async function handleReleaseRadarGet(request: Request, env: Env): Promise<Response> {
  await ensureReleaseRadarSchema(env);
  const url = new URL(request.url);
  const syncKey = normalizeSyncKey(url.searchParams.get('sync_key') ?? '');
  if (!syncKey) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'A valid sync_key is required', 400);
  }

  const rows = await env.DB.prepare(
    `SELECT id, sync_key, chat_id, artist, source, last_seen_key, last_seen_title, enabled,
            created_at, updated_at, last_checked_at
     FROM release_radar_artists
     WHERE sync_key = ?
     ORDER BY updated_at DESC
     LIMIT 100`,
  ).bind(syncKey).all<ReleaseRadarArtistRow>();

  return jsonOk(request, env, {
    artists: (rows.results ?? []).map(sanitizeRadarRow),
    total: rows.results?.length ?? 0,
  });
}

export async function handleReleaseRadarPost(request: Request, env: Env): Promise<Response> {
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `release-radar:${ip}`, 20, 60);
  if (rl.limited) {
    return jsonError(request, env, 'RATE_LIMITED', 'Too many Release Radar requests', 429, true);
  }

  const body = await parseJson<ReleaseRadarCreateBody>(request);
  const syncKey = normalizeSyncKey(body?.sync_key ?? '');
  const artist = normalizeArtist(body?.artist ?? '');
  const source = normalizeRadarSource(body?.source ?? 'spotify');
  if (!syncKey) {
    return jsonError(request, env, 'INVALID_SYNC_KEY', 'A valid sync_key is required', 400);
  }
  if (!artist) {
    return jsonError(request, env, 'INVALID_ARTIST', 'Artist is required', 400);
  }

  await ensureReleaseRadarSchema(env);
  const id = await radarId(syncKey, artist, source);
  const chatId = Number.isFinite(Number(body?.chat_id)) ? Number(body?.chat_id) : null;
  await env.DB.prepare(
    `INSERT INTO release_radar_artists (
       id, sync_key, chat_id, artist, source, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       chat_id = COALESCE(excluded.chat_id, release_radar_artists.chat_id),
       artist = excluded.artist,
       source = excluded.source,
       enabled = 1,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(id, syncKey, chatId, artist, source).run();

  await recordTelemetry(env, {
    event: 'release_radar_artist_saved',
    status: '200',
    source,
    code: artist,
  });

  return jsonOk(request, env, {
    ok: true,
    artist: {
      id,
      sync_key: syncKey,
      chat_id: chatId,
      artist,
      source,
      enabled: true,
    },
  });
}

export async function handleReleaseRadarDelete(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<ReleaseRadarDeleteBody>(request);
  const id = String(body?.id ?? '').trim();
  const syncKey = normalizeSyncKey(body?.sync_key ?? '');
  if (!id || !syncKey) {
    return jsonError(request, env, 'INVALID_RELEASE_RADAR_DELETE', 'id and sync_key are required', 400);
  }

  await ensureReleaseRadarSchema(env);
  await env.DB.prepare(
    `UPDATE release_radar_artists
     SET enabled = 0,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND sync_key = ?`,
  ).bind(id, syncKey).run();

  return jsonOk(request, env, { ok: true, id, enabled: false });
}

export async function runReleaseRadarChecks(env: Env): Promise<{ checked: number; notified: number }> {
  await ensureReleaseRadarSchema(env);
  const limit = Math.max(1, Math.min(50, readEnvInt(env.RELEASE_RADAR_MAX_CHECKS, 20)));
  const rows = await env.DB.prepare(
    `SELECT id, sync_key, chat_id, artist, source, last_seen_key, last_seen_title, enabled,
            created_at, updated_at, last_checked_at
     FROM release_radar_artists
     WHERE enabled = 1
     ORDER BY COALESCE(last_checked_at, created_at) ASC
     LIMIT ?`,
  ).bind(limit).all<ReleaseRadarArtistRow>();

  let checked = 0;
  let notifications = 0;
  for (const row of rows.results ?? []) {
    try {
      const latest = await fetchLatestRelease(row, env);
      if (!latest) {
        await markRadarChecked(env, row.id, row.last_seen_key, row.last_seen_title);
        checked += 1;
        continue;
      }

      const latestKey = await radarReleaseKey(latest);
      const firstRun = !row.last_seen_key;
      const changed = Boolean(row.last_seen_key && row.last_seen_key !== latestKey);
      await markRadarChecked(env, row.id, latestKey, latest.title ?? row.artist);

      if (changed) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO release_radar_events (
             id, radar_id, sync_key, chat_id, artist, source, release_key, title, url, notified, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`,
        ).bind(
          crypto.randomUUID(),
          row.id,
          row.sync_key,
          row.chat_id,
          row.artist,
          latest.source ?? row.source,
          latestKey,
          latest.title ?? row.artist,
          latest.url ?? null,
        ).run();
        const notified = await notifyReleaseRadar(row, latest, env);
        if (notified) {
          notifications += 1;
          await env.DB.prepare(
            `UPDATE release_radar_events
             SET notified = 1
             WHERE radar_id = ? AND release_key = ?`,
          ).bind(row.id, latestKey).run();
        }
      }
      checked += 1;

      await recordTelemetry(env, {
        event: 'release_radar_checked',
        status: '200',
        source: row.source,
        code: firstRun ? 'BASELINE' : changed ? 'NEW_RELEASE' : 'UNCHANGED',
      });
    } catch (error) {
      await recordTelemetry(env, {
        event: 'release_radar_checked',
        status: '500',
        source: row.source,
        code: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
      });
    }
  }

  return { checked, notified: notifications };
}

export async function addTelegramReleaseRadarArtist(
  chatId: number,
  artistRaw: string,
  sourceRaw: string | undefined,
  env: Env,
): Promise<{ ok: boolean; id?: string; artist?: string; source?: string; error?: string }> {
  const artist = normalizeArtist(artistRaw);
  if (!artist) return { ok: false, error: 'INVALID_ARTIST' };
  const source = normalizeRadarSource(sourceRaw ?? 'spotify');
  const syncKey = `tg_${Math.abs(chatId)}`;
  await ensureReleaseRadarSchema(env);
  const id = await radarId(syncKey, artist, source);
  await env.DB.prepare(
    `INSERT INTO release_radar_artists (
       id, sync_key, chat_id, artist, source, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       chat_id = excluded.chat_id,
       artist = excluded.artist,
       source = excluded.source,
       enabled = 1,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(id, syncKey, chatId, artist, source).run();
  return { ok: true, id, artist, source };
}

export async function listTelegramReleaseRadarArtists(chatId: number, env: Env): Promise<Array<Record<string, unknown>>> {
  await ensureReleaseRadarSchema(env);
  const rows = await env.DB.prepare(
    `SELECT id, sync_key, chat_id, artist, source, last_seen_key, last_seen_title, enabled,
            created_at, updated_at, last_checked_at
     FROM release_radar_artists
     WHERE chat_id = ? AND enabled = 1
     ORDER BY updated_at DESC
     LIMIT 50`,
  ).bind(chatId).all<ReleaseRadarArtistRow>();
  return (rows.results ?? []).map(sanitizeRadarRow);
}

async function ensureReleaseRadarSchema(env: Env): Promise<void> {
  if (!releaseRadarSchemaReady) {
    releaseRadarSchemaReady = ensureReleaseRadarSchemaInternal(env).catch((error) => {
      releaseRadarSchemaReady = null;
      throw error;
    });
  }
  await releaseRadarSchemaReady;
}

async function ensureReleaseRadarSchemaInternal(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS release_radar_artists (
      id              TEXT PRIMARY KEY,
      sync_key        TEXT,
      chat_id         INTEGER,
      artist          TEXT NOT NULL,
      source          TEXT NOT NULL DEFAULT 'spotify',
      last_seen_key   TEXT,
      last_seen_title TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_checked_at TEXT
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS release_radar_events (
      id          TEXT PRIMARY KEY,
      radar_id    TEXT NOT NULL,
      sync_key    TEXT,
      chat_id     INTEGER,
      artist      TEXT NOT NULL,
      source      TEXT NOT NULL,
      release_key TEXT NOT NULL,
      title       TEXT,
      url         TEXT,
      notified    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  ).run();
  await env.DB.batch([
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_release_radar_sync ON release_radar_artists(sync_key, enabled, updated_at DESC)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_release_radar_chat ON release_radar_artists(chat_id, enabled, updated_at DESC)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_release_radar_check ON release_radar_artists(enabled, last_checked_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_release_radar_events_radar ON release_radar_events(radar_id, created_at DESC)'),
    env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_release_radar_events_unique ON release_radar_events(radar_id, release_key)'),
  ]);
}

async function fetchLatestRelease(row: ReleaseRadarArtistRow, env: Env): Promise<DiscographyTrack | null> {
  const failover = await fetchDownloaderWithFailover(env, '/internal/artist/discography', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': env.DOWNLOADER_API_KEY,
    },
    body: JSON.stringify({
      artist: row.artist,
      source: row.source,
      limit: 1,
    }),
  });
  if (!failover.response.ok) return null;
  const payload = await failover.response.json() as { tracks?: DiscographyTrack[]; results?: DiscographyTrack[] };
  const tracks = Array.isArray(payload.tracks) ? payload.tracks : Array.isArray(payload.results) ? payload.results : [];
  return tracks.find((track) => track?.title || track?.url) ?? null;
}

async function markRadarChecked(env: Env, id: string, key: string | null, title: string | null | undefined): Promise<void> {
  await env.DB.prepare(
    `UPDATE release_radar_artists
     SET last_seen_key = COALESCE(?, last_seen_key),
         last_seen_title = COALESCE(?, last_seen_title),
         last_checked_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(key, title ?? null, id).run();
}

async function notifyReleaseRadar(
  row: ReleaseRadarArtistRow,
  latest: DiscographyTrack,
  env: Env,
): Promise<boolean> {
  if (String(env.RELEASE_RADAR_NOTIFY_ENABLED ?? '1').trim() === '0') return false;
  if (!row.chat_id || !env.TELEGRAM_BOT_TOKEN) return false;
  const text = [
    '🛰 Release Radar',
    `Нов запис за: ${row.artist}`,
    `${latest.artist || row.artist} - ${latest.title || 'Нов release'}`,
    latest.url ? `Линк: ${latest.url}` : '',
  ].filter(Boolean).join('\n');

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: row.chat_id,
        text,
        reply_markup: latest.url ? {
          inline_keyboard: [[{ text: 'Отвори', url: latest.url }]],
        } : undefined,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
async function radarId(syncKey: string, artist: string, source: string): Promise<string> {
  const input = `${syncKey}:${source}:${artist.toLowerCase()}`;
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function radarReleaseKey(track: DiscographyTrack): Promise<string> {
  const input = `${track.source ?? ''}:${track.artist ?? ''}:${track.title ?? ''}:${track.url ?? ''}`.toLowerCase();
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeArtist(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function normalizeRadarSource(value: string): string {
  const normalized = String(value || 'spotify').trim().toLowerCase();
  return ['spotify', 'youtube', 'apple', 'deezer', 'soundcloud'].includes(normalized) ? normalized : 'spotify';
}

function normalizeSyncKey(value: string): string | null {
  const trimmed = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(trimmed)) return null;
  return trimmed;
}

function sanitizeRadarRow(row: ReleaseRadarArtistRow): Record<string, unknown> {
  return {
    id: row.id,
    sync_key: row.sync_key,
    chat_id: row.chat_id,
    artist: row.artist,
    source: row.source,
    last_seen_title: row.last_seen_title,
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_checked_at: row.last_checked_at,
  };
}
