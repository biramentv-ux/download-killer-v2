import { spawn } from 'node:child_process';
import process from 'node:process';

const port = Number(process.env.PORT || 7860);
const mode = String(process.env.HF_BACKEND_MODE || 'cloudflare-mirror').toLowerCase();
const persistRoot = process.env.DYRAKARMY_PERSIST_ROOT || (mode === 'standalone' ? '/data/dyrakarmy' : '/tmp/dyrakarmy-mirror');
const localBase = `http://127.0.0.1:${port}`;
const timers = new Set();
let child;
let stopping = false;
let lastDailyKey = '';

function schedule(callback, delay) {
  const timer = setInterval(callback, delay);
  timers.add(timer);
  return timer;
}

async function waitForRuntime() {
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    try {
      const response = await fetch(`${localBase}/api/hf-mirror/health`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Hugging Face runtime did not become healthy within 120 seconds.');
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

function startRuntime() {
  const args = [
    'wrangler', 'dev',
    '--ip', '0.0.0.0',
    '--port', String(port),
    '--persist-to', persistRoot,
    '--config', 'wrangler.hf.jsonc',
    '--test-scheduled',
  ];
  child = spawn('npx', args, { cwd: '/app/worker', stdio: 'inherit', env: process.env });
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`Wrangler runtime exited unexpectedly: code=${code} signal=${signal || 'none'}`);
      process.exit(code || 1);
    }
  });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearInterval(timer);
  child?.kill(signal);
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

startRuntime();
await waitForRuntime();
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
