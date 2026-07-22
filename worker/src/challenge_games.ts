import type { Env } from './types';
import { latencyStrikeRank, latencyStrikeWeekKey } from './latency_strike';
import { applyD1SchemaStatements } from './schema';
import { validateTelegramInitData } from './telegram_platform';
import { rateLimit, readEnvInt } from './utils';

type ExtendedEnv = Env & { TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS?: string };

export type ChallengeGameSlug =
  | 'queue-commander'
  | 'beat-hunter'
  | 'format-forge'
  | 'server-defender'
  | 'metadata-detective'
  | 'link-runner'
  | 'bot-vs-human';

type ChallengeMode = 'priority' | 'rhythm' | 'format' | 'defense' | 'detective' | 'route' | 'classification';

interface TelegramChallengeUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface ChallengeQuestion {
  id: string;
  prompt: string;
  options: string[];
  correct: number;
  explanation: string;
}

export interface ChallengeGameDefinition {
  slug: ChallengeGameSlug;
  number: number;
  title: string;
  icon: string;
  command: string;
  mode: ChallengeMode;
  description: string;
  rounds: number;
  daily_attempts: number;
  score_multiplier: number;
  reward_id: string;
  reward_label: string;
  questions: ChallengeQuestion[];
}

interface ChallengeAnswerInput {
  question_id?: string;
  option_index?: number;
  response_ms?: number;
}

interface ChallengeSession {
  game: ChallengeGameSlug;
  user_id: number;
  practice: boolean;
  day_key: string;
  question_ids: string[];
  issued_at: number;
}

export interface ChallengeScore {
  score: number;
  xp: number;
  correct: number;
  total: number;
  accuracy: number;
  avg_response_ms: number;
  best_combo: number;
  reward_unlocked: boolean;
}

const SESSION_TTL_SECONDS = 900;

