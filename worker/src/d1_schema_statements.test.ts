import { describe, expect, it, vi } from 'vitest';
import { applyD1SchemaStatements } from './schema';

describe('D1 schema statement execution', () => {
  it('batches complete prepared statements without using multiline exec', async () => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS example (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      'CREATE INDEX IF NOT EXISTS idx_example_created ON example(created_at DESC)',
    ];
    const prepared: string[] = [];
    const exec = vi.fn(() => {
      throw new Error('D1 exec splits multiline SQL on newlines');
    });
    const batch = vi.fn(async (items: unknown[]) => items.map(() => ({ success: true })));
    const db = {
      exec,
      prepare(sql: string) {
        prepared.push(sql);
        return { sql };
      },
      batch,
    } as unknown as D1Database;

    await expect(applyD1SchemaStatements({ DB: db }, statements)).resolves.toBeUndefined();

    expect(prepared).toEqual(statements);
    expect(batch).toHaveBeenCalledOnce();
    expect(exec).not.toHaveBeenCalled();
  });
});
