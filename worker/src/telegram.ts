import { fetchDownloaderWithFailover } from './origins';
import type { AudioFormat, AudioQuality, DownloadJob, DownloaderDownloadResult, Env } from './types';
import {
  createDownloadToken,
  createJobFingerprint,
  detectSourceFromUrl,
  normalizeSource,
  rateLimit,
  readEnvInt,
  validateUrlPolicy,
} from './utils';

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; username?: string };
  from?: { id: number; first_name?: string; username?: string };
  text?: string;
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

const SUPPORTED_FORMATS: AudioFormat[] = ['mp3', 'flac', 'ogg', 'm4a', 'opus', 'wav'];
const LOSSLESS_FORMATS: AudioFormat[] = ['flac', 'wav'];
const LOSSLESS_QUALITIES: AudioQuality[] = ['lossless', 'best'];
const LOSSY_QUALITIES: AudioQuality[] = ['best', '320', '256', '192', '128', '96'];
const SUPPORTED_SOURCES = ['all', 'spotify', 'youtube', 'soundcloud', 'deezer', 'apple', 'podcast'];
type BotLanguage = 'bg' | 'en' | 'es' | 'ru' | 'de';

const DEFAULT_SETTINGS: TelegramSettings = {
  defaultFormat: 'mp3',
  defaultQuality: '320',
  defaultSource: 'all',
  preferArchive: true,
  language: 'bg',
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
  const expectedSecret = env.TELEGRAM_SECRET_TOKEN?.trim();
  if (!secret || !expectedSecret || secret !== expectedSecret) {
    return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized', retryable: false } }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json<TelegramUpdate>();
  } catch {
    return Response.json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON', retryable: false } }, { status: 400 });
  }

  try {
    if (update.message) {
      await handleMessage(update.message, env);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
    }
  } catch (error) {
    console.error('Telegram update failed', error);
  }

  return Response.json({ ok: true });
}

