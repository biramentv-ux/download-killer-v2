import { downloadRouter } from './api';
import { handleTelegramUpdate } from './telegram';
import { initializeTelegramStorageSchema } from './telegram_schema';
import type { AudioFormat, AudioQuality, DownloadJob, Env, JobHistoryEvent } from './types';
import {
  createDownloadToken,
  rateLimit,
  readEnvInt,
  validateUrlPolicy,
} from './utils';

type ExtendedEnv = Env & {
  TELEGRAM_BOT_API_BASE?: string;
  TELEGRAM_STORAGE_ENABLED?: string;
  TELEGRAM_STORAGE_MAX_MB?: string;
  TELEGRAM_MINIAPP_PATH?: string;
  TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS?: string;
};

type TelegramLanguage = 'bg' | 'en';
type TelegramMediaKind = 'audio' | 'document' | 'link';
type TelegramUploadMode = 'url' | 'multipart' | 'link';

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  username?: string;
  title?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  web_app_data?: { data: string; button_text?: string };
  audio?: TelegramFileObject;
  document?: TelegramFileObject;
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
  channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramFileObject {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  duration?: number;
  performer?: string;
  title?: string;
}

interface TelegramApiMessage {
  message_id: number;
  chat?: TelegramChat;
  audio?: TelegramFileObject;
  document?: TelegramFileObject;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface JobRow {
  id: string;
  url: string;
  source: string;
  format: AudioFormat;
  quality: AudioQuality;
  fingerprint: string | null;
  content_hash: string | null;
  result_url: string | null;
  r2_key: string | null;
  title: string | null;
  artist: string | null;
  duration: number | null;
  file_size: number | null;
  status: string;
  chat_id: number | null;
  created_at: string;
  updated_at: string;
}

interface TelegramMediaRow {
  id: number;
  storage_key: string;
  job_id: string;
  source_url: string;
  source: string;
  format: string;
  quality: string;
  title: string | null;
  artist: string | null;
  duration: number | null;
  file_size: number | null;
  content_hash: string | null;
  media_kind: TelegramMediaKind;
  telegram_file_id: string | null;
  telegram_file_unique_id: string | null;
  channel_id: string | null;
  channel_message_id: number | null;
  fallback_url: string | null;
  created_at: string;
  updated_at: string;
}

interface MiniAppAuthResult {
  ok: boolean;
  user?: TelegramUser;
  queryId?: string;
  authDate?: number;
  error?: string;
}

interface BotCommand {
  command: string;
  args: string;
}

const TELEGRAM_URL_UPLOAD_LIMIT = 20 * 1024 * 1024;
const TELEGRAM_DEFAULT_UPLOAD_LIMIT = 50 * 1024 * 1024;
const SUPPORTED_FORMATS: AudioFormat[] = ['mp3', 'flac', 'ogg', 'm4a', 'opus', 'wav'];
const SUPPORTED_QUALITIES: AudioQuality[] = ['320', '256', '192', '128', '96', 'best', 'lossless'];
const NEW_COMMAND_MARKER = 'tg:commands:bg:v10';
const LEGACY_COMMAND_MARKER = 'tg:commands:bg:v4';

let telegramStorageSchemaReady: Promise<void> | null = null;

const COPY = {
  bg: {
    welcome: '🎧 Добре дошъл в Download Killer BG\n\nТърси по име или изпрати публичен URL. Задачите от сайта и бота използват една обща опашка, история и Telegram архив.',
    help: [
      'ℹ️ Команди',
      '/search – търсене по име',
      '/download – сваляне от URL',
      '/queue – активна опашка',
      '/history – последни задачи',
      '/myfiles – файлове в Telegram архива',
      '/formats – формати и качества',
      '/archive – архивно търсене',
      '/site – отвори Mini App',
      '/language – език',
      '/storage – статистика за хранилището',
      '/cancel – откажи последната чакаща задача',
      '/settings – подробни настройки',
    ].join('\n'),
    queueEmpty: '📥 Нямаш активни задачи.',
    historyEmpty: '🕘 Няма запазена история.',
    filesEmpty: '📦 Все още няма твои файлове в Telegram архива.',
    invalidHandoff: 'Линкът е изтекъл или вече е използван.',
    fileUnavailable: 'Файлът още не е готов за изпращане в Telegram.',
    cancelled: '🛑 Последната чакаща задача беше отказана.',
    nothingToCancel: 'Няма чакаща задача за отказване.',
  },
  en: {
    welcome: '🎧 Welcome to Download Killer\n\nSearch by name or send a public URL. The site and bot share one queue, history, and Telegram archive.',
    help: [
      'ℹ️ Commands',
      '/search – search by name',
      '/download – download from URL',
      '/queue – active queue',
      '/history – recent jobs',
      '/myfiles – files in Telegram archive',
      '/formats – formats and qualities',
      '/archive – archive search',
      '/site – open Mini App',
      '/language – language',
      '/storage – storage statistics',
      '/cancel – cancel latest waiting job',
      '/settings – detailed settings',
    ].join('\n'),
    queueEmpty: '📥 You have no active jobs.',
    historyEmpty: '🕘 No history is available.',
    filesEmpty: '📦 You have no files in the Telegram archive yet.',
    invalidHandoff: 'The link expired or was already used.',
    fileUnavailable: 'The file is not ready for Telegram delivery yet.',
    cancelled: '🛑 The latest waiting job was cancelled.',
    nothingToCancel: 'There is no waiting job to cancel.',
  },
} as const;

export function parseBotCommand(text: string): BotCommand | null {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const [head, ...rest] = trimmed.split(/\s+/);
  const command = (head ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (!/^\/[a-z0-9_]{1,32}$/.test(command)) return null;
  return { command, args: rest.join(' ').trim() };
}

export function chooseTelegramUploadMode(
  fileSize: number | null | undefined,
  format: string,
  maxUploadBytes = TELEGRAM_DEFAULT_UPLOAD_LIMIT,
): TelegramUploadMode {
  const size = Number(fileSize ?? 0);
  const audioByUrl = ['mp3', 'm4a'].includes(String(format).toLowerCase());
  if (size > 0 && size <= TELEGRAM_URL_UPLOAD_LIMIT && audioByUrl) return 'url';
  if (size > 0 && size <= maxUploadBytes) return 'multipart';
  return 'link';
}

export function buildTelegramDeepLinks(
  username: string,
  token: string,
): { botUrl: string; miniAppUrl: string } {
  const cleanUsername = String(username || 'download_killerBOT').replace(/^@+/, '');
  const cleanToken = String(token || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 54);
  const payload = `job_${cleanToken}`;
  return {
    botUrl: `https://t.me/${cleanUsername}?start=${payload}`,
    miniAppUrl: `https://t.me/${cleanUsername}?startapp=${payload}`,
  };
}

export async function validateTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 900,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<MiniAppAuthResult> {
  if (!initData || !botToken) return { ok: false, error: 'Missing Telegram initData or bot token' };

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash')?.toLowerCase() ?? '';
  if (!/^[a-f0-9]{64}$/.test(receivedHash)) return { ok: false, error: 'Invalid Telegram hash' };

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, error: 'Invalid auth_date' };
  if (Math.abs(nowSeconds - authDate) > Math.max(60, maxAgeSeconds)) {
    return { ok: false, error: 'Telegram session expired' };
  }

  const entries: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash' || key === 'signature') continue;
    entries.push(`${key}=${value}`);
  }
  entries.sort();
  const dataCheckString = entries.join('\n');
  const encoder = new TextEncoder();

