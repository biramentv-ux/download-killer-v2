import { describe, expect, it } from 'vitest';
import { buildSoftwareCatalog, handleSoftwareCatalogApi } from './software_catalog';

describe('DyrakArmy software catalog', () => {
  it('publishes all supported release packages from the canonical repository', () => {
    const catalog = buildSoftwareCatalog({
      LATEST_DESKTOP_WINDOWS_VERSION: '7.2.1',
      LATEST_DESKTOP_MACOS_VERSION: '7.2.1',
      LATEST_MOBILE_EXPO_VERSION: '1.0.1',
      LATEST_EXTENSION_VERSION: '1.2.0',
      LATEST_WEB_VERSION: '17.0.0',
      RELEASE_CHANNEL: 'stable',
      RELEASE_GITHUB_REPOSITORY: 'biramentv-ux/download-killer-v2',
      PUBLIC_BASE_URL: 'https://dyrakarmy.eu',
    } as never);

    expect(catalog.ok).toBe(true);
    expect(catalog.product).toBe('DyrakArmy Software & Mixing Toolkit');
    expect(catalog.releases).toHaveLength(9);
    expect(catalog.telegram).toEqual({
      bot: '@dyrakarmy_bot',
      command: '/software',
      games_command: '/games',
    });

    const filenames = catalog.releases.map((entry) => entry.filename).filter(Boolean);
    expect(filenames).toEqual(expect.arrayContaining([
      'DyrakArmyDesktop.exe',
      'DyrakArmyDesktop-macOS.zip',
      'DyrakArmySpotifyOggMp4Engine.exe',
      'DyrakArmy-Extension-Chrome.zip',
      'DyrakArmy-Extension-Legacy-Chrome.zip',
      'DyrakArmy-Extension-Firefox.zip',
      'SoundDrop-Expo-Web.zip',
      'SoundDrop-Expo-Native-Update.zip',
    ]));

    for (const release of catalog.releases) {
      expect(release.version).toMatch(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/);
      expect(['windows', 'macos', 'browser', 'mobile', 'web']).toContain(release.platform);
      if (release.action === 'download') {
        expect(release.url).toMatch(/^https:\/\/github\.com\/biramentv-ux\/download-killer-v2\/releases\/latest\/download\//);
      } else {
        expect(release.url).toBe('https://dyrakarmy.eu/#home');
      }
    }
  });

  it('rejects unsafe repository and version overrides', () => {
    const catalog = buildSoftwareCatalog({
      RELEASE_GITHUB_REPOSITORY: 'javascript:alert(1)',
      LATEST_DESKTOP_WINDOWS_VERSION: '<script>',
      RELEASE_CHANNEL: 'unknown',
      PUBLIC_BASE_URL: 'https://dyrakarmy.eu',
    } as never);

    const windows = catalog.releases.find((entry) => entry.id === 'desktop-windows');
    expect(windows?.version).toBe('7.2.1');
    expect(windows?.url).toContain('/biramentv-ux/download-killer-v2/releases/latest/download/');
    expect(catalog.channel).toBe('stable');
  });

  it('serves the public catalog only on the intended GET route', async () => {
    const env = { PUBLIC_BASE_URL: 'https://dyrakarmy.eu' } as never;
    const response = await handleSoftwareCatalogApi(
      new Request('https://dyrakarmy.eu/api/software/releases'),
      env,
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get('X-DyrakArmy-Software-Catalog')).toBe('v1');
    const payload = await response?.json() as { ok?: boolean; releases?: unknown[] };
    expect(payload.ok).toBe(true);
    expect(payload.releases).toHaveLength(9);

    await expect(handleSoftwareCatalogApi(
      new Request('https://dyrakarmy.eu/api/software/releases', { method: 'POST' }),
      env,
    )).resolves.toBeNull();
  });
});
