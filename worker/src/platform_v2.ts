import legacyHandler from './index';
import type { DownloadJob, Env, JobHistoryEvent } from './types';
import { handleArchiveRaidApi } from './archive_raid';
import { handleArchiveRaidTelegramWebhook } from './archive_raid_bot';
import { handleDyrakArmyArenaApi } from './dyrakarmy_arena';
import { handleDyrakArmyArenaTelegramWebhook } from './dyrakarmy_arena_bot';
import { ensureDyrakArmyArenaCommands } from './dyrakarmy_arena_commands';
import { GAME_PACK, handleGamePackApi } from './game_pack';
import { handleGamePackTelegramWebhook } from './game_pack_bot';
import { handlePlatformControlApi, isPlatformModuleEnabled } from './platform_control';
import { handlePlatformControlTelegramWebhook } from './platform_control_bot';
import {
  ensureLatencyStrikeBotCommands,
  handleLatencyStrikeTelegramWebhook,
} from './latency_strike_bot';
import { handleLatencyStrikeGameApi } from './latency_strike_native';
import { handleMediaLabApi } from './media_lab';
import { handleJobStatusBridge } from './job_status_bridge';
import {
  ensureTelegramV10Commands,
  handleTelegramPlatformApi,
  syncTelegramStorageBatch,
} from './telegram_platform';
import {
  ensureTelegramMasterCommands,
  handleTelegramMasterWebhook,
} from './telegram_master_menu';
import {
  handleTelegramMiniAppHealth,
  TELEGRAM_MINIAPP_VERSION,
} from './telegram_miniapp_health';

type ExtendedEnv = Env & {
  TELEGRAM_STORAGE_ENABLED?: string;
  TELEGRAM_BOT_API_BASE?: string;
};

const PACK_GAME_IDS = Object.keys(GAME_PACK) as Array<keyof typeof GAME_PACK>;

function nativeTelegramLinks(env: ExtendedEnv): {
  username: string;
  deepLink: string;
  downloadLink: string;
  miniAppLink: string;
} {
  const username = String(env.TELEGRAM_BOT_USERNAME || 'dyrakarmy_bot').replace(/^@+/, '');
  return {
    username,
    deepLink: `tg://resolve?domain=${username}`,
    downloadLink: `tg://resolve?domain=${username}&start=download`,
    miniAppLink: `tg://resolve?domain=${username}&startapp=home`,
  };
}

