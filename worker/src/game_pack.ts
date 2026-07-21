import type { Env } from './types';
import { latencyStrikeRank, latencyStrikeWeekKey } from './latency_strike';
import { validateTelegramInitData } from './telegram_platform';
import { rateLimit, readEnvInt } from './utils';

type ExtendedEnv = Env & { TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS?: string };
export type GamePackId =
  | 'queue-commander'
  | 'beat-hunter'
  | 'format-forge'
  | 'server-defender'
  | 'metadata-detective'
  | 'link-runner'
  | 'bot-vs-human';

interface TelegramGameUser { id: number; first_name: string; last_name?: string; username?: string }
export interface GamePackQuestion {
  id: string;
  prompt: string;
  options: string[];
  correct: number;
  explanation: string;
  clue?: string;
}
export interface GamePackDefinition {
  id: GamePackId;
  title: string;
  icon: string;
  command: string;
  description: string;
  mechanic: string;
  reward_id: string;
  reward_title: string;
  questions: GamePackQuestion[];
}
interface GameAnswerInput { question_id?: string; option_index?: number; response_ms?: number }
interface GamePackSession {
  user_id: number;
  game_id: GamePackId;
  practice: boolean;
  day_key: string;
  question_ids: string[];
  bot_score: number;
  issued_at: number;
}
export interface GamePackScore {
  score: number;
  xp: number;
  correct: number;
  total: number;
  accuracy: number;
  avg_response_ms: number;
  best_combo: number;
  bot_score: number | null;
  won_duel: boolean | null;
}

const GAME_VERSION = '1.0.0';
const ROUNDS = 5;
const DAILY_ATTEMPTS = 5;
const SESSION_TTL_SECONDS = 900;

const q = (id: string, prompt: string, options: string[], correct: number, explanation: string, clue?: string): GamePackQuestion =>
  ({ id, prompt, options, correct, explanation, clue });

