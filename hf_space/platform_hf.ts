import platformV3 from './platform_v3';
import type { DownloadJob, Env, JobHistoryEvent } from './types';

type HfBackendMode = 'cloudflare-mirror' | 'standalone';

type HfEnv = Env & {
  HF_BACKEND_MODE?: string;
  HF_CLOUDFLARE_UPSTREAM?: string;
  HF_MIRROR_FALLBACK_LOCAL?: string;
};

const DEFAULT_UPSTREAM = 'https://dyrakarmy.eu';
const MIRROR_PATH_PREFIXES = ['/api/', '/files/', '/download/'];
const LOCAL_HEALTH_PATH = '/api/hf-mirror/health';

export function resolveHfBackendMode(env: HfEnv): HfBackendMode {
  return String(env.HF_BACKEND_MODE || 'cloudflare-mirror').toLowerCase() === 'standalone'
    ? 'standalone'
    : 'cloudflare-mirror';
}

export function resolveHfUpstream(env: HfEnv): URL {
  const candidate = String(env.HF_CLOUDFLARE_UPSTREAM || DEFAULT_UPSTREAM).trim();
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:') return new URL(DEFAULT_UPSTREAM);
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return new URL(DEFAULT_UPSTREAM);
  }
}

export function shouldProxyHfRequest(request: Request, env: HfEnv): boolean {
  if (resolveHfBackendMode(env) !== 'cloudflare-mirror') return false;
  const pathname = new URL(request.url).pathname;
  if (pathname === LOCAL_HEALTH_PATH) return false;
  if (pathname === '/telegram/webhook') return true;
  return MIRROR_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function mirrorHealth(env: HfEnv): Response {
  const mode = resolveHfBackendMode(env);
  return Response.json(
    {
      ok: true,
      service: 'dyrakarmy-hugging-face-mirror',
      mode,
      upstream: resolveHfUpstream(env).origin,
      state_authority: mode === 'cloudflare-mirror' ? 'cloudflare' : 'hugging-face-local',
      telegram_webhook_authority: mode === 'cloudflare-mirror' ? 'cloudflare' : 'hugging-face',
      cloudflare_untouched: true,
      split_brain_protection: String(env.HF_MIRROR_FALLBACK_LOCAL || '0') !== '1',
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        'X-DyrakArmy-HF-Mode': mode,
      },
    },
  );
}

function buildMirrorRequest(request: Request, env: HfEnv): Request {
  const sourceUrl = new URL(request.url);
  const upstream = resolveHfUpstream(env);
  upstream.pathname = sourceUrl.pathname;
  upstream.search = sourceUrl.search;

  const headers = new Headers(request.headers);
  const clientOrigin = headers.get('Origin');
  headers.delete('Host');
  headers.delete('CF-Connecting-IP');
  headers.delete('CF-IPCountry');
  headers.delete('CF-Ray');
  headers.delete('X-Forwarded-For');
  headers.delete('X-Forwarded-Host');
  headers.delete('X-Forwarded-Proto');
  if (clientOrigin) headers.set('X-DyrakArmy-Client-Origin', clientOrigin);
  headers.set('Origin', upstream.origin);
  headers.set('Referer', `${upstream.origin}/`);
  headers.set('X-DyrakArmy-HF-Mirror', '1');

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
  return new Request(upstream.toString(), init);
}

async function proxyToCloudflare(request: Request, env: HfEnv): Promise<Response> {
  try {
    const response = await fetch(buildMirrorRequest(request, env));
    const headers = new Headers(response.headers);
    headers.delete('Content-Length');
    headers.set('X-DyrakArmy-HF-Mirror', 'cloudflare-upstream');
    headers.set('X-DyrakArmy-HF-Upstream-Status', String(response.status));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    if (String(env.HF_MIRROR_FALLBACK_LOCAL || '0') === '1') {
      return platformV3.fetch(request, env, {} as ExecutionContext);
    }
    console.error('Hugging Face mirror upstream unavailable', error);
    return Response.json(
      {
        ok: false,
        error: {
          code: 'HF_MIRROR_UPSTREAM_UNAVAILABLE',
          message: 'The Cloudflare production backend is temporarily unavailable.',
        },
      },
      {
        status: 502,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': '15',
          'X-DyrakArmy-HF-Mirror': 'upstream-error',
        },
      },
    );
  }
}

export default {
  async fetch(request: Request, env: HfEnv, context: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === LOCAL_HEALTH_PATH) return mirrorHealth(env);
    if (shouldProxyHfRequest(request, env)) return proxyToCloudflare(request, env);
    return platformV3.fetch(request, env, context);
  },

  async queue(
    batch: MessageBatch<DownloadJob | JobHistoryEvent>,
    env: HfEnv,
    context: ExecutionContext,
  ): Promise<void> {
    if (resolveHfBackendMode(env) === 'standalone') {
      return platformV3.queue(batch, env, context);
    }
    for (const message of batch.messages) message.ack();
  },

  async scheduled(
    controller: ScheduledController,
    env: HfEnv,
    context: ExecutionContext,
  ): Promise<void> {
    if (resolveHfBackendMode(env) === 'standalone') {
      return platformV3.scheduled(controller, env, context);
    }
  },
} satisfies ExportedHandler<HfEnv, DownloadJob | JobHistoryEvent>;
