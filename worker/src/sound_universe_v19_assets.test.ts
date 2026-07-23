// @ts-expect-error Vitest executes this asset inspection in Node; Worker production types intentionally omit node built-ins.
import { readFileSync } from 'node:fs';
// @ts-expect-error Vitest executes this asset inspection in Node; Worker production types intentionally omit node built-ins.
import { resolve } from 'node:path';
// @ts-expect-error Vitest executes this asset inspection in Node; Worker production types intentionally omit node built-ins.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');
const stripComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');

describe('DyrakArmy Product System v20', () => {
  it('preserves the v19 source package while shipping the new shared product system', () => {
    const legacyCss = read('public/platform/sound-universe-v19.css');
    const legacyRuntime = read('public/platform/sound-universe-v19.js');
    const legacyManifest = JSON.parse(read('public/platform/sound-universe-v19-manifest.json'));
    const productCss = read('public/platform/product-redesign-v20.css');
    const productRuntime = read('public/platform/product-redesign-v20.js');

    expect(() => new Function(legacyRuntime)).not.toThrow();
    expect(() => new Function(productRuntime)).not.toThrow();
    expect(legacyCss).toContain('DyrakArmy Sound Universe v19');
    expect(legacyManifest.feature_version).toBe('19.0.0');
    expect(productCss).toContain('DyrakArmy Product System v20');
    expect(productCss).toContain('body[data-da-surface="telegram"]');
    expect(productCss).toContain('body[data-da-surface="control"]');
    expect(productCss).toContain('body[data-da-surface="game"]');
    expect(productCss).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('loads Product System v20 on web, Telegram, Control Center and games without replacing core logic', () => {
    const landing = read('public/index.html');
    const telegram = read('public/telegram/index.html');
    const control = read('public/control-v2/index.html');
    const challenge = read('public/games/challenge/index.html');

    for (const surface of [landing, telegram, control, challenge]) {
      expect(surface).toContain('data-product-generation="20"');
      expect(surface).toContain('/platform/product-redesign-v20.css?v=20.0.0');
    }
    expect(landing).toContain('/platform/product-redesign-v20.js?v=20.0.0');
    expect(telegram).toContain('/telegram/telegram-product-v20.js?v=20.0.0');
    expect(telegram).toContain('data-da-surface="telegram"');
    expect(control).toContain('data-da-surface="control"');
    expect(challenge).toContain('data-da-surface="game"');

    const visibleTelegram = stripComments(telegram);
    for (const retiredId of ['downloadForm', 'runtimeDiagnostic', 'archivePanel']) {
      expect(visibleTelegram).not.toContain(`id="${retiredId}"`);
    }
    for (const requiredId of ['searchForm', 'profileName', 'profileCardName']) expect(telegram).toContain(`id="${requiredId}"`);
    for (const requiredId of ['linkDeviceBtn', 'roleForm', 'profileForm']) expect(control).toContain(`id="${requiredId}"`);
  });

  it('uses product-first navigation targets and removes public download/backend surfaces', () => {
    const landing = read('public/index.html');
    const telegram = read('public/telegram/index.html');
    const productRuntime = read('public/platform/product-redesign-v20.js');
    const telegramRuntime = read('public/telegram/telegram-product-v20.js');
    const visibleLanding = stripComments(landing);
    const visibleTelegram = stripComments(telegram);
    const staticTargets = ['overview', 'experiences', 'studio', 'games', 'apps', 'profile', 'community'];

    for (const target of staticTargets) expect(landing).toContain(`id="${target}"`);
    expect(productRuntime).toContain("serviceWorker.register('/sw.js')");
    expect(productRuntime).toContain('beforeinstallprompt');
    expect(telegramRuntime).toContain("fetch('/api/search'");
    expect(telegramRuntime).not.toContain('/miniapp/download');
    expect(visibleLanding).not.toMatch(/MEDIA DOWNLOAD CENTER|MEDIA DOWNLOAD CONSOLE|id="downloadForm"/i);
    expect(visibleTelegram).not.toMatch(/data-tab="download"|id="downloadPanel"|id="archivePanel"/i);
    expect(landing).toContain('tg://resolve?domain=dyrakarmy_bot');
    expect(landing).toContain('/control-v2/');
  });
});
