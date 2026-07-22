import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(async () => new Response('local-runtime', { status: 200 })),
  queue: vi.fn(async () => undefined),
  scheduled: vi.fn(async () => undefined),
}));

vi.mock('./platform_v3', () => ({
  default: {
    fetch: mocks.fetch,
    queue: mocks.queue,
    scheduled: mocks.scheduled,
  },
}));

import handler, {
  resolveHfBackendMode,
  resolveHfUpstream,
  shouldProxyHfRequest,
} from './platform_hf';

const context = {} as ExecutionContext;

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.fetch.mockClear();
  mocks.queue.mockClear();
  mocks.scheduled.mockClear();
});

describe('Hugging Face parallel mirror runtime', () => {
  it('defaults to the safe Cloudflare mirror mode', () => {
    const env = {} as never;
    expect(resolveHfBackendMode(env)).toBe('cloudflare-mirror');
    expect(resolveHfUpstream(env).origin).toBe('https://dyrakarmy.eu');
  });

  it('keeps static pages local while proxying stateful routes', () => {
    const env = { HF_BACKEND_MODE: 'cloudflare-mirror' } as never;
    expect(shouldProxyHfRequest(new Request('https://space.example/'), env)).toBe(false);
    expect(shouldProxyHfRequest(new Request('https://space.example/games/queue-commander/'), env)).toBe(false);
    expect(shouldProxyHfRequest(new Request('https://space.example/api/health'), env)).toBe(true);
    expect(shouldProxyHfRequest(new Request('https://space.example/files/example.mp3'), env)).toBe(true);
    expect(shouldProxyHfRequest(new Request('https://space.example/telegram/webhook'), env)).toBe(true);
  });

  it('exposes a local mirror health contract without touching Cloudflare', async () => {
    const env = { HF_BACKEND_MODE: 'cloudflare-mirror' } as never;
    const response = await handler.fetch(
      new Request('https://space.example/api/hf-mirror/health'),
      env,
      context,
    );
    const payload = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe('cloudflare-mirror');
    expect(payload.state_authority).toBe('cloudflare');
    expect(payload.cloudflare_untouched).toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('forwards API requests to the canonical Cloudflare production backend', async () => {
    const upstreamFetch = vi.fn(async (request: Request) => Response.json({ ok: true, url: request.url }));
    vi.stubGlobal('fetch', upstreamFetch);
    const env = {
      HF_BACKEND_MODE: 'cloudflare-mirror',
      HF_CLOUDFLARE_UPSTREAM: 'https://dyrakarmy.eu',
    } as never;
    const response = await handler.fetch(
      new Request('https://dyrakarmy-dyrakarmy-platform.hf.space/api/health?full=1', {
        headers: { Origin: 'https://dyrakarmy-dyrakarmy-platform.hf.space' },
      }),
      env,
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-DyrakArmy-HF-Mirror')).toBe('cloudflare-upstream');
    expect(upstreamFetch).toHaveBeenCalledOnce();
    const forwarded = upstreamFetch.mock.calls[0][0];
    expect(forwarded.url).toBe('https://dyrakarmy.eu/api/health?full=1');
    expect(forwarded.headers.get('Origin')).toBe('https://dyrakarmy.eu');
    expect(forwarded.headers.get('X-DyrakArmy-HF-Mirror')).toBe('1');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not fall back to split local state when the upstream fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('upstream unavailable');
    }));
    const env = {
      HF_BACKEND_MODE: 'cloudflare-mirror',
      HF_MIRROR_FALLBACK_LOCAL: '0',
    } as never;
    const response = await handler.fetch(
      new Request('https://space.example/api/health'),
      env,
      context,
    );
    const payload = await response.json() as { error?: { code?: string } };
    expect(response.status).toBe(502);
    expect(payload.error?.code).toBe('HF_MIRROR_UPSTREAM_UNAVAILABLE');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('supports an explicit standalone mode for the final cutover', async () => {
    const env = { HF_BACKEND_MODE: 'standalone' } as never;
    const response = await handler.fetch(
      new Request('https://space.example/api/health'),
      env,
      context,
    );
    expect(await response.text()).toBe('local-runtime');
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});