export const GAME_PACK: Record<GamePackId, GamePackDefinition> = {
  'queue-commander': {
    id: 'queue-commander', title: 'Queue Commander', icon: '🎛', command: 'queuegame',
    description: 'Стратегическа игра за приоритети, retries, deduplication и стабилна обработка на задачи.',
    mechanic: 'Подреди критичните решения в опашката преди системата да се претовари.',
    reward_id: 'title_queue_master', reward_title: 'Queue Master',
    questions: [
      q('qc-expiring', 'Коя задача трябва да мине първа?', ['Нова заявка без срок', 'Заявка с изтичащ подписан URL', 'Архивна статистика', 'Duplicate job'], 1, 'Изтичащият URL има най-малък времеви прозорец.'),
      q('qc-429', 'Backend връща HTTP 429.', ['50 паралелни retries', 'Retry-After с backoff', 'Изтрий задачата', 'Маркирай done'], 1, 'Retry-After и exponential backoff пазят backend-а.'),
      q('qc-duplicate', 'Две еднакви задачи пристигат едновременно.', ['Обработи и двете', 'Dedupe и общ резултат', 'Спри Worker-а', 'Изтрий по-старата'], 1, 'Dedupe предотвратява двойна обработка.'),
      q('qc-poison', 'Задача пада многократно с една грешка.', ['Безкраен retry', 'Dead-letter след лимит', 'Спри всички задачи', 'Безкраен timeout'], 1, 'Dead-letter изолира проблемната задача.'),
      q('qc-idempotent', 'Как retry остава безопасен?', ['Idempotency key', 'По-дълъг URL', 'CSS cache', 'Нова иконка'], 0, 'Idempotency key пази от двойни странични ефекти.'),
      q('qc-breaker', 'Origin-ът е временно недостъпен.', ['Circuit breaker', '100 незабавни retries', 'Изтрий D1', 'Игнорирай timeout'], 0, 'Circuit breaker ограничава каскадните сривове.'),
    ],
  },
  'beat-hunter': {
    id: 'beat-hunter', title: 'Beat Hunter', icon: '🎧', command: 'beathunter',
    description: 'Познай жанр, BPM диапазон и структура по синтетични clues и waveform описания.',
    mechanic: 'Разчети ритъма без използване на защитени или чужди аудиозаписи.',
    reward_id: 'badge_beat_hunter', reward_title: 'Beat Hunter',
    questions: [
      q('bh-techno', 'Four-on-the-floor, 138 BPM, индустриален kick.', ['Dark Techno', 'Reggae', 'Ambient', 'Jazz'], 0, 'Това е типичен dark techno профил.', '▮▮▮▮ · 138 BPM'),
      q('bh-dnb', 'Breakbeat около 174 BPM и тежък sub bass.', ['House', 'Drum & Bass', 'Downtempo', 'Disco'], 1, '174 BPM и breakbeat насочват към Drum & Bass.', '▮▯▮▮▯▮ · 174 BPM'),
      q('bh-house', '124 BPM, four-on-the-floor и off-beat hi-hat.', ['House', 'Metal', 'Ambient', 'Trap'], 0, 'House обикновено е около 120-128 BPM.'),
      q('bh-breakdown', 'Waveform-ът става по-тих и губи kick за 16 такта.', ['Drop', 'Breakdown', 'Clipping', 'Metadata'], 1, 'Breakdown временно намалява енергията.'),
      q('bh-clipping', 'Върховете са постоянно отрязани.', ['Headroom', 'Clipping', 'Lossless tag', 'Stereo width'], 1, 'Плоските върхове подсказват clipping.'),
      q('bh-halftime', '140 BPM, но groove-ът се усеща като 70.', ['Half-time feel', 'Wrong cover', 'Mono', 'Dither'], 0, 'Half-time дели възприетия pulse на две.'),
    ],
  },
  'format-forge': {
    id: 'format-forge', title: 'Format Forge', icon: '⚒', command: 'formatforge',
    description: 'Изкови правилния формат и качество за устройство, архив или споделяне.',
    mechanic: 'Баланс между качество, размер, съвместимост и цел.',
    reward_id: 'badge_format_smith', reward_title: 'Format Smith',
    questions: [
      q('ff-iphone', 'Баланс за iPhone и малък размер?', ['WAV', 'M4A/AAC', 'BMP', 'RAW PCM'], 1, 'M4A/AAC има широка Apple съвместимост.'),
      q('ff-lossless', 'Lossless архив, по-компактен от WAV?', ['MP3', 'FLAC', 'AAC 96', 'OGG 64'], 1, 'FLAC компресира без загуба.'),
      q('ff-edit', 'Формат за професионален монтаж?', ['WAV/PCM', 'MP3 96', 'GIF', 'TXT'], 0, 'WAV/PCM избягва допълнителна lossy компресия.'),
      q('ff-telegram', 'Практичен формат за Telegram?', ['MP3 192/320', 'WAV 32-bit', 'ISO', 'RAW video'], 0, 'MP3 е малък и широко поддържан.'),
      q('ff-opus', 'Ефективен codec при нисък bitrate?', ['OPUS', 'BMP', 'AIFF', 'CSV'], 0, 'Opus е оптимизиран за широк диапазон bitrates.'),
      q('ff-transcode', 'Многократно MP3→MP3 прекодиране?', ['Подобрява', 'Generation loss', 'Става lossless', 'Няма промяна'], 1, 'Lossy прекодирането натрупва загуби.'),
    ],
  },
  'server-defender': {
    id: 'server-defender', title: 'Server Defender', icon: '🛡', command: 'serverdefender',
    description: 'Tower-defense решения върху Worker, Queue, D1, KV и FFmpeg backend.',
    mechanic: 'Разположи правилната защита срещу претоварване, грешки и злоупотреба.',
    reward_id: 'badge_server_guardian', reward_title: 'Server Guardian',
    questions: [
      q('sd-ddos', 'Рязък трафик от един IP.', ['Edge rate limit', 'Публичен token', 'Без logs', 'Без HTTPS'], 0, 'Edge rate limiting спира злоупотребата рано.'),
      q('sd-db', 'Много еднакви D1 read заявки.', ['KV/cache', 'DROP TABLE', 'Повече HTML', 'Без индекси'], 0, 'Cache намалява D1 натоварването.'),
      q('sd-origin', 'FFmpeg backend е offline.', ['Circuit breaker + queue retry', 'Безкрайни заявки', 'Всичко done', 'Изтрий queue'], 0, 'Circuit breaker пази origin-а.'),
      q('sd-secret', 'Bot token е във frontend.', ['Ротация и Worker secret', 'Остави го', 'Скрий с CSS', 'Base64'], 0, 'Secret се ротира и се пази server-side.'),
      q('sd-ssrf', 'URL е http://localhost/admin.', ['Блокирай private/loopback', 'Fetch', 'Следвай redirects', 'Sitemap'], 0, 'SSRF защитата блокира вътрешни адреси.'),
      q('sd-logs', 'Диагностика без изтичане на secrets.', ['Structured logs с redaction', 'Пълен token', 'Без timestamp', 'Screenshot'], 0, 'Redaction пази чувствителните стойности.'),
    ],
  },
  'metadata-detective': {
    id: 'metadata-detective', title: 'Metadata Detective', icon: '🔎', command: 'metadata',
    description: 'Открий надежден title, artist, album и artwork match от конфликтни данни.',
    mechanic: 'Събирай доказателства, нормализирай текст и избягвай фалшиви съвпадения.',
    reward_id: 'badge_metadata_detective', reward_title: 'Metadata Detective',
    questions: [
      q('md-isrc', 'Най-силно доказателство за конкретен запис?', ['Съвпадащ ISRC', 'Цвят на cover', 'Дължина на име', 'Hashtag'], 0, 'ISRC идентифицира конкретна звукозаписна версия.'),
      q('md-normalize', '„Artist – Track (Official Audio)“ става:', ['Artist – Track', 'Official – Artist', 'Unknown', 'Track.exe'], 0, 'Шумният platform suffix се премахва.'),
      q('md-duration', 'Два резултата имат еднакво име.', ['Близка duration', 'Favicon', 'По-дълъг URL', 'Emoji'], 0, 'Duration е полезен вторичен сигнал.'),
      q('md-remix', 'Как пазиш remix версия?', ['Премахни я', 'Запази version/remixer', 'Unknown artist', 'Random year'], 1, 'Версията е съществена metadata част.'),
      q('md-confidence', 'Ниска увереност между два match-а.', ['Покажи избор', 'Избери случаен', 'Слей artist-ите', 'Изтрий title'], 0, 'При ниска увереност не трябва да се гадае.'),
      q('md-unicode', 'Заглавия се различават само по Unicode форма.', ['Unicode normalization', 'Изтрий буквите', 'Base64', 'Bitrate'], 0, 'Unicode normalization помага за надеждно сравнение.'),
    ],
  },
  'link-runner': {
    id: 'link-runner', title: 'Link Runner', icon: '🔗', command: 'linkrunner',
    description: 'Сортирай URL-и по източник, риск и правилен edge маршрут.',
    mechanic: 'Реагирай бързо, но никога не следвай опасен или вътрешен адрес.',
    reward_id: 'badge_link_runner', reward_title: 'Link Runner',
    questions: [
      q('lr-youtube', 'https://youtube.com/watch?v=abc', ['Публичен video source', 'Private network', 'Executable', 'DSN'], 0, 'Това е публичен YouTube URL.'),
      q('lr-localhost', 'http://127.0.0.1:8787/admin', ['CDN', 'Блокиран loopback', 'RSS', 'Deep link'], 1, 'Loopback адресите не трябва да се fetch-ват.'),
      q('lr-file', 'file:///etc/passwd', ['Публичен URL', 'Блокирана file схема', 'SoundCloud', 'Artwork'], 1, 'file: схемата е локална и опасна.'),
      q('lr-redirect', 'URL redirect-ва към 169.254.169.254.', ['Следвай', 'Провери и блокирай', 'Cache', 'Изпрати'], 1, 'Redirect target също минава SSRF проверка.'),
      q('lr-rss', 'Content-Type е application/rss+xml.', ['Podcast/RSS route', 'JavaScript', 'D1 migration', 'Image'], 0, 'RSS се обработва от feed route.'),
      q('lr-creds', 'URL съдържа username:password@host.', ['Log целия', 'Reject/redact credentials', 'Покажи публично', 'Analytics'], 1, 'Credentials в URL се блокират или редактират.'),
    ],
  },
  'bot-vs-human': {
    id: 'bot-vs-human', title: 'Bot vs Human', icon: '🤖', command: 'botvshuman',
    description: 'Адаптивен дуел срещу DK Core за опашка, сигурност, формати и metadata.',
    mechanic: 'Победи симулирания Core с по-точни и по-бързи решения.',
    reward_id: 'title_core_breaker', reward_title: 'Core Breaker',
    questions: [
      q('bvh-cache', 'Кога KV е подходящ?', ['Краткотрайни read-heavy стойности', 'Транзакционна книга', 'Bot token', 'Audio processing'], 0, 'KV е добър за краткотрайни read-heavy данни.'),
      q('bvh-auth', 'Кое доказва Telegram потребител?', ['Проверено initData HMAC', 'Username JSON', 'CSS theme', 'URL fragment'], 0, 'initData се валидира server-side.'),
      q('bvh-race', 'Два score submit-а използват една сесия.', ['Приеми двата', 'Consume-once session', 'Събери точки', 'Без auth'], 1, 'Еднократната сесия пази класацията.'),
      q('bvh-cache-control', 'Registry се променя от Control Center.', ['Кратък TTL + invalidation', 'Cache forever', 'Без version', 'History'], 0, 'TTL и invalidation правят промените видими.'),
      q('bvh-upload', 'Огромен файл без лимит.', ['Size/type limits', 'Целият в RAM', 'Скрий progress', 'Изпълни metadata'], 0, 'Ранната validation пази ресурси.'),
      q('bvh-secret', 'Правилен secret lifecycle?', ['Secret store, rotate, audit', 'Public repo', 'Query string', 'Client config'], 0, 'Secrets се пазят извън source и се ротират.'),
    ],
  },
};

