-- Latency Strike v1 profiles, immutable runs and reward inventory.
CREATE TABLE IF NOT EXISTS game_profiles (
  telegram_user_id INTEGER PRIMARY KEY,
  username TEXT,
  display_name TEXT NOT NULL,
  total_xp INTEGER NOT NULL DEFAULT 0,
  total_games INTEGER NOT NULL DEFAULT 0,
  best_score INTEGER NOT NULL DEFAULT 0,
  best_reaction_ms INTEGER,
  current_streak INTEGER NOT NULL DEFAULT 0,
  equipped_frame TEXT NOT NULL DEFAULT 'frame_neon',
  equipped_icon TEXT NOT NULL DEFAULT 'icon_pulse',
  equipped_badge TEXT NOT NULL DEFAULT 'badge_recruit',
  equipped_waveform TEXT NOT NULL DEFAULT 'waveform_pulse',
  equipped_theme TEXT NOT NULL DEFAULT 'theme_violet',
  equipped_title TEXT NOT NULL DEFAULT 'title_recruit',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS game_runs (
  id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  week_key TEXT NOT NULL,
  score INTEGER NOT NULL,
  avg_reaction_ms INTEGER NOT NULL,
  best_reaction_ms INTEGER NOT NULL,
  accuracy INTEGER NOT NULL,
  rounds INTEGER NOT NULL,
  false_starts INTEGER NOT NULL DEFAULT 0,
  xp_earned INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES game_profiles(telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_game_runs_week_score
  ON game_runs(week_key, score DESC, avg_reaction_ms ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_game_runs_user_created
  ON game_runs(telegram_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS game_unlocks (
  telegram_user_id INTEGER NOT NULL,
  reward_id TEXT NOT NULL,
  unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (telegram_user_id, reward_id),
  FOREIGN KEY (telegram_user_id) REFERENCES game_profiles(telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_game_unlocks_user
  ON game_unlocks(telegram_user_id, unlocked_at DESC);
