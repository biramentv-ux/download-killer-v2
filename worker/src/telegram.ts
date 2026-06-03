import { fetchDownloaderWithFailover } from './origins';
import { hashAndCachePrivateUrl, verifyTelegramWebhookToken } from './security';
import type { AudioFormat, AudioQuality, DownloadJob, DownloaderDownloadResult, Env } from './types';
import {
  createDownloadToken,
  createJobFingerprint,
  detectSourceFromUrl,
  normalizeSource,
  rateLimit,
  readEnvInt,
  validateDownloadUrlPolicy,
  validateUrlPolicy,
} from './utils';

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
  my_chat_member?: TelegramChatMemberUpdate;
  callback_query?: TelegramCallbackQuery;
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
  from?: { id: number; first_name?: string; username?: string };
  text?: string;
  sender_chat?: TelegramChat;
  forward_from_chat?: TelegramChat;
  forward_origin?: {
    type?: string;
    chat?: TelegramChat;
    message_id?: number;
    date?: number;
  };
}

interface TelegramChatMemberUpdate {
  chat: TelegramChat;
  from?: { id: number; first_name?: string; username?: string };
  date?: number;
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number; first_name?: string };
  message?: TelegramMessage;
  data?: string;
}

interface TelegramRequestResult {
  ok: boolean;
  description?: string;
  result?: { message_id?: number };
}

interface TelegramChannelPublishResult {
  ok: boolean;
  method?: 'sendAudio' | 'sendDocument' | 'sendMessage' | 'skipped';
  channelId?: string;
  description?: string;
}

interface TelegramChannelPublishRecord {
  status?: string | null;
  method?: string | null;
  channel_id?: string | null;
  attempts?: number | null;
}

interface SearchResultPayload {
  title: string;
  artist: string;
  url: string;
  duration?: number;
  source: string;
}

interface CachedPickerResult {
  url: string;
  title: string;
  artist: string;
  source: string;
  archive: boolean;
  botUsername?: string | null;
}

interface TelegramSettings {
  defaultFormat: AudioFormat;
  defaultQuality: AudioQuality;
  defaultSource: string;
  preferArchive: boolean;
  language: BotLanguage;
  searchResultView: SearchResultView;
  audioQualityTier: AudioQualityTier;
  trackCoverImage: boolean;
  albumCoverImage: boolean;
  trackCaptionStyle: CaptionStyle;
  albumCaptionStyle: CaptionStyle;
  archiveUploads: boolean;
  useDirectLinks: boolean;
  spekZipForTracks: boolean;
  albumLinkPreview: boolean;
  showQualityInfoInCaptions: boolean;
  playlistTrackNumbers: boolean;
  playlistNameAsAlbum: boolean;
  fileNameTemplate: string;
  codecConversion: CodecConversionSettings;
  perServiceQuality: Record<string, string>;
  channelAutoPublish: boolean;
}

interface ArchiveRecord {
  normalized_url: string;
  source_url: string;
  source: string;
  title: string | null;
  artist: string | null;
  bot_username: string | null;
}

interface CompletedFingerprintJob {
  id: string;
  title: string | null;
  artist: string | null;
  duration: number | null;
  file_size: number | null;
}

interface CompletedTelegramChannelJobRow {
  id: string;
  url: string | null;
  source: string | null;
  format: AudioFormat;
  quality: AudioQuality;
  fingerprint: string | null;
  chat_id: number | null;
  message_id: number | null;
  sync_key: string | null;
  created_at: string | null;
  title: string | null;
  artist: string | null;
  duration: number | null;
  file_size: number | null;
  result_url: string | null;
}

const SUPPORTED_FORMATS: AudioFormat[] = ['mp3', 'flac', 'ogg', 'm4a', 'opus', 'wav'];
const LOSSLESS_FORMATS: AudioFormat[] = ['flac', 'wav'];
const LOSSLESS_QUALITIES: AudioQuality[] = ['lossless', 'best'];
const LOSSY_QUALITIES: AudioQuality[] = ['best', '320', '256', '192', '128', '96'];
const SUPPORTED_SOURCES = ['all', 'spotify', 'youtube', 'soundcloud', 'deezer', 'apple', 'podcast'];
type BotLanguage = 'bg' | 'en' | 'es' | 'ru' | 'de';
type SearchResultView = 'message' | 'buttons';
type AudioQualityTier = 'low' | 'high' | 'lossless' | 'hifi';
type CaptionStyle = 'none' | 'default' | 'detailed' | 'simple' | 'custom';

interface CodecConversionSettings {
  aacInM4a: string;
  alacInM4a: string;
  flac: string;
}

const BOT_LANGUAGES: BotLanguage[] = ['bg', 'en', 'es', 'ru', 'de'];
const SEARCH_RESULT_VIEWS: SearchResultView[] = ['message', 'buttons'];
const AUDIO_QUALITY_TIERS: AudioQualityTier[] = ['low', 'high', 'lossless', 'hifi'];
const CAPTION_STYLES: CaptionStyle[] = ['none', 'default', 'detailed', 'simple', 'custom'];
const SERVICE_KEYS = ['amazon', 'apple', 'beatport', 'deezer', 'kkbox', 'qobuz', 'tidal'] as const;
const SERVICE_QUALITY_PRESETS = ['mp3_320', 'aac_256', 'flac_cd', 'flac_hires', 'flac_24b', 'alac_hires'] as const;
const TELEGRAM_CHANNEL_PUBLISH_BACKFILL_LIMIT = 25;

let telegramChannelPublishSchemaReady: Promise<void> | null = null;

const DEFAULT_CODEC_CONVERSION: CodecConversionSettings = {
  aacInM4a: 'original',
  alacInM4a: 'original',
  flac: 'original',
};

const DEFAULT_PER_SERVICE_QUALITY: Record<string, string> = {
  amazon: 'flac_hires',
  apple: 'alac_hires',
  beatport: 'flac_cd',
  deezer: 'flac_cd',
  kkbox: 'flac_24b',
  qobuz: 'flac_hires',
  tidal: 'flac_hires',
};

const DEFAULT_SETTINGS: TelegramSettings = {
  defaultFormat: 'mp3',
  defaultQuality: '320',
  defaultSource: 'all',
  preferArchive: true,
  language: 'bg',
  searchResultView: 'message',
  audioQualityTier: 'hifi',
  trackCoverImage: true,
  albumCoverImage: true,
  trackCaptionStyle: 'detailed',
  albumCaptionStyle: 'detailed',
  archiveUploads: false,
  useDirectLinks: true,
  spekZipForTracks: true,
  albumLinkPreview: true,
  showQualityInfoInCaptions: true,
  playlistTrackNumbers: false,
  playlistNameAsAlbum: false,
  fileNameTemplate: '{artist} - {title}',
  codecConversion: DEFAULT_CODEC_CONVERSION,
  perServiceQuality: DEFAULT_PER_SERVICE_QUALITY,
  channelAutoPublish: true,
};

const MENU_LABELS = {
  search: '🎵 Търсене',
  settings: '⚙️ Настройки',
  archive: '📦 Архив',
  miniApp: '📱 Mini App',
  help: 'ℹ️ Помощ',
};

export async function handleTelegramUpdate(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token')?.trim();
  if (!await verifyTelegramWebhookToken(secret ?? null, env)) {
    return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized', retryable: false } }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json<TelegramUpdate>();
  } catch {
    return Response.json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON', retryable: false } }, { status: 400 });
  }

  try {
    await captureTelegramChannelBinding(update, env);
    if (update.message) {
      await handleMessage(update.message, env);
    } else if (update.channel_post) {
      await handleChannelPost(update.channel_post, env);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
    }
  } catch (error) {
    console.error('Telegram update failed', error);
  }

  return Response.json({ ok: true });
}

async function captureTelegramChannelBinding(update: TelegramUpdate, env: Env): Promise<void> {
  const chat = getChannelChatFromUpdate(update);
  if (!chat || chat.type !== 'channel') return;
  await storeTelegramDownloadChannel(chat, env);
}

async function storeTelegramDownloadChannel(chat: TelegramChat, env: Env): Promise<void> {
  const configured = normalizeTelegramChannelTarget(env.TELEGRAM_DOWNLOAD_CHANNEL_ID);
  const channelId = configured || String(chat.id);
  await env.CACHE.put('tg:download_channel_id', channelId);
  if (chat.username) {
    await env.CACHE.put('tg:download_channel_username', `@${chat.username}`);
  }
  if (chat.title) {
    await env.CACHE.put('tg:download_channel_title', chat.title);
  }
  await env.CACHE.put('tg:download_channel_bound_at', new Date().toISOString());
}

function getChannelChatFromUpdate(update: TelegramUpdate): TelegramChat | null {
  if (update.channel_post?.chat?.type === 'channel') return update.channel_post.chat;
  if (update.my_chat_member?.chat?.type === 'channel') return update.my_chat_member.chat;
  return update.message ? getChannelChatFromMessage(update.message) : null;
}

function getChannelChatFromMessage(msg: TelegramMessage): TelegramChat | null {
  if (msg.chat?.type === 'channel') return msg.chat;
  if (msg.sender_chat?.type === 'channel') return msg.sender_chat;
  if (msg.forward_from_chat?.type === 'channel') return msg.forward_from_chat;
  if (msg.forward_origin?.type === 'channel' && msg.forward_origin.chat?.type === 'channel') return msg.forward_origin.chat;
  return null;
}

async function handleChannelPost(msg: TelegramMessage, env: Env): Promise<void> {
  if (msg.chat.type !== 'channel') return;
  await storeTelegramDownloadChannel(msg.chat, env);
}

async function handleMessage(msg: TelegramMessage, env: Env): Promise<void> {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? '';

  const rl = await rateLimit(env.CACHE, `tgmsg:${chatId}`, 25, 60);
  if (rl.limited) {
    await sendMessage(chatId, env, '\u041f\u0440\u0435\u043a\u0430\u043b\u0435\u043d\u043e \u043c\u043d\u043e\u0433\u043e \u0437\u0430\u044f\u0432\u043a\u0438. \u0418\u0437\u0447\u0430\u043a\u0430\u0439 1 \u043c\u0438\u043d\u0443\u0442\u0430 \u0438 \u043e\u043f\u0438\u0442\u0430\u0439 \u043e\u0442\u043d\u043e\u0432\u043e.');
    return;
  }

  await ensureTelegramCommands(env);

  const forwardedChannel = getChannelChatFromMessage(msg);
  if (forwardedChannel && msg.chat.type !== 'channel' && !isBotCommand(text)) {
    await storeTelegramDownloadChannel(forwardedChannel, env);
    await sendChannelStatusPanel(chatId, env, '\u2705 \u041a\u0430\u043d\u0430\u043b\u044a\u0442 \u0435 \u0437\u0430\u0441\u0435\u0447\u0435\u043d \u043e\u0442 \u043f\u0440\u0435\u043f\u0440\u0430\u0442\u0435\u043d\u043e \u0441\u044a\u043e\u0431\u0449\u0435\u043d\u0438\u0435.');
    return;
  }

  if (!text) return;

  const lowered = text.toLowerCase();

  if (isStartCommand(text) || lowered === '/menu') {
    await sendWelcomeMenu(chatId, env);
    return;
  }

  if (isHelpCommand(text) || text === MENU_LABELS.help) {
    await sendHelp(chatId, env);
    return;
  }

  if (isSettingsCommand(text) || text === MENU_LABELS.settings) {
    await sendSettingsPanel(chatId, env);
    return;
  }

  if (isArchiveCommand(text) || text === MENU_LABELS.archive) {
    await sendArchivePanel(chatId, env);
    return;
  }

  if (isChannelCommand(text)) {
    await sendChannelStatusPanel(chatId, env);
    return;
  }

  if (text === MENU_LABELS.search) {
    await sendMessage(chatId, env, 'Изпрати име на песен или URL линк.');
    return;
  }

  if (text === MENU_LABELS.miniApp) {
    await sendMiniAppLink(chatId, env);
    return;
  }

  if (isUrl(text)) {
    await handleUrlInput(chatId, text, env, msg.message_id);
    return;
  }

  if (text.length >= 2) {
    await searchAndPresent(chatId, text, env);
    return;
  }

  await sendMessage(chatId, env, 'Изпрати URL или напиши име на песен.');
}

async function handleUrlInput(chatId: number, inputUrl: string, env: Env, replyToMessageId?: number): Promise<void> {
  const policy = validateUrlPolicy(inputUrl, env);
  if (!policy.allowed) {
    await sendMessage(chatId, env, `URL е блокиран: ${policy.message ?? 'domain policy'}`, replyToMessageId ? { reply_to_message_id: replyToMessageId } : undefined);
    return;
  }
  const settings = await getTelegramSettings(chatId, env);
  const archiveMatch = settings.preferArchive ? await lookupArchiveByExactUrl(inputUrl, env) : null;
  if (archiveMatch) {
    await sendMessage(
      chatId,
      env,
      `📦 Намерен запис в архива:\n${formatArchiveMeta(archiveMatch)}\n\nИзбери формат или използвай бързо сваляне.`,
      replyToMessageId ? { reply_to_message_id: replyToMessageId } : undefined,
    );
  }

  await presentFormatPicker(chatId, inputUrl, env, settings, replyToMessageId);
}

