import type { Env } from './types';
import { GAME_PACK, getGamePackBotSummary, type GamePackId } from './game_pack';

type ExtendedEnv = Env & { TELEGRAM_BOT_API_BASE?: string };
interface TelegramUser { id: number; first_name: string; last_name?: string; username?: string; language_code?: string }
interface TelegramMessage { message_id: number; chat: { id: number; type: string }; from?: TelegramUser; text?: string }
interface TelegramCallbackQuery { id: string; from: TelegramUser; message?: TelegramMessage; data?: string }
interface TelegramUpdate { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery }
interface WebhookRequestLike { headers: Headers; json(): Promise<unknown> }
interface TelegramMethodResult { ok: boolean; description?: string }

const COMMAND_TO_GAME: Record<string, GamePackId> = {
  '/queuegame': 'queue-commander',
  '/beathunter': 'beat-hunter',
  '/formatforge': 'format-forge',
  '/serverdefender': 'server-defender',
  '/metadata': 'metadata-detective',
  '/linkrunner': 'link-runner',
  '/botvshuman': 'bot-vs-human',
};

export async function handleGamePackTelegramWebhook(request: WebhookRequestLike, env: ExtendedEnv): Promise<Response | null> {
  const providedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!constantTimeEqual(providedSecret, String(env.TELEGRAM_SECRET_TOKEN || ''))) {
    return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });
  }
  const update = await request.json().catch(() => null) as TelegramUpdate | null;
  if (!update) return null;

  const callback = update.callback_query;
  if (callback?.data?.startsWith('game-pack:profile:')) {
    const gameId = callback.data.slice('game-pack:profile:'.length) as GamePackId;
    if (!GAME_PACK[gameId]) return null;
    await telegramRequest('answerCallbackQuery', { callback_query_id: callback.id }, env);
    const language = languageFor(callback.from);
    const summary = await getGamePackBotSummary(gameId, callback.from.id, env, language);
    await sendMessage(callback.message?.chat.id || callback.from.id, summary, env, keyboard(gameId, language, env));
    return Response.json({ ok: true, mode: 'game_pack_profile', game_id: gameId });
  }

  const message = update.message;
  if (!message?.text) return null;
  const text = message.text.trim();
  const command = text.split(/\s+/)[0]?.split('@')[0]?.toLowerCase() || '';
  const gameId = COMMAND_TO_GAME[command];
  if (!gameId) return null;
  const language = languageFor(message.from);
  const game = GAME_PACK[gameId];
  const body = language === 'en'
    ? [game.icon + ' ' + game.title, '', game.description, '', '🎯 5 daily decision rounds', '⚡ Shared XP and rank across all 10 games', `🏅 Perfect-run reward: ${game.reward_title}`, '🧪 Unlimited practice mode'].join('\n')
    : [game.icon + ' ' + game.title, '', game.description, '', '🎯 5 дневни decision рунда', '⚡ Общ XP и ранг за всичките 10 игри', `🏅 Perfect-run награда: ${game.reward_title}`, '🧪 Неограничен practice режим'].join('\n');
  await sendMessage(message.chat.id, body, env, keyboard(gameId, language, env));
  return Response.json({ ok: true, mode: 'game_pack_web_app', game_id: gameId });
}

function keyboard(gameId: GamePackId, language: 'bg' | 'en', env: ExtendedEnv): Record<string, unknown> {
  const game = GAME_PACK[gameId];
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: language === 'bg' ? `${game.icon} Играй ${game.title}` : `${game.icon} Play ${game.title}`, web_app: { url: gameUrl(gameId, env) } }],
        [{ text: language === 'bg' ? '🏆 Моят резултат и ранг' : '🏆 My score and rank', callback_data: `game-pack:profile:${gameId}` }],
        [{ text: language === 'bg' ? '🎮 Всички игри' : '🎮 All games', web_app: { url: `${baseUrl(env)}/#games` } }],
      ],
    },
  };
}

function gameUrl(gameId: GamePackId, env: ExtendedEnv): string { return `${baseUrl(env)}/games/${gameId}/?v=1.0.0`; }
function baseUrl(env: ExtendedEnv): string { return String(env.PUBLIC_BASE_URL || 'https://dyrakarmy.eu').replace(/\/+$/, ''); }
function languageFor(user?: TelegramUser): 'bg' | 'en' { return user?.language_code?.toLowerCase().startsWith('en') ? 'en' : 'bg'; }
async function sendMessage(chatId: number, text: string, env: ExtendedEnv, extra: Record<string, unknown>): Promise<void> {
  const result = await telegramRequest('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra }, env);
  if (!result.ok) throw new Error(result.description || 'Telegram sendMessage failed');
}
async function telegramRequest(method: string, payload: Record<string, unknown>, env: ExtendedEnv): Promise<TelegramMethodResult> {
  const base = String(env.TELEGRAM_BOT_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const response = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
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