function jsonWithExistingHeaders(response: Response, payload: unknown): Response {
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function enforceNativeTelegramApi(request: Request, response: Response, env: ExtendedEnv): Promise<Response> {
  if (request.method !== 'GET' || !response.ok) return response;
  const path = new URL(request.url).pathname;
  const links = nativeTelegramLinks(env);
  if (path === '/api/telegram/info') {
    return jsonWithExistingHeaders(response, {
      ok: true,
      available: true,
      username: links.username,
      deepLink: links.deepLink,
      downloadLink: links.downloadLink,
      miniAppLink: links.miniAppLink,
      native_only: true,
    });
  }
  if (path !== '/api/runtime-config') return response;

  const [latencyEnabled, arenaEnabled, raidEnabled, downloadsEnabled, mediaLabEnabled, ...packFlags] = await Promise.all([
    isPlatformModuleEnabled(env, 'latency-strike'),
    isPlatformModuleEnabled(env, 'dyrakarmy-arena'),
    isPlatformModuleEnabled(env, 'archive-raid'),
    isPlatformModuleEnabled(env, 'downloads'),
    isPlatformModuleEnabled(env, 'media-lab'),
    ...PACK_GAME_IDS.map((id) => isPlatformModuleEnabled(env, id)),
  ]);
  const packGames = Object.fromEntries(PACK_GAME_IDS.map((id, index) => {
    const game = GAME_PACK[id];
    return [id.replaceAll('-', '_'), {
      enabled: packFlags[index] ?? true,
      version: '1.0.0',
      path: `/games/${id}/`,
      miniapp_deep_link: `tg://resolve?domain=${links.username}&startapp=${id.replaceAll('-', '_')}`,
      shared_profile: true,
    }];
  }));
  const payload = await response.json() as Record<string, unknown>;
  return jsonWithExistingHeaders(response, {
    ...payload,
    platform_control: {
      enabled: true,
      public_registry: '/api/platform/public',
      control_path: '/control/',
      telegram_admin_command: '/control',
    },
    modules: {
      downloads: { enabled: downloadsEnabled },
      media_lab: { enabled: mediaLabEnabled },
    },
    telegram: {
      available: true,
      username: links.username,
      deep_link: links.deepLink,
      download_link: links.downloadLink,
      miniapp_link: links.miniAppLink,
      native_only: true,
    },
    games: {
      latency_strike: {
        enabled: latencyEnabled,
        version: '1.0.0',
        short_name: 'latency_strike',
        path: '/games/latency-strike/',
        native_deep_link: `tg://resolve?domain=${links.username}&game=latency_strike`,
      },
      dyrakarmy_arena: {
        enabled: arenaEnabled,
        version: '1.0.0',
        path: '/games/dyrakarmy-arena/',
        miniapp_deep_link: `tg://resolve?domain=${links.username}&startapp=arena`,
        modes: ['daily-arena', 'team-league', 'practice'],
      },
      archive_raid: {
        enabled: raidEnabled,
        version: '1.0.0',
        path: '/games/archive-raid/',
        miniapp_deep_link: `tg://resolve?domain=${links.username}&startapp=archive_raid`,
        modes: ['ranked-raid', 'practice', 'daily-crate', 'collection'],
        protected_content_access: false,
      },
      ...packGames,
    },
    game_system: {
      total_games: 10,
      shared_profile: true,
      shared_xp: true,
      shared_rewards: true,
      catalog: '/api/games/game-pack/catalog',
    },
  });
}

async function injectPlatformAssets(request: Request, response: Response): Promise<Response> {
  if (request.method !== 'GET' || !response.ok) return response;
  const url = new URL(request.url);
  const isRoot = url.pathname === '/' || url.pathname === '/index.html';
  const isTelegram = url.pathname === '/telegram/' || url.pathname === '/telegram/index.html';
  if (!isRoot && !isTelegram) return response;
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().includes('text/html')) return response;

  let html = await response.text();
  const favicon = '<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">';
  if (!html.includes('href="/favicon.svg"')) html = html.replace('</head>', `  ${favicon}\n</head>`);

  if (isRoot) {
    html = html.replace(/<link rel="canonical" href="[^"]+">/, '<link rel="canonical" href="https://dyrakarmy.eu/">');
    for (const href of ['/platform/games-v14.css', '/platform/platform-public.css']) {
      if (!html.includes(href)) html = html.replace('</head>', `  <link rel="stylesheet" href="${href}">\n</head>`);
    }
    if (!html.includes('/platform/status-backoff.js')) {
      html = html.replace('<script src="/platform/platform.js" defer></script>', [
        '<script src="/platform/status-backoff.js"></script>',
        '<script src="/platform/site-defaults.js" defer></script>',
        '<script src="/platform/platform.js" defer></script>',
      ].join('\n  '));
    }
    if (!html.includes('/media-lab/media-lab.css')) html = html.replace('</head>', '  <link rel="stylesheet" href="/media-lab/media-lab.css">\n</head>');
    if (!html.includes('/media-lab/media-lab.js')) html = html.replace('</body>', '  <script src="/media-lab/media-lab.js" defer></script>\n</body>');
    for (const src of ['/platform/games-v14.js', '/platform/platform-public.js']) {
      if (!html.includes(src)) html = html.replace('</body>', `  <script src="${src}" defer></script>\n</body>`);
    }
  } else {
    html = html.replace(
      /<script src="\.\/telegram\.js(?:\?[^\"]*)?" defer><\/script>/,
      `<script src="/platform/status-backoff.js?v=${TELEGRAM_MINIAPP_VERSION}"></script>\n  <script src="./telegram.js?v=${TELEGRAM_MINIAPP_VERSION}" defer></script>`,
    );
    const archiveCard = '<button class="command-card" type="button" data-open-tab="archive"><i>☁</i><b>Архив</b><small>Telegram file_id и повторна употреба</small></button>';
    const cards: string[] = [archiveCard];
    const fixedGames = [
      ['latency-strike', '⚡', 'Latency Strike', 'Native реакция, XP и седмична класация', 'tg://resolve?domain=dyrakarmy_bot&game=latency_strike'],
      ['dyrakarmy-arena', '⚔️', 'DyrakArmy Arena', 'Отбори, дневни мисии, сезони и класации', 'tg://resolve?domain=dyrakarmy_bot&startapp=arena'],
      ['archive-raid', '🗃', 'Archive Raid', 'Collectible карти, crates и профилни ефекти', 'tg://resolve?domain=dyrakarmy_bot&startapp=archive_raid'],
    ];
    for (const [id, icon, title, description, href] of fixedGames) {
      if (!html.includes(`data-game="${id}"`)) cards.push(`<a class="command-card" data-game="${id}" href="${href}" style="text-decoration:none"><i>${icon}</i><b>${title}</b><small>${description}</small></a>`);
    }
    for (const id of PACK_GAME_IDS) {
      const game = GAME_PACK[id];
      if (!html.includes(`data-game="${id}"`)) {
        cards.push(`<a class="command-card" data-game="${id}" href="tg://resolve?domain=dyrakarmy_bot&startapp=${id.replaceAll('-', '_')}" style="text-decoration:none"><i>${game.icon}</i><b>${game.title}</b><small>${game.description}</small></a>`);
      }
    }
    if (!html.includes('data-control-center')) cards.push('<a class="command-card" data-control-center href="/control/" style="text-decoration:none"><i>⚙</i><b>Control Center</b><small>Защитено дистанционно управление</small></a>');
    if (cards.length > 1) html = html.replace(archiveCard, cards.join('\n        '));
  }

  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.set('Cache-Control', isTelegram ? 'no-store, max-age=0, must-revalidate' : 'no-cache');
  headers.set('Pragma', isTelegram ? 'no-cache' : headers.get('Pragma') ?? '');
  headers.set('X-Download-Killer-Version', isTelegram ? TELEGRAM_MINIAPP_VERSION : 'platform-v15-games-10');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

async function disabledModuleResponse(request: Request, env: ExtendedEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const packChecks: Array<[string, boolean]> = PACK_GAME_IDS.map((id) => [
    id,
    url.pathname.startsWith(`/api/games/${id}/`) || url.pathname.startsWith(`/games/${id}/`),
  ]);
  const checks: Array<[string, boolean]> = [
    ...packChecks,
    ['archive-raid', url.pathname.startsWith('/api/games/archive-raid/') || url.pathname.startsWith('/games/archive-raid/')],
    ['dyrakarmy-arena', url.pathname.startsWith('/api/games/dyrakarmy-arena/') || url.pathname.startsWith('/games/dyrakarmy-arena/')],
    ['latency-strike', url.pathname.startsWith('/api/games/latency-strike/') || url.pathname.startsWith('/games/latency-strike/')],
    ['downloads', request.method === 'POST' && url.pathname === '/api/download'],
    ['media-lab', url.pathname.startsWith('/api/media-lab/')],
  ];
  for (const [moduleId, matches] of checks) {
    if (!matches) continue;
    if (await isPlatformModuleEnabled(env, moduleId)) return null;
    const isApi = url.pathname.startsWith('/api/');
    return isApi
      ? Response.json({ error: { code: 'MODULE_DISABLED', message: `${moduleId} is disabled by the platform administrator` } }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
      : new Response('This module is temporarily hidden by the platform administrator.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  return null;
}

export default {
  async fetch(request: Request, env: ExtendedEnv, _context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const controlResponse = await handlePlatformControlApi(request, env);
    if (controlResponse) return controlResponse;
    const disabledResponse = await disabledModuleResponse(request, env);
    if (disabledResponse) return disabledResponse;
    const telegramHealthResponse = handleTelegramMiniAppHealth(request, env);
    if (telegramHealthResponse) return telegramHealthResponse;
    const packResponse = await handleGamePackApi(request, env);
    if (packResponse) return packResponse;
    const raidResponse = await handleArchiveRaidApi(request, env);
    if (raidResponse) return raidResponse;
    const arenaResponse = await handleDyrakArmyArenaApi(request, env);
    if (arenaResponse) return arenaResponse;
    const gameResponse = await handleLatencyStrikeGameApi(request, env);
    if (gameResponse) return gameResponse;
    const jobStatusResponse = await handleJobStatusBridge(request, env);
    if (jobStatusResponse) return jobStatusResponse;
    const mediaLabResponse = await handleMediaLabApi(request, env);
    if (mediaLabResponse) return mediaLabResponse;

    if (url.pathname === '/telegram/webhook') {
      await ensureDyrakArmyArenaCommands(env);
      const controlWebhookResponse = await handlePlatformControlTelegramWebhook(request.clone(), env);
      if (controlWebhookResponse) return controlWebhookResponse;
      const packWebhookResponse = await handleGamePackTelegramWebhook(request.clone(), env);
      if (packWebhookResponse) return packWebhookResponse;
      if (await isPlatformModuleEnabled(env, 'archive-raid')) {
        const raidWebhookResponse = await handleArchiveRaidTelegramWebhook(request.clone(), env);
        if (raidWebhookResponse) return raidWebhookResponse;
      }
      if (await isPlatformModuleEnabled(env, 'dyrakarmy-arena')) {
        const arenaWebhookResponse = await handleDyrakArmyArenaTelegramWebhook(request.clone(), env);
        if (arenaWebhookResponse) return arenaWebhookResponse;
      }
      if (await isPlatformModuleEnabled(env, 'latency-strike')) {
        const gameWebhookResponse = await handleLatencyStrikeTelegramWebhook(request.clone(), env);
        if (gameWebhookResponse) return gameWebhookResponse;
      }
      return handleTelegramMasterWebhook(request, env);
    }

    const telegramApiResponse = await handleTelegramPlatformApi(request, env);
    if (telegramApiResponse) return telegramApiResponse;
    const legacyResponse = await legacyHandler.fetch(request, env);
    const nativeResponse = await enforceNativeTelegramApi(request, legacyResponse, env);
    return injectPlatformAssets(request, nativeResponse);
  },

  async queue(batch: MessageBatch<DownloadJob | JobHistoryEvent>, env: ExtendedEnv, context: ExecutionContext): Promise<void> {
    const legacyEnv = Object.assign(Object.create(env), { TELEGRAM_CHANNEL_PUBLISH_ENABLED: '0' }) as ExtendedEnv;
    await legacyHandler.queue(batch, legacyEnv);
    context.waitUntil(syncTelegramStorageBatch(batch, env));
  },

  async scheduled(controller: ScheduledController, env: ExtendedEnv, context: ExecutionContext): Promise<void> {
    await legacyHandler.scheduled(controller, env);
    context.waitUntil((async () => {
      await ensureDyrakArmyArenaCommands(env);
      await ensureTelegramV10Commands(env);
      await ensureTelegramMasterCommands(env);
      await ensureLatencyStrikeBotCommands(env);
      await ensureDyrakArmyArenaCommands(env);
    })());
  },
} satisfies ExportedHandler<ExtendedEnv, DownloadJob | JobHistoryEvent>;
