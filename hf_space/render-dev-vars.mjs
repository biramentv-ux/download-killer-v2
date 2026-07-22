import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';

const destination = path.resolve('/app/worker/.dev.vars');
const keys = [
  'PUBLIC_BASE_URL',
  'CORS_ORIGINS',
  'DOWNLOADER_API_URL',
  'DOWNLOADER_ORIGINS_JSON',
  'DOWNLOADER_BACKUP_API_URL',
  'DOWNLOADER_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_SECRET_TOKEN',
  'TELEGRAM_ADMIN_IDS',
  'TELEGRAM_DOWNLOAD_CHANNEL_ID',
  'DOWNLOAD_TOKEN_SECRET',
  'WEBHOOK_HMAC_SECRET',
  'OPS_READ_TOKEN',
  'OPS_OPERATOR_TOKEN',
  'OPS_ADMIN_TOKEN',
  'RELEASE_SIGNING_PRIVATE_KEY_PKCS8_BASE64',
  'RELEASE_SIGNING_KEY_ID',
  'INVIDIOUS_BASE_URL',
];

const lines = [
  '# Generated at container start from Hugging Face Space Variables and Secrets.',
  '# This file is never committed or uploaded.',
];

for (const key of keys) {
  const value = process.env[key];
  if (typeof value !== 'string' || value.length === 0) continue;
  lines.push(`${key}=${JSON.stringify(value)}`);
}

await writeFile(destination, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
await chmod(destination, 0o600);
console.log(`Prepared ${Math.max(0, lines.length - 2)} runtime bindings for the Hugging Face Space.`);
