import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Hugging Face Telegram downloader deployment contract', () => {
  it('bundles Python, yt-dlp and FFmpeg without publishing the private port', () => {
    const dockerfile = read('hf_space/Dockerfile');
    expect(dockerfile).toContain('ffmpeg');
    expect(dockerfile).toContain('python3-venv');
    expect(dockerfile).toContain('COPY downloader ./downloader');
    expect(dockerfile).toContain('HF_LOCAL_DOWNLOADER_PORT=8081');
    expect(dockerfile).not.toMatch(/EXPOSE\s+8081/);
  });

  it('generates one shared key and forces the Worker origin to localhost', () => {
    const start = read('hf_space/start.sh');
    expect(start).toContain('randomBytes(32)');
    expect(start).toContain('http://127.0.0.1:${LOCAL_DOWNLOADER_PORT}');
    expect(start).toContain('hf-local-private');
    expect(start).toContain('DOWNLOADER_BACKUP_API_URL=""');
    expect(start).toContain('DOWNLOADER_TERTIARY_API_URL=""');
  });

  it('supervises downloader and Worker as one failure domain', () => {
    const supervisor = read('hf_space/standalone-supervisor.mjs');
    expect(supervisor).toContain("'--host', '127.0.0.1'");
    expect(supervisor).toContain('waitForEndpoint(`${downloaderBase}/health`');
    expect(supervisor).toContain("wireFatalExit(downloaderChild, 'Local downloader')");
    expect(supervisor).toContain('downloaderChild?.kill(signal)');
  });

  it('blocks deployment on missing or rejected downloader authentication', () => {
    const runtime = read('hf_space/platform_hf.ts');
    const tests = read('hf_space/platform_hf.test.ts');
    const publish = read('.github/workflows/hf-publish-ledger.yml');
    expect(runtime).toContain('/internal/files/__hf_auth_probe__');
    expect(runtime).toContain("'X-API-Key': apiKey");
    expect(runtime).toContain('auth_status: authResponse.status');
    expect(runtime).toContain('status: ok ? 200 : 503');
    expect(tests).toContain('returns 503 when the downloader rejects the generated key');
    expect(publish).toContain('runtime.downloader?.auth_status!==404');
  });

  it('contains no Render downloader origin in the Hugging Face runtime overlay', () => {
    const config = read('hf_space/wrangler.hf.jsonc');
    expect(config).toContain('hf-free-public-v22-local-downloader');
    expect(config).toContain('http://127.0.0.1:8081');
    expect(config).not.toContain('dyrakarmy-downloader-primary.onrender.com');
  });
});
