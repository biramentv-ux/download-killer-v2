import type { Env } from './types';
import { validateTelegramInitData } from './telegram_platform';
import { readEnvInt } from './utils';

type ExtendedEnv = Env & {
  TELEGRAM_ADMIN_IDS?: string;
  TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS?: string;
};

type ModuleKind = 'system' | 'game' | 'tool' | 'section' | 'link';
type ContentSlot = 'announcement' | 'navigation' | 'home' | 'games' | 'updates' | 'footer';

type ControlAdmin = {
  id: number;
  username?: string;
  display_name: string;
  auth_mode: 'telegram' | 'token';
};

type PlatformModuleInput = {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  description?: unknown;
  icon?: unknown;
  public_url?: unknown;
  telegram_url?: unknown;
  enabled?: unknown;
  sort_order?: unknown;
  metadata?: unknown;
};

type PlatformContentInput = {
  id?: unknown;
  slot?: unknown;
  title?: unknown;
  body?: unknown;
  icon?: unknown;
  action_label?: unknown;
  action_url?: unknown;
  visible?: unknown;
  sort_order?: unknown;
  starts_at?: unknown;
  ends_at?: unknown;
};

const PUBLIC_CACHE_KEY = 'platform:public:registry:v1';
const PUBLIC_CACHE_TTL = 90;
const CONTROL_VERSION = '1.0.0';
const SYSTEM_MODULE_IDS = new Set([
  'home', 'how-it-works', 'features', 'downloads', 'games', 'dyrakarmy-arena',
  'latency-strike', 'media-lab', 'telegram', 'status', 'control-center',
]);
const MODULE_KINDS = new Set<ModuleKind>(['system', 'game', 'tool', 'section', 'link']);
const CONTENT_SLOTS = new Set<ContentSlot>(['announcement', 'navigation', 'home', 'games', 'updates', 'footer']);
const SETTING_KEYS = new Set([
  'site.title', 'site.subtitle', 'site.footer', 'theme.accent', 'theme.accent_secondary',
  'theme.background', 'theme.radius', 'announcement.enabled', 'games.season_label',
]);

let schemaReady: Promise<void> | null = null;