  const seedKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const secretKeyBytes = await crypto.subtle.sign('HMAC', seedKey, encoder.encode(botToken));
  const secretKey = await crypto.subtle.importKey(
    'raw',
    secretKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(dataCheckString));
  const calculatedHash = bytesToHex(new Uint8Array(signature));
  if (!constantTimeEqual(calculatedHash, receivedHash)) return { ok: false, error: 'Telegram signature mismatch' };

  let user: TelegramUser | undefined;
  const rawUser = params.get('user');
  if (rawUser) {
    try {
      const parsed = JSON.parse(rawUser) as TelegramUser;
      if (Number.isSafeInteger(parsed.id) && parsed.id > 0 && parsed.first_name) user = parsed;
    } catch {
      return { ok: false, error: 'Invalid Telegram user payload' };
    }
  }
  if (!user) return { ok: false, error: 'Telegram user is missing' };

  return {
    ok: true,
    user,
    queryId: params.get('query_id') ?? undefined,
    authDate,
  };
}

export async function handleTelegramPlatformWebhook(request: Request, env: ExtendedEnv): Promise<Response> {
  const providedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!constantTimeEqual(providedSecret, String(env.TELEGRAM_SECRET_TOKEN ?? ''))) {
    return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized', retryable: false } }, { status: 401 });
  }

  const rawBody = await request.text();
  let update: TelegramUpdate;
  try {
    update = JSON.parse(rawBody) as TelegramUpdate;
  } catch {
    return Response.json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON', retryable: false } }, { status: 400 });
  }

  try {
    await ensureTelegramStorageSchema(env);
    await ensureTelegramV10Commands(env);
    const handled = await handleTelegramV10Update(update, env);
    if (handled) return Response.json({ ok: true });
  } catch (error) {
    console.error('Telegram v10 update failed', error);
  }

  const replayRequest = new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: rawBody,
  });
  return handleTelegramUpdate(replayRequest, env);
}

