import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

const [
  webHtml,
  telegramHtml,
  controlHtml,
  challengeHtml,
  arenaHtml,
  raidHtml,
  latencyHtml,
  productCss,
  productJs,
  telegramJs,
  manifestText,
  serviceWorker,
] = await Promise.all([
  read('public/index.html'),
  read('public/telegram/index.html'),
  read('public/control-v2/index.html'),
  read('public/games/challenge/index.html'),
  read('public/games/dyrakarmy-arena/index.html'),
  read('public/games/archive-raid/index.html'),
  read('public/games/latency-strike/index.html'),
  read('public/platform/product-redesign-v20.css'),
  read('public/platform/product-redesign-v20.js'),
  read('public/telegram/telegram-product-v20.js'),
  read('public/manifest.webmanifest'),
  read('public/sw.js'),
]);

const visibleWeb = stripComments(webHtml);
const visibleTelegram = stripComments(telegramHtml);
const manifest = JSON.parse(manifestText);

for (const [label, html] of [
  ['web', webHtml],
  ['telegram', telegramHtml],
  ['control', controlHtml],
  ['challenge games', challengeHtml],
  ['arena', arenaHtml],
  ['archive raid', raidHtml],
  ['latency strike', latencyHtml],
]) {
  assert.match(html, /data-product-generation=["']20["']/, `${label} is missing Product System v20 generation`);
  assert.match(html, /product-redesign-v20\.css/, `${label} is missing the shared Product System v20 stylesheet`);
}

assert.match(webHtml, /product-redesign-v20\.js/);
assert.match(webHtml, /ТВОЯТА МУЗИКА\./);
assert.match(webHtml, /ТВОЯТА АРМИЯ\./);
assert.match(webHtml, /Telegram Companion/);
assert.match(webHtml, /DyrakArmy Studio/);
assert.match(webHtml, /Games 1–10/);
assert.match(webHtml, /Unified Profile/);
assert.match(webHtml, /DyrakArmy Apps/);

for (const forbidden of [
  /<section[^>]+id=["']console["']/i,
  /MEDIA DOWNLOAD CENTER/i,
  /MEDIA DOWNLOAD CONSOLE/i,
  /id=["']downloadForm["']/i,
  /id=["']softwarePreferredDownload["']/i,
  /href=["']#console["']/i,
  /API HEALTH/i,
  /Downloader origin/i,
  /edge round trip/i,
  /REST API|\bD1\b|\bKV\b|\bSSE\b|FFmpeg|webhook/i,
]) assert.doesNotMatch(visibleWeb, forbidden, `public web surface contains forbidden implementation/download copy: ${forbidden}`);

assert.match(telegramHtml, /telegram-product-v20\.js/);
for (const marker of ['data-tab="explore"', 'data-tab="games"', 'data-tab="profile"', 'id="searchForm"']) {
  assert.match(telegramHtml, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
for (const forbidden of [
  /data-tab=["']download["']/i,
  /data-panel=["']download["']/i,
  /id=["']downloadPanel["']/i,
  /id=["']queuePanel["']/i,
  /id=["']historyPanel["']/i,
  /id=["']archivePanel["']/i,
  /Избери качество|Получи файла|Свали URL|Сваляне|обща опашка|file_id|copyMessage|D1 metadata/i,
]) assert.doesNotMatch(visibleTelegram, forbidden, `Telegram product surface contains a retired workflow: ${forbidden}`);

assert.match(controlHtml, /YOUR DYRAKARMY SPACE/);
assert.match(controlHtml, />Изживявания</);
assert.match(controlHtml, />Достъп</);
assert.doesNotMatch(stripComments(controlHtml), /D1 MODULE REGISTRY|CYBER GOVERNANCE|\bRBAC\b/);

const gameSurfaces = [challengeHtml, arenaHtml, raidHtml, latencyHtml];
for (const html of gameSurfaces) {
  assert.match(html, /data-da-surface=["']game["']/);
  assert.doesNotMatch(stripComments(html), /Download Killer/i);
}

for (const breakpoint of ['1120px', '760px', '480px']) {
  assert.match(productCss, new RegExp(`max-width:\\s*${breakpoint}`));
}
assert.match(productCss, /prefers-reduced-motion/);
assert.match(productCss, /--da20-cyan:/);
assert.match(productCss, /--da20-violet:/);
assert.match(productCss, /body\[data-da-surface="telegram"\]/);
assert.match(productCss, /body\[data-da-surface="control"\]/);
assert.match(productCss, /body\[data-da-surface="game"\]/);

for (const script of [productJs, telegramJs]) {
  assert.doesNotMatch(script, /eval\s*\(|new Function\s*\(/);
}
assert.match(productJs, /beforeinstallprompt/);
assert.match(productJs, /serviceWorker\.register\('\/sw\.js'\)/);
assert.match(telegramJs, /Telegram\?\.WebApp/);
assert.match(telegramJs, /\/api\/search/);
assert.doesNotMatch(telegramJs, /\/miniapp\/download|queueDownload|downloadForm/);

assert.equal(manifest.theme_color, '#03040b');
assert.doesNotMatch(manifest.description, /download|backend|queue|archive/i);
assert.ok(manifest.shortcuts.some((shortcut) => shortcut.url === '/control-v2/'));
assert.ok(manifest.shortcuts.some((shortcut) => shortcut.url === '/#games'));
assert.ok(manifest.shortcuts.some((shortcut) => shortcut.url === '/telegram/'));
assert.ok(manifest.shortcuts.every((shortcut) => !/download|backend|telemetry/i.test(`${shortcut.name} ${shortcut.short_name} ${shortcut.description}`)));

for (const asset of [
  '/platform/product-redesign-v20.css?v=20.0.0',
  '/platform/product-redesign-v20.js?v=20.0.0',
  '/telegram/telegram-product-v20.js?v=20.0.0',
]) assert.match(serviceWorker, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(serviceWorker, /dyrakarmy-product-system-v20/);

console.log(JSON.stringify({
  ok: true,
  generation: 20,
  public_download_surfaces: 0,
  public_backend_explainers: 0,
  redesigned_surfaces: ['Web/PWA', 'Telegram Mini App', 'Control Center', 'Games 1-10'],
  languages: ['bg', 'en', 'ru', 'de'],
  responsive_breakpoints: [1120, 760, 480],
}, null, 2));