export async function handlePlatformControlApi(request: Request, env: ExtendedEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/platform/public' && request.method === 'GET') {
    await ensurePlatformControlSchema(env);
    return json(request, await publicRegistry(env), 200, 'public, max-age=30, s-maxage=60');
  }
  if (!url.pathname.startsWith('/api/platform/control')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== 'POST') return json(request, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, 405);

  await ensurePlatformControlSchema(env);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json(request, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400);
  const admin = await authorizeControl(request, body, env);
  if (!admin.ok) return json(request, { error: { code: admin.code, message: admin.message } }, admin.status);

  const action = String(body.action || 'snapshot').trim().toLowerCase();
  if (action === 'snapshot') {
    return json(request, { ok: true, version: CONTROL_VERSION, admin: admin.admin, ...(await controlSnapshot(env)) });
  }
  if (action === 'module.upsert') {
    const input = sanitizeModule(body.module as PlatformModuleInput | undefined);
    if (!input.ok) return json(request, { error: { code: 'INVALID_MODULE', message: input.message } }, 400);
    const before = await moduleById(input.value.id, env);
    const system = before?.system === 1 || SYSTEM_MODULE_IDS.has(input.value.id) ? 1 : 0;
    await env.DB.prepare(`
      INSERT INTO platform_modules (
        id, kind, title, description, icon, public_url, telegram_url,
        enabled, sort_order, system, metadata_json, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        description = excluded.description,
        icon = excluded.icon,
        public_url = excluded.public_url,
        telegram_url = excluded.telegram_url,
        enabled = excluded.enabled,
        sort_order = excluded.sort_order,
        metadata_json = excluded.metadata_json,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      input.value.id, input.value.kind, input.value.title, input.value.description,
      input.value.icon, input.value.public_url, input.value.telegram_url,
      input.value.enabled ? 1 : 0, input.value.sort_order, system,
      JSON.stringify(input.value.metadata), admin.admin.id,
    ).run();
    const after = await moduleById(input.value.id, env);
    await audit(env, admin.admin, before ? 'module.update' : 'module.create', 'module', input.value.id, before, after);
    await invalidatePublicRegistry(env);
    return json(request, { ok: true, module: after, ...(await controlSnapshot(env)) });
  }
  if (action === 'module.toggle') {
    const id = sanitizeId(body.id);
    if (!id) return json(request, { error: { code: 'INVALID_ID', message: 'Invalid module id' } }, 400);
    const before = await moduleById(id, env);
    if (!before) return json(request, { error: { code: 'NOT_FOUND', message: 'Module not found' } }, 404);
    const enabled = body.enabled === true;
    await env.DB.prepare('UPDATE platform_modules SET enabled = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(enabled ? 1 : 0, admin.admin.id, id).run();
    const after = await moduleById(id, env);
    await audit(env, admin.admin, 'module.toggle', 'module', id, before, after);
    await invalidatePublicRegistry(env);
    return json(request, { ok: true, module: after, ...(await controlSnapshot(env)) });
  }
  if (action === 'module.delete') {
    const id = sanitizeId(body.id);
    if (!id) return json(request, { error: { code: 'INVALID_ID', message: 'Invalid module id' } }, 400);
    const before = await moduleById(id, env);
    if (!before) return json(request, { error: { code: 'NOT_FOUND', message: 'Module not found' } }, 404);
    if (before.system === 1 || SYSTEM_MODULE_IDS.has(id)) {
      return json(request, { error: { code: 'SYSTEM_MODULE', message: 'System modules can be hidden, but not deleted' } }, 409);
    }
    await env.DB.prepare('DELETE FROM platform_modules WHERE id = ?').bind(id).run();
    await audit(env, admin.admin, 'module.delete', 'module', id, before, null);
    await invalidatePublicRegistry(env);
    return json(request, { ok: true, ...(await controlSnapshot(env)) });
  }
  if (action === 'content.upsert') {
    const input = sanitizeContent(body.content as PlatformContentInput | undefined);
    if (!input.ok) return json(request, { error: { code: 'INVALID_CONTENT', message: input.message } }, 400);
    const before = await contentById(input.value.id, env);
    await env.DB.prepare(`
      INSERT INTO platform_content (
        id, slot, title, body, icon, action_label, action_url, visible,
        sort_order, starts_at, ends_at, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        slot = excluded.slot,
        title = excluded.title,
        body = excluded.body,
        icon = excluded.icon,
        action_label = excluded.action_label,
        action_url = excluded.action_url,
        visible = excluded.visible,
        sort_order = excluded.sort_order,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      input.value.id, input.value.slot, input.value.title, input.value.body, input.value.icon,
      input.value.action_label, input.value.action_url, input.value.visible ? 1 : 0,
      input.value.sort_order, input.value.starts_at, input.value.ends_at, admin.admin.id,
    ).run();
    const after = await contentById(input.value.id, env);
    await audit(env, admin.admin, before ? 'content.update' : 'content.create', 'content', input.value.id, before, after);
    await invalidatePublicRegistry(env);
    return json(request, { ok: true, content: after, ...(await controlSnapshot(env)) });
  }
  if (action === 'content.delete') {
    const id = sanitizeId(body.id);
    if (!id) return json(request, { error: { code: 'INVALID_ID', message: 'Invalid content id' } }, 400);
    const before = await contentById(id, env);
    if (!before) return json(request, { error: { code: 'NOT_FOUND', message: 'Content not found' } }, 404);
    await env.DB.prepare('DELETE FROM platform_content WHERE id = ?').bind(id).run();
    await audit(env, admin.admin, 'content.delete', 'content', id, before, null);
    await invalidatePublicRegistry(env);
    return json(request, { ok: true, ...(await controlSnapshot(env)) });
  }
  if (action === 'setting.set') {
    const key = String(body.key || '').trim();
    if (!SETTING_KEYS.has(key)) return json(request, { error: { code: 'INVALID_SETTING', message: 'Setting is not remotely editable' } }, 400);
    const value = sanitizeSettingValue(key, body.value);
    if (!value.ok) return json(request, { error: { code: 'INVALID_SETTING_VALUE', message: value.message } }, 400);
    const before = await settingByKey(key, env);
    await env.DB.prepare(`
      INSERT INTO platform_settings (key, value_json, updated_by, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
    `).bind(key, JSON.stringify(value.value), admin.admin.id).run();
    const after = await settingByKey(key, env);
    await audit(env, admin.admin, 'setting.set', 'setting', key, before, after);
    await invalidatePublicRegistry(env);
    return json(request, { ok: true, setting: after, ...(await controlSnapshot(env)) });
  }
  if (action === 'audit.list') {
    const limit = clamp(Math.floor(Number(body.limit || 100)), 10, 300);
    return json(request, { ok: true, audit: await auditRows(env, limit) });
  }
  if (action === 'export') {
    return json(request, { ok: true, exported_at: new Date().toISOString(), ...(await controlSnapshot(env)) });
  }

  return json(request, { error: { code: 'UNKNOWN_ACTION', message: 'Unknown control action' } }, 400);
}

