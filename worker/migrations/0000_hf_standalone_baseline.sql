-- Baseline for clean standalone runtimes.
-- Existing Cloudflare D1 databases are unchanged because the table is created only when absent.
CREATE TABLE IF NOT EXISTS download_jobs (
  id               TEXT PRIMARY KEY,
  url              TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'unknown',
  format           TEXT NOT NULL DEFAULT 'mp3',
  quality          TEXT NOT NULL DEFAULT '320',
  status           TEXT NOT NULL DEFAULT 'queued',
  attempts         INTEGER NOT NULL DEFAULT 0,
  fingerprint      TEXT,
  parent_job_id    TEXT,
  variant_role     TEXT NOT NULL DEFAULT 'primary',
  sync_key         TEXT,
  playlist_folder  TEXT,
  playlist_index   INTEGER,
  local_relpath    TEXT,
  chat_id          INTEGER,
  result_url       TEXT,
  r2_key           TEXT,
  title            TEXT,
  artist           TEXT,
  duration         INTEGER,
  file_size        INTEGER,
  content_hash     TEXT,
  error_code       TEXT,
  error_message    TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created
  ON download_jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_fingerprint
  ON download_jobs(fingerprint);
CREATE INDEX IF NOT EXISTS idx_jobs_sync_created
  ON download_jobs(sync_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_parent
  ON download_jobs(parent_job_id);
