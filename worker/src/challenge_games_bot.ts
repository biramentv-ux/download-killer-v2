import type { Env } from './types';
import {
  CHALLENGE_GAMES,
  challengeGameSlugs,
  getChallengeGameBotSummary,
  type ChallengeGameSlug,
} from './challenge_games';
import { isPlatformModuleEnabled } from './platform_control';

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

const COMMAND_TO_GAME = new Map<string, ChallengeGameSlug>(
  challengeGameSlugs().map((slug) => [`/${CHALLENGE_GAMES[slug].command}`, slug]),
);

export async function handleChallengeGamesTelegramWebhook(
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
  if (callback?.data?.startsWith('challenge:profile:')) {
    const slug = callback.data.slice('challenge:profile:'.length) as ChallengeGameSlug;
    if (!CHALLENGE_GAMES[slug]) return null;
    if (!await isPlatformModuleEnabled(env, slug)) return Response.json({ ok: true, mode: 'game_disabled' });
    await telegramRequest('answerCallbackQuery', { callback_query_id: callback.id }, env);
    const language = languageFor(callback.from);
    const summary = await getChallengeGameBotSummary(slug, callback.from.id, env, language);
    await sendMessage(callback.message?.chat.id || callback.from.id, summary, env, gameKeyboard(slug, language, env));
    return Response.json({ ok: true, mode: `${slug}_profile` });
  }

  const message = update.message;
  if (!message?.text) return null;
  const raw = message.text.trim();
  const command = raw.split(/\s+/)[0]?.split('@')[0]?.toLowerCase() || '';
  const slug = COMMAND_TO_GAME.get(command);
  if (!slug) return null;
  if (!await isPlatformModuleEnabled(env, slug)) {
    await sendMessage(message.chat.id, 'Тази игра е временно изключена от Control Center.', env, {});
    return Response.json({ ok: true, mode: 'game_disabled' });
  }
  const game = CHALLENGE_GAMES[slug];
  const language = languageFor(message.from);
  const text = language === 'bg'
    ? [
        `${game.icon} ${game.title}`,
        '',
        game.description,
        '',
        `🎯 ${game.rounds} рунда на игра`,
        '⚡ Общ XP и ранг с останалите DyrakArmy Games',
        '🏆 Седмична класация',
        `🎁 Perfect-run награда: ${game.reward_label}`,
      ].join('\n')
    : [
        `${game.icon} ${game.title}`,
        '',
        game.description,
        '',
        `🎯 ${game.rounds} rounds per game`,
        '⚡ Shared XP and rank with all DyrakArmy Games',
        '🏆 Weekly leaderboard',
        `🎁 Perfect-run reward: ${game.reward_label}`,
      ].join('\n');
  await sendMessage(message.chat.id, text, env, gameKeyboard(slug, language, env));
  return Response.json({ ok: true, mode: `${slug}_web_app` });
}

function gameKeyboard(slug: ChallengeGameSlug, language: 'bg' | 'en', env: ExtendedEnv): Record<string, unknown> {
  const game = CHALLENGE_GAMES[slug];
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: language === 'bg' ? `${game.icon} Играй ${game.title}` : `${game.icon} Play ${game.title}`, web_app: { url: gameUrl(slug, env) } }],
        [{ text: language === 'bg' ? '🏅 Моят ранг и резултат' : '🏅 My rank and score', callback_data: `challenge:profile:${slug}` }],
        [{ text: language === 'bg' ? '🎮 Всички игри' : '🎮 All games', web_app: { url: `${baseUrl(env)}/#games` } }],
      ],
    },
  };
}

function gameUrl(slug: ChallengeGameSlug, env: ExtendedEnv): string {
  return `${baseUrl(env)}/games/${slug}/?v=1.0.0`;
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