export const CHALLENGE_GAMES: Record<ChallengeGameSlug, ChallengeGameDefinition> = {
  'queue-commander': {
    slug: 'queue-commander', number: 1, title: 'Queue Commander', icon: '📡', command: 'queuegame', mode: 'priority',
    description: 'Подреждай задачи, управлявай retry логика и пази опашката стабилна.', rounds: 6, daily_attempts: 3, score_multiplier: 1.05,
    reward_id: 'title_queue_commander', reward_label: 'Queue Commander title',
    questions: [
      { id: 'qc-expiring', prompt: 'Коя задача трябва да бъде първа?', options: ['Нова заявка без срок', 'Задача с изтичащ signed URL', 'Архивна статистика', 'Duplicate job'], correct: 1, explanation: 'Изтичащият URL има най-малък времеви прозорец.' },
      { id: 'qc-429', prompt: 'Origin връща HTTP 429. Как реагира стабилната опашка?', options: ['Retry по Retry-After', 'Безкраен tight loop', 'Изтрива всички задачи', 'Маркира задачата done'], correct: 0, explanation: 'Retry-After и backoff пазят origin-а и потребителите.' },
      { id: 'qc-dedupe', prompt: 'Две еднакви заявки пристигат едновременно.', options: ['Двойна обработка', 'Dedupe и общ резултат', 'Случайно изтриване', 'Спиране на Worker'], correct: 1, explanation: 'Dedupe предотвратява излишна работа.' },
      { id: 'qc-poison', prompt: 'Една задача се проваля след максималния брой retry.', options: ['Връща се в началото завинаги', 'Премества се в dead-letter поток', 'Изключва D1', 'Пуска се 100 пъти'], correct: 1, explanation: 'Dead-letter потокът изолира poison задачите.' },
      { id: 'qc-priority', prompt: 'Кое поле е най-полезно за справедлива priority queue?', options: ['Цвят на UI', 'Приоритет плюс време на заявката', 'Размер на favicon', 'Име на branch'], correct: 1, explanation: 'Приоритетът трябва да пази и fairness по време.' },
      { id: 'qc-idempotency', prompt: 'Защо е нужен idempotency key?', options: ['За дизайн', 'За да не се изпълни една операция два пъти', 'За по-голям JSON', 'За DNS кеш'], correct: 1, explanation: 'Idempotency защитава при повторени заявки.' },
      { id: 'qc-backlog', prompt: 'Backlog расте бързо. Първата безопасна стъпка е:', options: ['Повече concurrency без лимит', 'Измерване на bottleneck и контролирано scaling', 'Изтриване на history', 'Премахване на rate limit'], correct: 1, explanation: 'Scaling без измерване може да срине origin-а.' },
      { id: 'qc-timeout', prompt: 'Worker задача стои твърде дълго в processing.', options: ['Lease timeout и requeue', 'Оставя се завинаги', 'Скрива се от UI', 'Променя се favicon'], correct: 0, explanation: 'Lease timeout възстановява блокирани задачи.' },
    ],
  },
  'beat-hunter': {
    slug: 'beat-hunter', number: 2, title: 'Beat Hunter', icon: '🥁', command: 'beat', mode: 'rhythm',
    description: 'Разпознавай ритмични модели, тактове и DJ структура.', rounds: 6, daily_attempts: 3, score_multiplier: 1.12,
    reward_id: 'waveform_beat_hunter', reward_label: 'Beat Hunter waveform',
    questions: [
      { id: 'bh-four', prompt: 'Къде пада kick-ът при стандартен four-on-the-floor?', options: ['На всяка четвъртина', 'Само на 2 и 4', 'Само в края', 'Случайно'], correct: 0, explanation: 'Kick на всяка четвъртина е основата на много techno ритми.' },
      { id: 'bh-backbeat', prompt: 'Къде обикновено стои clap/snare в 4/4?', options: ['1 и 3', '2 и 4', 'Само 1', 'Между всеки такт'], correct: 1, explanation: 'Backbeat позициите са 2 и 4.' },
      { id: 'bh-phrase', prompt: 'Колко такта често образуват кратка DJ фраза?', options: ['3', '4 или 8', '5', '11'], correct: 1, explanation: 'Фразите често са групирани по 4, 8, 16 или 32 такта.' },
      { id: 'bh-sync', prompt: 'Два трака са с еднакво BPM, но звучат разместени.', options: ['Фазата/beatgrid е разместена', 'Форматът е FLAC', 'Името е грешно', 'Няма waveform'], correct: 0, explanation: 'Tempo sync не гарантира фазово подравняване.' },
      { id: 'bh-break', prompt: 'Каква е ролята на breakdown-а?', options: ['Намалява енергията преди build/drop', 'Ускорява файла', 'Променя metadata', 'Спира master clock'], correct: 0, explanation: 'Breakdown създава контраст и напрежение.' },
      { id: 'bh-cue', prompt: 'Най-доброто място за hot cue при вход в микс е:', options: ['Ясен downbeat', 'Случайна тишина', 'Последната секунда', 'Средата на вокал'], correct: 0, explanation: 'Ясният downbeat дава надеждна стартова точка.' },
      { id: 'bh-swing', prompt: 'Swing променя главно:', options: ['Времето между subdivision-ите', 'Sample rate', 'Cover art', 'URL схемата'], correct: 0, explanation: 'Swing измества микро-времето на подразделенията.' },
      { id: 'bh-clipping', prompt: 'Червен master meter означава:', options: ['Възможен clipping', 'Перфектен headroom', 'Нисък BPM', 'Липсващ жанр'], correct: 0, explanation: 'Червеният meter обикновено показва претоварване.' },
    ],
  },
  'format-forge': {
    slug: 'format-forge', number: 4, title: 'Format Forge', icon: '⚒', command: 'formatgame', mode: 'format',
    description: 'Избирай правилния формат и качество според устройството и целта.', rounds: 6, daily_attempts: 3, score_multiplier: 1.08,
    reward_id: 'badge_format_forge', reward_label: 'Format Forge badge',
    questions: [
      { id: 'ff-ios', prompt: 'Най-добър баланс за iPhone и малък размер?', options: ['M4A/AAC', 'WAV', 'BMP', 'TXT'], correct: 0, explanation: 'AAC в M4A има широка iOS поддръжка.' },
      { id: 'ff-lossless', prompt: 'Lossless формат, по-компактен от WAV:', options: ['MP3', 'FLAC', 'AAC 96', 'OGG 64'], correct: 1, explanation: 'FLAC компресира без загуба.' },
      { id: 'ff-edit', prompt: 'За последваща студийна обработка е най-подходящ:', options: ['WAV/FLAC', 'MP3 96', 'Thumbnail', 'JSON'], correct: 0, explanation: 'Lossless форматите пазят максимално качество.' },
      { id: 'ff-voice', prompt: 'За реч при нисък bitrate е силен избор:', options: ['Opus', 'BMP', 'WAV 32-bit винаги', 'CSV'], correct: 0, explanation: 'Opus е ефективен при реч и ниски bitrate-и.' },
      { id: 'ff-compat', prompt: 'Най-универсален компресиран аудио формат:', options: ['MP3', 'RAW PCM', 'AIFF metadata only', 'SVG'], correct: 0, explanation: 'MP3 има най-широка съвместимост.' },
      { id: 'ff-bitrate', prompt: 'По-високият bitrate обикновено означава:', options: ['По-голям файл и потенциално по-добро качество', 'По-малък файл винаги', 'Повече cover art', 'По-бърз DNS'], correct: 0, explanation: 'Bitrate е количество данни за единица време.' },
      { id: 'ff-transcode', prompt: 'MP3 към FLAC ще възстанови ли изгубеното качество?', options: ['Не', 'Да напълно', 'Само при 320 kbps', 'Само в Telegram'], correct: 0, explanation: 'Lossy загубата не може да бъде възстановена чрез transcode.' },
      { id: 'ff-sample', prompt: '44.1 kHz е традиционно свързано с:', options: ['Аудио CD', '4K видео', 'DNS', 'PDF'], correct: 0, explanation: '44.1 kHz е стандартната CD честота.' },
    ],
  },
  'server-defender': {
    slug: 'server-defender', number: 5, title: 'Server Defender', icon: '🛡', command: 'defender', mode: 'defense',
    description: 'Защитавай Worker-а, origin-ите, D1 и Telegram webhook-а.', rounds: 6, daily_attempts: 3, score_multiplier: 1.15,
    reward_id: 'frame_server_defender', reward_label: 'Server Defender frame',
    questions: [
      { id: 'sd-ssrf', prompt: 'Заявка сочи към http://127.0.0.1/admin.', options: ['Блокирай SSRF', 'Разреши', 'Прати в Telegram', 'Кеширай завинаги'], correct: 0, explanation: 'Loopback и private адресите трябва да бъдат блокирани.' },
      { id: 'sd-token', prompt: 'Къде се пази bot token?', options: ['Cloudflare secret', 'Public README', 'HTML data attribute', 'Branch name'], correct: 0, explanation: 'Secrets не се commit-ват.' },
      { id: 'sd-webhook', prompt: 'Webhook заявката трябва да се валидира чрез:', options: ['Secret token header', 'User-Agent само', 'Цвят на бутона', 'Размер на body'], correct: 0, explanation: 'Telegram secret token header удостоверява webhook-а.' },
      { id: 'sd-cors', prompt: 'CORS трябва да разрешава:', options: ['Само одобрени origins', '* с credentials', 'Всеки file:// URL', 'Никой включително сайта'], correct: 0, explanation: 'Allowlist е безопасният модел.' },
      { id: 'sd-injection', prompt: 'Потребителски текст влиза в SQL.', options: ['Prepared statement', 'String concatenation', 'eval', 'innerHTML'], correct: 0, explanation: 'Prepared statements предотвратяват SQL injection.' },
      { id: 'sd-rate', prompt: 'Публичен endpoint е spam-ван.', options: ['Rate limiting', 'Премахване на auth', 'Повече debug output', 'Изключване на logs'], correct: 0, explanation: 'Rate limiting ограничава abuse.' },
      { id: 'sd-headers', prompt: 'Кой header помага срещу MIME sniffing?', options: ['X-Content-Type-Options: nosniff', 'Retry-After', 'ETag', 'Accept-Language'], correct: 0, explanation: 'nosniff предотвратява интерпретация като друг тип.' },
      { id: 'sd-leak', prompt: 'Грешка съдържа API token.', options: ['Редактирай/скрий секрета', 'Покажи го в UI', 'Прати го в analytics', 'Commit-ни го'], correct: 0, explanation: 'Логовете и грешките не трябва да излагат secrets.' },
    ],
  },
  'metadata-detective': {
    slug: 'metadata-detective', number: 6, title: 'Metadata Detective', icon: '🕵', command: 'detective', mode: 'detective',
    description: 'Откривай грешни artist, title, album, year и cover данни.', rounds: 6, daily_attempts: 3, score_multiplier: 1.1,
    reward_id: 'icon_metadata_detective', reward_label: 'Metadata Detective icon',
    questions: [
      { id: 'md-title', prompt: 'Файлът е „Artist - Track (Remix).mp3“. Най-вероятният title е:', options: ['Track (Remix)', 'Artist', 'mp3', 'Unknown'], correct: 0, explanation: 'Title е частта след artist разделителя.' },
      { id: 'md-year', prompt: 'Release date е 2024-11-03. Year tag трябва да е:', options: ['2024', '11', '03', '20241103'], correct: 0, explanation: 'Year tag пази годината.' },
      { id: 'md-albumartist', prompt: 'Compilation с различни изпълнители.', options: ['Album Artist = Various Artists', 'Artist = Unknown за всички', 'Без album', 'Year = 0'], correct: 0, explanation: 'Various Artists групира compilation албума.' },
      { id: 'md-cover', prompt: 'Cover image е огромен PNG 20 MB.', options: ['Оптимизирай разумно JPEG/PNG', 'Вгради го 10 пъти', 'Премахни title', 'Промени BPM'], correct: 0, explanation: 'Оптимизираният cover намалява файла без да руши metadata.' },
      { id: 'md-track', prompt: 'Track 3 от 12 се записва като:', options: ['3/12', '12/3', '00312', 'Track'], correct: 0, explanation: 'Стандартното представяне е текущ/общ брой.' },
      { id: 'md-encoding', prompt: 'Кирилицата изглежда като странни символи.', options: ['Провери UTF-8/encoding', 'Увеличи bitrate', 'Промени sample rate', 'Изтрий cover'], correct: 0, explanation: 'Проблемът е кодировка, не аудио качество.' },
      { id: 'md-bpm', prompt: 'BPM tag е 0, но анализът намира 138.', options: ['Обнови BPM на 138 след проверка', 'Остави 0 винаги', 'Запиши 138 Hz', 'Смени жанра'], correct: 0, explanation: 'Анализираният BPM може да попълни липсващ tag.' },
      { id: 'md-isrc', prompt: 'ISRC е:', options: ['Идентификатор на звукозапис', 'Формат за cover', 'Тип bitrate', 'Telegram command'], correct: 0, explanation: 'ISRC идентифицира конкретен звукозапис.' },
    ],
  },
  'link-runner': {
    slug: 'link-runner', number: 7, title: 'Link Runner', icon: '🔗', command: 'linkrunner', mode: 'route',
    description: 'Следвай безопасни redirects и разпознавай валидни публични URL маршрути.', rounds: 6, daily_attempts: 3, score_multiplier: 1.09,
    reward_id: 'theme_link_runner', reward_label: 'Link Runner theme',
    questions: [
      { id: 'lr-https', prompt: 'Кой URL е безопасен кандидат за публична заявка?', options: ['https://example.com/audio', 'file:///etc/passwd', 'http://127.0.0.1', 'javascript:alert(1)'], correct: 0, explanation: 'HTTPS публичен URL е допустим кандидат.' },
      { id: 'lr-redirect', prompt: 'Redirect води към private IP.', options: ['Блокирай след повторна проверка', 'Следвай автоматично', 'Кеширай завинаги', 'Скрий URL'], correct: 0, explanation: 'Всеки redirect target трябва да се валидира отново.' },
      { id: 'lr-scheme', prompt: 'Кои схеми обикновено се позволяват?', options: ['http и https', 'javascript и data', 'file и ftp локално', 'chrome-extension'], correct: 0, explanation: 'Downloader allowlist обикновено е HTTP(S).' },
      { id: 'lr-shortener', prompt: 'Кратък URL трябва да бъде:', options: ['Разрешен след безопасно resolve-ване', 'Винаги доверен', 'Винаги локален', 'Изпълнен като код'], correct: 0, explanation: 'Shortener-ът скрива крайния адрес и изисква проверка.' },
      { id: 'lr-query', prompt: 'URL съдържа token в query string.', options: ['Не го логвай в чист вид', 'Покажи го в audit', 'Сложи го в title', 'Commit-ни го'], correct: 0, explanation: 'Sensitive query параметри трябва да се редактират.' },
      { id: 'lr-loop', prompt: 'Redirect A → B → A.', options: ['Спри при loop/лимит', 'Следвай безкрайно', 'Увеличи timeout безкрайно', 'Промени format'], correct: 0, explanation: 'Redirect limit и visited set предотвратяват loops.' },
      { id: 'lr-dns', prompt: 'DNS първо сочи публично, после към private IP.', options: ['Защита срещу DNS rebinding', 'Довери се на първия lookup', 'Изключи DNS', 'Промени UI'], correct: 0, explanation: 'Адресът трябва да се проверява при реалното свързване.' },
      { id: 'lr-normalize', prompt: 'За dedupe URL-ите трябва да бъдат:', options: ['Нормализирани внимателно', 'Сравнявани по цвят', 'Случайно хеширани', 'Превърнати в HTML'], correct: 0, explanation: 'Нормализацията намалява еквивалентни дубликати.' },
    ],
  },
  'bot-vs-human': {
    slug: 'bot-vs-human', number: 10, title: 'Bot vs Human', icon: '🤖', command: 'botvhuman', mode: 'classification',
    description: 'Разпознавай автоматизирано поведение, без да събираш чувствителни лични данни.', rounds: 6, daily_attempts: 3, score_multiplier: 1.13,
    reward_id: 'badge_bot_vs_human', reward_label: 'Bot vs Human animated badge',
    questions: [
      { id: 'bv-rate', prompt: '1000 еднакви заявки за 2 секунди най-вероятно са:', options: ['Автоматизация/bot', 'Нормален един потребител', 'Cover art', 'Audio codec'], correct: 0, explanation: 'Нереалистичната честота е силен automation сигнал.' },
      { id: 'bv-perfect', prompt: 'Всички действия са през точно 1000 ms.', options: ['Вероятна автоматизация', 'Сигурно човек', 'Metadata грешка', 'Lossless файл'], correct: 0, explanation: 'Перфектната периодичност е подозрителна.' },
      { id: 'bv-privacy', prompt: 'Кой подход е по-добър?', options: ['Минимални поведенчески сигнали', 'Събиране на ненужни лични данни', 'Публикуване на IP', 'Без retention limit'], correct: 0, explanation: 'Минимализацията пази privacy.' },
      { id: 'bv-challenge', prompt: 'При съмнение системата трябва:', options: ['Да приложи пропорционален challenge/rate limit', 'Да банне завинаги автоматично', 'Да покаже secrets', 'Да изтрие базата'], correct: 0, explanation: 'Меката ескалация намалява false positives.' },
      { id: 'bv-false', prompt: 'False positive означава:', options: ['Човек е маркиран като bot', 'Bot е маркиран като bot', 'Файлът е FLAC', 'URL е HTTPS'], correct: 0, explanation: 'False positive е погрешно положително решение.' },
      { id: 'bv-accessibility', prompt: 'Challenge системата трябва да:', options: ['Има достъпна алтернатива', 'Разчита само на визуална загадка', 'Блокира screen readers', 'Изисква камера'], correct: 0, explanation: 'Достъпността е задължителна.' },
      { id: 'bv-score', prompt: 'Един сигнал сам по себе си е:', options: ['Недостатъчен за категорична присъда', 'Винаги 100% доказателство', 'Причина за изтриване', 'API token'], correct: 0, explanation: 'Нужна е комбинация от сигнали и thresholds.' },
      { id: 'bv-review', prompt: 'За важни блокирания е полезно:', options: ['Обжалване или човешки review', 'Никакъв review', 'Публичен token', 'Без audit'], correct: 0, explanation: 'Review механизмът поправя грешни решения.' },
    ],
  },
};

