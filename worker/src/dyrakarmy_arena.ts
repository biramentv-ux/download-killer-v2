import type { Env } from './types';
import { latencyStrikeRank, latencyStrikeWeekKey } from './latency_strike';
import { validateTelegramInitData } from './telegram_platform';
import { rateLimit, readEnvInt } from './utils';

type ExtendedEnv = Env & { TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS?: string };
type ArenaCategory = 'queue' | 'format' | 'security' | 'routing' | 'memory' | 'reaction';

interface TelegramArenaUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface ArenaQuestion {
  id: string;
  category: ArenaCategory;
  prompt: string;
  options: string[];
  correct: number;
}

interface ArenaAnswerInput {
  question_id?: string;
  option_index?: number;
  response_ms?: number;
}

interface ArenaSession {
  user_id: number;
  practice: boolean;
  day_key: string;
  question_ids: string[];
  issued_at: number;
}

export interface ArenaScore {
  score: number;
  xp: number;
  correct: number;
  total: number;
  accuracy: number;
  avg_response_ms: number;
  best_combo: number;
  team_points: number;
}

interface TeamRow {
  id: string;
  code: string;
  name: string;
  owner_user_id: number;
  created_at: string;
  role?: string;
  member_count?: number;
  weekly_points?: number;
  season_points?: number;
}

const ARENA_VERSION = '1.0.0';
const ARENA_ROUNDS = 8;
const DAILY_ATTEMPTS = 3;
const SESSION_TTL_SECONDS = 900;
const TEAM_NAME_PATTERN = /^[\p{L}\p{N} _.-]{3,28}$/u;

const QUESTION_BANK: ArenaQuestion[] = [
  { id: 'queue-priority', category: 'queue', prompt: 'Коя задача трябва да бъде обработена първа?', options: ['Нова задача без срок', 'Повторен duplicate job', 'Задача с изтичащ Telegram URL', 'Архивна статистика'], correct: 2 },
  { id: 'queue-rate-limit', category: 'queue', prompt: 'Backend връща HTTP 429. Какво прави добрата опашка?', options: ['Изтрива задачата', 'Retry след Retry-After', 'Пуска 50 заявки наведнъж', 'Маркира всички задачи като готови'], correct: 1 },
  { id: 'queue-duplicate', category: 'queue', prompt: 'Две еднакви заявки пристигат едновременно. Най-доброто действие е:', options: ['Двойна обработка', 'Dedupe и общ резултат', 'Изключване на Worker-а', 'Случайно изтриване'], correct: 1 },
  { id: 'format-ios', category: 'format', prompt: 'Кой формат е добър баланс за iPhone, качество и малък размер?', options: ['WAV', 'M4A', 'BMP', 'TXT'], correct: 1 },
  { id: 'format-lossless', category: 'format', prompt: 'Кой формат е lossless и по-компактен от WAV?', options: ['MP3', 'OPUS', 'FLAC', 'AAC 96'], correct: 2 },
  { id: 'format-telegram', category: 'format', prompt: 'За бързо изпращане през Telegram най-практичният избор обикновено е:', options: ['MP3 192/320', 'WAV без компресия', 'RAW PCM', 'ISO image'], correct: 0 },
  { id: 'security-secret', category: 'security', prompt: 'Къде трябва да се пази Telegram bot token?', options: ['В публичния README', 'В HTML кода', 'Като Cloudflare secret', 'В името на branch'], correct: 2 },
  { id: 'security-url', category: 'security', prompt: 'Кой URL трябва да бъде блокиран от публичен downloader?', options: ['https://youtube.com/...', 'http://localhost:3000/admin', 'https://soundcloud.com/...', 'https://podcasts.apple.com/...'], correct: 1 },
  { id: 'security-webhook', category: 'security', prompt: 'Как Worker-ът проверява, че webhook заявката е от Telegram?', options: ['По цвета на бутона', 'Със secret token header', 'По размера на JSON', 'Със случайна пауза'], correct: 1 },
  { id: 'routing-edge', category: 'routing', prompt: 'Кой компонент приема публичната API заявка първи?', options: ['Cloudflare Worker', 'FFmpeg файлът', 'Telegram каналът', 'CSS кешът'], correct: 0 },
  { id: 'routing-media', category: 'routing', prompt: 'Кой компонент извършва медийната обработка?', options: ['D1', 'FFmpeg backend', 'KV namespace', 'Service Worker cache'], correct: 1 },
  { id: 'routing-archive', category: 'routing', prompt: 'Къде се пази Telegram file_id за повторно изпращане?', options: ['Само в browser history', 'В общата D1/Telegram archive логика', 'В DNS', 'В favicon'], correct: 1 },
  { id: 'memory-sequence', category: 'memory', prompt: 'Запомни реда: WEB → QUEUE → FFMPEG → TG. Кое е трето?', options: ['WEB', 'QUEUE', 'FFMPEG', 'TG'], correct: 2 },
  { id: 'memory-status', category: 'memory', prompt: 'Правилният lifecycle на задача е:', options: ['DONE → QUEUED → ERROR', 'QUEUED → PROCESSING → DONE', 'PROCESSING → QUEUED → READY', 'READY → OFFLINE → QUEUED'], correct: 1 },
  { id: 'memory-domains', category: 'memory', prompt: 'Кой е основният публичен домейн?', options: ['dyrakarmy.eu', 'localhost', 'example.invalid', 'telegram.local'], correct: 0 },
  { id: 'reaction-ready', category: 'reaction', prompt: 'При Latency Strike кога трябва да натиснеш?', options: ['При QUEUED', 'При PROCESSING', 'При READY', 'Преди старта'], correct: 2 },
  { id: 'reaction-false-start', category: 'reaction', prompt: 'Как се третира false start?', options: ['Като бонус', 'Като наказание', 'Като автоматична победа', 'Не се записва никога'], correct: 1 },
  { id: 'reaction-backoff', category: 'reaction', prompt: 'Кое поведение пази системата при временен проблем?', options: ['Exponential backoff', 'Безкраен tight loop', 'Изтриване на базата', 'Спиране на DNS'], correct: 0 },
];

