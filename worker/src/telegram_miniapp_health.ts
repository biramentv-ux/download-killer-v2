import type { Env } from './types';

export const TELEGRAM_MINIAPP_VERSION = '12.2.0';

export function handleTelegramMiniAppHealth(request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/api/telegram/v12/health') return null;

  const username = String(env.TELEGRAM_BOT_USERNAME || 'dyrakarmy_bot').replace(/^@+/, '');
  const publicBase = String(env.PUBLIC_BASE_URL || url.origin).replace(/\/+$/, '');
  const headers = new Headers({
    'Cache-Control': 'no-store, max-age=0',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Download-Killer-Version': TELEGRAM_MINIAPP_VERSION,
  });
  const origin = request.headers.get('Origin');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }

  return new Response(JSON.stringify({
    ok: true,
    status: 'online',
    service: 'download-killer-telegram-miniapp',
    version: TELEGRAM_MINIAPP_VERSION,
    username,
    native_link: `tg://resolve?domain=${username}`,
    public_base_url: publicBase,
    storage_enabled: String((env as Env & { TELEGRAM_STORAGE_ENABLED?: string }).TELEGRAM_STORAGE_ENABLED ?? '1') !== '0',
    server_time: new Date().toISOString(),
  }), { status: 200, headers });
}
