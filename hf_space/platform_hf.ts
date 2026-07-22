import platformV3 from './platform_v3';
import type { DownloadJob, Env, JobHistoryEvent } from './types';

type HfBackendMode = 'free-public' | 'standalone';
type HfEnv = Env & {
  HF_BACKEND_MODE?: string;
  HF_TELEGRAM_WEBHOOK_AUTOCONFIGURE?: string;
  PUBLIC_BASE_URL?: string;
};

const NATIVE_SPACE_URL = 'https://dyrakarmy-dyrakarmy-platform.hf.space';
const HEALTH_PATHS = new Set(['/api/hf-runtime/health', '/api/hf-mirror/health']);

export function resolveHfBackendMode(env: HfEnv): HfBackendMode {
  return String(env.HF_BACKEND_MODE || 'free-public').toLowerCase() === 'standalone'
    ? 'standalone'
    : 'free-public';
}

export function resolveHfUpstream(env: HfEnv): URL {
  const candidate = String(env.PUBLIC_BASE_URL || NATIVE_SPACE_URL).trim();
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:') return new URL(NATIVE_SPACE_URL);
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return new URL(NATIVE_SPACE_URL);
  }
}

export function shouldProxyHfRequest(_request: Request, _env: HfEnv): boolean {
  return false;
}

function runtimeHealth(request: Request, env: HfEnv): Response {
  const mode = resolveHfBackendMode(env);
  const persistent = mode === 'standalone';
  return Response.json({
    ok: true,
    service: 'dyrakarmy-hugging-face-runtime',
    mode,
    public_url: resolveHfUpstream(env).origin || new URL(request.url).origin,
    state_authority: persistent ? 'hugging-face-persistent' : 'hugging-face-ephemeral',
    storage: persistent ? 'persistent-volume' : 'ephemeral-disk',
    free_public_host: mode === 'free-public',
    cloudflare_dependency: false,
    cloudflare_proxy_enabled: false,
    telegram_webhook_authority: persistent && String(env.HF_TELEGRAM_WEBHOOK_AUTOCONFIGURE || '0') === '1'
      ? 'hugging-face'
      : 'disabled',
    split_brain_protection: true,
  }, {
    headers: {
      'Cache-Control': 'no-store',
      'X-DyrakArmy-HF-Mode': mode,
    },
  });
}

export default {
  async fetch(request: Request, env: HfEnv, context: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (HEALTH_PATHS.has(pathname)) return runtimeHealth(request, env);
    return platformV3.fetch(request, env, context);
  },

  async queue(
    batch: MessageBatch<DownloadJob | JobHistoryEvent>,
    env: HfEnv,
    context: ExecutionContext,
  ): Promise<void> {
    return platformV3.queue(batch, env, context);
  },

  async scheduled(
    controller: ScheduledController,
    env: HfEnv,
    context: ExecutionContext,
  ): Promise<void> {
    return platformV3.scheduled(controller, env, context);
  },
} satisfies ExportedHandler<HfEnv, DownloadJob | JobHistoryEvent>;
