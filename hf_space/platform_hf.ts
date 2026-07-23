import platformV3 from './platform_v3';
import type { DownloadJob, Env, JobHistoryEvent } from './types';

type HfBackendMode = 'free-public' | 'standalone';
type HfEnv = Env & {
  HF_BACKEND_MODE?: string;
  HF_TELEGRAM_WEBHOOK_AUTOCONFIGURE?: string;
  HF_LOCAL_DOWNLOADER_ENABLED?: string;
  HF_LOCAL_DOWNLOADER_PORT?: string;
  PUBLIC_BASE_URL?: string;
  DOWNLOADER_API_KEY?: string;
};

interface LocalDownloaderHealth {
  enabled: boolean;
  ok: boolean;
  mode: 'local-container' | 'disabled';
  status: number;
  auth_status: number;
  endpoint?: string;
  error?: string;
}

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

function resolveLocalDownloaderPort(env: HfEnv): number {
  const parsed = Number.parseInt(String(env.HF_LOCAL_DOWNLOADER_PORT || '8081'), 10);
  return Number.isFinite(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : 8081;
}

export async function probeHfLocalDownloader(env: HfEnv): Promise<LocalDownloaderHealth> {
  const enabled = String(env.HF_LOCAL_DOWNLOADER_ENABLED || '1') !== '0';
  if (!enabled) return { enabled: false, ok: true, mode: 'disabled', status: 0, auth_status: 0 };

  const base = `http://127.0.0.1:${resolveLocalDownloaderPort(env)}`;
  try {
    const response = await fetch(`${base}/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return {
        enabled: true,
        ok: false,
        mode: 'local-container',
        status: response.status,
        auth_status: 0,
        endpoint: '127.0.0.1',
        error: `health HTTP ${response.status}`,
      };
    }

    const apiKey = String(env.DOWNLOADER_API_KEY || '').trim();
    if (!apiKey) {
      return {
        enabled: true,
        ok: false,
        mode: 'local-container',
        status: response.status,
        auth_status: 401,
        endpoint: '127.0.0.1',
        error: 'DOWNLOADER_API_KEY is missing',
      };
    }

    const authResponse = await fetch(`${base}/internal/files/__hf_auth_probe__`, {
      headers: { Accept: 'application/json', 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(3000),
    });
    const authOk = authResponse.status === 404;
    return {
      enabled: true,
      ok: authOk,
      mode: 'local-container',
      status: response.status,
      auth_status: authResponse.status,
      endpoint: '127.0.0.1',
      ...(authOk ? {} : { error: `auth probe HTTP ${authResponse.status}` }),
    };
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      mode: 'local-container',
      status: 0,
      auth_status: 0,
      endpoint: '127.0.0.1',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runtimeHealth(request: Request, env: HfEnv): Promise<Response> {
  const mode = resolveHfBackendMode(env);
  const persistent = mode === 'standalone';
  const downloader = await probeHfLocalDownloader(env);
  const ok = downloader.ok;
  return Response.json({
    ok,
    service: 'dyrakarmy-hugging-face-runtime',
    mode,
    public_url: resolveHfUpstream(env).origin || new URL(request.url).origin,
    state_authority: persistent ? 'hugging-face-persistent' : 'hugging-face-ephemeral',
    storage: persistent ? 'persistent-volume' : 'ephemeral-disk',
    free_public_host: mode === 'free-public',
    cloudflare_dependency: false,
    cloudflare_proxy_enabled: false,
    downloader,
    telegram_webhook_authority: persistent && String(env.HF_TELEGRAM_WEBHOOK_AUTOCONFIGURE || '0') === '1'
      ? 'hugging-face'
      : 'disabled',
    split_brain_protection: true,
  }, {
    status: ok ? 200 : 503,
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
