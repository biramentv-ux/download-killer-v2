import { handleTelegramPlatformWebhook } from './telegram_platform';
import type { Env } from './types';
import { createDownloadToken, rateLimit, readEnvInt } from './utils';

type MasterLanguage = 'bg' | 'en';

type ExtendedEnv = Env & {
  TELEGRAM_BOT_API_BASE?: string;
  TELEGRAM_MINIAPP_PATH?: string;
};

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramInlineQuery {
  id: string;
  from: TelegramUser;
  query: string;
  offset?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  inline_query?: TelegramInlineQuery;
}

interface TelegramApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface ShareableMediaRow {
  id: number;
  job_id: string;
  media_kind: 'audio' | 'document' | 'link';
  telegram_file_id: string | null;
  fallback_url: string | null;
  title: string | null;
  artist: string | null;
  format: string;
  quality: string;
  file_size: number | null;
}

interface JobMenuRow {
  id: string;
  url: string;
  source: string;
  format: string;
  quality: string;
  status: string;
  title: string | null;
  artist: string | null;
  created_at: string;
}

const MASTER_COMMAND_VERSION = 'v1';
const PRIMARY_USERNAME = 'download_killerbot';

const COPY = {
  bg: {
    welcome: [
      '🎧 Download Killer',
      '',
      'Главният език е български. Избери действие от менюто или изпрати име на песен / публичен URL.',
      'Сайтът, Mini App и ботът използват обща опашка, история и Telegram архив.',
    ].join('\n'),
    menuTitle: '🆘 Главно меню\n\nИзбери категория:',
    searchPrompt: '🔎 Напиши име на песен, изпълнител или албум.',
    downloadPrompt: '⬇️ Изпрати публичен URL от поддържан източник.',
    languageTitle: '🌍 Избери език\n\nБългарският остава основният език.',
    help: [
      '🆘 Помощ',
      '',
      '🔎 Търсене – намиране по име',
      '⬇️ Свали URL – обработка на публичен линк',
      '🎧 Моите песни – готовите файлове в Telegram',
      '📤 Споделяне – изпращане към човек, група, канал или чат с друг бот',
      '📥 Опашка – активни задачи',
      '🕘 История – последни задачи',
      '🎚 Формати – описание на качествата',
      '⚙️ Настройки – формат, качество, източници, captions и downloads',
      '🌐 Mini App – пълният графичен интерфейс',
      '',
      'Команди: /menu /search /download /myfiles /share /queue /history /formats /settings /language',
    ].join('\n'),
    formats: [
      '🆘 Формати и качество',
      '',
      '¶ FLAC',
      '• Lossless формат с пълни метаданни и по-малък размер от WAV.',
      '• Подходящ за архив, Hi‑Fi системи и последваща обработка.',
      '• Налични режими: Best / Lossless.',
      '• Реалните bit depth и sample rate зависят от източника. Системата не създава фалшиво 192 kHz качество.',
      '',
      '¶ WAV',
      '• Lossless и некомпресиран звук.',
      '• Много големи файлове и по-ограничени метаданни.',
      '• Отлична съвместимост с редактори и професионален софтуер.',
      '',
      '¶ MP3 320',
      '• Най-високият стандартен MP3 bitrate.',
      '• Добър баланс между качество, размер и съвместимост.',
      '',
      '¶ MP3 128',
      '• По-малък файл и по-ниско качество.',
      '• Подходящ за мобилни устройства и ограничен трафик.',
      '',
      '¶ OGG / OPUS',
      '• По-ефективна компресия от MP3 при сходен bitrate.',
      '• Отлични за streaming, но с по-ограничена поддръжка в някои плеъри.',
      '',
      '¶ M4A',
      '• Добро качество при малък размер и отлична мобилна съвместимост.',
      '',
      '🎶 Избери формата според устройството и предназначението, а не само по най-голямото число.',
    ].join('\n'),
    shareTitle: [
      '📤 Споделяне на моите песни',
      '',
      'Натисни песен и избери човек, група, канал или чат с друг бот.',
      'Съобщението се изпраща от твоя Telegram профил чрез inline режима на Download Killer.',
      '',
      'Другият бот може да получи файла, но дали ще го обработи зависи от неговите команди и настройки.',
    ].join('\n'),
    shareEmpty: '📤 Няма готови песни за споделяне. Първо завърши нова задача.',
    filesEmpty: '🎧 Все още няма готови песни в твоя Telegram архив.',
    queueEmpty: '📥 Нямаш активни задачи.',
    historyEmpty: '🕘 Няма запазена история.',
    inlineDisabled: [
      '⚠️ Inline споделянето още не е активирано за този бот.',
      'В @BotFather изпълни /setinline, избери бота и въведи placeholder, например: „Сподели песен“.',
      'Дотогава можеш да използваш стандартния Telegram бутон Forward върху готовия файл.',
    ].join('\n'),
    settingsTitle: '⚙️ Настройки\n\nИзбери категория:',
  },
  en: {
    welcome: [
      '🎧 Download Killer',
      '',
      'Bulgarian is the primary language. Choose an action or send a song name / public URL.',
      'The website, Mini App and bot share one queue, history and Telegram archive.',
    ].join('\n'),
    menuTitle: '🆘 Main menu\n\nChoose a category:',
    searchPrompt: '🔎 Type a song, artist or album name.',
    downloadPrompt: '⬇️ Send a public URL from a supported source.',
    languageTitle: '🌍 Choose language\n\nBulgarian remains the primary language.',
    help: [
      '🆘 Help',
      '',
      '🔎 Search – find media by name',
      '⬇️ Download URL – process a public link',
      '🎧 My songs – completed Telegram files',
      '📤 Share – send to a user, group, channel or another bot chat',
      '📥 Queue – active jobs',
      '🕘 History – recent jobs',
      '🎚 Formats – quality guide',
      '⚙️ Settings – format, quality, sources, captions and downloads',
      '🌐 Mini App – full graphical interface',
      '',
      'Commands: /menu /search /download /myfiles /share /queue /history /formats /settings /language',
    ].join('\n'),
    formats: [
      '🆘 Formats and quality',
      '',
      '¶ FLAC',
      '• Lossless audio with metadata and smaller files than WAV.',
      '• Suitable for archives, Hi‑Fi playback and editing.',
      '• Available modes: Best / Lossless.',
      '• Real bit depth and sample rate depend on the source. The system does not invent fake 192 kHz quality.',
      '',
      '¶ WAV',
      '• Lossless, uncompressed audio.',
      '• Very large files and more limited metadata.',
      '',
      '¶ MP3 320 / MP3 128',
      '• 320 kbps balances quality and compatibility.',
      '• 128 kbps reduces size for mobile use.',
      '',
      '¶ OGG / OPUS',
      '• Efficient compression and strong streaming quality.',
      '• Some players have more limited support.',
      '',
      '¶ M4A',
      '• Good quality, compact size and strong mobile compatibility.',
    ].join('\n'),
    shareTitle: [
      '📤 Share my songs',
      '',
      'Choose a song, then select a user, group, channel or another bot chat.',
      'The message is sent from your Telegram account through Download Killer inline mode.',
      '',
      'The receiving bot may get the file, but whether it processes it depends on that bot.',
    ].join('\n'),
    shareEmpty: '📤 There are no completed songs to share yet.',
    filesEmpty: '🎧 There are no completed songs in your Telegram archive yet.',
    queueEmpty: '📥 You have no active jobs.',
    historyEmpty: '🕘 No history is available.',
    inlineDisabled: [
      '⚠️ Inline sharing is not enabled for this bot yet.',
      'Use /setinline in @BotFather, choose the bot and set a placeholder such as “Share a song”.',
      'Until then, use Telegram Forward on the completed file.',
    ].join('\n'),
    settingsTitle: '⚙️ Settings\n\nChoose a category:',
  },
} as const;

