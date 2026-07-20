-- Archive Raid v1: virtual collectible cards tied to the shared DyrakArmy profile.
-- No row grants access to protected media. Rewards are cosmetic game metadata only.
CREATE TABLE IF NOT EXISTS archive_raid_runs (
  id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  week_key TEXT NOT NULL,
  score INTEGER NOT NULL,
  successful_rooms INTEGER NOT NULL,
  failed_rooms INTEGER NOT NULL,
  best_combo INTEGER NOT NULL,
  shards_earned INTEGER NOT NULL,
  xp_earned INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES game_profiles(telegram_user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS archive_raid_inventory (
  telegram_user_id INTEGER NOT NULL,
  card_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'raid',
  first_unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (telegram_user_id, card_id),
  FOREIGN KEY (telegram_user_id) REFERENCES game_profiles(telegram_user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS archive_raid_daily_claims (
  telegram_user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  card_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (telegram_user_id, day_key),
  FOREIGN KEY (telegram_user_id) REFERENCES game_profiles(telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_archive_raid_runs_week
  ON archive_raid_runs(week_key, score DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_archive_raid_runs_user_day
  ON archive_raid_runs(telegram_user_id, day_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_archive_raid_inventory_user
  ON archive_raid_inventory(telegram_user_id, last_unlocked_at DESC);

INSERT OR IGNORE INTO platform_modules (
  id, kind, title, description, icon, public_url, telegram_url,
  enabled, sort_order, system, metadata_json
) VALUES (
  'archive-raid',
  'game',
  'Archive Raid',
  'Виртуални collectible карти, дневни crates, общ XP и козметични профилни награди.',
  '🗃',
  '/games/archive-raid/',
  'tg://resolve?domain=dyrakarmy_bot&startapp=archive_raid',
  1,
  43,
  1,
  '{"protected_content_access":false,"rarities":["Common","Rare","Epic","Legendary","Army Exclusive"]}'
);
