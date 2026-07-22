import type { Env } from './types';
import { applyD1SchemaStatements } from './schema';
import { validateTelegramInitData } from './telegram_platform';
import { rateLimit, readEnvInt } from './utils';

type RewardType = 'frame' | 'icon' | 'badge' | 'waveform' | 'theme' | 'title';
type RankId = 'recruit' | 'runner' | 'operator' | 'commander' | 'queue_master';

type ExtendedEnv = Env & {
  TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS?: string;
};

interface TelegramGameUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface ReactionRoundInput {
  reaction_ms?: number | null;
  false_start?: boolean;
}

interface NormalizedRound {
  reactionMs: number | null;
  falseStart: boolean;
}

interface ScoreResult {
  score: number;
  xp: number;
  rounds: number;
  accuracy: number;
  avgReactionMs: number;
  bestReactionMs: number;
  falseStarts: number;
}

interface GameProfileRow {
  telegram_user_id: number;
  username: string | null;
  display_name: string;
  total_xp: number;
  total_games: number;
  best_score: number;
  best_reaction_ms: number | null;
  current_streak: number;
  equipped_frame: string;
  equipped_icon: string;
  equipped_badge: string;
  equipped_waveform: string;
  equipped_theme: string;
  equipped_title: string;
  created_at: string;
  updated_at: string;
}

interface RewardDefinition {
  id: string;
  type: RewardType;
  name: string;
  description: string;
  glyph: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  unlock: {
    xp?: number;
    games?: number;
    bestReactionMs?: number;
    streak?: number;
    weeklyRank?: number;
  };
}

interface LeaderboardRow {
  telegram_user_id: number;
  username: string | null;
  display_name: string;
  score: number;
  avg_reaction_ms: number;
  games_played: number;
  equipped_frame: string;
  equipped_icon: string;
  equipped_badge: string;
  equipped_waveform: string;
  equipped_theme: string;
  equipped_title: string;
}

const GAME_VERSION = '1.0.0';
const GAME_ROUNDS = 5;
const SESSION_TTL_SECONDS = 600;
const DEFAULT_REWARDS = [
  'frame_neon',
  'icon_pulse',
  'badge_recruit',
  'waveform_pulse',
  'theme_violet',
  'title_recruit',
] as const;