const LABELS = {
  bg: {
    search: '🔎 Търсене', download: '⬇️ Свали URL', files: '🎧 Моите песни', share: '📤 Споделяне',
    queue: '📥 Опашка', history: '🕘 История', formats: '🎚 Формати', settings: '⚙️ Настройки',
    miniApp: '🌐 Mini App', language: '🌍 Език', help: '🆘 Помощ', menu: '🏠 Меню',
  },
  en: {
    search: '🔎 Search', download: '⬇️ Download URL', files: '🎧 My songs', share: '📤 Share',
    queue: '📥 Queue', history: '🕘 History', formats: '🎚 Formats', settings: '⚙️ Settings',
    miniApp: '🌐 Mini App', language: '🌍 Language', help: '🆘 Help', menu: '🏠 Menu',
  },
} as const;

export function parseShareMediaId(value: string): number | null {
  const match = String(value ?? '').trim().match(/^share:(\d+)$/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function handleTelegramMasterWebhook(request: Request, env: ExtendedEnv): Promise<Response> {
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
    await ensureTelegramMasterCommands(env);
    if (await handleMasterUpdate(update, env)) return Response.json({ ok: true });
  } catch (error) {
    console.error('Telegram master menu update failed', error);
  }

  const replay = new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: rawBody,
  });
  return handleTelegramPlatformWebhook(replay, env);
}