let schemaReady: Promise<void> | null = null;

export function arenaDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function arenaSeasonKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function arenaQuestionsForDay(dayKey: string): ArenaQuestion[] {
  const selected: ArenaQuestion[] = [];
  let state = hashString(`dyrakarmy-arena:${dayKey}`);
  const pool = QUESTION_BANK.slice();
  while (selected.length < ARENA_ROUNDS && pool.length) {
    state = xorshift32(state);
    const question = pool.splice(Math.abs(state) % pool.length, 1)[0];
    if (question) selected.push(question);
  }
  return selected;
}

export function calculateArenaScore(questions: ArenaQuestion[], answers: ArenaAnswerInput[]): ArenaScore {
  const answerMap = new Map<string, ArenaAnswerInput>();
  for (const answer of answers.slice(0, ARENA_ROUNDS * 2)) {
    const id = String(answer.question_id || '');
    if (id && !answerMap.has(id)) answerMap.set(id, answer);
  }
  let score = 0;
  let correct = 0;
  let combo = 0;
  let bestCombo = 0;
  const responseTimes: number[] = [];

  for (const question of questions.slice(0, ARENA_ROUNDS)) {
    const answer = answerMap.get(question.id);
    const option = Math.floor(Number(answer?.option_index));
    const responseMs = clamp(Math.round(Number(answer?.response_ms) || 15_000), 250, 15_000);
    responseTimes.push(responseMs);
    if (option === question.correct) {
      correct += 1;
      combo += 1;
      bestCombo = Math.max(bestCombo, combo);
      const speedBonus = Math.max(0, Math.round(650 - responseMs / 12));
      score += 1000 + speedBonus + combo * 90;
    } else {
      combo = 0;
      score = Math.max(0, score - 120);
    }
  }

  const total = Math.min(ARENA_ROUNDS, questions.length);
  const accuracy = Math.round((correct / Math.max(1, total)) * 100);
  if (correct === total && total === ARENA_ROUNDS) score += 1500;
  score += accuracy * 12;
  const avgResponseMs = responseTimes.length
    ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)
    : 15_000;
  const normalizedScore = Math.max(0, Math.round(score));
  return {
    score: normalizedScore,
    xp: clamp(Math.round(normalizedScore / 25), 35, 650),
    correct,
    total,
    accuracy,
    avg_response_ms: avgResponseMs,
    best_combo: bestCombo,
    team_points: normalizedScore,
  };
}