async function searchAndPresent(chatId: number, query: string, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  const loading = await sendMessage(chatId, env, `Търся: ${query}`);
  const loadingId = loading.result?.message_id;
  if (!loadingId) return;

  try {
    const combinedResults: CachedPickerResult[] = [];
    const seen = new Set<string>();

    if (settings.preferArchive) {
      const archiveRows = await lookupArchiveByQuery(query, 6, env);
      for (const row of archiveRows) {
        const normalizedUrl = normalizeArchiveUrl(row.source_url);
        if (!normalizedUrl || seen.has(normalizedUrl)) continue;
        seen.add(normalizedUrl);
        combinedResults.push({
          url: row.source_url,
          title: row.title?.trim() || 'Архивен запис',
          artist: row.artist?.trim() || 'Неизвестен изпълнител',
          source: normalizeSourceValue(row.source || detectSourceFromUrl(row.source_url)),
          archive: true,
          botUsername: row.bot_username,
        });
      }
    }

    try {
      const failover = await fetchDownloaderWithFailover(env, '/internal/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': env.DOWNLOADER_API_KEY,
        },
        body: JSON.stringify({ query, source: settings.defaultSource, limit: 8 }),
      });
      const payload = await failover.response.json() as { results?: SearchResultPayload[] } | SearchResultPayload[];
      const onlineResults = Array.isArray(payload) ? payload : (payload.results ?? []);
      for (const row of onlineResults) {
        if (!row?.url) continue;
        const normalizedUrl = normalizeArchiveUrl(row.url);
        if (!normalizedUrl || seen.has(normalizedUrl)) continue;
        seen.add(normalizedUrl);
        combinedResults.push({
          url: row.url,
          title: row.title || 'Без заглавие',
          artist: row.artist || 'Неизвестен изпълнител',
          source: normalizeSourceValue(row.source || detectSourceFromUrl(row.url)),
          archive: false,
          botUsername: null,
        });
      }
    } catch (error) {
      console.warn('Telegram online search skipped', error);
    }

    if (!combinedResults.length) {
      await editOrSend(chatId, loadingId, env, 'Няма намерени резултати. Опитай с друг текст или URL.');
      return;
    }

    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const result of combinedResults.slice(0, 10)) {
      const key = shortHash(`${result.url}|${result.title}|${result.artist}|${result.source}|${result.archive ? 'a' : 'n'}`);
      await env.CACHE.put(`tg:result:${key}`, JSON.stringify(result), { expirationTtl: 7200 });
      await env.CACHE.put(`tg:url:${key}`, result.url, { expirationTtl: 7200 });
      const prefix = result.archive ? '📦 ' : '';
      keyboard.push([{
        text: `${prefix}${truncate(`${result.artist} - ${result.title}`, 58)}`,
        callback_data: `search_pick:${key}`,
      }]);
    }
    keyboard.push([{ text: '⚙️ Настройки', callback_data: 's:open' }]);
    keyboard.push([{ text: 'Отказ', callback_data: 'cancel' }]);

    const chooserText = settings.searchResultView === 'message'
      ? [
        'Избери песен:',
        '',
        ...combinedResults.slice(0, 10).map((result, index) => {
          const prefix = result.archive ? '📦 ' : '';
          return `${index + 1}. ${prefix}${result.artist} - ${result.title} (${sourceLabel(result.source)})`;
        }),
      ].join('\n')
      : 'Избери песен:';

    await editOrSend(chatId, loadingId, env, chooserText, {
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (error) {
    console.error('Telegram search error', error);
    await editOrSend(chatId, loadingId, env, 'Грешка при търсене. Опитай отново.');
  }
}

async function presentFormatPicker(
  chatId: number,
  url: string,
  env: Env,
  settings: TelegramSettings,
  replyToMessageId?: number,
): Promise<void> {
  const urlKey = shortHash(url);
  await env.CACHE.put(`tg:url:${urlKey}`, url, { expirationTtl: 7200 });

  await sendMessage(chatId, env, 'Избери формат за сваляне:', {
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    reply_markup: {
      inline_keyboard: formatKeyboard(urlKey, settings),
    },
  });
}

function formatKeyboard(key: string, settings?: TelegramSettings): Array<Array<{ text: string; callback_data: string }>> {
  const quickLabel = settings
    ? `🚀 Бързо (${settings.defaultFormat.toUpperCase()} ${settings.defaultQuality})`
    : '🚀 Бързо';
  return [
    [
      { text: 'MP3', callback_data: `fmt:${key}:mp3` },
      { text: 'M4A', callback_data: `fmt:${key}:m4a` },
      { text: 'OGG', callback_data: `fmt:${key}:ogg` },
    ],
    [
      { text: 'OPUS', callback_data: `fmt:${key}:opus` },
      { text: 'FLAC', callback_data: `fmt:${key}:flac` },
      { text: 'WAV', callback_data: `fmt:${key}:wav` },
    ],
    [{ text: quickLabel, callback_data: `qdef:${key}` }],
    [
      { text: '⚙️ Настройки', callback_data: 's:open' },
      { text: 'Отказ', callback_data: 'cancel' },
    ],
  ];
}

function buildQualityKeyboard(key: string, format: AudioFormat): Array<Array<{ text: string; callback_data: string }>> {
  if (LOSSLESS_FORMATS.includes(format)) {
    return [
      [
        { text: 'Lossless', callback_data: `dl:${key}:${format}:lossless` },
        { text: 'Best', callback_data: `dl:${key}:${format}:best` },
      ],
      [
        { text: '⬅️ Назад', callback_data: `back_fmt:${key}` },
        { text: 'Отказ', callback_data: 'cancel' },
      ],
    ];
  }

  return [
    [
      { text: 'Best', callback_data: `dl:${key}:${format}:best` },
      { text: '320', callback_data: `dl:${key}:${format}:320` },
      { text: '256', callback_data: `dl:${key}:${format}:256` },
    ],
    [
      { text: '192', callback_data: `dl:${key}:${format}:192` },
      { text: '128', callback_data: `dl:${key}:${format}:128` },
      { text: '96', callback_data: `dl:${key}:${format}:96` },
    ],
    [
      { text: '⬅️ Назад', callback_data: `back_fmt:${key}` },
      { text: 'Отказ', callback_data: 'cancel' },
    ],
  ];
}

async function handleCallbackQuery(cb: TelegramCallbackQuery, env: Env): Promise<void> {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const data = cb.data ?? '';

  await answerCallback(cb.id, env, callbackNotice(data));
  if (!chatId || !messageId) return;

  const rl = await rateLimit(env.CACHE, `tgcb:${chatId}`, 80, 60);
  if (rl.limited) {
    await editOrSend(chatId, messageId, env, 'Прекалено много действия. Изчакай 1 минута.');
    return;
  }

  if (data === 'cancel') {
    await editOrSend(chatId, messageId, env, 'Операцията е отменена.');
    return;
  }

  if (data === 'arc:open') {
    await editArchivePanel(chatId, messageId, env);
    return;
  }

  if (data === 's:open') {
    await editSettingsPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:fmt') {
    await editSettingsFormatPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:q') {
    await editSettingsQualityPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:src') {
    await editSettingsSourcePanel(chatId, messageId, env);
    return;
  }

  if (data === 's:general') {
    await editSettingsGeneralPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:view') {
    await editSettingsSearchViewPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:lang') {
    await editSettingsLanguagePanel(chatId, messageId, env);
    return;
  }

  if (data === 's:tier') {
    await editSettingsAudioTierPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:svcq') {
    await editSettingsServiceQualityPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:downloads') {
    await editSettingsDownloadsPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:captions') {
    await editSettingsCaptionsPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:tcaption') {
    await editSettingsTrackCaptionPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:acaption') {
    await editSettingsAlbumCaptionPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:codec') {
    await editSettingsCodecPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:file') {
    await editSettingsFileNamingPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:channel') {
    await editSettingsChannelPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:channel:test') {
    await sendTelegramChannelTest(chatId, messageId, env);
    return;
  }

  if (data === 's:arc') {
    const settings = await getTelegramSettings(chatId, env);
    settings.preferArchive = !settings.preferArchive;
    await saveTelegramSettings(chatId, settings, env);
    await editSettingsPanel(chatId, messageId, env);
    return;
  }

  if (data === 's:back') {
    await editSettingsPanel(chatId, messageId, env);
    return;
  }

  if (data.startsWith('s:setlang:')) {
    const language = normalizeBotLanguage(data.replace('s:setlang:', ''));
    const settings = await getTelegramSettings(chatId, env);
    settings.language = language;
    await saveTelegramSettings(chatId, settings, env);
    await editSettingsGeneralPanel(chatId, messageId, env);
    return;
  }

  if (data.startsWith('s:setview:')) {
    const view = normalizeSearchResultView(data.replace('s:setview:', ''));
    const settings = await getTelegramSettings(chatId, env);
    settings.searchResultView = view;
    await saveTelegramSettings(chatId, settings, env);
    await editSettingsGeneralPanel(chatId, messageId, env);
    return;
  }

  if (data.startsWith('s:settier:')) {
    const tier = normalizeAudioQualityTier(data.replace('s:settier:', ''));
    const settings = await getTelegramSettings(chatId, env);
    settings.audioQualityTier = tier;
    if ((tier === 'lossless' || tier === 'hifi') && !LOSSLESS_FORMATS.includes(settings.defaultFormat)) {
      settings.defaultFormat = 'flac';
    }
    if (tier === 'low' && LOSSLESS_FORMATS.includes(settings.defaultFormat)) {
      settings.defaultFormat = 'mp3';
    }
    const mapped = qualityFromTier(tier, settings.defaultFormat);
    settings.defaultQuality = mapped;
    await saveTelegramSettings(chatId, settings, env);
    await editSettingsAudioTierPanel(chatId, messageId, env);
    return;
  }

  if (data.startsWith('s:setfmt:')) {
    const format = data.replace('s:setfmt:', '') as AudioFormat;
    if (SUPPORTED_FORMATS.includes(format)) {
      const settings = await getTelegramSettings(chatId, env);
      settings.defaultFormat = format;
      if (LOSSLESS_FORMATS.includes(format) && !LOSSLESS_QUALITIES.includes(settings.defaultQuality)) settings.defaultQuality = 'lossless';
      if (!LOSSLESS_FORMATS.includes(format) && settings.defaultQuality === 'lossless') settings.defaultQuality = '320';
      await saveTelegramSettings(chatId, settings, env);
    }
    await editSettingsFormatPanel(chatId, messageId, env);
    return;
  }

  if (data.startsWith('s:setq:')) {
    const quality = data.replace('s:setq:', '') as AudioQuality;
    const settings = await getTelegramSettings(chatId, env);
    if (isValidQualityForFormat(settings.defaultFormat, quality)) {
      settings.defaultQuality = quality;
      await saveTelegramSettings(chatId, settings, env);
    }
    await editSettingsQualityPanel(chatId, messageId, env);
    return;
  }

  if (data.startsWith('s:tog:')) {
    const key = data.replace('s:tog:', '');
    const settings = await getTelegramSettings(chatId, env);
    toggleTelegramSetting(settings, key);
    await saveTelegramSettings(chatId, settings, env);
    await editSettingsPanelForToggle(chatId, messageId, env, key);
    return;
  }

  if (data.startsWith('s:tcap:')) {
    const style = normalizeCaptionStyle(data.replace('s:tcap:', ''));
    const settings = await getTelegramSettings(chatId, env);
    settings.trackCaptionStyle = style;
    await saveTelegramSettings(chatId, settings, env);
    await editSettingsTrackCaptionPanel(chatId, messageId, env);
    return;
  }

  if (data.startsWith('s:acap:')) {
    const style = normalizeCaptionStyle(data.replace('s:acap:', ''));
    const settings = await getTelegramSettings(chatId, env);
    settings.albumCaptionStyle = style;
    await saveTelegramSettings(chatId, settings, env);
    await editSettingsAlbumCaptionPanel(chatId, messageId, env);
    return;
  }

  if (data.startsWith('s:svcq:')) {
    const [, , service, preset] = data.split(':');
    if (service && preset && SERVICE_KEYS.includes(service as typeof SERVICE_KEYS[number])) {
      const settings = await getTelegramSettings(chatId, env);
      settings.perServiceQuality = {
        ...settings.perServiceQuality,
        [service]: normalizeServiceQualityPreset(preset),
      };
      await saveTelegramSettings(chatId, settings, env);
    }
    await editSettingsServiceQualityPanel(chatId, messageId, env);
    return;
  }

  if (data.startsWith('s:codec:')) {
    const [, , codecKey, value] = data.split(':');
    const settings = await getTelegramSettings(chatId, env);
    if (codecKey === 'aac' || codecKey === 'alac' || codecKey === 'flac') {
      settings.codecConversion = {
        ...settings.codecConversion,
        ...(codecKey === 'aac' ? { aacInM4a: normalizeCodecConversion(value) } : {}),
        ...(codecKey === 'alac' ? { alacInM4a: normalizeCodecConversion(value) } : {}),
        ...(codecKey === 'flac' ? { flac: normalizeCodecConversion(value) } : {}),
      };
      await saveTelegramSettings(chatId, settings, env);
    }
    await editSettingsCodecPanel(chatId, messageId, env);
    return;
  }

  if (data.startsWith('s:setsrc:')) {
    const source = normalizeSourceValue(data.replace('s:setsrc:', ''));
    if (SUPPORTED_SOURCES.includes(source)) {
      const settings = await getTelegramSettings(chatId, env);
      settings.defaultSource = source;
      await saveTelegramSettings(chatId, settings, env);
    }
    await editSettingsPanel(chatId, messageId, env);
    return;
  }

  if (data.startsWith('search_pick:')) {
    const key = data.replace('search_pick:', '');
    const cached = await env.CACHE.get(`tg:result:${key}`, { type: 'json' }) as CachedPickerResult | null;
    if (!cached?.url) {
      await editOrSend(chatId, messageId, env, 'Сесията е изтекла. Потърси отново.');
      return;
    }

    await env.CACHE.put(`tg:url:${key}`, cached.url, { expirationTtl: 7200 });
    const archiveSuffix = cached.archive ? '\n📦 Резултат от архив.' : '';
    const settings = await getTelegramSettings(chatId, env);
    await editOrSend(chatId, messageId, env, `Избрано: ${cached.artist} - ${cached.title}${archiveSuffix}\nИзбери формат:`, {
      reply_markup: { inline_keyboard: formatKeyboard(key, settings) },
    });
    return;
  }

  if (data.startsWith('qdef:')) {
    const key = data.replace('qdef:', '');
    const url = await env.CACHE.get(`tg:url:${key}`);
    if (!url) {
      await editOrSend(chatId, messageId, env, 'Сесията е изтекла. Изпрати URL отново.');
      return;
    }
    const settings = await getTelegramSettings(chatId, env);
    await queueJobFromSelection(chatId, messageId, key, url, settings.defaultFormat, settings.defaultQuality, env);
    return;
  }

  if (data.startsWith('fmt:')) {
    const [, key, formatValue] = data.split(':');
    const format = formatValue as AudioFormat | undefined;
    if (!key || !format || !SUPPORTED_FORMATS.includes(format)) {
      await editOrSend(chatId, messageId, env, 'Неподдържан формат.');
      return;
    }

    await editOrSend(chatId, messageId, env, `Формат: ${format.toUpperCase()}\nИзбери качество:`, {
      reply_markup: { inline_keyboard: buildQualityKeyboard(key, format) },
    });
    return;
  }

  if (data.startsWith('back_fmt:')) {
    const key = data.replace('back_fmt:', '');
    const settings = await getTelegramSettings(chatId, env);
    await editOrSend(chatId, messageId, env, 'Избери формат:', {
      reply_markup: { inline_keyboard: formatKeyboard(key, settings) },
    });
    return;
  }

  if (data.startsWith('dl:')) {
    const [, key, formatValue, qualityValue] = data.split(':');
    const format = formatValue as AudioFormat | undefined;
    const quality = qualityValue as AudioQuality | undefined;
    if (!key || !format || !quality || !SUPPORTED_FORMATS.includes(format) || !isValidQualityForFormat(format, quality)) {
      await editOrSend(chatId, messageId, env, 'Невалиден избор за качество.');
      return;
    }

    const url = await env.CACHE.get(`tg:url:${key}`);
    if (!url) {
      await editOrSend(chatId, messageId, env, 'Сесията е изтекла. Изпрати URL отново.');
      return;
    }

    await queueJobFromSelection(chatId, messageId, key, url, format, quality, env);
  }
}

async function queueJobFromSelection(
  chatId: number,
  messageId: number,
  cacheKey: string,
  url: string,
  format: AudioFormat,
  quality: AudioQuality,
  env: Env,
): Promise<void> {
  const policy = validateDownloadUrlPolicy(url, env);
  if (!policy.allowed) {
    await editOrSend(chatId, messageId, env, `URL е блокиран: ${policy.message ?? 'domain policy'}`);
    return;
  }
  const cached = await env.CACHE.get(`tg:result:${cacheKey}`, { type: 'json' }) as CachedPickerResult | null;
  const source = normalizeSourceValue(cached?.source || detectSourceFromUrl(url));
  const fingerprint = await createJobFingerprint(url, format, quality);
  const syncKey = telegramSyncKey(chatId);
  const existing = await findCompletedJobByFingerprint(fingerprint, env);

  if (existing) {
    await hashAndCachePrivateUrl(env, 'job', existing.id, url);
    await env.DB.prepare(
      `UPDATE download_jobs
       SET sync_key = COALESCE(sync_key, ?),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).bind(syncKey, existing.id).run();
    const ttl = readEnvInt(env.DOWNLOAD_TOKEN_TTL_SECONDS, 3600);
    const token = await createDownloadToken(
      {
        jobId: existing.id,
        exp: Math.floor(Date.now() / 1000) + ttl,
      },
      env.DOWNLOAD_TOKEN_SECRET,
    );
    const link = `${getPublicBaseUrl(env)}/api/file/${encodeURIComponent(token)}`;
    const readyArtist = existing.artist?.trim() || cached?.artist || 'Неизвестен изпълнител';
    const readyTitle = existing.title?.trim() || cached?.title || 'Готов файл';
    const readyDuration = formatDuration(existing.duration ?? 0);
    const readySize = formatFileSize(existing.file_size ?? 0);
    await editOrSend(
      chatId,
      messageId,
      env,
      `📦 Намерен готов запис в кеша\n${readyArtist} - ${readyTitle}\n${readyDuration} | ${readySize}\n${link}`,
      downloadLinkMarkup(link),
    );
    const sent = await sendAudio(chatId, link, readyTitle, readyArtist, existing.duration ?? 0, env);
    if (!sent.ok) {
      await sendMessage(chatId, env, `Ако audio файлът не се отвори директно, използвай линка:\n${link}`);
    }

    await publishTelegramChannelDownload(
      {
        id: existing.id,
        url,
        source,
        format,
        quality,
        fingerprint,
        syncKey,
        chatId,
        messageId,
        requestedAt: new Date().toISOString(),
      },
      {
        download_url: link,
        title: readyTitle,
        artist: readyArtist,
        duration: existing.duration ?? 0,
        file_size: existing.file_size ?? 0,
        source,
      },
      env,
    );
    return;
  }

  const jobId = crypto.randomUUID();
  const title = cached?.title?.trim() || null;
  const artist = cached?.artist?.trim() || null;
  const urlHash = await hashAndCachePrivateUrl(env, 'job', jobId, url);

  await env.DB.prepare(
    `INSERT INTO download_jobs (
      id, url, source, format, quality, status, attempts, fingerprint, chat_id, message_id, sync_key, title, artist, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(jobId, urlHash, source, format, quality, fingerprint, chatId, messageId, syncKey, title, artist).run();

  const job: DownloadJob = {
    id: jobId,
    url,
    source,
    format,
    quality,
    fingerprint,
    syncKey,
    chatId,
    messageId,
    requestedAt: new Date().toISOString(),
  };

  await env.DOWNLOAD_QUEUE.send(job);
  await editOrSend(
    chatId,
    messageId,
    env,
    `✅ Добавено в опашката\nЗадача: ${jobId.slice(0, 8)}\nФормат: ${format.toUpperCase()} ${quality}\nЩе ти изпратя линк, когато файлът е готов.`,
  );
}

async function getTelegramSettings(chatId: number, env: Env): Promise<TelegramSettings> {
  const raw = await env.CACHE.get(`tg:settings:${chatId}`, { type: 'json' }) as Partial<TelegramSettings> | null;
  const merged: TelegramSettings = {
    defaultFormat: normalizeFormat(raw?.defaultFormat),
    defaultQuality: normalizeQuality(raw?.defaultQuality),
    defaultSource: normalizeSourceValue(raw?.defaultSource),
    preferArchive: typeof raw?.preferArchive === 'boolean' ? raw.preferArchive : DEFAULT_SETTINGS.preferArchive,
    language: normalizeBotLanguage(raw?.language),
    searchResultView: normalizeSearchResultView(raw?.searchResultView),
    audioQualityTier: normalizeAudioQualityTier(raw?.audioQualityTier),
    trackCoverImage: boolSetting(raw?.trackCoverImage, DEFAULT_SETTINGS.trackCoverImage),
    albumCoverImage: boolSetting(raw?.albumCoverImage, DEFAULT_SETTINGS.albumCoverImage),
    trackCaptionStyle: normalizeCaptionStyle(raw?.trackCaptionStyle),
    albumCaptionStyle: normalizeCaptionStyle(raw?.albumCaptionStyle),
    archiveUploads: boolSetting(raw?.archiveUploads, DEFAULT_SETTINGS.archiveUploads),
    useDirectLinks: boolSetting(raw?.useDirectLinks, DEFAULT_SETTINGS.useDirectLinks),
    spekZipForTracks: boolSetting(raw?.spekZipForTracks, DEFAULT_SETTINGS.spekZipForTracks),
    albumLinkPreview: boolSetting(raw?.albumLinkPreview, DEFAULT_SETTINGS.albumLinkPreview),
    showQualityInfoInCaptions: boolSetting(raw?.showQualityInfoInCaptions, DEFAULT_SETTINGS.showQualityInfoInCaptions),
    playlistTrackNumbers: boolSetting(raw?.playlistTrackNumbers, DEFAULT_SETTINGS.playlistTrackNumbers),
    playlistNameAsAlbum: boolSetting(raw?.playlistNameAsAlbum, DEFAULT_SETTINGS.playlistNameAsAlbum),
    fileNameTemplate: typeof raw?.fileNameTemplate === 'string' && raw.fileNameTemplate.trim()
      ? raw.fileNameTemplate.trim().slice(0, 120)
      : DEFAULT_SETTINGS.fileNameTemplate,
    codecConversion: normalizeCodecConversionSettings(raw?.codecConversion),
    perServiceQuality: normalizePerServiceQuality(raw?.perServiceQuality),
    channelAutoPublish: boolSetting(raw?.channelAutoPublish, DEFAULT_SETTINGS.channelAutoPublish),
  };

  const synced = await getTelegramSyncedPreferences(chatId, env);
  if (synced.language) merged.language = normalizeBotLanguage(synced.language);
  if (synced.source) merged.defaultSource = normalizeSourceValue(synced.source);
  if (synced.format) merged.defaultFormat = normalizeFormat(synced.format);
  if (synced.quality) merged.defaultQuality = normalizeQuality(synced.quality);
  if (synced.searchResultView) merged.searchResultView = normalizeSearchResultView(synced.searchResultView);
  if (synced.audioQualityTier) merged.audioQualityTier = normalizeAudioQualityTier(synced.audioQualityTier);

  if (!isValidQualityForFormat(merged.defaultFormat, merged.defaultQuality)) {
    merged.defaultQuality = LOSSLESS_FORMATS.includes(merged.defaultFormat) ? 'lossless' : '320';
  }
  return merged;
}

async function saveTelegramSettings(chatId: number, settings: TelegramSettings, env: Env): Promise<void> {
  await env.CACHE.put(`tg:settings:${chatId}`, JSON.stringify(settings), { expirationTtl: 31536000 });
  await saveTelegramSyncedPreferences(chatId, settings, env);
}

function settingsText(settings: TelegramSettings): string {
  return [
    '⚙️ Настройки DyrakArmy',
    '',
    `🌐 Език: ${languageLabel(settings.language)}`,
    `🔎 Търсене: ${sourceLabel(settings.defaultSource)} / ${searchResultViewLabel(settings.searchResultView)}`,
    `🎧 Формат: ${settings.defaultFormat.toUpperCase()} ${settings.defaultQuality}`,
    `💿 Аудио профил: ${audioTierLabel(settings.audioQualityTier)}`,
    `📦 Архив приоритет: ${settings.preferArchive ? 'ВКЛ' : 'ИЗКЛ'}`,
    `📣 Канал: ${settings.channelAutoPublish ? 'публикуване ВКЛ' : 'публикуване ИЗКЛ'}`,
  ].join('\n');
}

function settingsMainKeyboard(chatId: number, settings: TelegramSettings, env: Env): Array<Array<Record<string, unknown>>> {
  return [
    [{ text: '🧭 General', callback_data: 's:general' }, { text: '🎧 Audio Quality', callback_data: 's:tier' }],
    [{ text: '🎚 Per-Service Quality', callback_data: 's:svcq' }],
    [{ text: '📥 Downloads', callback_data: 's:downloads' }, { text: '📝 Captions', callback_data: 's:captions' }],
    [{ text: '🔁 Codec Conversion', callback_data: 's:codec' }, { text: '📁 File Naming', callback_data: 's:file' }],
    [{ text: '📣 Telegram канал', callback_data: 's:channel' }],
    [{ text: '📱 Mini App настройки', web_app: { url: buildTelegramMiniAppUrl(chatId, env, settings.language, 'settings') } }],
    [{ text: 'Затвори', callback_data: 'cancel' }],
  ];
}

async function sendSettingsPanel(chatId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  await sendMessage(chatId, env, settingsText(settings), {
    reply_markup: {
      inline_keyboard: settingsMainKeyboard(chatId, settings, env),
    },
  });
}

async function editSettingsPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  await editOrSend(chatId, messageId, env, settingsText(settings), {
    reply_markup: { inline_keyboard: settingsMainKeyboard(chatId, settings, env) },
  });
}

async function editSettingsGeneralPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  await editOrSend(chatId, messageId, env, [
    '🧭 General',
    `Език: ${languageLabel(settings.language)}`,
    `Default Search Service: ${sourceLabel(settings.defaultSource)}`,
    `Search Result View: ${searchResultViewLabel(settings.searchResultView)}`,
  ].join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: `🌐 Language: ${languageLabel(settings.language)}`, callback_data: 's:lang' }],
        [{ text: `🔎 Default Search: ${sourceLabel(settings.defaultSource)}`, callback_data: 's:src' }],
        [{ text: `⚙️ Result View: ${searchResultViewLabel(settings.searchResultView)}`, callback_data: 's:view' }],
        [{ text: '⬅️ Назад', callback_data: 's:back' }],
      ],
    },
  });
}