export async function ensureTelegramMasterCommands(env: ExtendedEnv): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const username = botUsername(env).toLowerCase();
  const marker = `tg:master:commands:${MASTER_COMMAND_VERSION}:${username}`;
  if (await env.CACHE.get(marker) === '1') return;

  const bgCommands = [
    { command: 'start', description: 'Старт и главно меню' },
    { command: 'menu', description: 'Главно меню' },
    { command: 'search', description: 'Търсене по име' },
    { command: 'download', description: 'Свали от публичен URL' },
    { command: 'myfiles', description: 'Моите готови песни' },
    { command: 'share', description: 'Сподели готова песен' },
    { command: 'queue', description: 'Активна опашка' },
    { command: 'history', description: 'Последни задачи' },
    { command: 'formats', description: 'Формати и качество' },
    { command: 'settings', description: 'Настройки' },
    { command: 'language', description: 'Смяна на езика' },
    { command: 'site', description: 'Отвори Mini App' },
    { command: 'help', description: 'Помощ' },
  ];
  const enCommands = [
    { command: 'start', description: 'Start and main menu' },
    { command: 'menu', description: 'Main menu' },
    { command: 'search', description: 'Search by name' },
    { command: 'download', description: 'Download from a public URL' },
    { command: 'myfiles', description: 'My completed songs' },
    { command: 'share', description: 'Share a completed song' },
    { command: 'queue', description: 'Active queue' },
    { command: 'history', description: 'Recent jobs' },
    { command: 'formats', description: 'Formats and quality' },
    { command: 'settings', description: 'Settings' },
    { command: 'language', description: 'Change language' },
    { command: 'site', description: 'Open Mini App' },
    { command: 'help', description: 'Help' },
  ];

  const results = await Promise.all([
    telegramRequest('setMyCommands', { commands: bgCommands }, env),
    telegramRequest('setMyCommands', { commands: bgCommands, language_code: 'bg' }, env),
    telegramRequest('setMyCommands', { commands: enCommands, language_code: 'en' }, env),
    telegramRequest('setMyDescription', {
      description: 'Download Killer: търсене, обща опашка, формати, Telegram архив и споделяне на готови песни.',
      language_code: 'bg',
    }, env),
    telegramRequest('setMyShortDescription', {
      short_description: 'BG меню, музикални формати, архив и споделяне.',
      language_code: 'bg',
    }, env),
  ]);
  if (results.every((result) => result.ok)) {
    await env.CACHE.put(marker, '1', { expirationTtl: 86400 });
  }
}

