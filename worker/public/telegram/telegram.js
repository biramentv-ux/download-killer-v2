(() => {
  "use strict";

  const API_BASE = "/api";
  const TELEGRAM_API = `${API_BASE}/telegram/v10`;
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const initData = tg && typeof tg.initData === "string" ? tg.initData : "";
  const jobs = new Map();
  const streams = new Map();
  let config = null;
  let profile = null;
  let searchResults = [];
  let currentLanguage = localStorage.getItem("dk_tg_lang") === "en" ? "en" : "bg";

  const I18N = {
    bg: {
      checking: "Проверка", online: "ONLINE", offline: "OFFLINE", guest: "Гост",
      hero_a: "Търси.", hero_b: "Избери качество.", hero_c: "Получи файла в чата.",
      hero_text: "Една обща система за сайта и @dyrakarmy_bot. Готовите файлове се индексират в Telegram канал и при повторна заявка се използват без ново качване.",
      active_jobs: "активни задачи", history_jobs: "в историята", stored_files: "Telegram файла", storage_size: "архивен размер",
      tab_download: "Сваляне", tab_search: "Търсене", tab_queue: "Опашка", tab_history: "История", tab_archive: "Архив",
      download_title: "Свали от публичен URL", download_text: "Постави линк, избери формат и качество. След приключване ботът ще изпрати файла директно в този Telegram чат.",
      url_label: "Публичен URL", paste: "Постави", source: "Източник", format: "Формат", quality: "Качество",
      legal: "Използвай само съдържание, което имаш право да изтеглиш или обработиш.", queue_action: "Добави в опашката",
      live_activity: "Live активност", clear: "Изчисти", no_live: "Няма активна задача", no_live_text: "Следващата задача ще се появи тук.",
      search_title: "Търсене по име", search_text: "Намери песен, избери резултат и го изпрати към общата опашка.", search_button: "Търси", search_empty: "Въведи име на песен или изпълнител.",
      queue_title: "Активна опашка", history_title: "История на задачите", refresh: "Обнови", archive_title: "Telegram файлов архив",
      archive_files: "Файлове", archive_unique: "Уникални", archive_bytes: "Общ размер", archive_mode: "Режим",
      archive_text: "Първото успешно сваляне се публикува в частен Telegram канал. Следващите потребители получават копие на същия Telegram файл, без ново качване.",
      outside_title: "Отвори в Telegram", outside_text: "За персонална опашка и директно изпращане на файлове стартирай Mini App през бота.", open_bot: "Отвори @dyrakarmy_bot",
      auth_required: "Отвори страницата през Telegram бота, за да използваш персоналната опашка.", invalid_url: "Въведи валиден публичен HTTP/HTTPS URL.",
      queued: "Задачата е добавена. Ботът ще изпрати файла след обработката.", request_failed: "Заявката не беше приета.", clipboard_failed: "Няма достъп до клипборда.",
      search_failed: "Търсенето не успя.", no_results: "Няма намерени резултати.", add: "Добави", send_chat: "Изпрати в чата", open_file: "Отвори файла",
      processing: "обработва се", queued_status: "в опашка", done: "готово", failed: "грешка", paused: "пауза", waiting: "изчакване",
      queue_empty: "Нямаш активни задачи.", history_empty: "Няма запазена история.", sent_chat: "Файлът беше изпратен към Telegram чата.",
      profile_failed: "Telegram профилът не можа да бъде зареден.", handoff_failed: "Файлът от линка не можа да бъде изпратен.",
    },
    en: {
      checking: "Checking", online: "ONLINE", offline: "OFFLINE", guest: "Guest",
      hero_a: "Search.", hero_b: "Choose quality.", hero_c: "Receive it in chat.",
      hero_text: "One shared system for the website and @dyrakarmy_bot. Completed files are indexed in a Telegram channel and reused without reuploading.",
      active_jobs: "active jobs", history_jobs: "history jobs", stored_files: "Telegram files", storage_size: "archive size",
      tab_download: "Download", tab_search: "Search", tab_queue: "Queue", tab_history: "History", tab_archive: "Archive",
      download_title: "Download from a public URL", download_text: "Paste a link, choose format and quality. The bot will deliver the file to this Telegram chat after processing.",
      url_label: "Public URL", paste: "Paste", source: "Source", format: "Format", quality: "Quality",
      legal: "Use only content you are authorized to download or process.", queue_action: "Add to queue",
      live_activity: "Live activity", clear: "Clear", no_live: "No active job", no_live_text: "The next job will appear here.",
      search_title: "Search by name", search_text: "Find a track, choose a result and add it to the shared queue.", search_button: "Search", search_empty: "Enter a track or artist name.",
      queue_title: "Active queue", history_title: "Job history", refresh: "Refresh", archive_title: "Telegram file archive",
      archive_files: "Files", archive_unique: "Unique", archive_bytes: "Total size", archive_mode: "Mode",
      archive_text: "The first successful download is published to a private Telegram channel. Later users receive a copy of the same Telegram file without a new upload.",
      outside_title: "Open in Telegram", outside_text: "Launch the Mini App from the bot for a personal queue and direct file delivery.", open_bot: "Open @dyrakarmy_bot",
      auth_required: "Open this page through the Telegram bot to use the personal queue.", invalid_url: "Enter a valid public HTTP/HTTPS URL.",
      queued: "The job was queued. The bot will deliver the file after processing.", request_failed: "The request was not accepted.", clipboard_failed: "Clipboard access is unavailable.",
      search_failed: "Search failed.", no_results: "No results found.", add: "Add", send_chat: "Send to chat", open_file: "Open file",
      processing: "processing", queued_status: "queued", done: "done", failed: "failed", paused: "paused", waiting: "waiting",
      queue_empty: "You have no active jobs.", history_empty: "No history is available.", sent_chat: "The file was sent to the Telegram chat.",
      profile_failed: "The Telegram profile could not be loaded.", handoff_failed: "The linked file could not be delivered.",
    },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const t = (key) => I18N[currentLanguage][key] || I18N.bg[key] || key;
  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  function applyLanguage() {
    document.documentElement.lang = currentLanguage;
    localStorage.setItem("dk_tg_lang", currentLanguage);
    $("#languageBtn").textContent = currentLanguage.toUpperCase();
    $$('[data-i18n]').forEach((node) => {
      const value = t(node.dataset.i18n);
      if (value) node.textContent = value;
    });
    renderLiveJobs();
    renderProfileLists();
  }

  function toast(message, type = "success") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = message;
    $("#toastRegion").appendChild(node);
    window.setTimeout(() => node.remove(), 4200);
    if (tg && typeof tg.HapticFeedback?.notificationOccurred === "function") {
      tg.HapticFeedback.notificationOccurred(type === "error" ? "error" : "success");
    }
  }

  async function apiJson(path, init = {}, timeoutMs = 25000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = payload?.error?.message || payload?.detail || `HTTP ${response.status}`;
        throw new Error(message);
      }
      return payload;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function isPublicUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (!["http:", "https:"].includes(url.protocol)) return false;
      const host = url.hostname.toLowerCase();
      return Boolean(host && host !== "localhost" && !host.endsWith(".local") && !host.endsWith(".onion"));
    } catch {
      return false;
    }
  }

  function detectSource(value) {
    const url = String(value || "").toLowerCase();
    if (url.includes("spotify.com") || url.includes("spotify.link")) return url.includes("/show/") || url.includes("/episode/") ? "podcast" : "spotify";
    if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
    if (url.includes("soundcloud.com")) return "soundcloud";
    if (url.includes("deezer.com")) return "deezer";
    if (url.includes("music.apple.com") || url.includes("itunes.apple.com")) return "apple";
    if (url.includes("podcasts.apple.com") || url.includes("/feed") || url.endsWith(".xml")) return "podcast";
    return "all";
  }

  function normalizeStatus(value) {
    return String(value || "queued").toLowerCase();
  }

  function statusText(value) {
    const status = normalizeStatus(value);
    if (status === "done") return t("done");
    if (status === "failed") return t("failed");
    if (status === "processing") return t("processing");
    if (status === "paused") return t("paused");
    if (status === "queued") return t("queued_status");
    return t("waiting");
  }

  function progressFor(value) {
    const status = normalizeStatus(value);
    if (status === "done" || status === "failed") return 100;
    if (status === "processing") return 62;
    if (status === "paused") return 35;
    return 12;
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value || 0));
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function normalizeJob(payload, fallback = {}) {
    const row = payload?.job || payload || {};
    return {
      ...fallback,
      id: String(row.id || row.jobId || row.job_id || fallback.id || ""),
      url: String(row.url || fallback.url || ""),
      title: String(row.title || fallback.title || "Media job"),
      artist: String(row.artist || fallback.artist || "Download Killer"),
      source: String(row.source || fallback.source || "all"),
      format: String(row.format || fallback.format || "mp3"),
      quality: String(row.quality || fallback.quality || "320"),
      status: normalizeStatus(row.status || fallback.status),
      downloadUrl: String(row.download_url || row.downloadUrl || row.result_url || fallback.downloadUrl || ""),
      error: String(row.error_message || row.error || fallback.error || ""),
      fileSize: Number(row.file_size || row.fileSize || fallback.fileSize || 0),
      createdAt: fallback.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
  }

  function updateConnection(state) {
    const node = $("#connectionState");
    node.dataset.state = state;
    $("b", node).textContent = t(state === "online" ? "online" : state === "offline" ? "offline" : "checking");
  }

  function applyTelegramTheme() {
    if (!tg) return;
    tg.ready();
    tg.expand();
    if (typeof tg.setHeaderColor === "function") tg.setHeaderColor("#070a13");
    if (typeof tg.setBackgroundColor === "function") tg.setBackgroundColor("#070a13");
    const theme = tg.themeParams || {};
    if (theme.button_color) document.documentElement.style.setProperty("--green", theme.button_color);
    if (theme.button_text_color) document.documentElement.style.setProperty("--tg-button-text", theme.button_text_color);
  }

  async function loadConfig() {
    config = await apiJson(`${TELEGRAM_API}/config`, {}, 12000);
    const botUrl = config.bot_url || "https://t.me/dyrakarmy_bot";
    const miniAppUrl = config.mini_app_url || `${botUrl}?startapp=home`;
    $("#openBotLink").href = miniAppUrl;
    $("#botFooterLink").href = botUrl;
    $("#botFooterLink").textContent = `@${config.username || "dyrakarmy_bot"}`;
    $("#archiveMode").textContent = config.storage_enabled ? `${config.max_upload_mb || 50} MB` : "OFF";
  }

  async function loadProfile() {
    if (!initData) {
      $("#outsideBanner").classList.remove("hidden");
      updateConnection("online");
      await loadPublicStorageStats();
      return;
    }
    try {
      profile = await apiJson(`${TELEGRAM_API}/miniapp/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ init_data: initData }),
      });
      const user = profile.user || {};
      $("#profileName").textContent = [user.first_name, user.last_name].filter(Boolean).join(" ") || t("guest");
      $("#profileMeta").textContent = user.username ? `@${user.username}` : `Telegram ID ${user.id || "—"}`;
      $("#profileAvatar").textContent = String(user.first_name || "DK").slice(0, 2).toUpperCase();
      updateMetrics();
      renderProfileLists();
      renderStorage(profile.storage || {});
      updateConnection("online");
      await processStartParameter();
    } catch (error) {
      updateConnection("offline");
      toast(`${t("profile_failed")} ${error.message || error}`, "error");
    }
  }

  async function refreshProfile() {
    await loadProfile();
  }

  function updateMetrics() {
    const queue = Array.isArray(profile?.queue) ? profile.queue : [];
    const history = Array.isArray(profile?.history) ? profile.history : [];
    const storage = profile?.storage || {};
    $("#metricQueue").textContent = String(queue.length);
    $("#metricHistory").textContent = String(history.length);
    $("#metricFiles").textContent = String(storage.files || 0);
    $("#metricStorage").textContent = formatBytes(storage.total_bytes || 0);
  }

  function renderStorage(storage) {
    $("#archiveFiles").textContent = String(storage.files || 0);
    $("#archiveUnique").textContent = String(storage.unique_files || 0);
    $("#archiveBytes").textContent = formatBytes(storage.total_bytes || 0);
  }

  async function loadPublicStorageStats() {
    try {
      const payload = await apiJson(`${TELEGRAM_API}/storage/stats`, {}, 12000);
      renderStorage(payload);
      $("#metricFiles").textContent = String(payload.files || 0);
      $("#metricStorage").textContent = formatBytes(payload.total_bytes || 0);
    } catch {
      // Public stats are supplementary.
    }
  }

  function listMarkup(rows, emptyText, includeActions) {
    if (!rows.length) return `<div class="empty-inline">${escapeHtml(emptyText)}</div>`;
    return rows.map((row) => {
      const job = normalizeJob(row);
      const action = includeActions && job.status === "done"
        ? `<button type="button" data-send-job="${escapeHtml(job.id)}">${escapeHtml(t("send_chat"))}</button>`
        : "";
      return `<article class="list-card">
        <span class="job-icon">${job.status === "done" ? "✓" : job.status === "failed" ? "!" : "↻"}</span>
        <div><b>${escapeHtml(job.artist)} - ${escapeHtml(job.title)}</b><small>${escapeHtml(job.format.toUpperCase())} ${escapeHtml(job.quality)} · ${escapeHtml(statusText(job.status))} · #${escapeHtml(job.id.slice(0, 8))}</small></div>
        <div class="job-actions">${action}</div>
      </article>`;
    }).join("");
  }

  function renderProfileLists() {
    const queue = Array.isArray(profile?.queue) ? profile.queue : [];
    const history = Array.isArray(profile?.history) ? profile.history : [];
    $("#queueList").innerHTML = listMarkup(queue, t("queue_empty"), false);
    $("#historyList").innerHTML = listMarkup(history, t("history_empty"), true);
    bindSendButtons($("#historyList"));
  }

  function renderLiveJobs() {
    const list = $("#liveList");
    const rows = Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
    if (!rows.length) {
      list.innerHTML = `<div class="empty-state"><div class="radar"><i></i><i></i><i></i></div><b>${escapeHtml(t("no_live"))}</b><span>${escapeHtml(t("no_live_text"))}</span></div>`;
      return;
    }
    list.innerHTML = rows.map((job) => {
      const action = job.status === "done"
        ? `<button type="button" data-send-job="${escapeHtml(job.id)}">${escapeHtml(t("send_chat"))}</button>${job.downloadUrl ? `<a href="${escapeHtml(job.downloadUrl)}" target="_blank" rel="noreferrer">${escapeHtml(t("open_file"))}</a>` : ""}`
        : "";
      return `<article class="job-card">
        <span class="job-icon">${job.status === "done" ? "✓" : job.status === "failed" ? "!" : "↻"}</span>
        <div><b>${escapeHtml(job.artist)} - ${escapeHtml(job.title)}</b><small>${escapeHtml(job.format.toUpperCase())} ${escapeHtml(job.quality)} · ${escapeHtml(statusText(job.status))}</small>${job.error ? `<small>${escapeHtml(job.error)}</small>` : ""}</div>
        <div class="job-actions">${action}</div>
        <div class="progress"><i style="--progress:${progressFor(job.status)}%"></i></div>
      </article>`;
    }).join("");
    bindSendButtons(list);
  }

  function bindSendButtons(root) {
    $$('[data-send-job]', root).forEach((button) => {
      if (button.dataset.bound === "1") return;
      button.dataset.bound = "1";
      button.addEventListener("click", () => void sendJobToChat(button.dataset.sendJob));
    });
  }

  async function queueDownload(url, source, format, quality, metadata = {}) {
    if (!initData) {
      toast(t("auth_required"), "error");
      $("#outsideBanner").classList.remove("hidden");
      return null;
    }
    if (!isPublicUrl(url)) {
      toast(t("invalid_url"), "error");
      return null;
    }

    const payload = await apiJson(`${TELEGRAM_API}/miniapp/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: initData, url, source, format, quality }),
    });
    const jobId = String(payload.jobId || payload.job_id || "");
    if (!jobId) throw new Error("Missing job id");
    const job = normalizeJob({
      id: jobId,
      status: payload.status || "queued",
      url,
      source,
      format,
      quality,
      title: metadata.title || "Media job",
      artist: metadata.artist || "Download Killer",
    });
    jobs.set(job.id, job);
    renderLiveJobs();
    subscribeJob(job.id);
    toast(t("queued"));
    if (tg && typeof tg.HapticFeedback?.impactOccurred === "function") tg.HapticFeedback.impactOccurred("medium");
    return job.id;
  }

  function closeStream(jobId) {
    const source = streams.get(jobId);
    if (source) source.close();
    streams.delete(jobId);
  }

  function subscribeJob(jobId) {
    closeStream(jobId);
    if (!("EventSource" in window)) {
      void pollJob(jobId);
      return;
    }
    const source = new EventSource(`${API_BASE}/job/${encodeURIComponent(jobId)}/events`);
    streams.set(jobId, source);
    const receive = (event) => {
      try {
        const payload = JSON.parse(event.data || "{}");
        const existing = jobs.get(jobId) || { id: jobId, createdAt: Date.now() };
        const next = normalizeJob(payload, existing);
        jobs.set(jobId, next);
        renderLiveJobs();
        if (["done", "failed"].includes(next.status)) {
          closeStream(jobId);
          void refreshProfile();
        }
      } catch {
        // Ignore malformed SSE frames and keep the connection alive.
      }
    };
    ["message", "status", "job", "done", "failed"].forEach((name) => source.addEventListener(name, receive));
    source.onerror = () => {
      closeStream(jobId);
      void pollJob(jobId);
    };
  }

  async function pollJob(jobId) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const payload = await apiJson(`${API_BASE}/job/${encodeURIComponent(jobId)}`, {}, 12000);
        const existing = jobs.get(jobId) || { id: jobId, createdAt: Date.now() };
        const next = normalizeJob(payload, existing);
        jobs.set(jobId, next);
        renderLiveJobs();
        if (["done", "failed"].includes(next.status)) {
          await refreshProfile();
          return;
        }
      } catch {
        // Retry with bounded polling.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1800));
    }
  }

  async function sendJobToChat(jobId) {
    if (!initData || !jobId) {
      toast(t("auth_required"), "error");
      return;
    }
    try {
      await apiJson(`${TELEGRAM_API}/miniapp/send-job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ init_data: initData, job_id: jobId }),
      });
      toast(t("sent_chat"));
    } catch (error) {
      toast(`${t("request_failed")} ${error.message || error}`, "error");
    }
  }

  async function runSearch(query, source) {
    const payload = await apiJson(`${API_BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, source }),
    });
    const rows = Array.isArray(payload) ? payload : (payload.results || payload.items || []);
    searchResults = rows.map((row, index) => ({
      id: String(row.id || index),
      title: String(row.title || "Media"),
      artist: String(row.artist || row.uploader || "Unknown"),
      url: String(row.url || ""),
      source: String(row.source || source || "all"),
      duration: Number(row.duration || 0),
    })).filter((row) => isPublicUrl(row.url));
    renderSearchResults();
  }

  function renderSearchResults() {
    const list = $("#searchResults");
    if (!searchResults.length) {
      list.innerHTML = `<div class="empty-inline">${escapeHtml(t("no_results"))}</div>`;
      return;
    }
    list.innerHTML = searchResults.map((row) => `<article class="result-card">
      <span class="job-icon">♪</span>
      <div><b>${escapeHtml(row.artist)} - ${escapeHtml(row.title)}</b><small>${escapeHtml(row.source)}${row.duration ? ` · ${Math.floor(row.duration / 60)}:${String(row.duration % 60).padStart(2, "0")}` : ""}</small></div>
      <button type="button" data-result-id="${escapeHtml(row.id)}">${escapeHtml(t("add"))}</button>
    </article>`).join("");
    $$('[data-result-id]', list).forEach((button) => {
      button.addEventListener("click", async () => {
        const row = searchResults.find((item) => item.id === button.dataset.resultId);
        if (!row) return;
        try {
          await queueDownload(row.url, row.source, $("#formatSelect").value, $("#qualitySelect").value, row);
          activateTab("download");
        } catch (error) {
          toast(`${t("request_failed")} ${error.message || error}`, "error");
        }
      });
    });
  }

  async function processStartParameter() {
    if (!initData) return;
    const startParam = String(tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get("tgWebAppStartParam") || "");
    if (!startParam.startsWith("job_")) return;
    const token = startParam.slice(4);
    try {
      await apiJson(`${TELEGRAM_API}/miniapp/send-job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ init_data: initData, handoff_token: token }),
      });
      toast(t("sent_chat"));
    } catch (error) {
      toast(`${t("handoff_failed")} ${error.message || error}`, "error");
    }
  }

  function activateTab(name) {
    $$('[data-tab]').forEach((button) => button.classList.toggle("active", button.dataset.tab === name));
    $$('[data-panel]').forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === name));
    if (name === "queue" || name === "history") void refreshProfile();
    if (name === "archive") void loadPublicStorageStats();
  }

  function setupReveal() {
    if (!("IntersectionObserver" in window)) {
      $$(".reveal").forEach((node) => node.classList.add("visible"));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.1 });
    $$(".reveal").forEach((node) => observer.observe(node));
  }

  function setupCanvas() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = $("#pulseCanvas");
    const context = canvas.getContext("2d", { alpha: true });
    let width = 0;
    let height = 0;
    let ratio = 1;
    let rings = [];

    const reset = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      rings = Array.from({ length: Math.min(28, Math.max(12, Math.floor(width / 45))) }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        radius: Math.random() * 5 + 1,
        speed: Math.random() * .18 + .05,
        alpha: Math.random() * .08 + .015,
      }));
    };
    reset();
    window.addEventListener("resize", reset, { passive: true });

    const frame = () => {
      context.clearRect(0, 0, width, height);
      for (const ring of rings) {
        ring.radius += ring.speed;
        if (ring.radius > 95) {
          ring.radius = 1;
          ring.x = Math.random() * width;
          ring.y = Math.random() * height;
        }
        context.beginPath();
        context.strokeStyle = `rgba(81,232,181,${Math.max(0, ring.alpha * (1 - ring.radius / 95))})`;
        context.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
        context.stroke();
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  function bindEvents() {
    $("#languageBtn").addEventListener("click", () => {
      currentLanguage = currentLanguage === "bg" ? "en" : "bg";
      applyLanguage();
    });
    $$('[data-tab]').forEach((button) => button.addEventListener("click", () => activateTab(button.dataset.tab)));
    $("#mediaUrl").addEventListener("input", (event) => {
      if ($("#sourceSelect").value === "all") {
        const source = detectSource(event.target.value);
        if (source !== "all") $("#sourceSelect").value = source;
      }
    });
    $("#pasteBtn").addEventListener("click", async () => {
      try {
        const value = await navigator.clipboard.readText();
        $("#mediaUrl").value = value.trim();
        const source = detectSource(value);
        if (source !== "all") $("#sourceSelect").value = source;
      } catch {
        toast(t("clipboard_failed"), "error");
      }
    });
    $("#downloadForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = $("#queueBtn");
      button.disabled = true;
      try {
        await queueDownload($("#mediaUrl").value.trim(), $("#sourceSelect").value, $("#formatSelect").value, $("#qualitySelect").value);
        $("#mediaUrl").value = "";
      } catch (error) {
        toast(`${t("request_failed")} ${error.message || error}`, "error");
      } finally {
        button.disabled = false;
      }
    });
    $("#searchForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const query = $("#searchInput").value.trim();
      if (!query) return;
      try {
        await runSearch(query, $("#searchSource").value);
      } catch (error) {
        toast(`${t("search_failed")} ${error.message || error}`, "error");
      }
    });
    $("#clearLiveBtn").addEventListener("click", () => {
      streams.forEach((source) => source.close());
      streams.clear();
      jobs.clear();
      renderLiveJobs();
    });
    $("#refreshQueueBtn").addEventListener("click", () => void refreshProfile());
    $("#refreshHistoryBtn").addEventListener("click", () => void refreshProfile());
    $("#refreshArchiveBtn").addEventListener("click", () => void loadPublicStorageStats());
  }

  async function init() {
    applyTelegramTheme();
    applyLanguage();
    bindEvents();
    setupReveal();
    setupCanvas();
    renderLiveJobs();
    updateConnection("checking");
    try {
      await loadConfig();
      await loadProfile();
    } catch (error) {
      updateConnection("offline");
      toast(String(error.message || error), "error");
    }
  }

  window.addEventListener("beforeunload", () => streams.forEach((source) => source.close()));
  document.addEventListener("DOMContentLoaded", () => void init());
})();
