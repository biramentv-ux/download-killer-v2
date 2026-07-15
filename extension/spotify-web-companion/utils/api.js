import { normalizeBackendJob, normalizeBackendUrl } from "./validators.js";

export class BackendApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "BackendApiError";
    this.status = Number(options.status || 0);
    this.code = String(options.code || "BACKEND_ERROR");
    this.retryable = options.retryable !== false;
    this.retryAfterMs = Number(options.retryAfterMs || 0);
  }
}

function retryAfterMs(response) {
  const raw = response.headers.get("Retry-After") || "";
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return response.status === 429 ? 15000 : 0;
}

async function apiJson(backendUrl, path, init = {}, timeoutMs = 25000) {
  const base = normalizeBackendUrl(backendUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${base}/api${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || payload?.detail || `HTTP ${response.status}`;
      throw new BackendApiError(message, {
        status: response.status,
        code: payload?.error?.code || `HTTP_${response.status}`,
        retryable: payload?.error?.retryable ?? response.status >= 429,
        retryAfterMs: retryAfterMs(response)
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof BackendApiError) throw error;
    if (error?.name === "AbortError") {
      throw new BackendApiError("Backend request timed out", {
        code: "TIMEOUT",
        retryable: true,
        retryAfterMs: 10000
      });
    }
    throw new BackendApiError(error?.message || String(error), {
      code: "NETWORK_ERROR",
      retryable: true,
      retryAfterMs: 10000
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function submitDownload(backendUrl, task) {
  const payload = await apiJson(backendUrl, "/download", {
    method: "POST",
    body: JSON.stringify({
      url: task.url,
      source: "spotify",
      format: task.format,
      quality: task.quality,
      client_id: "spotify-web-companion-v1.2",
      added_by: "chrome-extension"
    })
  });

  const job = normalizeBackendJob(payload, task);
  if (!job.id) throw new BackendApiError("Backend response did not include a job id", { retryable: false });
  return job;
}

export async function readJob(backendUrl, jobId, fallback = {}) {
  const payload = await apiJson(backendUrl, `/job/${encodeURIComponent(jobId)}`, {}, 15000);
  return normalizeBackendJob(payload, fallback);
}

export async function cancelJob(backendUrl, jobId) {
  try {
    await apiJson(backendUrl, `/job/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      body: "{}"
    }, 12000);
    return true;
  } catch {
    return false;
  }
}

export async function previewMetadata(backendUrl, url) {
  const payload = await apiJson(backendUrl, "/preview", {
    method: "POST",
    body: JSON.stringify({ query: url, url, source: "spotify" })
  }, 20000);

  return {
    title: String(payload.title || payload.track || ""),
    artist: String(payload.artist || payload.uploader || ""),
    album: String(payload.album || ""),
    duration: Number(payload.duration || 0),
    thumbnail: String(payload.thumbnail || payload.cover_url || ""),
    source: String(payload.source || "spotify")
  };
}

export async function resolvePlaylist(backendUrl, url) {
  const payload = await apiJson(backendUrl, "/playlist/resolve", {
    method: "POST",
    body: JSON.stringify({ url, source: "spotify" })
  }, 30000);

  return {
    title: String(payload.title || "Spotify playlist"),
    tracks: Array.isArray(payload.tracks) ? payload.tracks : []
  };
}