async function editSettingsLanguagePanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  const keyboard = BOT_LANGUAGES.map((language) => [{
    text: `${languageLabel(language)}${language === settings.language ? ' ✅' : ''}`,
    callback_data: `s:setlang:${language}`,
  }]);
  keyboard.push([{ text: '⬅️ Назад', callback_data: 's:general' }]);
  await editOrSend(chatId, messageId, env, 'Избери език за бота и Mini App sync:', {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function editSettingsSearchViewPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  await editOrSend(chatId, messageId, env, [
    '⚙️ Search Result View',
    'Message: резултатите са в едно съобщение.',
    'Buttons: резултатите са като компактни inline бутони.',
  ].join('\n'), {
    reply_markup: {
      inline_keyboard: [
        ...SEARCH_RESULT_VIEWS.map((view) => [{
          text: `${searchResultViewLabel(view)}${view === settings.searchResultView ? ' ✅' : ''}`,
          callback_data: `s:setview:${view}`,
        }]),
        [{ text: '⬅️ Назад', callback_data: 's:general' }],
      ],
    },
  });
}

async function editSettingsFormatPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  await editOrSend(chatId, messageId, env, 'Избери формат по подразбиране:', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: formatChoiceLabel('mp3', settings.defaultFormat), callback_data: 's:setfmt:mp3' },
          { text: formatChoiceLabel('m4a', settings.defaultFormat), callback_data: 's:setfmt:m4a' },
          { text: formatChoiceLabel('ogg', settings.defaultFormat), callback_data: 's:setfmt:ogg' },
        ],
        [
          { text: formatChoiceLabel('opus', settings.defaultFormat), callback_data: 's:setfmt:opus' },
          { text: formatChoiceLabel('flac', settings.defaultFormat), callback_data: 's:setfmt:flac' },
          { text: formatChoiceLabel('wav', settings.defaultFormat), callback_data: 's:setfmt:wav' },
        ],
        [{ text: '⬅️ Назад', callback_data: 's:back' }],
      ],
    },
  });
}

