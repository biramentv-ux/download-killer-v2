import type { Env } from './types';
import { isPlatformAdminId } from './platform_control';

type ExtendedEnv = Env & {
  TELEGRAM_ADMIN_IDS?: string;
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

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface WebhookRequestLike {
  headers: Headers;
  json(): Promise<unknown>;
}

interface TelegramMethodResult {
  ok: boolean;
  description?: string;
}

export async function handlePlatformControlTelegramWebhook(
  request: WebhookRequestLike,
  env: ExtendedEnv,
): Promise<Response | null> {
  const providedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!constantTimeEqual(providedSecret, String(env.TELEGRAM_SECRET_TOKEN || ''))) {
    return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });
  }
  const update = await request.json().catch(() => null) as TelegramUpdate | null;
  const message = update?.message;
  if (!message?.text || !message.from) return null;
  const command = message.text.trim().split(/\s+/)[0]?.split('@')[0]?.toLowerCase() || '';
  if (!['/control', '/admin', '/id', '/whoami'].includes(command)) return null;

  const language = message.from.language_code?.toLowerCase().startsWith('en') ? 'en' : 'bg';
  if (command === '/id' || command === '/whoami') {
    await sendMessage(message.chat.id, language === 'bg'
      ? `🪪 Твоят Telegram ID е:\n\n${message.from.id}\n\nТози номер се добавя в Cloudflare secret TELEGRAM_ADMIN_IDS. Не е парола.`
      : `🪪 Your Telegram ID is:\n\n${message.from.id}\n\nAdd this number to the Cloudflare secret TELEGRAM_ADMIN_IDS. It is not a password.`, env);
    return Response.json({ ok: true, mode: 'identity' });
  }

  if (!isPlatformAdminId(message.from.id, env)) {
    await sendMessage(message.chat.id, language === 'bg'
      ? `⛔ Нямаш администраторски достъп.\n\nТвоят Telegram ID: ${message.from.id}\nДобави го в secret TELEGRAM_ADMIN_IDS и публикувай Worker-а отново.`
      : `⛔ You do not have administrator access.\n\nYour Telegram ID: ${message.from.id}\nAdd it to the TELEGRAM_ADMIN_IDS secret and redeploy the Worker.`, env);
    return Response.json({ ok: true, mode: 'access_denied' });
  }

  const controlUrl = `${String(env.PUBLIC_BASE_URL || 'https://dyrakarmy.eu').replace(/\/+$/, '')}/control/?v=1.0.0`;
  await sendMessage(message.chat.id, language === 'bg'
    ? [
        '⚙️ DyrakArmy Control Center', '',
        'От телефона можеш да:',
        '• включваш и скриваш модули;',
        '• добавяш публични карти, линкове и съобщения;',
        '• управляваш игрите и секциите на сайта;',
        '• сменяш тема и публични текстове;',
        '• преглеждаш audit log.', '',
        'Промените стават публични веднага, без нов deploy.',
      ].join('\n')
    : [
        '⚙️ DyrakArmy Control Center', '',
        'From your phone you can:',
        '• enable or hide modules;',
        '• add public cards, links and announcements;',
        '• manage games and website sections;',
        '• change theme and public text;',
        '• review the audit log.', '',
        'Changes become public immediately without a new deploy.',
      ].join('\n'), env, {
        reply_markup: {
          inline_keyboard: [[{
            text: language === 'bg' ? '⚙️ Отвори Control Center' : '⚙️ Open Control Center',
            web_app: { url: controlUrl },
          }]],
        },
      });
  return Response.json({ ok: true, mode: 'control_center' });
}

async function sendMessage(
  chatId: number,
  text: string,
  env: ExtendedEnv,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const base = String(env.TELEGRAM_BOT_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const response = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, ...extra }),
  });
  const result = await response.json().catch(() => null) as TelegramMethodResult | null;
  if (!response.ok || !result?.ok) throw new Error(result?.description || `Telegram HTTP ${response.status}`);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}
