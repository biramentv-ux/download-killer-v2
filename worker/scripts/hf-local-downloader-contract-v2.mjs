#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(file, 'utf8');
const [dockerfile, start, supervisor, runtime, config, publish] = await Promise.all([
  read('../hf_space/Dockerfile'),
  read('../hf_space/start.sh'),
  read('../hf_space/standalone-supervisor.mjs'),
  read('../hf_space/platform_hf.ts'),
  read('../hf_space/wrangler.hf.jsonc'),
  read('../.github/workflows/hf-publish-ledger.yml'),
]);

assert.match(dockerfile, /COPY downloader \.\/downloader/);
assert.doesNotMatch(dockerfile, /EXPOSE\s+8081/);
assert.match(start, /randomBytes\(32\)/);
assert.match(start, /http:\/\/127\.0\.0\.1:\$\{LOCAL_DOWNLOADER_PORT\}/);
assert.match(supervisor, /--host', '127\.0\.0\.1'/);
assert.match(runtime, /\/internal\/files\/__hf_auth_probe__/);
assert.match(runtime, /auth_status: authResponse\.status/);
assert.match(config, /hf-free-public-v22-local-downloader/);
assert.doesNotMatch(config, /dyrakarmy-downloader-primary\.onrender\.com/);
assert.match(publish, /runtime\.downloader\?\.auth_status!==404/);
console.log('HF local downloader auth/isolation contract: PASS');
