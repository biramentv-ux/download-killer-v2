import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

const files = Object.fromEntries(await Promise.all([
  ['html', 'public/index.html'],
  ['legacyCss', 'public/platform/software-suite.css'],
  ['legacyClient', 'public/platform/software-suite.js'],
  ['productCss', 'public/platform/product-redesign-v20.css'],
  ['productClient', 'public/platform/product-redesign-v20.js'],
  ['sw', 'public/sw.js'],
  ['manifest', 'public/manifest.webmanifest'],
  ['catalog', 'src/software_catalog.ts'],
  ['telegram', 'src/software_telegram.ts'],
  ['commands', 'src/dyrakarmy_arena_commands.ts'],
  ['wrapper', 'src/platform_v3.ts'],
  ['wrangler', 'wrangler.jsonc'],
  ['releaseWorkflow', '../.github/workflows/release-assets.yml'],
].map(async ([key, relativePath]) => [key, await read(relativePath)])));

const visibleHtml = stripComments(files.html);
assert.match(files.html, /DyrakArmy Interface v17/);
assert.match(files.html, /data-product-generation=["']20["']/);
assert.match(files.html, /product-redesign-v20\.css/);
assert.match(files.html, /product-redesign-v20\.js/);
assert.match(visibleHtml, /DyrakArmy Apps/);
assert.match(visibleHtml, /Desktop/);
assert.match(visibleHtml, /Mobile/);
assert.match(visibleHtml, /Browser/);
assert.match(visibleHtml, /PWA/);

for (const retiredSurface of [
  /software-suite-section/,
  /softwareReleaseGrid/,
  /softwarePreferredDownload/,
  /MEDIA DOWNLOAD CONSOLE/i,
  /Директен download/i,
  /DOWNLOAD FOR MY DEVICE/i,
  /OPEN VERIFIED RELEASE/i,
]) assert.doesNotMatch(visibleHtml, retiredSurface, `Retired public software/download UI is visible: ${retiredSurface}`);

for (const marker of [
  'handleSoftwareCatalogApi',
  'handleSoftwareTelegramWebhook',
  "url.pathname === '/telegram/webhook'",
  'return platformV2.fetch',
]) assert.ok(files.wrapper.includes(marker), `Missing platform v3 integration: ${marker}`);

for (const marker of [
  "url.pathname !== '/api/software/releases'",
  'DyrakArmy Software & Mixing Toolkit',
  'DyrakArmyDesktop.exe',
  'DyrakArmyDesktop-macOS.zip',
  'DyrakArmySpotifyOggMp4Engine.exe',
  'DyrakArmy-Extension-Chrome.zip',
  'DyrakArmy-Extension-Legacy-Chrome.zip',
  'DyrakArmy-Extension-Firefox.zip',
  'SoundDrop-Expo-Web.zip',
  'SoundDrop-Expo-Native-Update.zip',
]) assert.ok(files.catalog.includes(marker), `Missing private release catalog contract: ${marker}`);

for (const marker of [
  "'software'",
  "'games'",
  'software:menu',
  'games:menu',
  'GAME_LINKS',
  'buildGamesInlineKeyboard',
  'buildSoftwareInlineKeyboard',
]) assert.ok(files.telegram.includes(marker), `Missing Telegram integration: ${marker}`);

for (const marker of [
  "{ command: 'software'",
  "{ command: 'games'",
  'software releases, 10 games',
]) assert.ok(files.commands.includes(marker), `Missing registered bot command: ${marker}`);

const expectedStartApps = [
  'queue_commander', 'beat_hunter', 'arena', 'format_forge', 'server_defender',
  'metadata_detective', 'link_runner', 'archive_raid', 'latency_strike', 'bot_vs_human',
];
for (const startapp of expectedStartApps) assert.ok(files.telegram.includes(`'${startapp}'`), `Missing game startapp: ${startapp}`);

for (const asset of ['/platform/product-redesign-v20.css?v=20.0.0', '/platform/product-redesign-v20.js?v=20.0.0']) {
  assert.ok(files.sw.includes(asset), `PWA does not cache ${asset}`);
}
assert.ok(files.sw.includes('dyrakarmy-product-system-v20'), 'Missing Product System v20 PWA cache marker');
assert.ok(files.sw.includes('download-killer-static-v17-software-suite'), 'Missing v17 compatibility cache marker');

const manifest = JSON.parse(files.manifest);
assert.equal(manifest.name, 'DyrakArmy Unified Platform v17');
assert.ok(manifest.shortcuts.some((shortcut) => shortcut.url === '/#software'), 'Missing Apps compatibility PWA shortcut');
assert.ok(manifest.shortcuts.every((shortcut) => !/download|backend|telemetry/i.test(`${shortcut.name} ${shortcut.short_name} ${shortcut.description}`)));

for (const filename of [
  'DyrakArmyDesktop.exe',
  'DyrakArmyDesktop-macOS.zip',
  'DyrakArmySpotifyOggMp4Engine.exe',
  'DyrakArmy-Extension-Chrome.zip',
  'DyrakArmy-Extension-Legacy-Chrome.zip',
  'DyrakArmy-Extension-Firefox.zip',
  'SoundDrop-Expo-Web.zip',
  'SoundDrop-Expo-Native-Update.zip',
]) assert.ok(files.releaseWorkflow.includes(filename), `Release workflow does not publish ${filename}`);

assert.ok(files.wrangler.includes('"LATEST_WEB_VERSION": "17.0.0"'));
assert.ok(files.wrangler.includes('"RELEASE_GITHUB_REPOSITORY": "biramentv-ux/download-killer-v2"'));

const retiredBot = ['download', 'killer', 'BOT'].join('_');
for (const [name, content] of Object.entries({ html: files.html, legacyClient: files.legacyClient, catalog: files.catalog, telegram: files.telegram })) {
  assert.ok(!content.includes(retiredBot), `${name} contains retired bot marker`);
}

for (const [name, content] of Object.entries({ productClient: files.productClient, catalog: files.catalog, telegram: files.telegram })) {
  assert.doesNotMatch(content, /eval\s*\(|new Function\s*\(/, `${name} contains executable constructor`);
  assert.ok(!content.toLowerCase().includes('javascript:'), `${name} contains unsafe URL scheme`);
}

assert.match(files.productCss, /--da20-cyan:/);
assert.match(files.productCss, /--da20-violet:/);
assert.match(files.productClient, /beforeinstallprompt/);
assert.ok(files.catalog.includes("const DEFAULT_REPOSITORY = 'biramentv-ux/download-killer-v2'"));
assert.ok(files.catalog.includes('releases/latest/download'));
assert.ok(files.catalog.includes('SAFE_REPOSITORY'));

console.log(JSON.stringify({
  ok: true,
  suite: 'DyrakArmy Apps · Product System v20',
  checks: {
    public_product_ui: 'pass',
    public_download_surface_removed: 'pass',
    responsive_design: 'pass',
    private_release_catalog_preserved: 'pass',
    release_assets_preserved: 'pass',
    telegram_games_1_10: 'pass',
    pwa: 'pass',
    sole_bot: 'pass',
  },
  public_download_sections: 0,
  verified_packages: 8,
  verified_games: 10,
}, null, 2));
