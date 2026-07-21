export const ALLOWED_BACKENDS = Object.freeze([
  "https://dyrakarmy.eu",
  "https://www.dyrakarmy.eu",
  "https://dyrakarmy.online",
  "https://www.dyrakarmy.online",
  "https://sounddrop.biramentv.workers.dev"
]);

export const DEFAULT_BACKEND = ALLOWED_BACKENDS[0];
export const SUPPORTED_FORMATS = Object.freeze(["mp3", "m4a", "ogg", "opus", "flac", "wav"]);
export const SUPPORTED_QUALITIES = Object.freeze(["best", "320", "256", "192", "128", "96", "lossless"]);

export function normalizeBackendUrl(value) {
  const candidate = String(value || "").trim().replace(/\/+$/, "");
  return ALLOWED_BACKENDS.includes(candidate) ? candidate : DEFAULT_BACKEND;
}

export function spotifyTrackId(value) {
  const raw = String(value || "").trim();
  const uriMatch = raw.match(/^spotify:track:([A-Za-z0-9]+)$/);
  if (uriMatch) return uriMatch[1];

  try {
    const url = new URL(raw, "https://open.spotify.com");
    if (url.hostname !== "open.spotify.com") return "";
    const match = url.pathname.match(/^\/(?:intl-[^/]+\/)?track\/([A-Za-z0-9]+)/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

export function spotifyTrackUrl(value) {
  const id = spotifyTrackId(value);
  return id ? `https://open.spotify.com/track/${id}` : "";
}

export function isSpotifyTrackUrl(value) {
  return Boolean(spotifyTrackId(value));
}

export function isSpotifyPlaylistUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.hostname === "open.spotify.com" &&
      /^\/(?:intl-[^/]+\/)?playlist\/[A-Za-z0-9]+/.test(url.pathname);
  } catch {
    return false;
  }
}

export function safeFilename(value, extension = "") {
  const base = String(value || "Download Killer")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 160) || "Download Killer";
  const ext = String(extension || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return ext && !base.toLowerCase().endsWith(`.${ext}`) ? `${base}.${ext}` : base;
}

export function normalizeSettings(input = {}) {
  const format = SUPPORTED_FORMATS.includes(input.format) ? input.format : "mp3";
  let quality = SUPPORTED_QUALITIES.includes(input.quality) ? input.quality : "320";

  if (["flac", "wav"].includes(format) && !["best", "lossless"].includes(quality)) {
    quality = "best";
  } else if (!["flac", "wav"].includes(format) && quality === "lossless") {
    quality = "best";
  }

  return {
    backendUrl: normalizeBackendUrl(input.backendUrl),
    format,
    quality,
    autoDownload: input.autoDownload === true,
    saveAs: input.saveAs === true
  };
}

export function normalizeBackendJob(payload, fallback = {}) {
  const row = payload?.job || payload || {};
  return {
    id: String(row.id || row.jobId || row.job_id || fallback.id || ""),
    status: String(row.status || fallback.status || "queued").toLowerCase(),
    title: String(row.title || row.track || fallback.title || "Media job"),
    artist: String(row.artist || row.uploader || fallback.artist || "Download Killer"),
    format: String(row.format || fallback.format || "mp3").toLowerCase(),
    quality: String(row.quality || fallback.quality || "best"),
    source: String(row.source || fallback.source || "spotify"),
    downloadUrl: String(
      row.download_url || row.downloadUrl || row.result_url || row.resultUrl ||
      fallback.downloadUrl || ""
    ),
    filename: String(row.filename || fallback.filename || ""),
    error: String(row.error_message || row.error || fallback.error || "")
  };
}