export async function handleTelegramPlatformApi(request: Request, env: ExtendedEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/telegram/v10/')) return null;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': request.headers.get('Origin') ?? '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        Vary: 'Origin',
      },
    });
  }

  await ensureTelegramStorageSchema(env);

  if (path === '/api/telegram/v10/config' && request.method === 'GET') {
    const username = botUsername(env);
    return jsonResponse(request, {
      ok: true,
      username,
      bot_url: `https://t.me/${username}`,
      mini_app_url: `https://t.me/${username}?startapp=home`,
      web_app_url: telegramMiniAppUrl(env),
      storage_enabled: storageEnabled(env),
      max_upload_mb: storageMaxBytes(env) / 1024 / 1024,
    });
  }

  if (path === '/api/telegram/v10/storage/stats' && request.method === 'GET') {
    return jsonResponse(request, { ok: true, ...(await getTelegramStorageStats(env)) });
  }

  if (path === '/api/telegram/v10/handoff' && request.method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? 'unknown';
    const limited = await rateLimit(env.CACHE, `tg:handoff:${ip}`, 20, 60);
    if (limited.limited) return jsonResponse(request, { error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true } }, 429);

    const body = await readJson<{ job_id?: string }>(request);
    const jobId = String(body?.job_id ?? '').trim();
    const job = jobId ? await loadJob(jobId, env) : null;
    if (!job || job.status !== 'done') {
      return jsonResponse(request, { error: { code: 'JOB_NOT_READY', message: 'The job is not ready', retryable: true } }, 409);
    }
    const token = randomToken(18);
    await env.CACHE.put(`tg:handoff:${token}`, job.id, { expirationTtl: 3600 });
    const links = buildTelegramDeepLinks(botUsername(env), token);
    return jsonResponse(request, { ok: true, job_id: job.id, expires_in: 3600, ...links });
  }

  if (path === '/api/telegram/v10/miniapp/profile' && request.method === 'POST') {
    const body = await readJson<{ init_data?: string }>(request);
    const auth = await authenticateMiniApp(body?.init_data ?? '', env);
    if (!auth.ok || !auth.user) return jsonResponse(request, { error: { code: 'TELEGRAM_AUTH_FAILED', message: auth.error ?? 'Unauthorized', retryable: false } }, 401);
    const syncKey = await ensureTelegramUserLink(auth.user, env);
    const history = await listUserJobs(auth.user.id, env, 12, false);
    const queue = history.filter((row) => ['queued', 'processing', 'paused'].includes(row.status));
    return jsonResponse(request, {
      ok: true,
      user: auth.user,
      sync_key: syncKey,
      queue,
      history,
      storage: await getTelegramStorageStats(env),
    });
  }

  if (path === '/api/telegram/v10/miniapp/download' && request.method === 'POST') {
    const body = await readJson<{
      init_data?: string;
      url?: string;
      source?: string;
      format?: AudioFormat;
      quality?: AudioQuality;
    }>(request);
    const auth = await authenticateMiniApp(body?.init_data ?? '', env);
    if (!auth.ok || !auth.user) return jsonResponse(request, { error: { code: 'TELEGRAM_AUTH_FAILED', message: auth.error ?? 'Unauthorized', retryable: false } }, 401);

    const policy = validateUrlPolicy(String(body?.url ?? ''), env);
    if (!policy.allowed) return jsonResponse(request, { error: { code: 'URL_BLOCKED', message: policy.message ?? 'URL blocked', retryable: false } }, 400);

    const syncKey = await ensureTelegramUserLink(auth.user, env);
    const internalBody = {
      url: String(body?.url ?? ''),
      source: String(body?.source ?? 'all'),
      format: normalizeFormat(body?.format),
      quality: normalizeQuality(body?.quality),
      sync_key: syncKey,
      client_id: 'telegram-miniapp',
    };
    const internalRequest = new Request(new URL('/api/download', request.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: request.headers.get('Origin') ?? new URL(request.url).origin,
        'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') ?? '',
      },
      body: JSON.stringify(internalBody),
    });
    const response = await downloadRouter(internalRequest, env);
    if (response.ok) {
      const payload = await response.clone().json() as { jobId?: string; mobileVariantJobId?: string };
      const jobIds = [payload.jobId, payload.mobileVariantJobId].filter(Boolean) as string[];
      for (const jobId of jobIds) {
        await env.DB.prepare('UPDATE download_jobs SET chat_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind(auth.user.id, jobId)
          .run();
      }
    }
    return response;
  }

  if (path === '/api/telegram/v10/miniapp/send-job' && request.method === 'POST') {
    const body = await readJson<{ init_data?: string; job_id?: string; handoff_token?: string }>(request);
    const auth = await authenticateMiniApp(body?.init_data ?? '', env);
    if (!auth.ok || !auth.user) return jsonResponse(request, { error: { code: 'TELEGRAM_AUTH_FAILED', message: auth.error ?? 'Unauthorized', retryable: false } }, 401);

    let jobId = String(body?.job_id ?? '').trim();
    if (!jobId && body?.handoff_token) jobId = await env.CACHE.get(`tg:handoff:${body.handoff_token}`) ?? '';
    if (!jobId) return jsonResponse(request, { error: { code: 'JOB_REQUIRED', message: 'job_id is required', retryable: false } }, 400);

    const delivered = await deliverJobToChat(auth.user.id, jobId, env);
    return jsonResponse(request, { ok: delivered, job_id: jobId }, delivered ? 200 : 409);
  }

  return jsonResponse(request, { error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } }, 404);
}

export async function syncTelegramStorageBatch(
  batch: MessageBatch<DownloadJob | JobHistoryEvent>,
  env: ExtendedEnv,
): Promise<void> {
  if (!storageEnabled(env)) return;
  const jobs = batch.messages
    .map((message) => message.body)
    .filter((body): body is DownloadJob => !('kind' in body));
  for (const job of jobs) {
    try {
      await syncCompletedJobToTelegramStorage(job.id, env);
    } catch (error) {
      console.warn(`Telegram storage sync failed for ${job.id}`, error);
    }
  }
}

export async function ensureTelegramV10Commands(env: ExtendedEnv): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const marker = await env.CACHE.get(NEW_COMMAND_MARKER);
  if (marker === '1') return;

  const commands = [
    { command: 'start', description: 'Старт и главно меню' },
    { command: 'search', description: 'Търсене по име' },
    { command: 'download', description: 'Свали от публичен URL' },
    { command: 'queue', description: 'Активна опашка' },
    { command: 'history', description: 'Последни задачи' },
    { command: 'myfiles', description: 'Моите файлове в Telegram' },
    { command: 'formats', description: 'Формати и качество' },
    { command: 'archive', description: 'Търсене в архива' },
    { command: 'site', description: 'Отвори Mini App' },
    { command: 'language', description: 'Език BG/EN' },
    { command: 'storage', description: 'Статистика за архива' },
    { command: 'cancel', description: 'Откажи чакаща задача' },
    { command: 'settings', description: 'Настройки' },
    { command: 'help', description: 'Помощ' },
  ];

  const results = await Promise.all([
    telegramRequest('setMyCommands', { commands, language_code: 'bg' }, env),
    telegramRequest('setMyCommands', { commands }, env),
    telegramRequest('setChatMenuButton', {
      menu_button: {
        type: 'web_app',
        text: 'Download Killer',
        web_app: { url: telegramMiniAppUrl(env) },
      },
    }, env),
    telegramRequest('setMyDescription', {
      description: 'Български бот и Mini App за търсене, опашка, история и Telegram архив на медийни файлове.',
      language_code: 'bg',
    }, env),
    telegramRequest('setMyShortDescription', {
      short_description: 'BG търсене, опашка, история и Telegram файлов архив.',
      language_code: 'bg',
    }, env),
  ]);

  if (results.every((result) => result.ok)) {
    await env.CACHE.put(NEW_COMMAND_MARKER, '1', { expirationTtl: 86400 });
    // Prevent the legacy handler from replacing the extended command list.
    await env.CACHE.put(LEGACY_COMMAND_MARKER, '1', { expirationTtl: 86400 });
  }
}

