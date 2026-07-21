(() => {
  "use strict";

  const API_BASE = "/api";
  const BOT_USERNAME = "dyrakarmy_bot";
  const SUPPORTED_LANGUAGES = ["bg", "en", "ru", "de"];
  let currentLang = localStorage.getItem("da_platform_lang") || "bg";
  if (!SUPPORTED_LANGUAGES.includes(currentLang)) currentLang = "bg";

  const jobs = new Map();
  const streams = new Map();

  const I18N = {
    bg: {
      page_title: "Download Killer Platform",
      page_description: "Download Killer — web платформа с един Telegram бот, обща опашка, история и файлов архив.",
      nav_tutorial: "Как работи", nav_console: "Конзола", nav_status: "Статус", checking: "Проверка", online: "ONLINE", offline: "OFFLINE",
      hero_eyebrow: "WEB · TELEGRAM · ЕДНА ОПАШКА", hero_line_1: "Подай линк.", hero_line_2: "Получи готовия файл.", hero_text: "Download Killer свързва сайта, @dyrakarmy_bot, Mini App, опашката и файловия архив върху един общ backend.",
      see_tutorial: "Виж как работи", open_miniapp: "Отвори Telegram Mini App", live_progress: "Live прогрес",
      tutorial_kicker: "БЪРЗО НАЧАЛО", tutorial_title: "Какво е системата и как се използва", tutorial_intro: "Платформата приема публичен URL, валидира го, добавя задачата в обща опашка и предава обработката към наличния backend. Резултатът се връща в сайта или в Telegram.",
      open_other_domain: "Отвори другия домейн", open_primary_domain: "Отвори резервния .online домейн", mirror_note: "Двата адреса използват една и съща база, опашка и Telegram интеграция.",
      step1_title: "Постави публичен URL", step1_text: "Копирай линк от поддържан източник или използвай търсенето в Telegram бота.", step2_title: "Избери формат и качество", step2_text: "Избери MP3, M4A, OGG, OPUS, FLAC или WAV и подходящо качество.", step3_title: "Следи общата опашка", step3_text: "Worker-ът валидира заявката, поставя я в queue и показва прогрес чрез SSE.", step4_title: "Получи резултата", step4_text: "Изтегли файла от сайта или го получи в Telegram. Повторните заявки могат да използват архива.",
      metric_formats: "формата", metric_sources: "източника", metric_updates: "live статус", metric_language: "езика", metric_edge: "edge достъп",
      console_title: "Web конзола", console_text: "Подай публичен URL, избери формат и следи задачата в реално време.", url_label: "Публичен URL", paste: "Постави", source_label: "Източник", format_label: "Формат", quality_label: "Качество", usage_note: "Използвай платформата само за съдържание, което имаш право да изтеглиш или обработиш.", launch: "Добави в опашката", activity_title: "Активност", clear: "Изчисти", empty_jobs: "Няма активни задачи", empty_jobs_text: "Първата заявка ще се появи тук с live прогрес.",
      telegram_title: "@dyrakarmy_bot и сайтът използват една и съща система.", telegram_text: "Бутоните отварят инсталирания Telegram клиент чрез native протокола. Няма автоматично прехвърляне към браузър.", open_bot: "Отвори @dyrakarmy_bot", copy_bot_handle: "Копирай @dyrakarmy_bot", bot_handle_copied: "Telegram username е копиран.", telegram_native: "Изпратена е заявка към инсталирания Telegram клиент.",
      engines_title: "Какво работи зад интерфейса", engines_text: "Web и Telegram използват един control plane, а обработващите компоненти се обновяват независимо.", engine_edge: "REST API, D1, KV, Queues, SSE и защитени файлови връзки.", engine_telegram: "Webhook, Mini App, обща опашка, файлов архив и повторно изпращане.", engine_downloader: "Изолирана обработка с FFmpeg и source fallback.", engine_metadata: "Metadata matching и алтернативни публични източници.", public_core: "Публично ядро", connected_surface: "Свързан интерфейс",
      status_title: "Системен статус", refresh: "Обнови", status_edge: "Edge API", status_origin: "Downloader origin", status_formats: "Формати", status_latency: "Латентност", recent_jobs: "Последни публични задачи", new_job: "Нова задача ↗", footer_text: "Web и Telegram workflow върху общ edge backend.",
      invalid_url: "Въведи валиден публичен HTTP/HTTPS URL.", queued: "Задачата е добавена в опашката.", request_failed: "Заявката не беше приета.", copied: "URL адресът е поставен.", clipboard_failed: "Няма достъп до clipboard.", download: "Изтегли", processing: "обработва се", done: "готово", failed: "грешка", paused: "паузирано", waiting: "изчаква", no_history: "Няма налична публична история.", formats_ready: "достъпни"
    },
    en: {
      page_title: "Download Killer Platform", page_description: "Download Killer web platform with one Telegram bot, shared queue, history and file archive.",
      nav_tutorial: "How it works", nav_console: "Console", nav_status: "Status", checking: "Checking", online: "ONLINE", offline: "OFFLINE",
      hero_eyebrow: "WEB · TELEGRAM · ONE QUEUE", hero_line_1: "Submit a link.", hero_line_2: "Receive the finished file.", hero_text: "Download Killer connects the website, @dyrakarmy_bot, Mini App, queue and file archive on one backend.",
      see_tutorial: "See how it works", open_miniapp: "Open Telegram Mini App", live_progress: "Live progress",
      tutorial_kicker: "QUICK START", tutorial_title: "What the system is and how to use it", tutorial_intro: "The platform accepts a public URL, validates it, queues the job and sends it to the available backend.",
      open_other_domain: "Open other domain", open_primary_domain: "Open backup .online domain", mirror_note: "Both domains use the same database, queue and Telegram integration.",
      step1_title: "Paste a public URL", step1_text: "Copy a supported link or use search in the Telegram bot.", step2_title: "Choose format and quality", step2_text: "Choose MP3, M4A, OGG, OPUS, FLAC or WAV.", step3_title: "Track the shared queue", step3_text: "The Worker validates, queues and reports progress through SSE.", step4_title: "Receive the result", step4_text: "Download from the site or receive it in Telegram.",
      metric_formats: "formats", metric_sources: "sources", metric_updates: "live status", metric_language: "languages", metric_edge: "edge access",
      console_title: "Web console", console_text: "Submit a public URL, choose a format and track it in real time.", url_label: "Public URL", paste: "Paste", source_label: "Source", format_label: "Format", quality_label: "Quality", usage_note: "Use the platform only for content you may download or process.", launch: "Add to queue", activity_title: "Activity", clear: "Clear", empty_jobs: "No active jobs", empty_jobs_text: "The first request will appear here with live progress.",
      telegram_title: "@dyrakarmy_bot and the website use the same system.", telegram_text: "Buttons open the installed Telegram client through its native protocol. There is no automatic browser fallback.", open_bot: "Open @dyrakarmy_bot", copy_bot_handle: "Copy @dyrakarmy_bot", bot_handle_copied: "Telegram username copied.", telegram_native: "A request was sent to the installed Telegram client.",
      engines_title: "What works behind the interface", engines_text: "Web and Telegram use one control plane while processing components update independently.", engine_edge: "REST API, D1, KV, Queues, SSE and protected file links.", engine_telegram: "Webhook, Mini App, shared queue, file archive and reuse.", engine_downloader: "Isolated processing with FFmpeg and source fallback.", engine_metadata: "Metadata matching and alternative public sources.", public_core: "Public core", connected_surface: "Connected surface",
      status_title: "System status", refresh: "Refresh", status_edge: "Edge API", status_origin: "Downloader origin", status_formats: "Formats", status_latency: "Latency", recent_jobs: "Recent public jobs", new_job: "New job ↗", footer_text: "Web and Telegram workflow on a shared edge backend.",
      invalid_url: "Enter a valid public HTTP/HTTPS URL.", queued: "The job was added to the queue.", request_failed: "The request was not accepted.", copied: "URL pasted.", clipboard_failed: "Clipboard access failed.", download: "Download", processing: "processing", done: "done", failed: "failed", paused: "paused", waiting: "waiting", no_history: "No public history is available.", formats_ready: "available"
    },
    ru: {},
    de: {}
  };
  I18N.ru = { ...I18N.en, page_description: "Download Killer — платформа с одним Telegram-ботом, общей очередью и архивом.", open_bot: "Открыть @dyrakarmy_bot", copy_bot_handle: "Копировать @dyrakarmy_bot", telegram_text: "Кнопки открывают установленный клиент Telegram без автоматического перехода в браузер." };
  I18N.de = { ...I18N.en, page_description: "Download Killer mit einem Telegram-Bot, gemeinsamer Warteschlange und Archiv.", open_bot: "@dyrakarmy_bot öffnen", copy_bot_handle: "@dyrakarmy_bot kopieren", telegram_text: "Die Schaltflächen öffnen den installierten Telegram-Client ohne automatischen Browser-Fallback." };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const t = (key) => I18N[currentLang]?.[key] || I18N.en[key] || key;
  const escapeHtml = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const localeForLanguage = { bg: "bg-BG", en: "en-GB", ru: "ru-RU", de: "de-DE" };

  function applyLanguage() {
    document.documentElement.lang = currentLang;
    localStorage.setItem("da_platform_lang", currentLang);
    document.title = t("page_title");
    const meta = $('meta[name="description"]');
    if (meta) meta.content = t("page_description");
    const select = $("#languageSelect");
    if (select) select.value = currentLang;
    $$('[data-i18n]').forEach((node) => { const value = t(node.dataset.i18n); if (value) node.textContent = value; });
    updateMirrorLink();
    renderJobs();
  }

  function updateMirrorLink() {
    const link = $("#alternateDomainLink");
    if (!link) return;
    const onEu = location.hostname === "dyrakarmy.eu" || location.hostname === "www.dyrakarmy.eu";
    const target = onEu ? "https://dyrakarmy.online/" : "https://dyrakarmy.eu/";
    link.href = target;
    const label = $("span", link);
    if (label) label.textContent = `${t("open_other_domain")}: ${new URL(target).hostname}`;
  }

  function toast(message, type = "info") {
    const region = $("#toastRegion");
    if (!region) return;
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = message;
    region.appendChild(node);
    setTimeout(() => node.remove(), 4300);
  }

  function openTelegram(mode) {
    const suffix = mode === "miniapp" ? "&startapp=home" : "";
    const nativeUrl = `tg://resolve?domain=${BOT_USERNAME}${suffix}`;
    window.location.href = nativeUrl;
    setTimeout(() => toast(t("telegram_native"), "info"), 350);
  }

  function normalizeError(payload, fallback) {
    if (payload?.error?.message) return String(payload.error.message);
    if (payload?.detail) return String(payload.detail);
    return fallback;
  }

  async function apiJson(path, init = {}, timeoutMs = 25000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(normalizeError(payload, `HTTP ${response.status}`));
      return payload;
    } finally { clearTimeout(timer); }
  }

  function isPublicHttpUrl(value) {
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase();
      return ["http:", "https:"].includes(parsed.protocol) && Boolean(host) && host !== "localhost" && !host.endsWith(".local") && !host.endsWith(".onion");
    } catch { return false; }
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
    return t(["done", "failed", "processing", "paused", "queued"].includes(value) ? value : "waiting");
  }

  function progressFor(status) { return ({ done: 100, failed: 100, processing: 58, paused: 35, queued: 12 })[String(status || "queued").toLowerCase()] || 12; }

  function readJobPayload(payload, fallback = {}) {
    const row = payload?.job || payload || {};
    return { ...fallback, id: String(row.id || row.jobId || row.job_id || fallback.id || ""), status: String(row.status || fallback.status || "queued").toLowerCase(), title: String(row.title || row.track || fallback.title || "Media job"), artist: String(row.artist || row.uploader || fallback.artist || "Download Killer"), format: String(row.format || fallback.format || "mp3"), quality: String(row.quality || fallback.quality || "best"), source: String(row.source || fallback.source || "all"), downloadUrl: String(row.download_url || row.downloadUrl || fallback.downloadUrl || ""), error: String(row.error_message || row.error || fallback.error || ""), updatedAt: Date.now() };
  }

  function renderJobs() {
    const feed = $("#jobFeed");
    if (!feed) return;
    const items = Array.from(jobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (!items.length) {
      feed.innerHTML = `<div class="empty-state" id="jobEmpty"><div class="radar"><i></i><i></i><i></i></div><strong>${escapeHtml(t("empty_jobs"))}</strong><span>${escapeHtml(t("empty_jobs_text"))}</span></div>`;
      return;
    }
    feed.innerHTML = items.map((job) => {
      const status = String(job.status || "queued").toLowerCase();
      const action = status === "done" && job.downloadUrl ? `<a href="${escapeHtml(job.downloadUrl)}" target="_blank" rel="noreferrer">${escapeHtml(t("download"))}</a>` : "";
      const error = job.error ? `<p>${escapeHtml(job.error)}</p>` : "";
      return `<article class="job-card ${escapeHtml(status)}" style="--progress:${progressFor(status)}%"><div class="job-status">${status === "done" ? "✓" : status === "failed" ? "!" : "↻"}</div><div><h4>${escapeHtml(job.title)}</h4><span>${escapeHtml(job.artist)} · ${escapeHtml(job.format.toUpperCase())} ${escapeHtml(job.quality)}</span><small>${escapeHtml(statusLabel(status))}</small>${error}</div><div class="job-actions">${action}</div></article>`;
    }).join("");
  }

  function closeStream(jobId) { const source = streams.get(jobId); if (source) source.close(); streams.delete(jobId); }

  async function pollJob(jobId, attempts = 0) {
    if (!jobs.has(jobId) || attempts > 80) return;
    try {
      const payload = await apiJson(`/job/${encodeURIComponent(jobId)}`, {}, 12000);
      const next = readJobPayload(payload, jobs.get(jobId));
      jobs.set(jobId, next); renderJobs();
      if (["done", "failed"].includes(next.status)) { closeStream(jobId); return; }
    } catch { /* retry */ }
    setTimeout(() => void pollJob(jobId, attempts + 1), 6000);
  }

  function subscribeJob(jobId) {
    if (!("EventSource" in window)) { void pollJob(jobId); return; }
    closeStream(jobId);
    const source = new EventSource(`${API_BASE}/job/${encodeURIComponent(jobId)}/events`);
    streams.set(jobId, source);
    source.onmessage = (event) => { try { const next = readJobPayload(JSON.parse(event.data), jobs.get(jobId)); jobs.set(jobId, next); renderJobs(); if (["done", "failed"].includes(next.status)) closeStream(jobId); } catch { /* heartbeat */ } };
    source.onerror = () => { closeStream(jobId); void pollJob(jobId); };
  }

  async function submitDownload(event) {
    event.preventDefault();
    const input = $("#mediaUrl");
    const url = input.value.trim();
    if (!isPublicHttpUrl(url)) { toast(t("invalid_url"), "error"); input.focus(); return; }
    const button = $("#launchBtn"); button.disabled = true;
    const sourceSelect = $("#sourceSelect");
    if (sourceSelect.value === "all") sourceSelect.value = detectSource(url);
    const body = { url, source: sourceSelect.value || "all", format: $("#formatSelect").value || "mp3", quality: $("#qualitySelect").value || "best", client_id: "platform-v12", added_by: "download-killer-home" };
    try {
      const payload = await apiJson("/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const jobId = String(payload.jobId || payload.job_id || payload.id || "");
      if (!jobId) throw new Error("Backend response did not include a job id");
      jobs.set(jobId, { id: jobId, status: String(payload.status || "queued").toLowerCase(), title: url, artist: body.source.toUpperCase(), format: body.format, quality: body.quality, source: body.source, downloadUrl: "", error: "", createdAt: Date.now() });
      renderJobs(); subscribeJob(jobId); toast(t("queued"), "success"); input.value = "";
    } catch (error) { toast(`${t("request_failed")} ${error.message || error}`, "error"); }
    finally { button.disabled = false; }
  }

  function updateHealthChip(state) { const chip = $("#globalHealth"); if (!chip) return; chip.dataset.state = state; const label = $("b", chip); if (label) label.textContent = t(state === "online" ? "online" : state === "offline" ? "offline" : "checking"); }
  function setStatus(selector, value, state = "") { const node = $(selector); if (!node) return; node.textContent = value; node.classList.remove("online", "offline"); if (state) node.classList.add(state); }

  async function loadSystemStatus() {
    updateHealthChip("checking");
    const started = performance.now(); let healthOk = false;
    try { const health = await apiJson("/health", {}, 12000); healthOk = Boolean(health && (health.ok === true || health.status === "ok" || health.status === "healthy")); setStatus("#edgeStatus", healthOk ? t("online") : t("offline"), healthOk ? "online" : "offline"); $("#edgeDetail").textContent = String(health.service || health.version || "Cloudflare Worker"); }
    catch (error) { setStatus("#edgeStatus", t("offline"), "offline"); $("#edgeDetail").textContent = String(error.message || error).slice(0, 80); }
    $("#latencyStatus").textContent = `${Math.max(1, Math.round(performance.now() - started))} ms`;
    try { const config = await apiJson("/runtime-config", {}, 12000); const origin = config.downloader_api_url || config.api_base || config.public_base || "configured"; setStatus("#originStatus", t("online"), "online"); $("#originDetail").textContent = String(origin).replace(/^https?:\/\//, "").slice(0, 52); }
    catch (error) { setStatus("#originStatus", t("offline"), "offline"); $("#originDetail").textContent = String(error.message || error).slice(0, 80); }
    try { const payload = await apiJson("/formats", {}, 12000); const list = Array.isArray(payload) ? payload : (payload.formats || payload.items || []); setStatus("#formatStatus", String(Array.isArray(list) && list.length ? list.length : 6), "online"); $("#formatDetail").textContent = t("formats_ready"); }
    catch { setStatus("#formatStatus", "6", "online"); $("#formatDetail").textContent = "MP3 · M4A · OGG · OPUS · FLAC · WAV"; }
    updateHealthChip(healthOk ? "online" : "offline");
  }

  function normalizeHistory(payload) { if (Array.isArray(payload)) return payload; return payload?.jobs || payload?.items || payload?.results || payload?.history || []; }
  async function loadHistory() {
    const list = $("#historyList"); if (!list) return;
    try {
      const payload = await apiJson("/history?limit=6&offset=0", {}, 12000); const rows = normalizeHistory(payload).slice(0, 6);
      if (!rows.length) { list.innerHTML = `<div class="history-row"><i></i><b>${escapeHtml(t("no_history"))}</b><span>—</span><time>—</time></div>`; return; }
      list.innerHTML = rows.map((row) => { const status = String(row.status || "queued").toLowerCase(); const title = row.title || row.url || row.id || "Media job"; const format = String(row.format || "").toUpperCase(); const created = row.created_at || row.createdAt || row.updated_at || row.updatedAt; const time = created ? new Date(created).toLocaleString(localeForLanguage[currentLang], { dateStyle: "short", timeStyle: "short" }) : "—"; return `<div class="history-row"><i class="${escapeHtml(status)}"></i><b>${escapeHtml(title)}</b><span>${escapeHtml(format)} · ${escapeHtml(statusLabel(status))}</span><time>${escapeHtml(time)}</time></div>`; }).join("");
    } catch (error) { list.innerHTML = `<div class="history-row"><i class="failed"></i><b>${escapeHtml(t("no_history"))}</b><span>${escapeHtml(String(error.message || error).slice(0, 60))}</span><time>—</time></div>`; }
  }

  function setupReveal() {
    if (!("IntersectionObserver" in window)) { $$(".reveal").forEach((node) => node.classList.add("visible")); return; }
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add("visible"); observer.unobserve(entry.target); } }), { threshold: .12 });
    $$(".reveal").forEach((node) => observer.observe(node));
  }

  function animateMetrics() {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    $$('[data-count]').forEach((node) => { const target = Number(node.dataset.count || 0); if (reduced) { node.textContent = String(target); return; } const started = performance.now(); const tick = (now) => { const progress = Math.min(1, (now - started) / 950); node.textContent = String(Math.round(target * (1 - Math.pow(1 - progress, 3)))); if (progress < 1) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  }

  function bindEvents() {
    const languageSelect = $("#languageSelect");
    if (languageSelect) languageSelect.addEventListener("change", () => { currentLang = SUPPORTED_LANGUAGES.includes(languageSelect.value) ? languageSelect.value : "bg"; applyLanguage(); void loadHistory(); void loadSystemStatus(); });
    $("#downloadForm")?.addEventListener("submit", submitDownload);
    $("#mediaUrl")?.addEventListener("input", (event) => { if ($("#sourceSelect").value === "all") { const source = detectSource(event.target.value); if (source !== "all") $("#sourceSelect").value = source; } });
    $("#formatSelect")?.addEventListener("change", (event) => { const quality = $("#qualitySelect"); const lossless = ["flac", "wav"].includes(event.target.value); if (lossless && !["best", "lossless"].includes(quality.value)) quality.value = "best"; else if (!lossless && quality.value === "lossless") quality.value = "best"; });
    $("#pasteBtn")?.addEventListener("click", async () => { try { const value = await navigator.clipboard.readText(); $("#mediaUrl").value = value.trim(); const source = detectSource(value); if (source !== "all") $("#sourceSelect").value = source; toast(t("copied"), "success"); } catch { toast(t("clipboard_failed"), "error"); } });
    $("#clearJobsBtn")?.addEventListener("click", () => { jobs.forEach((_, id) => closeStream(id)); jobs.clear(); renderJobs(); });
    $("#refreshStatusBtn")?.addEventListener("click", () => { void loadSystemStatus(); void loadHistory(); });
    $$(".telegram-link").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); openTelegram(link.dataset.telegramMode || "bot"); }));
    $("#copyBotHandleBtn")?.addEventListener("click", async () => { try { await navigator.clipboard.writeText(`@${BOT_USERNAME}`); toast(t("bot_handle_copied"), "success"); } catch { toast(t("clipboard_failed"), "error"); } });
  }

  async function init() {
    const year = $("#year"); if (year) year.textContent = String(new Date().getFullYear());
    applyLanguage(); bindEvents(); setupReveal(); animateMetrics(); renderJobs();
    await Promise.allSettled([loadSystemStatus(), loadHistory()]);
  }

  addEventListener("beforeunload", () => streams.forEach((source) => source.close()));
  document.addEventListener("DOMContentLoaded", () => void init());
})();
