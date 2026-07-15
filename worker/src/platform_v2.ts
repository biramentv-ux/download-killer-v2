import legacyHandler from './index';
import type { DownloadJob, Env, JobHistoryEvent } from './types';
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
};

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

async function enforceNativeTelegramApi(
  request: Request,
  response: Response,
  env: ExtendedEnv,
): Promise<Response> {
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
  const payload = await response.json() as Record<string, unknown>;
  return jsonWithExistingHeaders(response, {
    ...payload,
    telegram: {
      available: true,
      username: links.username,
      deep_link: links.deepLink,
      download_link: links.downloadLink,
      miniapp_link: links.miniAppLink,
      native_only: true,
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
  if (!html.includes('href="/favicon.svg"')) {
    html = html.replace('</head>', `  ${favicon}\n</head>`);
  }

  if (isRoot) {
    html = html.replace(
      /<link rel="canonical" href="[^"]+">/,
      '<link rel="canonical" href="https://dyrakarmy.eu/">',
    );
    if (!html.includes('/platform/status-backoff.js')) {
      html = html.replace('<script src="/platform/platform.js" defer></script>', [
        '<script src="/platform/status-backoff.js"></script>',
        '<script src="/platform/site-defaults.js" defer></script>',
        '<script src="/platform/platform.js" defer></script>',
      ].join('\n  '));
    }
    if (!html.includes('/media-lab/media-lab.css')) {
      html = html.replace('</head>', '  <link rel="stylesheet" href="/media-lab/media-lab.css">\n</head>');
    }
    if (!html.includes('/media-lab/media-lab.js')) {
      html = html.replace('</body>', '  <script src="/media-lab/media-lab.js" defer></script>\n</body>');
    }
  } else {
    html = html.replace(
      /<script src="\.\/telegram\.js(?:\?[^\"]*)?" defer><\/script>/,
      `<script src="/platform/status-backoff.js?v=${TELEGRAM_MINIAPP_VERSION}"></script>\n  <script src="./telegram.js?v=${TELEGRAM_MINIAPP_VERSION}" defer></script>`,
    );
  }

  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.set('Cache-Control', isTelegram ? 'no-store, max-age=0, must-revalidate' : 'no-cache');
  headers.set('Pragma', isTelegram ? 'no-cache' : headers.get('Pragma') ?? '');
  headers.set('X-Download-Killer-Version', isTelegram ? TELEGRAM_MINIAPP_VERSION : 'platform');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: ExtendedEnv, _context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const telegramHealthResponse = handleTelegramMiniAppHealth(request, env);
    if (telegramHealthResponse) return telegramHealthResponse;

    const jobStatusResponse = await handleJobStatusBridge(request, env);
    if (jobStatusResponse) return jobStatusResponse;

    const mediaLabResponse = await handleMediaLabApi(request, env);
    if (mediaLabResponse) return mediaLabResponse;

    if (url.pathname === '/telegram/webhook') {
      return handleTelegramMasterWebhook(request, env);
    }

    const telegramApiResponse = await handleTelegramPlatformApi(request, env);
    if (telegramApiResponse) return telegramApiResponse;

    const legacyResponse = await legacyHandler.fetch(request, env);
    const nativeResponse = await enforceNativeTelegramApi(request, legacyResponse, env);
    return injectPlatformAssets(request, nativeResponse);
  },

  async queue(
    batch: MessageBatch<DownloadJob | JobHistoryEvent>,
    env: ExtendedEnv,
    context: ExecutionContext,
  ): Promise<void> {
    const legacyEnv = Object.assign(Object.create(env), {
      TELEGRAM_CHANNEL_PUBLISH_ENABLED: '0',
    }) as ExtendedEnv;

    await legacyHandler.queue(batch, legacyEnv);
    context.waitUntil(syncTelegramStorageBatch(batch, env));
  },

  async scheduled(
    controller: ScheduledController,
    env: ExtendedEnv,
    context: ExecutionContext,
  ): Promise<void> {
    await legacyHandler.scheduled(controller, env);
    context.waitUntil((async () => {
      await ensureTelegramV10Commands(env);
      await ensureTelegramMasterCommands(env);
    })());
  },
} satisfies ExportedHandler<ExtendedEnv, DownloadJob | JobHistoryEvent>;
