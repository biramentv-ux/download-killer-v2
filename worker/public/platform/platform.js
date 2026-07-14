(() => {
  "use strict";

  const API_BASE = "/api";
  const jobs = new Map();
  const streams = new Map();
  let currentLang = localStorage.getItem("da_platform_lang") === "en" ? "en" : "bg";

  const I18N = {
    bg: {
      nav_console: "Конзола", nav_engines: "Двигатели", nav_architecture: "Архитектура", nav_access: "Достъп",
      checking: "Проверка", online: "ONLINE", offline: "OFFLINE", open_classic: "Класическо приложение",
      hero_eyebrow: "ЕДНА ПЛАТФОРМА · МНОГО ДВИГАТЕЛИ", hero_line_1: "Медийният workflow,", hero_line_2: "сглобен като система.",
      hero_text: "Web, desktop, browser extension, Telegram, опашки, история и автоматичен fallback върху един общ backend.",
      start_now: "Стартирай задача", download_apps: "Изтегли приложенията", live_progress: "Live прогрес",
      metric_formats: "формата", metric_sources: "източника", metric_updates: "live статус", metric_language: "двуезичен UI", metric_edge: "edge достъп",
      console_title: "Публична web конзола", console_text: "Подай публичен URL, избери формат и следи задачата в реално време. Backend-ът валидира, поставя в опашка и обработва през наличния origin.",
      url_label: "Публичен URL", paste: "Постави", source_label: "Източник", format_label: "Формат", quality_label: "Качество",
      usage_note: "Използвай платформата само за съдържание, което имаш право да изтеглиш или обработиш.", launch: "Добави в опашката",
      activity_title: "Активност", clear: "Изчисти", empty_jobs: "Няма активни задачи", empty_jobs_text: "Първата заявка ще се появи тук с live прогрес.",
      engines_title: "Модулна система от двигатели", engines_text: "Публичният web слой остава стабилен, докато двигателите могат да се обновяват, заменят или изолират независимо.",
      engine_edge: "REST API, D1, KV, Queues, SSE и tokenized файлове.", engine_downloader: "Изолирано обработване с yt-dlp, FFmpeg и source fallback.",
      engine_dotify: "Планиран локален plugin за desktop workflow и пакетни задачи.", engine_node: "Отделен Node worker с JSON bridge към desktop приложението.",
      engine_spotdl: "Metadata matching и външен audio fallback за устойчиви задачи.", engine_oggmp4: "Самостоятелен BG/EN GUI launcher за външно конфигуриран двигател.",
      public_core: "Публично ядро", remote_origin: "Remote origin", desktop_plugin: "Desktop plugin", optional_engine: "Опционален", fallback_engine: "Fallback", isolated_engine: "Изолиран процес",
      architecture_title: "Архитектура без магически кутии", status_title: "Системен статус", refresh: "Обнови", status_edge: "Edge API", status_origin: "Downloader origin", status_formats: "Формати", status_latency: "Латентност",
      recent_jobs: "Последни публични задачи", full_history: "Пълна история ↗", access_title: "Избери интерфейса. Системата остава същата.",
      access_text: "Web за бърз достъп, desktop за локално записване, extension за задачи от браузъра и Telegram за мобилен workflow.", access_web: "Пълна конзола",
      footer_text: "Модулна media workflow платформа, изградена върху edge инфраструктура.", open_app: "Отвори приложението",
      invalid_url: "Въведи валиден публичен HTTP/HTTPS URL.", queued: "Задачата е добавена в опашката.", request_failed: "Заявката не беше приета.", copied: "URL адресът е поставен.", clipboard_failed: "Няма достъп до клипборда.",
      download: "Изтегли", processing: "обработва се", done: "готово", failed: "грешка", paused: "пауза", waiting: "изчакване", no_history: "Няма публична история.", formats_ready: "налични", origin_ready: "конфигуриран"
    },
    en: {
      nav_console: "Console", nav_engines: "Engines", nav_architecture: "Architecture", nav_access: "Access",
      checking: "Checking", online: "ONLINE", offline: "OFFLINE", open_classic: "Classic application",
      hero_eyebrow: "ONE PLATFORM · MULTIPLE ENGINES", hero_line_1: "The media workflow,", hero_line_2: "assembled as a system.",
      hero_text: "Web, desktop, browser extension, Telegram, queues, history and automatic fallback on one shared backend.",
      start_now: "Launch a job", download_apps: "Download applications", live_progress: "Live progress",
      metric_formats: "formats", metric_sources: "sources", metric_updates: "live status", metric_language: "bilingual UI", metric_edge: "edge access",
      console_title: "Public web console", console_text: "Submit a public URL, choose a format and follow the job in real time. The backend validates, queues and processes it through an available origin.",
      url_label: "Public URL", paste: "Paste", source_label: "Source", format_label: "Format", quality_label: "Quality",
      usage_note: "Use the platform only for content you are authorized to download or process.", launch: "Add to queue",
      activity_title: "Activity", clear: "Clear", empty_jobs: "No active jobs", empty_jobs_text: "The first request will appear here with live progress.",
      engines_title: "Modular engine fabric", engines_text: "The public web layer remains stable while engines can be updated, replaced or isolated independently.",
      engine_edge: "REST API, D1, KV, Queues, SSE and tokenized files.", engine_downloader: "Isolated processing with yt-dlp, FFmpeg and source fallback.",
      engine_dotify: "Planned local plugin for desktop workflows and batch jobs.", engine_node: "Separate Node worker with a JSON bridge to the desktop application.",
      engine_spotdl: "Metadata matching and external audio fallback for resilient jobs.", engine_oggmp4: "Standalone BG/EN GUI launcher for a separately configured external engine.",
      public_core: "Public core", remote_origin: "Remote origin", desktop_plugin: "Desktop plugin", optional_engine: "Optional", fallback_engine: "Fallback", isolated_engine: "Isolated process",
      architecture_title: "Architecture without magic boxes", status_title: "System status", refresh: "Refresh", status_edge: "Edge API", status_origin: "Downloader origin", status_formats: "Formats", status_latency: "Latency",
      recent_jobs: "Recent public jobs", full_history: "Full history ↗", access_title: "Choose the surface. The system remains the same.",
      access_text: "Web for instant access, desktop for local saves, extensions for browser workflows and Telegram for mobile operation.", access_web: "Full console",
      footer_text: "A modular media workflow platform built on edge infrastructure.", open_app: "Open application",
      invalid_url: "Enter a valid public HTTP/HTTPS URL.", queued: "The job was added to the queue.", request_failed: "The request was not accepted.", copied: "URL pasted from the clipboard.", clipboard_failed: "Clipboard access is unavailable.",
      download: "Download", processing: "processing", done: "done", failed: "failed", paused: "paused", waiting: "waiting", no_history: "No public history is available.", formats_ready: "available", origin_ready: "configured"
    }
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const t = (key) => (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  function applyLanguage() {
    document.documentElement.lang = currentLang;
    localStorage.setItem("da_platform_lang", currentLang);
    $("#languageBtn").textContent = currentLang.toUpperCase();
    $$('[data-i18n]').forEach((node) => {
      const value = t(node.dataset.i18n);
      if (value) node.textContent = value;
    });
    renderJobs();
  }

  function toast(message, type = "info") {
    const region = $("#toastRegion");
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = message;
    region.appendChild(node);
    window.setTimeout(() => node.remove(), 4300);
  }

  function normalizeError(payload, fallback) {
    if (payload && payload.error && payload.error.message) return String(payload.error.message);
    if (payload && payload.detail) return String(payload.detail);
    return fallback;
  }

  async function apiJson(path, init = {}, timeoutMs = 25000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(normalizeError(payload, `HTTP ${response.status}`));
      return payload;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function isPublicHttpUrl(value) {
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      const host = parsed.hostname.toLowerCase();
      if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.onion')) return false;
      return true;
    } catch {
      return false;
    }
  }

  function detectSource(url) {
    const value = String(url || "").toLowerCase();
    if (value.includes("spotify.com") || value.includes("spotify.link")) return value.includes("/show/") || value.includes("/episode/") ? "podcast" : "spotify";
    if (value.includes("youtube.com") || value.includes("youtu.be")) return "youtube";
    if (value.includes("soundcloud.com")) return "soundcloud";
    if (value.includes("deezer.com")) return "deezer";
    if (value.includes("music.apple.com") || value.includes("itunes.apple.com")) return "apple";
    if (value.includes("podcasts.apple.com") || value.endsWith(".xml") || value.includes("/feed") || value.includes("rss")) return "podcast";
    return "all";
  }

  function statusLabel(status) {
    const value = String(status || "waiting").toLowerCase();
    if (value === "done") return t("done");
    if (value === "failed") return t("failed");
    if (value === "processing") return t("processing");
    if (value === "paused") return t("paused");
    if (value === "queued") return t("queued");
    return t("waiting");
  }

  function progressFor(status) {
    const value = String(status || "queued").toLowerCase();
    if (value === "done") return 100;
    if (value === "failed") return 100;
    if (value === "processing") return 58;
    if (value === "paused") return 35;
    return 12;
  }

  function readJobPayload(payload, fallback = {}) {
    const row = payload && payload.job ? payload.job : (payload || {});
    return {
      ...fallback,
      id: String(row.id || row.jobId || row.job_id || fallback.id || ""),
      status: String(row.status || fallback.status || "queued").toLowerCase(),
      title: String(row.title || row.track || fallback.title || "Media job"),
      artist: String(row.artist || row.uploader || fallback.artist || "DyrakArmy"),
      format: String(row.format || fallback.format || "mp3"),
      quality: String(row.quality || fallback.quality || "best"),
      source: String(row.source || fallback.source || "all"),
      downloadUrl: String(row.download_url || row.downloadUrl || fallback.downloadUrl || ""),
      streamUrl: String(row.stream_url || row.streamUrl || fallback.streamUrl || ""),
      error: String(row.error_message || row.error || fallback.error || ""),
      updatedAt: Date.now(),
    };
  }

  function renderJobs() {
    const feed = $("#jobFeed");
    const items = Array.from(jobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (!items.length) {
      feed.innerHTML = `
        <div class="empty-state" id="jobEmpty">
          <div class="radar"><i></i><i></i><i></i></div>
          <strong>${escapeHtml(t("empty_jobs"))}</strong>
          <span>${escapeHtml(t("empty_jobs_text"))}</span>
        </div>`;
      return;
    }
    feed.innerHTML = items.map((job) => {
      const status = String(job.status || "queued").toLowerCase();
      const action = status === "done" && job.downloadUrl
        ? `<a href="${escapeHtml(job.downloadUrl)}" target="_blank" rel="noreferrer">${escapeHtml(t("download"))}</a>`
        : "";
      const error = job.error ? `<p>${escapeHtml(job.error)}</p>` : "";
      return `<article class="job-card ${escapeHtml(status)}" style="--progress:${progressFor(status)}%">
        <div class="job-status">${status === "done" ? "✓" : status === "failed" ? "!" : "↻"}</div>
        <div>
          <h4>${escapeHtml(job.artist)} · ${escapeHtml(job.title)}</h4>
          <p>#${escapeHtml(job.id.slice(0, 10))} · ${escapeHtml(job.format.toUpperCase())} ${escapeHtml(job.quality)} · ${escapeHtml(statusLabel(status))}</p>
          ${error}
        </div>
        <div class="job-actions">${action}</div>
      </article>`;
    }).join("");
  }

  function closeStream(jobId) {
    const source = streams.get(jobId);
    if (source) source.close();
    streams.delete(jobId);
  }

  async function pollJob(jobId, attempts = 0) {
    if (!jobs.has(jobId) || attempts > 80) return;
    try {
      const payload = await apiJson(`/job/${encodeURIComponent(jobId)}`, {}, 12000);
      const next = readJobPayload(payload, jobs.get(jobId));
      jobs.set(jobId, next);
      renderJobs();
      if (["done", "failed"].includes(next.status)) {
        closeStream(jobId);
        return;
      }
    } catch {
      // SSE may still be active; polling is only the resilient fallback.
    }
    window.setTimeout(() => void pollJob(jobId, attempts + 1), 3500);
  }

  function subscribeJob(jobId) {
    if (!("EventSource" in window)) {
      void pollJob(jobId);
      return;
    }
    closeStream(jobId);
    const source = new EventSource(`${API_BASE}/job/${encodeURIComponent(jobId)}/events`);
    streams.set(jobId, source);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const next = readJobPayload(payload, jobs.get(jobId));
        jobs.set(jobId, next);
        renderJobs();
        if (["done", "failed"].includes(next.status)) closeStream(jobId);
      } catch {
        // Ignore malformed heartbeat events.
      }
    };
    source.onerror = () => {
      closeStream(jobId);
      void pollJob(jobId);
    };
  }

  async function submitDownload(event) {
    event.preventDefault();
    const input = $("#mediaUrl");
    const url = input.value.trim();
    if (!isPublicHttpUrl(url)) {
      toast(t("invalid_url"), "error");
      input.focus();
      return;
    }
    const button = $("#launchBtn");
    button.disabled = true;
    const sourceSelect = $("#sourceSelect");
    if (sourceSelect.value === "all") sourceSelect.value = detectSource(url);
    const body = {
      url,
      source: sourceSelect.value || "all",
      format: $("#formatSelect").value || "mp3",
      quality: $("#qualitySelect").value || "best",
      client_id: "platform-v9",
      added_by: "platform-portal",
    };
    try {
      const payload = await apiJson("/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const jobId = String(payload.jobId || payload.job_id || payload.id || "");
      if (!jobId) throw new Error("Backend response did not include a job id");
      jobs.set(jobId, {
        id: jobId,
        status: String(payload.status || "queued").toLowerCase(),
        title: url,
        artist: body.source.toUpperCase(),
        format: body.format,
        quality: body.quality,
        source: body.source,
        downloadUrl: "",
        streamUrl: "",
        error: "",
        createdAt: Date.now(),
      });
      renderJobs();
      subscribeJob(jobId);
      toast(t("queued"), "success");
      input.value = "";
    } catch (error) {
      toast(`${t("request_failed")} ${error.message || error}`, "error");
    } finally {
      button.disabled = false;
    }
  }

  function updateHealthChip(state) {
    const chip = $("#globalHealth");
    chip.dataset.state = state;
    $("b", chip).textContent = t(state === "online" ? "online" : state === "offline" ? "offline" : "checking");
  }

  function setStatus(selector, value, state = "") {
    const node = $(selector);
    node.textContent = value;
    node.classList.remove("online", "offline");
    if (state) node.classList.add(state);
  }

  async function loadSystemStatus() {
    updateHealthChip("checking");
    const started = performance.now();
    let healthOk = false;
    try {
      const health = await apiJson("/health", {}, 12000);
      healthOk = Boolean(health && (health.ok === true || health.status === "ok" || health.status === "healthy"));
      setStatus("#edgeStatus", healthOk ? t("online") : t("offline"), healthOk ? "online" : "offline");
      $("#edgeDetail").textContent = String(health.service || health.version || "Cloudflare Worker");
    } catch (error) {
      setStatus("#edgeStatus", t("offline"), "offline");
      $("#edgeDetail").textContent = String(error.message || error).slice(0, 80);
    }
    const latency = Math.max(1, Math.round(performance.now() - started));
    $("#latencyStatus").textContent = `${latency} ms`;

    try {
      const config = await apiJson("/runtime-config", {}, 12000);
      const origin = config.downloader_api_url || config.downloaderApiUrl || config.api_base || config.public_base || "configured";
      setStatus("#originStatus", t("online"), "online");
      $("#originDetail").textContent = String(origin).replace(/^https?:\/\//, "").slice(0, 52);
    } catch (error) {
      setStatus("#originStatus", t("offline"), "offline");
      $("#originDetail").textContent = String(error.message || error).slice(0, 80);
    }

    try {
      const payload = await apiJson("/formats", {}, 12000);
      const list = Array.isArray(payload) ? payload : (payload.formats || payload.items || []);
      const count = Array.isArray(list) && list.length ? list.length : 6;
      setStatus("#formatStatus", String(count), "online");
      $("#formatDetail").textContent = t("formats_ready");
    } catch {
      setStatus("#formatStatus", "6", "online");
      $("#formatDetail").textContent = "MP3 · M4A · OGG · OPUS · FLAC · WAV";
    }
    updateHealthChip(healthOk ? "online" : "offline");
  }

  function normalizeHistory(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.jobs)) return payload.jobs;
    if (payload && Array.isArray(payload.items)) return payload.items;
    if (payload && Array.isArray(payload.results)) return payload.results;
    if (payload && Array.isArray(payload.history)) return payload.history;
    return [];
  }

  async function loadHistory() {
    const list = $("#historyList");
    try {
      const payload = await apiJson("/history?limit=6&offset=0", {}, 12000);
      const rows = normalizeHistory(payload).slice(0, 6);
      if (!rows.length) {
        list.innerHTML = `<div class="history-row"><i></i><b>${escapeHtml(t("no_history"))}</b><span>—</span><time>—</time></div>`;
        return;
      }
      list.innerHTML = rows.map((row) => {
        const status = String(row.status || "queued").toLowerCase();
        const title = row.title || row.url || row.id || "Media job";
        const format = String(row.format || "").toUpperCase();
        const created = row.created_at || row.createdAt || row.updated_at || row.updatedAt;
        const time = created ? new Date(created).toLocaleString(currentLang === "bg" ? "bg-BG" : "en-GB", { dateStyle: "short", timeStyle: "short" }) : "—";
        return `<div class="history-row"><i class="${escapeHtml(status)}"></i><b>${escapeHtml(title)}</b><span>${escapeHtml(format)} · ${escapeHtml(statusLabel(status))}</span><time>${escapeHtml(time)}</time></div>`;
      }).join("");
    } catch (error) {
      list.innerHTML = `<div class="history-row"><i class="failed"></i><b>${escapeHtml(t("no_history"))}</b><span>${escapeHtml(String(error.message || error).slice(0, 60))}</span><time>—</time></div>`;
    }
  }

  function setupReveal() {
    if (!("IntersectionObserver" in window)) {
      $$(".reveal").forEach((node) => node.classList.add("visible"));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    $$(".reveal").forEach((node) => observer.observe(node));
  }

  function animateMetrics() {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    $$('[data-count]').forEach((node) => {
      const target = Number(node.dataset.count || 0);
      if (reduced) {
        node.textContent = String(target);
        return;
      }
      const started = performance.now();
      const tick = (now) => {
        const progress = Math.min(1, (now - started) / 950);
        node.textContent = String(Math.round(target * (1 - Math.pow(1 - progress, 3))));
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  function setupCanvas() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = $("#signalCanvas");
    const context = canvas.getContext("2d", { alpha: true });
    const points = [];
    let width = 0;
    let height = 0;
    let dpr = 1;
    let mouseX = -1000;
    let mouseY = -1000;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      points.length = 0;
      const count = Math.min(90, Math.max(30, Math.floor((width * height) / 19000)));
      for (let index = 0; index < count; index += 1) {
        points.push({ x: Math.random() * width, y: Math.random() * height, vx: (Math.random() - .5) * .18, vy: (Math.random() - .5) * .18, r: Math.random() * 1.5 + .4 });
      }
    };
    window.addEventListener("resize", resize, { passive: true });
    window.addEventListener("pointermove", (event) => { mouseX = event.clientX; mouseY = event.clientY; }, { passive: true });
    resize();

    const frame = () => {
      context.clearRect(0, 0, width, height);
      points.forEach((point, index) => {
        point.x += point.vx;
        point.y += point.vy;
        if (point.x < -10) point.x = width + 10;
        if (point.x > width + 10) point.x = -10;
        if (point.y < -10) point.y = height + 10;
        if (point.y > height + 10) point.y = -10;
        const mouseDistance = Math.hypot(point.x - mouseX, point.y - mouseY);
        if (mouseDistance < 130 && mouseDistance > .01) {
          point.x += (point.x - mouseX) / mouseDistance * .35;
          point.y += (point.y - mouseY) / mouseDistance * .35;
        }
        context.beginPath();
        context.fillStyle = index % 4 === 0 ? "rgba(201,255,75,.52)" : "rgba(126,151,255,.32)";
        context.arc(point.x, point.y, point.r, 0, Math.PI * 2);
        context.fill();
        for (let nextIndex = index + 1; nextIndex < points.length; nextIndex += 1) {
          const other = points[nextIndex];
          const distance = Math.hypot(point.x - other.x, point.y - other.y);
          if (distance < 105) {
            context.beginPath();
            context.strokeStyle = `rgba(120,145,230,${(1 - distance / 105) * .09})`;
            context.moveTo(point.x, point.y);
            context.lineTo(other.x, other.y);
            context.stroke();
          }
        }
      });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  function setupMagneticButtons() {
    if (window.matchMedia("(pointer: coarse)").matches) return;
    $$(".magnetic").forEach((node) => {
      node.addEventListener("pointermove", (event) => {
        const rect = node.getBoundingClientRect();
        const x = (event.clientX - rect.left - rect.width / 2) * .09;
        const y = (event.clientY - rect.top - rect.height / 2) * .13;
        node.style.transform = `translate(${x}px, ${y - 3}px)`;
      });
      node.addEventListener("pointerleave", () => { node.style.transform = ""; });
    });
  }

  function bindEvents() {
    $("#languageBtn").addEventListener("click", () => {
      currentLang = currentLang === "bg" ? "en" : "bg";
      applyLanguage();
      void loadHistory();
      void loadSystemStatus();
    });
    $("#downloadForm").addEventListener("submit", submitDownload);
    $("#mediaUrl").addEventListener("input", (event) => {
      if ($("#sourceSelect").value === "all") {
        const source = detectSource(event.target.value);
        if (source !== "all") $("#sourceSelect").value = source;
      }
    });
    $("#formatSelect").addEventListener("change", (event) => {
      const lossless = ["flac", "wav"].includes(event.target.value);
      const quality = $("#qualitySelect");
      if (lossless) {
        if (!["best", "lossless"].includes(quality.value)) quality.value = "best";
      } else if (quality.value === "lossless") {
        quality.value = "best";
      }
    });
    $("#pasteBtn").addEventListener("click", async () => {
      try {
        const value = await navigator.clipboard.readText();
        $("#mediaUrl").value = value.trim();
        const source = detectSource(value);
        if (source !== "all") $("#sourceSelect").value = source;
        toast(t("copied"), "success");
      } catch {
        toast(t("clipboard_failed"), "error");
      }
    });
    $("#clearJobsBtn").addEventListener("click", () => {
      jobs.forEach((_, id) => closeStream(id));
      jobs.clear();
      renderJobs();
    });
    $("#refreshStatusBtn").addEventListener("click", () => {
      void loadSystemStatus();
      void loadHistory();
    });
  }

  async function init() {
    $("#year").textContent = String(new Date().getFullYear());
    applyLanguage();
    bindEvents();
    setupReveal();
    animateMetrics();
    setupCanvas();
    setupMagneticButtons();
    renderJobs();
    await Promise.allSettled([loadSystemStatus(), loadHistory()]);
  }

  window.addEventListener("beforeunload", () => streams.forEach((source) => source.close()));
  document.addEventListener("DOMContentLoaded", () => void init());
})();