export async function isPlatformModuleEnabled(env: ExtendedEnv, id: string): Promise<boolean> {
  await ensurePlatformControlSchema(env);
  const row = await env.DB.prepare('SELECT enabled FROM platform_modules WHERE id = ? LIMIT 1')
    .bind(id).first<{ enabled: number }>();
  return row ? row.enabled === 1 : true;
}

export function parsePlatformAdminIds(raw: string | undefined): Set<number> {
  return new Set(String(raw || '')
    .split(/[\s,;]+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0));
}

export function isPlatformAdminId(userId: number, env: Pick<ExtendedEnv, 'TELEGRAM_ADMIN_IDS'>): boolean {
  return parsePlatformAdminIds(env.TELEGRAM_ADMIN_IDS).has(userId);
}

async function authorizeControl(
  request: Request,
  body: Record<string, unknown>,
  env: ExtendedEnv,
): Promise<{ ok: true; admin: ControlAdmin } | { ok: false; status: number; code: string; message: string }> {
  const bearer = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (env.OPS_ADMIN_TOKEN && bearer && constantTimeEqual(bearer, env.OPS_ADMIN_TOKEN)) {
    return { ok: true, admin: { id: 0, display_name: 'Operations Admin', auth_mode: 'token' } };
  }
  const auth = await validateTelegramInitData(
    String(body.init_data || ''),
    String(env.TELEGRAM_BOT_TOKEN || ''),
    clamp(readEnvInt(env.TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS, 900), 60, 3600),
  );
  if (!auth.ok || !auth.user) return { ok: false, status: 401, code: 'TELEGRAM_AUTH_FAILED', message: auth.error || 'Unauthorized' };
  if (!isPlatformAdminId(auth.user.id, env)) {
    return { ok: false, status: 403, code: 'ADMIN_REQUIRED', message: `Telegram user ${auth.user.id} is not an administrator` };
  }
  return {
    ok: true,
    admin: {
      id: auth.user.id,
      username: auth.user.username,
      display_name: [auth.user.first_name, auth.user.last_name].filter(Boolean).join(' ') || auth.user.username || String(auth.user.id),
      auth_mode: 'telegram',
    },
  };
}