async function handleTelegramV10Update(update: TelegramUpdate, env: ExtendedEnv): Promise<boolean> {
  if (update.callback_query) return handleV10Callback(update.callback_query, env);
  const message = update.message;
  if (!message || message.chat.type !== 'private') return false;

  if (message.web_app_data?.data) {
    return handleWebAppData(message, env);
  }

  const text = String(message.text ?? '').trim();
  if (!text) return false;
  const command = parseBotCommand(text);
  const label = text.toLowerCase();

  if (command?.command === '/start') {
    if (command.args.startsWith('job_')) {
      const token = command.args.slice(4);
      const jobId = await env.CACHE.get(`tg:handoff:${token}`);
      if (!jobId) {
        await sendMessage(message.chat.id, COPY.bg.invalidHandoff, env, mainKeyboard(env));
        return true;
      }
      await env.CACHE.delete(`tg:handoff:${token}`);
      const delivered = await deliverJobToChat(message.chat.id, jobId, env);
      if (!delivered) await sendMessage(message.chat.id, COPY.bg.fileUnavailable, env, mainKeyboard(env));
      return true;
    }
    await ensureTelegramUserLink(message.from ?? { id: message.chat.id, first_name: 'Telegram' }, env);
    await sendWelcome(message.chat.id, env);
    return true;
  }

  if (command?.command === '/menu' || label === '🏠 меню') {
    await sendWelcome(message.chat.id, env);
    return true;
  }
  if (command?.command === '/help' || label === 'ℹ️ помощ') {
    await sendLocalized(message.chat.id, 'help', env, mainKeyboard(env));
    return true;
  }
  if (command?.command === '/queue' || label === '📥 опашка') {
    await sendQueue(message.chat.id, env);
    return true;
  }
  if (command?.command === '/history' || label === '🕘 история') {
    await sendHistory(message.chat.id, env);
    return true;
  }
  if (command?.command === '/myfiles' || label === '🎧 моите файлове') {
    await sendMyFiles(message.chat.id, env);
    return true;
  }
  if (command?.command === '/formats' || label === '🎚 формати') {
    await sendFormats(message.chat.id, env);
    return true;
  }
  if (command?.command === '/site' || label === '🌐 mini app') {
    await sendMiniApp(message.chat.id, env);
    return true;
  }
  if (command?.command === '/language' || label === '🌍 език') {
    await sendLanguagePicker(message.chat.id, env);
    return true;
  }
  if (command?.command === '/storage' || label === '☁️ telegram архив') {
    await sendStorageStats(message.chat.id, env);
    return true;
  }
  if (command?.command === '/cancel') {
    await cancelLatestWaitingJob(message.chat.id, env);
    return true;
  }
  if (command?.command === '/download' || label === '⬇️ свали url') {
    await sendMessage(message.chat.id, 'Изпрати публичен URL от Spotify, YouTube, SoundCloud, Deezer, Apple Music или Podcast/RSS.', env, mainKeyboard(env));
    return true;
  }
  if (command?.command === '/search' || label === '🔎 търсене') {
    await sendMessage(message.chat.id, 'Напиши име на песен, изпълнител или албум.', env, mainKeyboard(env));
    return true;
  }

  // Archive and settings are already feature-rich in the legacy module.
  if (command?.command === '/archive' || command?.command === '/settings' || label === '📦 архив' || label === '⚙️ настройки') {
    return false;
  }

  return false;
}

async function handleV10Callback(query: TelegramCallbackQuery, env: ExtendedEnv): Promise<boolean> {
  const data = String(query.data ?? '');
  if (!data.startsWith('v10:')) return false;
  await telegramRequest('answerCallbackQuery', { callback_query_id: query.id }, env);
  const chatId = query.message?.chat.id ?? query.from.id;

  if (data === 'v10:home') await sendWelcome(chatId, env);
  else if (data === 'v10:queue') await sendQueue(chatId, env);
  else if (data === 'v10:history') await sendHistory(chatId, env);
  else if (data === 'v10:myfiles') await sendMyFiles(chatId, env);
  else if (data === 'v10:formats') await sendFormats(chatId, env);
  else if (data === 'v10:storage') await sendStorageStats(chatId, env);
  else if (data === 'v10:site') await sendMiniApp(chatId, env);
  else if (data === 'v10:lang:bg' || data === 'v10:lang:en') {
    const language = data.endsWith(':en') ? 'en' : 'bg';
    await env.CACHE.put(`tg:v10:lang:${chatId}`, language, { expirationTtl: 365 * 86400 });
    await sendWelcome(chatId, env);
  } else if (data.startsWith('v10:file:')) {
    const mediaId = Number(data.slice('v10:file:'.length));
    if (Number.isSafeInteger(mediaId) && mediaId > 0) await deliverMediaById(chatId, mediaId, env);
  }
  return true;
}

async function handleWebAppData(message: TelegramMessage, env: ExtendedEnv): Promise<boolean> {
  let payload: { action?: string; job_id?: string };
  try {
    payload = JSON.parse(message.web_app_data?.data ?? '{}') as { action?: string; job_id?: string };
  } catch {
    return false;
  }
  if (payload.action === 'send_job' && payload.job_id) {
    const delivered = await deliverJobToChat(message.chat.id, payload.job_id, env);
    if (!delivered) await sendMessage(message.chat.id, COPY.bg.fileUnavailable, env);
    return true;
  }
  return false;
}

async function sendWelcome(chatId: number, env: ExtendedEnv): Promise<void> {
  const language = await getLanguage(chatId, env);
  await sendMessage(chatId, COPY[language].welcome, env, mainKeyboard(env));
}

async function sendQueue(chatId: number, env: ExtendedEnv): Promise<void> {
  const language = await getLanguage(chatId, env);
  const rows = await listUserJobs(chatId, env, 10, true);
  if (!rows.length) {
    await sendMessage(chatId, COPY[language].queueEmpty, env, mainKeyboard(env));
    return;
  }
  const body = rows.map((row, index) => `${index + 1}. ${statusIcon(row.status)} ${row.artist || '—'} - ${row.title || shortUrl(row.url)}\n   ${row.format.toUpperCase()} ${row.quality} · ${row.status} · #${row.id.slice(0, 8)}`).join('\n\n');
  await sendMessage(chatId, `📥 Активна опашка\n\n${body}`, env, {
    reply_markup: { inline_keyboard: [[{ text: '🔄 Обнови', callback_data: 'v10:queue' }, { text: '🏠 Меню', callback_data: 'v10:home' }]] },
  });
}

