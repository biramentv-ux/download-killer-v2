-- DyrakArmy Arena v1: teams, daily challenges and seasonal competition.
CREATE TABLE IF NOT EXISTS arena_teams (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS arena_team_members (
  team_id TEXT NOT NULL,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id, telegram_user_id),
  FOREIGN KEY (team_id) REFERENCES arena_teams(id) ON DELETE CASCADE,
  FOREIGN KEY (telegram_user_id) REFERENCES game_profiles(telegram_user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS arena_runs (
  id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  team_id TEXT,
  day_key TEXT NOT NULL,
  week_key TEXT NOT NULL,
  season_key TEXT NOT NULL,
  score INTEGER NOT NULL,
  correct_answers INTEGER NOT NULL,
  total_questions INTEGER NOT NULL,
  accuracy INTEGER NOT NULL,
  avg_response_ms INTEGER NOT NULL,
  best_combo INTEGER NOT NULL,
  xp_earned INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES game_profiles(telegram_user_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES arena_teams(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_arena_runs_week_score
  ON arena_runs(week_key, score DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_arena_runs_season_score
  ON arena_runs(season_key, score DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_arena_runs_user_day
  ON arena_runs(telegram_user_id, day_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arena_runs_team_week
  ON arena_runs(team_id, week_key, score DESC);
CREATE INDEX IF NOT EXISTS idx_arena_members_team
  ON arena_team_members(team_id, joined_at ASC);