async function ensurePlatformControlSchema(env: ExtendedEnv): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS platform_modules (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT '◈',
        public_url TEXT,
        telegram_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 100,
        system INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        updated_by INTEGER,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS platform_content (
        id TEXT PRIMARY KEY,
        slot TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT '◈',
        action_label TEXT,
        action_url TEXT,
        visible INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 100,
        starts_at TEXT,
        ends_at TEXT,
        updated_by INTEGER,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_by INTEGER,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS platform_audit (
        id TEXT PRIMARY KEY,
        admin_user_id INTEGER NOT NULL,
        admin_name TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_platform_modules_order ON platform_modules(enabled DESC, sort_order ASC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_platform_content_slot ON platform_content(slot, visible DESC, sort_order ASC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit(created_at DESC);
    `);
    const defaults = [
      ['home', 'system', 'Начало', 'Главна секция на платформата.', '⌂', '/', null, 1, 10, 1],
      ['how-it-works', 'section', 'Как работи', 'Процесът от публичен URL до резултат.', '↗', '/#tutorial', null, 1, 20, 1],
      ['features', 'section', 'Функции', 'Backend, опашка, Telegram и сигурност.', '▤', '/#engines', null, 1, 30, 1],
      ['games', 'system', 'DyrakArmy Games', 'Общ игрови профил, XP, награди и класации.', '🎮', '/#games', null, 1, 40, 1],
      ['dyrakarmy-arena', 'game', 'DyrakArmy Arena', 'Отбори, дневни мисии, седмични лиги и сезони.', '⚔️', '/games/dyrakarmy-arena/', 'tg://resolve?domain=dyrakarmy_bot&startapp=arena', 1, 41, 1],
      ['latency-strike', 'game', 'Latency Strike', 'Реакция, общ XP и профилни награди.', '⚡', '/games/latency-strike/', 'tg://resolve?domain=dyrakarmy_bot&game=latency_strike', 1, 42, 1],
      ['downloads', 'tool', 'Download Console', 'Публични URL задачи, формати и статус.', '↓', '/#console', null, 1, 50, 1],
      ['media-lab', 'tool', 'Media Lab', 'Metadata и безопасни медийни инструменти.', '◉', '/#media-lab', null, 1, 60, 1],
      ['telegram', 'system', 'Telegram Bot', 'Mini App, команди, архив и доставка.', '✈', null, 'tg://resolve?domain=dyrakarmy_bot', 1, 70, 1],
      ['status', 'system', 'System Status', 'Публичен runtime статус и история.', '●', '/#status', null, 1, 80, 1],
      ['control-center', 'system', 'Control Center', 'Защитено дистанционно управление от телефон.', '⚙', '/control/', 'tg://resolve?domain=dyrakarmy_bot&startapp=control', 1, 900, 1]
    ];
    for (const row of defaults) {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO platform_modules (
          id, kind, title, description, icon, public_url, telegram_url, enabled, sort_order, system, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
      `).bind(...row).run();
    }
    const defaultSettings: Array<[string, unknown]> = [
      ['site.title', 'Download Killer'],
      ['site.subtitle', 'DyrakArmy unified platform'],
      ['site.footer', 'Web, Telegram, Games и Control Center върху общ edge backend.'],
      ['theme.accent', '#8b5cff'],
      ['theme.accent_secondary', '#62d4ff'],
      ['theme.background', '#070a18'],
      ['theme.radius', 18],
      ['announcement.enabled', true],
      ['games.season_label', 'SEASON 01'],
    ];
    for (const [key, value] of defaultSettings) {
      await env.DB.prepare('INSERT OR IGNORE INTO platform_settings (key, value_json) VALUES (?, ?)')
        .bind(key, JSON.stringify(value)).run();
    }
  })();
  return schemaReady;
}