let schemaReady: Promise<void> | null = null;
export function gamePackDayKey(date = new Date()): string { return date.toISOString().slice(0, 10); }

export function gamePackQuestions(gameId: GamePackId, dayKey: string): GamePackQuestion[] {
  const pool = GAME_PACK[gameId].questions.slice();
  const selected: GamePackQuestion[] = [];
  let state = hashString(`${gameId}:${dayKey}`);
  while (selected.length < ROUNDS && pool.length) {
    state = xorshift32(state);
    const question = pool.splice(Math.abs(state) % pool.length, 1)[0];
    if (question) selected.push(question);
  }
  return selected;
}

export function calculateGamePackScore(gameId: GamePackId, questions: GamePackQuestion[], answers: GameAnswerInput[], botScore = 0): GamePackScore {
  const answerMap = new Map<string, GameAnswerInput>();
  for (const answer of answers.slice(0, ROUNDS * 2)) {
    const id = String(answer.question_id || '');
    if (id && !answerMap.has(id)) answerMap.set(id, answer);
  }
  let score = 0;
  let correct = 0;
  let combo = 0;
  let bestCombo = 0;
  const times: number[] = [];
  for (const question of questions.slice(0, ROUNDS)) {
    const answer = answerMap.get(question.id);
    const option = Math.floor(Number(answer?.option_index));
    const responseMs = clamp(Math.round(Number(answer?.response_ms) || 15_000), 250, 15_000);
    times.push(responseMs);
    if (option === question.correct) {
      correct += 1;
      combo += 1;
      bestCombo = Math.max(bestCombo, combo);
      score += 1000 + Math.max(0, Math.round(620 - responseMs / 16)) + combo * 100;
    } else {
      combo = 0;
      score = Math.max(0, score - 140);
    }
  }
  const total = Math.min(ROUNDS, questions.length);
  const accuracy = Math.round((correct / Math.max(1, total)) * 100);
  if (correct === total && total === ROUNDS) score += 1300;
  score += accuracy * 10;
  const normalized = Math.max(0, Math.round(score));
  const duel = gameId === 'bot-vs-human';
  return {
    score: normalized,
    xp: clamp(Math.round(normalized / 24), 30, 650),
    correct,
    total,
    accuracy,
    avg_response_ms: times.length ? Math.round(times.reduce((sum, value) => sum + value, 0) / times.length) : 15_000,
    best_combo: bestCombo,
    bot_score: duel ? botScore : null,
    won_duel: duel ? normalized > botScore : null,
  };
}

