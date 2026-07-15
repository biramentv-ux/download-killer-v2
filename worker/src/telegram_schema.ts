export type DownloadJobsChatIdRepairResult = 'added' | 'present' | 'table-missing';

const TELEGRAM_STORAGE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS telegram_media_objects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storage_key TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'unknown',
    format TEXT NOT NULL,
    quality TEXT NOT NULL,
    title TEXT,
    artist TEXT,
    duration INTEGER,
    file_size INTEGER,
    content_hash TEXT,
    media_kind TEXT NOT NULL DEFAULT 'link',
    telegram_file_id TEXT,
    telegram_file_unique_id TEXT,
    channel_id TEXT,
    channel_message_id INTEGER,
    fallback_url TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_tg_media_job ON telegram_media_objects(job_id)',
  'CREATE INDEX IF NOT EXISTS idx_tg_media_hash ON telegram_media_objects(content_hash)',
  'CREATE INDEX IF NOT EXISTS idx_tg_media_created ON telegram_media_objects(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_tg_media_channel_message ON telegram_media_objects(channel_id, channel_message_id)',
  'CREATE INDEX IF NOT EXISTS idx_tg_media_file_unique ON telegram_media_objects(telegram_file_unique_id)',
  `CREATE TABLE IF NOT EXISTS telegram_user_links (
    telegram_user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    sync_key TEXT NOT NULL UNIQUE,
    username TEXT,
    first_name TEXT,
    language_code TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_tg_user_links_sync ON telegram_user_links(sync_key)',
  'CREATE INDEX IF NOT EXISTS idx_tg_user_links_updated ON telegram_user_links(updated_at DESC)',
] as const;

function isDuplicateColumnError(error: unknown): boolean {
  return /duplicate column name:\s*chat_id/i.test(error instanceof Error ? error.message : String(error));
}

export async function ensureDownloadJobsChatId(
  db: D1Database,
): Promise<DownloadJobsChatIdRepairResult> {
  const info = await db.prepare('PRAGMA table_info(download_jobs)').all<{ name: string }>();
  const columns = info.results ?? [];
  if (columns.length === 0) return 'table-missing';

  let result: DownloadJobsChatIdRepairResult = 'present';
  if (!columns.some((column) => column.name === 'chat_id')) {
    try {
      await db.prepare('ALTER TABLE download_jobs ADD COLUMN chat_id INTEGER').run();
      result = 'added';
    } catch (error) {
      // Multiple Worker isolates may race while repairing the same legacy database.
      // The second ALTER is safe to ignore only when the desired column now exists.
      if (!isDuplicateColumnError(error)) throw error;
    }
  }

  await db.prepare('CREATE INDEX IF NOT EXISTS idx_jobs_chat ON download_jobs(chat_id)').run();
  return result;
}

export async function initializeTelegramStorageSchema(db: D1Database): Promise<void> {
  // D1Database.exec() splits input on newlines. A formatted multi-line CREATE TABLE
  // therefore reaches SQLite as an incomplete first line. Prepared statements keep
  // each complete SQL statement intact and are safe to retry.
  for (const statement of TELEGRAM_STORAGE_SCHEMA_STATEMENTS) {
    await db.prepare(statement).run();
  }
  await ensureDownloadJobsChatId(db);
}
