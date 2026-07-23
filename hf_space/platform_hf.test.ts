import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platformFetch: vi.fn(async () => new Response('local-runtime', { status: 200 })),
  queue: vi.fn(async () => undefined),
  scheduled: vi.fn(async () => undefined),
  downloaderFetch: vi.fn(async () => Response.json({ ok: true, service: 'downloader' })),
}));

vi.mock('./platform_v3', () => ({
  default: {
    fetch: mocks.platformFetch,
    queue: mocks.queue,
    scheduled: mocks.scheduled,
  },
}));

import handler, {
  probeHfLocalDownloader,
  resolveHfBackendMode,
  resolveHfUpstream,
  shouldProxyHfRequest,
} from './platform_hf';

const context = {} as ExecutionContext;

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.platformFetch.mockClear();
  mocks.queue.mockClear();
  mocks.scheduled.mockClear();
  mocks.downloaderFetch.mockReset();
  mocks.downloaderFetch.mockResolvedValue(Response.json({ ok: true, service: 'downloader' }));
  vi.stubGlobal('fetch', mocks.downloaderFetch);
});

describe('Hugging Face free-public runtime', () => {
  it('defaults to the native free public Space URL', () => {
    const env = {} as never;
    expect(resolveHfBackendMode(env)).toBe('free-public');
    expect(resolveHfUpstream(env).origin).toBe('https://dyrakarmy-dyrakarmy-platform.hf.space');
  });

  it('maps every legacy non-standalone value to free-public mode', () => {
    expect(resolveHfBackendMode({ HF_BACKEND_MODE: 'cloudflare-mirror' } as never)).toBe('free-public');
    expect(resolveHfBackendMode({ HF_BACKEND_MODE: 'unknown' } as never)).toBe('free-public');
    expect(resolveHfBackendMode({ HF_BACKEND_MODE: 'standalone' } as never)).toBe('standalone');
  });

  it('never proxies pages, APIs, files, games or Telegram routes', () => {
    const env = { HF_BACKEND_MODE: 'free-public' } as never;
    for (const path of ['/', '/api/health', '/files/example.mp3', '/games/queue-commander/', '/control-v2/', '/telegram/webhook']) {
      expect(shouldProxyHfRequest(new Request(`https://space.example${path}`), env)).toBe(false);
    }
  });

  it('probes only the private localhost downloader endpoint', async () => {
    const result = await probeHfLocalDownloader({ HF_LOCAL_DOWNLOADER_PORT: '8081' } as never);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('local-container');
    expect(result.endpoint).toBe('127.0.0.1');
    expect(mocks.downloaderFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8081/health',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('exposes the free-public health contract with a ready local downloader', async () => {
    const response = await handler.fetch(
      new Request('https://space.example/api/hf-runtime/health'),
      { HF_BACKEND_MODE: 'free-public', HF_LOCAL_DOWNLOADER_ENABLED: '1' } as never,
      context,
    );
    const payload = await response.json() as Record<string, unknown>;
    const downloader = payload.downloader as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe('free-public');
    expect(payload.state_authority).toBe('hugging-face-ephemeral');
    expect(payload.storage).toBe('ephemeral-disk');
    expect(payload.cloudflare_dependency).toBe(false);
    expect(payload.cloudflare_proxy_enabled).toBe(false);
    expect(payload.telegram_webhook_authority).toBe('disabled');
    expect(downloader.ok).toBe(true);
    expect(downloader.mode).toBe('local-container');
    expect(mocks.platformFetch).not.toHaveBeenCalled();
  });

  it('returns 503 when the private downloader is not ready', async () => {
    mocks.downloaderFetch.mockResolvedValueOnce(new Response('down', { status: 503 }));
    const response = await handler.fetch(
      new Request('https://space.example/api/hf-runtime/health'),
      { HF_BACKEND_MODE: 'free-public', HF_LOCAL_DOWNLOADER_ENABLED: '1' } as never,
      context,
    );
    const payload = await response.json() as { ok?: boolean; downloader?: { status?: number } };
    expect(response.status).toBe(503);
    expect(payload.ok).toBe(false);
    expect(payload.downloader?.status).toBe(503);
  });

  it('supports explicitly disabling the bundled downloader', async () => {
    const response = await handler.fetch(
      new Request('https://space.example/api/hf-runtime/health'),
      { HF_BACKEND_MODE: 'free-public', HF_LOCAL_DOWNLOADER_ENABLED: '0' } as never,
      context,
    );
    const payload = await response.json() as { ok?: boolean; downloader?: { mode?: string } };
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.downloader?.mode).toBe('disabled');
    expect(mocks.downloaderFetch).not.toHaveBeenCalled();
  });

  it('retains the old health path as a compatibility alias', async () => {
    const response = await handler.fetch(
      new Request('https://space.example/api/hf-mirror/health'),
      { HF_BACKEND_MODE: 'free-public' } as never,
      context,
    );
    const payload = await response.json() as { mode?: string };
    expect(payload.mode).toBe('free-public');
    expect(mocks.platformFetch).not.toHaveBeenCalled();
  });

  it('serves all normal requests from the local Worker runtime', async () => {
    const response = await handler.fetch(
      new Request('https://space.example/api/health'),
      { HF_BACKEND_MODE: 'free-public' } as never,
      context,
    );
    expect(await response.text()).toBe('local-runtime');
    expect(mocks.platformFetch).toHaveBeenCalledOnce();
    expect(mocks.downloaderFetch).not.toHaveBeenCalled();
  });

  it('runs queue and scheduled handlers locally in free-public mode', async () => {
    const env = { HF_BACKEND_MODE: 'free-public' } as never;
    await handler.queue({ messages: [] } as never, env, context);
    await handler.scheduled({} as never, env, context);
    expect(mocks.queue).toHaveBeenCalledOnce();
    expect(mocks.scheduled).toHaveBeenCalledOnce();
  });

  it('reports persistent authority only for explicit standalone mode', async () => {
    const response = await handler.fetch(
      new Request('https://space.example/api/hf-runtime/health'),
      { HF_BACKEND_MODE: 'standalone', HF_TELEGRAM_WEBHOOK_AUTOCONFIGURE: '1' } as never,
      context,
    );
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.mode).toBe('standalone');
    expect(payload.state_authority).toBe('hugging-face-persistent');
    expect(payload.storage).toBe('persistent-volume');
    expect(payload.telegram_webhook_authority).toBe('hugging-face');
  });
});
