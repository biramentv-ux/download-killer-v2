#!/usr/bin/env node

const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const secret = String(process.env.TELEGRAM_SECRET_TOKEN || '').trim();
const publicBase = String(process.env.PUBLIC_BASE_URL || 'https://dyrakarmy.eu').replace(/\/+$/, '');
const expectedUsername = String(process.env.TELEGRAM_BOT_USERNAME || 'dyrakarmy_bot').replace(/^@+/, '');
const dropPending = String(process.env.TELEGRAM_DROP_PENDING_UPDATES || '0') === '1';
const miniAppVersion = String(process.env.TELEGRAM_MINIAPP_VERSION || '12.2.0').trim();
const miniAppUrl = `${publicBase}/telegram/?v=${encodeURIComponent(miniAppVersion)}`;
const controlUrl = `${publicBase}/control/?v=1.0.0`;
const gameUrls = {
  queue_commander: `${publicBase}/games/queue-commander/?v=1.0.0`,
  beat_hunter: `${publicBase}/games/beat-hunter/?v=1.0.0`,
  dyrakarmy_arena: `${publicBase}/games/dyrakarmy-arena/?v=1.0.0`,
  format_forge: `${publicBase}/games/format-forge/?v=1.0.0`,
  server_defender: `${publicBase}/games/server-defender/?v=1.0.0`,
  metadata_detective: `${publicBase}/games/metadata-detective/?v=1.0.0`,
  link_runner: `${publicBase}/games/link-runner/?v=1.0.0`,
  archive_raid: `${publicBase}/games/archive-raid/?v=1.0.0`,
  latency_strike: `${publicBase}/games/latency-strike/?v=1.0.0`,
  bot_vs_human: `${publicBase}/games/bot-vs-human/?v=1.0.0`,
};

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
  if (!response.ok || !body.ok) throw new Error(`${method} failed: ${body.description || response.status}`);
  return body.result;
}

const commands = [
  { command: 'start', description: 'Старт и главно меню' },
  { command: 'menu', description: 'Главно меню' },
  { command: 'queuegame', description: '1. Queue Commander' },
  { command: 'beat', description: '2. Beat Hunter' },
  { command: 'arena', description: '3. DyrakArmy Arena' },
  { command: 'team', description: 'Моят Arena отбор и ранг' },
  { command: 'formatgame', description: '4. Format Forge' },
  { command: 'defender', description: '5. Server Defender' },
  { command: 'detective', description: '6. Metadata Detective' },
  { command: 'linkrunner', description: '7. Link Runner' },
  { command: 'raid', description: '8. Archive Raid' },
  { command: 'collection', description: 'Archive Raid колекция' },
  { command: 'crate', description: 'Archive Raid дневен crate' },
  { command: 'game', description: '9. Latency Strike' },
  { command: 'botvhuman', description: '10. Bot vs Human' },
  { command: 'rewards', description: 'Общ ранг и игрови награди' },
  { command: 'control', description: 'Мобилен Control Center' },
  { command: 'id', description: 'Покажи моя Telegram ID' },
  { command: 'search', description: 'Търсене по име' },
  { command: 'download', description: 'Свали от публичен URL' },
  { command: 'myfiles', description: 'Моите готови песни' },
  { command: 'share', description: 'Сподели готова песен' },
  { command: 'queue', description: 'Активна опашка' },
  { command: 'history', description: 'Последни задачи' },
  { command: 'formats', description: 'Формати и качество' },
  { command: 'archive', description: 'Търсене в медийния архив' },
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
    console.warn('Inline sharing is disabled. In @BotFather run /setinline and add a short placeholder.');
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
    description: 'Download Killer: 10 DyrakArmy Games, общ XP профил, Control Center, опашка, архив и споделяне.',
    language_code: 'bg',
  });
  await call('setMyShortDescription', {
    short_description: '10 игри, общ XP, рангове, награди и Control Center.',
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
  console.log(`Native link: tg://resolve?domain=${expectedUsername}`);
  console.log(`Mini App v${miniAppVersion}: ${miniAppUrl}`);
  Object.entries(gameUrls).forEach(([key, url]) => console.log(`${key}: ${url}`));
  console.log(`Control Center v1: ${controlUrl}`);
  console.log(`Health: ${publicBase}/api/telegram/v12/health`);
  console.log('Admin bootstrap: send /id to the bot, then add that numeric ID to TELEGRAM_ADMIN_IDS.');
  console.log('Next: close the existing Telegram WebView completely and open the Menu button again.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
