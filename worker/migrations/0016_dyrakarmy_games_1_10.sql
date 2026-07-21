-- DyrakArmy Games 1-10 completion: shared ranked runs for the seven challenge games.
CREATE TABLE IF NOT EXISTS challenge_game_runs (
  id TEXT PRIMARY KEY,
  game_slug TEXT NOT NULL,
  telegram_user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  week_key TEXT NOT NULL,
  score INTEGER NOT NULL,
  correct_answers INTEGER NOT NULL,
  total_questions INTEGER NOT NULL,
  accuracy INTEGER NOT NULL,
  avg_response_ms INTEGER NOT NULL,
  best_combo INTEGER NOT NULL,
  xp_earned INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES game_profiles(telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_challenge_runs_game_week
  ON challenge_game_runs(game_slug, week_key, score DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_challenge_runs_user_day
  ON challenge_game_runs(game_slug, telegram_user_id, day_key, created_at DESC);

INSERT OR IGNORE INTO platform_modules (id, kind, title, description, icon, public_url, telegram_url, enabled, sort_order, system, metadata_json) VALUES
  ('queue-commander', 'game', 'Queue Commander', 'Priority queue, retry, dedupe и idempotency предизвикателства.', '📡', '/games/queue-commander/', 'tg://resolve?domain=dyrakarmy_bot&startapp=queue_commander', 1, 41, 1, '{"game_number":1,"shared_profile":true}'),
  ('beat-hunter', 'game', 'Beat Hunter', 'Ритми, фразиране, beatgrid и DJ структура.', '🥁', '/games/beat-hunter/', 'tg://resolve?domain=dyrakarmy_bot&startapp=beat_hunter', 1, 42, 1, '{"game_number":2,"shared_profile":true}'),
  ('format-forge', 'game', 'Format Forge', 'Формати, bitrate, lossless и device compatibility.', '⚒', '/games/format-forge/', 'tg://resolve?domain=dyrakarmy_bot&startapp=format_forge', 1, 44, 1, '{"game_number":4,"shared_profile":true}'),
  ('server-defender', 'game', 'Server Defender', 'SSRF, secrets, webhook, CORS и rate-limit защита.', '🛡', '/games/server-defender/', 'tg://resolve?domain=dyrakarmy_bot&startapp=server_defender', 1, 45, 1, '{"game_number":5,"shared_profile":true}'),
  ('metadata-detective', 'game', 'Metadata Detective', 'Artist, title, album, year, ISRC и cover разследвания.', '🕵', '/games/metadata-detective/', 'tg://resolve?domain=dyrakarmy_bot&startapp=metadata_detective', 1, 46, 1, '{"game_number":6,"shared_profile":true}'),
  ('link-runner', 'game', 'Link Runner', 'Безопасни URL схеми, redirects, DNS и нормализация.', '🔗', '/games/link-runner/', 'tg://resolve?domain=dyrakarmy_bot&startapp=link_runner', 1, 47, 1, '{"game_number":7,"shared_profile":true}'),
  ('bot-vs-human', 'game', 'Bot vs Human', 'Privacy-aware разпознаване на автоматизирано поведение.', '🤖', '/games/bot-vs-human/', 'tg://resolve?domain=dyrakarmy_bot&startapp=bot_vs_human', 1, 50, 1, '{"game_number":10,"shared_profile":true}');
