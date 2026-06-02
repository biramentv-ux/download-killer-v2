CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        TEXT NOT NULL,
  source        TEXT,
  format        TEXT,
  quality       TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  error_code    TEXT NOT NULL,
  error_message TEXT,
  queue_name    TEXT NOT NULL DEFAULT 'sounddrop-downloads',
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_job ON dead_letter_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_created ON dead_letter_jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS sync_key_claims (
  sync_key           TEXT PRIMARY KEY,
  email_hash         TEXT,
  turnstile_verified INTEGER NOT NULL DEFAULT 0,
  ip_hash            TEXT,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_claimed_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sync_key_claims_email ON sync_key_claims(email_hash);
CREATE INDEX IF NOT EXISTS idx_sync_key_claims_updated ON sync_key_claims(updated_at DESC);
