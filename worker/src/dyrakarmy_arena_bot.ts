import type { Env } from './types';
import { getDyrakArmyArenaBotSummary } from './dyrakarmy_arena';

type ExtendedEnv = Env & {
  TELEGRAM_BOT_API_BASE?: string;
};

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
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

interface TelegramInlineQuery {
  id: string;
  from: TelegramUser;
  query: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  inline_query?: TelegramInlineQuery;
}

interface WebhookRequestLike {
  headers: Headers;
  json(): Promise<unknown>;
}

interface TelegramMethodResult<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

export async function handleDyrakArmyArenaTelegramWebhook(
  request: WebhookRequestLike,
  env: ExtendedEnv,
): Promise<Response | null> {
  const providedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!constantTimeEqual(providedSecret, String(env.TELEGRAM_SECRET_TOKEN || ''))) {
    return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });
  }

  const update = await request.json().catch(() => null) as TelegramUpdate | null;
  if (!update) return null;

  const inlineResponse = await handleInlineQuery(update.inline_query, env);
  if (inlineResponse) return inlineResponse;

  const callbackResponse = await handleCallback(update.callback_query, env);
  if (callbackResponse) return callbackResponse;

  const message = update.message;
  if (!message?.text) return null;
  const text = message.text.trim();
  const command = text.split(/\s+/)[0]?.split('@')[0]?.toLowerCase() || '';
  const label = text.toLowerCase();
  const language = languageFor(message.from);
  const isArena = command === '/arena' || command === '/army' || label === '⚔️ dyrakarmy arena' || label === '⚔️ arena';
  const isTeam = command === '/team' || command === '/squad' || label === '🛡 моят отбор' || label === '🛡 my team';
  if (!isArena && !isTeam) return null;

  if (isTeam) {
    const summary = await getDyrakArmyArenaBotSummary(message.from?.id || message.chat.id, env, language);
    await sendMessage(message.chat.id, summary, env, arenaKeyboard(language, env));
    return Response.json({ ok: true, mode: 'arena_profile' });
  }

  await sendArenaCard(message.chat.id, language, env);
  return Response.json({ ok: true, mode: 'arena_web_app' });
}

async function handleCallback(
  query: TelegramCallbackQuery | undefined,
  env: ExtendedEnv,
): Promise<Response | null> {
  if (!query || query.data !== 'arena:profile') return null;
  await telegramRequest('answerCallbackQuery', { callback_query_id: query.id }, env);
  const language = languageFor(query.from);
  const chatId = query.message?.chat.id || query.from.id;
  const summary = await getDyrakArmyArenaBotSummary(query.from.id, env, language);
  await sendMessage(chatId, summary, env, arenaKeyboard(language, env));
  return Response.json({ ok: true, mode: 'arena_profile' });
}

async function handleInlineQuery(
  inlineQuery: TelegramInlineQuery | undefined,
  env: ExtendedEnv,
): Promise<Response | null> {
  if (!inlineQuery) return null;
  const query = String(inlineQuery.query || '').trim().toLowerCase();
  if (query && !query.includes('arena') && !query.includes('army') && !query.includes('отбор')) return null;
  const language = languageFor(inlineQuery.from);
  const url = arenaUrl(env);
  const title = language === 'bg' ? 'DyrakArmy Arena' : 'DyrakArmy Arena';
  const description = language === 'bg'
    ? 'Дневни предизвикателства, отбори, сезони и класации.'
    : 'Daily challenges, teams, seasons and leaderboards.';
  const response = await telegramRequest('answerInlineQuery', {
    inline_query_id: inlineQuery.id,
    results: [{
      type: 'article',
      id: 'dyrakarmy-arena-v1',
      title,
      description,
      input_message_content: {
        message_text: language === 'bg'
          ? '⚔️ DyrakArmy Arena\n\nСъбери отбор, изпълни дневното предизвикателство и изкачи седмичната лига.'
          : '⚔️ DyrakArmy Arena\n\nBuild a team, complete the daily challenge and climb the weekly league.',
      },
      reply_markup: {
        inline_keyboard: [[{ text: language === 'bg' ? '⚔️ Отвори Arena' : '⚔️ Open Arena', web_app: { url } }]],
      },
    }],
    cache_time: 10,
    is_personal: true,
  }, env);
  return response.ok ? Response.json({ ok: true, mode: 'arena_inline' }) : null;
}

async function sendArenaCard(chatId: number, language: 'bg' | 'en', env: ExtendedEnv): Promise<void> {
  const text = language === 'bg'
    ? [
        '⚔️ DyrakArmy Arena',
        '',
        'Създай или се присъедини към отбор и изпълнявай ново предизвикателство всеки ден.',
        '',
        '🎯 8 задачи на ден',
        '🛡 Отборна седмична лига',
        '🏆 Месечен сезон',
        '⚡ Общ XP, ранг и профилни награди',
        '👑 Top 3 отборите получават шампионски статус',
      ].join('\n')
    : [
        '⚔️ DyrakArmy Arena',
        '',
        'Create or join a team and complete a fresh challenge every day.',
        '',
        '🎯 8 daily missions',
        '🛡 Weekly team league',
        '🏆 Monthly season',
        '⚡ Shared XP, rank and profile rewards',
        '👑 Top 3 teams receive champion status',
      ].join('\n');
  await sendMessage(chatId, text, env, arenaKeyboard(language, env));
}

function arenaKeyboard(language: 'bg' | 'en', env: ExtendedEnv): Record<string, unknown> {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: language === 'bg' ? '⚔️ Играй DyrakArmy Arena' : '⚔️ Play DyrakArmy Arena', web_app: { url: arenaUrl(env) } }],
        [{ text: language === 'bg' ? '🛡 Моят отбор и ранг' : '🛡 My team and rank', callback_data: 'arena:profile' }],
        [{ text: language === 'bg' ? '⚡ Latency Strike' : '⚡ Latency Strike', web_app: { url: latencyUrl(env) } }],
      ],
    },
  };
}

function arenaUrl(env: ExtendedEnv): string {
  const base = String(env.PUBLIC_BASE_URL || 'https://dyrakarmy.eu').replace(/\/+$/, '');
  return `${base}/games/dyrakarmy-arena/?v=1.0.0`;
}

function latencyUrl(env: ExtendedEnv): string {
  const base = String(env.PUBLIC_BASE_URL || 'https://dyrakarmy.eu').replace(/\/+$/, '');
  return `${base}/games/latency-strike/?v=1.0.0`;
}

function languageFor(user?: TelegramUser): 'bg' | 'en' {
  return user?.language_code?.toLowerCase().startsWith('en') ? 'en' : 'bg';
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

async function telegramRequest<T = unknown>(
  method: string,
  payload: Record<string, unknown>,
  env: ExtendedEnv,
): Promise<TelegramMethodResult<T>> {
  const base = String(env.TELEGRAM_BOT_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const response = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const parsed = await response.json().catch(() => null) as TelegramMethodResult<T> | null;
  return parsed || { ok: false, description: `HTTP ${response.status}` };
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}
