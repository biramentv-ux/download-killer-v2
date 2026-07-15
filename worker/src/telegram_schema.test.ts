import { describe, expect, it } from 'vitest';
import {
  ensureDownloadJobsChatId,
  initializeTelegramStorageSchema,
} from './telegram_schema';

interface FakeDatabase {
  db: D1Database;
  queries: string[];
  execCalls: string[];
}

function createFakeDatabase(columnNames: string[]): FakeDatabase {
  const queries: string[] = [];
  const execCalls: string[] = [];
  const db = {
    async exec(sql: string): Promise<never> {
      execCalls.push(sql);
      throw new Error('Fake D1 rejects multiline exec input as incomplete SQL');
    },
    prepare(sql: string) {
      queries.push(sql);
      const statement = {
        bind() {
          return statement;
        },
        async all<T>() {
          if (sql !== 'PRAGMA table_info(download_jobs)') {
            throw new Error(`Unexpected all() query: ${sql}`);
          }
          return { results: columnNames.map((name) => ({ name })) as T[] };
        },
        async run() {
          const normalized = sql.trim();
          if (/^CREATE TABLE/i.test(normalized) && !/\)\s*$/s.test(normalized)) {
            throw new Error(`Incomplete CREATE TABLE statement: ${normalized}`);
          }
          return { success: true };
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, queries, execCalls };
}

describe('Telegram D1 schema bootstrap', () => {
  it('runs complete prepared statements without using multiline exec', async () => {
    const fake = createFakeDatabase(['id', 'url']);

    await expect(initializeTelegramStorageSchema(fake.db)).resolves.toBeUndefined();

    expect(fake.execCalls).toEqual([]);
    expect(fake.queries.some((query) => query.includes('CREATE TABLE IF NOT EXISTS telegram_media_objects'))).toBe(true);
    expect(fake.queries.some((query) => query.includes('CREATE TABLE IF NOT EXISTS telegram_user_links'))).toBe(true);
    expect(fake.queries).toContain(
      'CREATE INDEX IF NOT EXISTS idx_tg_media_channel_message ON telegram_media_objects(channel_id, channel_message_id)',
    );
    expect(fake.queries).toContain(
      'CREATE INDEX IF NOT EXISTS idx_tg_media_file_unique ON telegram_media_objects(telegram_file_unique_id)',
    );
    expect(fake.queries).toContain(
      'CREATE INDEX IF NOT EXISTS idx_tg_user_links_updated ON telegram_user_links(updated_at DESC)',
    );
    expect(fake.queries).toContain('ALTER TABLE download_jobs ADD COLUMN chat_id INTEGER');
    expect(fake.queries).toContain('CREATE INDEX IF NOT EXISTS idx_jobs_chat ON download_jobs(chat_id)');
  });

  it('leaves an existing chat_id column intact and still ensures its index', async () => {
    const fake = createFakeDatabase(['id', 'chat_id']);

    await expect(ensureDownloadJobsChatId(fake.db)).resolves.toBe('present');

    expect(fake.queries).not.toContain('ALTER TABLE download_jobs ADD COLUMN chat_id INTEGER');
    expect(fake.queries).toContain('CREATE INDEX IF NOT EXISTS idx_jobs_chat ON download_jobs(chat_id)');
  });

  it('does not assume download_jobs exists in a fresh database', async () => {
    const fake = createFakeDatabase([]);

    await expect(ensureDownloadJobsChatId(fake.db)).resolves.toBe('table-missing');

    expect(fake.queries).not.toContain('ALTER TABLE download_jobs ADD COLUMN chat_id INTEGER');
    expect(fake.queries).not.toContain('CREATE INDEX IF NOT EXISTS idx_jobs_chat ON download_jobs(chat_id)');
  });
});