async function sendHistory(chatId: number, env: ExtendedEnv): Promise<void> {
  const language = await getLanguage(chatId, env);
  const rows = await listUserJobs(chatId, env, 10, false);
  if (!rows.length) {
    await sendMessage(chatId, COPY[language].historyEmpty, env, mainKeyboard(env));
    return;
  }
  const body = rows.map((row, index) => `${index + 1}. ${statusIcon(row.status)} ${row.artist || '—'} - ${row.title || shortUrl(row.url)}\n   ${row.format.toUpperCase()} ${row.quality} · ${row.status}`).join('\n\n');
  await sendMessage(chatId, `🕘 Последни задачи\n\n${body}`, env, {
    reply_markup: { inline_keyboard: [[{ text: '🔄 Обнови', callback_data: 'v10:history' }, { text: '🎧 Моите файлове', callback_data: 'v10:myfiles' }]] },
  });
}

async function sendMyFiles(chatId: number, env: ExtendedEnv): Promise<void> {
  const language = await getLanguage(chatId, env);
  const result = await env.DB.prepare(
    `SELECT m.* FROM telegram_media_objects m
     JOIN download_jobs j ON j.id = m.job_id
     WHERE j.chat_id = ?
     ORDER BY m.id DESC LIMIT 8`,
  ).bind(chatId).all<TelegramMediaRow>();
  const rows = result.results ?? [];
  if (!rows.length) {
    await sendMessage(chatId, COPY[language].filesEmpty, env, mainKeyboard(env));
    return;
  }
  const keyboard = rows.map((row) => [{
    text: `🎵 ${(row.artist || '—').slice(0, 20)} - ${(row.title || 'Файл').slice(0, 24)}`,
    callback_data: `v10:file:${row.id}`,
  }]);
  keyboard.push([{ text: '🏠 Меню', callback_data: 'v10:home' }]);
  await sendMessage(chatId, `🎧 Моите файлове\nЗаписани в Telegram: ${rows.length}`, env, { reply_markup: { inline_keyboard: keyboard } });
}

async function sendFormats(chatId: number, env: ExtendedEnv): Promise<void> {
  await sendMessage(chatId, [
    '🎚 Формати и качество',
    '',
    'MP3: 96 / 128 / 192 / 256 / 320 / Best',
    'M4A: 96 / 128 / 192 / 256 / 320 / Best',
    'OGG / OPUS: 96 / 128 / 192 / 256 / 320 / Best',
    'FLAC / WAV: Best / Lossless',
    '',
    'За Telegram player се предпочитат MP3 и M4A. Другите формати се изпращат като файл.',
  ].join('\n'), env, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⚙️ Подробни настройки', callback_data: 'cfg:home' }],
        [{ text: '🌐 Mini App', web_app: { url: telegramMiniAppUrl(env) } }],
      ],
    },
  });
}

async function sendMiniApp(chatId: number, env: ExtendedEnv): Promise<void> {
  await sendMessage(chatId, '🌐 Отвори Download Killer Mini App. Опашката и историята са синхронизирани с този чат.', env, {
    reply_markup: {
      inline_keyboard: [[{ text: '🚀 Отвори Mini App', web_app: { url: telegramMiniAppUrl(env) } }]],
    },
  });
}

async function sendLanguagePicker(chatId: number, env: ExtendedEnv): Promise<void> {
  await sendMessage(chatId, '🌍 Избери език / Choose language', env, {
    reply_markup: {
      inline_keyboard: [[
        { text: '🇧🇬 Български', callback_data: 'v10:lang:bg' },
        { text: '🇬🇧 English', callback_data: 'v10:lang:en' },
      ]],
    },
  });
}

async function sendStorageStats(chatId: number, env: ExtendedEnv): Promise<void> {
  const stats = await getTelegramStorageStats(env);
  await sendMessage(chatId, [
    '☁️ Telegram архив',
    `Файлове: ${stats.files}`,
    `Уникални обекти: ${stats.unique_files}`,
    `Общ размер: ${formatBytes(stats.total_bytes)}`,
    `Audio: ${stats.audio_files} · Documents: ${stats.document_files} · Links: ${stats.link_records}`,
    '',
    'При повторна заявка файлът се копира от storage канала без ново качване.',
  ].join('\n'), env, {
    reply_markup: { inline_keyboard: [[{ text: '🔄 Обнови', callback_data: 'v10:storage' }, { text: '🎧 Моите файлове', callback_data: 'v10:myfiles' }]] },
  });
}

async function cancelLatestWaitingJob(chatId: number, env: ExtendedEnv): Promise<void> {
  const language = await getLanguage(chatId, env);
  const row = await env.DB.prepare(
    `SELECT id FROM download_jobs
     WHERE chat_id = ? AND status IN ('queued', 'paused')
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(chatId).first<{ id: string }>();
  if (!row?.id) {
    await sendMessage(chatId, COPY[language].nothingToCancel, env, mainKeyboard(env));
    return;
  }
  await env.DB.prepare(
    `UPDATE download_jobs SET status = 'failed', error_code = 'USER_CANCELLED',
     error_message = 'Cancelled by Telegram user', finished_at = CURRENT_TIMESTAMP,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).bind(row.id).run();
  await sendMessage(chatId, COPY[language].cancelled, env, mainKeyboard(env));
}

async function sendLocalized(
  chatId: number,
  key: 'help',
  env: ExtendedEnv,
  extra?: Record<string, unknown>,
): Promise<void> {
  const language = await getLanguage(chatId, env);
  await sendMessage(chatId, COPY[language][key], env, extra);
}