async function publicRegistry(env: ExtendedEnv) {
  const cached = await env.CACHE.get(PUBLIC_CACHE_KEY, 'json').catch(() => null) as Record<string, unknown> | null;
  if (cached) return cached;
  const modulesResult = await env.DB.prepare(`
    SELECT id, kind, title, description, icon, public_url, telegram_url, enabled,
      sort_order, system, metadata_json, updated_at
    FROM platform_modules ORDER BY sort_order ASC, id ASC
  `).all<Record<string, unknown>>();
  const contentResult = await env.DB.prepare(`
    SELECT id, slot, title, body, icon, action_label, action_url, visible,
      sort_order, starts_at, ends_at, updated_at
    FROM platform_content
    WHERE visible = 1
      AND (starts_at IS NULL OR starts_at <= CURRENT_TIMESTAMP)
      AND (ends_at IS NULL OR ends_at >= CURRENT_TIMESTAMP)
    ORDER BY slot ASC, sort_order ASC, id ASC
  `).all<Record<string, unknown>>();
  const settingsResult = await env.DB.prepare('SELECT key, value_json FROM platform_settings ORDER BY key ASC')
    .all<{ key: string; value_json: string }>();
  const payload = {
    ok: true,
    version: CONTROL_VERSION,
    generated_at: new Date().toISOString(),
    modules: (modulesResult.results || []).map((row) => ({
      ...row,
      enabled: Number(row.enabled) === 1,
      system: Number(row.system) === 1,
      metadata: parseJson(String(row.metadata_json || '{}'), {}),
      metadata_json: undefined,
    })),
    content: (contentResult.results || []).map((row) => ({ ...row, visible: Number(row.visible) === 1 })),
    settings: Object.fromEntries((settingsResult.results || []).map((row) => [row.key, parseJson(row.value_json, null)])),
  };
  await env.CACHE.put(PUBLIC_CACHE_KEY, JSON.stringify(payload), { expirationTtl: PUBLIC_CACHE_TTL });
  return payload;
}

async function controlSnapshot(env: ExtendedEnv) {
  const publicData = await publicRegistry(env);
  return { ...publicData, audit: await auditRows(env, 80) };
}

async function invalidatePublicRegistry(env: ExtendedEnv): Promise<void> {
  await env.CACHE.delete(PUBLIC_CACHE_KEY);
}

async function moduleById(id: string, env: ExtendedEnv) {
  const row = await env.DB.prepare('SELECT * FROM platform_modules WHERE id = ? LIMIT 1').bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    ...row,
    system: Number(row.system || 0),
    enabled: Number(row.enabled || 0),
    metadata: parseJson(String(row.metadata_json || '{}'), {}),
    metadata_json: undefined,
  };
}

async function contentById(id: string, env: ExtendedEnv) {
  return env.DB.prepare('SELECT * FROM platform_content WHERE id = ? LIMIT 1').bind(id).first<Record<string, unknown>>();
}

async function settingByKey(key: string, env: ExtendedEnv) {
  const row = await env.DB.prepare('SELECT key, value_json, updated_by, updated_at FROM platform_settings WHERE key = ? LIMIT 1')
    .bind(key).first<{ key: string; value_json: string; updated_by: number | null; updated_at: string }>();
  return row ? { key: row.key, value: parseJson(row.value_json, null), updated_by: row.updated_by, updated_at: row.updated_at } : null;
}

async function audit(
  env: ExtendedEnv,
  admin: ControlAdmin,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO platform_audit (
      id, admin_user_id, admin_name, action, target_type, target_id, before_json, after_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), admin.id, admin.display_name, action, targetType, targetId,
    before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after),
  ).run();
}

async function auditRows(env: ExtendedEnv, limit: number) {
  const result = await env.DB.prepare(`
    SELECT id, admin_user_id, admin_name, action, target_type, target_id, created_at
    FROM platform_audit ORDER BY created_at DESC LIMIT ?
  `).bind(limit).all<Record<string, unknown>>();
  return result.results || [];
}

