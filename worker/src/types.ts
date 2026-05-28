export type AudioFormat = 'mp3' | 'flac' | 'ogg' | 'm4a' | 'opus' | 'wav';
export type AudioQuality = '320' | '256' | '192' | '128' | '96' | 'best' | 'lossless';
export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface DownloadJob {
  id: string;
  url: string;
  source: string;
  format: AudioFormat;
  quality: AudioQuality;
  fingerprint: string;
  chatId?: number;
  messageId?: number;
  requestedAt: string;
}

export interface DownloaderSearchResult {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  thumbnail?: string;
  source: string;
  url: string;
  year?: number;
}

export interface DownloaderDownloadResult {
  download_url: string;
  title: string;
  artist: string;
  duration: number;
  file_size: number;
  source: string;
  resolved_url?: string;
  fallback_used?: boolean;
  mime_type?: string;
  filename?: string;
}

export interface Env {
  DB: D1Database;
  FILES?: R2Bucket;
  DOWNLOAD_QUEUE: Queue<DownloadJob>;
  CACHE: KVNamespace;
  ASSETS: Fetcher;

  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_SECRET_TOKEN: string;
  DOWNLOADER_API_URL: string;
  DOWNLOADER_API_KEY: string;
  DOWNLOAD_TOKEN_SECRET: string;

  CORS_ORIGINS?: string;
  DOWNLOAD_TOKEN_TTL_SECONDS?: string;
  SEARCH_CACHE_TTL_SECONDS?: string;
  DOWNLOAD_DEDUPE_TTL_SECONDS?: string;
  PUBLIC_BASE_URL?: string;
  INVIDIOUS_BASE_URL?: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
