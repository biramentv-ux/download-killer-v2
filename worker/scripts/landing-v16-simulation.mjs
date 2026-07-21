import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [html, css, script, sw, manifest, controlHtml, controlCss, controlSw] = await Promise.all([
  read('public/index.html'),
  read('public/platform/landing-v16.css'),
  read('public/platform/landing-v16.js'),
  read('public/sw.js'),
  read('public/manifest.webmanifest'),
  read('public/control-v2/index.html'),
  read('public/control-v2/control-v2.css'),
  read('public/control-v2/sw.js'),
]);

const requiredIds = [
  'mainNav', 'mobileNavToggle', 'languageSelect', 'installPwaBtn', 'globalHealth',
  'moduleGrid', 'profileName', 'profileRole', 'profileModules', 'profilePoints',
  'profileRank', 'profileMemberSince', 'profileSync', 'previewModuleList',
  'rewardXp', 'rewardRank', 'rewardUnlocks', 'downloadForm', 'mediaUrl',
  'sourceSelect', 'formatSelect', 'qualitySelect', 'launchBtn', 'pasteBtn',
  'jobFeed', 'clearJobsBtn', 'refreshStatusBtn', 'edgeStatus', 'originStatus',
  'formatStatus', 'latencyStatus', 'historyList', 'copyBotHandleBtn', 'year',
];
for (const id of requiredIds) assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);

assert.match(html, /<title>DyrakArmy Platform<\/title>/);
assert.match(html, /DyrakArmy Interface v16/);
assert.match(html, /ONE PLATFORM\./);
assert.match(html, /EVERY <span>DYRAKARMY<\/span>/);
assert.match(html, /\/platform\/landing-v16\.css/);
assert.match(html, /\/platform\/landing-v16\.js/);
assert.match(html, /\/platform\/games-v14\.js/);
assert.match(html, /\/platform\/platform-public\.js/);
assert.match(html, /tg:\/\/resolve\?domain=dyrakarmy_bot/);
assert.doesNotMatch(html, /SECONDARY BOT/i);
const retiredBot = 'download_killer' + 'BOT';
const browserFallback = 'web.telegram' + '.org';
assert.ok(!html.includes(retiredBot));
assert.ok(!html.includes(browserFallback));

for (const breakpoint of ['1180px', '920px', '620px']) {
  assert.match(css, new RegExp(`max-width:\\s*${breakpoint.replace('.', '\\.')}`));
}
assert.match(css, /--da-cyan:/);
assert.match(css, /\.overview-grid/);
assert.match(css, /\.module-grid/);
assert.match(css, /\.hero-emblem/);
assert.match(css, /prefers-reduced-motion/);

assert.match(script, /dyrakarmy\.platform\.session\.v2/);
assert.match(script, /identity\.telegram\.session/);
assert.match(script, /profile\.get/);
assert.match(script, /platform-registry-ready/);
assert.match(script, /beforeinstallprompt/);
assert.match(script, /serviceWorker\.register\('\/sw\.js'\)/);
assert.doesNotMatch(script, /eval\(|new Function\(/);

assert.match(sw, /download-killer-static-v16-dyrakarmy-dashboard/);
for (const asset of ['/platform/landing-v16.css', '/platform/landing-v16.js', '/control-v2/']) {
  assert.match(sw, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

const parsedManifest = JSON.parse(manifest);
assert.equal(parsedManifest.name, 'DyrakArmy Unified Platform v16');
assert.equal(parsedManifest.theme_color, '#050914');
assert.ok(parsedManifest.shortcuts.some((shortcut) => shortcut.url === '/control-v2/'));
assert.ok(parsedManifest.shortcuts.some((shortcut) => shortcut.url === '/control/'));
assert.ok(parsedManifest.shortcuts.some((shortcut) => shortcut.url === '/#games'));

assert.match(controlHtml, /DyrakArmy Control Center v2/);
assert.match(controlHtml, /brand-logo/);
assert.match(controlHtml, /control-v2\.css\?v=2\.1\.0/);
assert.match(controlCss, /--accent:\s*#00d9ff/);
assert.match(controlCss, /\.brand-logo/);
assert.match(controlCss, /max-width:\s*760px/);
assert.match(controlSw, /dyrakarmy-control-v2-2\.1\.0-cyber/);

console.log(JSON.stringify({
  ok: true,
  interface: 'DyrakArmy v16 cyber dashboard',
  responsive_breakpoints: [1180, 920, 620],
  functional_contract_ids: requiredIds.length,
  pwa: true,
  governance_profile: true,
  sole_telegram_bot: '@dyrakarmy_bot',
}, null, 2));