async function handleMasterUpdate(update: TelegramUpdate, env: ExtendedEnv): Promise<boolean> {
  if (update.inline_query) {
    await handleInlineQuery(update.inline_query, env);
    return true;
  }
  if (update.callback_query) return handleMasterCallback(update.callback_query, env);

  const message = update.message;
  if (!message || message.chat.type !== 'private') return false;
  const text = String(message.text ?? '').trim();
  if (!text) return false;

  const limited = await rateLimit(env.CACHE, `tg:master:${message.chat.id}`, 45, 60);
  if (limited.limited) return false;

  const language = await getLanguage(message.chat.id, env);
  const label = text.toLowerCase();
  const command = parseCommand(text);
  if (command.name === '/start' && command.args.startsWith('job_')) return false;

  if (command.name === '/start' || command.name === '/menu' || isMenuLabel(label, 'menu')) {
    await sendMasterMenu(message.chat.id, language, env, command.name === '/start');
    return true;
  }
  if (command.name === '/formats' || isMenuLabel(label, 'formats')) {
    await sendFormats(message.chat.id, language, env);
    return true;
  }
  if (command.name === '/language' || isMenuLabel(label, 'language')) {
    await sendLanguagePicker(message.chat.id, language, env);
    return true;
  }
  if (command.name === '/share' || isMenuLabel(label, 'share')) {
    await sendShareMenu(message.chat.id, language, env);
    return true;
  }
  if (command.name === '/myfiles' || isMenuLabel(label, 'files')) {
    await sendMySongs(message.chat.id, language, env);
    return true;
  }
  if (command.name === '/queue' || isMenuLabel(label, 'queue')) {
    await sendQueue(message.chat.id, language, env);
    return true;
  }
  if (command.name === '/history' || isMenuLabel(label, 'history')) {
    await sendHistory(message.chat.id, language, env);
    return true;
  }
  if (command.name === '/settings' || isMenuLabel(label, 'settings')) {
    await sendSettingsMenu(message.chat.id, language, env);
    return true;
  }
  if (command.name === '/help' || isMenuLabel(label, 'help')) {
    await sendMessage(message.chat.id, COPY[language].help, env, replyKeyboard(language, env));
    return true;
  }
  if (command.name === '/search' || isMenuLabel(label, 'search')) {
    await sendMessage(message.chat.id, COPY[language].searchPrompt, env, replyKeyboard(language, env));
    return true;
  }
  if (command.name === '/download' || isMenuLabel(label, 'download')) {
    await sendMessage(message.chat.id, COPY[language].downloadPrompt, env, replyKeyboard(language, env));
    return true;
  }

  return false;
}

async function handleMasterCallback(query: TelegramCallbackQuery, env: ExtendedEnv): Promise<boolean> {
  const data = String(query.data ?? '');
  if (!data.startsWith('master:')) return false;
  await telegramRequest('answerCallbackQuery', { callback_query_id: query.id }, env);
  const chatId = query.message?.chat.id ?? query.from.id;
  const language = await getLanguage(chatId, env);

  if (data === 'master:home') await sendMasterMenu(chatId, language, env, false);
  else if (data === 'master:search') await sendMessage(chatId, COPY[language].searchPrompt, env, replyKeyboard(language, env));
  else if (data === 'master:download') await sendMessage(chatId, COPY[language].downloadPrompt, env, replyKeyboard(language, env));
  else if (data === 'master:formats') await sendFormats(chatId, language, env);
  else if (data === 'master:settings') await sendSettingsMenu(chatId, language, env);
  else if (data === 'master:language') await sendLanguagePicker(chatId, language, env);
  else if (data === 'master:share') await sendShareMenu(chatId, language, env);
  else if (data === 'master:myfiles') await sendMySongs(chatId, language, env);
  else if (data === 'master:queue') await sendQueue(chatId, language, env);
  else if (data === 'master:history') await sendHistory(chatId, language, env);
  else if (data === 'master:help') await sendMessage(chatId, COPY[language].help, env, replyKeyboard(language, env));
  else if (data === 'master:lang:bg' || data === 'master:lang:en') {
    const nextLanguage: MasterLanguage = data.endsWith(':en') ? 'en' : 'bg';
    await env.CACHE.put(`tg:v10:lang:${chatId}`, nextLanguage, { expirationTtl: 365 * 86400 });
    await sendMasterMenu(chatId, nextLanguage, env, false);
  }
  return true;
}

async function sendMasterMenu(chatId: number, language: MasterLanguage, env: ExtendedEnv, includeWelcome: boolean): Promise<void> {
  if (includeWelcome) {
    await sendMessage(chatId, COPY[language].welcome, env, replyKeyboard(language, env));
  }
  const labels = LABELS[language];
  await sendMessage(chatId, COPY[language].menuTitle, env, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: labels.search, callback_data: 'master:search' },
          { text: labels.download, callback_data: 'master:download' },
        ],
        [
          { text: labels.files, callback_data: 'master:myfiles' },
          { text: labels.share, callback_data: 'master:share' },
        ],
        [
          { text: labels.queue, callback_data: 'master:queue' },
          { text: labels.history, callback_data: 'master:history' },
        ],
        [{ text: labels.formats, callback_data: 'master:formats' }],
        [
          { text: labels.settings, callback_data: 'master:settings' },
          { text: labels.miniApp, web_app: { url: miniAppUrl(env) } },
        ],
        [
          { text: labels.language, callback_data: 'master:language' },
          { text: labels.help, callback_data: 'master:help' },
        ],
      ],
    },
  });
}

