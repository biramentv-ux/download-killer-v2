import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

describe('Platform v18 browser assets', () => {
  it('ships parseable landing and Control Center language packs', () => {
    const landing = read('public/platform/i18n-v18.js');
    const control = read('public/control-v2/control-v2-i18n.js');
    expect(() => new Function(landing)).not.toThrow();
    expect(() => new Function(control)).not.toThrow();
    for (const language of ['bg', 'en', 'ru', 'de']) {
      expect(landing).toContain(`${language}: {`);
      expect(control).toContain(`${language}: {`);
    }
    expect(landing).toContain("button.addEventListener('click'");
    expect(control).toContain("button.addEventListener('click'");
  });

  it('loads the source discovery module and exposes real language buttons in Control Center', () => {
    const defaults = read('public/platform/site-defaults.js');
    const discovery = read('public/platform/source-discovery-v18.js');
    const controlHtml = read('public/control-v2/index.html');
    expect(() => new Function(discovery)).not.toThrow();
    expect(defaults).toContain("loadScript('/platform/i18n-v18.js')");
    expect(defaults).toContain("loadScript('/platform/source-discovery-v18.js')");
    expect(controlHtml).toContain('data-control-lang="bg"');
    expect(controlHtml).toContain('data-control-lang="de"');
    expect(controlHtml).toContain('control-v2-i18n.js?v=18.0.0');
  });
});
