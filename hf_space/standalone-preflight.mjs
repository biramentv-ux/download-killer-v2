import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const mode = String(process.env.HF_BACKEND_MODE || 'free-public').toLowerCase() === 'standalone'
  ? 'standalone'
  : 'free-public';
const persistent = mode === 'standalone';
const persistRoot = process.env.DYRAKARMY_PERSIST_ROOT || (persistent ? '/data/dyrakarmy' : '/tmp/dyrakarmy-free-public');
const publicBase = String(process.env.PUBLIC_BASE_URL || 'https://dyrakarmy-dyrakarmy-platform.hf.space').trim();

await mkdir(persistRoot, { recursive: true });
await access(persistRoot, constants.R_OK | constants.W_OK);

const probePath = path.join(persistRoot, '.hf-runtime-probe');
const probeValue = `dyrakarmy:${Date.now()}:${crypto.randomUUID()}`;
await writeFile(probePath, probeValue, { encoding: 'utf8', mode: 0o600 });
if ((await readFile(probePath, 'utf8')) !== probeValue) {
  throw new Error(`Runtime storage probe failed at ${probePath}`);
}

if (!/^https:\/\//i.test(publicBase)) {
  throw new Error('PUBLIC_BASE_URL must be an HTTPS URL.');
}

if (persistent) {
  const requiredSecrets = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_SECRET_TOKEN',
    'DOWNLOADER_API_KEY',
    'DOWNLOAD_TOKEN_SECRET',
    'WEBHOOK_HMAC_SECRET',
    'OPS_ADMIN_TOKEN',
    'RELEASE_SIGNING_PRIVATE_KEY_PKCS8_BASE64',
  ];
  const missing = requiredSecrets.filter((key) => !String(process.env[key] || '').trim());
  if (missing.length) {
    throw new Error(`Standalone mode is blocked. Missing Space Secrets: ${missing.join(', ')}`);
  }

  const requireImport = String(process.env.HF_STATE_IMPORT_REQUIRED || '1') !== '0';
  if (requireImport) {
    const marker = path.join(persistRoot, '.cloudflare-state-imported');
    try {
      await access(marker, constants.R_OK);
    } catch {
      throw new Error(`Standalone mode is blocked. State import marker is missing: ${marker}`);
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  mode,
  public_base_url: publicBase,
  persist_root: persistRoot,
  state_persistence: persistent ? 'persistent' : 'ephemeral',
  paid_hardware_required: false,
  custom_domain_required: false,
  cloudflare_dependency: false,
  warning: persistent ? null : 'Free Spaces can sleep and local state can reset after restart or rebuild.',
}));
