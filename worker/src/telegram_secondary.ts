import type { Env } from './types';

type SecondaryTelegramEnv = Env & {
  TELEGRAM_SECONDARY_BOT_TOKEN?: string;
  TELEGRAM_SECONDARY_SECRET_TOKEN?: string;
  TELEGRAM_SECONDARY_BOT_USERNAME?: string;
  TELEGRAM_BOT_API_BASE?: string;
  TELEGRAM_STORAGE_ENABLED?: string;
  TELEGRAM_STORAGE_MAX_MB?: string;
  TELEGRAM_MINIAPP_PATH?: string;
  TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS?: string;
};

export function hasSecondaryTelegramBot(env: SecondaryTelegramEnv): boolean {
  return Boolean(
    String(env.TELEGRAM_SECONDARY_BOT_TOKEN ?? '').trim()
    && String(env.TELEGRAM_SECONDARY_SECRET_TOKEN ?? '').trim(),
  );
}

export function createSecondaryTelegramEnv(env: SecondaryTelegramEnv): SecondaryTelegramEnv {
  return Object.assign(Object.create(env), {
    TELEGRAM_BOT_TOKEN: String(env.TELEGRAM_SECONDARY_BOT_TOKEN ?? '').trim(),
    TELEGRAM_SECRET_TOKEN: String(env.TELEGRAM_SECONDARY_SECRET_TOKEN ?? '').trim(),
    TELEGRAM_BOT_USERNAME: String(env.TELEGRAM_SECONDARY_BOT_USERNAME ?? 'dyrakarmy_bot').replace(/^@+/, ''),
    // The secondary bot opens the public platform. Its commands, queue, history
    // and file delivery still use the same Worker, D1 and Telegram archive.
    TELEGRAM_MINIAPP_PATH: '/',
  }) as SecondaryTelegramEnv;
}

export function rewriteSecondaryTelegramApiRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(
    /^\/api\/telegram\/v10-secondary\//,
    '/api/telegram/v10/',
  );
  return new Request(url.toString(), request);
}
