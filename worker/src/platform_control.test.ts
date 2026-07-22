import { describe, expect, it, vi } from 'vitest';
import { cachePlatformPublicRegistry, isPlatformAdminId, parsePlatformAdminIds } from './platform_control';

describe('DyrakArmy platform control authorization', () => {
  it('parses comma, space and semicolon separated Telegram IDs', () => {
    expect([...parsePlatformAdminIds('123, 456;789\n999')]).toEqual([123, 456, 789, 999]);
  });

  it('ignores invalid, negative and unsafe IDs', () => {
    expect([...parsePlatformAdminIds('abc,-3,0,12.5,9007199254740999,42')]).toEqual([42]);
  });

  it('allows only explicitly configured administrators', () => {
    const env = { TELEGRAM_ADMIN_IDS: '111,222' };
    expect(isPlatformAdminId(111, env)).toBe(true);
    expect(isPlatformAdminId(222, env)).toBe(true);
    expect(isPlatformAdminId(333, env)).toBe(false);
  });

  it('defaults to deny when the admin list is missing', () => {
    expect(isPlatformAdminId(111, {})).toBe(false);
  });

  it('keeps the public registry available when the KV write quota is exhausted', async () => {
    const put = vi.fn().mockRejectedValue(new Error('KV put() limit exceeded for the day.'));
    const cache = { put } as unknown as KVNamespace;

    await expect(cachePlatformPublicRegistry(cache, { ok: true })).resolves.toBeUndefined();

    expect(put).toHaveBeenCalledWith(
      'platform:public:registry:v1',
      '{"ok":true}',
      { expirationTtl: 90 },
    );
  });
});
