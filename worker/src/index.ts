/**
 * SoundDrop v7 Worker
 * Public API + queue consumer + Telegram webhook
 */

import { downloadRouter } from './api';
import { handleTelegramUpdate, notifyTelegramComplete, notifyTelegramFailure } from './telegram';
import type { DownloadJob, DownloaderDownloadResult, Env } from './types';
import { jsonError, optionsResponse, sha256HexBytes } from './utils';

const MAX_QUEUE_RETRIES = 5;
const INVIDIOUS_DEFAULT_BASE_URL = 'https://inv.nadeko.net';
const INVIDIOUS_FALLBACK_BASE_URLS = [
  'https://invidious.f5.si',
  'https://inv.thepixora.com',
  'https://yt.chocolatemoo53.com',
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return optionsResponse(request, env);
    }

    try {
      if (pathname === '/telegram/webhook') {
        return handleTelegramUpdate(request, env);
      }

      if (pathname.startsWith('/api/')) {
        return downloadRouter(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error('Unhandled fetch error', error);
      return jsonError(request, env, 'INTERNAL_ERROR', 'Internal server error', 500, true);
    }
  },

  async queue(batch: MessageBatch<DownloadJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;
      const attempts = Number((message as unknown as { attempts?: number }).attempts ?? 1);

      try {
        await processDownloadJob(job, env, attempts);
        message.ack();
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        console.error(`Job ${job.id} failed at attempt ${attempts}`, error);

        if (attempts >= MAX_QUEUE_RETRIES) {
          await markFailed(job.id, env, attempts, 'QUEUE_JOB_FAILED', errorText, true);
          message.ack();
        } else {
          await markFailed(job.id, env, attempts, 'QUEUE_RETRY', errorText, false);
          message.retry({ delaySeconds: Math.min(120, attempts * 20) });
        }
      }
    }
  },
} satisfies ExportedHandler<Env, DownloadJob>;