async function sendSettingsMenu(chatId: number, language: MasterLanguage, env: ExtendedEnv): Promise<void> {
  await sendMessage(chatId, COPY[language].settingsTitle, env, {
    reply_markup: {
      inline_keyboard: [
        [{ text: language === 'bg' ? '⚙️ Общи' : '⚙️ General', callback_data: 's:general' }],
        [{ text: language === 'bg' ? '🔊 Качество и информация' : '🔊 Quality and information', callback_data: 's:tier' }],
        [{ text: language === 'bg' ? '📥 Изтегляния' : '📥 Downloads', callback_data: 's:downloads' }],
        [{ text: language === 'bg' ? '📝 Надписи и шаблони' : '📝 Captions and templates', callback_data: 's:captions' }],
        [{ text: language === 'bg' ? '🎚 Ръководство за форматите' : '🎚 Formats guide', callback_data: 'master:formats' }],
        [{ text: language === 'bg' ? '📤 Споделяне' : '📤 Sharing', callback_data: 'master:share' }],
        [{ text: language === 'bg' ? '🏠 Главно меню' : '🏠 Main menu', callback_data: 'master:home' }],
      ],
    },
  });
}

async function sendFormats(chatId: number, language: MasterLanguage, env: ExtendedEnv): Promise<void> {
  await sendMessage(chatId, COPY[language].formats, env, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: language === 'bg' ? '🎛 Избери качество' : '🎛 Choose quality', callback_data: 's:tier' },
          { text: language === 'bg' ? '⚙️ Настройки' : '⚙️ Settings', callback_data: 's:open' },
        ],
        [{ text: language === 'bg' ? '🏠 Главно меню' : '🏠 Main menu', callback_data: 'master:home' }],
      ],
    },
  });
}

async function sendLanguagePicker(chatId: number, language: MasterLanguage, env: ExtendedEnv): Promise<void> {
  await sendMessage(chatId, COPY[language].languageTitle, env, {
    reply_markup: {
      inline_keyboard: [[
        { text: '🇧🇬 Български', callback_data: 'master:lang:bg' },
        { text: '🇬🇧 English', callback_data: 'master:lang:en' },
      ]],
    },
  });
}

async function sendQueue(chatId: number, language: MasterLanguage, env: ExtendedEnv): Promise<void> {
  const rows = await listJobs(chatId, env, true);
  if (!rows.length) {
    await sendMessage(chatId, COPY[language].queueEmpty, env, replyKeyboard(language, env));
    return;
  }
  const title = language === 'bg' ? '📥 Активна опашка' : '📥 Active queue';
  const body = rows.map((row, index) => formatJobRow(row, index, language)).join('\n\n');
  await sendMessage(chatId, `${title}\n\n${body}`, env, {
    reply_markup: {
      inline_keyboard: [[
        { text: language === 'bg' ? '🔄 Обнови' : '🔄 Refresh', callback_data: 'master:queue' },
        { text: language === 'bg' ? '🏠 Меню' : '🏠 Menu', callback_data: 'master:home' },
      ]],
    },
  });
}

async function sendHistory(chatId: number, language: MasterLanguage, env: ExtendedEnv): Promise<void> {
  const rows = await listJobs(chatId, env, false);
  if (!rows.length) {
    await sendMessage(chatId, COPY[language].historyEmpty, env, replyKeyboard(language, env));
    return;
  }
  const title = language === 'bg' ? '🕘 Последни задачи' : '🕘 Recent jobs';
  const body = rows.map((row, index) => formatJobRow(row, index, language)).join('\n\n');
  await sendMessage(chatId, `${title}\n\n${body}`, env, {
    reply_markup: {
      inline_keyboard: [[
        { text: language === 'bg' ? '🔄 Обнови' : '🔄 Refresh', callback_data: 'master:history' },
        { text: language === 'bg' ? '🎧 Моите песни' : '🎧 My songs', callback_data: 'master:myfiles' },
      ]],
    },
  });
}

