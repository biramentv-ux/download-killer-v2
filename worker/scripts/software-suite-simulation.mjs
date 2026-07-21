import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

const files = Object.fromEntries(await Promise.all([
  ['html', 'public/index.html'],
  ['css', 'public/platform/software-suite.css'],
  ['client', 'public/platform/software-suite.js'],
  ['sw', 'public/sw.js'],
  ['manifest', 'public/manifest.webmanifest'],
  ['catalog', 'src/software_catalog.ts'],
  ['telegram', 'src/software_telegram.ts'],
  ['commands', 'src/dyrakarmy_arena_commands.ts'],
  ['wrapper', 'src/platform_v3.ts'],
  ['wrangler', 'wrangler.jsonc'],
  ['releaseWorkflow', '../.github/workflows/release-assets.yml'],
].map(async ([key, relativePath]) => [key, await read(relativePath)])));

const requiredHtmlMarkers = [
  'DyrakArmy Interface v17',
  'id="software"',
  'id="softwareReleaseGrid"',
  'id="softwarePreferredDownload"',
  'id="softwareTelegramButton"',
  'id="softwareChannel"',
  'id="detectedSoftwarePlatform"',
  '/platform/software-suite.css',
  '/platform/software-suite.js',
  'SOFTWARE &amp; MIXING TOOLKIT',
  '/api/software/releases',
  '@dyrakarmy_bot',
];
for (const marker of requiredHtmlMarkers) assert.ok(files.html.includes(marker), `Missing HTML marker: ${marker}`);

for (const marker of [
  '.software-suite-section',
  '.software-showcase',
  '.mix-monitor',
  '.software-release-grid',
  '.software-release-card',
  '@media (max-width: 920px)',
  '@media (max-width: 640px)',
]) assert.ok(files.css.includes(marker), `Missing CSS contract: ${marker}`);

for (const marker of [
  "fetch('/api/software/releases'",
  'detectPlatform()',
  'data-software-filter',
  'DyrakArmySoftware',
  'releases/latest/download',
]) assert.ok(files.client.includes(marker), `Missing browser client contract: ${marker}`);

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
]) assert.ok(files.catalog.includes(marker), `Missing release catalog contract: ${marker}`);

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

for (const asset of ['/platform/software-suite.css', '/platform/software-suite.js']) {
  assert.ok(files.sw.includes(asset), `PWA does not cache ${asset}`);
}
assert.ok(files.sw.includes('download-killer-static-v17-software-suite'), 'Missing v17 PWA cache marker');

const manifest = JSON.parse(files.manifest);
assert.equal(manifest.name, 'DyrakArmy Unified Platform v17');
assert.ok(manifest.shortcuts.some((shortcut) => shortcut.url === '/#software'), 'Missing Software PWA shortcut');

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
for (const [name, content] of Object.entries({ html: files.html, client: files.client, catalog: files.catalog, telegram: files.telegram })) {
  assert.ok(!content.includes(retiredBot), `${name} contains retired bot marker`);
}

const executableConstructors = [
  ['ev', 'al('].join(''),
  ['new', ' Function('].join(''),
];
const unsafeScheme = ['java', 'script:'].join('');
for (const [name, content] of Object.entries({ client: files.client, catalog: files.catalog, telegram: files.telegram })) {
  for (const marker of executableConstructors) assert.ok(!content.includes(marker), `${name} contains executable constructor`);
  assert.ok(!content.toLowerCase().includes(unsafeScheme), `${name} contains unsafe URL scheme`);
}

assert.ok(files.catalog.includes("const DEFAULT_REPOSITORY = 'biramentv-ux/download-killer-v2'"));
assert.ok(files.catalog.includes('releases/latest/download'));
assert.ok(files.catalog.includes('SAFE_REPOSITORY'));
assert.ok(files.client.includes('github\\.com|dyrakarmy'));

const report = {
  ok: true,
  suite: 'DyrakArmy Software & Mixing Toolkit v17',
  checks: {
    public_ui: 'pass',
    responsive_css: 'pass',
    dynamic_catalog: 'pass',
    release_assets: 'pass',
    telegram_software: 'pass',
    telegram_games_1_10: 'pass',
    pwa: 'pass',
    safety: 'pass',
    sole_bot: 'pass',
  },
  verified_packages: 8,
  verified_games: 10,
};

console.log(JSON.stringify(report, null, 2));
