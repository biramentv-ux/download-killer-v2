-- SoundDrop D1 schema
-- Apply: wrangler d1 execute sounddrop-db --file=schema.sql

CREATE TABLE IF NOT EXISTS download_jobs (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'unknown',
  format        TEXT NOT NULL DEFAULT 'mp3',
  quality       TEXT NOT NULL DEFAULT '320',
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | processing | done | failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  fingerprint   TEXT,
  content_hash  TEXT,
  result_url    TEXT,
  r2_key        TEXT,
  title         TEXT,
  artist        TEXT,
  duration      INTEGER,
  file_size     INTEGER,
  error_code    TEXT,
  error_message TEXT,
  chat_id       INTEGER,
  message_id    INTEGER,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status       ON download_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created      ON download_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_chat         ON download_jobs(chat_id);
CREATE INDEX IF NOT EXISTS idx_jobs_source       ON download_jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_fingerprint  ON download_jobs(fingerprint);
CREATE INDEX IF NOT EXISTS idx_jobs_content_hash ON download_jobs(content_hash);

-- NOTE:
-- FTS table/triggers were removed in production due SQLITE_CORRUPT_VTAB errors under queue load.
-- Keep this schema minimal and stable for the active download pipeline.

CREATE TABLE IF NOT EXISTS telegram_archive_tracks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_url TEXT NOT NULL UNIQUE,
  source_url     TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'unknown',
  title          TEXT,
  artist         TEXT,
  bot_username   TEXT,
  match_text     TEXT NOT NULL,
  export_file    TEXT,
  message_id     TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tg_archive_source ON telegram_archive_tracks(source);
CREATE INDEX IF NOT EXISTS idx_tg_archive_match  ON telegram_archive_tracks(match_text);