export const LATENCY_STRIKE_REWARDS: RewardDefinition[] = [
  { id: 'frame_neon', type: 'frame', name: 'Neon Frame', description: 'Стартова неонова рамка.', glyph: '◉', rarity: 'common', unlock: { xp: 0 } },
  { id: 'frame_signal', type: 'frame', name: 'Signal Frame', description: 'Рамка за стабилни оператори.', glyph: '◎', rarity: 'rare', unlock: { xp: 600 } },
  { id: 'frame_overdrive', type: 'frame', name: 'Overdrive Frame', description: 'Анимирана рамка за висока скорост.', glyph: '◍', rarity: 'epic', unlock: { xp: 1800 } },
  { id: 'frame_champion', type: 'frame', name: 'Weekly Champion', description: 'Рамка за достигане на седмичния Top 3.', glyph: '✦', rarity: 'legendary', unlock: { weeklyRank: 3 } },

  { id: 'icon_pulse', type: 'icon', name: 'Pulse', description: 'Основна профилна иконка.', glyph: '◌', rarity: 'common', unlock: { xp: 0 } },
  { id: 'icon_lightning', type: 'icon', name: 'Lightning', description: 'Отключва се след първите бързи реакции.', glyph: 'ϟ', rarity: 'rare', unlock: { xp: 250 } },
  { id: 'icon_crosshair', type: 'icon', name: 'Crosshair', description: 'За реакция под 260 ms.', glyph: '⌾', rarity: 'epic', unlock: { bestReactionMs: 260 } },
  { id: 'icon_crown', type: 'icon', name: 'Crown', description: 'Награда за седмичния Top 10.', glyph: '♛', rarity: 'legendary', unlock: { weeklyRank: 10 } },

  { id: 'badge_recruit', type: 'badge', name: 'Recruit Badge', description: 'Начален animated badge.', glyph: 'R', rarity: 'common', unlock: { xp: 0 } },
  { id: 'badge_hot_streak', type: 'badge', name: 'Hot Streak', description: 'Пет чисти игри под контрол.', glyph: 'S', rarity: 'rare', unlock: { streak: 5 } },
  { id: 'badge_precision', type: 'badge', name: 'Precision', description: 'Реакция под 220 ms.', glyph: 'P', rarity: 'epic', unlock: { bestReactionMs: 220 } },
  { id: 'badge_queue_master', type: 'badge', name: 'Queue Master', description: 'Легендарен animated badge.', glyph: 'QM', rarity: 'legendary', unlock: { xp: 3000 } },

  { id: 'waveform_pulse', type: 'waveform', name: 'Pulse Wave', description: 'Класически персонален waveform.', glyph: '▂▅▇▅▂', rarity: 'common', unlock: { xp: 0 } },
  { id: 'waveform_surge', type: 'waveform', name: 'Surge Wave', description: 'Динамичен waveform за 1000 XP.', glyph: '▁▃▆█▆▃▁', rarity: 'rare', unlock: { xp: 1000 } },
  { id: 'waveform_void', type: 'waveform', name: 'Void Wave', description: 'Тъмна форма за елитни играчи.', glyph: '▇▂▆▁▆▂▇', rarity: 'epic', unlock: { xp: 2500 } },

  { id: 'theme_violet', type: 'theme', name: 'Violet Core', description: 'Основната DyrakArmy тема.', glyph: 'V', rarity: 'common', unlock: { xp: 0 } },
  { id: 'theme_cyan', type: 'theme', name: 'Cyan Pulse', description: 'Студена светлинна тема.', glyph: 'C', rarity: 'rare', unlock: { xp: 500 } },
  { id: 'theme_crimson', type: 'theme', name: 'Crimson Strike', description: 'Тема за опитни оператори.', glyph: 'X', rarity: 'epic', unlock: { xp: 1600 } },
  { id: 'theme_gold', type: 'theme', name: 'Champion Gold', description: 'Седмична Top 3 тема.', glyph: 'G', rarity: 'legendary', unlock: { weeklyRank: 3 } },

  { id: 'title_recruit', type: 'title', name: 'Recruit', description: 'Начално заглавие.', glyph: 'R', rarity: 'common', unlock: { xp: 0 } },
  { id: 'title_latency_hunter', type: 'title', name: 'Latency Hunter', description: 'Заглавие за 500 XP.', glyph: 'LH', rarity: 'rare', unlock: { xp: 500 } },
  { id: 'title_signal_operator', type: 'title', name: 'Signal Operator', description: 'Заглавие за 30 завършени игри.', glyph: 'SO', rarity: 'epic', unlock: { games: 30 } },
  { id: 'title_queue_master', type: 'title', name: 'Queue Master', description: 'Най-високото игрово заглавие.', glyph: 'QM', rarity: 'legendary', unlock: { xp: 3000 } },
];

let schemaReady: Promise<void> | null = null;

export function latencyStrikeWeekKey(date = new Date()): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function latencyStrikeRank(totalXp: number): { id: RankId; name: string; minXp: number; nextXp: number | null } {
  const xp = Math.max(0, Math.floor(Number(totalXp) || 0));
  if (xp >= 3000) return { id: 'queue_master', name: 'Queue Master', minXp: 3000, nextXp: null };
  if (xp >= 1500) return { id: 'commander', name: 'Commander', minXp: 1500, nextXp: 3000 };
  if (xp >= 700) return { id: 'operator', name: 'Operator', minXp: 700, nextXp: 1500 };
  if (xp >= 250) return { id: 'runner', name: 'Runner', minXp: 250, nextXp: 700 };
  return { id: 'recruit', name: 'Recruit', minXp: 0, nextXp: 250 };
}