async function editSettingsQualityPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  const allowed = LOSSLESS_FORMATS.includes(settings.defaultFormat) ? LOSSLESS_QUALITIES : LOSSY_QUALITIES;
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < allowed.length; i += 3) {
    keyboard.push(allowed.slice(i, i + 3).map((value) => ({
      text: qualityChoiceLabel(value, settings.defaultQuality),
      callback_data: `s:setq:${value}`,
    })));
  }
  keyboard.push([{ text: '⬅️ Назад', callback_data: 's:back' }]);

  await editOrSend(chatId, messageId, env, 'Избери качество по подразбиране:', {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function editSettingsAudioTierPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  await editOrSend(chatId, messageId, env, [
    '🎧 Audio Quality',
    `Текущ профил: ${audioTierLabel(settings.audioQualityTier)}`,
    `Формат/качество: ${settings.defaultFormat.toUpperCase()} ${settings.defaultQuality}`,
    '',
    'Low: мобилен икономичен режим.',
    'High: качествен MP3/OPUS режим.',
    'Lossless: FLAC/WAV при възможност.',
    'HiFi: максимален профил за услугата.',
  ].join('\n'), {
    reply_markup: {
      inline_keyboard: [
        AUDIO_QUALITY_TIERS.map((tier) => ({
          text: `${audioTierLabel(tier)}${tier === settings.audioQualityTier ? ' ✅' : ''}`,
          callback_data: `s:settier:${tier}`,
        })),
        [{ text: `Формат: ${settings.defaultFormat.toUpperCase()}`, callback_data: 's:fmt' }],
        [{ text: `Качество: ${settings.defaultQuality}`, callback_data: 's:q' }],
        [{ text: '⬅️ Назад', callback_data: 's:back' }],
      ],
    },
  });
}

async function editSettingsSourcePanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
    [
      { text: sourceChoiceLabel('all', settings.defaultSource), callback_data: 's:setsrc:all' },
      { text: sourceChoiceLabel('spotify', settings.defaultSource), callback_data: 's:setsrc:spotify' },
      { text: sourceChoiceLabel('youtube', settings.defaultSource), callback_data: 's:setsrc:youtube' },
    ],
    [
      { text: sourceChoiceLabel('soundcloud', settings.defaultSource), callback_data: 's:setsrc:soundcloud' },
      { text: sourceChoiceLabel('deezer', settings.defaultSource), callback_data: 's:setsrc:deezer' },
      { text: sourceChoiceLabel('apple', settings.defaultSource), callback_data: 's:setsrc:apple' },
    ],
    [
      { text: sourceChoiceLabel('podcast', settings.defaultSource), callback_data: 's:setsrc:podcast' },
    ],
    [{ text: '⬅️ Назад', callback_data: 's:back' }],
  ];

  await editOrSend(chatId, messageId, env, 'Избери източник по подразбиране за търсене:', {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function editSettingsServiceQualityPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = SERVICE_KEYS.map((service) => {
    const current = normalizeServiceQualityPreset(settings.perServiceQuality[service]);
    return [{
      text: `${serviceLabel(service)}: ${serviceQualityLabel(current)}`,
      callback_data: `s:svcq:${service}:${nextServiceQualityPreset(current)}`,
    }];
  });
  keyboard.push([{ text: '⬅️ Назад', callback_data: 's:back' }]);
  await editOrSend(chatId, messageId, env, [
    '🎚 Per-Service Quality',
    'Натискането върху ред циклира качеството за конкретната платформа.',
  ].join('\n'), {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function editSettingsDownloadsPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  await editOrSend(chatId, messageId, env, [
    '📥 Downloads',
    'Настройки за албуми, плейлисти, директни линкове и допълнителни файлове.',
  ].join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: toggleLabel('📦 Enable Archive Uploads', settings.archiveUploads), callback_data: 's:tog:archiveUploads' }],
        [{ text: toggleLabel('🔗 Use Direct Links', settings.useDirectLinks), callback_data: 's:tog:useDirectLinks' }],
        [{ text: toggleLabel('📈 Spek ZIP For Tracks', settings.spekZipForTracks), callback_data: 's:tog:spekZipForTracks' }],
        [{ text: toggleLabel('💿 Album Link Preview', settings.albumLinkPreview), callback_data: 's:tog:albumLinkPreview' }],
        [{ text: toggleLabel('ℹ️ Show Quality Info In Captions', settings.showQualityInfoInCaptions), callback_data: 's:tog:showQualityInfoInCaptions' }],
        [{ text: toggleLabel('🔢 Playlist Position Track Numbers', settings.playlistTrackNumbers), callback_data: 's:tog:playlistTrackNumbers' }],
        [{ text: toggleLabel('📁 Playlist Name As Album', settings.playlistNameAsAlbum), callback_data: 's:tog:playlistNameAsAlbum' }],
        [{ text: toggleLabel('📦 Архив приоритет при търсене', settings.preferArchive), callback_data: 's:arc' }],
        [{ text: '⬅️ Назад', callback_data: 's:back' }],
      ],
    },
  });
}

async function editSettingsCaptionsPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  await editOrSend(chatId, messageId, env, [
    '📝 Captions',
    `Track Caption: ${captionStyleLabel(settings.trackCaptionStyle)}`,
    `Album Caption: ${captionStyleLabel(settings.albumCaptionStyle)}`,
  ].join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: toggleLabel('🖼 Track Cover Image', settings.trackCoverImage), callback_data: 's:tog:trackCoverImage' }],
        [{ text: `🎵 Track Caption: ${captionStyleLabel(settings.trackCaptionStyle)}`, callback_data: 's:tcaption' }],
        [{ text: toggleLabel('💿 Album Cover Image', settings.albumCoverImage), callback_data: 's:tog:albumCoverImage' }],
        [{ text: `💿 Album Caption: ${captionStyleLabel(settings.albumCaptionStyle)}`, callback_data: 's:acaption' }],
        [{ text: '⬅️ Назад', callback_data: 's:back' }],
      ],
    },
  });
}

async function editSettingsTrackCaptionPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  await editOrSend(chatId, messageId, env, captionPreviewText('track', settings.trackCaptionStyle), {
    reply_markup: {
      inline_keyboard: [
        ...CAPTION_STYLES.map((style) => [{
          text: `${captionStyleLabel(style)}${style === settings.trackCaptionStyle ? ' ✅' : ''}`,
          callback_data: `s:tcap:${style}`,
        }]),
        [{ text: '⬅️ Назад', callback_data: 's:captions' }],
      ],
    },
  });
}

async function editSettingsAlbumCaptionPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  await editOrSend(chatId, messageId, env, captionPreviewText('album', settings.albumCaptionStyle), {
    reply_markup: {
      inline_keyboard: [
        ...CAPTION_STYLES.map((style) => [{
          text: `${captionStyleLabel(style)}${style === settings.albumCaptionStyle ? ' ✅' : ''}`,
          callback_data: `s:acap:${style}`,
        }]),
        [{ text: '⬅️ Назад', callback_data: 's:captions' }],
      ],
    },
  });
}

async function editSettingsCodecPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  await editOrSend(chatId, messageId, env, [
    '🔁 Direct-Link Codec Conversion',
    'Контролира AAC, ALAC и FLAC правилата отделно.',
  ].join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: `AAC in M4A: ${codecConversionLabel(settings.codecConversion.aacInM4a)}`, callback_data: `s:codec:aac:${nextCodecConversion(settings.codecConversion.aacInM4a)}` }],
        [{ text: `ALAC in M4A: ${codecConversionLabel(settings.codecConversion.alacInM4a)}`, callback_data: `s:codec:alac:${nextCodecConversion(settings.codecConversion.alacInM4a)}` }],
        [{ text: `FLAC: ${codecConversionLabel(settings.codecConversion.flac)}`, callback_data: `s:codec:flac:${nextCodecConversion(settings.codecConversion.flac)}` }],
        [{ text: '⬅️ Назад', callback_data: 's:back' }],
      ],
    },
  });
}

async function editSettingsFileNamingPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  await editOrSend(chatId, messageId, env, [
    '📁 File Name Templates',
    `Шаблон: ${settings.fileNameTemplate}`,
    '',
    'Поддържани полета: {artist}, {title}, {album}, {year}, {track}.',
    'За свободно редактиране отвори Mini App настройките.',
  ].join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: toggleLabel('🔢 Playlist Position Track Numbers', settings.playlistTrackNumbers), callback_data: 's:tog:playlistTrackNumbers' }],
        [{ text: toggleLabel('📁 Playlist Name As Album', settings.playlistNameAsAlbum), callback_data: 's:tog:playlistNameAsAlbum' }],
        [{ text: '📱 Отвори Mini App', web_app: { url: buildTelegramMiniAppUrl(chatId, env, settings.language, 'settings') } }],
        [{ text: '⬅️ Назад', callback_data: 's:back' }],
      ],
    },
  });
}

async function editSettingsChannelPanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  await editOrSend(chatId, messageId, env, await buildChannelStatusText(settings, env), {
    reply_markup: {
      inline_keyboard: [
        [{ text: toggleLabel('\u{1F4E3} Auto publish new downloads', settings.channelAutoPublish), callback_data: 's:tog:channelAutoPublish' }],
        [{ text: '\u{1F9EA} \u0422\u0435\u0441\u0442 \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f \u0432 \u043a\u0430\u043d\u0430\u043b\u0430', callback_data: 's:channel:test' }],
        [{ text: '\u{1F916} \u041e\u0442\u0432\u043e\u0440\u0438 \u0431\u043e\u0442\u0430', url: 'https://t.me/dyrakarmy_bot' }],
        [{ text: '\u2B05\uFE0F \u041d\u0430\u0437\u0430\u0434', callback_data: 's:back' }],
      ],
    },
  });
}

