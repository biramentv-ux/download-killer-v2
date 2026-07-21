ALTER TABLE download_jobs ADD COLUMN album TEXT;
ALTER TABLE download_jobs ADD COLUMN genre TEXT;
ALTER TABLE download_jobs ADD COLUMN release_year TEXT;
ALTER TABLE download_jobs ADD COLUMN track_number INTEGER;
ALTER TABLE download_jobs ADD COLUMN thumbnail_url TEXT;
ALTER TABLE download_jobs ADD COLUMN quality_score INTEGER;
ALTER TABLE download_jobs ADD COLUMN quality_grade TEXT;
ALTER TABLE download_jobs ADD COLUMN quality_details TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_quality_score ON download_jobs(quality_score, quality_grade);

CREATE TABLE IF NOT EXISTS scheduled_downloads (
  id             TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  title          TEXT,
  artist         TEXT,
  thumbnail      TEXT,
  source         TEXT NOT NULL DEFAULT 'unknown',
  format         TEXT NOT NULL DEFAULT 'mp3',
  quality        TEXT NOT NULL DEFAULT '320',
  sync_key       TEXT NOT NULL,
  scheduled_at   TEXT NOT NULL,
  recurrence     TEXT,
  wifi_only      INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending',
  last_triggered TEXT,
  next_run       TEXT,
  job_id         TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scheduled_downloads_next ON scheduled_downloads(status, next_run);
CREATE INDEX IF NOT EXISTS idx_scheduled_downloads_sync ON scheduled_downloads(sync_key, status, next_run);
CREATE INDEX IF NOT EXISTS idx_scheduled_downloads_job ON scheduled_downloads(job_id);