function sanitizeModule(input: PlatformModuleInput | undefined):
  | { ok: true; value: { id: string; kind: ModuleKind; title: string; description: string; icon: string; public_url: string | null; telegram_url: string | null; enabled: boolean; sort_order: number; metadata: Record<string, unknown> } }
  | { ok: false; message: string } {
  const id = sanitizeId(input?.id);
  if (!id) return { ok: false, message: 'Module id must use lowercase letters, numbers, - or _' };
  const kind = String(input?.kind || 'link') as ModuleKind;
  if (!MODULE_KINDS.has(kind)) return { ok: false, message: 'Unknown module kind' };
  const title = plainText(input?.title, 80);
  if (!title) return { ok: false, message: 'Title is required' };
  const publicUrl = safeUrl(input?.public_url);
  const telegramUrl = safeUrl(input?.telegram_url);
  if (input?.public_url && !publicUrl) return { ok: false, message: 'Public URL must be https, tg:// or a local /path' };
  if (input?.telegram_url && !telegramUrl) return { ok: false, message: 'Telegram URL must be https, tg:// or a local /path' };
  const metadata = isPlainObject(input?.metadata) ? JSON.parse(JSON.stringify(input?.metadata)) as Record<string, unknown> : {};
  if (JSON.stringify(metadata).length > 3000) return { ok: false, message: 'Metadata is too large' };
  return {
    ok: true,
    value: {
      id,
      kind,
      title,
      description: plainText(input?.description, 500),
      icon: plainText(input?.icon, 12) || '◈',
      public_url: publicUrl,
      telegram_url: telegramUrl,
      enabled: input?.enabled !== false,
      sort_order: clamp(Math.floor(Number(input?.sort_order || 100)), 0, 9999),
      metadata,
    },
  };
}

function sanitizeContent(input: PlatformContentInput | undefined):
  | { ok: true; value: { id: string; slot: ContentSlot; title: string; body: string; icon: string; action_label: string | null; action_url: string | null; visible: boolean; sort_order: number; starts_at: string | null; ends_at: string | null } }
  | { ok: false; message: string } {
  const id = sanitizeId(input?.id || crypto.randomUUID().slice(0, 18));
  if (!id) return { ok: false, message: 'Invalid content id' };
  const slot = String(input?.slot || 'updates') as ContentSlot;
  if (!CONTENT_SLOTS.has(slot)) return { ok: false, message: 'Unknown content slot' };
  const title = plainText(input?.title, 120);
  if (!title) return { ok: false, message: 'Title is required' };
  const actionUrl = safeUrl(input?.action_url);
  if (input?.action_url && !actionUrl) return { ok: false, message: 'Action URL must be https, tg:// or a local /path' };
  const startsAt = isoDateOrNull(input?.starts_at);
  const endsAt = isoDateOrNull(input?.ends_at);
  if (input?.starts_at && !startsAt) return { ok: false, message: 'Invalid start date' };
  if (input?.ends_at && !endsAt) return { ok: false, message: 'Invalid end date' };
  return {
    ok: true,
    value: {
      id,
      slot,
      title,
      body: plainText(input?.body, 1600),
      icon: plainText(input?.icon, 12) || '◈',
      action_label: plainText(input?.action_label, 50) || null,
      action_url: actionUrl,
      visible: input?.visible !== false,
      sort_order: clamp(Math.floor(Number(input?.sort_order || 100)), 0, 9999),
      starts_at: startsAt,
      ends_at: endsAt,
    },
  };
}

function sanitizeSettingValue(key: string, value: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  if (key.startsWith('theme.')) {
    if (key === 'theme.radius') {
      const radius = Number(value);
      if (!Number.isFinite(radius) || radius < 0 || radius > 48) return { ok: false, message: 'Radius must be between 0 and 48' };
      return { ok: true, value: Math.round(radius) };
    }
    const color = String(value || '').trim();
    if (!/^#[0-9a-f]{6}$/i.test(color)) return { ok: false, message: 'Theme colors must use #RRGGBB' };
    return { ok: true, value: color.toLowerCase() };
  }
  if (key === 'announcement.enabled') return { ok: true, value: value === true };
  const text = plainText(value, key === 'site.footer' ? 300 : 120);
  if (!text) return { ok: false, message: 'Value cannot be empty' };
  return { ok: true, value: text };
}

function sanitizeId(value: unknown): string | null {
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

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
