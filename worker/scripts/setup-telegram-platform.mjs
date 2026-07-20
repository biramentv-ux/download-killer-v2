#!/usr/bin/env node

const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const secret = String(process.env.TELEGRAM_SECRET_TOKEN || '').trim();
const publicBase = String(process.env.PUBLIC_BASE_URL || 'https://dyrakarmy.eu').replace(/\/+$/, '');
const expectedUsername = String(process.env.TELEGRAM_BOT_USERNAME || 'dyrakarmy_bot').replace(/^@+/, '');
const dropPending = String(process.env.TELEGRAM_DROP_PENDING_UPDATES || '0') === '1';
const miniAppVersion = String(process.env.TELEGRAM_MINIAPP_VERSION || '12.2.0').trim();
const miniAppUrl = `${publicBase}/telegram/?v=${encodeURIComponent(miniAppVersion)}`;
const latencyStrikeUrl = `${publicBase}/games/latency-strike/?v=1.0.0`;
const arenaUrl = `${publicBase}/games/dyrakarmy-arena/?v=1.0.0`;

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
  { command: 'menu', description: 'Главно меню' },
  { command: 'arena', description: 'Играй DyrakArmy Arena' },
  { command: 'team', description: 'Моят Arena отбор и ранг' },
  { command: 'game', description: 'Играй Latency Strike' },
  { command: 'rewards', description: 'Ранг и игрови награди' },
  { command: 'search', description: 'Търсене по име' },
  { command: 'download', description: 'Свали от публичен URL' },
  { command: 'myfiles', description: 'Моите готови песни' },
  { command: 'share', description: 'Сподели готова песен' },
  { command: 'queue', description: 'Активна опашка' },
  { command: 'history', description: 'Последни задачи' },
  { command: 'formats', description: 'Формати и качество' },
  { command: 'archive', description: 'Търсене в архива' },
  { command: 'site', description: 'Отвори Mini App' },
  { command: 'language', description: 'Смяна на езика' },
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
    throw new Error(`Token belongs to @${actualUsername}, expected @${expectedUsername}. Refusing to bind the wrong Mini App session key.`);
  }
  if (!me.supports_inline_queries) {
    console.warn('Inline sharing is disabled. In @BotFather run /setinline for this bot and set a placeholder such as "Сподели песен или Arena".');
  }

  await call('setMyCommands', { commands, language_code: 'bg' });
  await call('setMyCommands', { commands });
  await call('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: 'Download Killer',
      web_app: { url: miniAppUrl },
    },
  });
  await call('setMyDescription', {
    description: 'Download Killer: Mini App v12, DyrakArmy Arena, Latency Strike, обща опашка, Telegram архив и споделяне.',
    language_code: 'bg',
  });
  await call('setMyShortDescription', {
    short_description: 'Mini App, Arena, Latency Strike, архив и споделяне.',
    language_code: 'bg',
  });

  const webhookUrl = `${publicBase}/telegram/webhook`;
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
  console.log(`Native link: tg://resolve?domain=${expectedUsername}`);
  console.log(`Mini App v${miniAppVersion}: ${miniAppUrl}`);
  console.log(`DyrakArmy Arena v1: ${arenaUrl}`);
  console.log(`Latency Strike v1: ${latencyStrikeUrl}`);
  console.log(`Health: ${publicBase}/api/telegram/v12/health`);
  console.log('Optional native Games catalog: in @BotFather create latency_strike. Arena runs as a team Mini App.');
  console.log('Next: close the existing Telegram WebView completely and open the Menu button again.');
  console.log('Add the bot as an administrator to a private storage channel with permission to post messages.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
