import type { Env } from './types';
import { buildSoftwareCatalog, type SoftwareReleaseEntry } from './software_catalog';

type SoftwareTelegramEnv = Env & {
  TELEGRAM_BOT_API_BASE?: string;
  PUBLIC_BASE_URL?: string;
  LATEST_DESKTOP_WINDOWS_VERSION?: string;
  LATEST_DESKTOP_MACOS_VERSION?: string;
  LATEST_MOBILE_EXPO_VERSION?: string;
  LATEST_EXTENSION_VERSION?: string;
  LATEST_WEB_VERSION?: string;
  RELEASE_CHANNEL?: string;
  RELEASE_GITHUB_REPOSITORY?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  text?: string;
};

type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: TelegramMessage;
};

type TelegramUpdate = {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type InlineButton = { text: string; url?: string; callback_data?: string };

type SoftwareCommand = 'software' | 'games';

const SOFTWARE_ALIASES = new Set(['software', 'apps', 'releases', 'mix', 'mixing']);
const GAMES_ALIASES = new Set(['games', 'gamehub', 'allgames']);

const GAME_LINKS = [
  ['1 · Queue Commander', 'queue_commander'],
  ['2 · Beat Hunter', 'beat_hunter'],
  ['3 · DyrakArmy Arena', 'arena'],
  ['4 · Format Forge', 'format_forge'],
  ['5 · Server Defender', 'server_defender'],
  ['6 · Metadata Detective', 'metadata_detective'],
  ['7 · Link Runner', 'link_runner'],
  ['8 · Archive Raid', 'archive_raid'],
  ['9 · Latency Strike', 'latency_strike'],
  ['10 · Bot vs Human', 'bot_vs_human'],
] as const;

export function parseSoftwareTelegramCommand(text: string | undefined): SoftwareCommand | null {
  const firstToken = String(text || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  const command = firstToken.replace(/^\/+/, '').split('@')[0] || '';
  if (SOFTWARE_ALIASES.has(command)) return 'software';
  if (GAMES_ALIASES.has(command)) return 'games';
  return null;
}

function compactVersion(release: SoftwareReleaseEntry): string {
  return `v${release.version}`.slice(0, 16);
}

export function buildSoftwareInlineKeyboard(
  releases: SoftwareReleaseEntry[],
  publicBase = 'https://dyrakarmy.eu',
): InlineButton[][] {
  const preferredOrder = [
    'desktop-windows',
    'desktop-macos',
    'mix-engine-windows',
    'extension-chrome',
    'extension-firefox',
    'expo-native-update',
    'expo-web',
  ];
  const byId = new Map(releases.map((release) => [release.id, release]));
  const rows: InlineButton[][] = [];

  for (const id of preferredOrder) {
    const release = byId.get(id);
    if (!release) continue;
    const platformIcon = release.platform === 'windows'
      ? '🪟'
      : release.platform === 'macos'
        ? '🍎'
        : release.platform === 'mobile'
          ? '📱'
          : release.platform === 'browser'
            ? '🧩'
            : '🌐';
    rows.push([{ text: `${platformIcon} ${release.title} · ${compactVersion(release)}`.slice(0, 64), url: release.url }]);
  }

  rows.push([
    { text: '🌐 Всички версии', url: `${publicBase.replace(/\/+$/, '')}/#software` },
    { text: '🎮 Игри 1–10', callback_data: 'games:menu' },
  ]);
  return rows;
}

export function buildGamesInlineKeyboard(username = 'dyrakarmy_bot'): InlineButton[][] {
  const safeUsername = String(username || 'dyrakarmy_bot').replace(/^@+/, '').replace(/[^A-Za-z0-9_]/g, '') || 'dyrakarmy_bot';
  const rows: InlineButton[][] = [];
  for (let index = 0; index < GAME_LINKS.length; index += 2) {
    rows.push(GAME_LINKS.slice(index, index + 2).map(([title, startapp]) => ({
      text: `🎮 ${title}`.slice(0, 64),
      url: `https://t.me/${safeUsername}?startapp=${startapp}`,
    })));
  }
  rows.push([
    { text: '🏆 Общ профил и награди', url: 'https://dyrakarmy.eu/#rewards' },
    { text: '💿 Софтуер', callback_data: 'software:menu' },
  ]);
  return rows;
}

function softwareText(releases: SoftwareReleaseEntry[], channel: string): string {
  const featured = releases.filter((item) => item.featured).slice(0, 4);
  return [
    '💿 DyrakArmy Software & Mixing Toolkit',
    '',
    `Канал: ${channel.toUpperCase()}`,
    ...featured.map((item) => `• ${item.title} — v${item.version}`),
    '',
    'Бутоните водят директно към последните GitHub Release файлове. Използвай инструментите само за съдържание, което имаш право да обработваш.',
  ].join('\n');
}

function gamesText(): string {
  return [
    '🎮 DyrakArmy Games 1–10',
    '',
    'Всички игри използват един Telegram профил, общ XP, рангове, награди и седмични класации.',
    'Избери игра директно от менюто:',
  ].join('\n');
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) diff |= (a[index % Math.max(a.length, 1)] || 0) ^ (b[index % Math.max(b.length, 1)] || 0);
  return diff === 0;
}

async function telegramRequest(
  method: string,
  payload: Record<string, unknown>,
  env: SoftwareTelegramEnv,
): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const base = String(env.TELEGRAM_BOT_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const response = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => null) as { ok?: boolean } | null;
  return Boolean(response.ok && result?.ok);
}

async function sendSoftwareMenu(chatId: number, env: SoftwareTelegramEnv): Promise<boolean> {
  const publicBase = String(env.PUBLIC_BASE_URL || 'https://dyrakarmy.eu').replace(/\/+$/, '');
  const catalog = buildSoftwareCatalog(env, publicBase);
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text: softwareText(catalog.releases, catalog.channel),
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buildSoftwareInlineKeyboard(catalog.releases, publicBase) },
  }, env);
}

async function sendGamesMenu(chatId: number, env: SoftwareTelegramEnv): Promise<boolean> {
  const username = String(env.TELEGRAM_BOT_USERNAME || 'dyrakarmy_bot').replace(/^@+/, '');
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text: gamesText(),
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buildGamesInlineKeyboard(username) },
  }, env);
}

export async function handleSoftwareTelegramWebhook(
  request: Request,
  env: SoftwareTelegramEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;

  const providedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  const expectedSecret = String(env.TELEGRAM_SECRET_TOKEN || '');
  if (!expectedSecret || !constantTimeEqual(providedSecret, expectedSecret)) {
    return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });
  }

  const update = await request.json().catch(() => null) as TelegramUpdate | null;
  if (!update) return Response.json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, { status: 400 });

  const command = parseSoftwareTelegramCommand(update.message?.text);
  if (command && update.message?.chat.id) {
    const ok = command === 'software'
      ? await sendSoftwareMenu(update.message.chat.id, env)
      : await sendGamesMenu(update.message.chat.id, env);
    return Response.json({ ok }, { status: ok ? 200 : 502 });
  }

  const callback = String(update.callback_query?.data || '');
  const callbackChatId = update.callback_query?.message?.chat.id;
  if (callbackChatId && (callback === 'software:menu' || callback === 'games:menu')) {
    if (update.callback_query?.id) {
      await telegramRequest('answerCallbackQuery', { callback_query_id: update.callback_query.id }, env);
    }
    const ok = callback === 'software:menu'
      ? await sendSoftwareMenu(callbackChatId, env)
      : await sendGamesMenu(callbackChatId, env);
    return Response.json({ ok }, { status: ok ? 200 : 502 });
  }

  return null;
}
