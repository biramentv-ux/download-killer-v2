// @ts-expect-error Vitest executes this asset inspection in Node; Worker production types intentionally omit node built-ins.
import { readFileSync } from 'node:fs';
// @ts-expect-error Vitest executes this asset inspection in Node; Worker production types intentionally omit node built-ins.
import { resolve } from 'node:path';
// @ts-expect-error Vitest executes this asset inspection in Node; Worker production types intentionally omit node built-ins.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

describe('DyrakArmy Sound Universe v19', () => {
  it('ships parseable shared assets and a complete integration manifest', () => {
    const css = read('public/platform/sound-universe-v19.css');
    const runtime = read('public/platform/sound-universe-v19.js');
    const manifest = JSON.parse(read('public/platform/sound-universe-v19-manifest.json'));

    expect(() => new Function(runtime)).not.toThrow();
    expect(css).toContain('DyrakArmy Sound Universe v19');
    expect(css).toContain('body[data-da-surface="web"]');
    expect(css).toContain('body[data-da-surface="telegram"]');
    expect(css).toContain('body[data-da-surface="control"]');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(manifest.feature_version).toBe('19.0.0');
    expect(manifest.surfaces).toEqual(['web', 'telegram-mini-app', 'control-center']);
    expect(manifest.domains.primary).toBe('https://dyrakarmy.eu');
    expect(manifest.domains.secondary).toBe('https://dyrakarmy.online');
  });

  it('loads the theme on the web, Telegram and Control Center without replacing core logic', () => {
    const defaults = read('public/platform/site-defaults.js');
    const telegram = read('public/telegram/index.html');
    const control = read('public/control-v2/index.html');

    expect(defaults).toContain("loadStylesheet('/platform/sound-universe-v19.css')");
    expect(defaults).toContain("loadScript('/platform/sound-universe-v19.js', '19.0.0')");
    expect(telegram).toContain('data-da-surface="telegram"');
    expect(telegram).toContain('/platform/sound-universe-v19.css?v=19.0.0');
    expect(telegram).toContain('/platform/sound-universe-v19.js?v=19.0.0');
    expect(control).toContain('data-da-surface="control"');
    expect(control).toContain('/platform/sound-universe-v19.css?v=19.0.0');
    expect(control).toContain('/platform/sound-universe-v19.js?v=19.0.0');

    for (const requiredId of ['downloadForm', 'runtimeDiagnostic', 'archivePanel']) expect(telegram).toContain(`id="${requiredId}"`);
    for (const requiredId of ['linkDeviceBtn', 'roleForm', 'profileForm']) expect(control).toContain(`id="${requiredId}"`);
  });

  it('uses only working public navigation targets and keeps both domains synchronized', () => {
    const runtime = read('public/platform/sound-universe-v19.js');
    const landing = read('public/index.html');
    const gamesRuntime = read('public/platform/games-v14.js');
    const staticTargets = ['home', 'engines', 'software', 'console', 'community', 'status'];

    expect(runtime).toContain("const PRIMARY_HOST = 'dyrakarmy.eu'");
    expect(runtime).toContain("const SECONDARY_HOST = 'dyrakarmy.online'");
    expect(runtime).toContain('fetch(`/api/health?');
    for (const target of staticTargets) {
      expect(runtime).toContain(`'#${target}'`);
      expect(landing).toContain(`id="${target}"`);
    }
    expect(runtime).toContain("'#games'");
    expect(gamesRuntime).toContain("section.id = 'games'");
    expect(runtime).toContain("['/control-v2/'");
  });
});
