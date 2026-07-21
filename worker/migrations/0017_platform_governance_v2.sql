-- DyrakArmy Platform Governance v2
-- Unified identity, role-based access, device sessions, version snapshots and realtime events.

CREATE TABLE IF NOT EXISTS platform_users (
  telegram_user_id INTEGER PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner', 'admin', 'editor', 'moderator', 'user')),
  username TEXT,
  display_name TEXT NOT NULL,
  language_code TEXT,
  profile_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_role_history (
  id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  previous_role TEXT NOT NULL,
  new_role TEXT NOT NULL,
  changed_by INTEGER NOT NULL,
  changed_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_sessions (
  id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  device_name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  FOREIGN KEY (telegram_user_id) REFERENCES platform_users(telegram_user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_versions (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  label TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  actor_name TEXT NOT NULL,
  revision INTEGER,
  payload_json TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_platform_users_role
  ON platform_users(role, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_role_history_user
  ON platform_role_history(telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_sessions_user
  ON platform_sessions(telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_sessions_expiry
  ON platform_sessions(expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS idx_platform_versions_created
  ON platform_versions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_events_visibility_sequence
  ON platform_events(visibility, sequence ASC);

UPDATE platform_modules
SET public_url = '/control-v2/',
    telegram_url = 'tg://resolve?domain=dyrakarmy_bot&startapp=control',
    title = 'Control Center v2',
    description = 'Роли, версии, rollback, общ профил и realtime синхронизация.',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'control-center';

INSERT OR IGNORE INTO platform_settings (key, value_json)
VALUES ('governance.version', '"2.0.0"');