export async function handleGamePackApi(request: Request, env: ExtendedEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/games/game-pack/catalog' && request.method === 'GET') {
    return json(request, { ok: true, version: GAME_VERSION, games: Object.values(GAME_PACK).map(publicDefinition), existing_games: ['dyrakarmy-arena', 'archive-raid', 'latency-strike'], total_games: 10, shared_profile: true });
  }
  const match = url.pathname.match(/^\/api\/games\/([a-z0-9-]+)\/(config|session|score|profile|leaderboard)$/);
  if (!match) return null;
  const gameId = match[1] as GamePackId;
  const action = match[2] || '';
  const game = GAME_PACK[gameId];
  if (!game) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  await ensureSchema(env);

  if (action === 'config' && request.method === 'GET') {
    return json(request, { ok: true, game: publicDefinition(game), version: GAME_VERSION, rounds: ROUNDS, daily_attempts: DAILY_ATTEMPTS, day_key: gamePackDayKey(), week_key: latencyStrikeWeekKey(), shared_profile: true });
  }
  if (action === 'leaderboard' && request.method === 'GET') {
    const limit = clamp(Math.floor(Number(url.searchParams.get('limit') || 25)), 5, 100);
    return json(request, { ok: true, game_id: gameId, week_key: latencyStrikeWeekKey(), entries: await leaderboard(gameId, env, limit) });
  }
  if (request.method !== 'POST') return json(request, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, 405);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json(request, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400);
  const practice = body.practice === true;
  const auth = practice ? null : await authenticate(body, env);
  if (!practice && (!auth?.ok || !auth.user)) return json(request, { error: { code: 'TELEGRAM_AUTH_FAILED', message: auth?.error || 'Unauthorized' } }, 401);
  const user = auth?.user as TelegramGameUser | undefined;
  if (user) await upsertProfile(user, env);

  if (action === 'session') {
    const actor = user?.id || request.headers.get('CF-Connecting-IP') || 'practice';
    const limited = await rateLimit(env.CACHE, `game:pack:${gameId}:session:${actor}`, 20, 60);
    if (limited.limited) return json(request, { error: { code: 'RATE_LIMITED', message: 'Too many game sessions' } }, 429);
    if (user && await attemptsToday(gameId, user.id, env) >= DAILY_ATTEMPTS) return json(request, { error: { code: 'DAILY_LIMIT', message: 'Daily ranked attempts are complete. Practice remains available.' } }, 409);
    const dayKey = gamePackDayKey();
    const questions = gamePackQuestions(gameId, dayKey);
    const sessionId = randomToken(24);
    const botScore = gameId === 'bot-vs-human' ? 4200 + Math.abs(hashString(`${dayKey}:${sessionId}`)) % 2600 : 0;
    const session: GamePackSession = { user_id: user?.id || 0, game_id: gameId, practice, day_key: dayKey, question_ids: questions.map((question) => question.id), bot_score: botScore, issued_at: Math.floor(Date.now() / 1000) };
    await env.CACHE.put(`game:pack:session:${sessionId}`, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
    return json(request, { ok: true, session_id: sessionId, practice, expires_in: SESSION_TTL_SECONDS, opponent: gameId === 'bot-vs-human' ? { name: 'DK Core', target_score: botScore } : null, questions: questions.map(publicQuestion) });
  }
  if (action === 'score') return scoreSession(request, game, body, user, env);
  if (!user) return json(request, { error: { code: 'TELEGRAM_REQUIRED', message: 'Telegram identity required' } }, 401);
  if (action === 'profile') return json(request, { ok: true, game: publicDefinition(game), ...(await buildProfile(gameId, user.id, env)) });
  return json(request, { error: { code: 'NOT_FOUND', message: 'Game endpoint not found' } }, 404);
}

