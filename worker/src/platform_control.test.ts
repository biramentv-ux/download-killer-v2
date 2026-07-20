import { describe, expect, it } from 'vitest';
import { isPlatformAdminId, parsePlatformAdminIds } from './platform_control';

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
});