async function sendChannelStatusPanel(chatId: number, env: Env, prefix = ''): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  const text = [prefix, await buildChannelStatusText(settings, env)].filter(Boolean).join('\n\n');
  await sendMessage(chatId, env, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: toggleLabel('\u{1F4E3} Auto publish new downloads', settings.channelAutoPublish), callback_data: 's:tog:channelAutoPublish' }],
        [{ text: '\u{1F9EA} \u0422\u0435\u0441\u0442 \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f \u0432 \u043a\u0430\u043d\u0430\u043b\u0430', callback_data: 's:channel:test' }],
        [{ text: '\u2699\uFE0F \u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438', callback_data: 's:open' }],
      ],
    },
  });
}

async function buildChannelStatusText(settings: TelegramSettings, env: Env): Promise<string> {
  const channelId = await resolveTelegramDownloadChannelId(env);
  const channelName = await env.CACHE.get('tg:download_channel_username') ?? await env.CACHE.get('tg:download_channel_title');
  const boundAt = await env.CACHE.get('tg:download_channel_bound_at');
  const lastPublish = await env.CACHE.get('tg:last_channel_publish', { type: 'json' }) as Record<string, unknown> | null;
  const lastError = await env.CACHE.get('tg:last_channel_publish_error');

  return [
    '\u{1F4E3} Telegram \u043a\u0430\u043d\u0430\u043b',
    `\u0421\u0442\u0430\u0442\u0443\u0441: ${settings.channelAutoPublish ? '\u0430\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0447\u043d\u043e \u043f\u0443\u0431\u043b\u0438\u043a\u0443\u0432\u0430\u043d\u0435 \u0412\u041a\u041b' : '\u0430\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0447\u043d\u043e \u043f\u0443\u0431\u043b\u0438\u043a\u0443\u0432\u0430\u043d\u0435 \u0418\u0417\u041a\u041b'}`,
    `\u041a\u0430\u043d\u0430\u043b: ${channelName || channelId || '\u043d\u044f\u043c\u0430 \u0437\u0430\u0441\u0435\u0447\u0435\u043d channel id'}`,
    boundAt ? `\u0417\u0430\u0441\u0435\u0447\u0435\u043d: ${boundAt}` : '\u0417\u0430\u0441\u0435\u0447\u0435\u043d: \u043e\u0449\u0435 \u043d\u0435',
    lastPublish ? `\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u043e \u043f\u0443\u0431\u043b\u0438\u043a\u0443\u0432\u0430\u043d\u0435: ${String(lastPublish.at || '--')} (${String(lastPublish.method || '--')})` : '\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u043e \u043f\u0443\u0431\u043b\u0438\u043a\u0443\u0432\u0430\u043d\u0435: \u043d\u044f\u043c\u0430',
    lastError ? `\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u0430 \u0433\u0440\u0435\u0448\u043a\u0430: ${lastError.slice(0, 180)}` : '\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u0430 \u0433\u0440\u0435\u0448\u043a\u0430: \u043d\u044f\u043c\u0430',
    '',
    '\u041a\u0430\u043a \u0434\u0430 \u0432\u044a\u0440\u0436\u0435\u0448 \u0447\u0430\u0441\u0442\u0435\u043d \u043a\u0430\u043d\u0430\u043b:',
    '1. \u0411\u043e\u0442\u044a\u0442 \u0442\u0440\u044f\u0431\u0432\u0430 \u0434\u0430 \u0435 \u0430\u0434\u043c\u0438\u043d\u0438\u0441\u0442\u0440\u0430\u0442\u043e\u0440 \u0432 \u043a\u0430\u043d\u0430\u043b\u0430.',
    '2. \u041f\u0443\u0441\u043d\u0438 \u0435\u0434\u043d\u043e \u0441\u044a\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u0432 \u043a\u0430\u043d\u0430\u043b\u0430 \u0438\u043b\u0438 \u043f\u0440\u0435\u043f\u0440\u0430\u0442\u0438 \u043f\u043e\u0441\u0442 \u043e\u0442 \u043a\u0430\u043d\u0430\u043b\u0430 \u043a\u044a\u043c \u0431\u043e\u0442\u0430.',
    '3. \u041d\u0430\u0442\u0438\u0441\u043d\u0438 \u201e\u0422\u0435\u0441\u0442 \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f \u0432 \u043a\u0430\u043d\u0430\u043b\u0430\u201c.',
  ].join('\n');
}

async function sendTelegramChannelTest(chatId: number, messageId: number, env: Env): Promise<void> {
  const channelId = await resolveTelegramDownloadChannelId(env);
  if (!channelId) {
    await editOrSend(chatId, messageId, env, [
      '\u274c \u041d\u044f\u043c\u0430 \u0437\u0430\u0441\u0435\u0447\u0435\u043d Telegram \u043a\u0430\u043d\u0430\u043b.',
      '',
      '\u0414\u043e\u0431\u0430\u0432\u0438 \u0431\u043e\u0442\u0430 \u043a\u0430\u0442\u043e \u0430\u0434\u043c\u0438\u043d\u0438\u0441\u0442\u0440\u0430\u0442\u043e\u0440 \u0432 \u043a\u0430\u043d\u0430\u043b\u0430 \u0438 \u043f\u0440\u0435\u043f\u0440\u0430\u0442\u0438 \u0435\u0434\u0438\u043d \u043f\u043e\u0441\u0442 \u043e\u0442 \u043a\u0430\u043d\u0430\u043b\u0430 \u043a\u044a\u043c \u0442\u043e\u0437\u0438 \u0447\u0430\u0442, \u0438\u043b\u0438 \u043f\u0443\u0431\u043b\u0438\u043a\u0443\u0432\u0430\u0439 \u0442\u0435\u0441\u0442\u043e\u0432\u043e \u0441\u044a\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u0432 \u043a\u0430\u043d\u0430\u043b\u0430.',
    ].join('\n'));
    await env.CACHE.put('tg:last_channel_publish_error', 'Missing Telegram channel id', { expirationTtl: 86400 });
    return;
  }

  const result = await telegramRequest('sendMessage', {
    chat_id: channelId,
    text: [
      '\u2705 DyrakArmy test publish',
      '\u041a\u0430\u043d\u0430\u043b\u044a\u0442 \u0435 \u0441\u0432\u044a\u0440\u0437\u0430\u043d. \u041d\u043e\u0432\u0438\u0442\u0435 \u0433\u043e\u0442\u043e\u0432\u0438 \u043f\u0435\u0441\u043d\u0438 \u0449\u0435 \u0441\u0435 \u043f\u0443\u0431\u043b\u0438\u043a\u0443\u0432\u0430\u0442 \u0442\u0443\u043a \u0430\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0447\u043d\u043e.',
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [[{ text: '\u{1F916} DyrakArmy BOT', url: 'https://t.me/dyrakarmy_bot' }]],
    },
  }, env);

  if (result.ok) {
    await recordTelegramChannelPublish(env, {
      ok: true,
      method: 'sendMessage',
      channelId,
      description: 'manual test',
    });
    const settings = await getTelegramSettings(chatId, env);
    await editOrSend(chatId, messageId, env, `\u2705 \u0422\u0435\u0441\u0442 \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f\u0442\u0430 \u0435 \u0438\u0437\u043f\u0440\u0430\u0442\u0435\u043d\u0430.\n\n${await buildChannelStatusText(settings, env)}`);
    return;
  }

  await recordTelegramChannelPublish(env, {
    ok: false,
    method: 'sendMessage',
    channelId,
    description: result.description ?? 'Telegram sendMessage failed',
  });
  await editOrSend(chatId, messageId, env, `\u274c \u0422\u0435\u0441\u0442 \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f\u0442\u0430 \u043d\u0435 \u043c\u0438\u043d\u0430:\n${result.description ?? 'Telegram sendMessage failed'}`);
}

async function sendWelcomeMenu(chatId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  const miniAppUrl = buildTelegramMiniAppUrl(chatId, env, settings.language, 'download');
  await sendMessage(
    chatId,
    env,
    [
      '🎧 DyrakArmy BOT',
      '',
      'Изпрати име на песен или URL от YouTube, Spotify, SoundCloud, Deezer или Apple Music.',
      'Можеш да използваш архива, настройките и Mini App бутона от менюто.',
    ].join('\n'),
    {
      reply_markup: {
        resize_keyboard: true,
        one_time_keyboard: false,
        keyboard: [
          [{ text: MENU_LABELS.search }, { text: MENU_LABELS.archive }],
          [{ text: MENU_LABELS.settings }, { text: MENU_LABELS.help }],
          [{ text: MENU_LABELS.miniApp, web_app: { url: miniAppUrl } }],
        ],
      },
    },
  );
}

async function sendHelp(chatId: number, env: Env): Promise<void> {
  await sendMessage(
    chatId,
    env,
    [
      'ℹ️ Помощ',
      '1. Изпрати URL или име на песен.',
      '2. Избери резултат, формат и качество.',
      '3. Ботът добавя задачата в опашка.',
      '4. При готов файл получаваш директен линк и audio изпращане, когато Telegram го приеме.',
      '',
      'Команди:',
      '/start - старт и меню',
      '/menu - показва меню',
      '/settings - настройки',
      '/archive - архив',
      '/help - помощ',
    ].join('\n'),
  );
}

async function sendMiniAppLink(chatId: number, env: Env): Promise<void> {
  const settings = await getTelegramSettings(chatId, env);
  const base = buildTelegramMiniAppUrl(chatId, env, settings.language, 'settings');
  await sendMessage(chatId, env, `Отвори DyrakArmy Mini App:\n${base}`, {
    reply_markup: {
      inline_keyboard: [[{ text: 'Отвори Mini App', web_app: { url: base } }]],
    },
  });
}

async function sendArchivePanel(chatId: number, env: Env): Promise<void> {
  const text = await buildArchivePanelText(env);
  await sendMessage(chatId, env, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔎 Търси в архива', callback_data: 'arc:open' }],
        [{ text: 'Отвори Web архива', url: `${getPublicBaseUrl(env)}/?tab=archive` }],
      ],
    },
  });
}

async function editArchivePanel(chatId: number, messageId: number, env: Env): Promise<void> {
  const text = await buildArchivePanelText(env);
  await editOrSend(chatId, messageId, env, `${text}\n\nНапиши част от име/изпълнител и ще върна резултати от архива.`, {
    reply_markup: {
      inline_keyboard: [[{ text: 'Отвори Web архива', url: `${getPublicBaseUrl(env)}/?tab=archive` }]],
    },
  });
}

async function buildArchivePanelText(env: Env): Promise<string> {
  const count = await getArchiveCount(env);
  const latest = await lookupLatestArchiveRows(5, env);
  const rows = latest.map((row, index) => `${index + 1}. ${(row.artist || 'Неизвестен')} - ${(row.title || 'Без заглавие')}`);
  return [
    '📦 Архив',
    `Записи: ${count}`,
    'Търсенето първо проверява архива и после онлайн източниците.',
    rows.length ? '\nПоследни записи:' : '',
    ...rows,
  ].filter(Boolean).join('\n');
}

export async function notifyTelegramComplete(job: DownloadJob, result: DownloaderDownloadResult, env: Env): Promise<void> {
  if (!job.chatId) return;

  const ttl = readEnvInt(env.DOWNLOAD_TOKEN_TTL_SECONDS, 3600);
  const token = await createDownloadToken(
    {
      jobId: job.id,
      exp: Math.floor(Date.now() / 1000) + ttl,
    },
    env.DOWNLOAD_TOKEN_SECRET,
  );

  const link = `${getPublicBaseUrl(env)}/api/file/${encodeURIComponent(token)}`;
  const doneText = [
    '✅ Готово',
    `${result.artist || 'Неизвестен изпълнител'} - ${result.title || 'Файл'}`,
    `${formatDuration(result.duration)} | ${formatFileSize(result.file_size)}`,
    link,
  ].join('\n');

  if (job.messageId) {
    await editOrSend(job.chatId, job.messageId, env, doneText, downloadLinkMarkup(link));
  } else {
    await sendMessage(job.chatId, env, doneText, downloadLinkMarkup(link));
  }

  const sent = await sendAudio(job.chatId, link, result.title || 'Файл', result.artist || 'DyrakArmy', result.duration || 0, env);
  if (!sent.ok) {
    await sendMessage(job.chatId, env, `Telegram не прие директното audio изпращане. Използвай линка:\n${link}`);
  }
}

