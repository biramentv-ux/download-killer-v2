#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(process.cwd(), '..');
const targets = [
  '.github/workflows',
  'worker/src',
  'worker/public',
  'worker/scripts',
  'worker/package.json',
  'worker/wrangler.jsonc',
  'mobile_expo',
  'desktop_launcher',
  'extension',
];
const allowedExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.jsonc', '.html', '.yml', '.yaml', '.md', '.py']);
const ignoredNames = new Set(['node_modules', '.git', 'downloads', 'dist', 'build', '.expo', '__pycache__']);
const forbidden = [
  ['retired bot username', 'download_killerBOT'],
  ['secondary Telegram environment', 'TELEGRAM_SECONDARY_'],
  ['secondary Telegram API namespace', 'v10-secondary'],
  ['secondary Telegram webhook', '/telegram/webhook/dyrakarmy'],
  ['Telegram browser fallback', 'web.telegram.org'],
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
  const text = await readFile(file, 'utf8');
  const relative = path.relative(repoRoot, file).replaceAll('\\', '/');
  for (const [label, marker] of forbidden) {
    if (text.includes(marker)) violations.push(`${relative}: ${label} (${marker})`);
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
  const text = await readFile(path.join(repoRoot, relative), 'utf8');
  if (!text.includes(marker)) violations.push(`${relative}: missing required marker (${marker})`);
}

if (violations.length) {
  console.error('Single Telegram bot validation failed:\n' + violations.map((item) => `- ${item}`).join('\n'));
  process.exit(1);
}

console.log(`Single Telegram bot validation passed across ${files.length} source files.`);
console.log('Canonical bot: @dyrakarmy_bot');
console.log('Launch mode: tg:// native client only; no Telegram Web fallback.');