export function calculateLatencyStrikeScore(input: ReactionRoundInput[]): ScoreResult {
  const rounds = input.slice(0, GAME_ROUNDS).map(normalizeRound);
  while (rounds.length < GAME_ROUNDS) rounds.push({ reactionMs: null, falseStart: true });

  const valid = rounds.filter((round) => !round.falseStart && round.reactionMs !== null);
  const falseStarts = rounds.length - valid.length;
  const reactions = valid.map((round) => round.reactionMs as number);
  const bestReactionMs = reactions.length ? Math.min(...reactions) : 2000;
  const avgReactionMs = reactions.length
    ? Math.round(reactions.reduce((sum, value) => sum + value, 0) / reactions.length)
    : 2000;
  const accuracy = Math.round((valid.length / GAME_ROUNDS) * 100);
  const reactionPoints = reactions.reduce((sum, reaction) => sum + Math.max(0, 1300 - reaction) * 2, 0);
  const accuracyBonus = accuracy * 20;
  const cleanBonus = falseStarts === 0 ? 1000 : 0;
  const precisionBonus = bestReactionMs <= 220 ? 900 : bestReactionMs <= 280 ? 450 : 0;
  const penalty = falseStarts * 700;
  const score = Math.max(0, Math.round(reactionPoints + accuracyBonus + cleanBonus + precisionBonus - penalty));
  const xp = Math.max(20, Math.min(700, Math.round(score / 22)));

  return {
    score,
    xp,
    rounds: GAME_ROUNDS,
    accuracy,
    avgReactionMs,
    bestReactionMs,
    falseStarts,
  };
}

export function eligibleLatencyStrikeRewards(
  profile: Pick<GameProfileRow, 'total_xp' | 'total_games' | 'best_reaction_ms' | 'current_streak'>,
  weeklyRank: number | null,
): string[] {
  return LATENCY_STRIKE_REWARDS.filter((reward) => {
    const rule = reward.unlock;
    if (rule.xp !== undefined && profile.total_xp < rule.xp) return false;
    if (rule.games !== undefined && profile.total_games < rule.games) return false;
    if (rule.bestReactionMs !== undefined && (profile.best_reaction_ms === null || profile.best_reaction_ms > rule.bestReactionMs)) return false;
    if (rule.streak !== undefined && profile.current_streak < rule.streak) return false;
    if (rule.weeklyRank !== undefined && (weeklyRank === null || weeklyRank > rule.weeklyRank)) return false;
    return true;
  }).map((reward) => reward.id);
}