export async function backfillTelegramChannelPublishes(env: Env, limit = TELEGRAM_CHANNEL_PUBLISH_BACKFILL_LIMIT): Promise<number> {
  if (String(env.TELEGRAM_CHANNEL_PUBLISH_ENABLED ?? '1').trim() === '0') return 0;
  await ensureTelegramChannelPublishSchema(env);

  const rows = await env.DB.prepare(
    `SELECT
       j.id, j.url, j.source, j.format, j.quality, j.fingerprint, j.chat_id, j.message_id,
       j.sync_key, j.created_at, j.title, j.artist, j.duration, j.file_size, j.result_url
     FROM download_jobs j
     LEFT JOIN telegram_channel_publishes p
       ON p.job_id = j.id AND p.status = 'published'
     WHERE j.status = 'done'
       AND j.chat_id IS NOT NULL
       AND p.job_id IS NULL
     ORDER BY COALESCE(j.finished_at, j.updated_at, j.created_at) DESC
     LIMIT ?`,
  ).bind(Math.max(1, Math.min(100, limit))).all<CompletedTelegramChannelJobRow>();

  let published = 0;
  for (const row of rows.results ?? []) {
    if (!row.chat_id) continue;
    const result = await publishTelegramChannelDownload(
      {
        id: row.id,
        url: row.url ?? '',
        source: normalizeSourceValue(row.source ?? undefined),
        format: normalizeFormat(row.format),
        quality: normalizeQuality(row.quality),
        fingerprint: row.fingerprint ?? row.id,
        syncKey: row.sync_key ?? undefined,
        chatId: row.chat_id,
        messageId: row.message_id ?? undefined,
        requestedAt: row.created_at ?? new Date().toISOString(),
      },
      {
        download_url: row.result_url ?? '',
        title: row.title ?? 'Файл',
        artist: row.artist ?? 'DyrakArmy',
        duration: Number(row.duration ?? 0),
        file_size: Number(row.file_size ?? 0),
        source: normalizeSourceValue(row.source ?? undefined),
      },
      env,
    );
    if (result.ok && result.method !== 'skipped') published += 1;
  }
  return published;
}

export async function publishTelegramChannelDownload(
  job: DownloadJob,
  result: DownloaderDownloadResult,
  env: Env,
): Promise<TelegramChannelPublishResult> {
  if (String(env.TELEGRAM_CHANNEL_PUBLISH_ENABLED ?? '1').trim() === '0') {
    return { ok: true, method: 'skipped', description: 'Channel publishing disabled' };
  }

  const trackPublish = Boolean(job.chatId);
  if (trackPublish) {
    await ensureTelegramChannelPublishSchema(env);
    const existing = await getTelegramChannelPublishRecord(env, job.id);
    if (existing?.status === 'published') {
      return {
        ok: true,
        method: 'skipped',
        channelId: existing.channel_id ?? undefined,
        description: 'Already published',
      };
    }
  }

  const channelId = await resolveTelegramDownloadChannelId(env);
  if (!channelId) {
    const skipped = { ok: false, method: 'skipped' as const, description: 'Missing Telegram channel id' };
    await recordTelegramChannelPublish(env, skipped);
    if (trackPublish) await recordTelegramJobChannelPublish(env, job, skipped);
    return skipped;
  }

  const settings = job.chatId ? await getTelegramSettings(job.chatId, env) : DEFAULT_SETTINGS;
  const forceBotDownloads = Boolean(job.chatId) && String(env.TELEGRAM_CHANNEL_FORCE_BOT_DOWNLOADS ?? '1').trim() !== '0';
  if (!forceBotDownloads && !settings.channelAutoPublish) {
    return { ok: true, method: 'skipped', channelId, description: 'User disabled channel auto publish' };
  }

  const link = await createJobDownloadLink(job.id, env);
  const title = result.title || 'Файл';
  const artist = result.artist || 'DyrakArmy';
  const caption = buildDownloadCaption(job, result, link, settings);
  const replyMarkup = {
    inline_keyboard: [
      [{ text: '⬇️ Свали файла', url: link }, { text: '🤖 DyrakArmy BOT', url: 'https://t.me/dyrakarmy_bot' }],
    ],
  };

  const shouldTryAudio = String(env.TELEGRAM_CHANNEL_SEND_AUDIO ?? '1').trim() !== '0';
  const sent = shouldTryAudio
    ? await sendAudio(channelId, link, title, artist, result.duration || 0, env, {
      caption: truncate(caption, 1000),
      reply_markup: replyMarkup,
    })
    : { ok: false, description: 'Audio publishing disabled' };

  if (sent.ok) {
    const ok = { ok: true, method: 'sendAudio' as const, channelId, description: 'published audio' };
    await recordTelegramChannelPublish(env, ok);
    if (trackPublish) await recordTelegramJobChannelPublish(env, job, ok);
    return ok;
  }

  const document = await sendDocument(channelId, link, env, {
    caption: truncate(caption, 1000),
    reply_markup: replyMarkup,
  });
  if (document.ok) {
    const ok = { ok: true, method: 'sendDocument' as const, channelId, description: sent.description ?? 'published document' };
    await recordTelegramChannelPublish(env, ok);
    if (trackPublish) await recordTelegramJobChannelPublish(env, job, ok);
    return ok;
  }

  const fallback = await telegramRequest('sendMessage', {
    chat_id: channelId,
    text: caption,
    disable_web_page_preview: false,
    reply_markup: replyMarkup,
  }, env);

  if (!fallback.ok) {
    console.warn('Telegram channel publish failed', fallback.description ?? document.description ?? sent.description);
  }
  const status = {
    ok: fallback.ok,
    method: 'sendMessage' as const,
    channelId,
    description: fallback.description ?? document.description ?? sent.description ?? 'Telegram channel publish failed',
  };
  await recordTelegramChannelPublish(env, status);
  if (trackPublish) await recordTelegramJobChannelPublish(env, job, status);
  return status;
}

export async function notifyTelegramFailure(job: DownloadJob, errorMessage: string, env: Env): Promise<void> {
  if (!job.chatId) return;
  const text = formatTelegramFailureText(errorMessage);
  if (job.messageId) {
    await editOrSend(job.chatId, job.messageId, env, text);
  } else {
    await sendMessage(job.chatId, env, text);
  }
}

function formatTelegramFailureText(errorMessage: string): string {
  const normalized = errorMessage.toLowerCase();
  if (
    normalized.includes('sign in to confirm') ||
    normalized.includes('not a bot') ||
    normalized.includes('cookies-from-browser') ||
    normalized.includes('ytdlp_cookies')
  ) {
    return [
      '\u274c \u0421\u0432\u0430\u043b\u044f\u043d\u0435\u0442\u043e \u0441\u0435 \u043f\u0440\u043e\u0432\u0430\u043b\u0438',
      '\u041f\u0440\u0438\u0447\u0438\u043d\u0430: YouTube \u0431\u043b\u043e\u043a\u0438\u0440\u0430 Render origin-\u0430 \u0441 bot-check.',
      '\u041d\u0443\u0436\u043d\u043e \u0435 \u0432 Render \u0434\u0430 \u0438\u043c\u0430 YTDLP_COOKIES_BASE64 \u0438\u043b\u0438 YTDLP_COOKIES_TEXT.',
      '\u0421\u043b\u0435\u0434 \u0442\u043e\u0432\u0430 \u0431\u043e\u0442\u044a\u0442 \u0449\u0435 \u043f\u043e\u0434\u043d\u043e\u0432\u0438 \u0441\u0432\u0430\u043b\u044f\u043d\u0435\u0442\u043e.',
    ].join('\n');
  }
  return `\u274c \u0421\u0432\u0430\u043b\u044f\u043d\u0435\u0442\u043e \u0441\u0435 \u043f\u0440\u043e\u0432\u0430\u043b\u0438\n${errorMessage.slice(0, 600)}`;
}

async function ensureTelegramCommands(env: Env): Promise<void> {
  const marker = await env.CACHE.get('tg:commands:bg:v5');
  if (marker === '1') return;

  try {
    await telegramRequest('setMyCommands', {
      commands: [
        { command: 'start', description: 'Старт и меню' },
        { command: 'menu', description: 'Покажи меню' },
        { command: 'settings', description: 'Настройки' },
        { command: 'archive', description: 'Архив' },
        { command: 'channel', description: 'Telegram \u043a\u0430\u043d\u0430\u043b' },
        { command: 'help', description: 'Помощ' },
      ],
      language_code: 'bg',
    }, env);

    await telegramRequest('setChatMenuButton', {
      menu_button: {
        type: 'web_app',
        text: 'DyrakArmy Mini App',
        web_app: { url: getPublicBaseUrl(env) },
      },
    }, env);

    await telegramRequest('setMyDescription', {
      description: 'Български бот за търсене, опашка, архив и сваляне през DyrakArmy.',
      language_code: 'bg',
    }, env);

    await telegramRequest('setMyShortDescription', {
      short_description: 'Търсене, архив и сваляне на музика през DyrakArmy.',
      language_code: 'bg',
    }, env);

    await ensureTelegramWebhookAllowedUpdates(env);
    await env.CACHE.put('tg:commands:bg:v5', '1', { expirationTtl: 86400 });
  } catch (error) {
    console.warn('Unable to set Telegram commands/menu', error);
  }
}

async function ensureTelegramWebhookAllowedUpdates(env: Env): Promise<void> {
  if (String(env.TELEGRAM_WEBHOOK_AUTO_CONFIG_ENABLED ?? '1').trim() === '0') return;

  const marker = await env.CACHE.get('tg:webhook:allowed-updates:v2');
  if (marker === '1') return;

  const secretToken = env.TELEGRAM_SECRET_TOKEN?.trim();
  const publicBaseUrl = getPublicBaseUrl(env);
  if (!secretToken || !publicBaseUrl.startsWith('https://')) return;

  const result = await telegramRequest('setWebhook', {
    url: `${publicBaseUrl}/telegram/webhook`,
    secret_token: secretToken,
    drop_pending_updates: false,
    allowed_updates: [
      'message',
      'callback_query',
      'channel_post',
      'my_chat_member',
    ],
  }, env);

  if (result.ok) {
    await env.CACHE.put('tg:webhook:allowed-updates:v2', '1', { expirationTtl: 86400 });
  } else {
    await env.CACHE.put('tg:webhook:last_error', result.description ?? 'setWebhook failed', { expirationTtl: 86400 });
  }
}

async function getTelegramSyncedPreferences(
  chatId: number,
  env: Env,
): Promise<Partial<{
  language: string;
  source: string;
  format: string;
  quality: string;
  searchResultView: string;
  audioQualityTier: string;
}>> {
  try {
    const row = await env.DB.prepare('SELECT payload FROM user_preferences WHERE sync_key = ? LIMIT 1')
      .bind(telegramSyncKey(chatId))
      .first<{ payload: string }>();
    if (!row?.payload) return {};
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const telegramSettings = asRecord(payload.telegram_settings) ?? asRecord(payload.telegramSettings);
    return {
      language: typeof payload.language === 'string' ? payload.language : undefined,
      source: typeof payload.source === 'string' ? payload.source : undefined,
      format: typeof payload.format === 'string' ? payload.format : undefined,
      quality: typeof payload.quality === 'string' ? payload.quality : undefined,
      searchResultView: typeof telegramSettings?.searchResultView === 'string' ? telegramSettings.searchResultView : undefined,
      audioQualityTier: typeof telegramSettings?.audioQualityTier === 'string' ? telegramSettings.audioQualityTier : undefined,
    };
  } catch {
    return {};
  }
}