async function sendMySongs(chatId: number, language: MasterLanguage, env: ExtendedEnv): Promise<void> {
  const rows = await listShareableMedia(chatId, env, 8);
  if (!rows.length) {
    await sendMessage(chatId, COPY[language].filesEmpty, env, replyKeyboard(language, env));
    return;
  }
  const inlineEnabled = await supportsInlineQueries(env);
  const keyboard: Array<Array<Record<string, unknown>>> = rows.map((row) => {
    const actions: Array<Record<string, unknown>> = [{
      text: `🎵 ${(row.artist || '—').slice(0, 18)} - ${(row.title || 'Файл').slice(0, 22)}`,
      callback_data: `v10:file:${row.id}`,
    }];
    if (inlineEnabled) actions.push(shareButton(row.id));
    return actions;
  });
  keyboard.push([
    { text: language === 'bg' ? '📤 Всички опции за споделяне' : '📤 Sharing options', callback_data: 'master:share' },
    { text: language === 'bg' ? '🏠 Меню' : '🏠 Menu', callback_data: 'master:home' },
  ]);
  const title = language === 'bg'
    ? `🎧 Моите песни\nГотови файлове: ${rows.length}`
    : `🎧 My songs\nCompleted files: ${rows.length}`;
  await sendMessage(chatId, title, env, { reply_markup: { inline_keyboard: keyboard } });
}

async function sendShareMenu(chatId: number, language: MasterLanguage, env: ExtendedEnv): Promise<void> {
  if (!await supportsInlineQueries(env)) {
    await sendMessage(chatId, COPY[language].inlineDisabled, env, replyKeyboard(language, env));
    return;
  }

  const rows = await listShareableMedia(chatId, env, 8);
  if (!rows.length) {
    await sendMessage(chatId, COPY[language].shareEmpty, env, replyKeyboard(language, env));
    return;
  }

  const keyboard: Array<Array<Record<string, unknown>>> = rows.map((row) => [{
    text: `📤 ${(row.artist || '—').slice(0, 20)} - ${(row.title || 'Файл').slice(0, 24)}`,
    ...shareButtonPayload(row.id),
  }]);
  keyboard.push([{ text: language === 'bg' ? '🏠 Главно меню' : '🏠 Main menu', callback_data: 'master:home' }]);
  await sendMessage(chatId, COPY[language].shareTitle, env, { reply_markup: { inline_keyboard: keyboard } });
}

function shareButton(mediaId: number): Record<string, unknown> {
  return { text: '📤', ...shareButtonPayload(mediaId) };
}

function shareButtonPayload(mediaId: number): Record<string, unknown> {
  return {
    switch_inline_query_chosen_chat: {
      query: `share:${mediaId}`,
      allow_user_chats: true,
      allow_bot_chats: true,
      allow_group_chats: true,
      allow_channel_chats: true,
    },
  };
}

async function handleInlineQuery(query: TelegramInlineQuery, env: ExtendedEnv): Promise<void> {
  const mediaId = parseShareMediaId(query.query);
  if (!mediaId) {
    await answerInlineQuery(query.id, [], env);
    return;
  }

  const media = await loadOwnedMedia(query.from.id, mediaId, env);
  if (!media) {
    await answerInlineQuery(query.id, [], env);
    return;
  }

  const caption = [
    `🎵 ${media.artist || '—'} - ${media.title || 'Файл'}`,
    `🎧 ${media.format.toUpperCase()} ${media.quality}`,
    `🤖 @${botUsername(env)}`,
  ].join('\n');
  const resultId = `${media.media_kind.slice(0, 1)}_${media.id}`.slice(0, 64);
  const isPrimary = botUsername(env).toLowerCase() === PRIMARY_USERNAME;
  let result: Record<string, unknown>;

  if (isPrimary && media.telegram_file_id && media.media_kind === 'audio') {
    result = {
      type: 'audio',
      id: resultId,
      audio_file_id: media.telegram_file_id,
      caption,
    };
  } else if (isPrimary && media.telegram_file_id && media.media_kind === 'document') {
    result = {
      type: 'document',
      id: resultId,
      title: `${media.artist || '—'} - ${media.title || 'Файл'}`.slice(0, 256),
      document_file_id: media.telegram_file_id,
      description: `${media.format.toUpperCase()} ${media.quality}`,
      caption,
    };
  } else {
    const freshUrl = await createFreshDownloadUrl(media.job_id, env);
    result = {
      type: 'article',
      id: resultId,
      title: `${media.artist || '—'} - ${media.title || 'Файл'}`.slice(0, 256),
      description: `${media.format.toUpperCase()} ${media.quality}`,
      input_message_content: {
        message_text: `${caption}\n\n⬇️ ${freshUrl}`,
        disable_web_page_preview: false,
      },
      reply_markup: {
        inline_keyboard: [[{ text: '⬇️ Download Killer', url: freshUrl }]],
      },
    };
  }

  await answerInlineQuery(query.id, [result], env);
}