async function processDownloadJob(job: DownloadJob, env: Env, attempts: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE download_jobs
     SET status = 'processing', attempts = ?, error_code = NULL, error_message = NULL, finished_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(attempts, job.id).run();

  let result: DownloaderDownloadResult;
  let internalErrorText: string | null = null;
  try {
    result = await downloadViaInternalService(job, env);
  } catch (error) {
    internalErrorText = error instanceof Error ? error.message : String(error);
    console.error('Internal downloader failed. Falling back to Invidious.', error);
    try {
      result = await downloadViaInvidious(job, env);
    } catch (fallbackError) {
      const fallbackErrorText = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`internal=${internalErrorText}; fallback=${fallbackErrorText}`);
    }
  }

  let contentHash: string | null = null;
  let r2Key: string | null = null;
  const normalizedDownloadUrl = normalizeDownloaderUrl(result.download_url, env.DOWNLOADER_API_URL);

  if (env.FILES) {
    const streamHeaders = buildDownloaderHeaders(normalizedDownloadUrl, env);
    const streamResponse = await fetch(normalizedDownloadUrl, streamHeaders ? { headers: streamHeaders } : undefined);

    if (!streamResponse.ok || !streamResponse.body) {
      const details = await streamResponse.text();
      throw new Error(`Unable to fetch converted file (${streamResponse.status}): ${details}`);
    }

    const fileBuffer = await streamResponse.arrayBuffer();
    contentHash = await sha256HexBytes(fileBuffer);
    r2Key = `objects/${contentHash}.${job.format}`;

    const existing = await env.FILES.head(r2Key);
    if (!existing) {
      await env.FILES.put(r2Key, fileBuffer, {
        httpMetadata: {
          contentType: result.mime_type ?? streamResponse.headers.get('content-type') ?? 'application/octet-stream',
          contentDisposition: `attachment; filename="${result.filename ?? `${job.id}.${job.format}`}"`,
        },
      });
    }
  }

  await env.DB.prepare(
    `UPDATE download_jobs
     SET status = 'done',
         source = ?,
         result_url = ?,
         r2_key = ?,
         content_hash = ?,
         title = ?,
         artist = ?,
         duration = ?,
         file_size = ?,
         updated_at = CURRENT_TIMESTAMP,
         finished_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(
    result.source ?? job.source,
    normalizedDownloadUrl,
    r2Key,
    contentHash,
    result.title,
    result.artist,
    result.duration,
    result.file_size,
    job.id,
  ).run();

  if (job.chatId && job.messageId) {
    await notifyTelegramComplete(job, result, env);
  }
}

async function markFailed(
  jobId: string,
  env: Env,
  attempts: number,
  errorCode: string,
  errorMessage: string,
  terminal: boolean,
): Promise<void> {
  const status = terminal ? 'failed' : 'queued';
  const finishedAtExpr = terminal ? 'CURRENT_TIMESTAMP' : 'NULL';

  await env.DB.prepare(
    `UPDATE download_jobs
     SET status = ?,
         attempts = ?,
         error_code = ?,
         error_message = ?,
         updated_at = CURRENT_TIMESTAMP,
         finished_at = ${finishedAtExpr}
     WHERE id = ?`,
  ).bind(status, attempts, errorCode, errorMessage.slice(0, 2000), jobId).run();

  if (!terminal) {
    return;
  }

  const row = await env.DB.prepare(
    `SELECT id, chat_id, message_id, url, source, format, quality, fingerprint, created_at
     FROM download_jobs WHERE id = ?`,
  ).bind(jobId).first<{
    id: string;
    chat_id: number | null;
    message_id: number | null;
    url: string;
    source: string;
    format: DownloadJob['format'];
    quality: DownloadJob['quality'];
    fingerprint: string;
    created_at: string;
  }>();

  if (row?.chat_id && row.message_id) {
    await notifyTelegramFailure(
      {
        id: row.id,
        url: row.url,
        source: row.source,
        format: row.format,
        quality: row.quality,
        fingerprint: row.fingerprint,
        chatId: row.chat_id,
        messageId: row.message_id,
        requestedAt: row.created_at,
      },
      errorMessage,
      env,
    );
  }
}

async function downloadViaInternalService(job: DownloadJob, env: Env): Promise<DownloaderDownloadResult> {
  const response = await fetch(`${env.DOWNLOADER_API_URL}/internal/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': env.DOWNLOADER_API_KEY,
    },
    body: JSON.stringify({
      job_id: job.id,
      url: job.url,
      source: job.source,
      format: job.format,
      quality: job.quality,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Downloader API failed (${response.status}): ${details}`);
  }

  const result = await response.json<DownloaderDownloadResult>();
  if (!result.download_url) {
    throw new Error('Downloader API did not return download_url');
  }

  return result;
}

async function downloadViaInvidious(job: DownloadJob, env: Env): Promise<DownloaderDownloadResult> {
  const videoUrl = await resolveToYouTubeUrl(job.url, env);
  const videoId = extractYouTubeVideoId(videoUrl);
  if (!videoId) {
    throw new Error('Unable to resolve a playable YouTube video');
  }

  for (const base of getInvidiousBaseUrls(env)) {
    try {
      const response = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`);
      if (!response.ok) {
        const details = await response.text();
        console.warn(`Invidious video endpoint ${base} failed (${response.status}): ${details.slice(0, 240)}`);
        continue;
      }

      const raw = await response.text();
      const payload = JSON.parse(raw) as {
        title?: string;
        author?: string;
        lengthSeconds?: number;
        adaptiveFormats?: Array<{
          url?: string;
          type?: string;
          bitrate?: string;
          clen?: string;
        }>;
      };

      const audioCandidates = (payload.adaptiveFormats ?? [])
        .filter((entry) => typeof entry.url === 'string' && typeof entry.type === 'string' && entry.type.includes('audio/'))
        .map((entry) => ({
          url: entry.url as string,
          type: entry.type as string,
          bitrate: Number(entry.bitrate ?? 0),
          size: Number(entry.clen ?? 0),
        }))
        .sort((a, b) => b.bitrate - a.bitrate);

      const bestAudio = audioCandidates[0];
      if (!bestAudio) {
        console.warn(`Invidious ${base} returned no playable audio streams`);
        continue;
      }

      const mimeType = bestAudio.type.split(';')[0]?.trim() || 'application/octet-stream';
      const extension = mimeTypeToExtension(mimeType);

      return {
        download_url: bestAudio.url,
        title: payload.title ?? videoId,
        artist: payload.author ?? 'Unknown artist',
        duration: Number(payload.lengthSeconds ?? 0),
        file_size: Number.isFinite(bestAudio.size) ? bestAudio.size : 0,
        source: 'youtube',
        resolved_url: videoUrl,
        fallback_used: true,
        mime_type: mimeType,
        filename: `${videoId}.${extension}`,
      };
    } catch (error) {
      console.warn(`Invidious parser failed on ${base}`, error);
    }
  }

  throw new Error('All Invidious fallback instances failed for this video');
}