async function listUserJobs(chatId: number, env: ExtendedEnv, limit: number, activeOnly: boolean): Promise<JobRow[]> {
  const condition = activeOnly ? "AND status IN ('queued', 'processing', 'paused')" : '';
  const result = await env.DB.prepare(
    `SELECT id, url, source, format, quality, fingerprint, content_hash, result_url, r2_key,
            title, artist, duration, file_size, status, chat_id, created_at, updated_at
     FROM download_jobs WHERE chat_id = ? ${condition}
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(chatId, Math.max(1, Math.min(30, limit))).all<JobRow>();
  return result.results ?? [];
}

async function deliverJobToChat(chatId: number, jobId: string, env: ExtendedEnv): Promise<boolean> {
  await ensureTelegramStorageSchema(env);
  const job = await loadJob(jobId, env);
  if (!job || job.status !== 'done') return false;

  let media = await findMediaForJob(job, env);
  if (!media && storageEnabled(env)) {
    await syncCompletedJobToTelegramStorage(job.id, env);
    media = await findMediaForJob(job, env);
  }
  if (media) return deliverStoredMedia(chatId, media, env);

  const link = await createJobDownloadLink(job.id, env);
  const response = await sendMessage(chatId, `✅ ${job.artist || '—'} - ${job.title || 'Файл'}\n${link}`, env, {
    reply_markup: { inline_keyboard: [[{ text: '⬇️ Свали файла', url: link }]] },
  });
  return response.ok;
}

async function deliverMediaById(chatId: number, mediaId: number, env: ExtendedEnv): Promise<boolean> {
  const media = await env.DB.prepare('SELECT * FROM telegram_media_objects WHERE id = ? LIMIT 1')
    .bind(mediaId)
    .first<TelegramMediaRow>();
  return media ? deliverStoredMedia(chatId, media, env) : false;
}

async function deliverStoredMedia(chatId: number, media: TelegramMediaRow, env: ExtendedEnv): Promise<boolean> {
  const caption = `🎵 ${media.artist || '—'} - ${media.title || 'Файл'}\n${media.format.toUpperCase()} ${media.quality} · ${formatBytes(media.file_size || 0)}`;

  if (media.channel_id && media.channel_message_id) {
    const copied = await telegramRequest<{ message_id: number }>('copyMessage', {
      chat_id: chatId,
      from_chat_id: media.channel_id,
      message_id: media.channel_message_id,
      caption,
    }, env);
    if (copied.ok) return true;
  }

  if (media.telegram_file_id) {
    const method = media.media_kind === 'audio' ? 'sendAudio' : 'sendDocument';
    const field = media.media_kind === 'audio' ? 'audio' : 'document';
    const sent = await telegramRequest<TelegramApiMessage>(method, {
      chat_id: chatId,
      [field]: media.telegram_file_id,
      caption,
      performer: media.artist || undefined,
      title: media.title || undefined,
      duration: media.duration || undefined,
    }, env);
    if (sent.ok) return true;
  }

  if (media.fallback_url) {
    const sent = await sendMessage(chatId, `${caption}\n${media.fallback_url}`, env, {
      reply_markup: { inline_keyboard: [[{ text: '⬇️ Свали файла', url: media.fallback_url }]] },
    });
    return sent.ok;
  }
  return false;
}

async function syncCompletedJobToTelegramStorage(jobId: string, env: ExtendedEnv): Promise<void> {
  if (!storageEnabled(env)) return;
  await ensureTelegramStorageSchema(env);
  const job = await loadJob(jobId, env);
  if (!job || job.status !== 'done' || !job.result_url) return;

  const storageKey = job.content_hash
    ? `sha256:${job.content_hash}:${job.format}:${job.quality}`
    : `fingerprint:${job.fingerprint || job.id}:${job.format}:${job.quality}`;
  const existing = await env.DB.prepare('SELECT id FROM telegram_media_objects WHERE storage_key = ? LIMIT 1')
    .bind(storageKey)
    .first<{ id: number }>();
  if (existing?.id) {
    await env.DB.prepare('UPDATE telegram_media_objects SET job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(job.id, existing.id)
      .run();
    return;
  }

  const channelId = await resolveStorageChannelId(env);
  if (!channelId) return;
  const downloadLink = await createJobDownloadLink(job.id, env);
  const maxBytes = storageMaxBytes(env);
  const uploadMode = chooseTelegramUploadMode(job.file_size, job.format, maxBytes);
  const caption = buildStorageCaption(job, downloadLink, env);

  let sent: TelegramApiResponse<TelegramApiMessage> = { ok: false, description: 'Storage upload not attempted' };
  let mediaKind: TelegramMediaKind = ['mp3', 'm4a'].includes(job.format) ? 'audio' : 'document';

  if (uploadMode === 'url') {
    sent = await telegramRequest<TelegramApiMessage>('sendAudio', {
      chat_id: channelId,
      audio: downloadLink,
      caption,
      performer: job.artist || 'DyrakArmy',
      title: job.title || 'Файл',
      duration: job.duration || undefined,
      disable_notification: true,
    }, env);
  } else if (uploadMode === 'multipart') {
    sent = await uploadJobMultipart(job, channelId, downloadLink, caption, env);
  }

  if (!sent.ok || !sent.result) {
    mediaKind = 'link';
    sent = await telegramRequest<TelegramApiMessage>('sendMessage', {
      chat_id: channelId,
      text: `${caption}\n\n⚠️ Файлът е над Telegram upload лимита или качването не беше прието.`,
      disable_web_page_preview: false,
      disable_notification: true,
      reply_markup: {
        inline_keyboard: [[{ text: '⬇️ Свали файла', url: downloadLink }, { text: '🤖 Отвори бота', url: `https://t.me/${botUsername(env)}` }]],
      },
    }, env);
  }

  if (!sent.ok || !sent.result) {
    console.warn('Telegram storage publish failed', sent.description);
    return;
  }

  const file = sent.result.audio ?? sent.result.document;
  if (file) mediaKind = sent.result.audio ? 'audio' : 'document';

  await env.DB.prepare(
    `INSERT INTO telegram_media_objects (
       storage_key, job_id, source_url, source, format, quality, title, artist,
       duration, file_size, content_hash, media_kind, telegram_file_id,
       telegram_file_unique_id, channel_id, channel_message_id, fallback_url,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(storage_key) DO UPDATE SET
       job_id = excluded.job_id,
       telegram_file_id = COALESCE(excluded.telegram_file_id, telegram_media_objects.telegram_file_id),
       telegram_file_unique_id = COALESCE(excluded.telegram_file_unique_id, telegram_media_objects.telegram_file_unique_id),
       channel_id = excluded.channel_id,
       channel_message_id = excluded.channel_message_id,
       fallback_url = excluded.fallback_url,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(
    storageKey,
    job.id,
    job.url,
    job.source,
    job.format,
    job.quality,
    job.title,
    job.artist,
    job.duration,
    job.file_size,
    job.content_hash,
    mediaKind,
    file?.file_id ?? null,
    file?.file_unique_id ?? null,
    channelId,
    sent.result.message_id,
    downloadLink,
  ).run();
}

async function uploadJobMultipart(
  job: JobRow,
  channelId: string,
  downloadLink: string,
  caption: string,
  env: ExtendedEnv,
): Promise<TelegramApiResponse<TelegramApiMessage>> {
  const response = await fetch(downloadLink, { method: 'GET' });
  if (!response.ok) return { ok: false, description: `Unable to fetch file (${response.status})` };
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > storageMaxBytes(env)) return { ok: false, description: 'File exceeds configured Telegram storage limit' };

  const audioMode = ['mp3', 'm4a'].includes(job.format);
  const method = audioMode ? 'sendAudio' : 'sendDocument';
  const field = audioMode ? 'audio' : 'document';
  const form = new FormData();
  form.set('chat_id', channelId);
  form.set('caption', caption);
  form.set('disable_notification', 'true');
  if (audioMode) {
    form.set('performer', job.artist || 'DyrakArmy');
    form.set('title', job.title || 'Файл');
    if (job.duration) form.set('duration', String(job.duration));
  }
  const filename = safeFilename(`${job.artist || 'DyrakArmy'} - ${job.title || job.id}.${job.format}`);
  const mime = contentTypeForFormat(job.format);
  form.set(field, new Blob([bytes], { type: mime }), filename);
  return telegramMultipartRequest<TelegramApiMessage>(method, form, env);
}

async function findMediaForJob(job: JobRow, env: ExtendedEnv): Promise<TelegramMediaRow | null> {
  let row = await env.DB.prepare('SELECT * FROM telegram_media_objects WHERE job_id = ? ORDER BY id DESC LIMIT 1')
    .bind(job.id)
    .first<TelegramMediaRow>();
  if (row) return row;
  if (job.content_hash) {
    row = await env.DB.prepare(
      'SELECT * FROM telegram_media_objects WHERE content_hash = ? AND format = ? ORDER BY id DESC LIMIT 1',
    ).bind(job.content_hash, job.format).first<TelegramMediaRow>();
  }
  return row ?? null;
}

async function loadJob(jobId: string, env: ExtendedEnv): Promise<JobRow | null> {
  return env.DB.prepare(
    `SELECT id, url, source, format, quality, fingerprint, content_hash, result_url, r2_key,
            title, artist, duration, file_size, status, chat_id, created_at, updated_at
     FROM download_jobs WHERE id = ? LIMIT 1`,
  ).bind(jobId).first<JobRow>();
}

async function getTelegramStorageStats(env: ExtendedEnv): Promise<{
  files: number;
  unique_files: number;
  total_bytes: number;
  audio_files: number;
  document_files: number;
  link_records: number;
}> {
  await ensureTelegramStorageSchema(env);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS files,
            COUNT(DISTINCT storage_key) AS unique_files,
            COALESCE(SUM(file_size), 0) AS total_bytes,
            SUM(CASE WHEN media_kind = 'audio' THEN 1 ELSE 0 END) AS audio_files,
            SUM(CASE WHEN media_kind = 'document' THEN 1 ELSE 0 END) AS document_files,
            SUM(CASE WHEN media_kind = 'link' THEN 1 ELSE 0 END) AS link_records
     FROM telegram_media_objects`,
  ).first<Record<string, number>>();
  return {
    files: Number(row?.files ?? 0),
    unique_files: Number(row?.unique_files ?? 0),
    total_bytes: Number(row?.total_bytes ?? 0),
    audio_files: Number(row?.audio_files ?? 0),
    document_files: Number(row?.document_files ?? 0),
    link_records: Number(row?.link_records ?? 0),
  };
}