async function handleMessage(msg: TelegramMessage, env: Env): Promise<void> {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? '';
  if (!text) return;

  const rl = await rateLimit(env.CACHE, `tgmsg:${chatId}`, 25, 60);
  if (rl.limited) {
    await sendMessage(chatId, env, 'Прекалено много заявки. Изчакай 1 минута и опитай отново.');
    return;
  }

  await ensureTelegramCommands(env);

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

    await editOrSend(chatId, loadingId, env, 'Избери песен:', {
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
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  const data = cb.data ?? '';

  await answerCallback(cb.id, env);
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

  if (data.startsWith('s:setfmt:')) {
    const format = data.replace('s:setfmt:', '') as AudioFormat;
    if (SUPPORTED_FORMATS.includes(format)) {
      const settings = await getTelegramSettings(chatId, env);
      settings.defaultFormat = format;
      if (LOSSLESS_FORMATS.includes(format) && !LOSSLESS_QUALITIES.includes(settings.defaultQuality)) settings.defaultQuality = 'lossless';
      if (!LOSSLESS_FORMATS.includes(format) && settings.defaultQuality === 'lossless') settings.defaultQuality = '320';
      await saveTelegramSettings(chatId, settings, env);
    }
    await editSettingsPanel(chatId, messageId, env);
    return;
  }

  if (data.startsWith('s:setq:')) {
    const quality = data.replace('s:setq:', '') as AudioQuality;
    const settings = await getTelegramSettings(chatId, env);
    if (isValidQualityForFormat(settings.defaultFormat, quality)) {
      settings.defaultQuality = quality;
      await saveTelegramSettings(chatId, settings, env);
    }
    await editSettingsPanel(chatId, messageId, env);
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
  const policy = validateUrlPolicy(url, env);
  if (!policy.allowed) {
    await editOrSend(chatId, messageId, env, `URL е блокиран: ${policy.message ?? 'domain policy'}`);
    return;
  }
  const cached = await env.CACHE.get(`tg:result:${cacheKey}`, { type: 'json' }) as CachedPickerResult | null;
  const source = normalizeSourceValue(cached?.source || detectSourceFromUrl(url));
  const fingerprint = await createJobFingerprint(url, format, quality);
  const existing = await findCompletedJobByFingerprint(fingerprint, env);

  if (existing) {
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
    return;
  }

  const jobId = crypto.randomUUID();
  const title = cached?.title?.trim() || null;
  const artist = cached?.artist?.trim() || null;

  await env.DB.prepare(
    `INSERT INTO download_jobs (
      id, url, source, format, quality, status, attempts, fingerprint, chat_id, message_id, title, artist, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(jobId, url, source, format, quality, fingerprint, chatId, messageId, title, artist).run();

  const job: DownloadJob = {
    id: jobId,
    url,
    source,
    format,
    quality,
    fingerprint,
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
  };

  const synced = await getTelegramSyncedPreferences(chatId, env);
  if (synced.language) merged.language = normalizeBotLanguage(synced.language);
  if (synced.source) merged.defaultSource = normalizeSourceValue(synced.source);
  if (synced.format) merged.defaultFormat = normalizeFormat(synced.format);
  if (synced.quality) merged.defaultQuality = normalizeQuality(synced.quality);

  if (!isValidQualityForFormat(merged.defaultFormat, merged.defaultQuality)) {
    merged.defaultQuality = LOSSLESS_FORMATS.includes(merged.defaultFormat) ? 'lossless' : '320';
  }
  return merged;
}

async function saveTelegramSettings(chatId: number, settings: TelegramSettings, env: Env): Promise<void> {
  await env.CACHE.put(`tg:settings:${chatId}`, JSON.stringify(settings), { expirationTtl: 31536000 });
}

function settingsText(settings: TelegramSettings): string {
  return [
    '⚙️ Настройки',
    `Език: ${languageLabel(settings.language)}`,
    `Формат по подразбиране: ${settings.defaultFormat.toUpperCase()}`,
    `Качество по подразбиране: ${settings.defaultQuality}`,
    `Източник при търсене: ${sourceLabel(settings.defaultSource)}`,
    `Архив приоритет: ${settings.preferArchive ? 'ВКЛ' : 'ИЗКЛ'}`,
  ].join('\n');
}

function settingsMainKeyboard(chatId: number, settings: TelegramSettings, env: Env): Array<Array<Record<string, unknown>>> {
  return [
    [{ text: `🌐 Език: ${languageLabel(settings.language)}`, web_app: { url: buildTelegramMiniAppUrl(chatId, env, settings.language, 'settings') } }],
    [{ text: `🎧 Формат: ${settings.defaultFormat.toUpperCase()}`, callback_data: 's:fmt' }],
    [{ text: `🎚 Качество: ${settings.defaultQuality}`, callback_data: 's:q' }],
    [{ text: `🌐 Източник: ${sourceLabel(settings.defaultSource)}`, callback_data: 's:src' }],
    [{ text: `📦 Архив: ${settings.preferArchive ? 'ВКЛ' : 'ИЗКЛ'}`, callback_data: 's:arc' }],
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

export async function publishTelegramChannelDownload(
  job: DownloadJob,
  result: DownloaderDownloadResult,
  env: Env,
): Promise<void> {
  const channelId = String(env.TELEGRAM_DOWNLOAD_CHANNEL_ID ?? '').trim();
  if (!channelId) return;

  const ttl = readEnvInt(env.DOWNLOAD_TOKEN_TTL_SECONDS, 3600);
  const token = await createDownloadToken(
    {
      jobId: job.id,
      exp: Math.floor(Date.now() / 1000) + ttl,
    },
    env.DOWNLOAD_TOKEN_SECRET,
  );
  const link = `${getPublicBaseUrl(env)}/api/file/${encodeURIComponent(token)}`;
  const text = [
    '✅ Ново сваляне в DyrakArmy',
    `${result.artist || 'Неизвестен изпълнител'} - ${result.title || 'Файл'}`,
    `Източник: ${result.source || job.source} | Формат: ${job.format.toUpperCase()} ${job.quality}`,
    `${formatDuration(result.duration)} | ${formatFileSize(result.file_size)}`,
    link,
  ].join('\n');

  const sent = await telegramRequest('sendMessage', {
    chat_id: channelId,
    text,
    disable_web_page_preview: false,
    reply_markup: {
      inline_keyboard: [[{ text: 'Свали файла', url: link }]],
    },
  }, env);

  if (!sent.ok) {
    console.warn('Telegram channel publish failed', sent.description);
  }
}

export async function notifyTelegramFailure(job: DownloadJob, errorMessage: string, env: Env): Promise<void> {
  if (!job.chatId) return;
  const text = `❌ Свалянето се провали\n${errorMessage.slice(0, 600)}`;
  if (job.messageId) {
    await editOrSend(job.chatId, job.messageId, env, text);
  } else {
    await sendMessage(job.chatId, env, text);
  }
}

async function ensureTelegramCommands(env: Env): Promise<void> {
  const marker = await env.CACHE.get('tg:commands:bg:v4');
  if (marker === '1') return;

  try {
    await telegramRequest('setMyCommands', {
      commands: [
        { command: 'start', description: 'Старт и меню' },
        { command: 'menu', description: 'Покажи меню' },
        { command: 'settings', description: 'Настройки' },
        { command: 'archive', description: 'Архив' },
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

    await env.CACHE.put('tg:commands:bg:v4', '1', { expirationTtl: 86400 });
  } catch (error) {
    console.warn('Unable to set Telegram commands/menu', error);
  }
}

async function getTelegramSyncedPreferences(
  chatId: number,
  env: Env,
): Promise<Partial<{ language: string; source: string; format: string; quality: string }>> {
  try {
    const row = await env.DB.prepare('SELECT payload FROM user_preferences WHERE sync_key = ? LIMIT 1')
      .bind(telegramSyncKey(chatId))
      .first<{ payload: string }>();
    if (!row?.payload) return {};
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    return {
      language: typeof payload.language === 'string' ? payload.language : undefined,
      source: typeof payload.source === 'string' ? payload.source : undefined,
      format: typeof payload.format === 'string' ? payload.format : undefined,
      quality: typeof payload.quality === 'string' ? payload.quality : undefined,
    };
  } catch {
    return {};
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

function sendMessage(chatId: number, env: Env, text: string, extra?: Record<string, unknown>) {
  return telegramRequest('sendMessage', { chat_id: chatId, text, ...extra }, env);
}

function editMessage(chatId: number, messageId: number, env: Env, text: string, extra?: Record<string, unknown>) {
  return telegramRequest('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra }, env);
}

async function editOrSend(chatId: number, messageId: number, env: Env, text: string, extra?: Record<string, unknown>): Promise<TelegramRequestResult> {
  const edited = await editMessage(chatId, messageId, env, text, extra);
  if (edited.ok) return edited;
  return sendMessage(chatId, env, text, extra);
}

function answerCallback(callbackId: string, env: Env, text?: string) {
  return telegramRequest('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) }, env);
}

function sendAudio(chatId: number, fileUrl: string, title: string, artist: string, duration: number, env: Env) {
  return telegramRequest('sendAudio', {
    chat_id: chatId,
    audio: fileUrl,
    title,
    performer: artist,
    duration,
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