async function scoreSession(request: Request, game: GamePackDefinition, body: Record<string, unknown>, user: TelegramGameUser | undefined, env: ExtendedEnv): Promise<Response> {
  const sessionId = String(body.session_id || '').trim();
  if (!/^[a-f0-9]{48}$/.test(sessionId)) return json(request, { error: { code: 'INVALID_SESSION', message: 'Invalid session' } }, 400);
  const key = `game:pack:session:${sessionId}`;
  const raw = await env.CACHE.get(key);
  if (!raw) return json(request, { error: { code: 'SESSION_EXPIRED', message: 'Session expired or already used' } }, 409);
  const session = JSON.parse(raw) as GamePackSession;
  if (session.game_id !== game.id || session.day_key !== gamePackDayKey()) return json(request, { error: { code: 'SESSION_MISMATCH', message: 'Session does not match this game rotation' } }, 403);
  if (session.practice !== (body.practice === true)) return json(request, { error: { code: 'SESSION_MISMATCH', message: 'Practice mode mismatch' } }, 403);
  if (!session.practice && (!user || user.id !== session.user_id)) return json(request, { error: { code: 'SESSION_MISMATCH', message: 'Session identity mismatch' } }, 403);
  const bank = new Map(game.questions.map((question) => [question.id, question]));
  const questions = session.question_ids.map((id) => bank.get(id)).filter(Boolean) as GamePackQuestion[];
  const answers = Array.isArray(body.answers) ? body.answers as GameAnswerInput[] : [];
  const result = calculateGamePackScore(game.id, questions, answers, session.bot_score);
  const explanations = questions.map((question) => ({ id: question.id, correct: question.correct, explanation: question.explanation }));
  await env.CACHE.delete(key);
  if (session.practice) return json(request, { ok: true, practice: true, recorded: false, result, explanations });
  if (!user) return json(request, { error: { code: 'TELEGRAM_REQUIRED', message: 'Telegram identity required' } }, 401);
  if (await attemptsToday(game.id, user.id, env) >= DAILY_ATTEMPTS) return json(request, { error: { code: 'DAILY_LIMIT', message: 'Daily ranked attempts are complete' } }, 409);
  const runId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO game_pack_runs (id, game_id, telegram_user_id, day_key, week_key, score, correct_answers, total_questions, accuracy, avg_response_ms, best_combo, xp_earned, opponent_score, won_duel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(runId, game.id, user.id, session.day_key, latencyStrikeWeekKey(), result.score, result.correct, result.total, result.accuracy, result.avg_response_ms, result.best_combo, result.xp, result.bot_score, result.won_duel === null ? null : result.won_duel ? 1 : 0),
    env.DB.prepare(`UPDATE game_profiles SET total_xp = total_xp + ?, total_games = total_games + 1, best_score = MAX(best_score, ?), updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?`)
      .bind(result.xp, result.score, user.id),
  ]);
  const unlocks = await grantRewards(game, user.id, result, env);
  return json(request, { ok: true, practice: false, recorded: true, run_id: runId, result, explanations, unlocks, ...(await buildProfile(game.id, user.id, env)) });
}

