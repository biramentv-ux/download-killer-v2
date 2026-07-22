import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const mode = String(process.env.HF_BACKEND_MODE || 'cloudflare-mirror').toLowerCase();
if (mode !== 'standalone') {
  console.log('Standalone preflight skipped: mirror mode is active.');
  process.exit(0);
}

const persistRoot = process.env.DYRAKARMY_PERSIST_ROOT || '/data/dyrakarmy';
const requireImport = String(process.env.HF_STATE_IMPORT_REQUIRED || '1') !== '0';
const requiredSecrets = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_SECRET_TOKEN',
  'DOWNLOADER_API_KEY',
  'DOWNLOAD_TOKEN_SECRET',
  'WEBHOOK_HMAC_SECRET',
  'OPS_ADMIN_TOKEN',
  'RELEASE_SIGNING_PRIVATE_KEY_PKCS8_BASE64',
];

await mkdir(persistRoot, { recursive: true });
await access(persistRoot, constants.R_OK | constants.W_OK);

const probePath = path.join(persistRoot, '.hf-persistence-probe');
const probeValue = `dyrakarmy:${Date.now()}:${crypto.randomUUID()}`;
await writeFile(probePath, probeValue, { encoding: 'utf8', mode: 0o600 });
if ((await readFile(probePath, 'utf8')) !== probeValue) {
  throw new Error(`Persistent volume probe failed at ${probePath}`);
}

const missing = requiredSecrets.filter((key) => !String(process.env[key] || '').trim());
if (missing.length) {
  throw new Error(`Standalone cutover blocked. Missing Space Secrets: ${missing.join(', ')}`);
}

if (requireImport) {
  const marker = path.join(persistRoot, '.cloudflare-state-imported');
  try {
    await access(marker, constants.R_OK);
  } catch {
    throw new Error(`Standalone cutover blocked. State import marker is missing: ${marker}`);
  }
}

const publicBase = String(process.env.PUBLIC_BASE_URL || '').trim();
if (!/^https:\/\//i.test(publicBase)) {
  throw new Error('Standalone cutover blocked. PUBLIC_BASE_URL must be an HTTPS URL.');
}

console.log(JSON.stringify({
  ok: true,
  mode,
  persist_root: persistRoot,
  state_import_required: requireImport,
  required_secrets_present: requiredSecrets.length,
  public_base_url: publicBase,
}));
