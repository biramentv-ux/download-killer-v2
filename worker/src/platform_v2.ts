import legacyHandler from './index';
import type { DownloadJob, Env, JobHistoryEvent } from './types';
import {
  ensureTelegramV10Commands,
  handleTelegramPlatformApi,
  handleTelegramPlatformWebhook,
  syncTelegramStorageBatch,
} from './telegram_platform';

type ExtendedEnv = Env & {
  TELEGRAM_STORAGE_ENABLED?: string;
};

export default {
  async fetch(request: Request, env: ExtendedEnv, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/telegram/webhook') {
      return handleTelegramPlatformWebhook(request, env);
    }

    const telegramApiResponse = await handleTelegramPlatformApi(request, env);
    if (telegramApiResponse) return telegramApiResponse;

    return legacyHandler.fetch(request, env, context);
  },

  async queue(
    batch: MessageBatch<DownloadJob | JobHistoryEvent>,
    env: ExtendedEnv,
    context: ExecutionContext,
  ): Promise<void> {
    const legacyEnv = Object.assign(Object.create(env), {
      TELEGRAM_CHANNEL_PUBLISH_ENABLED: '0',
    }) as ExtendedEnv;

    await legacyHandler.queue(batch, legacyEnv, context);
    context.waitUntil(syncTelegramStorageBatch(batch, env));
  },

  async scheduled(
    controller: ScheduledController,
    env: ExtendedEnv,
    context: ExecutionContext,
  ): Promise<void> {
    await legacyHandler.scheduled(controller, env, context);
    context.waitUntil(ensureTelegramV10Commands(env));
  },
} satisfies ExportedHandler<ExtendedEnv, DownloadJob | JobHistoryEvent>;
