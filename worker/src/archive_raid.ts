import type { Env } from './types';
import { latencyStrikeRank, latencyStrikeWeekKey } from './latency_strike';
import { applyD1SchemaStatements } from './schema';
import { validateTelegramInitData } from './telegram_platform';
import { rateLimit, readEnvInt } from './utils';

type ExtendedEnv = Env & { TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS?: string };
export type ArchiveRaidRarity = 'Common' | 'Rare' | 'Epic' | 'Legendary' | 'Army Exclusive';
export type ArchiveRaidCategory = 'genre' | 'waveform' | 'bot_skin' | 'server_core' | 'badge' | 'artist_archetype' | 'profile_effect';
type RaidRoute = 'scan' | 'breach' | 'extract';

interface TelegramRaidUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface ArchiveRaidCard {
  id: string;
  category: ArchiveRaidCategory;
  rarity: ArchiveRaidRarity;
  title: string;
  description: string;
  icon: string;
  power: number;
}

interface RaidChoiceInput {
  room_index?: number;
  route?: RaidRoute;
  response_ms?: number;
}

interface RaidSession {
  user_id: number;
  practice: boolean;
  day_key: string;
  seed: number;
  issued_at: number;
}

export interface ArchiveRaidOutcome {
  score: number;
  xp: number;
  shards: number;
  successful_rooms: number;
  failed_rooms: number;
  best_combo: number;
  drops: ArchiveRaidCard[];
}

const GAME_VERSION = '1.0.0';
const RAID_ROOMS = 5;
const DAILY_RANKED_ATTEMPTS = 4;
const SESSION_TTL_SECONDS = 900;
const ROUTES: Record<RaidRoute, { base: number; risk: number; rarity_bonus: number }> = {
  scan: { base: 320, risk: 18, rarity_bonus: 0 },
  extract: { base: 500, risk: 30, rarity_bonus: 6 },
  breach: { base: 760, risk: 48, rarity_bonus: 14 },
};

export const ARCHIVE_RAID_CARDS: ArchiveRaidCard[] = [
  { id: 'genre_dark_techno', category: 'genre', rarity: 'Common', title: 'Dark Techno Archive', description: 'Collectible genre archive card.', icon: '◼', power: 8 },
  { id: 'genre_industrial', category: 'genre', rarity: 'Rare', title: 'Industrial Vault', description: 'Heavy mechanical genre signature.', icon: '⚙', power: 18 },
  { id: 'genre_hypnotic', category: 'genre', rarity: 'Epic', title: 'Hypnotic Sector', description: 'Deep-loop archive archetype.', icon: '◎', power: 34 },
  { id: 'waveform_pulse', category: 'waveform', rarity: 'Common', title: 'Pulse Waveform', description: 'Clean animated profile waveform.', icon: '〰', power: 7 },
  { id: 'waveform_neon_grid', category: 'waveform', rarity: 'Rare', title: 'Neon Grid', description: 'Layered neon waveform design.', icon: '≋', power: 19 },
  { id: 'waveform_void', category: 'waveform', rarity: 'Legendary', title: 'Void Wave', description: 'Rare black-hole waveform effect.', icon: '∿', power: 72 },
  { id: 'bot_skin_scout', category: 'bot_skin', rarity: 'Common', title: 'Scout Bot', description: 'Fast archive reconnaissance skin.', icon: '🤖', power: 9 },
  { id: 'bot_skin_sentinel', category: 'bot_skin', rarity: 'Epic', title: 'Sentinel Bot', description: 'Armored DyrakArmy bot skin.', icon: '🦾', power: 42 },
  { id: 'bot_skin_ghost', category: 'bot_skin', rarity: 'Army Exclusive', title: 'Ghost Protocol', description: 'DyrakArmy-only spectral bot skin.', icon: '👻', power: 100 },
  { id: 'server_core_edge', category: 'server_core', rarity: 'Common', title: 'Edge Core', description: 'Stable edge-compute collectible.', icon: '◆', power: 10 },
  { id: 'server_core_quantum', category: 'server_core', rarity: 'Epic', title: 'Quantum Core', description: 'High-output virtual server core.', icon: '✦', power: 48 },
  { id: 'server_core_army', category: 'server_core', rarity: 'Army Exclusive', title: 'Army Mainframe', description: 'Exclusive command-grade core.', icon: '⬢', power: 100 },
  { id: 'badge_raider', category: 'badge', rarity: 'Common', title: 'Archive Raider', description: 'First successful raid badge.', icon: '🛡', power: 6 },
  { id: 'badge_vaultbreaker', category: 'badge', rarity: 'Rare', title: 'Vaultbreaker', description: 'Badge for high-risk extractions.', icon: '🔓', power: 24 },
  { id: 'badge_zero_trace', category: 'badge', rarity: 'Legendary', title: 'Zero Trace', description: 'Legendary flawless-run badge.', icon: '◉', power: 80 },
  { id: 'archetype_selector', category: 'artist_archetype', rarity: 'Common', title: 'The Selector', description: 'Curator-focused artist archetype.', icon: '🎚', power: 8 },
  { id: 'archetype_architect', category: 'artist_archetype', rarity: 'Epic', title: 'Sound Architect', description: 'System-building performer archetype.', icon: '🏗', power: 44 },
  { id: 'archetype_farst', category: 'artist_archetype', rarity: 'Army Exclusive', title: 'FarsT Protocol', description: 'Exclusive dark-techno command archetype.', icon: '☠', power: 100 },
  { id: 'effect_violet', category: 'profile_effect', rarity: 'Common', title: 'Violet Signal', description: 'Subtle violet profile effect.', icon: '✧', power: 7 },
  { id: 'effect_chromatic', category: 'profile_effect', rarity: 'Rare', title: 'Chromatic Distortion', description: 'Animated chromatic profile effect.', icon: '✺', power: 22 },
  { id: 'effect_blackout', category: 'profile_effect', rarity: 'Legendary', title: 'Blackout Field', description: 'Legendary dark profile aura.', icon: '⬤', power: 78 },
];

