import type { Env } from './types';

type ExtendedEnv = Env & { TELEGRAM_BOT_API_BASE?: string };

const COMMAND_MARKER = 'tg:dyrakarmy:commands:v6';
const LATENCY_MARKER = 'tg:latency-strike:commands:v2';
const V10_MARKER = 'tg:commands:bg:v10';
const LEGACY_MARKER = 'tg:commands:bg:v4';

const BG_COMMANDS = [
  { command: 'start', description: 'Старт и главно меню' },
  { command: 'menu', description: 'Главно меню' },
  { command: 'arena', description: 'Играй DyrakArmy Arena' },
  { command: 'team', description: 'Моят Arena отбор и ранг' },
  { command: 'game', description: 'Играй Latency Strike' },
  { command: 'raid', description: 'Играй Archive Raid' },
  { command: 'collection', description: 'Моята collectible колекция' },
  { command: 'crate', description: 'Отвори дневния Archive crate' },
  { command: 'rewards', description: 'Ранг и игрови награди' },
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

const EN_COMMANDS = [
  { command: 'start', description: 'Start and main menu' },
  { command: 'menu', description: 'Main menu' },
  { command: 'arena', description: 'Play DyrakArmy Arena' },
  { command: 'team', description: 'My Arena team and rank' },
  { command: 'game', description: 'Play Latency Strike' },
  { command: 'raid', description: 'Play Archive Raid' },
  { command: 'collection', description: 'My collectible collection' },
  { command: 'crate', description: 'Open the daily Archive crate' },
  { command: 'rewards', description: 'Game rank and rewards' },
  { command: 'control', description: 'Mobile Control Center' },
  { command: 'id', description: 'Show my Telegram ID' },
  { command: 'search', description: 'Search by name' },
  { command: 'download', description: 'Download from a public URL' },
  { command: 'myfiles', description: 'My completed songs' },
  { command: 'share', description: 'Share a completed song' },
  { command: 'queue', description: 'Active queue' },
  { command: 'history', description: 'Recent jobs' },
  { command: 'formats', description: 'Formats and quality' },
  { command: 'archive', description: 'Search the media archive' },
  { command: 'site', description: 'Open Mini App' },
  { command: 'language', description: 'Change language' },
  { command: 'storage', description: 'Archive statistics' },
  { command: 'cancel', description: 'Cancel a pending job' },
  { command: 'settings', description: 'Settings' },
  { command: 'help', description: 'Help' },
];

export async function ensureDyrakArmyArenaCommands(env: ExtendedEnv): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  if (await env.CACHE.get(COMMAND_MARKER) === '1') return;
  const results = await Promise.all([
    telegramRequest('setMyCommands', { commands: BG_COMMANDS }, env),
    telegramRequest('setMyCommands', { commands: BG_COMMANDS, language_code: 'bg' }, env),
    telegramRequest('setMyCommands', { commands: EN_COMMANDS, language_code: 'en' }, env),
    telegramRequest('setMyDescription', {
      description: 'Download Killer: DyrakArmy Arena, Latency Strike, Archive Raid, общ профил, Control Center, опашка и Telegram архив.',
      language_code: 'bg',
    }, env),
    telegramRequest('setMyShortDescription', {
      short_description: 'Arena, Raid, игри, Control Center и общ профил.',
      language_code: 'bg',
    }, env),
  ]);
  if (!results.every((result) => result.ok)) return;

  const username = String(env.TELEGRAM_BOT_USERNAME || 'dyrakarmy_bot').replace(/^@+/, '').toLowerCase();
  const markers = [
    COMMAND_MARKER,
    LATENCY_MARKER,
    V10_MARKER,
    LEGACY_MARKER,
    `tg:master:commands:v1:${username}`,
  ];
  await Promise.all(markers.map((marker) => env.CACHE.put(marker, '1', { expirationTtl: 86400 })));
}

async function telegramRequest(
  method: string,
  payload: Record<string, unknown>,
  env: ExtendedEnv,
): Promise<{ ok: boolean; description?: string }> {
  const base = String(env.TELEGRAM_BOT_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const response = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const parsed = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
  return { ok: Boolean(response.ok && parsed?.ok), description: parsed?.description };
}