export async function handleLatencyStrikeApi(request: Request, env: ExtendedEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/games/latency-strike/')) return null;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }

  await ensureLatencyStrikeSchema(env);

  if (url.pathname === '/api/games/latency-strike/config' && request.method === 'GET') {
    return json(request, {
      ok: true,
      game: 'latency-strike',
      version: GAME_VERSION,
      rounds: GAME_ROUNDS,
      week_key: latencyStrikeWeekKey(),
      rewards: LATENCY_STRIKE_REWARDS,
      ranks: [
        latencyStrikeRank(0), latencyStrikeRank(250), latencyStrikeRank(700),
        latencyStrikeRank(1500), latencyStrikeRank(3000),
      ],
    });
  }

  if (url.pathname === '/api/games/latency-strike/leaderboard' && request.method === 'GET') {
    const limit = Math.min(100, Math.max(5, Number(url.searchParams.get('limit') || 25)));
    const weekKey = latencyStrikeWeekKey();
    const rows = await leaderboard(env, weekKey, limit);
    return json(request, {
      ok: true,
      week_key: weekKey,
      entries: rows.map((row, index) => leaderboardPayload(row, index + 1)),
    });
  }

  if (request.method !== 'POST') return json(request, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, 405);

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const initData = String(body?.init_data ?? '');
  const auth = await validateTelegramInitData(
    initData,
    String(env.TELEGRAM_BOT_TOKEN || ''),
    Math.min(3600, Math.max(60, readEnvInt(env.TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS, 900))),
  );
  if (!auth.ok || !auth.user) {
    return json(request, { error: { code: 'TELEGRAM_AUTH_FAILED', message: auth.error || 'Unauthorized' } }, 401);
  }
  const user = auth.user as TelegramGameUser;
  await upsertProfileIdentity(user, env);

  if (url.pathname === '/api/games/latency-strike/profile') {
    return json(request, { ok: true, ...(await buildProfileResponse(user.id, env)) });
  }

  if (url.pathname === '/api/games/latency-strike/session') {
    const limited = await rateLimit(env.CACHE, `game:latency:session:${user.id}`, 12, 60);
    if (limited.limited) return json(request, { error: { code: 'RATE_LIMITED', message: 'Too many sessions' } }, 429);
    const sessionId = randomToken(24);
    const issuedAt = Math.floor(Date.now() / 1000);
    await env.CACHE.put(`game:latency:session:${sessionId}`, JSON.stringify({
      user_id: user.id,
      issued_at: issuedAt,
      rounds: GAME_ROUNDS,
    }), { expirationTtl: SESSION_TTL_SECONDS });
    return json(request, {
      ok: true,
      session_id: sessionId,
      rounds: GAME_ROUNDS,
      expires_in: SESSION_TTL_SECONDS,
      phases: ['QUEUED', 'PROCESSING', 'READY'],
    });
  }

  if (url.pathname === '/api/games/latency-strike/score') {
    const sessionId = String(body?.session_id ?? '').trim();
    if (!/^[a-f0-9]{48}$/.test(sessionId)) {
      return json(request, { error: { code: 'INVALID_SESSION', message: 'Invalid game session' } }, 400);
    }
    const sessionKey = `game:latency:session:${sessionId}`;
    const rawSession = await env.CACHE.get(sessionKey);
    if (!rawSession) return json(request, { error: { code: 'SESSION_EXPIRED', message: 'Game session expired or used' } }, 409);
    const session = JSON.parse(rawSession) as { user_id?: number; rounds?: number };
    if (session.user_id !== user.id || session.rounds !== GAME_ROUNDS) {
      return json(request, { error: { code: 'SESSION_MISMATCH', message: 'Game session mismatch' } }, 403);
    }
    await env.CACHE.delete(sessionKey);

    const rounds = Array.isArray(body?.rounds) ? body.rounds as ReactionRoundInput[] : [];
    const result = calculateLatencyStrikeScore(rounds);
    const weekKey = latencyStrikeWeekKey();
    const runId = crypto.randomUUID();
    const profileBefore = await loadProfile(user.id, env);
    if (!profileBefore) return json(request, { error: { code: 'PROFILE_MISSING', message: 'Profile unavailable' } }, 500);
    const nextStreak = result.falseStarts === 0 && result.avgReactionMs <= 450
      ? profileBefore.current_streak + 1
      : 0;

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO game_runs (
          id, telegram_user_id, week_key, score, avg_reaction_ms, best_reaction_ms,
          accuracy, rounds, false_starts, xp_earned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        runId, user.id, weekKey, result.score, result.avgReactionMs, result.bestReactionMs,
        result.accuracy, result.rounds, result.falseStarts, result.xp,
      ),
      env.DB.prepare(`
        UPDATE game_profiles SET
          total_xp = total_xp + ?,
          total_games = total_games + 1,
          best_score = MAX(best_score, ?),
          best_reaction_ms = CASE
            WHEN best_reaction_ms IS NULL THEN ?
            ELSE MIN(best_reaction_ms, ?)
          END,
          current_streak = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE telegram_user_id = ?
      `).bind(result.xp, result.score, result.bestReactionMs, result.bestReactionMs, nextStreak, user.id),
    ]);

    const weeklyRank = await getWeeklyRank(user.id, env, weekKey);
    const profile = await loadProfile(user.id, env);
    if (!profile) return json(request, { error: { code: 'PROFILE_MISSING', message: 'Profile unavailable' } }, 500);
    const newlyUnlocked = await grantEligibleRewards(profile, weeklyRank, env);
    return json(request, {
      ok: true,
      run_id: runId,
      result,
      newly_unlocked: newlyUnlocked.map(rewardById).filter(Boolean),
      ...(await buildProfileResponse(user.id, env)),
    });
  }

  if (url.pathname === '/api/games/latency-strike/equip') {
    const rewardId = String(body?.reward_id ?? '').trim();
    const reward = rewardById(rewardId);
    if (!reward) return json(request, { error: { code: 'UNKNOWN_REWARD', message: 'Unknown reward' } }, 404);
    const unlocked = await env.DB.prepare(
      'SELECT 1 AS ok FROM game_unlocks WHERE telegram_user_id = ? AND reward_id = ? LIMIT 1',
    ).bind(user.id, rewardId).first<{ ok: number }>();
    if (!unlocked) return json(request, { error: { code: 'REWARD_LOCKED', message: 'Reward is locked' } }, 403);

    const column = equippedColumn(reward.type);
    await env.DB.prepare(`UPDATE game_profiles SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?`)
      .bind(rewardId, user.id).run();
    return json(request, { ok: true, ...(await buildProfileResponse(user.id, env)) });
  }

  return json(request, { error: { code: 'NOT_FOUND', message: 'Game endpoint not found' } }, 404);
}