let schemaReady: Promise<void> | null = null;

export function archiveRaidDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function archiveRaidCardForRoll(roll: number, rarityBonus = 0): ArchiveRaidCard {
  const normalized = clamp(Math.floor(roll) + rarityBonus, 0, 99);
  const rarity: ArchiveRaidRarity = normalized >= 99
    ? 'Army Exclusive'
    : normalized >= 94
      ? 'Legendary'
      : normalized >= 82
        ? 'Epic'
        : normalized >= 58
          ? 'Rare'
          : 'Common';
  const pool = ARCHIVE_RAID_CARDS.filter((card) => card.rarity === rarity);
  return pool[normalized % pool.length] || ARCHIVE_RAID_CARDS[0]!;
}

export function calculateArchiveRaidOutcome(seed: number, choices: RaidChoiceInput[]): ArchiveRaidOutcome {
  const selected = new Map<number, RaidChoiceInput>();
  for (const choice of choices.slice(0, RAID_ROOMS * 2)) {
    const room = Math.floor(Number(choice.room_index));
    if (room >= 0 && room < RAID_ROOMS && !selected.has(room)) selected.set(room, choice);
  }
  let state = seed | 0;
  let score = 0;
  let shards = 0;
  let combo = 0;
  let bestCombo = 0;
  let successfulRooms = 0;
  const drops: ArchiveRaidCard[] = [];

  for (let room = 0; room < RAID_ROOMS; room += 1) {
    state = xorshift32(state + room + 1);
    const hazard = Math.abs(state) % 100;
    const choice = selected.get(room);
    const route = choice?.route && ROUTES[choice.route] ? choice.route : 'scan';
    const rules = ROUTES[route];
    const responseMs = clamp(Math.round(Number(choice?.response_ms) || 12_000), 250, 12_000);
    const speedBonus = Math.max(0, Math.round(360 - responseMs / 35));
    const success = hazard >= rules.risk;
    if (success) {
      successfulRooms += 1;
      combo += 1;
      bestCombo = Math.max(bestCombo, combo);
      score += rules.base + speedBonus + combo * 85;
      shards += 4 + Math.floor(rules.base / 180);
      state = xorshift32(state ^ 0x5f3759df);
      if ((Math.abs(state) % 100) < 28 + rules.rarity_bonus) {
        drops.push(archiveRaidCardForRoll(Math.abs(xorshift32(state)) % 100, rules.rarity_bonus));
      }
    } else {
      combo = 0;
      score = Math.max(0, score - Math.round(rules.base * 0.28));
      shards += 1;
    }
  }

  if (successfulRooms === RAID_ROOMS) {
    score += 1200;
    shards += 18;
    drops.push(archiveRaidCardForRoll(Math.abs(xorshift32(state ^ 0x7f4a7c15)) % 100, 12));
  }
  const normalizedScore = Math.max(0, Math.round(score));
  return {
    score: normalizedScore,
    xp: clamp(Math.round(normalizedScore / 22), 30, 700),
    shards,
    successful_rooms: successfulRooms,
    failed_rooms: RAID_ROOMS - successfulRooms,
    best_combo: bestCombo,
    drops: dedupeDrops(drops).slice(0, 4),
  };
}

