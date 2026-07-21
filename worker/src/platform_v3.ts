import platformV2 from './platform_v2';
import type { DownloadJob, Env, JobHistoryEvent } from './types';
import {
  handlePlatformGovernanceApi,
  handlePlatformGovernanceTelegramWebhook,
} from './platform_governance';
import { handleSoftwareCatalogApi } from './software_catalog';
import { handleSoftwareTelegramWebhook } from './software_telegram';

type ExtendedEnv = Env & {
  TELEGRAM_ADMIN_IDS?: string;
  TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS?: string;
  TELEGRAM_BOT_API_BASE?: string;
  PLATFORM_SESSION_TTL_SECONDS?: string;
  LATEST_DESKTOP_WINDOWS_VERSION?: string;
  LATEST_DESKTOP_MACOS_VERSION?: string;
  LATEST_MOBILE_EXPO_VERSION?: string;
  LATEST_EXTENSION_VERSION?: string;
  LATEST_WEB_VERSION?: string;
  RELEASE_CHANNEL?: string;
  RELEASE_GITHUB_REPOSITORY?: string;
  PUBLIC_BASE_URL?: string;
};

export default {
  async fetch(request: Request, env: ExtendedEnv, context: ExecutionContext): Promise<Response> {
    const softwareCatalogResponse = await handleSoftwareCatalogApi(request, env);
    if (softwareCatalogResponse) return softwareCatalogResponse;

    const governanceResponse = await handlePlatformGovernanceApi(request, env);
    if (governanceResponse) return governanceResponse;

    const url = new URL(request.url);
    if (url.pathname === '/telegram/webhook' && request.method === 'POST') {
      const linkResponse = await handlePlatformGovernanceTelegramWebhook(request.clone(), env);
      if (linkResponse) return linkResponse;

      const softwareResponse = await handleSoftwareTelegramWebhook(request.clone(), env);
      if (softwareResponse) return softwareResponse;
    }

    return platformV2.fetch(request, env, context);
  },

  async queue(
    batch: MessageBatch<DownloadJob | JobHistoryEvent>,
    env: ExtendedEnv,
    context: ExecutionContext,
  ): Promise<void> {
    return platformV2.queue(batch, env, context);
  },

  async scheduled(
    controller: ScheduledController,
    env: ExtendedEnv,
    context: ExecutionContext,
  ): Promise<void> {
    return platformV2.scheduled(controller, env, context);
  },
} satisfies ExportedHandler<ExtendedEnv, DownloadJob | JobHistoryEvent>;
