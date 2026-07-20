#!/usr/bin/env node

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(process.cwd(), '..');
const reportPath = path.join(process.cwd(), 'single-bot-report.txt');
const excludedTestFiles = new Set([
  'worker/scripts/validate-single-telegram-bot.mjs',
  'worker/scripts/full-virtual-simulation.mjs',
]);
const targets = [
  'worker/src',
  'worker/public',
  'worker/scripts',
  'worker/package.json',
  'worker/wrangler.jsonc',
  'mobile_expo',
  'desktop_launcher',
  'extension',
];
const allowedExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.jsonc', '.html', '.md', '.py']);
const ignoredNames = new Set(['node_modules', '.git', 'downloads', 'dist', 'build', '.expo', '__pycache__']);
const forbidden = [
  ['retired bot username', 'download_killer' + 'BOT'],
  ['secondary Telegram environment', 'TELEGRAM_' + 'SECONDARY_'],
  ['secondary Telegram API namespace', 'v10-' + 'secondary'],
  ['secondary Telegram webhook', '/telegram/webhook/' + 'dyrakarmy'],
  ['Telegram browser fallback', 'web.telegram' + '.org'],
];

async function collect(entry, files) {
  let info;
  try { info = await stat(entry); } catch { return; }
  if (info.isFile()) {
    if (allowedExtensions.has(path.extname(entry).toLowerCase())) files.push(entry);
    return;
  }
  if (!info.isDirectory() || ignoredNames.has(path.basename(entry))) return;
  for (const name of await readdir(entry)) {
    if (ignoredNames.has(name)) continue;
    await collect(path.join(entry, name), files);
  }
}

const files = [];
for (const target of targets) await collect(path.join(repoRoot, target), files);

const violations = [];
for (const file of files) {
  const relative = path.relative(repoRoot, file).replaceAll('\\', '/');
  if (excludedTestFiles.has(relative)) continue;
  const source = await readFile(file, 'utf8');
  for (const [label, marker] of forbidden) {
    if (source.includes(marker)) violations.push(`${relative}: ${label} (${marker})`);
  }
}

const required = [
  ['worker/wrangler.jsonc', '"TELEGRAM_BOT_USERNAME": "dyrakarmy_bot"'],
  ['worker/public/index.html', 'tg://resolve?domain=dyrakarmy_bot'],
  ['worker/public/platform/platform.js', 'const BOT_USERNAME = "dyrakarmy_bot"'],
  ['worker/public/platform/platform.js', 'window.location.href = nativeUrl'],
  ['worker/src/platform_v2.ts', 'native_only: true'],
  ['worker/scripts/setup-telegram-platform.mjs', "expectedUsername = String(process.env.TELEGRAM_BOT_USERNAME || 'dyrakarmy_bot')"],
];
for (const [relative, marker] of required) {
  const source = await readFile(path.join(repoRoot, relative), 'utf8');
  if (!source.includes(marker)) violations.push(`${relative}: missing required marker (${marker})`);
}

const report = violations.length
  ? `Single Telegram bot validation failed:\n${violations.map((item) => `- ${item}`).join('\n')}\n`
  : `Single Telegram bot validation passed across ${files.length} runtime source files.\nCanonical bot: @dyrakarmy_bot\nLaunch mode: tg:// native client only; no browser fallback.\n`;
await writeFile(reportPath, report, 'utf8');

if (violations.length) {
  console.error(report);
  process.exit(1);
}
console.log(report);
