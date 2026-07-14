import legacyHandler from './index';
import type { DownloadJob, Env, JobHistoryEvent } from './types';
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

export default {
  async fetch(request: Request, env: ExtendedEnv, _context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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

    return legacyHandler.fetch(request, env);
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