async function resolveToYouTubeUrl(inputUrl: string, env: Env): Promise<string> {
  const directVideoId = extractYouTubeVideoId(inputUrl);
  if (directVideoId) {
    return `https://www.youtube.com/watch?v=${directVideoId}`;
  }

  const metadataTitle = await extractOgTitle(inputUrl);
  const query = metadataTitle || inputUrl;
  for (const base of getInvidiousBaseUrls(env)) {
    try {
      const searchUrl = new URL(`${base}/api/v1/search`);
      searchUrl.searchParams.set('q', query);
      searchUrl.searchParams.set('type', 'video');
      searchUrl.searchParams.set('sort', 'relevance');
      searchUrl.searchParams.set('page', '1');

      const response = await fetch(searchUrl.toString());
      if (!response.ok) {
        continue;
      }

      const raw = await response.text();
      const rows = JSON.parse(raw) as Array<{ type?: string; videoId?: string }>;
      const firstVideo = rows.find((row) => row.type === 'video' && typeof row.videoId === 'string' && row.videoId.length > 0);
      if (firstVideo?.videoId) {
        return `https://www.youtube.com/watch?v=${firstVideo.videoId}`;
      }
    } catch {
      // try next instance
    }
  }

  throw new Error('No fallback YouTube mirror found for input URL');
}

async function extractOgTitle(targetUrl: string): Promise<string | null> {
  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SoundDrop/7.0; +https://sounddrop.biramentv.workers.dev)',
      },
    });
    if (!response.ok) return null;

    const html = await response.text();
    const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (!ogMatch?.[1]) return null;

    return decodeHtmlEntities(ogMatch[1]).trim();
  } catch {
    return null;
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractYouTubeVideoId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id ? id.slice(0, 11) : null;
    }

    if (host.endsWith('youtube.com')) {
      const fromQuery = url.searchParams.get('v');
      if (fromQuery) return fromQuery.slice(0, 11);

      const parts = url.pathname.split('/').filter(Boolean);
      const shortsIndex = parts.findIndex((part) => part === 'shorts' || part === 'embed');
      if (shortsIndex >= 0 && parts[shortsIndex + 1]) {
        return parts[shortsIndex + 1]!.slice(0, 11);
      }
    }
  } catch {
    return null;
  }

  return null;
}

function mimeTypeToExtension(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mpeg')) return 'mp3';
  return 'bin';
}

function getInvidiousBaseUrl(env: Env): string {
  return (env.INVIDIOUS_BASE_URL ?? INVIDIOUS_DEFAULT_BASE_URL).replace(/\/+$/g, '');
}

function getInvidiousBaseUrls(env: Env): string[] {
  const configured = getInvidiousBaseUrl(env);
  const merged = [configured, ...INVIDIOUS_FALLBACK_BASE_URLS]
    .map((url) => url.replace(/\/+$/g, ''))
    .filter(Boolean);
  return [...new Set(merged)];
}

function buildDownloaderHeaders(targetUrl: string, env: Env): Record<string, string> | null {
  const normalizedBase = env.DOWNLOADER_API_URL.replace(/\/+$/g, '');
  if (!targetUrl.startsWith(normalizedBase)) {
    return null;
  }

  return {
    'X-API-Key': env.DOWNLOADER_API_KEY,
  };
}

function normalizeDownloaderUrl(rawUrl: string, downloaderBaseUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
    if (!localHosts.has(parsed.hostname.toLowerCase())) {
      return rawUrl;
    }

    const base = new URL(downloaderBaseUrl.replace(/\/+$/g, ''));
    return `${base.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return rawUrl;
  }
}