export async function handleArchiveRaidApi(request: Request, env: ExtendedEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/games/archive-raid/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  await ensureArchiveRaidSchema(env);

  if (url.pathname === '/api/games/archive-raid/config' && request.method === 'GET') {
    return json(request, {
      ok: true,
      game: 'archive-raid',
      version: GAME_VERSION,
      rooms: RAID_ROOMS,
      daily_ranked_attempts: DAILY_RANKED_ATTEMPTS,
      rarities: ['Common', 'Rare', 'Epic', 'Legendary', 'Army Exclusive'],
      categories: ['genre', 'waveform', 'bot_skin', 'server_core', 'badge', 'artist_archetype', 'profile_effect'],
      protected_content_access: false,
      rewards: ['shared-xp', 'shared-rank', 'collectible-cards', 'profile-cosmetics'],
    });
  }

  if (url.pathname === '/api/games/archive-raid/catalog' && request.method === 'GET') {
    return json(request, { ok: true, cards: ARCHIVE_RAID_CARDS });
  }

  if (url.pathname === '/api/games/archive-raid/leaderboard' && request.method === 'GET') {
    const limit = clamp(Math.floor(Number(url.searchParams.get('limit') || 25)), 5, 100);
    return json(request, { ok: true, week_key: latencyStrikeWeekKey(), entries: await leaderboard(env, limit) });
  }

  if (request.method !== 'POST') return json(request, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, 405);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json(request, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400);
  const practice = body.practice === true;
  const auth = practice ? null : await authenticate(body, env);
  if (!practice && (!auth?.ok || !auth.user)) {
    return json(request, { error: { code: 'TELEGRAM_AUTH_FAILED', message: auth?.error || 'Unauthorized' } }, 401);
  }
  const user = auth?.user as TelegramRaidUser | undefined;
  if (user) await upsertProfile(user, env);

  if (url.pathname === '/api/games/archive-raid/session') {
    const actor = user?.id || request.headers.get('CF-Connecting-IP') || 'practice';
    const limited = await rateLimit(env.CACHE, `game:archive-raid:session:${actor}`, 18, 60);
    if (limited.limited) return json(request, { error: { code: 'RATE_LIMITED', message: 'Too many raid sessions' } }, 429);
    if (user && await attemptsToday(user.id, env) >= DAILY_RANKED_ATTEMPTS) {
      return json(request, { error: { code: 'DAILY_LIMIT', message: 'Daily ranked raids are complete. Practice remains available.' } }, 409);
    }
    const sessionId = randomToken(24);
    const seed = hashString(`${archiveRaidDayKey()}:${sessionId}:${user?.id || actor}`);
    const session: RaidSession = { user_id: user?.id || 0, practice, day_key: archiveRaidDayKey(), seed, issued_at: Math.floor(Date.now() / 1000) };
    await env.CACHE.put(`game:archive-raid:session:${sessionId}`, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
    return json(request, {
      ok: true,
      session_id: sessionId,
      practice,
      expires_in: SESSION_TTL_SECONDS,
      rooms: Array.from({ length: RAID_ROOMS }, (_, room_index) => ({ room_index, routes: Object.keys(ROUTES) })),
    });
  }

  if (url.pathname === '/api/games/archive-raid/resolve') {
    return resolveRaid(request, body, user, env);
  }

  if (!user) return json(request, { error: { code: 'TELEGRAM_REQUIRED', message: 'Telegram identity required' } }, 401);

  if (url.pathname === '/api/games/archive-raid/profile') {
    return json(request, { ok: true, ...(await buildProfile(user.id, env)) });
  }

  if (url.pathname === '/api/games/archive-raid/daily-crate') {
    return claimDailyCrate(request, user, env);
  }

  if (url.pathname === '/api/games/archive-raid/equip') {
    const cardId = String(body.card_id || '').trim();
    const card = ARCHIVE_RAID_CARDS.find((candidate) => candidate.id === cardId);
    if (!card) return json(request, { error: { code: 'CARD_NOT_FOUND', message: 'Unknown card' } }, 404);
    const owned = await env.DB.prepare('SELECT quantity FROM archive_raid_inventory WHERE telegram_user_id = ? AND card_id = ? LIMIT 1')
      .bind(user.id, cardId).first<{ quantity: number }>();
    if (!owned || Number(owned.quantity) < 1) return json(request, { error: { code: 'CARD_NOT_OWNED', message: 'Card is not unlocked' } }, 403);
    const column = equipColumn(card.category);
    if (!column) return json(request, { error: { code: 'NOT_EQUIPPABLE', message: 'This card is collectible-only' } }, 409);
    await env.DB.prepare(`UPDATE game_profiles SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?`)
      .bind(card.id, user.id).run();
    return json(request, { ok: true, equipped: card, ...(await buildProfile(user.id, env)) });
  }

  return json(request, { error: { code: 'NOT_FOUND', message: 'Archive Raid endpoint not found' } }, 404);
}

async function resolveRaid(
  request: Request,
  body: Record<string, unknown>,
  user: TelegramRaidUser | undefined,
  env: ExtendedEnv,
): Promise<Response> {
  const sessionId = String(body.session_id || '').trim();
  if (!/^[a-f0-9]{48}$/.test(sessionId)) return json(request, { error: { code: 'INVALID_SESSION', message: 'Invalid raid session' } }, 400);
  const key = `game:archive-raid:session:${sessionId}`;
  const raw = await env.CACHE.get(key);
  if (!raw) return json(request, { error: { code: 'SESSION_EXPIRED', message: 'Raid session expired or already used' } }, 409);
  const session = JSON.parse(raw) as RaidSession;
  if (session.day_key !== archiveRaidDayKey()) return json(request, { error: { code: 'RAID_EXPIRED', message: 'Daily vault rotation changed' } }, 409);
  if (session.practice !== (body.practice === true)) return json(request, { error: { code: 'SESSION_MISMATCH', message: 'Practice mode mismatch' } }, 403);
  if (!session.practice && (!user || session.user_id !== user.id)) return json(request, { error: { code: 'SESSION_MISMATCH', message: 'Session identity mismatch' } }, 403);
  const choices = Array.isArray(body.choices) ? body.choices as RaidChoiceInput[] : [];
  const outcome = calculateArchiveRaidOutcome(session.seed, choices);
  await env.CACHE.delete(key);

  if (session.practice) return json(request, { ok: true, practice: true, recorded: false, outcome });
  if (!user) return json(request, { error: { code: 'TELEGRAM_REQUIRED', message: 'Telegram identity required' } }, 401);
  if (await attemptsToday(user.id, env) >= DAILY_RANKED_ATTEMPTS) return json(request, { error: { code: 'DAILY_LIMIT', message: 'Daily ranked raids are complete' } }, 409);

  const runId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO archive_raid_runs (
        id, telegram_user_id, day_key, week_key, score, successful_rooms,
        failed_rooms, best_combo, shards_earned, xp_earned
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(runId, user.id, session.day_key, latencyStrikeWeekKey(), outcome.score, outcome.successful_rooms, outcome.failed_rooms, outcome.best_combo, outcome.shards, outcome.xp),
    env.DB.prepare(`
      UPDATE game_profiles SET total_xp = total_xp + ?, total_games = total_games + 1,
        best_score = MAX(best_score, ?), updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
    `).bind(outcome.xp, outcome.score, user.id),
  ]);
  for (const card of outcome.drops) await grantCard(user.id, card.id, 'raid', env);
  return json(request, { ok: true, practice: false, recorded: true, run_id: runId, outcome, ...(await buildProfile(user.id, env)) });
}

