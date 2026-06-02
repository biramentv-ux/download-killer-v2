export type AudioFormat = 'mp3' | 'flac' | 'ogg' | 'm4a' | 'opus' | 'wav';
export type AudioQuality = '320' | '256' | '192' | '128' | '96' | 'best' | 'lossless';
export type JobStatus = 'queued' | 'processing' | 'paused' | 'done' | 'failed';

export interface DownloadJob {
  id: string;
  url: string;
  source: string;
  format: AudioFormat;
  quality: AudioQuality;
  fingerprint: string;
  parentJobId?: string;
  variantRole?: 'primary' | 'mobile';
  syncKey?: string;
  playlistFolder?: string;
  playlistIndex?: number;
  localRelpath?: string;
  chatId?: number;
  messageId?: number;
  requestedAt: string;
}

export interface JobHistoryEvent {
  kind: 'history_event';
  id: string;
  jobId: string;
  event: 'queued' | 'processing' | 'done' | 'failed' | 'paused' | 'resumed' | 'deduped';
  status: JobStatus;
  source?: string;
  detail?: string;
  createdAt: string;
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
  HISTORY_QUEUE?: Queue<JobHistoryEvent>;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  ANALYTICS?: AnalyticsEngineDataset;

  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_SECRET_TOKEN: string;
  TELEGRAM_WEBHOOK_JWT_SECRET?: string;
  TELEGRAM_WEBHOOK_JWT_PUBLIC_JWK?: string;
  TELEGRAM_WEBHOOK_REQUIRE_JWT?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_DOWNLOAD_CHANNEL_ID?: string;
  DOWNLOADER_API_URL: string;
  DOWNLOADER_ORIGINS_JSON?: string;
  DOWNLOADER_BACKUP_API_URL?: string;
  DOWNLOADER_TERTIARY_API_URL?: string;
  DOWNLOADER_API_KEY: string;
  DOWNLOAD_TOKEN_SECRET: string;
  OPS_READ_TOKEN?: string;
  OPS_OPERATOR_TOKEN?: string;
  OPS_ADMIN_TOKEN?: string;
  OPS_ALERT_CHAT_ID?: string;
  OPS_REPLAY_RATE_LIMIT_PER_MINUTE?: string;
  OPS_REPLAY_RATE_LIMIT_OPERATOR_PER_MINUTE?: string;
  OPS_REPLAY_RATE_LIMIT_ADMIN_PER_MINUTE?: string;
  OPS_REPLAY_RATE_LIMIT_IP_PER_MINUTE?: string;
  OPS_REPLAY_MAX_TARGETS_OPERATOR?: string;
  OPS_REPLAY_MAX_TARGETS_ADMIN?: string;
  OPS_SMOKE_ALERT_COOLDOWN_SECONDS?: string;
  OPS_SMOKE_CONSECUTIVE_ALERT_THRESHOLD?: string;
  OPS_SMOKE_FAILURES_1H_ALERT_THRESHOLD?: string;
  ORIGIN_HEALTH_TIMEOUT_MS?: string;
  ORIGIN_FAIL_THRESHOLD?: string;
  ORIGIN_RECOVERY_SECONDS?: string;
  OPS_QUEUE_BACKLOG_THRESHOLD?: string;
  QUEUE_RETRY_BASE_SECONDS?: string;
  QUEUE_RETRY_MAX_SECONDS?: string;
  QUEUE_RETRY_JITTER_PERCENT?: string;
  SMOKE_TEST_YOUTUBE_URL?: string;
  SMOKE_TEST_SPOTIFY_URL?: string;
  SMOKE_TEST_FORMAT?: string;
  SMOKE_TEST_QUALITY?: string;
  MIN_CLIENT_WEB?: string;
  MIN_CLIENT_DESKTOP_WINDOWS?: string;
  MIN_CLIENT_DESKTOP_MACOS?: string;
  MIN_CLIENT_MOBILE_EXPO?: string;
  MIN_CLIENT_EXTENSION?: string;
  LATEST_DESKTOP_WINDOWS_VERSION?: string;
  LATEST_DESKTOP_MACOS_VERSION?: string;
  LATEST_MOBILE_EXPO_VERSION?: string;
  LATEST_EXTENSION_VERSION?: string;
  RELEASE_CHANNEL?: string;
  RELEASE_SIGNING_KEY_ID?: string;
  RELEASE_SIGNING_PRIVATE_KEY_PKCS8_BASE64?: string;
  RELEASE_MANIFEST_CACHE_TTL_SECONDS?: string;
  PLAYLIST_QUEUE_MAX_TRACKS?: string;
  AUTO_MOBILE_VARIANT_ENABLED?: string;
  MOBILE_VARIANT_FORMAT?: string;
  MOBILE_VARIANT_QUALITY?: string;
  PRIVATE_URL_TTL_SECONDS?: string;
  WEBHOOK_HMAC_SECRET?: string;
  WEBHOOK_HMAC_MAX_SKEW_SECONDS?: string;
  KV_CLEANUP_PREFIXES?: string;
  KV_CLEANUP_MAX_KEYS?: string;
  URL_ALLOWLIST?: string;
  DOWNLOAD_URL_ALLOWLIST?: string;
  URL_BLOCKLIST?: string;

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
