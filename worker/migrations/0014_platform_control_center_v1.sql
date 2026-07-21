-- Unified DyrakArmy platform registry, public content and audit trail.
CREATE TABLE IF NOT EXISTS platform_modules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '◈',
  public_url TEXT,
  telegram_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  system INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_content (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '◈',
  action_label TEXT,
  action_url TEXT,
  visible INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  starts_at TEXT,
  ends_at TEXT,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_audit (
  id TEXT PRIMARY KEY,
  admin_user_id INTEGER NOT NULL,
  admin_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_platform_modules_order
  ON platform_modules(enabled DESC, sort_order ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_platform_content_slot
  ON platform_content(slot, visible DESC, sort_order ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_created
  ON platform_audit(created_at DESC);

INSERT OR IGNORE INTO platform_modules (id, kind, title, description, icon, public_url, enabled, sort_order, system)
VALUES
  ('home', 'system', 'Начало', 'Главна секция на платформата.', '⌂', '/', 1, 10, 1),
  ('how-it-works', 'section', 'Как работи', 'Процесът от публичен URL до резултат.', '↗', '/#tutorial', 1, 20, 1),
  ('features', 'section', 'Функции', 'Backend, опашка, Telegram и сигурност.', '▤', '/#engines', 1, 30, 1),
  ('games', 'system', 'DyrakArmy Games', 'Общ игрови профил, XP, награди и класации.', '🎮', '/#games', 1, 40, 1),
  ('dyrakarmy-arena', 'game', 'DyrakArmy Arena', 'Отбори, дневни мисии, седмични лиги и сезони.', '⚔️', '/games/dyrakarmy-arena/', 1, 41, 1),
  ('latency-strike', 'game', 'Latency Strike', 'Реакция, общ XP и профилни награди.', '⚡', '/games/latency-strike/', 1, 42, 1),
  ('downloads', 'tool', 'Download Console', 'Публични URL задачи, формати и статус.', '↓', '/#console', 1, 50, 1),
  ('media-lab', 'tool', 'Media Lab', 'Metadata и безопасни медийни инструменти.', '◉', '/#media-lab', 1, 60, 1),
  ('telegram', 'system', 'Telegram Bot', 'Mini App, команди, архив и доставка.', '✈', NULL, 1, 70, 1),
  ('status', 'system', 'System Status', 'Публичен runtime статус и история.', '●', '/#status', 1, 80, 1),
  ('control-center', 'system', 'Control Center', 'Защитено дистанционно управление от телефон.', '⚙', '/control/', 1, 900, 1);

UPDATE platform_modules
SET telegram_url = 'tg://resolve?domain=dyrakarmy_bot&startapp=arena'
WHERE id = 'dyrakarmy-arena' AND telegram_url IS NULL;
UPDATE platform_modules
SET telegram_url = 'tg://resolve?domain=dyrakarmy_bot&game=latency_strike'
WHERE id = 'latency-strike' AND telegram_url IS NULL;
UPDATE platform_modules
SET telegram_url = 'tg://resolve?domain=dyrakarmy_bot'
WHERE id = 'telegram' AND telegram_url IS NULL;
UPDATE platform_modules
SET telegram_url = 'tg://resolve?domain=dyrakarmy_bot&startapp=control'
WHERE id = 'control-center' AND telegram_url IS NULL;

INSERT OR IGNORE INTO platform_settings (key, value_json) VALUES
  ('site.title', '"Download Killer"'),
  ('site.subtitle', '"DyrakArmy unified platform"'),
  ('site.footer', '"Web, Telegram, Games и Control Center върху общ edge backend."'),
  ('theme.accent', '"#8b5cff"'),
  ('theme.accent_secondary', '"#62d4ff"'),
  ('theme.background', '"#070a18"'),
  ('theme.radius', '18'),
  ('announcement.enabled', 'true'),
  ('games.season_label', '"SEASON 01"');
