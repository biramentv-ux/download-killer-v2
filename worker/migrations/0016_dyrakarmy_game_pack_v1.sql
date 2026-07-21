-- Seven additional DyrakArmy games sharing game_profiles, XP, ranks and rewards.
CREATE TABLE IF NOT EXISTS game_pack_runs (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
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
  opponent_score INTEGER,
  won_duel INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_user_id) REFERENCES game_profiles(telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_game_pack_runs_week
  ON game_pack_runs(game_id, week_key, score DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_game_pack_runs_user_day
  ON game_pack_runs(game_id, telegram_user_id, day_key, created_at DESC);

INSERT OR IGNORE INTO platform_modules (id, kind, title, description, icon, public_url, telegram_url, enabled, sort_order, system, metadata_json) VALUES
  ('queue-commander', 'game', 'Queue Commander', 'Стратегия за queues, retries, dedupe и backpressure.', '🎛', '/games/queue-commander/', 'tg://resolve?domain=dyrakarmy_bot&startapp=queue_commander', 1, 44, 1, '{"shared_profile":true}'),
  ('beat-hunter', 'game', 'Beat Hunter', 'Познай жанр, BPM и waveform структура по синтетични clues.', '🎧', '/games/beat-hunter/', 'tg://resolve?domain=dyrakarmy_bot&startapp=beat_hunter', 1, 45, 1, '{"copyright_safe":true,"shared_profile":true}'),
  ('format-forge', 'game', 'Format Forge', 'Избери правилния формат, качество и съвместимост.', '⚒', '/games/format-forge/', 'tg://resolve?domain=dyrakarmy_bot&startapp=format_forge', 1, 46, 1, '{"shared_profile":true}'),
  ('server-defender', 'game', 'Server Defender', 'Защити Worker, Queue, D1, KV и backend инфраструктурата.', '🛡', '/games/server-defender/', 'tg://resolve?domain=dyrakarmy_bot&startapp=server_defender', 1, 47, 1, '{"shared_profile":true}'),
  ('metadata-detective', 'game', 'Metadata Detective', 'Намери надежден artist, title, album и artwork match.', '🔎', '/games/metadata-detective/', 'tg://resolve?domain=dyrakarmy_bot&startapp=metadata_detective', 1, 48, 1, '{"shared_profile":true}'),
  ('link-runner', 'game', 'Link Runner', 'Сортирай URL-и по източник, маршрут и SSRF риск.', '🔗', '/games/link-runner/', 'tg://resolve?domain=dyrakarmy_bot&startapp=link_runner', 1, 49, 1, '{"shared_profile":true,"safe_urls_only":true}'),
  ('bot-vs-human', 'game', 'Bot vs Human', 'Адаптивен дуел срещу DK Core.', '🤖', '/games/bot-vs-human/', 'tg://resolve?domain=dyrakarmy_bot&startapp=bot_vs_human', 1, 50, 1, '{"shared_profile":true,"opponent":"DK Core"}');