let schemaReady: Promise<void> | null = null;

export function challengeGameSlugs(): ChallengeGameSlug[] {
  return Object.keys(CHALLENGE_GAMES) as ChallengeGameSlug[];
}

export function challengeDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function challengeQuestionsForDay(game: ChallengeGameDefinition, dayKey: string): ChallengeQuestion[] {
  const pool = game.questions.slice();
  const selected: ChallengeQuestion[] = [];
  let state = hashString(`${game.slug}:${dayKey}`);
  while (selected.length < game.rounds && pool.length) {
    state = xorshift32(state);
    const question = pool.splice(Math.abs(state) % pool.length, 1)[0];
    if (question) selected.push(question);
  }
  return selected;
}

export function calculateChallengeScore(
  game: ChallengeGameDefinition,
  questions: ChallengeQuestion[],
  answers: ChallengeAnswerInput[],
): ChallengeScore {
  const answerMap = new Map<string, ChallengeAnswerInput>();
  for (const answer of answers.slice(0, game.rounds * 2)) {
    const id = String(answer.question_id || '');
    if (id && !answerMap.has(id)) answerMap.set(id, answer);
  }
  let score = 0;
  let correct = 0;
  let combo = 0;
  let bestCombo = 0;
  const responseTimes: number[] = [];
  for (const question of questions.slice(0, game.rounds)) {
    const answer = answerMap.get(question.id);
    const option = Math.floor(Number(answer?.option_index));
    const responseMs = clamp(Math.round(Number(answer?.response_ms) || 15_000), 250, 15_000);
    responseTimes.push(responseMs);
    if (option === question.correct) {
      correct += 1;
      combo += 1;
      bestCombo = Math.max(bestCombo, combo);
      const speedBonus = Math.max(0, Math.round(520 - responseMs / 18));
      score += Math.round((900 + speedBonus + combo * 75) * game.score_multiplier);
    } else {
      combo = 0;
      score = Math.max(0, score - 100);
    }
  }
  const total = Math.min(game.rounds, questions.length);
  const accuracy = Math.round((correct / Math.max(1, total)) * 100);
  if (correct === total && total === game.rounds) score += 1000;
  score += accuracy * 10;
  const normalizedScore = Math.max(0, Math.round(score));
  const avgResponseMs = responseTimes.length
    ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)
    : 15_000;
  return {
    score: normalizedScore,
    xp: clamp(Math.round(normalizedScore / 24), 30, 650),
    correct,
    total,
    accuracy,
    avg_response_ms: avgResponseMs,
    best_combo: bestCombo,
    reward_unlocked: accuracy === 100 && avgResponseMs <= 6500,
  };
}

