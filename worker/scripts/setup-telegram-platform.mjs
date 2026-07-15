#!/usr/bin/env node

const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const secret = String(process.env.TELEGRAM_SECRET_TOKEN || '').trim();
const publicBase = String(process.env.PUBLIC_BASE_URL || 'https://dyrakarmy.eu').replace(/\/+$/, '');
const expectedUsername = String(process.env.TELEGRAM_BOT_USERNAME || 'download_killerBOT').replace(/^@+/, '');
const dropPending = String(process.env.TELEGRAM_DROP_PENDING_UPDATES || '0') === '1';

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is required. Set it as an environment variable; do not commit it.');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error('TELEGRAM_SECRET_TOKEN is required and may contain only A-Z, a-z, 0-9, _ and -.');
  process.exit(1);
}

const apiBase = `https://api.telegram.org/bot${token}`;

async function call(method, payload = {}) {
  const response = await fetch(`${apiBase}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(`${method} failed: ${body.description || response.status}`);
  }
  return body.result;
}

const commands = [
  { command: 'start', description: 'Старт и главно меню' },
  { command: 'search', description: 'Търсене по име' },
  { command: 'download', description: 'Свали от публичен URL' },
  { command: 'queue', description: 'Активна опашка' },
  { command: 'history', description: 'Последни задачи' },
  { command: 'myfiles', description: 'Моите файлове в Telegram' },
  { command: 'formats', description: 'Формати и качество' },
  { command: 'archive', description: 'Търсене в архива' },
  { command: 'site', description: 'Отвори Mini App' },
  { command: 'language', description: 'Език BG/EN' },
  { command: 'storage', description: 'Статистика за архива' },
  { command: 'cancel', description: 'Откажи чакаща задача' },
  { command: 'settings', description: 'Настройки' },
  { command: 'help', description: 'Помощ' },
];

try {
  const me = await call('getMe');
  const actualUsername = String(me.username || '');
  console.log(`Connected bot: @${actualUsername} (${me.id})`);
  if (actualUsername.toLowerCase() !== expectedUsername.toLowerCase()) {
    console.warn(`Warning: configured username is @${expectedUsername}, but token belongs to @${actualUsername}.`);
  }

  await call('setMyCommands', { commands, language_code: 'bg' });
  await call('setMyCommands', { commands });
  await call('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: 'Download Killer',
      web_app: { url: `${publicBase}/telegram/` },
    },
  });
  await call('setMyDescription', {
    description: 'Български бот и Mini App за търсене, опашка, история и Telegram файлов архив.',
    language_code: 'bg',
  });
  await call('setMyShortDescription', {
    short_description: 'BG търсене, опашка, история и Telegram файлов архив.',
    language_code: 'bg',
  });

  const webhookUrl = `${publicBase}/telegram/webhook`;
  await call('setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query', 'channel_post', 'my_chat_member'],
    drop_pending_updates: dropPending,
    max_connections: 40,
  });

  const webhook = await call('getWebhookInfo');
  console.log(`Webhook: ${webhook.url || '(not set)'}`);
  console.log(`Pending updates: ${webhook.pending_update_count || 0}`);
  if (webhook.last_error_message) console.warn(`Last webhook error: ${webhook.last_error_message}`);
  console.log(`Mini App: ${publicBase}/telegram/`);
  console.log('Next: add the bot as an administrator to a private storage channel with permission to post messages.');
  console.log('Set TELEGRAM_DOWNLOAD_CHANNEL_ID to the numeric channel id, or publish one channel post after adding the bot so the Worker can capture it.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