async function claimDailyCrate(request: Request, user: TelegramRaidUser, env: ExtendedEnv): Promise<Response> {
  const dayKey = archiveRaidDayKey();
  const existing = await env.DB.prepare('SELECT card_id FROM archive_raid_daily_claims WHERE telegram_user_id = ? AND day_key = ? LIMIT 1')
    .bind(user.id, dayKey).first<{ card_id: string }>();
  if (existing) {
    const card = ARCHIVE_RAID_CARDS.find((candidate) => candidate.id === existing.card_id) || null;
    return json(request, { ok: true, already_claimed: true, card, ...(await buildProfile(user.id, env)) });
  }
  const roll = Math.abs(hashString(`daily:${dayKey}:${user.id}`)) % 100;
  const card = archiveRaidCardForRoll(roll, 4);
  await env.DB.prepare('INSERT INTO archive_raid_daily_claims (telegram_user_id, day_key, card_id) VALUES (?, ?, ?)')
    .bind(user.id, dayKey, card.id).run();
  await grantCard(user.id, card.id, 'daily-crate', env);
  return json(request, { ok: true, already_claimed: false, card, ...(await buildProfile(user.id, env)) });
}

export async function getArchiveRaidBotSummary(
  telegramUserId: number,
  env: ExtendedEnv,
  language: 'bg' | 'en' = 'bg',
): Promise<string> {
  await ensureArchiveRaidSchema(env);
  const profile = await buildProfile(telegramUserId, env);
  const inventory = profile.inventory as Array<{ rarity: ArchiveRaidRarity; quantity: number }>;
  const totalCards = inventory.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const uniqueCards = inventory.length;
  const exclusive = inventory.filter((item) => item.rarity === 'Army Exclusive').length;
  const totalXp = Number((profile.profile as Record<string, unknown> | null)?.total_xp || 0);
  const rank = latencyStrikeRank(totalXp);
  if (language === 'en') {
    return ['🗃 Archive Raid', '', `🃏 Collection: ${uniqueCards}/${ARCHIVE_RAID_CARDS.length} unique · ${totalCards} total`, `👑 Army Exclusive: ${exclusive}`, `⚡ Shared XP: ${totalXp}`, `🏅 Shared rank: ${rank.name}`, `🎯 Ranked raids today: ${profile.attempts_today}/${DAILY_RANKED_ATTEMPTS}`, '', 'Collectibles are virtual cosmetics and never provide access to protected media.'].join('\n');
  }
  return ['🗃 Archive Raid', '', `🃏 Колекция: ${uniqueCards}/${ARCHIVE_RAID_CARDS.length} уникални · ${totalCards} общо`, `👑 Army Exclusive: ${exclusive}`, `⚡ Общ XP: ${totalXp}`, `🏅 Общ ранг: ${rank.name}`, `🎯 Ranked рейдове днес: ${profile.attempts_today}/${DAILY_RANKED_ATTEMPTS}`, '', 'Картите са виртуални козметични награди и не дават достъп до защитена медия.'].join('\n');
}