export async function handleChallengeGamesApi(request: Request, env: ExtendedEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/games\/([a-z0-9-]+)\/(config|session|score|profile|leaderboard)$/);
  if (!match) return null;
  const slug = match[1] as ChallengeGameSlug;
  const action = match[2] || '';
  const game = CHALLENGE_GAMES[slug];
  if (!game) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  await ensureChallengeSchema(env);

  if (action === 'config' && request.method === 'GET') {
    return json(request, {
      ok: true,
      game: game.slug,
      number: game.number,
      title: game.title,
      icon: game.icon,
      mode: game.mode,
      description: game.description,
      rounds: game.rounds,
      daily_attempts: game.daily_attempts,
      shared_profile: true,
      reward: { id: game.reward_id, label: game.reward_label },
    });
  }

  if (action === 'leaderboard' && request.method === 'GET') {
    const limit = clamp(Math.floor(Number(url.searchParams.get('limit') || 25)), 5, 100);
    return json(request, { ok: true, game: game.slug, week_key: latencyStrikeWeekKey(), entries: await leaderboard(game.slug, env, limit) });
  }

  if (request.method !== 'POST') return json(request, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, 405);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json(request, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400);
  const practice = body.practice === true;
  const auth = practice ? null : await authenticate(body, env);
  if (!practice && (!auth?.ok || !auth.user)) {
    return json(request, { error: { code: 'TELEGRAM_AUTH_FAILED', message: auth?.error || 'Unauthorized' } }, 401);
  }
  const user = auth?.user as TelegramChallengeUser | undefined;
  if (user) await upsertProfile(user, env);

  if (action === 'session') {
    const actor = user?.id || request.headers.get('CF-Connecting-IP') || 'practice';
    const limited = await rateLimit(env.CACHE, `game:${game.slug}:session:${actor}`, 18, 60);
    if (limited.limited) return json(request, { error: { code: 'RATE_LIMITED', message: 'Too many game sessions' } }, 429);
    if (user && await attemptsToday(game.slug, user.id, env) >= game.daily_attempts) {
      return json(request, { error: { code: 'DAILY_LIMIT', message: 'Daily ranked attempts are complete. Practice remains available.' } }, 409);
    }
    const dayKey = challengeDayKey();
    const questions = challengeQuestionsForDay(game, dayKey);
    const sessionId = randomToken(24);
    const session: ChallengeSession = {
      game: game.slug,
      user_id: user?.id || 0,
      practice,
      day_key: dayKey,
      question_ids: questions.map((question) => question.id),
      issued_at: Math.floor(Date.now() / 1000),
    };
    await env.CACHE.put(`game:challenge:session:${sessionId}`, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
    return json(request, {
      ok: true,
      session_id: sessionId,
      practice,
      expires_in: SESSION_TTL_SECONDS,
      questions: questions.map((question) => ({ id: question.id, prompt: question.prompt, options: question.options })),
    });
  }

  if (action === 'score') return scoreSession(request, game, body, user, env);

  if (!user) return json(request, { error: { code: 'TELEGRAM_REQUIRED', message: 'Telegram identity required' } }, 401);
  if (action === 'profile') return json(request, { ok: true, ...(await buildProfile(game, user.id, env)) });
  return json(request, { error: { code: 'NOT_FOUND', message: 'Challenge endpoint not found' } }, 404);
}