async function saveTelegramSyncedPreferences(chatId: number, settings: TelegramSettings, env: Env): Promise<void> {
  const key = telegramSyncKey(chatId);
  try {
    let existing: Record<string, unknown> = {};
    const row = await env.DB.prepare('SELECT payload FROM user_preferences WHERE sync_key = ? LIMIT 1')
      .bind(key)
      .first<{ payload: string | null }>();
    if (row?.payload) {
      existing = JSON.parse(row.payload) as Record<string, unknown>;
    }

    const now = new Date().toISOString();
    const existingFieldTimes = asRecord(existing.field_updated_at) ?? {};
    const currentRevision = Number(existing.revision ?? 0);
    const payload = {
      ...existing,
      language: settings.language,
      source: settings.defaultSource,
      format: settings.defaultFormat,
      quality: settings.defaultQuality,
      download_directory: typeof existing.download_directory === 'string' ? existing.download_directory : '',
      telegram_link_mode: existing.telegram_link_mode === 'download' ? 'download' : 'bot',
      revision: Number.isFinite(currentRevision) ? currentRevision + 1 : 1,
      field_updated_at: {
        language: now,
        source: now,
        format: now,
        quality: now,
        download_directory: typeof existingFieldTimes.download_directory === 'string' ? existingFieldTimes.download_directory : now,
        telegram_link_mode: typeof existingFieldTimes.telegram_link_mode === 'string' ? existingFieldTimes.telegram_link_mode : now,
      },
      last_writer: 'telegram',
      updated_at: now,
      telegram_settings: settings,
      updated_from: 'telegram',
    };

    await env.DB.prepare(
      `INSERT INTO user_preferences (sync_key, payload, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(sync_key) DO UPDATE SET
         payload = excluded.payload,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(key, JSON.stringify(payload)).run();
    await env.CACHE.put(`prefs:${key}`, JSON.stringify(payload), { expirationTtl: 86400 });
  } catch (error) {
    console.warn('Telegram preference sync skipped', error);
  }
}

async function lookupArchiveByExactUrl(url: string, env: Env): Promise<ArchiveRecord | null> {
  const normalized = normalizeArchiveUrl(url);
  if (!normalized) return null;

  try {
    return await env.DB.prepare(
      `SELECT normalized_url, source_url, source, title, artist, bot_username
       FROM telegram_archive_tracks
       WHERE normalized_url = ?
       LIMIT 1`,
    ).bind(normalized).first<ArchiveRecord>();
  } catch (error) {
    console.warn('Archive table lookup failed', error);
    return null;
  }
}

async function lookupArchiveByQuery(query: string, limit: number, env: Env): Promise<ArchiveRecord[]> {
  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean).slice(0, 6);
  if (tokens.length === 0) return [];

  const where = tokens.map(() => 'match_text LIKE ?').join(' AND ');
  const binds = tokens.map((token) => `%${token}%`);
  try {
    const rows = await env.DB.prepare(
      `SELECT normalized_url, source_url, source, title, artist, bot_username
       FROM telegram_archive_tracks
       WHERE ${where}
       ORDER BY id DESC
       LIMIT ?`,
    ).bind(...binds, Math.max(1, Math.min(20, limit))).all<ArchiveRecord>();
    return rows.results ?? [];
  } catch (error) {
    console.warn('Archive query search failed', error);
    return [];
  }
}

async function lookupLatestArchiveRows(limit: number, env: Env): Promise<ArchiveRecord[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT normalized_url, source_url, source, title, artist, bot_username
       FROM telegram_archive_tracks
       ORDER BY id DESC
       LIMIT ?`,
    ).bind(Math.max(1, Math.min(20, limit))).all<ArchiveRecord>();
    return rows.results ?? [];
  } catch {
    return [];
  }
}

async function getArchiveCount(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM telegram_archive_tracks').first<{ total: number }>();
    return Number(row?.total ?? 0);
  } catch {
    return 0;
  }
}

async function findCompletedJobByFingerprint(fingerprint: string, env: Env): Promise<CompletedFingerprintJob | null> {
  try {
    return await env.DB.prepare(
      `SELECT id, title, artist, duration, file_size
       FROM download_jobs
       WHERE fingerprint = ?
         AND status = 'done'
       ORDER BY finished_at DESC, updated_at DESC
       LIMIT 1`,
    ).bind(fingerprint).first<CompletedFingerprintJob>();
  } catch (error) {
    console.warn('Completed fingerprint lookup failed', error);
    return null;
  }
}

async function telegramRequest(method: string, body: Record<string, unknown>, env: Env): Promise<TelegramRequestResult> {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) return { ok: false, description: 'Missing TELEGRAM_BOT_TOKEN' };

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await response.json().catch(() => ({ ok: false, description: `Telegram HTTP ${response.status}` })) as TelegramRequestResult;
  } catch (error) {
    return { ok: false, description: error instanceof Error ? error.message : String(error) };
  }
}

function sendMessage(chatId: number | string, env: Env, text: string, extra?: Record<string, unknown>) {
  return telegramRequest('sendMessage', { chat_id: chatId, text, ...extra }, env);
}

function editMessage(chatId: number | string, messageId: number, env: Env, text: string, extra?: Record<string, unknown>) {
  return telegramRequest('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra }, env);
}

async function editOrSend(chatId: number | string, messageId: number, env: Env, text: string, extra?: Record<string, unknown>): Promise<TelegramRequestResult> {
  const edited = await editMessage(chatId, messageId, env, text, extra);
  if (edited.ok) return edited;
  return sendMessage(chatId, env, text, extra);
}

function answerCallback(callbackId: string, env: Env, text?: string) {
  return telegramRequest('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) }, env);
}

function callbackNotice(data: string): string | undefined {
  if (data.startsWith('fmt:')) {
    const [, , format] = data.split(':');
    return format ? `Формат: ${format.toUpperCase()}. Избери качество.` : 'Избери качество.';
  }
  if (data.startsWith('dl:')) {
    return 'Добавям задачата в опашката.';
  }
  if (data.startsWith('qdef:')) {
    return 'Добавям с настройките по подразбиране.';
  }
  if (data.startsWith('s:setfmt:')) {
    const format = data.replace('s:setfmt:', '');
    return `Форматът е сменен на ${format.toUpperCase()}.`;
  }
  if (data.startsWith('s:setq:')) {
    const quality = data.replace('s:setq:', '');
    return `Качеството е сменено на ${quality}.`;
  }
  if (data.startsWith('s:settier:')) {
    return 'Аудио профилът е обновен.';
  }
  if (data.startsWith('s:tog:')) {
    return 'Настройката е обновена.';
  }
  if (data.startsWith('s:setlang:')) {
    return 'Езикът е обновен.';
  }
  return undefined;
}

function sendAudio(
  chatId: number | string,
  fileUrl: string,
  title: string,
  artist: string,
  duration: number,
  env: Env,
  extra?: Record<string, unknown>,
) {
  return telegramRequest('sendAudio', {
    chat_id: chatId,
    audio: fileUrl,
    title,
    performer: artist,
    duration,
    ...extra,
  }, env);
}

function sendDocument(chatId: number | string, fileUrl: string, env: Env, extra?: Record<string, unknown>) {
  return telegramRequest('sendDocument', {
    chat_id: chatId,
    document: fileUrl,
    ...extra,
  }, env);
}

function downloadLinkMarkup(link: string): Record<string, unknown> {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: '⬇️ Свали файл', url: link }]],
    },
  };
}

function isStartCommand(text: string): boolean {
  return text === '/start' || text.startsWith('/start ');
}

function isHelpCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '/help' || normalized === 'help' || normalized === 'помощ';
}

function isArchiveCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '/archive' || normalized === 'архив';
}

function isSettingsCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '/settings' || normalized === 'настройки';
}


function isChannelCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '/channel' || normalized === '/channel_test' || normalized === 'channel' || normalized === '\u043a\u0430\u043d\u0430\u043b';
}

function isBotCommand(text: string): boolean {
  return text.trim().startsWith('/');
}

function telegramSyncKey(chatId: number): string {
  return `tg_${Math.abs(chatId)}`;
}

function buildTelegramMiniAppUrl(chatId: number, env: Env, language: BotLanguage, tab: string): string {
  const url = new URL(getPublicBaseUrl(env));
  url.searchParams.set('sync', telegramSyncKey(chatId));
  url.searchParams.set('lang', language);
  url.searchParams.set('client', 'telegram-miniapp');
  url.searchParams.set('tab', tab);
  return url.toString();
}

function normalizeBotLanguage(raw: string | undefined): BotLanguage {
  const value = String(raw || '').toLowerCase();
  if (value.startsWith('en')) return 'en';
  if (value.startsWith('es')) return 'es';
  if (value.startsWith('ru')) return 'ru';
  if (value.startsWith('de')) return 'de';
  return 'bg';
}

function languageLabel(value: BotLanguage): string {
  const labels: Record<BotLanguage, string> = {
    bg: '🇧🇬 Български',
    en: '🇬🇧 English',
    es: '🇪🇸 Español',
    ru: '🇷🇺 Русский',
    de: '🇩🇪 Deutsch',
  };
  return labels[value];
}

function boolSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeSearchResultView(input: unknown): SearchResultView {
  return SEARCH_RESULT_VIEWS.includes(input as SearchResultView)
    ? input as SearchResultView
    : DEFAULT_SETTINGS.searchResultView;
}

function normalizeAudioQualityTier(input: unknown): AudioQualityTier {
  return AUDIO_QUALITY_TIERS.includes(input as AudioQualityTier)
    ? input as AudioQualityTier
    : DEFAULT_SETTINGS.audioQualityTier;
}

function normalizeCaptionStyle(input: unknown): CaptionStyle {
  return CAPTION_STYLES.includes(input as CaptionStyle)
    ? input as CaptionStyle
    : 'detailed';
}

function normalizeCodecConversionSettings(input: unknown): CodecConversionSettings {
  const raw = asRecord(input);
  return {
    aacInM4a: normalizeCodecConversion(raw?.aacInM4a),
    alacInM4a: normalizeCodecConversion(raw?.alacInM4a),
    flac: normalizeCodecConversion(raw?.flac),
  };
}

function normalizeCodecConversion(input: unknown): string {
  const value = String(input ?? '').toLowerCase();
  return ['original', 'mp3', 'flac', 'wav'].includes(value) ? value : 'original';
}

function normalizePerServiceQuality(input: unknown): Record<string, string> {
  const raw = asRecord(input) ?? {};
  const normalized: Record<string, string> = {};
  for (const service of SERVICE_KEYS) {
    normalized[service] = normalizeServiceQualityPreset(raw[service] ?? DEFAULT_PER_SERVICE_QUALITY[service]);
  }
  return normalized;
}

function normalizeServiceQualityPreset(input: unknown): string {
  const value = String(input ?? '').toLowerCase();
  return SERVICE_QUALITY_PRESETS.includes(value as typeof SERVICE_QUALITY_PRESETS[number])
    ? value
    : 'flac_cd';
}

function qualityFromTier(tier: AudioQualityTier, format: AudioFormat): AudioQuality {
  if (LOSSLESS_FORMATS.includes(format)) {
    return tier === 'high' || tier === 'low' ? 'best' : 'lossless';
  }
  if (tier === 'low') return '128';
  if (tier === 'high') return '320';
  if (tier === 'lossless') return 'best';
  return format === 'opus' ? '256' : '320';
}

function toggleTelegramSetting(settings: TelegramSettings, key: string): void {
  switch (key) {
    case 'archiveUploads':
      settings.archiveUploads = !settings.archiveUploads;
      break;
    case 'useDirectLinks':
      settings.useDirectLinks = !settings.useDirectLinks;
      break;
    case 'spekZipForTracks':
      settings.spekZipForTracks = !settings.spekZipForTracks;
      break;
    case 'albumLinkPreview':
      settings.albumLinkPreview = !settings.albumLinkPreview;
      break;
    case 'showQualityInfoInCaptions':
      settings.showQualityInfoInCaptions = !settings.showQualityInfoInCaptions;
      break;
    case 'playlistTrackNumbers':
      settings.playlistTrackNumbers = !settings.playlistTrackNumbers;
      break;
    case 'playlistNameAsAlbum':
      settings.playlistNameAsAlbum = !settings.playlistNameAsAlbum;
      break;
    case 'trackCoverImage':
      settings.trackCoverImage = !settings.trackCoverImage;
      break;
    case 'albumCoverImage':
      settings.albumCoverImage = !settings.albumCoverImage;
      break;
    case 'channelAutoPublish':
      settings.channelAutoPublish = !settings.channelAutoPublish;
      break;
  }
}

async function editSettingsPanelForToggle(chatId: number, messageId: number, env: Env, key: string): Promise<void> {
  if (['archiveUploads', 'useDirectLinks', 'spekZipForTracks', 'albumLinkPreview', 'showQualityInfoInCaptions', 'playlistTrackNumbers', 'playlistNameAsAlbum'].includes(key)) {
    await editSettingsDownloadsPanel(chatId, messageId, env);
    return;
  }
  if (['trackCoverImage', 'albumCoverImage'].includes(key)) {
    await editSettingsCaptionsPanel(chatId, messageId, env);
    return;
  }
  if (key === 'channelAutoPublish') {
    await editSettingsChannelPanel(chatId, messageId, env);
    return;
  }
  await editSettingsPanel(chatId, messageId, env);
}

function toggleLabel(label: string, enabled: boolean): string {
  return `${label}: ${enabled ? '✅' : '❌'}`;
}

function searchResultViewLabel(value: SearchResultView): string {
  return value === 'buttons' ? 'Buttons' : 'Message';
}

function audioTierLabel(value: AudioQualityTier): string {
  const labels: Record<AudioQualityTier, string> = {
    low: '🔈 Low',
    high: '🔊 High',
    lossless: '💿 Lossless',
    hifi: '🎧 HiFi',
  };
  return labels[value];
}

function captionStyleLabel(value: CaptionStyle): string {
  const labels: Record<CaptionStyle, string> = {
    none: 'No Caption',
    default: 'Default',
    detailed: 'Detailed',
    simple: 'Simple',
    custom: 'Custom template',
  };
  return labels[value];
}