async function ensureArchiveRaidSchema(env: ExtendedEnv): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = applyD1SchemaStatements(env, [
    `CREATE TABLE IF NOT EXISTS archive_raid_runs (
      id TEXT PRIMARY KEY, telegram_user_id INTEGER NOT NULL, day_key TEXT NOT NULL,
      week_key TEXT NOT NULL, score INTEGER NOT NULL, successful_rooms INTEGER NOT NULL,
      failed_rooms INTEGER NOT NULL, best_combo INTEGER NOT NULL, shards_earned INTEGER NOT NULL,
      xp_earned INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS archive_raid_inventory (
      telegram_user_id INTEGER NOT NULL, card_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'raid', first_unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (telegram_user_id, card_id)
    )`,
    `CREATE TABLE IF NOT EXISTS archive_raid_daily_claims (
      telegram_user_id INTEGER NOT NULL, day_key TEXT NOT NULL, card_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (telegram_user_id, day_key)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_archive_raid_runs_week ON archive_raid_runs(week_key, score DESC, created_at ASC)',
    'CREATE INDEX IF NOT EXISTS idx_archive_raid_runs_user_day ON archive_raid_runs(telegram_user_id, day_key, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_archive_raid_inventory_user ON archive_raid_inventory(telegram_user_id, last_unlocked_at DESC)',
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

async function upsertProfile(user: TelegramRaidUser, env: ExtendedEnv): Promise<void> {
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.username || `Player ${user.id}`;
  await env.DB.prepare(`
    INSERT INTO game_profiles (telegram_user_id, username, display_name) VALUES (?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET username = excluded.username,
      display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP
  `).bind(user.id, user.username || null, displayName).run();
}

async function attemptsToday(userId: number, env: ExtendedEnv): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM archive_raid_runs WHERE telegram_user_id = ? AND day_key = ?')
    .bind(userId, archiveRaidDayKey()).first<{ count: number }>();
  return Number(row?.count || 0);
}

async function grantCard(userId: number, cardId: string, source: string, env: ExtendedEnv): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO archive_raid_inventory (telegram_user_id, card_id, quantity, source)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(telegram_user_id, card_id) DO UPDATE SET
      quantity = quantity + 1, source = excluded.source, last_unlocked_at = CURRENT_TIMESTAMP
  `).bind(userId, cardId, source).run();
}

async function buildProfile(userId: number, env: ExtendedEnv) {
  const profile = await env.DB.prepare(`
    SELECT telegram_user_id, username, display_name, total_xp, total_games, best_score,
      equipped_frame, equipped_icon, equipped_badge, equipped_waveform, equipped_theme, equipped_title
    FROM game_profiles WHERE telegram_user_id = ? LIMIT 1
  `).bind(userId).first<Record<string, unknown>>();
  const inventoryResult = await env.DB.prepare(`
    SELECT card_id, quantity, source, first_unlocked_at, last_unlocked_at
    FROM archive_raid_inventory WHERE telegram_user_id = ? ORDER BY last_unlocked_at DESC
  `).bind(userId).all<Record<string, unknown>>();
  const inventory = (inventoryResult.results || []).map((row) => {
    const card = ARCHIVE_RAID_CARDS.find((candidate) => candidate.id === row.card_id);
    return { ...row, ...(card || {}) };
  });
  return {
    profile: profile ? { ...profile, rank: latencyStrikeRank(Number(profile.total_xp || 0)) } : null,
    inventory,
    collection: { unique: inventory.length, total: inventory.reduce((sum, item) => sum + Number((item as Record<string, unknown>).quantity || 0), 0), catalog_total: ARCHIVE_RAID_CARDS.length },
    attempts_today: await attemptsToday(userId, env),
    attempts_limit: DAILY_RANKED_ATTEMPTS,
  };
}

async function leaderboard(env: ExtendedEnv, limit: number): Promise<Array<Record<string, unknown> & { position: number }>> {
  const result = await env.DB.prepare(`
    SELECT p.telegram_user_id, p.username, p.display_name, p.equipped_icon, p.equipped_badge,
      SUM(r.score) AS points, COUNT(*) AS raids, MAX(r.score) AS best_score,
      SUM(r.shards_earned) AS shards
    FROM archive_raid_runs r JOIN game_profiles p ON p.telegram_user_id = r.telegram_user_id
    WHERE r.week_key = ? GROUP BY p.telegram_user_id
    ORDER BY points DESC, best_score DESC, raids ASC LIMIT ?
  `).bind(latencyStrikeWeekKey(), limit).all<Record<string, unknown>>();
  return (result.results || []).map((row, index) => ({ ...row, position: index + 1 })) as Array<Record<string, unknown> & { position: number }>;
}

function equipColumn(category: ArchiveRaidCategory): string | null {
  if (category === 'waveform') return 'equipped_waveform';
  if (category === 'bot_skin') return 'equipped_icon';
  if (category === 'badge' || category === 'server_core') return 'equipped_badge';
  if (category === 'artist_archetype') return 'equipped_title';
  if (category === 'profile_effect') return 'equipped_theme';
  return null;
}

function dedupeDrops(cards: ArchiveRaidCard[]): ArchiveRaidCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => !seen.has(card.id) && seen.add(card.id));
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