async function ensureTelegramStorageSchema(env: ExtendedEnv): Promise<void> {
  if (!telegramStorageSchemaReady) {
    telegramStorageSchemaReady = initializeTelegramStorageSchema(env.DB).catch((error) => {
      telegramStorageSchemaReady = null;
      throw error;
    });
  }
  await telegramStorageSchemaReady;
}

async function ensureTelegramUserLink(user: TelegramUser, env: ExtendedEnv): Promise<string> {
  await ensureTelegramStorageSchema(env);
  const existing = await env.DB.prepare('SELECT sync_key FROM telegram_user_links WHERE telegram_user_id = ? LIMIT 1')
    .bind(user.id)
    .first<{ sync_key: string }>();
  const syncKey = existing?.sync_key ?? `tg_${user.id}_${randomToken(7)}`;
  await env.DB.prepare(
    `INSERT INTO telegram_user_links (
       telegram_user_id, chat_id, sync_key, username, first_name, language_code, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       username = excluded.username,
       first_name = excluded.first_name,
       language_code = excluded.language_code,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(user.id, user.id, syncKey, user.username ?? null, user.first_name, user.language_code ?? null).run();
  return syncKey;
}

async function authenticateMiniApp(initData: string, env: ExtendedEnv): Promise<MiniAppAuthResult> {
  const maxAge = readEnvInt(env.TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS, 900);
  return validateTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN, maxAge);
}

async function getLanguage(chatId: number, env: ExtendedEnv): Promise<TelegramLanguage> {
  const stored = await env.CACHE.get(`tg:v10:lang:${chatId}`);
  return stored === 'en' ? 'en' : 'bg';
}

function mainKeyboard(env: ExtendedEnv): Record<string, unknown> {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '🔎 Търсене' }, { text: '⬇️ Свали URL' }],
        [{ text: '📥 Опашка' }, { text: '🕘 История' }],
        [{ text: '🎧 Моите файлове' }, { text: '☁️ Telegram архив' }],
        [{ text: '📦 Архив' }, { text: '🎚 Формати' }],
        [{ text: '🌐 Mini App', web_app: { url: telegramMiniAppUrl(env) } }],
        [{ text: '⚙️ Настройки' }, { text: 'ℹ️ Помощ' }, { text: '🌍 Език' }],
      ],
      resize_keyboard: true,
      is_persistent: true,
      input_field_placeholder: 'Име на песен или публичен URL…',
    },
  };
}

async function resolveStorageChannelId(env: ExtendedEnv): Promise<string | null> {
  const configured = String(env.TELEGRAM_DOWNLOAD_CHANNEL_ID ?? '').trim();
  if (configured) return configured;
  const cached = await env.CACHE.get('tg:download_channel_id');
  return cached?.trim() || null;
}

async function createJobDownloadLink(jobId: string, env: ExtendedEnv): Promise<string> {
  const ttl = readEnvInt(env.DOWNLOAD_TOKEN_TTL_SECONDS, 3600);
  const token = await createDownloadToken({ jobId, exp: Math.floor(Date.now() / 1000) + ttl }, env.DOWNLOAD_TOKEN_SECRET);
  return `${publicBaseUrl(env)}/api/file/${encodeURIComponent(token)}`;
}

function buildStorageCaption(job: JobRow, link: string, env: ExtendedEnv): string {
  return [
    `🎵 ${job.artist || 'Неизвестен изпълнител'} - ${job.title || 'Файл'}`,
    `🎧 ${job.format.toUpperCase()} ${job.quality}`,
    `💾 ${formatBytes(job.file_size || 0)} · ⏱ ${formatDuration(job.duration || 0)}`,
    `🌐 ${job.source}`,
    `🆔 ${job.id.slice(0, 8)}`,
    '',
    link,
    `🤖 https://t.me/${botUsername(env)}`,
  ].join('\n').slice(0, 1000);
}

