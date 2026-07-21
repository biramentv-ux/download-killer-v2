import type { Env } from './types';
import { getArchiveRaidBotSummary } from './archive_raid';

type ExtendedEnv = Env & { TELEGRAM_BOT_API_BASE?: string };

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

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface WebhookRequestLike {
  headers: Headers;
  json(): Promise<unknown>;
}

interface TelegramMethodResult {
  ok: boolean;
  description?: string;
}

export async function handleArchiveRaidTelegramWebhook(
  request: WebhookRequestLike,
  env: ExtendedEnv,
): Promise<Response | null> {
  const providedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!constantTimeEqual(providedSecret, String(env.TELEGRAM_SECRET_TOKEN || ''))) {
    return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });
  }
  const update = await request.json().catch(() => null) as TelegramUpdate | null;
  if (!update) return null;

  const callback = update.callback_query;
  if (callback?.data === 'archive-raid:collection') {
    await telegramRequest('answerCallbackQuery', { callback_query_id: callback.id }, env);
    const language = languageFor(callback.from);
    const summary = await getArchiveRaidBotSummary(callback.from.id, env, language);
    await sendMessage(callback.message?.chat.id || callback.from.id, summary, env, raidKeyboard(language, env));
    return Response.json({ ok: true, mode: 'archive_raid_collection' });
  }

  const message = update.message;
  if (!message?.text) return null;
  const text = message.text.trim();
  const command = text.split(/\s+/)[0]?.split('@')[0]?.toLowerCase() || '';
  const label = text.toLowerCase();
  const language = languageFor(message.from);
  const isRaid = command === '/raid' || command === '/archiveraid' || label === '🗃 archive raid';
  const isCollection = command === '/collection' || command === '/cards' || label === '🃏 колекция' || label === '🃏 collection';
  const isCrate = command === '/crate' || label === '🎁 дневен crate' || label === '🎁 daily crate';
  if (!isRaid && !isCollection && !isCrate) return null;

  if (isCollection) {
    const summary = await getArchiveRaidBotSummary(message.from?.id || message.chat.id, env, language);
    await sendMessage(message.chat.id, summary, env, raidKeyboard(language, env));
    return Response.json({ ok: true, mode: 'archive_raid_collection' });
  }

  const textCard = language === 'bg'
    ? [
        '🗃 Archive Raid', '',
        'Проникни във виртуални архивни сектори, избери риск и печели collectible карти.', '',
        '🃏 Жанрове, waveform дизайни и bot skins',
        '⬢ Server cores, badges и артистични архетипи',
        '✨ Profile effects и Army Exclusive награди',
        '⚡ Общ XP и ранг с Arena и Latency Strike',
        '🔒 Няма достъп до защитено съдържание', '',
        isCrate ? 'Отвори играта и натисни „Дневен crate“.' : 'Всеки рейд има пет сектора и избор между Scan, Extract и Breach.',
      ].join('\n')
    : [
        '🗃 Archive Raid', '',
        'Enter virtual archive sectors, choose your risk and earn collectible cards.', '',
        '🃏 Genres, waveform designs and bot skins',
        '⬢ Server cores, badges and artist archetypes',
        '✨ Profile effects and Army Exclusive rewards',
        '⚡ Shared XP and rank with Arena and Latency Strike',
        '🔒 No access to protected content', '',
        isCrate ? 'Open the game and press “Daily crate”.' : 'Every raid contains five sectors with Scan, Extract and Breach routes.',
      ].join('\n');
  await sendMessage(message.chat.id, textCard, env, raidKeyboard(language, env));
  return Response.json({ ok: true, mode: isCrate ? 'archive_raid_crate' : 'archive_raid_web_app' });
}

function raidKeyboard(language: 'bg' | 'en', env: ExtendedEnv): Record<string, unknown> {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: language === 'bg' ? '🗃 Играй Archive Raid' : '🗃 Play Archive Raid', web_app: { url: raidUrl(env) } }],
        [{ text: language === 'bg' ? '🃏 Моята колекция' : '🃏 My collection', callback_data: 'archive-raid:collection' }],
        [
          { text: '⚔️ Arena', web_app: { url: arenaUrl(env) } },
          { text: '⚡ Latency Strike', web_app: { url: latencyUrl(env) } },
        ],
      ],
    },
  };
}

function raidUrl(env: ExtendedEnv): string {
  return `${baseUrl(env)}/games/archive-raid/?v=1.0.0`;
}

function arenaUrl(env: ExtendedEnv): string {
  return `${baseUrl(env)}/games/dyrakarmy-arena/?v=1.0.0`;
}

function latencyUrl(env: ExtendedEnv): string {
  return `${baseUrl(env)}/games/latency-strike/?v=1.0.0`;
}

function baseUrl(env: ExtendedEnv): string {
  return String(env.PUBLIC_BASE_URL || 'https://dyrakarmy.eu').replace(/\/+$/, '');
}

function languageFor(user?: TelegramUser): 'bg' | 'en' {
  return user?.language_code?.toLowerCase().startsWith('en') ? 'en' : 'bg';
}

async function sendMessage(chatId: number, text: string, env: ExtendedEnv, extra: Record<string, unknown>): Promise<void> {
  const result = await telegramRequest('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra }, env);
  if (!result.ok) throw new Error(result.description || 'Telegram sendMessage failed');
}

async function telegramRequest(method: string, payload: Record<string, unknown>, env: ExtendedEnv): Promise<TelegramMethodResult> {
  const base = String(env.TELEGRAM_BOT_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const response = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` })) as TelegramMethodResult;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}