export async function getLatencyStrikeBotSummary(
  telegramUserId: number,
  env: ExtendedEnv,
  language: 'bg' | 'en' = 'bg',
): Promise<string> {
  await ensureLatencyStrikeSchema(env);
  const profile = await loadProfile(telegramUserId, env);
  if (!profile) {
    return language === 'bg'
      ? '🎮 Latency Strike\n\nВсе още нямаш игрови профил. Стартирай играта, за да отключиш награди.'
      : '🎮 Latency Strike\n\nYou do not have a game profile yet. Start the game to unlock rewards.';
  }
  const weekKey = latencyStrikeWeekKey();
  const weeklyRank = await getWeeklyRank(telegramUserId, env, weekKey);
  const rank = latencyStrikeRank(profile.total_xp);
  const title = rewardById(profile.equipped_title)?.name || rank.name;
  const badge = rewardById(profile.equipped_badge)?.name || 'Recruit Badge';
  const position = weeklyRank ? `#${weeklyRank}` : '—';
  return language === 'bg'
    ? [
        '🎮 Latency Strike профил', '',
        `🏅 Ранг: ${rank.name}`,
        `🏷 Заглавие: ${title}`,
        `✨ Badge: ${badge}`,
        `⚡ XP: ${profile.total_xp}`,
        `🎯 Най-добра реакция: ${profile.best_reaction_ms ?? '—'} ms`,
        `🏆 Седмична позиция: ${position}`,
        `🎲 Изиграни игри: ${profile.total_games}`,
      ].join('\n')
    : [
        '🎮 Latency Strike profile', '',
        `🏅 Rank: ${rank.name}`,
        `🏷 Title: ${title}`,
        `✨ Badge: ${badge}`,
        `⚡ XP: ${profile.total_xp}`,
        `🎯 Best reaction: ${profile.best_reaction_ms ?? '—'} ms`,
        `🏆 Weekly position: ${position}`,
        `🎲 Games played: ${profile.total_games}`,
      ].join('\n');
}

function normalizeRound(input: ReactionRoundInput): NormalizedRound {
  if (input?.false_start) return { reactionMs: null, falseStart: true };
  const value = Math.round(Number(input?.reaction_ms));
  if (!Number.isFinite(value) || value < 80 || value > 2000) return { reactionMs: null, falseStart: true };
  return { reactionMs: value, falseStart: false };
}