async function scoreSession(
  request: Request,
  game: ChallengeGameDefinition,
  body: Record<string, unknown>,
  user: TelegramChallengeUser | undefined,
  env: ExtendedEnv,
): Promise<Response> {
  const sessionId = String(body.session_id || '').trim();
  if (!/^[a-f0-9]{48}$/.test(sessionId)) return json(request, { error: { code: 'INVALID_SESSION', message: 'Invalid session' } }, 400);
  const key = `game:challenge:session:${sessionId}`;
  const raw = await env.CACHE.get(key);
  if (!raw) return json(request, { error: { code: 'SESSION_EXPIRED', message: 'Session expired or already used' } }, 409);
  const session = JSON.parse(raw) as ChallengeSession;
  if (session.game !== game.slug || session.day_key !== challengeDayKey()) return json(request, { error: { code: 'SESSION_MISMATCH', message: 'Session does not match the current game rotation' } }, 403);
  if (session.practice !== (body.practice === true)) return json(request, { error: { code: 'SESSION_MISMATCH', message: 'Practice mode mismatch' } }, 403);
  if (!session.practice && (!user || session.user_id !== user.id)) return json(request, { error: { code: 'SESSION_MISMATCH', message: 'Session identity mismatch' } }, 403);
  const questionsById = new Map(challengeQuestionsForDay(game, session.day_key).map((question) => [question.id, question]));
  const questions = session.question_ids.map((id) => questionsById.get(id)).filter(Boolean) as ChallengeQuestion[];
  const answers = Array.isArray(body.answers) ? body.answers as ChallengeAnswerInput[] : [];
  const result = calculateChallengeScore(game, questions, answers);
  await env.CACHE.delete(key);

  if (session.practice) return json(request, { ok: true, practice: true, recorded: false, result });
  if (!user) return json(request, { error: { code: 'TELEGRAM_REQUIRED', message: 'Telegram identity required' } }, 401);
  if (await attemptsToday(game.slug, user.id, env) >= game.daily_attempts) return json(request, { error: { code: 'DAILY_LIMIT', message: 'Daily ranked attempts are complete' } }, 409);

  const runId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO challenge_game_runs (
        id, game_slug, telegram_user_id, day_key, week_key, score, correct_answers,
        total_questions, accuracy, avg_response_ms, best_combo, xp_earned
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(runId, game.slug, user.id, session.day_key, latencyStrikeWeekKey(), result.score, result.correct, result.total, result.accuracy, result.avg_response_ms, result.best_combo, result.xp),
    env.DB.prepare(`
      UPDATE game_profiles SET total_xp = total_xp + ?, total_games = total_games + 1,
        best_score = MAX(best_score, ?), updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
    `).bind(result.xp, result.score, user.id),
  ]);
  if (result.reward_unlocked) {
    await env.DB.prepare('INSERT OR IGNORE INTO game_unlocks (telegram_user_id, reward_id) VALUES (?, ?)')
      .bind(user.id, game.reward_id).run();
  }
  return json(request, { ok: true, practice: false, recorded: true, run_id: runId, result, ...(await buildProfile(game, user.id, env)) });
}