export async function getGamePackBotSummary(gameId: GamePackId, telegramUserId: number, env: ExtendedEnv, language: 'bg' | 'en' = 'bg'): Promise<string> {
  await ensureSchema(env);
  const game = GAME_PACK[gameId];
  const data = await buildProfile(gameId, telegramUserId, env);
  const profile = data.profile as Record<string, unknown> | null;
  const xp = Number(profile?.total_xp || 0);
  const rank = latencyStrikeRank(xp);
  const best = Number(data.game_stats.best_score || 0);
  const position = data.weekly_position ? `#${data.weekly_position}` : '—';
  return language === 'en'
    ? [game.icon + ' ' + game.title, '', game.description, '', `⚡ Shared XP: ${xp}`, `🏅 Shared rank: ${rank.name}`, `🏆 Weekly position: ${position}`, `🎯 Best score: ${best}`, `🕹 Attempts today: ${data.attempts_today}/${DAILY_ATTEMPTS}`].join('\n')
    : [game.icon + ' ' + game.title, '', game.description, '', `⚡ Общ XP: ${xp}`, `🏅 Общ ранг: ${rank.name}`, `🏆 Седмична позиция: ${position}`, `🎯 Най-добър резултат: ${best}`, `🕹 Опити днес: ${data.attempts_today}/${DAILY_ATTEMPTS}`].join('\n');
}