async function listJobs(chatId: number, env: ExtendedEnv, activeOnly: boolean): Promise<JobMenuRow[]> {
  const condition = activeOnly ? "AND status IN ('queued', 'processing', 'paused')" : '';
  const result = await env.DB.prepare(
    `SELECT id, url, source, format, quality, status, title, artist, created_at
     FROM download_jobs
     WHERE chat_id = ? ${condition}
     ORDER BY created_at DESC
     LIMIT 10`,
  ).bind(chatId).all<JobMenuRow>();
  return result.results ?? [];
}

async function listShareableMedia(chatId: number, env: ExtendedEnv, limit: number): Promise<ShareableMediaRow[]> {
  const result = await env.DB.prepare(
    `WITH owned_media AS (
       SELECT m.id, j.id AS job_id, m.media_kind, m.telegram_file_id, m.fallback_url,
              m.title, m.artist, m.format, m.quality, m.file_size,
              ROW_NUMBER() OVER (PARTITION BY m.id ORDER BY j.created_at DESC) AS row_number
       FROM telegram_media_objects m
       JOIN download_jobs j
         ON j.id = m.job_id
         OR (m.content_hash IS NOT NULL AND j.content_hash = m.content_hash AND j.format = m.format)
       WHERE j.chat_id = ? AND j.status = 'done'
     )
     SELECT id, job_id, media_kind, telegram_file_id, fallback_url,
            title, artist, format, quality, file_size
     FROM owned_media
     WHERE row_number = 1
     ORDER BY id DESC
     LIMIT ?`,
  ).bind(chatId, Math.max(1, Math.min(20, limit))).all<ShareableMediaRow>();
  return result.results ?? [];
}

async function loadOwnedMedia(chatId: number, mediaId: number, env: ExtendedEnv): Promise<ShareableMediaRow | null> {
  return env.DB.prepare(
    `SELECT m.id, j.id AS job_id, m.media_kind, m.telegram_file_id, m.fallback_url,
            m.title, m.artist, m.format, m.quality, m.file_size
     FROM telegram_media_objects m
     JOIN download_jobs j
       ON j.id = m.job_id
       OR (m.content_hash IS NOT NULL AND j.content_hash = m.content_hash AND j.format = m.format)
     WHERE m.id = ? AND j.chat_id = ? AND j.status = 'done'
     ORDER BY j.created_at DESC
     LIMIT 1`,
  ).bind(mediaId, chatId).first<ShareableMediaRow>();
}

function replyKeyboard(language: MasterLanguage, env: ExtendedEnv): Record<string, unknown> {
  const labels = LABELS[language];
  return {
    reply_markup: {
      keyboard: [
        [{ text: labels.search }, { text: labels.download }],
        [{ text: labels.files }, { text: labels.share }],
        [{ text: labels.queue }, { text: labels.history }],
        [{ text: labels.formats }, { text: labels.settings }],
        [{ text: labels.miniApp, web_app: { url: miniAppUrl(env) } }, { text: labels.language }],
        [{ text: labels.help }, { text: labels.menu }],
      ],
      resize_keyboard: true,
      is_persistent: true,
      input_field_placeholder: language === 'bg' ? 'Име на песен или публичен URL…' : 'Song name or public URL…',
    },
  };
}

function isMenuLabel(value: string, key: keyof typeof LABELS.bg): boolean {
  return value === LABELS.bg[key].toLowerCase() || value === LABELS.en[key].toLowerCase();
}