export async function getChallengeGameBotSummary(
  slug: ChallengeGameSlug,
  telegramUserId: number,
  env: ExtendedEnv,
  language: 'bg' | 'en' = 'bg',
): Promise<string> {
  const game = CHALLENGE_GAMES[slug];
  await ensureChallengeSchema(env);
  const data = await buildProfile(game, telegramUserId, env);
  const profile = data.profile as Record<string, unknown> | null;
  const totalXp = Number(profile?.total_xp || 0);
  const rank = latencyStrikeRank(totalXp);
  const attempts = Number(data.attempts_today || 0);
  const best = Number(data.best_game_score || 0);
  if (language === 'en') {
    return [`${game.icon} ${game.title}`, '', game.description, '', `⚡ Shared XP: ${totalXp}`, `🏅 Shared rank: ${rank.name}`, `🏆 Best score: ${best}`, `🎯 Ranked attempts today: ${attempts}/${game.daily_attempts}`, `🎁 Perfect-run reward: ${game.reward_label}`].join('\n');
  }
  return [`${game.icon} ${game.title}`, '', game.description, '', `⚡ Общ XP: ${totalXp}`, `🏅 Общ ранг: ${rank.name}`, `🏆 Най-добър резултат: ${best}`, `🎯 Ranked опити днес: ${attempts}/${game.daily_attempts}`, `🎁 Награда за perfect run: ${game.reward_label}`].join('\n');
}

