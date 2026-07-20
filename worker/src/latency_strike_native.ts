import type { Env } from './types';
import { handleLatencyStrikeApi } from './latency_strike';

type ExtendedEnv = Env & {
  TELEGRAM_BOT_API_BASE?: string;
};

export interface NativeGameTelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface NativeGameLaunchContext {
  user: NativeGameTelegramUser;
  chat_id?: number;
  message_id?: number;
  inline_message_id?: string;
  chat_instance?: string;
}

interface StoredNativeGameSession extends NativeGameLaunchContext {
  issued_at: number;
}

interface TelegramMethodResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

const NATIVE_SESSION_PREFIX = 'game:latency:native:';
const NATIVE_SESSION_TTL_SECONDS = 900;

export async function createLatencyStrikeNativeLaunch(
  context: NativeGameLaunchContext,
  env: ExtendedEnv,
): Promise<string> {
  const token = randomHex(24);
  const session: StoredNativeGameSession = {
    ...context,
    issued_at: Math.floor(Date.now() / 1000),
  };
  await env.CACHE.put(`${NATIVE_SESSION_PREFIX}${token}`, JSON.stringify(session), {
    expirationTtl: NATIVE_SESSION_TTL_SECONDS,
  });
  const base = String(env.PUBLIC_BASE_URL || 'https://dyrakarmy.eu').replace(/\/+$/, '');
  return `${base}/games/latency-strike/?v=1.0.0&native_session=${token}`;
}

export async function handleLatencyStrikeGameApi(
  request: Request,
  env: ExtendedEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/games/latency-strike/')) {
    return handleLatencyStrikeApi(request, env);
  }
  if (request.method !== 'POST') {
    return handleLatencyStrikeApi(request, env);
  }

  const body = await request.clone().json<Record<string, unknown>>().catch(() => null);
  const nativeToken = String(body?.native_session || '').trim();
  if (!/^[a-f0-9]{48}$/.test(nativeToken)) {
    return handleLatencyStrikeApi(request, env);
  }

  const session = await readNativeSession(nativeToken, env);
  if (!session) {
    return Response.json({
      error: { code: 'NATIVE_SESSION_EXPIRED', message: 'Telegram game session expired. Open the game again.' },
    }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  const initData = await createSyntheticTelegramInitData(session.user, env.TELEGRAM_BOT_TOKEN);
  const rewrittenBody = { ...(body || {}), init_data: initData };
  const rewrittenRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(rewrittenBody),
  });
  const response = await handleLatencyStrikeApi(rewrittenRequest, env);
  if (!response) return null;

  if (url.pathname.endsWith('/score') && response.ok) {
    const payload = await response.clone().json<{ result?: { score?: number } }>().catch(() => ({}));
    const score = Math.max(0, Math.floor(Number(payload.result?.score || 0)));
    if (score > 0) {
      await syncNativeTelegramScore(session, score, env).catch((error) => {
        console.warn('Unable to synchronize native Telegram game score', error);
      });
    }
  }

  return response;
}

export async function createSyntheticTelegramInitData(
  user: NativeGameTelegramUser,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  const params = new URLSearchParams();
  params.set('auth_date', String(nowSeconds));
  params.set('query_id', `native_${randomHex(12)}`);
  params.set('user', JSON.stringify(user));

  const entries = Array.from(params.entries())
    .map(([key, value]) => `${key}=${value}`)
    .sort();
  const dataCheckString = entries.join('\n');
  const encoder = new TextEncoder();
  const seedKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const secretBytes = await crypto.subtle.sign('HMAC', seedKey, encoder.encode(botToken));
  const secretKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(dataCheckString));
  params.set('hash', bytesToHex(new Uint8Array(signature)));
  return params.toString();
}

async function readNativeSession(
  token: string,
  env: ExtendedEnv,
): Promise<StoredNativeGameSession | null> {
  const raw = await env.CACHE.get(`${NATIVE_SESSION_PREFIX}${token}`);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as StoredNativeGameSession;
    if (!Number.isSafeInteger(session.user?.id) || session.user.id <= 0 || !session.user.first_name) return null;
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(session.issued_at || 0)) > NATIVE_SESSION_TTL_SECONDS) return null;
    return session;
  } catch {
    return null;
  }
}

async function syncNativeTelegramScore(
  session: StoredNativeGameSession,
  score: number,
  env: ExtendedEnv,
): Promise<void> {
  const payload: Record<string, unknown> = {
    user_id: session.user.id,
    score,
    force: false,
    disable_edit_message: false,
  };
  if (session.inline_message_id) {
    payload.inline_message_id = session.inline_message_id;
  } else if (session.chat_id && session.message_id) {
    payload.chat_id = session.chat_id;
    payload.message_id = session.message_id;
  } else {
    return;
  }
  const result = await telegramRequest('setGameScore', payload, env);
  if (!result.ok && !String(result.description || '').includes('BOT_SCORE_NOT_MODIFIED')) {
    throw new Error(result.description || 'setGameScore failed');
  }
}

async function telegramRequest<T>(
  method: string,
  payload: Record<string, unknown>,
  env: ExtendedEnv,
): Promise<TelegramMethodResponse<T>> {
  const base = String(env.TELEGRAM_BOT_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const response = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const parsed = await response.json().catch(() => null) as TelegramMethodResponse<T> | null;
  return parsed || { ok: false, description: `HTTP ${response.status}` };
}

function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}
