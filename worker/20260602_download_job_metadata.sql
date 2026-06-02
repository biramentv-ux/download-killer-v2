ALTER TABLE download_jobs ADD COLUMN parent_job_id TEXT;
ALTER TABLE download_jobs ADD COLUMN variant_role TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE download_jobs ADD COLUMN sync_key TEXT;
ALTER TABLE download_jobs ADD COLUMN playlist_folder TEXT;
ALTER TABLE download_jobs ADD COLUMN playlist_index INTEGER;
ALTER TABLE download_jobs ADD COLUMN local_relpath TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_parent ON download_jobs(parent_job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_sync_created ON download_jobs(sync_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_variant_role ON download_jobs(variant_role);
