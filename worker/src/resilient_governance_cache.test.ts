import { describe, expect, it, vi } from 'vitest';
import {
  createResilientGovernanceCache,
  decodeFallbackValue,
  isResilientGovernanceKey,
} from './resilient_governance_cache';

function createD1Mock() {
  const rows = new Map<string, { value: string; expires_at: string | null }>();
  const prepare = vi.fn((sql: string) => ({
    bind: (...bindings: unknown[]) => ({
      run: async () => {
        if (/INSERT INTO platform_resilient_kv/i.test(sql)) {
          rows.set(String(bindings[0]), { value: String(bindings[1]), expires_at: bindings[2] ? String(bindings[2]) : null });
        }
        if (/DELETE FROM platform_resilient_kv WHERE key/i.test(sql)) rows.delete(String(bindings[0]));
        return { success: true };
      },
      first: async () => rows.get(String(bindings[0])) ?? null,
    }),
    run: async () => ({ success: true }),
  }));
  return { db: { prepare }, rows };
}

describe('resilient governance cache', () => {
  it('recognizes only link and session keys', () => {
    expect(isResilientGovernanceKey('platform:link:v2:ABCDEFGH')).toBe(true);
    expect(isResilientGovernanceKey('platform:session:v2:token')).toBe(true);
    expect(isResilientGovernanceKey('search:youtube:test')).toBe(false);
  });

  it('decodes stored JSON and text values', () => {
    expect(decodeFallbackValue('{"ok":true}', 'json')).toEqual({ ok: true });
    expect(decodeFallbackValue('plain')).toBe('plain');
  });

  it('keeps identity link state available when KV writes are rejected', async () => {
    const { db, rows } = createD1Mock();
    const kv = {
      get: vi.fn(async () => { throw new Error('KV put() limit exceeded for the day'); }),
      put: vi.fn(async () => { throw new Error('KV put() limit exceeded for the day'); }),
      delete: vi.fn(async () => undefined),
    };
    const cache = createResilientGovernanceCache({ DB: db as never, CACHE: kv as never });

    await cache.put('platform:link:v2:ABCDEFGH', JSON.stringify({ status: 'pending' }), { expirationTtl: 600 });
    expect(rows.has('platform:link:v2:ABCDEFGH')).toBe(true);
    await expect(cache.get('platform:link:v2:ABCDEFGH', 'json')).resolves.toEqual({ status: 'pending' });
  });
});
