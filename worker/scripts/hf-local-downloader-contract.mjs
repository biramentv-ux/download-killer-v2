#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(file, 'utf8');
const [dockerfile, start, supervisor, vars, worker, tests, config, publish, spotifyResolver] = await Promise.all([
  read('../hf_space/Dockerfile'),
  read('../hf_space/start.sh'),
  read('../hf_space/standalone-supervisor.mjs'),
  read('../hf_space/render-dev-vars.mjs'),
  read('../hf_space/platform_hf.ts'),
  read('../hf_space/platform_hf.test.ts'),
  read('../hf_space/wrangler.hf.jsonc'),
  read('../.github/workflows/hf-publish-ledger.yml'),
  read('src/spotify_resolver.ts'),
]);

assert.match(dockerfile, /ffmpeg/);
assert.match(dockerfile, /python3-venv/);
assert.match(dockerfile, /COPY downloader \.\/downloader/);
assert.match(dockerfile, /HF_LOCAL_DOWNLOADER_PORT=8081/);
assert.doesNotMatch(dockerfile, /EXPOSE\s+8081/);

assert.match(start, /randomBytes\(32\)/);
assert.match(start, /http:\/\/127\.0\.0\.1:\$\{LOCAL_DOWNLOADER_PORT\}/);
assert.match(start, /hf-local-private/);
assert.match(start, /DOWNLOADER_BACKUP_API_URL=""/);
assert.match(start, /DOWNLOADER_TERTIARY_API_URL=""/);

assert.match(supervisor, /--host', '127\.0\.0\.1'/);
assert.match(supervisor, /Local downloader/);
assert.match(supervisor, /waitForEndpoint\(`\$\{downloaderBase\}\/health`/);
assert.match(supervisor, /downloaderChild\?\.kill/);

for (const key of [
  'HF_LOCAL_DOWNLOADER_ENABLED',
  'HF_LOCAL_DOWNLOADER_PORT',
  'DOWNLOADER_API_KEY',
  'DOWNLOADER_STORAGE_DIR',
  'DOWNLOADER_WORK_DIR',
]) assert.match(vars, new RegExp(`'${key}'`));

assert.match(worker, /probeHfLocalDownloader/);
assert.match(worker, /\/internal\/files\/__hf_auth_probe__/);
assert.match(worker, /'X-API-Key': apiKey/);
assert.match(worker, /auth_status: authResponse\.status/);
assert.match(worker, /status: ok \? 200 : 503/);

assert.match(tests, /returns 503 when the downloader rejects the generated key/);
assert.match(config, /hf-free-public-v23-spotify-resolver/);
assert.match(config, /"SPOTIFY_RESOLVER_AUTO_THRESHOLD": "88"/);
assert.match(config, /"SPOTIFY_RESOLVER_REVIEW_THRESHOLD": "76"/);
assert.match(config, /http:\/\/127\.0\.0\.1:8081/);
assert.doesNotMatch(config, /dyrakarmy-downloader-primary\.onrender\.com/);
assert.match(spotifyResolver, /handleSpotifyTelegramResolverWebhook/);
assert.match(spotifyResolver, /authorized_external_sources_only/);
assert.match(publish, /runtime\.downloader\?\.auth_status!==404/);
assert.match(publish, /Telegram downloader is private, local and authenticated/);

console.log('Hugging Face private local downloader and Spotify resolver contract: PASS');