export async function handleDyrakArmyArenaApi(request: Request, env: ExtendedEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/games/dyrakarmy-arena/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  await ensureArenaSchema(env);

  if (url.pathname === '/api/games/dyrakarmy-arena/config' && request.method === 'GET') {
    return json(request, {
      ok: true,
      game: 'dyrakarmy-arena',
      version: ARENA_VERSION,
      rounds: ARENA_ROUNDS,
      daily_attempts: DAILY_ATTEMPTS,
      day_key: arenaDayKey(),
      week_key: latencyStrikeWeekKey(),
      season_key: arenaSeasonKey(),
      modes: ['daily-arena', 'team-league', 'practice'],
      rewards: ['shared-xp', 'shared-rank', 'weekly-team-podium', 'profile-cosmetics'],
    });
  }

  if (url.pathname === '/api/games/dyrakarmy-arena/leaderboard' && request.method === 'GET') {
    const scope = url.searchParams.get('scope') === 'players' ? 'players' : 'teams';
    const period = url.searchParams.get('period') === 'season' ? 'season' : 'week';
    const limit = clamp(Math.floor(Number(url.searchParams.get('limit') || 25)), 5, 100);
    return json(request, {
      ok: true,
      scope,
      period,
      week_key: latencyStrikeWeekKey(),
      season_key: arenaSeasonKey(),
      entries: scope === 'teams' ? await teamLeaderboard(env, period, limit) : await playerLeaderboard(env, period, limit),
    });
  }

  if (request.method !== 'POST') return json(request, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, 405);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json(request, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400);
  const practice = body.practice === true;
  const auth = practice ? null : await authenticate(body, env);
  if (!practice && (!auth?.ok || !auth.user)) {
    return json(request, { error: { code: 'TELEGRAM_AUTH_FAILED', message: auth?.error || 'Unauthorized' } }, 401);
  }
  const user = auth?.user as TelegramArenaUser | undefined;
  if (user) await upsertProfile(user, env);

  if (url.pathname === '/api/games/dyrakarmy-arena/session') {
    const userKey = user?.id || request.headers.get('CF-Connecting-IP') || 'practice';
    const limited = await rateLimit(env.CACHE, `game:arena:session:${userKey}`, 15, 60);
    if (limited.limited) return json(request, { error: { code: 'RATE_LIMITED', message: 'Too many sessions' } }, 429);
    if (user && await attemptsToday(user.id, env) >= DAILY_ATTEMPTS) {
      return json(request, { error: { code: 'DAILY_LIMIT', message: 'Daily ranked attempts are complete. Practice mode remains available.' } }, 409);
    }
    const dayKey = arenaDayKey();
    const questions = arenaQuestionsForDay(dayKey);
    const sessionId = randomToken(24);
    const session: ArenaSession = {
      user_id: user?.id || 0,
      practice,
      day_key: dayKey,
      question_ids: questions.map((question) => question.id),
      issued_at: Math.floor(Date.now() / 1000),
    };
    await env.CACHE.put(`game:arena:session:${sessionId}`, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
    return json(request, { ok: true, session_id: sessionId, practice, expires_in: SESSION_TTL_SECONDS, questions: questions.map(publicQuestion) });
  }

  if (url.pathname === '/api/games/dyrakarmy-arena/score') {
    return handleArenaScore(request, body, user, env);
  }

  if (!user) return json(request, { error: { code: 'TELEGRAM_REQUIRED', message: 'Telegram identity required' } }, 401);

  if (url.pathname === '/api/games/dyrakarmy-arena/profile') {
    return json(request, { ok: true, ...(await buildArenaProfile(user.id, env)) });
  }

  if (url.pathname === '/api/games/dyrakarmy-arena/team') {
    return handleTeamAction(request, body, user, env);
  }

  return json(request, { error: { code: 'NOT_FOUND', message: 'Arena endpoint not found' } }, 404);
}

async function handleArenaScore(
  request: Request,
  body: Record<string, unknown>,
  user: TelegramArenaUser | undefined,
  env: ExtendedEnv,
): Promise<Response> {
  const sessionId = String(body.session_id || '').trim();
  if (!/^[a-f0-9]{48}$/.test(sessionId)) return json(request, { error: { code: 'INVALID_SESSION', message: 'Invalid session' } }, 400);
  const sessionKey = `game:arena:session:${sessionId}`;
  const rawSession = await env.CACHE.get(sessionKey);
  if (!rawSession) return json(request, { error: { code: 'SESSION_EXPIRED', message: 'Session expired or already used' } }, 409);
  const session = JSON.parse(rawSession) as ArenaSession;
  if (session.day_key !== arenaDayKey()) return json(request, { error: { code: 'CHALLENGE_EXPIRED', message: 'Daily challenge changed' } }, 409);
  if (session.practice !== (body.practice === true)) return json(request, { error: { code: 'SESSION_MISMATCH', message: 'Practice mode mismatch' } }, 403);
  if (!session.practice && (!user || session.user_id !== user.id)) return json(request, { error: { code: 'SESSION_MISMATCH', message: 'Session identity mismatch' } }, 403);
  if (session.practice && session.user_id !== 0) return json(request, { error: { code: 'SESSION_MISMATCH', message: 'Invalid practice session' } }, 403);

  const questionsById = new Map(arenaQuestionsForDay(session.day_key).map((question) => [question.id, question]));
  const questions = session.question_ids.map((id) => questionsById.get(id)).filter(Boolean) as ArenaQuestion[];
  const answers = Array.isArray(body.answers) ? body.answers as ArenaAnswerInput[] : [];
  const result = calculateArenaScore(questions, answers);

  if (session.practice) {
    await env.CACHE.delete(sessionKey);
    return json(request, { ok: true, practice: true, result, recorded: false });
  }

  if (!user) return json(request, { error: { code: 'TELEGRAM_REQUIRED', message: 'Telegram identity required' } }, 401);
  if (await attemptsToday(user.id, env) >= DAILY_ATTEMPTS) return json(request, { error: { code: 'DAILY_LIMIT', message: 'Daily ranked attempts are complete' } }, 409);
  const team = await teamForUser(user.id, env);
  const runId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO arena_runs (
        id, telegram_user_id, team_id, day_key, week_key, season_key,
        score, correct_answers, total_questions, accuracy, avg_response_ms,
        best_combo, xp_earned
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      runId, user.id, team?.id || null, session.day_key, latencyStrikeWeekKey(), arenaSeasonKey(),
      result.score, result.correct, result.total, result.accuracy, result.avg_response_ms, result.best_combo, result.xp,
    ),
    env.DB.prepare(`
      UPDATE game_profiles SET
        total_xp = total_xp + ?, total_games = total_games + 1,
        best_score = MAX(best_score, ?), updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
    `).bind(result.xp, result.score, user.id),
  ]);
  await env.CACHE.delete(sessionKey);
  return json(request, { ok: true, practice: false, recorded: true, run_id: runId, result, ...(await buildArenaProfile(user.id, env)) });
}

