import { describe, expect, it } from 'vitest';

import {
  cleanupStaleKvKeys,
  hashAndCachePrivateUrl,
  resolvePrivateUrl,
  verifyExternalHmacRequest,
  verifyTelegramWebhookToken,
} from '../src/security';
import type { Env } from '../src/types';

const encoder = new TextEncoder();

class MemoryKv {
  store = new Map<string, { value: string; expiration?: number }>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiration = options?.expirationTtl ? Math.floor(Date.now() / 1000) + options.expirationTtl : undefined;
    this.store.set(key, { value, expiration });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string; expiration?: number }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? '';
    return {
      keys: [...this.store.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .slice(0, options?.limit ?? 1000)
        .map(([name, entry]) => ({ name, expiration: entry.expiration })),
      list_complete: true,
    };
  }
}

class FailingPutKv extends MemoryKv {
  override async put(): Promise<void> {
    throw new Error('KV put() limit exceeded for the day.');
  }
}

describe('security private URL cache', () => {
  it('stores only a hash value for D1 and resolves plaintext from KV', async () => {
    const kv = new MemoryKv();
    const env = { CACHE: kv, PRIVATE_URL_TTL_SECONDS: '60' } as unknown as Env;

    const hash = await hashAndCachePrivateUrl(env, 'job', 'job-1', 'https://example.com/song?id=private');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain('example.com');
    await expect(resolvePrivateUrl(env, 'job', 'job-1', hash)).resolves.toBe('https://example.com/song?id=private');
  });

  it('keeps queue creation non-fatal when private URL KV writes hit quota', async () => {
    const kv = new FailingPutKv();
    const env = { CACHE: kv, PRIVATE_URL_TTL_SECONDS: '60' } as unknown as Env;

    const hash = await hashAndCachePrivateUrl(env, 'job', 'job-2', 'https://example.com/song?id=private');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain('example.com');
    await expect(resolvePrivateUrl(env, 'job', 'job-2', hash)).resolves.toBeNull();
  });
});

describe('security Telegram webhook JWT', () => {
  it('accepts short-lived HS256 JWT token', async () => {
    const token = await createHs256Jwt(
      {
        iss: 'dyrakarmy',
        aud: 'telegram-webhook',
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      'jwt-secret',
    );

    const env = { TELEGRAM_WEBHOOK_JWT_SECRET: 'jwt-secret', TELEGRAM_WEBHOOK_REQUIRE_JWT: '1' } as Env;
    await expect(verifyTelegramWebhookToken(token, env)).resolves.toBe(true);
  });

  it('falls back to static Telegram secret when JWT is not required', async () => {
    const env = { TELEGRAM_SECRET_TOKEN: 'static-secret' } as Env;
    await expect(verifyTelegramWebhookToken('static-secret', env)).resolves.toBe(true);
    await expect(verifyTelegramWebhookToken('wrong', env)).resolves.toBe(false);
  });
});

describe('security external HMAC webhook', () => {
  it('verifies HMAC signed request body', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = '{"ok":true}';
    const signature = await hmacHex('hook-secret', `${timestamp}.${body}`);
    const request = new Request('https://example.com/api/webhooks/external/ping', {
      method: 'POST',
      headers: {
        'X-DyrakArmy-Timestamp': timestamp,
        'X-DyrakArmy-Signature': `sha256=${signature}`,
      },
      body,
    });

    const env = { WEBHOOK_HMAC_SECRET: 'hook-secret', WEBHOOK_HMAC_MAX_SKEW_SECONDS: '300' } as Env;
    await expect(verifyExternalHmacRequest(request, body, env)).resolves.toEqual({ ok: true });
  });
});

describe('security KV cleanup', () => {
  it('deletes matching keys without expiration only', async () => {
    const kv = new MemoryKv();
    kv.store.set('url:job:stale', { value: 'https://example.com/a' });
    await kv.put('url:job:fresh', 'https://example.com/b', { expirationTtl: 60 });
    kv.store.set('prefs:keep', { value: '1' });

    const env = {
      CACHE: kv,
      KV_CLEANUP_PREFIXES: 'url:',
      KV_CLEANUP_MAX_KEYS: '10',
    } as unknown as Env;

    await expect(cleanupStaleKvKeys(env)).resolves.toEqual({ scanned: 2, deleted: 1 });
    expect(kv.store.has('url:job:stale')).toBe(false);
    expect(kv.store.has('url:job:fresh')).toBe(true);
    expect(kv.store.has('prefs:keep')).toBe(true);
  });
});

async function createHs256Jwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  const unsigned = `${header}.${body}`;
  const signature = base64UrlBytes(await hmacBytes(secret, unsigned));
  return `${unsigned}.${signature}`;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const bytes = await hmacBytes(secret, message);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function hmacBytes(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function base64Url(value: string): string {
  return base64UrlBytes(encoder.encode(value));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
