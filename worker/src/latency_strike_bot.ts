import type { Env } from './types';
import { getLatencyStrikeBotSummary } from './latency_strike';

type ExtendedEnv = Env & {
  TELEGRAM_BOT_API_BASE?: string;
};

interface TelegramUser {
  id: number;
  first_name?: string;
  language_code?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TelegramUser;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

const COMMAND_MARKER = 'tg:latency-strike:commands:v1';

export async function handleLatencyStrikeTelegramWebhook(
  request: Request,
  env: ExtendedEnv,
): Promise<Response | null> {
  const providedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!constantTimeEqual(providedSecret, String(env.TELEGRAM_SECRET_TOKEN || ''))) {
    return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });
  }

  const update = await request.json().catch(() => null) as TelegramUpdate | null;
  if (!update) return null;

  if (update.callback_query?.data === 'latency:rewards') {
    const query = update.callback_query;
    await telegramRequest('answerCallbackQuery', { callback_query_id: query.id }, env);
    const chatId = query.message?.chat.id || query.from.id;
    const language = languageFor(query.from);
    const summary = await getLatencyStrikeBotSummary(query.from.id, env, language);
    await sendMessage(chatId, summary, env, rewardKeyboard(language, env));
    return Response.json({ ok: true });
  }

  const message = update.message;
  if (!message || message.chat.type !== 'private') return null;
  const text = String(message.text || '').trim();
  if (!text) return null;
  const command = text.split(/\s+/)[0]?.split('@')[0]?.toLowerCase() || '';
  const label = text.toLowerCase();
  const language = languageFor(message.from);

  const isGame = command === '/game' || command === '/games' || label === '🎮 latency strike' || label === '🎮 games';
  const isRewards = command === '/rewards' || command === '/rank' || label === '🏆 награди' || label === '🏆 rewards';
  if (!isGame && !isRewards) return null;

  await ensureLatencyStrikeBotCommands(env);
  if (isRewards) {
    const summary = await getLatencyStrikeBotSummary(message.from?.id || message.chat.id, env, language);
    await sendMessage(message.chat.id, summary, env, rewardKeyboard(language, env));
    return Response.json({ ok: true });
  }

  const gameUrl = latencyStrikeUrl(env);
  const copy = language === 'bg'
    ? [
        '🎮 Latency Strike v1',
        '',
        'Изчакай фазата READY и натисни възможно най-бързо.',
        'Пет рунда определят резултата, XP, ранга и седмичното ти място.',
        '',
        'Награди: профилни рамки, иконки, animated badges, waveforms, теми и титлата Queue Master.',
      ].join('\n')
    : [
        '🎮 Latency Strike v1',
        '',
        'Wait for READY and tap as fast as possible.',
        'Five rounds determine your score, XP, rank and weekly position.',
        '',
        'Rewards: profile frames, icons, animated badges, waveforms, themes and the Queue Master title.',
      ].join('\n');

  await sendMessage(message.chat.id, copy, env, {
    reply_markup: {
      inline_keyboard: [
        [{ text: language === 'bg' ? '⚡ Играй Latency Strike' : '⚡ Play Latency Strike', web_app: { url: gameUrl } }],
        [{ text: language === 'bg' ? '🏆 Моят ранг и награди' : '🏆 My rank and rewards', callback_data: 'latency:rewards' }],
      ],
    },
  });
  return Response.json({ ok: true });
}

export async function ensureLatencyStrikeBotCommands(env: ExtendedEnv): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  if (await env.CACHE.get(COMMAND_MARKER) === '1') return;

  const bgCommands = [
    { command: 'start', description: 'Старт и главно меню' },
    { command: 'menu', description: 'Главно меню' },
    { command: 'game', description: 'Играй Latency Strike' },
    { command: 'rewards', description: 'Ранг и игрови награди' },
    { command: 'search', description: 'Търсене по име' },
    { command: 'download', description: 'Свали от публичен URL' },
    { command: 'myfiles', description: 'Моите готови песни' },
    { command: 'share', description: 'Сподели готова песен' },
    { command: 'queue', description: 'Активна опашка' },
    { command: 'history', description: 'Последни задачи' },
    { command: 'formats', description: 'Формати и качество' },
    { command: 'settings', description: 'Настройки' },
    { command: 'language', description: 'Смяна на езика' },
    { command: 'site', description: 'Отвори Mini App' },
    { command: 'help', description: 'Помощ' },
  ];
  const enCommands = [
    { command: 'start', description: 'Start and main menu' },
    { command: 'menu', description: 'Main menu' },
    { command: 'game', description: 'Play Latency Strike' },
    { command: 'rewards', description: 'Game rank and rewards' },
    { command: 'search', description: 'Search by name' },
    { command: 'download', description: 'Download from a public URL' },
    { command: 'myfiles', description: 'My completed songs' },
    { command: 'share', description: 'Share a completed song' },
    { command: 'queue', description: 'Active queue' },
    { command: 'history', description: 'Recent jobs' },
    { command: 'formats', description: 'Formats and quality' },
    { command: 'settings', description: 'Settings' },
    { command: 'language', description: 'Change language' },
    { command: 'site', description: 'Open Mini App' },
    { command: 'help', description: 'Help' },
  ];

  const results = await Promise.all([
    telegramRequest('setMyCommands', { commands: bgCommands }, env),
    telegramRequest('setMyCommands', { commands: bgCommands, language_code: 'bg' }, env),
    telegramRequest('setMyCommands', { commands: enCommands, language_code: 'en' }, env),
  ]);
  if (results.every((result) => result.ok)) {
    await env.CACHE.put(COMMAND_MARKER, '1', { expirationTtl: 86400 });
  }
}

function rewardKeyboard(language: 'bg' | 'en', env: ExtendedEnv): Record<string, unknown> {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: language === 'bg' ? '⚡ Играй Latency Strike' : '⚡ Play Latency Strike', web_app: { url: latencyStrikeUrl(env) } },
      ]],
    },
  };
}

function languageFor(user?: TelegramUser): 'bg' | 'en' {
  return user?.language_code?.toLowerCase().startsWith('en') ? 'en' : 'bg';
}

function latencyStrikeUrl(env: ExtendedEnv): string {
  const base = String(env.PUBLIC_BASE_URL || 'https://dyrakarmy.eu').replace(/\/+$/, '');
  return `${base}/games/latency-strike/?v=1.0.0`;
}

async function sendMessage(
  chatId: number,
  text: string,
  env: ExtendedEnv,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const result = await telegramRequest('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra,
  }, env);
  if (!result.ok) throw new Error(result.description || 'Telegram sendMessage failed');
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
  return response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }));
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}