async function handleTeamAction(
  request: Request,
  body: Record<string, unknown>,
  user: TelegramArenaUser,
  env: ExtendedEnv,
): Promise<Response> {
  const action = String(body.action || '').toLowerCase();
  if (action === 'create') {
    const name = normalizeTeamName(String(body.name || ''));
    if (!name) return json(request, { error: { code: 'INVALID_TEAM_NAME', message: 'Team name must contain 3-28 letters or numbers' } }, 400);
    if (await membership(user.id, env)) return json(request, { error: { code: 'ALREADY_IN_TEAM', message: 'Leave the current team first' } }, 409);
    const teamId = crypto.randomUUID();
    const code = await uniqueTeamCode(env);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO arena_teams (id, code, name, owner_user_id) VALUES (?, ?, ?, ?)').bind(teamId, code, name, user.id),
      env.DB.prepare("INSERT INTO arena_team_members (team_id, telegram_user_id, role) VALUES (?, ?, 'owner')").bind(teamId, user.id),
    ]);
    return json(request, { ok: true, team: await teamForUser(user.id, env) });
  }
  if (action === 'join') {
    const code = String(body.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return json(request, { error: { code: 'INVALID_CODE', message: 'Invalid team code' } }, 400);
    if (await membership(user.id, env)) return json(request, { error: { code: 'ALREADY_IN_TEAM', message: 'Leave the current team first' } }, 409);
    const team = await env.DB.prepare('SELECT id FROM arena_teams WHERE code = ? LIMIT 1').bind(code).first<{ id: string }>();
    if (!team) return json(request, { error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' } }, 404);
    await env.DB.prepare("INSERT INTO arena_team_members (team_id, telegram_user_id, role) VALUES (?, ?, 'member')").bind(team.id, user.id).run();
    return json(request, { ok: true, team: await teamForUser(user.id, env) });
  }
  if (action === 'leave') {
    const current = await membership(user.id, env);
    if (!current) return json(request, { error: { code: 'NO_TEAM', message: 'You are not in a team' } }, 404);
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM arena_team_members WHERE team_id = ?').bind(current.team_id).first<{ count: number }>();
    if (current.role === 'owner' && Number(count?.count || 0) > 1) {
      return json(request, { error: { code: 'OWNER_CANNOT_LEAVE', message: 'Transfer ownership or remove members first' } }, 409);
    }
    await env.DB.prepare('DELETE FROM arena_team_members WHERE telegram_user_id = ?').bind(user.id).run();
    if (current.role === 'owner') await env.DB.prepare('DELETE FROM arena_teams WHERE id = ?').bind(current.team_id).run();
    return json(request, { ok: true, team: null });
  }
  return json(request, { error: { code: 'UNKNOWN_ACTION', message: 'Unknown team action' } }, 400);
}

export async function getDyrakArmyArenaBotSummary(
  telegramUserId: number,
  env: ExtendedEnv,
  language: 'bg' | 'en' = 'bg',
): Promise<string> {
  await ensureArenaSchema(env);
  const profile = await env.DB.prepare('SELECT total_xp, total_games FROM game_profiles WHERE telegram_user_id = ?')
    .bind(telegramUserId).first<{ total_xp: number; total_games: number }>();
  const team = await teamForUser(telegramUserId, env);
  const weekly = await playerWeeklyPosition(telegramUserId, env);
  const attempts = await attemptsToday(telegramUserId, env);
  const rank = latencyStrikeRank(Number(profile?.total_xp || 0));
  if (language === 'en') {
    return ['⚔️ DyrakArmy Arena', '', `🛡 Team: ${team?.name || 'No team'}`, `🔑 Team code: ${team?.code || '—'}`, `🏅 Shared rank: ${rank.name}`, `⚡ Shared XP: ${Number(profile?.total_xp || 0)}`, `🏆 Weekly player position: ${weekly ? `#${weekly}` : '—'}`, `🎯 Ranked attempts today: ${attempts}/${DAILY_ATTEMPTS}`].join('\n');
  }
  return ['⚔️ DyrakArmy Arena', '', `🛡 Отбор: ${team?.name || 'Нямаш отбор'}`, `🔑 Код на отбора: ${team?.code || '—'}`, `🏅 Общ ранг: ${rank.name}`, `⚡ Общ XP: ${Number(profile?.total_xp || 0)}`, `🏆 Седмична лична позиция: ${weekly ? `#${weekly}` : '—'}`, `🎯 Ranked опити днес: ${attempts}/${DAILY_ATTEMPTS}`].join('\n');
}

async function authenticate(body: Record<string, unknown>, env: ExtendedEnv) {
  return validateTelegramInitData(
    String(body.init_data || ''),
    String(env.TELEGRAM_BOT_TOKEN || ''),
    clamp(readEnvInt(env.TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS, 900), 60, 3600),
  );
}

async function ensureArenaSchema(env: ExtendedEnv): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = env.DB.exec(`
    CREATE TABLE IF NOT EXISTS game_profiles (
      telegram_user_id INTEGER PRIMARY KEY, username TEXT, display_name TEXT NOT NULL,
      total_xp INTEGER NOT NULL DEFAULT 0, total_games INTEGER NOT NULL DEFAULT 0,
      best_score INTEGER NOT NULL DEFAULT 0, best_reaction_ms INTEGER,
      current_streak INTEGER NOT NULL DEFAULT 0,
      equipped_frame TEXT NOT NULL DEFAULT 'frame_neon', equipped_icon TEXT NOT NULL DEFAULT 'icon_pulse',
      equipped_badge TEXT NOT NULL DEFAULT 'badge_recruit', equipped_waveform TEXT NOT NULL DEFAULT 'waveform_pulse',
      equipped_theme TEXT NOT NULL DEFAULT 'theme_violet', equipped_title TEXT NOT NULL DEFAULT 'title_recruit',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS arena_teams (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS arena_team_members (
      team_id TEXT NOT NULL, telegram_user_id INTEGER NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'member', joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (team_id, telegram_user_id)
    );
    CREATE TABLE IF NOT EXISTS arena_runs (
      id TEXT PRIMARY KEY, telegram_user_id INTEGER NOT NULL, team_id TEXT,
      day_key TEXT NOT NULL, week_key TEXT NOT NULL, season_key TEXT NOT NULL,
      score INTEGER NOT NULL, correct_answers INTEGER NOT NULL, total_questions INTEGER NOT NULL,
      accuracy INTEGER NOT NULL, avg_response_ms INTEGER NOT NULL, best_combo INTEGER NOT NULL,
      xp_earned INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_arena_runs_week_score ON arena_runs(week_key, score DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_arena_runs_season_score ON arena_runs(season_key, score DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_arena_runs_user_day ON arena_runs(telegram_user_id, day_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_arena_runs_team_week ON arena_runs(team_id, week_key, score DESC);
  `).then(() => undefined);
  return schemaReady;
}

async function upsertProfile(user: TelegramArenaUser, env: ExtendedEnv): Promise<void> {
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.username || `Player ${user.id}`;
  await env.DB.prepare(`
    INSERT INTO game_profiles (telegram_user_id, username, display_name) VALUES (?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      username = excluded.username, display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP
  `).bind(user.id, user.username || null, displayName).run();
}

async function attemptsToday(userId: number, env: ExtendedEnv): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM arena_runs WHERE telegram_user_id = ? AND day_key = ?')
    .bind(userId, arenaDayKey()).first<{ count: number }>();
  return Number(row?.count || 0);
}

async function membership(userId: number, env: ExtendedEnv): Promise<{ team_id: string; role: string } | null> {
  return env.DB.prepare('SELECT team_id, role FROM arena_team_members WHERE telegram_user_id = ? LIMIT 1')
    .bind(userId).first<{ team_id: string; role: string }>();
}

async function teamForUser(userId: number, env: ExtendedEnv): Promise<TeamRow | null> {
  const row = await env.DB.prepare(`
    SELECT t.id, t.code, t.name, t.owner_user_id, t.created_at, m.role,
      (SELECT COUNT(*) FROM arena_team_members x WHERE x.team_id = t.id) AS member_count,
      COALESCE((SELECT SUM(r.score) FROM arena_runs r WHERE r.team_id = t.id AND r.week_key = ?), 0) AS weekly_points,
      COALESCE((SELECT SUM(r.score) FROM arena_runs r WHERE r.team_id = t.id AND r.season_key = ?), 0) AS season_points
    FROM arena_team_members m JOIN arena_teams t ON t.id = m.team_id
    WHERE m.telegram_user_id = ? LIMIT 1
  `).bind(latencyStrikeWeekKey(), arenaSeasonKey(), userId).first<TeamRow>();
  return row || null;
}

async function buildArenaProfile(userId: number, env: ExtendedEnv) {
  const profile = await env.DB.prepare(`
    SELECT telegram_user_id, username, display_name, total_xp, total_games, best_score,
      equipped_frame, equipped_icon, equipped_badge, equipped_waveform, equipped_theme, equipped_title
    FROM game_profiles WHERE telegram_user_id = ? LIMIT 1
  `).bind(userId).first<Record<string, unknown>>();
  return {
    profile: profile ? { ...profile, rank: latencyStrikeRank(Number(profile.total_xp || 0)) } : null,
    team: await teamForUser(userId, env),
    attempts_today: await attemptsToday(userId, env),
    attempts_limit: DAILY_ATTEMPTS,
    weekly_position: await playerWeeklyPosition(userId, env),
  };
}

async function playerWeeklyPosition(userId: number, env: ExtendedEnv): Promise<number | null> {
  const rows = await playerLeaderboard(env, 'week', 1000);
  const index = rows.findIndex((row) => Number(row.telegram_user_id) === userId);
  return index >= 0 ? index + 1 : null;
}

async function playerLeaderboard(
  env: ExtendedEnv,
  period: 'week' | 'season',
  limit: number,
): Promise<Array<Record<string, unknown> & { position: number }>> {
  const column = period === 'week' ? 'r.week_key' : 'r.season_key';
  const value = period === 'week' ? latencyStrikeWeekKey() : arenaSeasonKey();
  const result = await env.DB.prepare(`
    SELECT p.telegram_user_id, p.username, p.display_name, p.equipped_frame, p.equipped_icon,
      p.equipped_badge, p.equipped_theme, p.equipped_title,
      SUM(r.score) AS points, COUNT(*) AS games, MAX(r.score) AS best_score
    FROM arena_runs r JOIN game_profiles p ON p.telegram_user_id = r.telegram_user_id
    WHERE ${column} = ? GROUP BY p.telegram_user_id
    ORDER BY points DESC, best_score DESC, games ASC LIMIT ?
  `).bind(value, limit).all<Record<string, unknown>>();
  return ((result.results || []).map((row, index) => ({ ...row, position: index + 1 })))
    as Array<Record<string, unknown> & { position: number }>;
}

async function teamLeaderboard(env: ExtendedEnv, period: 'week' | 'season', limit: number) {
  const column = period === 'week' ? 'week_key' : 'season_key';
  const value = period === 'week' ? latencyStrikeWeekKey() : arenaSeasonKey();
  const result = await env.DB.prepare(`
    SELECT t.id, t.code, t.name,
      (SELECT COUNT(*) FROM arena_team_members m WHERE m.team_id = t.id) AS members,
      COALESCE((SELECT SUM(r.score) FROM arena_runs r WHERE r.team_id = t.id AND r.${column} = ?), 0) AS points,
      COALESCE((SELECT COUNT(*) FROM arena_runs r WHERE r.team_id = t.id AND r.${column} = ?), 0) AS games
    FROM arena_teams t
    ORDER BY points DESC, members DESC, t.created_at ASC LIMIT ?
  `).bind(value, value, limit).all<Record<string, unknown>>();
  return (result.results || []).map((row, index) => ({ position: index + 1, ...row }));
}

async function uniqueTeamCode(env: ExtendedEnv): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = randomToken(6).slice(0, 6).toUpperCase();
    if (!await env.DB.prepare('SELECT 1 AS ok FROM arena_teams WHERE code = ? LIMIT 1').bind(code).first()) return code;
  }
  throw new Error('Unable to allocate unique team code');
}

function normalizeTeamName(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return TEAM_NAME_PATTERN.test(normalized) ? normalized : null;
}

function publicQuestion(question: ArenaQuestion) {
  return { id: question.id, category: question.category, prompt: question.prompt, options: question.options };
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
