#!/usr/bin/env node

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const SECRET_KEYS = [
  'DOWNLOADER_API_KEY',
  'DOWNLOAD_TOKEN_SECRET',
  'TELEGRAM_SECRET_TOKEN',
  'OPS_READ_TOKEN',
  'OPS_OPERATOR_TOKEN',
  'OPS_ADMIN_TOKEN',
  'RELEASE_SIGNING_PRIVATE_KEY_PKCS8_BASE64',
];

function randomToken(size = 32) {
  return randomBytes(size).toString('base64url');
}

function generateReleaseSigningPrivateKeyBase64() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

function parseArgs() {
  const flags = new Set(process.argv.slice(2));
  return {
    apply: flags.has('--apply'),
    generateMissing: flags.has('--generate-missing'),
  };
}

function collectSecrets({ generateMissing }) {
  const out = {};
  for (const key of SECRET_KEYS) {
    const existing = String(process.env[key] ?? '').trim();
    if (existing) {
      out[key] = existing;
      continue;
    }
    if (generateMissing) {
      if (key === 'RELEASE_SIGNING_PRIVATE_KEY_PKCS8_BASE64') {
        out[key] = generateReleaseSigningPrivateKeyBase64();
      } else {
        out[key] = randomToken(36);
      }
    }
  }
  return out;
}

function main() {
  const args = parseArgs();
  const secrets = collectSecrets(args);
  const missing = SECRET_KEYS.filter((key) => !secrets[key]);

  if (missing.length > 0) {
    console.error(`Missing required secrets: ${missing.join(', ')}`);
    console.error('Provide them as environment variables or re-run with --generate-missing.');
    process.exit(1);
  }

  if (!args.apply) {
    console.log('Secret payload prepared. Dry-run mode.');
    console.log(JSON.stringify(Object.keys(secrets), null, 2));
    console.log('Run with --apply to push via `wrangler secret bulk`.');
    return;
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'sd-secrets-'));
  const file = join(tempDir, 'secrets.json');
  writeFileSync(file, JSON.stringify(secrets, null, 2), 'utf-8');

  const localWranglerBin = join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const useLocalWrangler = existsSync(localWranglerBin);
  const command = useLocalWrangler ? process.execPath : 'npx';
  const argsList = useLocalWrangler
    ? [localWranglerBin, 'secret', 'bulk', file, '--config', 'wrangler.jsonc']
    : ['wrangler', 'secret', 'bulk', file, '--config', 'wrangler.jsonc'];

  const cmd = spawnSync(command, argsList, {
    stdio: 'inherit',
    shell: false,
    cwd: process.cwd(),
    env: process.env,
  });

  if (cmd.error) {
    console.error(`Failed to execute ${command}: ${cmd.error.message}`);
    rmSync(tempDir, { recursive: true, force: true });
    process.exit(1);
  }

  rmSync(tempDir, { recursive: true, force: true });
  if (cmd.status !== 0) {
    process.exit(cmd.status ?? 1);
  }
  console.log('Secrets rotated successfully.');
}

main();
