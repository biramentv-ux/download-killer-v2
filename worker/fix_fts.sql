DROP TRIGGER IF EXISTS jobs_fts_insert;
DROP TRIGGER IF EXISTS jobs_fts_update;
DROP TRIGGER IF EXISTS jobs_fts_delete;
DROP TABLE IF EXISTS jobs_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
  title,
  artist,
  content='download_jobs',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS jobs_fts_insert AFTER INSERT ON download_jobs
WHEN NEW.title IS NOT NULL OR NEW.artist IS NOT NULL
BEGIN
  INSERT INTO jobs_fts(rowid, title, artist)
  VALUES (NEW.rowid, COALESCE(NEW.title, ''), COALESCE(NEW.artist, ''));
END;

CREATE TRIGGER IF NOT EXISTS jobs_fts_update AFTER UPDATE OF title, artist ON download_jobs
BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, artist)
  VALUES ('delete', OLD.rowid, COALESCE(OLD.title, ''), COALESCE(OLD.artist, ''));

  INSERT INTO jobs_fts(rowid, title, artist)
  VALUES (NEW.rowid, COALESCE(NEW.title, ''), COALESCE(NEW.artist, ''));
END;

CREATE TRIGGER IF NOT EXISTS jobs_fts_delete AFTER DELETE ON download_jobs
BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, artist)
  VALUES ('delete', OLD.rowid, COALESCE(OLD.title, ''), COALESCE(OLD.artist, ''));
END;

INSERT INTO jobs_fts(rowid, title, artist)
SELECT rowid, COALESCE(title, ''), COALESCE(artist, '')
FROM download_jobs
WHERE title IS NOT NULL OR artist IS NOT NULL;
