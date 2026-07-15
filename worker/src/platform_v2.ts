import legacyHandler from './index';
import type { DownloadJob, Env, JobHistoryEvent } from './types';
import { handleMediaLabApi } from './media_lab';
import { handleJobStatusBridge } from './job_status_bridge';
import {
  ensureTelegramV10Commands,
  handleTelegramPlatformApi,
  handleTelegramPlatformWebhook,
  syncTelegramStorageBatch,
} from './telegram_platform';
import {
  createSecondaryTelegramEnv,
  hasSecondaryTelegramBot,
  rewriteSecondaryTelegramApiRequest,
} from './telegram_secondary';

type ExtendedEnv = Env & {
  TELEGRAM_STORAGE_ENABLED?: string;
  TELEGRAM_SECONDARY_BOT_TOKEN?: string;
  TELEGRAM_SECONDARY_SECRET_TOKEN?: string;
  TELEGRAM_SECONDARY_BOT_USERNAME?: string;
};

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
  html = html.replace('</head>', `  ${favicon}\n</head>`);

  if (isRoot) {
    html = html
      .replace('href="https://dyrakarmy.online/" rel="canonical"', 'href="https://dyrakarmy.eu/" rel="canonical"')
      .replace('<script src="/platform/platform.js" defer></script>', [
        '<script src="/platform/status-backoff.js"></script>',
        '<script src="/platform/site-defaults.js" defer></script>',
        '<script src="/platform/platform.js" defer></script>',
      ].join('\n  '))
      .replace('</head>', '  <link rel="stylesheet" href="/media-lab/media-lab.css">\n</head>')
      .replace('</body>', '  <script src="/media-lab/media-lab.js" defer></script>\n</body>');
  } else {
    html = html.replace(
      '<script src="./telegram.js" defer></script>',
      '<script src="/platform/status-backoff.js"></script>\n  <script src="./telegram.js" defer></script>',
    );
  }

  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'no-cache');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: ExtendedEnv, _context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const jobStatusResponse = await handleJobStatusBridge(request, env);
    if (jobStatusResponse) return jobStatusResponse;

    const mediaLabResponse = await handleMediaLabApi(request, env);
    if (mediaLabResponse) return mediaLabResponse;

    if (url.pathname === '/telegram/webhook') {
      return handleTelegramPlatformWebhook(request, env);
    }

    if (url.pathname === '/telegram/webhook/dyrakarmy') {
      if (!hasSecondaryTelegramBot(env)) {
        return Response.json(
          { error: { code: 'SECONDARY_BOT_NOT_CONFIGURED', message: 'Secondary Telegram bot is not configured', retryable: false } },
          { status: 503 },
        );
      }
      return handleTelegramPlatformWebhook(request, createSecondaryTelegramEnv(env));
    }

    if (url.pathname.startsWith('/api/telegram/v10-secondary/')) {
      if (!hasSecondaryTelegramBot(env)) {
        return Response.json(
          { error: { code: 'SECONDARY_BOT_NOT_CONFIGURED', message: 'Secondary Telegram bot is not configured', retryable: false } },
          { status: 503 },
        );
      }
      return handleTelegramPlatformApi(
        rewriteSecondaryTelegramApiRequest(request),
        createSecondaryTelegramEnv(env),
      ) as Promise<Response>;
    }

    const telegramApiResponse = await handleTelegramPlatformApi(request, env);
    if (telegramApiResponse) return telegramApiResponse;

    const response = await legacyHandler.fetch(request, env);
    return injectPlatformAssets(request, response);
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
    context.waitUntil(ensureTelegramV10Commands(env));
  },
} satisfies ExportedHandler<ExtendedEnv, DownloadJob | JobHistoryEvent>;
