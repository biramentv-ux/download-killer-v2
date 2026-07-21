ALTER TABLE download_jobs ADD COLUMN audio_normalized INTEGER NOT NULL DEFAULT 0;
ALTER TABLE download_jobs ADD COLUMN normalization_mode TEXT NOT NULL DEFAULT 'off';
ALTER TABLE download_jobs ADD COLUMN normalization_target_lufs REAL;
ALTER TABLE download_jobs ADD COLUMN audio_analysis TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_audio_normalization ON download_jobs(normalization_mode, audio_normalized);