function formatJobRow(row: JobMenuRow, index: number, language: MasterLanguage): string {
  const title = row.title || shortUrl(row.url);
  const artist = row.artist || '—';
  return `${index + 1}. ${statusIcon(row.status)} ${artist} - ${title}\n   ${row.format.toUpperCase()} ${row.quality} · ${statusLabel(row.status, language)} · #${row.id.slice(0, 8)}`;
}

function statusIcon(status: string): string {
  if (status === 'done') return '✅';
  if (status === 'failed') return '❌';
  if (status === 'processing') return '⚙️';
  if (status === 'paused') return '⏸';
  return '⏳';
}

function statusLabel(status: string, language: MasterLanguage): string {
  const labels: Record<MasterLanguage, Record<string, string>> = {
    bg: { queued: 'чака', processing: 'обработва се', paused: 'пауза', done: 'готово', failed: 'грешка' },
    en: { queued: 'queued', processing: 'processing', paused: 'paused', done: 'done', failed: 'failed' },
  };
  return labels[language][status] ?? status;
}

function shortUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.slice(0, 50);
  } catch {
    return value.slice(0, 50);
  }
}

async function getLanguage(chatId: number, env: ExtendedEnv): Promise<MasterLanguage> {
  return await env.CACHE.get(`tg:v10:lang:${chatId}`) === 'en' ? 'en' : 'bg';
}

async function supportsInlineQueries(env: ExtendedEnv): Promise<boolean> {
  const key = `tg:inline:supported:${botUsername(env).toLowerCase()}`;
  const cached = await env.CACHE.get(key);
  if (cached === '1') return true;
  if (cached === '0') return false;
  const response = await telegramRequest<{ supports_inline_queries?: boolean }>('getMe', {}, env);
  const supported = Boolean(response.ok && response.result?.supports_inline_queries);
  await env.CACHE.put(key, supported ? '1' : '0', { expirationTtl: 600 });
  return supported;
}

async function createFreshDownloadUrl(jobId: string, env: ExtendedEnv): Promise<string> {
  const ttl = readEnvInt(env.DOWNLOAD_TOKEN_TTL_SECONDS, 3600);
  const token = await createDownloadToken({ jobId, exp: Math.floor(Date.now() / 1000) + ttl }, env.DOWNLOAD_TOKEN_SECRET);
  return `${publicBaseUrl(env)}/api/file/${encodeURIComponent(token)}`;
}

async function answerInlineQuery(inlineQueryId: string, results: Record<string, unknown>[], env: ExtendedEnv): Promise<void> {
  await telegramRequest('answerInlineQuery', {
    inline_query_id: inlineQueryId,
    results,
    cache_time: 1,
    is_personal: true,
  }, env);
}

async function sendMessage(
  chatId: number,
  text: string,
  env: ExtendedEnv,
  extra: Record<string, unknown> = {},
): Promise<TelegramApiResponse> {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text: text.slice(0, 4096),
    disable_web_page_preview: true,
    ...extra,
  }, env);
}

async function telegramRequest<T = unknown>(
  method: string,
  payload: Record<string, unknown>,
  env: ExtendedEnv,
): Promise<TelegramApiResponse<T>> {
  const token = String(env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) return { ok: false, description: 'Telegram bot token is missing' };
  const base = String(env.TELEGRAM_BOT_API_BASE ?? 'https://api.telegram.org').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await response.json() as TelegramApiResponse<T>;
  } catch (error) {
    return { ok: false, description: error instanceof Error ? error.message : String(error) };
  }
}

function parseCommand(text: string): { name: string; args: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { name: '', args: '' };
  const [head = '', ...rest] = trimmed.split(/\s+/);
  return { name: head.split('@')[0]?.toLowerCase() ?? '', args: rest.join(' ').trim() };
}

function miniAppUrl(env: ExtendedEnv): string {
  const path = String(env.TELEGRAM_MINIAPP_PATH ?? '/telegram/');
  return `${publicBaseUrl(env)}${path.startsWith('/') ? path : `/${path}`}`;
}

function publicBaseUrl(env: ExtendedEnv): string {
  return String(env.PUBLIC_BASE_URL ?? 'https://dyrakarmy.eu').replace(/\/+$/, '');
}

function botUsername(env: ExtendedEnv): string {
  return String(env.TELEGRAM_BOT_USERNAME ?? 'dyrakarmy_bot').replace(/^@+/, '');
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}