function botUsername(env: ExtendedEnv): string {
  return String(env.TELEGRAM_BOT_USERNAME ?? 'download_killerBOT').replace(/^@+/, '');
}

function publicBaseUrl(env: ExtendedEnv): string {
  return String(env.PUBLIC_BASE_URL ?? 'https://dyrakarmy.online').replace(/\/+$/g, '');
}

function telegramMiniAppUrl(env: ExtendedEnv): string {
  const path = String(env.TELEGRAM_MINIAPP_PATH ?? '/telegram/');
  return `${publicBaseUrl(env)}${path.startsWith('/') ? path : `/${path}`}`;
}

function storageEnabled(env: ExtendedEnv): boolean {
  return String(env.TELEGRAM_STORAGE_ENABLED ?? '1').trim() !== '0';
}

function storageMaxBytes(env: ExtendedEnv): number {
  const configuredMb = Math.max(1, Math.min(2000, readEnvInt(env.TELEGRAM_STORAGE_MAX_MB, 50)));
  return configuredMb * 1024 * 1024;
}

function normalizeFormat(value: unknown): AudioFormat {
  const normalized = String(value ?? 'mp3').toLowerCase() as AudioFormat;
  return SUPPORTED_FORMATS.includes(normalized) ? normalized : 'mp3';
}

function normalizeQuality(value: unknown): AudioQuality {
  const normalized = String(value ?? '320').toLowerCase() as AudioQuality;
  return SUPPORTED_QUALITIES.includes(normalized) ? normalized : '320';
}

function contentTypeForFormat(format: AudioFormat): string {
  const map: Record<AudioFormat, string> = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    flac: 'audio/flac',
    wav: 'audio/wav',
  };
  return map[format];
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 160) || 'download.bin';
}

function randomToken(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let binary = '';
  for (const value of buffer) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

function statusIcon(status: string): string {
  if (status === 'done') return '✅';
  if (status === 'failed') return '❌';
  if (status === 'processing') return '⚙️';
  if (status === 'paused') return '⏸';
  return '⏳';
}

function shortUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.slice(0, 50);
  } catch {
    return value.slice(0, 50);
  }
}

function formatBytes(value: number): string {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

function jsonResponse(request: Request, payload: unknown, status = 200): Response {
  const origin = request.headers.get('Origin') ?? '*';
  return Response.json(payload, {
    status,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
      'Cache-Control': 'no-store',
    },
  });
}

async function sendMessage(
  chatId: number | string,
  text: string,
  env: ExtendedEnv,
  extra: Record<string, unknown> = {},
): Promise<TelegramApiResponse<TelegramApiMessage>> {
  return telegramRequest<TelegramApiMessage>('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra,
  }, env);
}

async function telegramRequest<T>(
  method: string,
  payload: Record<string, unknown>,
  env: ExtendedEnv,
): Promise<TelegramApiResponse<T>> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, description: 'TELEGRAM_BOT_TOKEN is not configured' };
  try {
    const response = await fetch(telegramApiUrl(method, env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await response.json<TelegramApiResponse<T>>();
  } catch (error) {
    return { ok: false, description: error instanceof Error ? error.message : String(error) };
  }
}

async function telegramMultipartRequest<T>(
  method: string,
  form: FormData,
  env: ExtendedEnv,
): Promise<TelegramApiResponse<T>> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, description: 'TELEGRAM_BOT_TOKEN is not configured' };
  try {
    const response = await fetch(telegramApiUrl(method, env), { method: 'POST', body: form });
    return await response.json<TelegramApiResponse<T>>();
  } catch (error) {
    return { ok: false, description: error instanceof Error ? error.message : String(error) };
  }
}

function telegramApiUrl(method: string, env: ExtendedEnv): string {
  const base = String(env.TELEGRAM_BOT_API_BASE ?? 'https://api.telegram.org').replace(/\/+$/g, '');
  return `${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}
