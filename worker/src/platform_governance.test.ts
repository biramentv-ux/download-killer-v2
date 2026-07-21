import { describe, expect, it } from 'vitest';
import { normalizePlatformRole, parseDeviceLinkCommand, roleCan } from './platform_governance';

describe('DyrakArmy Platform Governance v2', () => {
  it('enforces the intended RBAC capability matrix', () => {
    expect(roleCan('owner', 'versions.rollback')).toBe(true);
    expect(roleCan('admin', 'roles.write')).toBe(true);
    expect(roleCan('admin', 'versions.rollback')).toBe(false);
    expect(roleCan('editor', 'module.write')).toBe(true);
    expect(roleCan('editor', 'roles.write')).toBe(false);
    expect(roleCan('moderator', 'content.write')).toBe(true);
    expect(roleCan('moderator', 'settings.write')).toBe(false);
    expect(roleCan('user', 'profile.write')).toBe(true);
    expect(roleCan('user', 'module.write')).toBe(false);
  });

  it('normalizes only published role identifiers', () => {
    expect(normalizePlatformRole('OWNER')).toBe('owner');
    expect(normalizePlatformRole(' moderator ')).toBe('moderator');
    expect(normalizePlatformRole('superadmin')).toBeNull();
    expect(normalizePlatformRole('')).toBeNull();
  });

  it('accepts one-time Telegram device-link commands', () => {
    expect(parseDeviceLinkCommand('/link AB23CD45')).toBe('AB23CD45');
    expect(parseDeviceLinkCommand('/link@dyrakarmy_bot ab23cd45')).toBe('AB23CD45');
    expect(parseDeviceLinkCommand('/link short')).toBeNull();
    expect(parseDeviceLinkCommand('/control')).toBeNull();
  });
});