function captionPreviewText(kind: 'track' | 'album', style: CaptionStyle): string {
  if (style === 'none') {
    return `${kind === 'track' ? 'Track' : 'Album'} Caption: No Caption\nНяма да се изпраща caption.`;
  }
  if (style === 'simple') {
    return `${kind === 'track' ? 'Track' : 'Album'} Caption: Simple\nNova Echo - City Static`;
  }
  if (style === 'custom') {
    return [
      `${kind === 'track' ? 'Track' : 'Album'} Caption: Custom template`,
      'Шаблонът се редактира от Mini App настройките.',
      'Пример: {artist} - {title} | {format} {quality}',
    ].join('\n');
  }
  if (style === 'default') {
    return [
      `${kind === 'track' ? 'Track' : 'Album'} Caption: Default`,
      '🎧 Album title: City Static',
      '👤 Artist: Nova Echo',
      '📅 Release date: May 17, 2024',
      '🎵 Total tracks: 12',
      '⏱ Duration: 44m',
      '🏷 Genre: Indie Electronic',
      '🏢 Label: Aurora Lane',
    ].join('\n');
  }
  return [
    `${kind === 'track' ? 'Track' : 'Album'} Caption: Detailed`,
    '12 track(s)',
    'Total length: 44m',
    '',
    'Main Artists: Nova Echo',
    'Label: Aurora Lane',
    'Genre: Indie Electronic',
    'Detailed mode shows track count, duration, artists, label, and genre.',
  ].join('\n');
}

function serviceLabel(service: string): string {
  const labels: Record<string, string> = {
    amazon: '📦 Amazon',
    apple: '🍎 Apple',
    beatport: '🎛 Beatport',
    deezer: '🎵 Deezer',
    kkbox: '🟠 KKbox',
    qobuz: '🔊 Qobuz',
    tidal: '🌊 Tidal',
  };
  return labels[service] ?? service;
}

function serviceQualityLabel(value: string): string {
  const labels: Record<string, string> = {
    mp3_320: 'MP3 (320kbps)',
    aac_256: 'AAC (256kbps)',
    flac_cd: 'FLAC (CD)',
    flac_hires: 'FLAC (Hi-Res)',
    flac_24b: 'FLAC (24b)',
    alac_hires: 'ALAC (Hi-Res)',
  };
  return labels[normalizeServiceQualityPreset(value)] ?? 'FLAC (CD)';
}

function nextServiceQualityPreset(current: string): string {
  const normalized = normalizeServiceQualityPreset(current);
  const index = SERVICE_QUALITY_PRESETS.indexOf(normalized as typeof SERVICE_QUALITY_PRESETS[number]);
  return SERVICE_QUALITY_PRESETS[(index + 1) % SERVICE_QUALITY_PRESETS.length] ?? 'flac_cd';
}

function codecConversionLabel(value: string): string {
  const normalized = normalizeCodecConversion(value);
  return normalized === 'original' ? 'Original' : normalized.toUpperCase();
}

function nextCodecConversion(current: string): string {
  const options = ['original', 'mp3', 'flac', 'wav'];
  const normalized = normalizeCodecConversion(current);
  const index = options.indexOf(normalized);
  return options[(index + 1) % options.length] ?? 'original';
}

async function resolveTelegramDownloadChannelId(env: Env): Promise<string | null> {
  const configured = normalizeTelegramChannelTarget(env.TELEGRAM_DOWNLOAD_CHANNEL_ID);
  if (configured) return configured;
  const cached = await env.CACHE.get('tg:download_channel_id');
  const normalizedCached = normalizeTelegramChannelTarget(cached ?? undefined);
  if (normalizedCached) return normalizedCached;
  const username = await env.CACHE.get('tg:download_channel_username');
  return normalizeTelegramChannelTarget(username ?? undefined);
}

function normalizeTelegramChannelTarget(raw: string | undefined): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.startsWith('@')) return value;

  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      const boostChannel = url.searchParams.get('c');
      if (boostChannel && /^\d{5,}$/.test(boostChannel)) return `-100${boostChannel}`;
      const username = url.pathname.replace(/^\/+/, '').split('/')[0] ?? '';
      if (username && !username.startsWith('+') && username !== 'joinchat' && /^[a-zA-Z0-9_]{5,}$/.test(username)) {
        return `@${username}`;
      }
      return '';
    }
  } catch {
    return '';
  }

  const numeric = value.replace(/\s+/g, '');
  if (/^-100\d{5,}$/.test(numeric)) return numeric;
  if (/^\d{5,}$/.test(numeric)) return `-100${numeric}`;
  if (/^-\d{5,}$/.test(numeric)) return `-100${numeric.slice(1)}`;
  if (/^[a-zA-Z0-9_]{5,}$/.test(value)) return `@${value}`;
  return '';
}

async function recordTelegramChannelPublish(env: Env, result: TelegramChannelPublishResult): Promise<void> {
  const payload = {
    ok: result.ok,
    method: result.method ?? 'skipped',
    channel_id: result.channelId ?? null,
    description: result.description ?? null,
    at: new Date().toISOString(),
  };

  if (result.ok) {
    await env.CACHE.put('tg:last_channel_publish', JSON.stringify(payload), { expirationTtl: 604800 });
    await env.CACHE.delete?.('tg:last_channel_publish_error').catch?.(() => undefined);
    return;
  }

  await env.CACHE.put(
    'tg:last_channel_publish_error',
    `${payload.at}: ${result.description ?? 'Telegram channel publish failed'}`,
    { expirationTtl: 604800 },
  );
}

async function ensureTelegramChannelPublishSchema(env: Env): Promise<void> {
  if (!telegramChannelPublishSchemaReady) {
    telegramChannelPublishSchemaReady = (async () => {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS telegram_channel_publishes (
          job_id          TEXT PRIMARY KEY,
          status          TEXT NOT NULL,
          method          TEXT,
          channel_id      TEXT,
          attempts        INTEGER NOT NULL DEFAULT 0,
          description     TEXT,
          first_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_attempt_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          published_at     TEXT
        )`,
      ).run();
      await env.DB.batch([
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tg_channel_publishes_status ON telegram_channel_publishes(status)'),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tg_channel_publishes_last_attempt ON telegram_channel_publishes(last_attempt_at DESC)'),
      ]);
    })().catch((error) => {
      telegramChannelPublishSchemaReady = null;
      throw error;
    });
  }
  await telegramChannelPublishSchemaReady;
}

async function getTelegramChannelPublishRecord(
  env: Env,
  jobId: string,
): Promise<TelegramChannelPublishRecord | null> {
  await ensureTelegramChannelPublishSchema(env);
  return env.DB.prepare(
    `SELECT status, method, channel_id, attempts
     FROM telegram_channel_publishes
     WHERE job_id = ?
     LIMIT 1`,
  ).bind(jobId).first<TelegramChannelPublishRecord>();
}

async function recordTelegramJobChannelPublish(
  env: Env,
  job: DownloadJob,
  result: TelegramChannelPublishResult,
): Promise<void> {
  await ensureTelegramChannelPublishSchema(env);
  const status = result.ok && result.method !== 'skipped' ? 'published' : 'failed';
  const publishedAt = status === 'published' ? new Date().toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO telegram_channel_publishes (
       job_id, status, method, channel_id, attempts, description, first_attempt_at, last_attempt_at, published_at
     ) VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       status = excluded.status,
       method = excluded.method,
       channel_id = excluded.channel_id,
       attempts = telegram_channel_publishes.attempts + 1,
       description = excluded.description,
       last_attempt_at = CURRENT_TIMESTAMP,
       published_at = COALESCE(excluded.published_at, telegram_channel_publishes.published_at)`,
  ).bind(
    job.id,
    status,
    result.method ?? 'skipped',
    result.channelId ?? null,
    result.description?.slice(0, 500) ?? null,
    publishedAt,
  ).run();
}

async function createJobDownloadLink(jobId: string, env: Env): Promise<string> {
  const ttl = readEnvInt(env.DOWNLOAD_TOKEN_TTL_SECONDS, 3600);
  const token = await createDownloadToken(
    {
      jobId,
      exp: Math.floor(Date.now() / 1000) + ttl,
    },
    env.DOWNLOAD_TOKEN_SECRET,
  );
  return `${getPublicBaseUrl(env)}/api/file/${encodeURIComponent(token)}`;
}

function buildDownloadCaption(
  job: DownloadJob,
  result: DownloaderDownloadResult,
  link: string,
  settings: TelegramSettings,
): string {
  const artist = result.artist || 'Неизвестен изпълнител';
  const title = result.title || 'Файл';
  if (settings.trackCaptionStyle === 'none') {
    return link;
  }
  if (settings.trackCaptionStyle === 'simple') {
    return `${artist} - ${title}\n${link}`;
  }

  const rows = [
    '✅ Ново сваляне в DyrakArmy',
    `🎵 ${artist} - ${title}`,
    `🌐 Източник: ${sourceLabel(normalizeSourceValue(result.source || job.source))}`,
    `🎧 Формат: ${job.format.toUpperCase()} ${job.quality}`,
  ];
  if (settings.showQualityInfoInCaptions) {
    rows.push(`⏱ ${formatDuration(result.duration)} | 💾 ${formatFileSize(result.file_size)}`);
  }
  if (settings.trackCaptionStyle === 'detailed') {
    rows.push(`🆔 Job: ${job.id.slice(0, 8)}`);
    if (result.fallback_used) rows.push('🔁 Fallback mirror used');
  }
  rows.push(link);
  return rows.join('\n');
}

function normalizeFormat(input: string | undefined): AudioFormat {
  if (input && SUPPORTED_FORMATS.includes(input as AudioFormat)) return input as AudioFormat;
  return DEFAULT_SETTINGS.defaultFormat;
}

function normalizeQuality(input: string | undefined): AudioQuality {
  const values = [...LOSSY_QUALITIES, ...LOSSLESS_QUALITIES];
  if (input && values.includes(input as AudioQuality)) return input as AudioQuality;
  return DEFAULT_SETTINGS.defaultQuality;
}

function normalizeSourceValue(input: string | undefined): string {
  const normalized = normalizeSource(input);
  return SUPPORTED_SOURCES.includes(normalized) ? normalized : DEFAULT_SETTINGS.defaultSource;
}

function isValidQualityForFormat(format: AudioFormat, quality: AudioQuality): boolean {
  if (LOSSLESS_FORMATS.includes(format)) return LOSSLESS_QUALITIES.includes(quality);
  return LOSSY_QUALITIES.includes(quality);
}

function formatChoiceLabel(value: AudioFormat, selected: AudioFormat): string {
  return `${value.toUpperCase()}${value === selected ? ' ✅' : ''}`;
}

function qualityChoiceLabel(value: AudioQuality, selected: AudioQuality): string {
  return `${value}${value === selected ? ' ✅' : ''}`;
}

function sourceChoiceLabel(value: string, selected: string): string {
  return `${sourceLabel(value)}${value === selected ? ' ✅' : ''}`;
}

function sourceLabel(value: string): string {
  const map: Record<string, string> = {
    all: 'Всички',
    spotify: 'Spotify',
    youtube: 'YouTube',
    soundcloud: 'SoundCloud',
    deezer: 'Deezer',
    apple: 'Apple Music',
    podcast: 'Podcast/RSS',
  };
  return map[value] ?? 'Всички';
}

function formatArchiveMeta(row: ArchiveRecord): string {
  const title = row.title?.trim() || 'Неизвестно заглавие';
  const artist = row.artist?.trim() || 'Неизвестен изпълнител';
  const bot = row.bot_username ? `@${row.bot_username}` : 'архив';
  return `${artist} - ${title}\nИзточник: ${sourceLabel(normalizeSourceValue(row.source))}\nЗапис: ${bot}`;
}

function normalizeArchiveUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (host.includes('spotify.com')) {
      const type = segments[0];
      const id = segments[1];
      if (type && id) return `https://open.spotify.com/${type}/${id}`;
      return `https://open.spotify.com${parsed.pathname}`;
    }

    if (host.includes('deezer.com')) {
      const cleaned = segments.length >= 3 && /^[a-z]{2}$/i.test(segments[0] ?? '') ? segments.slice(1) : segments;
      if (cleaned[0] && cleaned[1]) return `https://www.deezer.com/${cleaned[0]}/${cleaned[1]}`;
      return `https://www.deezer.com${parsed.pathname}`;
    }

    if (host.includes('music.apple.com') || host.includes('itunes.apple.com')) return `${parsed.origin}${parsed.pathname}`;
    if (host.includes('soundcloud.com')) return `${parsed.origin}${parsed.pathname}`;
    if (host.includes('youtube.com')) {
      const videoId = parsed.searchParams.get('v');
      return videoId ? `https://www.youtube.com/watch?v=${videoId}` : `${parsed.origin}${parsed.pathname}`;
    }
    if (host === 'youtu.be') return `https://youtu.be${parsed.pathname}`;

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function getPublicBaseUrl(env: Env): string {
  return (env.PUBLIC_BASE_URL ?? 'https://dyrakarmy.online').replace(/\/+$/g, '');
}

function shortHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = Math.imul(31, hash) + input.charCodeAt(i) | 0;
  }
  return Math.abs(hash).toString(36);
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function formatDuration(seconds: number | null | undefined): string {
  const secNum = Number.isFinite(seconds) ? Math.max(0, Math.floor(Number(seconds))) : 0;
  const min = Math.floor(secNum / 60);
  const sec = secNum % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number | null | undefined): string {
  const size = Number.isFinite(bytes) ? Math.max(0, Number(bytes)) : 0;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
