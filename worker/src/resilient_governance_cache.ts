import type { Env } from './types';

type KvReadMode = 'text' | 'json' | 'arrayBuffer' | 'stream';
type KvReadOptions = KvReadMode | { type?: KvReadMode } | undefined;
type FallbackRow = { value: string; expires_at: string | null };

type MinimalKv = {
  get(key: string, options?: unknown): Promise<unknown>;
  put(key: string, value: unknown, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

const RESILIENT_PREFIXES = ['platform:link:v2:', 'platform:session:v2:'] as const;
const schemaReady = new WeakMap<object, Promise<void>>();

export function isResilientGovernanceKey(key: string): boolean {
  return RESILIENT_PREFIXES.some((prefix) => String(key || '').startsWith(prefix));
}

export async function ensureResilientGovernanceCacheSchema(env: Pick<Env, 'DB'>): Promise<void> {
  const dbKey = env.DB as unknown as object;
  let pending = schemaReady.get(dbKey);
  if (!pending) {
    pending = (async () => {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS platform_resilient_kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_platform_resilient_kv_expiry ON platform_resilient_kv(expires_at)').run();
      await env.DB.prepare('DELETE FROM platform_resilient_kv WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP').run();
    })().catch((error) => {
      schemaReady.delete(dbKey);
      throw error;
    });
    schemaReady.set(dbKey, pending);
  }
  await pending;
}

export function createResilientGovernanceCache(env: Pick<Env, 'DB' | 'CACHE'>): KVNamespace {
  const original = env.CACHE as unknown as MinimalKv & Record<PropertyKey, unknown>;

  return new Proxy(original, {
    get(target, property) {
      if (property === 'get') {
        return async (key: string, options?: KvReadOptions): Promise<unknown> => {
          if (!isResilientGovernanceKey(key)) return target.get(key, options);

          try {
            const cached = await target.get(key, options);
            if (cached !== null && cached !== undefined) return cached;
          } catch (error) {
            console.warn('Governance KV read failed; using D1 fallback', error);
          }

          await ensureResilientGovernanceCacheSchema(env);
          const row = await env.DB.prepare(`
            SELECT value, expires_at
            FROM platform_resilient_kv
            WHERE key = ? AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
            LIMIT 1
          `).bind(key).first<FallbackRow>();
          if (!row) return null;
          return decodeFallbackValue(row.value, options);
        };
      }

      if (property === 'put') {
        return async (key: string, value: unknown, options?: { expirationTtl?: number }): Promise<void> => {
          if (!isResilientGovernanceKey(key)) {
            await target.put(key, value, options);
            return;
          }

          const serialized = serializeFallbackValue(value);
          const ttl = Number(options?.expirationTtl || 0);
          const expiresAt = Number.isFinite(ttl) && ttl > 0
            ? new Date(Date.now() + ttl * 1000).toISOString()
            : null;

          let d1Succeeded = false;
          let kvSucceeded = false;
          let d1Error: unknown;
          let kvError: unknown;

          try {
            await ensureResilientGovernanceCacheSchema(env);
            await env.DB.prepare(`
              INSERT INTO platform_resilient_kv (key, value, expires_at, updated_at)
              VALUES (?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                expires_at = excluded.expires_at,
                updated_at = CURRENT_TIMESTAMP
            `).bind(key, serialized, expiresAt).run();
            d1Succeeded = true;
          } catch (error) {
            d1Error = error;
          }

          try {
            await target.put(key, value, options);
            kvSucceeded = true;
          } catch (error) {
            kvError = error;
            console.warn('Governance KV write failed; D1 remains authoritative', error);
          }

          if (!d1Succeeded && !kvSucceeded) throw kvError || d1Error || new Error('Unable to persist governance state');
        };
      }

      if (property === 'delete') {
        return async (key: string): Promise<void> => {
          if (!isResilientGovernanceKey(key)) {
            await target.delete(key);
            return;
          }

          const outcomes = await Promise.allSettled([
            (async () => {
              await ensureResilientGovernanceCacheSchema(env);
              await env.DB.prepare('DELETE FROM platform_resilient_kv WHERE key = ?').bind(key).run();
            })(),
            target.delete(key),
          ]);
          if (outcomes.every((outcome) => outcome.status === 'rejected')) {
            const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
            throw rejected?.reason || new Error('Unable to delete governance state');
          }
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as KVNamespace;
}

export function withResilientGovernanceCache<T extends Env>(env: T): T {
  const resilientCache = createResilientGovernanceCache(env);
  return Object.assign(Object.create(env), { CACHE: resilientCache }) as T;
}

export function decodeFallbackValue(value: string, options?: KvReadOptions): unknown {
  const mode = typeof options === 'string' ? options : options?.type || 'text';
  if (mode === 'json') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (mode === 'arrayBuffer') return new TextEncoder().encode(value).buffer;
  if (mode === 'stream') return new Blob([value]).stream();
  return value;
}

function serializeFallbackValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  return JSON.stringify(value);
}
