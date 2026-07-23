import platformV2 from './platform_v2';
import type { DownloadJob, Env, JobHistoryEvent } from './types';
import {
  handlePlatformGovernanceApi,
  handlePlatformGovernanceTelegramWebhook,
} from './platform_governance';
import { handleSoftwareCatalogApi } from './software_catalog';
import { handleSoftwareTelegramWebhook } from './software_telegram';
import { withResilientGovernanceCache } from './resilient_governance_cache';
import { handleSourceDiscoveryApi } from './source_discovery';
import {
  handleSpotifyResolverApi,
  handleSpotifyTelegramResolverWebhook,
} from './spotify_resolver';
import {
  handleTelegramArchiveReconcileApi,
  runTelegramArchiveReconcile,
} from './telegram_archive_reconcile';

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
  AUDIUS_API_KEY?: string;
  JAMENDO_CLIENT_ID?: string;
  SOURCE_SEARCH_LIMIT?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_RESOLVER_AUTO_THRESHOLD?: string;
  SPOTIFY_RESOLVER_REVIEW_THRESHOLD?: string;
  TELEGRAM_STORAGE_ENABLED?: string;
  TELEGRAM_DOWNLOAD_CHANNEL_ID?: string;
  TELEGRAM_ARCHIVE_RECONCILE_BATCH?: string;
  TELEGRAM_ARCHIVE_RECONCILE_RETRY_MINUTES?: string;
};

export default {
  async fetch(request: Request, env: ExtendedEnv, context: ExecutionContext): Promise<Response> {
    const spotifyResolverResponse = await handleSpotifyResolverApi(request, env);
    if (spotifyResolverResponse) return spotifyResolverResponse;

    const sourceDiscoveryResponse = await handleSourceDiscoveryApi(request, env);
    if (sourceDiscoveryResponse) return sourceDiscoveryResponse;

    const archiveReconcileResponse = await handleTelegramArchiveReconcileApi(request, env);
    if (archiveReconcileResponse) return archiveReconcileResponse;

    const softwareCatalogResponse = await handleSoftwareCatalogApi(
      request as unknown as Request,
      env,
    );
    if (softwareCatalogResponse) return softwareCatalogResponse;

    // Device-link and opaque session state are written to D1 first and mirrored to KV.
    // This keeps Control Center login working even when the Cloudflare KV daily write
    // quota is temporarily exhausted.
    const governanceEnv = withResilientGovernanceCache(env);
    const governanceResponse = await handlePlatformGovernanceApi(request, governanceEnv);
    if (governanceResponse) return governanceResponse;

    const url = new URL(request.url);
    let downstreamRequest = request;
    if (url.pathname === '/telegram/webhook' && request.method === 'POST') {
      const linkResponse = await handlePlatformGovernanceTelegramWebhook(request.clone(), governanceEnv);
      if (linkResponse) return linkResponse;

      const softwareResponse = await handleSoftwareTelegramWebhook(
        request.clone() as unknown as Request,
        env,
      );
      if (softwareResponse) return softwareResponse;

      // Spotify URLs are resolved before the legacy bot creates a job. High-confidence
      // authorized matches are rewritten to their external audio URL; all other matches
      // receive a Spotify playback/review response and do not create a failed job.
      const spotifyTelegram = await handleSpotifyTelegramResolverWebhook(request.clone(), env);
      if (spotifyTelegram?.response) return spotifyTelegram.response;
      if (spotifyTelegram?.request) downstreamRequest = spotifyTelegram.request;
    }

    return platformV2.fetch(downstreamRequest, env, context);
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
    await platformV2.scheduled(controller, env, context);
    context.waitUntil(
      runTelegramArchiveReconcile(env).catch((error) => {
        console.warn('Telegram archive reconciliation skipped', error);
      }),
    );
  },
} satisfies ExportedHandler<ExtendedEnv, DownloadJob | JobHistoryEvent>;
