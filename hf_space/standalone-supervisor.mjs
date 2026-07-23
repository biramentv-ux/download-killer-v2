import { spawn } from 'node:child_process';
import process from 'node:process';

const port = Number(process.env.PORT || 7860);
const mode = String(process.env.HF_BACKEND_MODE || 'free-public').toLowerCase() === 'standalone'
  ? 'standalone'
  : 'free-public';
const persistRoot = process.env.DYRAKARMY_PERSIST_ROOT || (mode === 'standalone' ? '/data/dyrakarmy' : '/tmp/dyrakarmy-free-public');
const localDownloaderEnabled = String(process.env.HF_LOCAL_DOWNLOADER_ENABLED || '1') !== '0';
const localDownloaderPort = Number(process.env.HF_LOCAL_DOWNLOADER_PORT || 8081);
const localBase = `http://127.0.0.1:${port}`;
const downloaderBase = `http://127.0.0.1:${localDownloaderPort}`;
const timers = new Set();
let workerChild;
let downloaderChild;
let stopping = false;
let lastDailyKey = '';

function schedule(callback, delay) {
  const timer = setInterval(callback, delay);
  timers.add(timer);
  return timer;
}

async function waitForEndpoint(url, label, attempts = 120) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} did not become healthy within ${attempts} seconds.`);
}

function wireFatalExit(child, label) {
  child.once('exit', (code, signal) => {
    if (stopping) return;
    console.error(`${label} exited unexpectedly: code=${code} signal=${signal || 'none'}`);
    stop('SIGTERM', code || 1);
  });
}

function startDownloader() {
  if (!localDownloaderEnabled) return;
  const python = '/opt/dyrakarmy-downloader/bin/python';
  const args = [
    '-m', 'uvicorn', 'app.main:app',
    '--host', '127.0.0.1',
    '--port', String(localDownloaderPort),
    '--workers', '1',
    '--no-access-log',
  ];
  downloaderChild = spawn(python, args, {
    cwd: '/app/downloader',
    stdio: 'inherit',
    env: process.env,
  });
  wireFatalExit(downloaderChild, 'Local downloader');
}

function startRuntime() {
  const args = [
    'wrangler', 'dev',
    '--ip', '0.0.0.0',
    '--port', String(port),
    '--persist-to', persistRoot,
    '--config', 'wrangler.hf.jsonc',
    '--test-scheduled',
  ];
  workerChild = spawn('npx', args, { cwd: '/app/worker', stdio: 'inherit', env: process.env });
  wireFatalExit(workerChild, 'Wrangler runtime');
}

async function triggerScheduled(cron) {
  if (mode !== 'standalone' || stopping) return;
  try {
    const response = await fetch(`${localBase}/__scheduled?cron=${encodeURIComponent(cron)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log(`Scheduled handler completed for ${cron}`);
  } catch (error) {
    console.error(`Scheduled handler failed for ${cron}`, error);
  }
}

async function configureTelegramWebhook() {
  if (mode !== 'standalone' || String(process.env.HF_TELEGRAM_WEBHOOK_AUTOCONFIGURE || '0') !== '1') return;
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '');
  const secretToken = String(process.env.TELEGRAM_SECRET_TOKEN || '');
  const publicBase = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!token || !secretToken || !publicBase) throw new Error('Telegram webhook configuration is incomplete.');

  const webhookUrl = `${publicBase}/telegram/webhook`;
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query', 'inline_query', 'my_chat_member'],
      drop_pending_updates: false,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    throw new Error(`Telegram setWebhook failed: ${payload.description || `HTTP ${response.status}`}`);
  }
  console.log(`Telegram webhook authority moved to ${new URL(webhookUrl).origin}`);
}

function stop(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearInterval(timer);
  workerChild?.kill(signal);
  downloaderChild?.kill(signal);
  setTimeout(() => process.exit(exitCode), 5000).unref();
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

startDownloader();
if (localDownloaderEnabled) {
  await waitForEndpoint(`${downloaderBase}/health`, 'Local downloader');
  console.log(`Private local downloader ready at ${downloaderBase}.`);
}

startRuntime();
await waitForEndpoint(`${localBase}/api/hf-runtime/health`, 'Hugging Face runtime');
console.log(`DyrakArmy HF runtime ready in ${mode} mode.`);

if (mode === 'standalone') {
  await configureTelegramWebhook();
  await triggerScheduled('*/5 * * * *');
  schedule(() => triggerScheduled('*/5 * * * *'), 5 * 60 * 1000);
  schedule(() => {
    const now = new Date();
    const dailyKey = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === 3 && now.getUTCMinutes() >= 17 && lastDailyKey !== dailyKey) {
      lastDailyKey = dailyKey;
      void triggerScheduled('17 3 * * *');
    }
  }, 30 * 1000);
}