async function ensureSchema(env: ExtendedEnv): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = env.DB.exec(`
    CREATE TABLE IF NOT EXISTS game_pack_runs (
      id TEXT PRIMARY KEY, game_id TEXT NOT NULL, telegram_user_id INTEGER NOT NULL,
      day_key TEXT NOT NULL, week_key TEXT NOT NULL, score INTEGER NOT NULL,
      correct_answers INTEGER NOT NULL, total_questions INTEGER NOT NULL,
      accuracy INTEGER NOT NULL, avg_response_ms INTEGER NOT NULL, best_combo INTEGER NOT NULL,
      xp_earned INTEGER NOT NULL, opponent_score INTEGER, won_duel INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_game_pack_runs_week ON game_pack_runs(game_id, week_key, score DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_game_pack_runs_user_day ON game_pack_runs(game_id, telegram_user_id, day_key, created_at DESC);
  `).then(() => undefined);
  return schemaReady;
}

async function authenticate(body: Record<string, unknown>, env: ExtendedEnv) {
  return validateTelegramInitData(String(body.init_data || ''), String(env.TELEGRAM_BOT_TOKEN || ''), clamp(readEnvInt(env.TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS, 900), 60, 3600));
}
async function upsertProfile(user: TelegramGameUser, env: ExtendedEnv): Promise<void> {
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.username || `Player ${user.id}`;
  await env.DB.prepare(`INSERT INTO game_profiles (telegram_user_id, username, display_name) VALUES (?, ?, ?) ON CONFLICT(telegram_user_id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP`)
    .bind(user.id, user.username || null, displayName).run();
}
async function attemptsToday(gameId: GamePackId, userId: number, env: ExtendedEnv): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM game_pack_runs WHERE game_id = ? AND telegram_user_id = ? AND day_key = ?').bind(gameId, userId, gamePackDayKey()).first<{ count: number }>();
  return Number(row?.count || 0);
}
async function buildProfile(gameId: GamePackId, userId: number, env: ExtendedEnv) {
  const profile = await env.DB.prepare(`SELECT telegram_user_id, username, display_name, total_xp, total_games, best_score, equipped_frame, equipped_icon, equipped_badge, equipped_waveform, equipped_theme, equipped_title FROM game_profiles WHERE telegram_user_id = ? LIMIT 1`).bind(userId).first<Record<string, unknown>>();
  const stats = await env.DB.prepare(`SELECT COUNT(*) AS games, COALESCE(MAX(score), 0) AS best_score, COALESCE(SUM(score), 0) AS total_score, COALESCE(AVG(accuracy), 0) AS avg_accuracy FROM game_pack_runs WHERE game_id = ? AND telegram_user_id = ?`).bind(gameId, userId).first<Record<string, unknown>>();
  const rows = await leaderboard(gameId, env, 1000);
  const index = rows.findIndex((row) => Number(row.telegram_user_id) === userId);
  return { profile: profile ? { ...profile, rank: latencyStrikeRank(Number(profile.total_xp || 0)) } : null, game_stats: stats || { games: 0, best_score: 0, total_score: 0, avg_accuracy: 0 }, attempts_today: await attemptsToday(gameId, userId, env), attempts_limit: DAILY_ATTEMPTS, weekly_position: index >= 0 ? index + 1 : null };
}
async function leaderboard(gameId: GamePackId, env: ExtendedEnv, limit: number): Promise<Array<Record<string, unknown> & { position: number }>> {
  const result = await env.DB.prepare(`SELECT p.telegram_user_id, p.username, p.display_name, p.equipped_icon, p.equipped_badge, p.equipped_title, SUM(r.score) AS points, COUNT(*) AS games, MAX(r.score) AS best_score, AVG(r.accuracy) AS avg_accuracy FROM game_pack_runs r JOIN game_profiles p ON p.telegram_user_id = r.telegram_user_id WHERE r.game_id = ? AND r.week_key = ? GROUP BY p.telegram_user_id ORDER BY points DESC, best_score DESC, games ASC LIMIT ?`).bind(gameId, latencyStrikeWeekKey(), limit).all<Record<string, unknown>>();
  return (result.results || []).map((row, index) => ({ ...row, position: index + 1 })) as Array<Record<string, unknown> & { position: number }>;
}
async function grantRewards(game: GamePackDefinition, userId: number, result: GamePackScore, env: ExtendedEnv): Promise<string[]> {
  const rewards = [`badge_${game.id}_rookie`];
  if (result.accuracy === 100) rewards.push(game.reward_id);
  if (game.id === 'bot-vs-human' && result.won_duel) rewards.push('badge_core_breaker');
  for (const reward of rewards) await env.DB.prepare('INSERT OR IGNORE INTO game_unlocks (telegram_user_id, reward_id) VALUES (?, ?)').bind(userId, reward).run();
  return rewards;
}
function publicDefinition(game: GamePackDefinition) {
  return { id: game.id, title: game.title, icon: game.icon, command: game.command, description: game.description, mechanic: game.mechanic, reward_id: game.reward_id, reward_title: game.reward_title, path: `/games/${game.id}/`, telegram_deep_link: `tg://resolve?domain=dyrakarmy_bot&startapp=${game.id.replaceAll('-', '_')}` };
}
function publicQuestion(question: GamePackQuestion) { return { id: question.id, prompt: question.prompt, options: question.options, clue: question.clue || null }; }
function randomToken(bytes: number): string { const data = crypto.getRandomValues(new Uint8Array(bytes)); return Array.from(data, (value) => value.toString(16).padStart(2, '0')).join(''); }
function hashString(value: string): number { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); } return hash | 0; }
function xorshift32(value: number): number { let state = value || 0x6d2b79f5; state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state | 0; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function corsHeaders(request: Request): Headers { const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); const origin = request.headers.get('Origin'); if (origin) { headers.set('Access-Control-Allow-Origin', origin); headers.set('Access-Control-Allow-Headers', 'Content-Type'); headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); headers.set('Vary', 'Origin'); } return headers; }
function json(request: Request, payload: unknown, status = 200): Response { return new Response(JSON.stringify(payload), { status, headers: corsHeaders(request) }); }
