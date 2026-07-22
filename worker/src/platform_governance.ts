import type { Env } from './types';
import { handlePlatformControlApi, parsePlatformAdminIds } from './platform_control';
import { applyD1SchemaStatements } from './schema';
import { validateTelegramInitData } from './telegram_platform';
import { readEnvInt } from './utils';

type PlatformRole = 'owner' | 'admin' | 'editor' | 'moderator' | 'user';
type Capability =
  | 'platform.read'
  | 'module.write'
  | 'content.write'
  | 'settings.write'
  | 'audit.read'
  | 'roles.read'
  | 'roles.write'
  | 'versions.read'
  | 'versions.write'
  | 'versions.rollback'
  | 'profile.write';

type ExtendedEnv = Env & {
  TELEGRAM_ADMIN_IDS?: string;
  TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS?: string;
  TELEGRAM_BOT_API_BASE?: string;
  PLATFORM_SESSION_TTL_SECONDS?: string;
};

type Actor = {
  id: number;
  role: PlatformRole;
  display_name: string;
  username?: string;
  auth_mode: 'telegram' | 'session' | 'token';
  session_id?: string;
  session_token?: string;
};

type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: TelegramUser;
    text?: string;
  };
};

type GovernanceActionBody = Record<string, unknown> & {
  action?: unknown;
  init_data?: unknown;
};

const GOVERNANCE_VERSION = '2.0.0';
const PUBLIC_CACHE_KEY = 'platform:public:registry:v1';
const SESSION_PREFIX = 'platform:session:v2:';
const LINK_PREFIX = 'platform:link:v2:';
const SESSION_MIN_TTL = 900;
const SESSION_MAX_TTL = 60 * 60 * 24 * 30;
const LINK_TTL = 600;
const ROLE_ORDER: Record<PlatformRole, number> = { user: 0, moderator: 1, editor: 2, admin: 3, owner: 4 };
const ROLE_CAPABILITIES: Record<PlatformRole, ReadonlySet<Capability>> = {
  owner: new Set<Capability>([
    'platform.read', 'module.write', 'content.write', 'settings.write', 'audit.read',
    'roles.read', 'roles.write', 'versions.read', 'versions.write', 'versions.rollback', 'profile.write',
  ]),
  admin: new Set<Capability>([
    'platform.read', 'module.write', 'content.write', 'settings.write', 'audit.read',
    'roles.read', 'roles.write', 'versions.read', 'versions.write', 'profile.write',
  ]),
  editor: new Set<Capability>([
    'platform.read', 'module.write', 'content.write', 'settings.write', 'versions.read', 'versions.write', 'profile.write',
  ]),
  moderator: new Set<Capability>(['platform.read', 'content.write', 'audit.read', 'versions.read', 'profile.write']),
  user: new Set<Capability>(['platform.read', 'profile.write']),
};

const DELEGATED_ACTIONS = new Map<string, Capability>([
  ['module.upsert', 'module.write'],
  ['module.toggle', 'module.write'],
  ['module.delete', 'module.write'],
  ['content.upsert', 'content.write'],
  ['content.delete', 'content.write'],
  ['setting.set', 'settings.write'],
  ['audit.list', 'audit.read'],
  ['export', 'platform.read'],
]);

let schemaReady: Promise<void> | null = null;