async function ensureLatencyStrikeSchema(env: ExtendedEnv): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await applyD1SchemaStatements(env, [
      `CREATE TABLE IF NOT EXISTS game_profiles (
        telegram_user_id INTEGER PRIMARY KEY,
        username TEXT,
        display_name TEXT NOT NULL,
        total_xp INTEGER NOT NULL DEFAULT 0,
        total_games INTEGER NOT NULL DEFAULT 0,
        best_score INTEGER NOT NULL DEFAULT 0,
        best_reaction_ms INTEGER,
        current_streak INTEGER NOT NULL DEFAULT 0,
        equipped_frame TEXT NOT NULL DEFAULT 'frame_neon',
        equipped_icon TEXT NOT NULL DEFAULT 'icon_pulse',
        equipped_badge TEXT NOT NULL DEFAULT 'badge_recruit',
        equipped_waveform TEXT NOT NULL DEFAULT 'waveform_pulse',
        equipped_theme TEXT NOT NULL DEFAULT 'theme_violet',
        equipped_title TEXT NOT NULL DEFAULT 'title_recruit',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS game_runs (
        id TEXT PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL,
        week_key TEXT NOT NULL,
        score INTEGER NOT NULL,
        avg_reaction_ms INTEGER NOT NULL,
        best_reaction_ms INTEGER NOT NULL,
        accuracy INTEGER NOT NULL,
        rounds INTEGER NOT NULL,
        false_starts INTEGER NOT NULL DEFAULT 0,
        xp_earned INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      'CREATE INDEX IF NOT EXISTS idx_game_runs_week_score ON game_runs(week_key, score DESC, avg_reaction_ms ASC, created_at ASC)',
      'CREATE INDEX IF NOT EXISTS idx_game_runs_user_created ON game_runs(telegram_user_id, created_at DESC)',
      `CREATE TABLE IF NOT EXISTS game_unlocks (
        telegram_user_id INTEGER NOT NULL,
        reward_id TEXT NOT NULL,
        unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (telegram_user_id, reward_id)
      )`,
    ]);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function upsertProfileIdentity(user: TelegramGameUser, env: ExtendedEnv): Promise<void> {
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 96) || `Player ${user.id}`;
  await env.DB.prepare(`
    INSERT INTO game_profiles (telegram_user_id, username, display_name)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      updated_at = CURRENT_TIMESTAMP
  `).bind(user.id, user.username || null, displayName).run();
  await env.DB.batch(DEFAULT_REWARDS.map((rewardId) => env.DB.prepare(
    'INSERT OR IGNORE INTO game_unlocks (telegram_user_id, reward_id) VALUES (?, ?)',
  ).bind(user.id, rewardId)));
}

async function loadProfile(userId: number, env: ExtendedEnv): Promise<GameProfileRow | null> {
  return env.DB.prepare('SELECT * FROM game_profiles WHERE telegram_user_id = ? LIMIT 1')
    .bind(userId).first<GameProfileRow>();
}

async function buildProfileResponse(userId: number, env: ExtendedEnv): Promise<Record<string, unknown>> {
  const profile = await loadProfile(userId, env);
  if (!profile) return { profile: null, unlocked_rewards: [], weekly_rank: null };
  const weekKey = latencyStrikeWeekKey();
  const weeklyRank = await getWeeklyRank(userId, env, weekKey);
  await grantEligibleRewards(profile, weeklyRank, env);
  const unlockRows = await env.DB.prepare(
    'SELECT reward_id FROM game_unlocks WHERE telegram_user_id = ? ORDER BY unlocked_at ASC',
  ).bind(userId).all<{ reward_id: string }>();
  const unlockedIds = (unlockRows.results || []).map((row) => row.reward_id);
  const refreshed = await loadProfile(userId, env) || profile;
  return {
    profile: profilePayload(refreshed, weeklyRank),
    unlocked_rewards: unlockedIds.map(rewardById).filter(Boolean),
    weekly_rank: weeklyRank,
    week_key: weekKey,
  };
}

async function grantEligibleRewards(profile: GameProfileRow, weeklyRank: number | null, env: ExtendedEnv): Promise<string[]> {
  const eligible = eligibleLatencyStrikeRewards(profile, weeklyRank);
  if (!eligible.length) return [];
  const existingRows = await env.DB.prepare(
    'SELECT reward_id FROM game_unlocks WHERE telegram_user_id = ?',
  ).bind(profile.telegram_user_id).all<{ reward_id: string }>();
  const existing = new Set((existingRows.results || []).map((row) => row.reward_id));
  const newIds = eligible.filter((id) => !existing.has(id));
  if (newIds.length) {
    await env.DB.batch(newIds.map((rewardId) => env.DB.prepare(
      'INSERT OR IGNORE INTO game_unlocks (telegram_user_id, reward_id) VALUES (?, ?)',
    ).bind(profile.telegram_user_id, rewardId)));
  }
  return newIds;
}

async function getWeeklyRank(userId: number, env: ExtendedEnv, weekKey: string): Promise<number | null> {
  const result = await env.DB.prepare(`
    WITH best AS (
      SELECT telegram_user_id, MAX(score) AS score, MIN(avg_reaction_ms) AS avg_reaction_ms
      FROM game_runs WHERE week_key = ? GROUP BY telegram_user_id
    ), ranked AS (
      SELECT telegram_user_id,
        ROW_NUMBER() OVER (ORDER BY score DESC, avg_reaction_ms ASC, telegram_user_id ASC) AS rank
      FROM best
    )
    SELECT rank FROM ranked WHERE telegram_user_id = ? LIMIT 1
  `).bind(weekKey, userId).first<{ rank: number }>();
  return result?.rank ? Number(result.rank) : null;
}

async function leaderboard(env: ExtendedEnv, weekKey: string, limit: number): Promise<LeaderboardRow[]> {
  const result = await env.DB.prepare(`
    WITH best AS (
      SELECT telegram_user_id, MAX(score) AS score, MIN(avg_reaction_ms) AS avg_reaction_ms, COUNT(*) AS games_played
      FROM game_runs WHERE week_key = ? GROUP BY telegram_user_id
    )
    SELECT p.telegram_user_id, p.username, p.display_name, b.score, b.avg_reaction_ms, b.games_played,
      p.equipped_frame, p.equipped_icon, p.equipped_badge, p.equipped_waveform,
      p.equipped_theme, p.equipped_title
    FROM best b JOIN game_profiles p ON p.telegram_user_id = b.telegram_user_id
    ORDER BY b.score DESC, b.avg_reaction_ms ASC, p.telegram_user_id ASC
    LIMIT ?
  `).bind(weekKey, limit).all<LeaderboardRow>();
  return result.results || [];
}

function profilePayload(profile: GameProfileRow, weeklyRank: number | null): Record<string, unknown> {
  const rank = latencyStrikeRank(profile.total_xp);
  return {
    telegram_user_id: profile.telegram_user_id,
    username: profile.username,
    display_name: profile.display_name,
    total_xp: profile.total_xp,
    total_games: profile.total_games,
    best_score: profile.best_score,
    best_reaction_ms: profile.best_reaction_ms,
    current_streak: profile.current_streak,
    rank,
    weekly_rank: weeklyRank,
    equipped: {
      frame: profile.equipped_frame,
      icon: profile.equipped_icon,
      badge: profile.equipped_badge,
      waveform: profile.equipped_waveform,
      theme: profile.equipped_theme,
      title: profile.equipped_title,
    },
  };
}

function leaderboardPayload(row: LeaderboardRow, rank: number): Record<string, unknown> {
  return {
    rank,
    telegram_user_id: row.telegram_user_id,
    username: row.username,
    display_name: row.display_name,
    score: row.score,
    avg_reaction_ms: row.avg_reaction_ms,
    games_played: row.games_played,
    equipped: {
      frame: row.equipped_frame,
      icon: row.equipped_icon,
      badge: row.equipped_badge,
      waveform: row.equipped_waveform,
      theme: row.equipped_theme,
      title: row.equipped_title,
    },
  };
}

function rewardById(id: string): RewardDefinition | undefined {
  return LATENCY_STRIKE_REWARDS.find((reward) => reward.id === id);
}

function equippedColumn(type: RewardType): string {
  const columns: Record<RewardType, string> = {
    frame: 'equipped_frame',
    icon: 'equipped_icon',
    badge: 'equipped_badge',
    waveform: 'equipped_waveform',
    theme: 'equipped_theme',
    title: 'equipped_title',
  };
  return columns[type];
}

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
}

function json(request: Request, payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: corsHeaders(request) });
}

function randomToken(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (value) => value.toString(16).padStart(2, '0')).join('');
}
