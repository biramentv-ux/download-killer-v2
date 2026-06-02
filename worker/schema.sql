-- SoundDrop D1 schema
-- Apply: wrangler d1 execute sounddrop-db --file=schema.sql

CREATE TABLE IF NOT EXISTS download_jobs (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'unknown',
  format        TEXT NOT NULL DEFAULT 'mp3',
  quality       TEXT NOT NULL DEFAULT '320',
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | processing | paused | done | failed
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

CREATE TABLE IF NOT EXISTS job_history_events (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  event      TEXT NOT NULL,
  status     TEXT NOT NULL,
  source     TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_job_history_events_job_created ON job_history_events(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_history_events_created ON job_history_events(created_at DESC);

CREATE TABLE IF NOT EXISTS playlist_workflows (
  workflow_id       TEXT PRIMARY KEY,
  source_url        TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'unknown',
  status            TEXT NOT NULL DEFAULT 'queued', -- queued | processing | paused | done | failed
  phase             TEXT NOT NULL DEFAULT 'init',
  total_tracks      INTEGER NOT NULL DEFAULT 0,
  queued_count      INTEGER NOT NULL DEFAULT 0,
  processing_count  INTEGER NOT NULL DEFAULT 0,
  done_count        INTEGER NOT NULL DEFAULT 0,
  failed_count      INTEGER NOT NULL DEFAULT 0,
  deduped_count     INTEGER NOT NULL DEFAULT 0,
  control_state     TEXT NOT NULL DEFAULT 'active', -- active | paused | cancelled
  archive_status    TEXT, -- building | ready | failed
  archive_url       TEXT,
  archive_error     TEXT,
  archive_finished_at TEXT,
  error_code        TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_playlist_workflows_status ON playlist_workflows(status);
CREATE INDEX IF NOT EXISTS idx_playlist_workflows_created ON playlist_workflows(created_at DESC);

CREATE TABLE IF NOT EXISTS playlist_workflow_jobs (
  workflow_id  TEXT NOT NULL,
  job_id       TEXT NOT NULL,
  is_deduped   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workflow_id, job_id),
  FOREIGN KEY (workflow_id) REFERENCES playlist_workflows(workflow_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_playlist_workflow_jobs_workflow ON playlist_workflow_jobs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_playlist_workflow_jobs_job ON playlist_workflow_jobs(job_id);

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

CREATE TABLE IF NOT EXISTS ops_audit_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  role       TEXT NOT NULL,
  token_id   TEXT,
  ip         TEXT,
  status     TEXT NOT NULL, -- allowed | denied | limited | success | failed
  details    TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ops_audit_created ON ops_audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_audit_action  ON ops_audit_events(action, created_at DESC);

CREATE TABLE IF NOT EXISTS user_preferences (
  sync_key   TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_updated ON user_preferences(updated_at DESC);

CREATE TABLE IF NOT EXISTS shared_queue_items (
  id         TEXT PRIMARY KEY,
  sync_key   TEXT NOT NULL,
  job_id     TEXT,
  url        TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'unknown',
  format     TEXT NOT NULL DEFAULT 'mp3',
  quality    TEXT NOT NULL DEFAULT '320',
  title      TEXT,
  artist     TEXT,
  added_by   TEXT,
  status     TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shared_queue_sync_created ON shared_queue_items(sync_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shared_queue_job ON shared_queue_items(job_id);
