#!/usr/bin/env node

const token = String(process.env.TELEGRAM_SECONDARY_BOT_TOKEN || '').trim();
const secret = String(process.env.TELEGRAM_SECONDARY_SECRET_TOKEN || '').trim();
const publicBase = String(process.env.PUBLIC_BASE_URL || 'https://dyrakarmy.eu').replace(/\/+$/, '');
const expectedUsername = String(process.env.TELEGRAM_SECONDARY_BOT_USERNAME || 'dyrakarmy_bot').replace(/^@+/, '');
const dropPending = String(process.env.TELEGRAM_DROP_PENDING_UPDATES || '0') === '1';

if (!token) {
  console.error('TELEGRAM_SECONDARY_BOT_TOKEN is required. Set it locally; do not commit it.');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error('TELEGRAM_SECONDARY_SECRET_TOKEN is required and may contain only A-Z, a-z, 0-9, _ and -.');
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
  { command: 'menu', description: 'Главно меню' },
  { command: 'search', description: 'Търсене по име' },
  { command: 'download', description: 'Свали от публичен URL' },
  { command: 'myfiles', description: 'Моите готови песни' },
  { command: 'share', description: 'Сподели готова песен' },
  { command: 'queue', description: 'Активна опашка' },
  { command: 'history', description: 'Последни задачи' },
  { command: 'formats', description: 'Формати и качество' },
  { command: 'archive', description: 'Търсене в архива' },
  { command: 'site', description: 'Отвори web платформата' },
  { command: 'language', description: 'Смяна на езика' },
  { command: 'storage', description: 'Статистика за архива' },
  { command: 'cancel', description: 'Откажи чакаща задача' },
  { command: 'settings', description: 'Настройки' },
  { command: 'help', description: 'Помощ' },
];

try {
  const me = await call('getMe');
  const actualUsername = String(me.username || '');
  console.log(`Connected secondary bot: @${actualUsername} (${me.id})`);
  if (actualUsername.toLowerCase() !== expectedUsername.toLowerCase()) {
    throw new Error(`Token belongs to @${actualUsername}, expected @${expectedUsername}.`);
  }
  if (!me.supports_inline_queries) {
    console.warn('Inline sharing is disabled. In @BotFather run /setinline for this bot and set a placeholder such as "Сподели песен".');
  }

  await call('setMyCommands', { commands, language_code: 'bg' });
  await call('setMyCommands', { commands });
  await call('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: 'Download Killer Web',
      web_app: { url: `${publicBase}/` },
    },
  });
  await call('setMyDescription', {
    description: 'Алтернативен вход към Download Killer: българско меню, обща опашка, формати, архив и споделяне.',
    language_code: 'bg',
  });
  await call('setMyShortDescription', {
    short_description: 'Алтернативен BG бот с архив и споделяне.',
    language_code: 'bg',
  });

  const webhookUrl = `${publicBase}/telegram/webhook/dyrakarmy`;
  await call('setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query', 'inline_query', 'channel_post', 'my_chat_member'],
    drop_pending_updates: dropPending,
    max_connections: 40,
  });

  const webhook = await call('getWebhookInfo');
  console.log(`Webhook: ${webhook.url || '(not set)'}`);
  console.log(`Pending updates: ${webhook.pending_update_count || 0}`);
  console.log(`Inline sharing: ${me.supports_inline_queries ? 'enabled' : 'requires /setinline in @BotFather'}`);
  if (webhook.last_error_message) console.warn(`Last webhook error: ${webhook.last_error_message}`);
  console.log(`Public platform: ${publicBase}/`);
  console.log('The secondary bot now shares the same Worker, D1 queue, history and Telegram archive.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