export function roleCan(role: PlatformRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

export function normalizePlatformRole(value: unknown): PlatformRole | null {
  const role = String(value || '').trim().toLowerCase();
  return role === 'owner' || role === 'admin' || role === 'editor' || role === 'moderator' || role === 'user'
    ? role
    : null;
}

export function parseDeviceLinkCommand(text: string): string | null {
  const match = String(text || '').trim().match(/^\/link(?:@[a-z0-9_]+)?\s+([A-Z0-9]{8})$/i);
  return match?.[1]?.toUpperCase() ?? null;
}

export async function handlePlatformGovernanceApi(request: Request, env: ExtendedEnv): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === '/api/platform/realtime' && request.method === 'GET') {
    await ensureGovernanceSchema(env);
    return realtimeResponse(request, env, url);
  }

  if (url.pathname === '/api/platform/governance/health' && request.method === 'GET') {
    await ensureGovernanceSchema(env);
    return json(request, {
      ok: true,
      version: GOVERNANCE_VERSION,
      roles: Object.keys(ROLE_CAPABILITIES),
      realtime: 'sse-reconnect',
      identity: ['telegram-mini-app', 'telegram-device-link', 'opaque-device-session'],
      public_deploy: false,
    }, 200, 'public, max-age=30');
  }

  if (url.pathname !== '/api/platform/governance') return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== 'POST') return jsonError(request, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');

  await ensureGovernanceSchema(env);
  const body = await request.json().catch(() => null) as GovernanceActionBody | null;
  if (!body) return jsonError(request, 400, 'INVALID_JSON', 'Invalid JSON body');
  const action = String(body.action || 'snapshot').trim().toLowerCase();

  if (action === 'identity.link.start') return startDeviceLink(request, body, env);
  if (action === 'identity.link.status') return deviceLinkStatus(request, body, env);
  if (action === 'identity.telegram.session') return createTelegramSession(request, body, env);

  const authorized = await authorize(request, body, env);
  if (!authorized.ok) return jsonError(request, authorized.status, authorized.code, authorized.message);
  const actor = authorized.actor;
  await touchUser(actor, env);

  try {
  if (action === 'snapshot') {
    requireCapability(actor, 'platform.read');
    const [snapshot, versions, users] = await Promise.all([
      capturePublicSnapshot(env),
      versionRows(env, 20),
      roleCan(actor.role, 'roles.read') ? userRows(env, 100) : Promise.resolve([]),
    ]);
    return json(request, {
      ok: true,
      version: GOVERNANCE_VERSION,
      actor: publicActor(actor),
      capabilities: [...ROLE_CAPABILITIES[actor.role]],
      ...snapshot,
      versions,
      users,
    });
  }

  if (action === 'profile.get') {
    requireCapability(actor, 'platform.read');
    const requestedId = safeUserId(body.telegram_user_id);
    const targetId = requestedId && roleCan(actor.role, 'roles.read') ? requestedId : actor.id;
    return json(request, { ok: true, profile: await profileForUser(targetId, env), actor: publicActor(actor) });
  }

  if (action === 'profile.update') {
    requireCapability(actor, 'profile.write');
    const requestedId = safeUserId(body.telegram_user_id);
    const targetId = requestedId && roleCan(actor.role, 'roles.write') ? requestedId : actor.id;
    if (targetId !== actor.id && !roleCan(actor.role, 'roles.write')) {
      return jsonError(request, 403, 'PROFILE_FORBIDDEN', 'You can update only your own profile');
    }
    const profile = sanitizeProfile(body.profile);
    if (!profile.ok) return jsonError(request, 400, 'INVALID_PROFILE', profile.message);
    await env.DB.prepare(`
      UPDATE platform_users
      SET display_name = COALESCE(?, display_name), profile_json = ?, updated_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
    `).bind(profile.value.display_name, JSON.stringify(profile.value), targetId).run();
    if (profile.value.display_name) {
      await env.DB.prepare('UPDATE game_profiles SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?')
        .bind(profile.value.display_name, targetId).run().catch(() => undefined);
    }
    await emitEvent(env, actor, 'profile.updated', 'user', String(targetId), null, 'private');
    return json(request, { ok: true, profile: await profileForUser(targetId, env) });
  }

  if (action === 'role.list') {
    requireCapability(actor, 'roles.read');
    return json(request, { ok: true, users: await userRows(env, clampInt(body.limit, 10, 300, 100)) });
  }

  if (action === 'role.assign') {
    requireCapability(actor, 'roles.write');
    const targetId = safeUserId(body.telegram_user_id);
    const role = normalizePlatformRole(body.role);
    if (!targetId || !role) return jsonError(request, 400, 'INVALID_ROLE_ASSIGNMENT', 'Valid Telegram user ID and role are required');
    const current = await userById(targetId, env);
    const currentRole = normalizePlatformRole(current?.role) || 'user';
    const permissionError = validateRoleChange(actor, targetId, currentRole, role);
    if (permissionError) return jsonError(request, 403, 'ROLE_FORBIDDEN', permissionError);
    if (currentRole === 'owner' && role !== 'owner') {
      const owners = await env.DB.prepare("SELECT COUNT(*) AS count FROM platform_users WHERE role = 'owner'").first<{ count: number }>();
      if (Number(owners?.count || 0) <= 1) return jsonError(request, 409, 'LAST_OWNER', 'The last owner cannot be demoted');
    }
    await env.DB.prepare(`
      INSERT INTO platform_users (telegram_user_id, role, display_name, profile_json)
      VALUES (?, ?, ?, '{}')
      ON CONFLICT(telegram_user_id) DO UPDATE SET role = excluded.role, updated_at = CURRENT_TIMESTAMP
    `).bind(targetId, role, current?.display_name || `Telegram ${targetId}`).run();
    await env.DB.prepare(`
      INSERT INTO platform_role_history (id, telegram_user_id, previous_role, new_role, changed_by, changed_by_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), targetId, currentRole, role, actor.id, actor.display_name).run();
    await emitEvent(env, actor, 'role.assigned', 'user', String(targetId), { previous_role: currentRole, role }, 'private');
    return json(request, { ok: true, user: await userById(targetId, env), users: await userRows(env, 100) });
  }

  if (action === 'module.reorder') {
    requireCapability(actor, 'module.write');
    const ids = sanitizeIdList(body.ids);
    if (!ids.length) return jsonError(request, 400, 'INVALID_ORDER', 'A non-empty module ID list is required');
    for (let index = 0; index < ids.length; index += 1) {
      await env.DB.prepare('UPDATE platform_modules SET sort_order = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind((index + 1) * 10, actor.id, ids[index]).run();
    }
    await env.CACHE.delete(PUBLIC_CACHE_KEY);
    const version = await createVersion(env, actor, 'module.reorder', `Reordered ${ids.length} modules`);
    await emitEvent(env, actor, 'module.reordered', 'module', '*', { ids }, 'public', version.revision);
    return json(request, { ok: true, ...(await capturePublicSnapshot(env)), governance: version });
  }

  if (action === 'version.list') {
    requireCapability(actor, 'versions.read');
    return json(request, { ok: true, versions: await versionRows(env, clampInt(body.limit, 10, 100, 30)) });
  }

  if (action === 'version.create') {
    requireCapability(actor, 'versions.write');
    const label = plainText(body.label, 120) || 'Manual snapshot';
    const version = await createVersion(env, actor, 'version.manual', label);
    await emitEvent(env, actor, 'version.created', 'version', String(version.revision), { label }, 'private', version.revision);
    return json(request, { ok: true, version });
  }

  if (action === 'version.rollback') {
    requireCapability(actor, 'versions.rollback');
    const revision = Number(body.revision);
    if (!Number.isSafeInteger(revision) || revision <= 0) return jsonError(request, 400, 'INVALID_REVISION', 'A valid revision is required');
    const row = await env.DB.prepare('SELECT revision, snapshot_json, label FROM platform_versions WHERE revision = ? LIMIT 1')
      .bind(revision).first<{ revision: number; snapshot_json: string; label: string }>();
    if (!row) return jsonError(request, 404, 'VERSION_NOT_FOUND', 'Version not found');
    const snapshot = parseJson<Record<string, unknown>>(row.snapshot_json, {});
    const restore = await restorePublicSnapshot(snapshot, actor, env);
    if (!restore.ok) return jsonError(request, 409, 'ROLLBACK_FAILED', restore.message);
    const version = await createVersion(env, actor, 'version.rollback', `Rollback to r${revision}: ${row.label}`);
    await emitEvent(env, actor, 'version.rolled_back', 'version', String(revision), { restored_revision: revision }, 'public', version.revision);
    return json(request, { ok: true, restored_revision: revision, ...(await capturePublicSnapshot(env)), governance: version });
  }

  if (action === 'events.list') {
    requireCapability(actor, 'audit.read');
    const since = clampInt(body.since, 0, Number.MAX_SAFE_INTEGER, 0);
    return json(request, { ok: true, events: await eventRows(env, since, 200, false) });
  }

  if (action === 'session.list') {
    requireCapability(actor, 'roles.read');
    const targetId = safeUserId(body.telegram_user_id) || actor.id;
    return json(request, { ok: true, sessions: await sessionRows(env, targetId) });
  }

  if (action === 'session.revoke') {
    const sessionId = plainText(body.session_id, 80);
    if (!sessionId) return jsonError(request, 400, 'INVALID_SESSION', 'Session ID is required');
    const session = await env.DB.prepare('SELECT id, telegram_user_id FROM platform_sessions WHERE id = ? LIMIT 1')
      .bind(sessionId).first<{ id: string; telegram_user_id: number }>();
    if (!session) return jsonError(request, 404, 'SESSION_NOT_FOUND', 'Session not found');
    if (session.telegram_user_id !== actor.id && !roleCan(actor.role, 'roles.write')) {
      return jsonError(request, 403, 'SESSION_FORBIDDEN', 'You cannot revoke this session');
    }
    await env.DB.prepare('UPDATE platform_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').bind(sessionId).run();
    await emitEvent(env, actor, 'session.revoked', 'session', sessionId, null, 'private');
    return json(request, { ok: true });
  }

  const delegatedCapability = DELEGATED_ACTIONS.get(action);
  if (delegatedCapability) {
    requireCapability(actor, delegatedCapability);
    return delegateControlAction(request, body, action, actor, env);
  }

  return jsonError(request, 400, 'UNKNOWN_ACTION', 'Unknown governance action');
  } catch (error) {
    const value = error as Error & { status?: number; code?: string };
    return jsonError(request, value.status || 500, value.code || 'GOVERNANCE_FAILED', value.message || 'Governance action failed');
  }
}

export async function handlePlatformGovernanceTelegramWebhook(
  request: { headers: Headers; json(): Promise<unknown> },
  env: ExtendedEnv,
): Promise<Response | null> {
  const providedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.TELEGRAM_SECRET_TOKEN || !constantTimeEqual(providedSecret, String(env.TELEGRAM_SECRET_TOKEN))) {
    return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });
  }
  const update = await request.json().catch(() => null) as TelegramUpdate | null;
  const message = update?.message;
  if (!message?.text || !message.from) return null;
  const command = message.text.trim().split(/\s+/)[0]?.split('@')[0]?.toLowerCase() || '';
  const code = parseDeviceLinkCommand(message.text);
  if (!code && !['/control', '/admin'].includes(command)) return null;

  await ensureGovernanceSchema(env);
  const language = message.from.language_code?.toLowerCase().startsWith('en') ? 'en' : 'bg';
  if (!code) {
    const actor = await actorFromTelegramUser(message.from, 'telegram', env);
    const controlUrl = `${String(env.PUBLIC_BASE_URL || 'https://dyrakarmy.eu').replace(/\/+$/, '')}/control-v2/?v=${GOVERNANCE_VERSION}`;
    await sendTelegramMessageWithMarkup(message.chat.id, language === 'bg'
      ? `⚙️ DyrakArmy Control Center v2\n\nРоля: ${actor.role.toUpperCase()}\nМодули, общ профил, роли, версии, rollback и realtime синхронизация.`
      : `⚙️ DyrakArmy Control Center v2\n\nRole: ${actor.role.toUpperCase()}\nModules, shared profile, roles, versions, rollback and realtime sync.`, env, {
        reply_markup: { inline_keyboard: [[{ text: language === 'bg' ? '⚙️ Отвори Control Center v2' : '⚙️ Open Control Center v2', web_app: { url: controlUrl } }]] },
      });
    return Response.json({ ok: true, mode: 'governance_control_center', role: actor.role });
  }

  const pending = await env.CACHE.get(`${LINK_PREFIX}${code}`, 'json').catch(() => null) as Record<string, unknown> | null;
  if (!pending || pending.status !== 'pending') {
    await sendTelegramMessage(message.chat.id, language === 'bg'
      ? '⛔ Кодът е невалиден или е изтекъл. Генерирай нов код от приложението.'
      : '⛔ The code is invalid or expired. Generate a new code from the app.', env);
    return Response.json({ ok: true, mode: 'link_invalid' });
  }

  const actor = await actorFromTelegramUser(message.from, 'telegram', env);
  const session = await issueSession(actor, plainText(pending.device_name, 80) || 'Linked device', env);
  await env.CACHE.put(`${LINK_PREFIX}${code}`, JSON.stringify({
    status: 'approved',
    session_token: session.token,
    session_id: session.id,
    user: publicActor(actor),
  }), { expirationTtl: 300 });
  await emitEvent(env, actor, 'identity.device_linked', 'session', session.id, { device_name: pending.device_name }, 'private');
  await sendTelegramMessage(message.chat.id, language === 'bg'
    ? `✅ Устройството е свързано с DyrakArmy.\n\nУстройство: ${plainText(pending.device_name, 80) || 'Device'}\nРоля: ${actor.role.toUpperCase()}\n\nМожеш да се върнеш в приложението.`
    : `✅ The device is linked to DyrakArmy.\n\nDevice: ${plainText(pending.device_name, 80) || 'Device'}\nRole: ${actor.role.toUpperCase()}\n\nReturn to the app.`, env);
  return Response.json({ ok: true, mode: 'device_linked' });
}

async function ensureGovernanceSchema(env: ExtendedEnv): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await applyD1SchemaStatements(env, [
      `CREATE TABLE IF NOT EXISTS platform_users (
        telegram_user_id INTEGER PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'user',
        username TEXT,
        display_name TEXT NOT NULL,
        language_code TEXT,
        profile_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS platform_role_history (
        id TEXT PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL,
        previous_role TEXT NOT NULL,
        new_role TEXT NOT NULL,
        changed_by INTEGER NOT NULL,
        changed_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS platform_sessions (
        id TEXT PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL,
        device_name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        auth_mode TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS platform_versions (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL,
        label TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_by INTEGER NOT NULL,
        created_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS platform_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        actor_user_id INTEGER NOT NULL,
        actor_name TEXT NOT NULL,
        revision INTEGER,
        payload_json TEXT,
        visibility TEXT NOT NULL DEFAULT 'private',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      'CREATE INDEX IF NOT EXISTS idx_platform_users_role ON platform_users(role, updated_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_platform_sessions_user ON platform_sessions(telegram_user_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_platform_versions_created ON platform_versions(created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_platform_events_visibility_sequence ON platform_events(visibility, sequence ASC)',
    ]);

    const admins = [...parsePlatformAdminIds(env.TELEGRAM_ADMIN_IDS)];
    for (let index = 0; index < admins.length; index += 1) {
      const id = admins[index];
      const bootstrapRole: PlatformRole = index === 0 ? 'owner' : 'admin';
      await env.DB.prepare(`
        INSERT INTO platform_users (telegram_user_id, role, display_name, profile_json)
        VALUES (?, ?, ?, '{}')
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          role = CASE WHEN platform_users.role = 'user' THEN excluded.role ELSE platform_users.role END,
          updated_at = CURRENT_TIMESTAMP
      `).bind(id, bootstrapRole, `Telegram ${id}`).run();
    }
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function authorize(
  request: Request,
  body: GovernanceActionBody,
  env: ExtendedEnv,
): Promise<{ ok: true; actor: Actor } | { ok: false; status: number; code: string; message: string }> {
  const bearer = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim() || '';
  if (env.OPS_ADMIN_TOKEN && bearer && constantTimeEqual(bearer, String(env.OPS_ADMIN_TOKEN))) {
    return { ok: true, actor: { id: 0, role: 'owner', display_name: 'Operations Owner', auth_mode: 'token' } };
  }
  if (bearer) {
    const session = await env.CACHE.get(`${SESSION_PREFIX}${bearer}`, 'json').catch(() => null) as Record<string, unknown> | null;
    if (session) {
      const sessionId = String(session.session_id || '');
      const row = await env.DB.prepare(`
        SELECT s.id, s.telegram_user_id, s.expires_at, s.revoked_at, u.role, u.display_name, u.username
        FROM platform_sessions s JOIN platform_users u ON u.telegram_user_id = s.telegram_user_id
        WHERE s.id = ? LIMIT 1
      `).bind(sessionId).first<Record<string, unknown>>();
      if (row && !row.revoked_at && new Date(String(row.expires_at)).getTime() > Date.now()) {
        await env.DB.prepare('UPDATE platform_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').bind(sessionId).run();
        return {
          ok: true,
          actor: {
            id: Number(row.telegram_user_id),
            role: normalizePlatformRole(row.role) || 'user',
            display_name: String(row.display_name || row.username || row.telegram_user_id),
            username: row.username ? String(row.username) : undefined,
            auth_mode: 'session',
            session_id: sessionId,
            session_token: bearer,
          },
        };
      }
      await env.CACHE.delete(`${SESSION_PREFIX}${bearer}`);
    }
  }

  const initData = String(body.init_data || '');
  if (initData) {
    const auth = await validateTelegramInitData(
      initData,
      String(env.TELEGRAM_BOT_TOKEN || ''),
      clampInt(readEnvInt(env.TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS, 900), 60, 3600, 900),
    );
    if (auth.ok && auth.user) return { ok: true, actor: await actorFromTelegramUser(auth.user as TelegramUser, 'telegram', env) };
    return { ok: false, status: 401, code: 'TELEGRAM_AUTH_FAILED', message: auth.error || 'Telegram authentication failed' };
  }
  return { ok: false, status: 401, code: 'AUTH_REQUIRED', message: 'Telegram initData or a linked device session is required' };
}

async function actorFromTelegramUser(user: TelegramUser, authMode: 'telegram' | 'session', env: ExtendedEnv): Promise<Actor> {
  const configuredAdmins = [...parsePlatformAdminIds(env.TELEGRAM_ADMIN_IDS)];
  const bootstrapRole: PlatformRole = configuredAdmins[0] === user.id
    ? 'owner'
    : configuredAdmins.includes(user.id) ? 'admin' : 'user';
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id);
  await env.DB.prepare(`
    INSERT INTO platform_users (telegram_user_id, role, username, display_name, language_code, profile_json)
    VALUES (?, ?, ?, ?, ?, '{}')
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      language_code = excluded.language_code,
      role = CASE WHEN platform_users.role = 'user' AND excluded.role IN ('owner', 'admin') THEN excluded.role ELSE platform_users.role END,
      updated_at = CURRENT_TIMESTAMP,
      last_seen_at = CURRENT_TIMESTAMP
  `).bind(user.id, bootstrapRole, user.username || null, displayName, user.language_code || null).run();
  const row = await userById(user.id, env);
  return {
    id: user.id,
    role: normalizePlatformRole(row?.role) || bootstrapRole,
    display_name: String(row?.display_name || displayName),
    username: row?.username ? String(row.username) : user.username,
    auth_mode: authMode,
  };
}

async function createTelegramSession(request: Request, body: GovernanceActionBody, env: ExtendedEnv): Promise<Response> {
  const initData = String(body.init_data || '');
  if (!initData) return jsonError(request, 400, 'INIT_DATA_REQUIRED', 'Telegram initData is required');
  const auth = await validateTelegramInitData(
    initData,
    String(env.TELEGRAM_BOT_TOKEN || ''),
    clampInt(readEnvInt(env.TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS, 900), 60, 3600, 900),
  );
  if (!auth.ok || !auth.user) return jsonError(request, 401, 'TELEGRAM_AUTH_FAILED', auth.error || 'Telegram authentication failed');
  const actor = await actorFromTelegramUser(auth.user as TelegramUser, 'telegram', env);
  const session = await issueSession(actor, plainText(body.device_name, 80) || 'Telegram Mini App', env);
  return json(request, { ok: true, session_token: session.token, session_id: session.id, expires_at: session.expires_at, actor: publicActor(actor) });
}

async function startDeviceLink(request: Request, body: GovernanceActionBody, env: ExtendedEnv): Promise<Response> {
  const deviceName = plainText(body.device_name, 80) || 'DyrakArmy device';
  const code = randomCode(8);
  await env.CACHE.put(`${LINK_PREFIX}${code}`, JSON.stringify({ status: 'pending', device_name: deviceName, created_at: new Date().toISOString() }), { expirationTtl: LINK_TTL });
  return json(request, {
    ok: true,
    code,
    command: `/link ${code}`,
    expires_in: LINK_TTL,
    telegram_url: `tg://resolve?domain=${telegramUsername(env)}&text=${encodeURIComponent(`/link ${code}`)}`,
  });
}

async function deviceLinkStatus(request: Request, body: GovernanceActionBody, env: ExtendedEnv): Promise<Response> {
  const code = String(body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) return jsonError(request, 400, 'INVALID_LINK_CODE', 'Invalid link code');
  const record = await env.CACHE.get(`${LINK_PREFIX}${code}`, 'json').catch(() => null) as Record<string, unknown> | null;
  if (!record) return json(request, { ok: true, status: 'expired' });
  if (record.status !== 'approved') return json(request, { ok: true, status: 'pending' });
  await env.CACHE.delete(`${LINK_PREFIX}${code}`);
  return json(request, {
    ok: true,
    status: 'approved',
    session_token: record.session_token,
    session_id: record.session_id,
    actor: record.user,
  });
}

async function issueSession(actor: Actor, deviceName: string, env: ExtendedEnv): Promise<{ id: string; token: string; expires_at: string }> {
  const token = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  const id = crypto.randomUUID();
  const ttl = clampInt(readEnvInt(env.PLATFORM_SESSION_TTL_SECONDS, 60 * 60 * 24 * 14), SESSION_MIN_TTL, SESSION_MAX_TTL, 60 * 60 * 24 * 14);
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const tokenHash = await sha256(token);
  await env.DB.prepare(`
    INSERT INTO platform_sessions (id, telegram_user_id, device_name, token_hash, auth_mode, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, actor.id, deviceName, tokenHash, actor.auth_mode, expiresAt).run();
  await env.CACHE.put(`${SESSION_PREFIX}${token}`, JSON.stringify({ session_id: id, telegram_user_id: actor.id }), { expirationTtl: ttl });
  return { id, token, expires_at: expiresAt };
}

async function delegateControlAction(
  request: Request,
  body: GovernanceActionBody,
  action: string,
  actor: Actor,
  env: ExtendedEnv,
): Promise<Response> {
  const internalToken = crypto.randomUUID();
  const internalEnv = Object.assign(Object.create(env), { OPS_ADMIN_TOKEN: internalToken }) as ExtendedEnv;
  const target = new URL(request.url);
  target.pathname = '/api/platform/control';
  target.search = '';
  const delegatedRequest = new Request(target.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${internalToken}` },
    body: JSON.stringify({ ...body, action, init_data: '' }),
  });
  const delegated = await handlePlatformControlApi(delegatedRequest, internalEnv);
  if (!delegated) return jsonError(request, 500, 'CONTROL_DELEGATION_FAILED', 'Control handler did not accept the action');
  const payload = await delegated.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (!delegated.ok || payload?.error) {
    return new Response(delegated.body, { status: delegated.status, statusText: delegated.statusText, headers: delegated.headers });
  }
  const version = action === 'audit.list' || action === 'export'
    ? null
    : await createVersion(env, actor, action, describeAction(action, body));
  if (version) {
    await emitEvent(env, actor, action, action.split('.')[0] || 'platform', targetIdForAction(body), null, 'public', version.revision);
  }
  return json(request, { ...(payload || { ok: true }), actor: publicActor(actor), governance: version || undefined });
}

async function createVersion(env: ExtendedEnv, actor: Actor, action: string, label: string): Promise<{ revision: number; version_id: string; label: string; snapshot_hash: string; created_at: string }> {
  const snapshot = await capturePublicSnapshot(env);
  const serializable = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  const snapshotJson = JSON.stringify(serializable);
  const hash = await sha256(stableStringify(serializable));
  const versionId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO platform_versions (version_id, action, label, snapshot_hash, snapshot_json, created_by, created_by_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(versionId, action, plainText(label, 180) || action, hash, snapshotJson, actor.id, actor.display_name).run();
  const row = await env.DB.prepare('SELECT revision, created_at FROM platform_versions WHERE version_id = ? LIMIT 1')
    .bind(versionId).first<{ revision: number; created_at: string }>();
  return { revision: Number(row?.revision || 0), version_id: versionId, label: plainText(label, 180) || action, snapshot_hash: hash, created_at: String(row?.created_at || new Date().toISOString()) };
}

async function capturePublicSnapshot(env: ExtendedEnv): Promise<Record<string, unknown>> {
  const [modules, content, settings] = await Promise.all([
    env.DB.prepare(`SELECT id, kind, title, description, icon, public_url, telegram_url, enabled, sort_order, system, metadata_json, updated_by, updated_at FROM platform_modules ORDER BY sort_order ASC, id ASC`).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT id, slot, title, body, icon, action_label, action_url, visible, sort_order, starts_at, ends_at, updated_by, updated_at FROM platform_content ORDER BY slot ASC, sort_order ASC, id ASC`).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT key, value_json, updated_by, updated_at FROM platform_settings ORDER BY key ASC`).all<Record<string, unknown>>(),
  ]);
  return {
    generated_at: new Date().toISOString(),
    modules: (modules.results || []).map((row) => ({
      ...row,
      enabled: Number(row.enabled) === 1,
      system: Number(row.system) === 1,
      metadata: parseJson(String(row.metadata_json || '{}'), {}),
      metadata_json: undefined,
    })),
    content: (content.results || []).map((row) => ({ ...row, visible: Number(row.visible) === 1 })),
    settings: Object.fromEntries((settings.results || []).map((row) => [String(row.key), parseJson(String(row.value_json || 'null'), null)])),
  };
}

async function restorePublicSnapshot(snapshot: Record<string, unknown>, actor: Actor, env: ExtendedEnv): Promise<{ ok: true } | { ok: false; message: string }> {
  const modules = Array.isArray(snapshot.modules) ? snapshot.modules.filter(isPlainObject) : [];
  const content = Array.isArray(snapshot.content) ? snapshot.content.filter(isPlainObject) : [];
  const settings = isPlainObject(snapshot.settings) ? snapshot.settings : {};
  if (!modules.length) return { ok: false, message: 'Snapshot does not contain modules' };

  await env.DB.prepare('DELETE FROM platform_modules WHERE system = 0').run();
  await env.DB.prepare('DELETE FROM platform_content').run();
  await env.DB.prepare('DELETE FROM platform_settings').run();

  for (const row of modules) {
    const id = safeId(row.id);
    if (!id) continue;
    await env.DB.prepare(`
      INSERT INTO platform_modules (id, kind, title, description, icon, public_url, telegram_url, enabled, sort_order, system, metadata_json, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind, title = excluded.title, description = excluded.description, icon = excluded.icon,
        public_url = excluded.public_url, telegram_url = excluded.telegram_url, enabled = excluded.enabled,
        sort_order = excluded.sort_order, system = excluded.system, metadata_json = excluded.metadata_json,
        updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
    `).bind(
      id, plainText(row.kind, 20) || 'link', plainText(row.title, 80) || id, plainText(row.description, 500),
      plainText(row.icon, 12) || '◈', safeUrl(row.public_url), safeUrl(row.telegram_url), row.enabled === true ? 1 : 0,
      clampInt(row.sort_order, 0, 9999, 100), row.system === true ? 1 : 0,
      JSON.stringify(isPlainObject(row.metadata) ? row.metadata : {}), actor.id,
    ).run();
  }

  for (const row of content) {
    const id = safeId(row.id);
    if (!id) continue;
    await env.DB.prepare(`
      INSERT INTO platform_content (id, slot, title, body, icon, action_label, action_url, visible, sort_order, starts_at, ends_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(
      id, plainText(row.slot, 24) || 'updates', plainText(row.title, 120) || id, plainText(row.body, 1600),
      plainText(row.icon, 12) || '◈', plainText(row.action_label, 50) || null, safeUrl(row.action_url), row.visible === true ? 1 : 0,
      clampInt(row.sort_order, 0, 9999, 100), isoDateOrNull(row.starts_at), isoDateOrNull(row.ends_at), actor.id,
    ).run();
  }

  for (const [key, value] of Object.entries(settings)) {
    if (!/^[a-z0-9._-]{2,80}$/i.test(key)) continue;
    await env.DB.prepare('INSERT INTO platform_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
      .bind(key, JSON.stringify(value), actor.id).run();
  }
  await env.CACHE.delete(PUBLIC_CACHE_KEY);
  await env.DB.prepare(`
    INSERT INTO platform_audit (id, admin_user_id, admin_name, action, target_type, target_id, before_json, after_json)
    VALUES (?, ?, ?, 'version.rollback', 'platform', 'public-registry', NULL, ?)
  `).bind(crypto.randomUUID(), actor.id, actor.display_name, JSON.stringify({ modules: modules.length, content: content.length, settings: Object.keys(settings).length })).run();
  return { ok: true };
}

async function realtimeResponse(request: Request, env: ExtendedEnv, url: URL): Promise<Response> {
  const since = clampInt(url.searchParams.get('since'), 0, Number.MAX_SAFE_INTEGER, 0);
  const events = await eventRows(env, since, 100, true);
  const latest = events.length ? Number(events.at(-1)?.sequence || since) : await latestEventSequence(env);
  const accept = request.headers.get('Accept') || '';
  if (!accept.includes('text/event-stream')) {
    return json(request, { ok: true, version: GOVERNANCE_VERSION, since, latest, events }, 200, 'no-store');
  }
  const lines = ['retry: 2000'];
  if (!events.length) lines.push(`event: heartbeat\nid: ${latest}\ndata: ${JSON.stringify({ latest, generated_at: new Date().toISOString() })}`);
  for (const event of events) lines.push(`event: ${event.event_type}\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}`);
  return new Response(`${lines.join('\n\n')}\n\n`, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

async function emitEvent(
  env: ExtendedEnv,
  actor: Actor,
  eventType: string,
  targetType: string,
  targetId: string,
  payload: unknown,
  visibility: 'public' | 'private',
  revision?: number,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO platform_events (event_type, target_type, target_id, actor_user_id, actor_name, revision, payload_json, visibility)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(eventType, targetType, targetId, actor.id, actor.display_name, revision || null, payload === null ? null : JSON.stringify(payload), visibility).run();
}

async function eventRows(env: ExtendedEnv, since: number, limit: number, publicOnly: boolean): Promise<Record<string, unknown>[]> {
  const sql = publicOnly
    ? `SELECT sequence, event_type, target_type, target_id, revision, payload_json, created_at FROM platform_events WHERE visibility = 'public' AND sequence > ? ORDER BY sequence ASC LIMIT ?`
    : `SELECT sequence, event_type, target_type, target_id, actor_user_id, actor_name, revision, payload_json, visibility, created_at FROM platform_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`;
  const result = await env.DB.prepare(sql).bind(since, limit).all<Record<string, unknown>>();
  return (result.results || []).map((row) => ({ ...row, payload: row.payload_json ? parseJson(String(row.payload_json), null) : null, payload_json: undefined }));
}

async function latestEventSequence(env: ExtendedEnv): Promise<number> {
  const row = await env.DB.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM platform_events WHERE visibility = 'public'").first<{ sequence: number }>();
  return Number(row?.sequence || 0);
}

async function versionRows(env: ExtendedEnv, limit: number): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare(`
    SELECT revision, version_id, action, label, snapshot_hash, created_by, created_by_name, created_at
    FROM platform_versions ORDER BY revision DESC LIMIT ?
  `).bind(limit).all<Record<string, unknown>>();
  return result.results || [];
}

async function userRows(env: ExtendedEnv, limit: number): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare(`
    SELECT telegram_user_id, role, username, display_name, language_code, created_at, updated_at, last_seen_at
    FROM platform_users ORDER BY CASE role WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'editor' THEN 3 WHEN 'moderator' THEN 2 ELSE 1 END DESC, updated_at DESC LIMIT ?
  `).bind(limit).all<Record<string, unknown>>();
  return result.results || [];
}

async function userById(id: number, env: ExtendedEnv): Promise<Record<string, unknown> | null> {
  return env.DB.prepare('SELECT * FROM platform_users WHERE telegram_user_id = ? LIMIT 1').bind(id).first<Record<string, unknown>>();
}

async function profileForUser(id: number, env: ExtendedEnv): Promise<Record<string, unknown>> {
  const [user, gameProfile, unlocks] = await Promise.all([
    userById(id, env),
    env.DB.prepare('SELECT * FROM game_profiles WHERE telegram_user_id = ? LIMIT 1').bind(id).first<Record<string, unknown>>().catch(() => null),
    env.DB.prepare('SELECT reward_id, unlocked_at FROM game_unlocks WHERE telegram_user_id = ? ORDER BY unlocked_at DESC LIMIT 100').bind(id).all<Record<string, unknown>>().catch(() => ({ results: [] })),
  ]);
  return {
    user: user ? { ...user, profile: parseJson(String(user.profile_json || '{}'), {}), profile_json: undefined } : null,
    game_profile: gameProfile,
    unlocks: unlocks.results || [],
  };
}

async function sessionRows(env: ExtendedEnv, userId: number): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare(`
    SELECT id, device_name, auth_mode, created_at, expires_at, last_seen_at, revoked_at
    FROM platform_sessions WHERE telegram_user_id = ? ORDER BY created_at DESC LIMIT 100
  `).bind(userId).all<Record<string, unknown>>();
  return result.results || [];
}

async function touchUser(actor: Actor, env: ExtendedEnv): Promise<void> {
  if (actor.id <= 0) return;
  await env.DB.prepare('UPDATE platform_users SET last_seen_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?').bind(actor.id).run();
}

function validateRoleChange(actor: Actor, targetId: number, currentRole: PlatformRole, nextRole: PlatformRole): string | null {
  if (actor.id === targetId && actor.role !== 'owner' && ROLE_ORDER[nextRole] < ROLE_ORDER[currentRole]) return 'You cannot demote your own account';
  if (actor.role === 'owner') return null;
  if (actor.role !== 'admin') return 'Only owners and administrators can manage roles';
  if (currentRole === 'owner' || nextRole === 'owner') return 'Only an owner can manage the owner role';
  if (currentRole === 'admin' || nextRole === 'admin') return 'Only an owner can manage administrator roles';
  return null;
}

function requireCapability(actor: Actor, capability: Capability): void {
  if (!roleCan(actor.role, capability)) {
    const error = new Error(`Role ${actor.role} does not have ${capability}`) as Error & { status?: number; code?: string };
    error.status = 403;
    error.code = 'CAPABILITY_REQUIRED';
    throw error;
  }
}

function publicActor(actor: Actor): Record<string, unknown> {
  return { id: actor.id, role: actor.role, display_name: actor.display_name, username: actor.username, auth_mode: actor.auth_mode, session_id: actor.session_id };
}

function sanitizeProfile(value: unknown): { ok: true; value: Record<string, unknown> & { display_name?: string } } | { ok: false; message: string } {
  if (!isPlainObject(value)) return { ok: false, message: 'Profile must be an object' };
  const profile: Record<string, unknown> & { display_name?: string } = {};
  const displayName = plainText(value.display_name, 80);
  if (displayName) profile.display_name = displayName;
  const bio = plainText(value.bio, 240);
  if (bio) profile.bio = bio;
  const locale = plainText(value.locale, 12);
  if (locale && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale)) profile.locale = locale;
  const theme = plainText(value.theme, 40);
  if (theme && /^[a-z0-9_-]+$/i.test(theme)) profile.theme = theme;
  const avatarUrl = safeUrl(value.avatar_url);
  if (avatarUrl) profile.avatar_url = avatarUrl;
  if (JSON.stringify(profile).length > 1200) return { ok: false, message: 'Profile is too large' };
  return { ok: true, value: profile };
}

function sanitizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map(safeId).filter((id): id is string => Boolean(id));
  return [...new Set(ids)].slice(0, 250);
}

function targetIdForAction(body: GovernanceActionBody): string {
  if (typeof body.id === 'string') return body.id;
  if (isPlainObject(body.module) && typeof body.module.id === 'string') return body.module.id;
  if (isPlainObject(body.content) && typeof body.content.id === 'string') return body.content.id;
  if (typeof body.key === 'string') return body.key;
  return 'platform';
}

function describeAction(action: string, body: GovernanceActionBody): string {
  const target = targetIdForAction(body);
  return `${action}: ${target}`.slice(0, 180);
}

function safeUserId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function safeId(value: unknown): string | null {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{1,47}$/.test(id) ? id : null;
}

function plainText(value: unknown, max: number): string {
  return String(value ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
}

function safeUrl(value: unknown): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw.slice(0, 500);
  if (/^tg:\/\/[a-z0-9/?&=_.%-]+$/i.test(raw)) return raw.slice(0, 500);
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}

function isoDateOrNull(value: unknown): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function randomCode(length: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function telegramUsername(env: ExtendedEnv): string {
  return String(env.TELEGRAM_BOT_USERNAME || 'dyrakarmy_bot').replace(/^@+/, '');
}

async function sendTelegramMessage(chatId: number, text: string, env: ExtendedEnv): Promise<void> {
  return sendTelegramMessageWithMarkup(chatId, text, env, {});
}

async function sendTelegramMessageWithMarkup(
  chatId: number,
  text: string,
  env: ExtendedEnv,
  extra: Record<string, unknown>,
): Promise<void> {
  const base = String(env.TELEGRAM_BOT_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const response = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, ...extra }),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  const origin = request.headers.get('Origin');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Last-Event-ID');
    headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    headers.set('Vary', 'Origin');
  }
  return headers;
}

function json(request: Request, payload: unknown, status = 200, cacheControl = 'no-store'): Response {
  const headers = corsHeaders(request);
  headers.set('Cache-Control', cacheControl);
  return new Response(JSON.stringify(payload), { status, headers });
}

function jsonError(request: Request, status: number, code: string, message: string): Response {
  return json(request, { error: { code, message } }, status);
}
