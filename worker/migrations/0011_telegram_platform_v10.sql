-- Telegram Platform v10 storage and identity index
-- Apply with:
-- npx wrangler d1 execute sounddrop-db --file=migrations/0011_telegram_platform_v10.sql

CREATE TABLE IF NOT EXISTS telegram_media_objects (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  storage_key             TEXT NOT NULL UNIQUE,
  job_id                  TEXT NOT NULL,
  source_url              TEXT NOT NULL,
  source                  TEXT NOT NULL DEFAULT 'unknown',
  format                  TEXT NOT NULL,
  quality                 TEXT NOT NULL,
  title                   TEXT,
  artist                  TEXT,
  duration                INTEGER,
  file_size               INTEGER,
  content_hash            TEXT,
  media_kind              TEXT NOT NULL DEFAULT 'link', -- audio | document | link
  telegram_file_id        TEXT,
  telegram_file_unique_id TEXT,
  channel_id              TEXT,
  channel_message_id      INTEGER,
  fallback_url            TEXT,
  created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tg_media_job
  ON telegram_media_objects(job_id);
CREATE INDEX IF NOT EXISTS idx_tg_media_hash
  ON telegram_media_objects(content_hash);
CREATE INDEX IF NOT EXISTS idx_tg_media_created
  ON telegram_media_objects(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_media_channel_message
  ON telegram_media_objects(channel_id, channel_message_id);
CREATE INDEX IF NOT EXISTS idx_tg_media_file_unique
  ON telegram_media_objects(telegram_file_unique_id);

CREATE TABLE IF NOT EXISTS telegram_user_links (
  telegram_user_id INTEGER PRIMARY KEY,
  chat_id          INTEGER NOT NULL,
  sync_key         TEXT NOT NULL UNIQUE,
  username         TEXT,
  first_name       TEXT,
  language_code    TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tg_user_links_sync
  ON telegram_user_links(sync_key);
CREATE INDEX IF NOT EXISTS idx_tg_user_links_updated
  ON telegram_user_links(updated_at DESC);