async function ensureChallengeSchema(env: ExtendedEnv): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = applyD1SchemaStatements(env, [
    `CREATE TABLE IF NOT EXISTS challenge_game_runs (
      id TEXT PRIMARY KEY, game_slug TEXT NOT NULL, telegram_user_id INTEGER NOT NULL,
      day_key TEXT NOT NULL, week_key TEXT NOT NULL, score INTEGER NOT NULL,
      correct_answers INTEGER NOT NULL, total_questions INTEGER NOT NULL,
      accuracy INTEGER NOT NULL, avg_response_ms INTEGER NOT NULL, best_combo INTEGER NOT NULL,
      xp_earned INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE INDEX IF NOT EXISTS idx_challenge_runs_game_week ON challenge_game_runs(game_slug, week_key, score DESC, created_at ASC)',
    'CREATE INDEX IF NOT EXISTS idx_challenge_runs_user_day ON challenge_game_runs(game_slug, telegram_user_id, day_key, created_at DESC)',
  ]).catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function authenticate(body: Record<string, unknown>, env: ExtendedEnv) {
  return validateTelegramInitData(
    String(body.init_data || ''),
    String(env.TELEGRAM_BOT_TOKEN || ''),
    clamp(readEnvInt(env.TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS, 900), 60, 3600),
  );
}

async function upsertProfile(user: TelegramChallengeUser, env: ExtendedEnv): Promise<void> {
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.username || `Player ${user.id}`;
  await env.DB.prepare(`
    INSERT INTO game_profiles (telegram_user_id, username, display_name) VALUES (?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET username = excluded.username,
      display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP
  `).bind(user.id, user.username || null, displayName).run();
}

async function attemptsToday(slug: ChallengeGameSlug, userId: number, env: ExtendedEnv): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM challenge_game_runs WHERE game_slug = ? AND telegram_user_id = ? AND day_key = ?')
    .bind(slug, userId, challengeDayKey()).first<{ count: number }>();
  return Number(row?.count || 0);
}

async function buildProfile(game: ChallengeGameDefinition, userId: number, env: ExtendedEnv) {
  const profile = await env.DB.prepare(`
    SELECT telegram_user_id, username, display_name, total_xp, total_games, best_score,
      equipped_frame, equipped_icon, equipped_badge, equipped_waveform, equipped_theme, equipped_title
    FROM game_profiles WHERE telegram_user_id = ? LIMIT 1
  `).bind(userId).first<Record<string, unknown>>();
  const best = await env.DB.prepare('SELECT MAX(score) AS best_score FROM challenge_game_runs WHERE game_slug = ? AND telegram_user_id = ?')
    .bind(game.slug, userId).first<{ best_score: number | null }>();
  const unlocked = await env.DB.prepare('SELECT 1 AS ok FROM game_unlocks WHERE telegram_user_id = ? AND reward_id = ? LIMIT 1')
    .bind(userId, game.reward_id).first<{ ok: number }>();
  return {
    profile: profile ? { ...profile, rank: latencyStrikeRank(Number(profile.total_xp || 0)) } : null,
    attempts_today: await attemptsToday(game.slug, userId, env),
    attempts_limit: game.daily_attempts,
    best_game_score: Number(best?.best_score || 0),
    reward: { id: game.reward_id, label: game.reward_label, unlocked: Boolean(unlocked) },
  };
}

async function leaderboard(slug: ChallengeGameSlug, env: ExtendedEnv, limit: number): Promise<Array<Record<string, unknown> & { position: number }>> {
  const result = await env.DB.prepare(`
    SELECT p.telegram_user_id, p.username, p.display_name, p.equipped_icon, p.equipped_badge,
      SUM(r.score) AS points, COUNT(*) AS games, MAX(r.score) AS best_score,
      ROUND(AVG(r.accuracy)) AS accuracy
    FROM challenge_game_runs r JOIN game_profiles p ON p.telegram_user_id = r.telegram_user_id
    WHERE r.game_slug = ? AND r.week_key = ? GROUP BY p.telegram_user_id
    ORDER BY points DESC, best_score DESC, games ASC LIMIT ?
  `).bind(slug, latencyStrikeWeekKey(), limit).all<Record<string, unknown>>();
  return (result.results || []).map((row, index) => ({ ...row, position: index + 1 })) as Array<Record<string, unknown> & { position: number }>;
}

function randomToken(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (value) => value.toString(16).padStart(2, '0')).join('');
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

function xorshift32(value: number): number {
  let state = value || 0x6d2b79f5;
  state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
  return state | 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  const origin = request.headers.get('Origin');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    headers.set('Vary', 'Origin');
  }
  return headers;
}

function json(request: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: corsHeaders(request) });
}
