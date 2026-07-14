(() => {
  "use strict";

  const API_BASE = "/api";
  const BOT_USERNAME = "download_killerBOT";
  const SUPPORTED_LANGUAGES = ["bg", "en", "ru", "de"];
  const jobs = new Map();
  const streams = new Map();
  const storedLanguage = localStorage.getItem("da_platform_lang");
  const browserLanguage = String(navigator.language || "bg").slice(0, 2).toLowerCase();
  let currentLang = SUPPORTED_LANGUAGES.includes(storedLanguage)
    ? storedLanguage
    : (SUPPORTED_LANGUAGES.includes(browserLanguage) ? browserLanguage : "bg");

  const I18N = {
    bg: {
      page_title:"Download Killer Platform", page_description:"Download Killer — web и Telegram платформа с обща опашка, история и файлов архив.",
      nav_tutorial:"Как работи", nav_console:"Конзола", nav_status:"Статус", checking:"Проверка", online:"ONLINE", offline:"OFFLINE",
      hero_eyebrow:"WEB · TELEGRAM · ЕДНА ОПАШКА", hero_line_1:"Подай линк.", hero_line_2:"Получи готовия файл.", hero_text:"Download Killer свързва сайта, Telegram бота, Mini App, опашката и файловия архив върху един общ backend.",
      see_tutorial:"Виж как работи", open_miniapp:"Отвори Telegram Mini App", live_progress:"Live прогрес",
      tutorial_kicker:"БЪРЗО НАЧАЛО", tutorial_title:"Какво е системата и как се използва", tutorial_intro:"Платформата приема публичен URL, валидира го, добавя задачата в обща опашка и предава обработката към наличния backend. Резултатът се връща в сайта или в Telegram.",
      open_other_domain:"Отвори другия домейн", open_primary_domain:"Отвори основния .online домейн", mirror_note:"Двата адреса използват една и съща база, опашка и Telegram интеграция.",
      step1_title:"Постави публичен URL", step1_text:"Копирай линк от поддържан източник или използвай търсенето в Telegram бота.", step2_title:"Избери формат и качество", step2_text:"Избери MP3, M4A, OGG, OPUS, FLAC или WAV и подходящо качество.", step3_title:"Следи общата опашка", step3_text:"Worker-ът валидира заявката, поставя я в queue и показва прогрес чрез SSE.", step4_title:"Получи резултата", step4_text:"Изтегли файла от сайта или го получи в Telegram. Повторните заявки могат да използват архива.",
      metric_formats:"формата", metric_sources:"източника", metric_updates:"live статус", metric_language:"езика", metric_edge:"edge достъп",
      console_title:"Web конзола", console_text:"Подай публичен URL, избери формат и следи задачата в реално време.", url_label:"Публичен URL", paste:"Постави", source_label:"Източник", format_label:"Формат", quality_label:"Качество", usage_note:"Използвай платформата само за съдържание, което имаш право да изтеглиш или обработиш.", launch:"Добави в опашката", activity_title:"Активност", clear:"Изчисти", empty_jobs:"Няма активни задачи", empty_jobs_text:"Първата заявка ще се появи тук с live прогрес.",
      telegram_title:"Ботът и сайтът използват една и съща система.", telegram_text:"Бутоните първо отварят инсталираното Telegram приложение. Ако протоколът не е наличен, системата преминава към Telegram Web и не зависи единствено от t.me.", open_bot:"Отвори @download_killerBOT", open_telegram_web:"Отвори Telegram Web", copy_bot_handle:"Копирай @download_killerBOT", open_web_miniapp:"Web изглед на Mini App", bot_handle_copied:"Telegram username е копиран.", telegram_fallback:"Отварям Telegram Web…",
      engines_title:"Какво работи зад интерфейса", engines_text:"Web и Telegram използват един control plane, а обработващите компоненти се обновяват независимо.", engine_edge:"REST API, D1, KV, Queues, SSE и защитени файлови връзки.", engine_telegram:"Webhook, Mini App, обща опашка, файлов архив и повторно изпращане.", engine_downloader:"Изолирана обработка с FFmpeg и source fallback.", engine_metadata:"Metadata matching и алтернативни публични източници.", public_core:"Публично ядро", connected_surface:"Свързан интерфейс",
      status_title:"Системен статус", refresh:"Обнови", status_edge:"Edge API", status_origin:"Downloader origin", status_formats:"Формати", status_latency:"Латентност", recent_jobs:"Последни публични задачи", new_job:"Нова задача ↗", footer_text:"Web и Telegram workflow върху общ edge backend.",
      invalid_url:"Въведи валиден публичен HTTP/HTTPS URL.", queued:"Задачата е добавена в опашката.", request_failed:"Заявката не беше приета.", copied:"URL адресът е поставен.", clipboard_failed:"Няма достъп до клипборда.", download:"Изтегли", processing:"обработва се", done:"готово", failed:"грешка", paused:"пауза", waiting:"изчакване", no_history:"Няма публична история.", formats_ready:"налични"
    },
    en: {
      page_title:"Download Killer Platform", page_description:"Download Killer — a web and Telegram platform with a shared queue, history and file archive.",
      nav_tutorial:"How it works", nav_console:"Console", nav_status:"Status", checking:"Checking", online:"ONLINE", offline:"OFFLINE",
      hero_eyebrow:"WEB · TELEGRAM · ONE QUEUE", hero_line_1:"Submit a link.", hero_line_2:"Receive the finished file.", hero_text:"Download Killer connects the website, Telegram bot, Mini App, queue and file archive on one shared backend.",
      see_tutorial:"See how it works", open_miniapp:"Open Telegram Mini App", live_progress:"Live progress",
      tutorial_kicker:"QUICK START", tutorial_title:"What the system is and how to use it", tutorial_intro:"The platform accepts a public URL, validates it, adds the job to a shared queue and sends it to the available backend. The result returns through the website or Telegram.",
      open_other_domain:"Open the other domain", open_primary_domain:"Open the primary .online domain", mirror_note:"Both addresses use the same database, queue and Telegram integration.",
      step1_title:"Paste a public URL", step1_text:"Copy a link from a supported source or use search in the Telegram bot.", step2_title:"Choose format and quality", step2_text:"Select MP3, M4A, OGG, OPUS, FLAC or WAV and the preferred quality.", step3_title:"Follow the shared queue", step3_text:"The Worker validates the request, queues it and displays progress through SSE.", step4_title:"Receive the result", step4_text:"Download from the website or receive the file in Telegram. Repeated requests can reuse the archive.",
      metric_formats:"formats", metric_sources:"sources", metric_updates:"live status", metric_language:"languages", metric_edge:"edge access",
      console_title:"Web console", console_text:"Submit a public URL, choose a format and follow the job in real time.", url_label:"Public URL", paste:"Paste", source_label:"Source", format_label:"Format", quality_label:"Quality", usage_note:"Use the platform only for content you are authorized to download or process.", launch:"Add to queue", activity_title:"Activity", clear:"Clear", empty_jobs:"No active jobs", empty_jobs_text:"The first request will appear here with live progress.",
      telegram_title:"The bot and website use the same system.", telegram_text:"The buttons first try the installed Telegram application. If the protocol is unavailable, the platform falls back to Telegram Web and does not rely only on t.me.", open_bot:"Open @download_killerBOT", open_telegram_web:"Open Telegram Web", copy_bot_handle:"Copy @download_killerBOT", open_web_miniapp:"Mini App web view", bot_handle_copied:"Telegram username copied.", telegram_fallback:"Opening Telegram Web…",
      engines_title:"What runs behind the interface", engines_text:"Web and Telegram use one control plane while processing components can be updated independently.", engine_edge:"REST API, D1, KV, Queues, SSE and protected file links.", engine_telegram:"Webhook, Mini App, shared queue, file archive and file reuse.", engine_downloader:"Isolated processing with FFmpeg and source fallback.", engine_metadata:"Metadata matching and alternative public sources.", public_core:"Public core", connected_surface:"Connected surface",
      status_title:"System status", refresh:"Refresh", status_edge:"Edge API", status_origin:"Downloader origin", status_formats:"Formats", status_latency:"Latency", recent_jobs:"Recent public jobs", new_job:"New job ↗", footer_text:"Web and Telegram workflow on one shared edge backend.",
      invalid_url:"Enter a valid public HTTP/HTTPS URL.", queued:"The job was added to the queue.", request_failed:"The request was not accepted.", copied:"URL pasted from clipboard.", clipboard_failed:"Clipboard access is unavailable.", download:"Download", processing:"processing", done:"done", failed:"failed", paused:"paused", waiting:"waiting", no_history:"No public history is available.", formats_ready:"available"
    },
    ru: {
      page_title:"Download Killer Platform", page_description:"Download Killer — веб- и Telegram-платформа с общей очередью, историей и файловым архивом.",
      nav_tutorial:"Как это работает", nav_console:"Консоль", nav_status:"Статус", checking:"Проверка", online:"ONLINE", offline:"OFFLINE",
      hero_eyebrow:"WEB · TELEGRAM · ОДНА ОЧЕРЕДЬ", hero_line_1:"Отправьте ссылку.", hero_line_2:"Получите готовый файл.", hero_text:"Download Killer объединяет сайт, Telegram-бота, Mini App, очередь и файловый архив на одном backend.",
      see_tutorial:"Как это работает", open_miniapp:"Открыть Telegram Mini App", live_progress:"Прогресс в реальном времени",
      tutorial_kicker:"БЫСТРЫЙ СТАРТ", tutorial_title:"Что это за система и как ей пользоваться", tutorial_intro:"Платформа принимает публичный URL, проверяет его, добавляет задачу в общую очередь и передаёт доступному backend. Результат возвращается через сайт или Telegram.",
      open_other_domain:"Открыть другой домен", open_primary_domain:"Открыть основной домен .online", mirror_note:"Оба адреса используют одну базу данных, очередь и Telegram-интеграцию.",
      step1_title:"Вставьте публичный URL", step1_text:"Скопируйте ссылку из поддерживаемого источника или используйте поиск в Telegram-боте.", step2_title:"Выберите формат и качество", step2_text:"Выберите MP3, M4A, OGG, OPUS, FLAC или WAV и нужное качество.", step3_title:"Следите за общей очередью", step3_text:"Worker проверяет запрос, ставит его в очередь и показывает прогресс через SSE.", step4_title:"Получите результат", step4_text:"Скачайте файл с сайта или получите его в Telegram. Повторные запросы могут использовать архив.",
      metric_formats:"форматов", metric_sources:"источников", metric_updates:"live-статус", metric_language:"языка", metric_edge:"edge-доступ",
      console_title:"Веб-консоль", console_text:"Отправьте публичный URL, выберите формат и следите за задачей в реальном времени.", url_label:"Публичный URL", paste:"Вставить", source_label:"Источник", format_label:"Формат", quality_label:"Качество", usage_note:"Используйте платформу только для контента, который вы имеете право скачивать или обрабатывать.", launch:"Добавить в очередь", activity_title:"Активность", clear:"Очистить", empty_jobs:"Нет активных задач", empty_jobs_text:"Первая заявка появится здесь с live-прогрессом.",
      telegram_title:"Бот и сайт используют одну систему.", telegram_text:"Кнопки сначала пытаются открыть установленное приложение Telegram. Если протокол недоступен, используется Telegram Web без зависимости только от t.me.", open_bot:"Открыть @download_killerBOT", open_telegram_web:"Открыть Telegram Web", copy_bot_handle:"Копировать @download_killerBOT", open_web_miniapp:"Web-версия Mini App", bot_handle_copied:"Имя Telegram скопировано.", telegram_fallback:"Открывается Telegram Web…",
      engines_title:"Что работает за интерфейсом", engines_text:"Web и Telegram используют единый control plane, а компоненты обработки обновляются независимо.", engine_edge:"REST API, D1, KV, Queues, SSE и защищённые ссылки на файлы.", engine_telegram:"Webhook, Mini App, общая очередь, файловый архив и повторная отправка.", engine_downloader:"Изолированная обработка с FFmpeg и source fallback.", engine_metadata:"Сопоставление метаданных и альтернативные публичные источники.", public_core:"Публичное ядро", connected_surface:"Подключённый интерфейс",
      status_title:"Состояние системы", refresh:"Обновить", status_edge:"Edge API", status_origin:"Downloader origin", status_formats:"Форматы", status_latency:"Задержка", recent_jobs:"Последние публичные задачи", new_job:"Новая задача ↗", footer_text:"Web и Telegram workflow на общем edge backend.",
      invalid_url:"Введите корректный публичный HTTP/HTTPS URL.", queued:"Задача добавлена в очередь.", request_failed:"Запрос не принят.", copied:"URL вставлен из буфера обмена.", clipboard_failed:"Буфер обмена недоступен.", download:"Скачать", processing:"обработка", done:"готово", failed:"ошибка", paused:"пауза", waiting:"ожидание", no_history:"Публичная история отсутствует.", formats_ready:"доступны"
    },
    de: {
      page_title:"Download Killer Platform", page_description:"Download Killer — Web- und Telegram-Plattform mit gemeinsamer Warteschlange, Verlauf und Dateiarchiv.",
      nav_tutorial:"So funktioniert es", nav_console:"Konsole", nav_status:"Status", checking:"Prüfung", online:"ONLINE", offline:"OFFLINE",
      hero_eyebrow:"WEB · TELEGRAM · EINE WARTESCHLANGE", hero_line_1:"Link einfügen.", hero_line_2:"Fertige Datei erhalten.", hero_text:"Download Killer verbindet Website, Telegram-Bot, Mini App, Warteschlange und Dateiarchiv auf einem gemeinsamen Backend.",
      see_tutorial:"Funktionsweise ansehen", open_miniapp:"Telegram Mini App öffnen", live_progress:"Live-Fortschritt",
      tutorial_kicker:"SCHNELLSTART", tutorial_title:"Was das System ist und wie es funktioniert", tutorial_intro:"Die Plattform nimmt eine öffentliche URL an, validiert sie, fügt den Auftrag einer gemeinsamen Warteschlange hinzu und übergibt ihn an das verfügbare Backend. Das Ergebnis kommt über die Website oder Telegram zurück.",
      open_other_domain:"Andere Domain öffnen", open_primary_domain:"Primäre .online-Domain öffnen", mirror_note:"Beide Adressen verwenden dieselbe Datenbank, Warteschlange und Telegram-Integration.",
      step1_title:"Öffentliche URL einfügen", step1_text:"Kopiere einen Link aus einer unterstützten Quelle oder nutze die Suche im Telegram-Bot.", step2_title:"Format und Qualität wählen", step2_text:"Wähle MP3, M4A, OGG, OPUS, FLAC oder WAV und die gewünschte Qualität.", step3_title:"Gemeinsame Warteschlange verfolgen", step3_text:"Der Worker validiert die Anfrage, reiht sie ein und zeigt den Fortschritt über SSE.", step4_title:"Ergebnis erhalten", step4_text:"Lade die Datei von der Website herunter oder erhalte sie in Telegram. Wiederholte Anfragen können das Archiv verwenden.",
      metric_formats:"Formate", metric_sources:"Quellen", metric_updates:"Live-Status", metric_language:"Sprachen", metric_edge:"Edge-Zugriff",
      console_title:"Web-Konsole", console_text:"Sende eine öffentliche URL, wähle ein Format und verfolge den Auftrag in Echtzeit.", url_label:"Öffentliche URL", paste:"Einfügen", source_label:"Quelle", format_label:"Format", quality_label:"Qualität", usage_note:"Nutze die Plattform nur für Inhalte, die du herunterladen oder verarbeiten darfst.", launch:"Zur Warteschlange", activity_title:"Aktivität", clear:"Leeren", empty_jobs:"Keine aktiven Aufträge", empty_jobs_text:"Die erste Anfrage erscheint hier mit Live-Fortschritt.",
      telegram_title:"Bot und Website verwenden dasselbe System.", telegram_text:"Die Schaltflächen versuchen zuerst, die installierte Telegram-App zu öffnen. Ist das Protokoll nicht verfügbar, wird Telegram Web verwendet und die Plattform ist nicht nur von t.me abhängig.", open_bot:"@download_killerBOT öffnen", open_telegram_web:"Telegram Web öffnen", copy_bot_handle:"@download_killerBOT kopieren", open_web_miniapp:"Mini App im Web", bot_handle_copied:"Telegram-Benutzername kopiert.", telegram_fallback:"Telegram Web wird geöffnet…",
      engines_title:"Was hinter der Oberfläche arbeitet", engines_text:"Web und Telegram nutzen eine gemeinsame Steuerebene, während Verarbeitungskomponenten unabhängig aktualisiert werden.", engine_edge:"REST API, D1, KV, Queues, SSE und geschützte Datei-Links.", engine_telegram:"Webhook, Mini App, gemeinsame Warteschlange, Dateiarchiv und Wiederverwendung.", engine_downloader:"Isolierte Verarbeitung mit FFmpeg und Source-Fallback.", engine_metadata:"Metadatenabgleich und alternative öffentliche Quellen.", public_core:"Öffentlicher Kern", connected_surface:"Verbundene Oberfläche",
      status_title:"Systemstatus", refresh:"Aktualisieren", status_edge:"Edge API", status_origin:"Downloader origin", status_formats:"Formate", status_latency:"Latenz", recent_jobs:"Letzte öffentliche Aufträge", new_job:"Neuer Auftrag ↗", footer_text:"Web- und Telegram-Workflow auf einem gemeinsamen Edge-Backend.",
      invalid_url:"Gib eine gültige öffentliche HTTP/HTTPS-URL ein.", queued:"Der Auftrag wurde zur Warteschlange hinzugefügt.", request_failed:"Die Anfrage wurde nicht akzeptiert.", copied:"URL aus der Zwischenablage eingefügt.", clipboard_failed:"Kein Zugriff auf die Zwischenablage.", download:"Herunterladen", processing:"Verarbeitung", done:"fertig", failed:"Fehler", paused:"pausiert", waiting:"wartet", no_history:"Kein öffentlicher Verlauf verfügbar.", formats_ready:"verfügbar"
    }
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const t = (key) => I18N[currentLang]?.[key] || I18N.en[key] || key;
  const escapeHtml = (value) => String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  const localeForLanguage = { bg:"bg-BG", en:"en-GB", ru:"ru-RU", de:"de-DE" };

  function applyLanguage() {
    document.documentElement.lang = currentLang;
    localStorage.setItem("da_platform_lang", currentLang);
    document.title = t("page_title");
    const meta = $('meta[name="description"]');
    if (meta) meta.content = t("page_description");
    const select = $("#languageSelect");
    if (select) select.value = currentLang;
    const button = $("#languageBtn");
    if (button) button.textContent = currentLang.toUpperCase();
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
    const startApp = mode === "miniapp" ? "&startapp=home" : "";
    const appUrl = `tg://resolve?domain=${BOT_USERNAME}${startApp}`;
    const webUrl = `https://web.telegram.org/k/#@${BOT_USERNAME}`;
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    frame.src = appUrl;
    document.body.appendChild(frame);
    const startedVisible = document.visibilityState === "visible";
    setTimeout(() => {
      frame.remove();
      if (startedVisible && document.visibilityState === "visible") {
        toast(t("telegram_fallback"), "info");
        window.location.assign(webUrl);
      }
    }, 1100);
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
      if (!["http:","https:"].includes(parsed.protocol)) return false;
      const host = parsed.hostname.toLowerCase();
      return Boolean(host && host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local") && !host.endsWith(".onion"));
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
    return t(["done","failed","processing","paused","queued"].includes(value) ? value : "waiting");
  }

  function progressFor(status) {
    return ({ done:100, failed:100, processing:58, paused:35, queued:12 })[String(status || "queued").toLowerCase()] || 12;
  }

  function readJobPayload(payload, fallback = {}) {
    const row = payload?.job || payload || {};
    return { ...fallback, id:String(row.id || row.jobId || row.job_id || fallback.id || ""), status:String(row.status || fallback.status || "queued").toLowerCase(), title:String(row.title || row.track || fallback.title || "Media job"), artist:String(row.artist || row.uploader || fallback.artist || "Download Killer"), format:String(row.format || fallback.format || "mp3"), quality:String(row.quality || fallback.quality || "best"), source:String(row.source || fallback.source || "all"), downloadUrl:String(row.download_url || row.downloadUrl || fallback.downloadUrl || ""), error:String(row.error_message || row.error || fallback.error || ""), updatedAt:Date.now() };
  }

  function renderJobs() {
    const feed = $("#jobFeed");
    if (!feed) return;
    const items = Array.from(jobs.values()).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
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
      const next = readJobPayload(payload, jobs.get(jobId)); jobs.set(jobId, next); renderJobs();
      if (["done","failed"].includes(next.status)) { closeStream(jobId); return; }
    } catch { /* SSE may still be active. */ }
    setTimeout(() => void pollJob(jobId, attempts + 1), 3500);
  }

  function subscribeJob(jobId) {
    if (!("EventSource" in window)) { void pollJob(jobId); return; }
    closeStream(jobId);
    const source = new EventSource(`${API_BASE}/job/${encodeURIComponent(jobId)}/events`);
    streams.set(jobId, source);
    source.onmessage = (event) => { try { const next = readJobPayload(JSON.parse(event.data), jobs.get(jobId)); jobs.set(jobId, next); renderJobs(); if (["done","failed"].includes(next.status)) closeStream(jobId); } catch { /* heartbeat */ } };
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
    const body = { url, source:sourceSelect.value || "all", format:$("#formatSelect").value || "mp3", quality:$("#qualitySelect").value || "best", client_id:"platform-v12", added_by:"download-killer-home" };
    try {
      const payload = await apiJson("/download", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
      const jobId = String(payload.jobId || payload.job_id || payload.id || "");
      if (!jobId) throw new Error("Backend response did not include a job id");
      jobs.set(jobId, { id:jobId, status:String(payload.status || "queued").toLowerCase(), title:url, artist:body.source.toUpperCase(), format:body.format, quality:body.quality, source:body.source, downloadUrl:"", error:"", createdAt:Date.now() });
      renderJobs(); subscribeJob(jobId); toast(t("queued"), "success"); input.value = "";
    } catch (error) { toast(`${t("request_failed")} ${error.message || error}`, "error"); }
    finally { button.disabled = false; }
  }

  function updateHealthChip(state) { const chip = $("#globalHealth"); if (!chip) return; chip.dataset.state = state; const label = $("b", chip); if (label) label.textContent = t(state === "online" ? "online" : state === "offline" ? "offline" : "checking"); }
  function setStatus(selector, value, state = "") { const node = $(selector); if (!node) return; node.textContent = value; node.classList.remove("online","offline"); if (state) node.classList.add(state); }

  async function loadSystemStatus() {
    updateHealthChip("checking");
    const started = performance.now(); let healthOk = false;
    try { const health = await apiJson("/health", {}, 12000); healthOk = Boolean(health && (health.ok === true || health.status === "ok" || health.status === "healthy")); setStatus("#edgeStatus", healthOk ? t("online") : t("offline"), healthOk ? "online" : "offline"); $("#edgeDetail").textContent = String(health.service || health.version || "Cloudflare Worker"); }
    catch (error) { setStatus("#edgeStatus", t("offline"), "offline"); $("#edgeDetail").textContent = String(error.message || error).slice(0,80); }
    $("#latencyStatus").textContent = `${Math.max(1, Math.round(performance.now() - started))} ms`;
    try { const config = await apiJson("/runtime-config", {}, 12000); const origin = config.downloader_api_url || config.downloaderApiUrl || config.api_base || config.public_base || "configured"; setStatus("#originStatus", t("online"), "online"); $("#originDetail").textContent = String(origin).replace(/^https?:\/\//,"").slice(0,52); }
    catch (error) { setStatus("#originStatus", t("offline"), "offline"); $("#originDetail").textContent = String(error.message || error).slice(0,80); }
    try { const payload = await apiJson("/formats", {}, 12000); const list = Array.isArray(payload) ? payload : (payload.formats || payload.items || []); setStatus("#formatStatus", String(Array.isArray(list) && list.length ? list.length : 6), "online"); $("#formatDetail").textContent = t("formats_ready"); }
    catch { setStatus("#formatStatus", "6", "online"); $("#formatDetail").textContent = "MP3 · M4A · OGG · OPUS · FLAC · WAV"; }
    updateHealthChip(healthOk ? "online" : "offline");
  }

  function normalizeHistory(payload) { if (Array.isArray(payload)) return payload; return payload?.jobs || payload?.items || payload?.results || payload?.history || []; }
  async function loadHistory() {
    const list = $("#historyList"); if (!list) return;
    try {
      const payload = await apiJson("/history?limit=6&offset=0", {}, 12000); const rows = normalizeHistory(payload).slice(0,6);
      if (!rows.length) { list.innerHTML = `<div class="history-row"><i></i><b>${escapeHtml(t("no_history"))}</b><span>—</span><time>—</time></div>`; return; }
      list.innerHTML = rows.map((row) => { const status = String(row.status || "queued").toLowerCase(); const title = row.title || row.url || row.id || "Media job"; const format = String(row.format || "").toUpperCase(); const created = row.created_at || row.createdAt || row.updated_at || row.updatedAt; const time = created ? new Date(created).toLocaleString(localeForLanguage[currentLang], { dateStyle:"short", timeStyle:"short" }) : "—"; return `<div class="history-row"><i class="${escapeHtml(status)}"></i><b>${escapeHtml(title)}</b><span>${escapeHtml(format)} · ${escapeHtml(statusLabel(status))}</span><time>${escapeHtml(time)}</time></div>`; }).join("");
    } catch (error) { list.innerHTML = `<div class="history-row"><i class="failed"></i><b>${escapeHtml(t("no_history"))}</b><span>${escapeHtml(String(error.message || error).slice(0,60))}</span><time>—</time></div>`; }
  }

  function setupReveal() {
    if (!("IntersectionObserver" in window)) { $$(".reveal").forEach((node) => node.classList.add("visible")); return; }
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add("visible"); observer.unobserve(entry.target); } }), { threshold:.12 });
    $$(".reveal").forEach((node) => observer.observe(node));
  }

  function animateMetrics() {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    $$('[data-count]').forEach((node) => { const target = Number(node.dataset.count || 0); if (reduced) { node.textContent = String(target); return; } const started = performance.now(); const tick = (now) => { const progress = Math.min(1,(now-started)/950); node.textContent = String(Math.round(target*(1-Math.pow(1-progress,3)))); if (progress < 1) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  }

  function setupCanvas() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = $("#signalCanvas"); if (!canvas) return;
    const context = canvas.getContext("2d", {alpha:true}); const points = []; let width=0,height=0,dpr=1,mouseX=-1000,mouseY=-1000;
    const resize = () => { dpr=Math.min(devicePixelRatio || 1,2); width=innerWidth; height=innerHeight; canvas.width=Math.floor(width*dpr); canvas.height=Math.floor(height*dpr); canvas.style.width=`${width}px`; canvas.style.height=`${height}px`; context.setTransform(dpr,0,0,dpr,0,0); points.length=0; const count=Math.min(90,Math.max(30,Math.floor((width*height)/19000))); for(let i=0;i<count;i++) points.push({x:Math.random()*width,y:Math.random()*height,vx:(Math.random()-.5)*.18,vy:(Math.random()-.5)*.18,r:Math.random()*1.5+.4}); };
    addEventListener("resize",resize,{passive:true}); addEventListener("pointermove",(event)=>{mouseX=event.clientX;mouseY=event.clientY;},{passive:true}); resize();
    const frame=()=>{context.clearRect(0,0,width,height);points.forEach((point,index)=>{point.x+=point.vx;point.y+=point.vy;if(point.x<-10)point.x=width+10;if(point.x>width+10)point.x=-10;if(point.y<-10)point.y=height+10;if(point.y>height+10)point.y=-10;const md=Math.hypot(point.x-mouseX,point.y-mouseY);if(md<130&&md>.01){point.x+=(point.x-mouseX)/md*.35;point.y+=(point.y-mouseY)/md*.35;}context.beginPath();context.fillStyle=index%4===0?"rgba(201,255,75,.52)":"rgba(126,151,255,.32)";context.arc(point.x,point.y,point.r,0,Math.PI*2);context.fill();for(let j=index+1;j<points.length;j++){const other=points[j];const distance=Math.hypot(point.x-other.x,point.y-other.y);if(distance<105){context.beginPath();context.strokeStyle=`rgba(120,145,230,${(1-distance/105)*.09})`;context.moveTo(point.x,point.y);context.lineTo(other.x,other.y);context.stroke();}}});requestAnimationFrame(frame);};requestAnimationFrame(frame);
  }

  function setupMagneticButtons() { if (matchMedia("(pointer: coarse)").matches) return; $$(".magnetic").forEach((node) => { node.addEventListener("pointermove",(event)=>{const rect=node.getBoundingClientRect();node.style.transform=`translate(${(event.clientX-rect.left-rect.width/2)*.09}px,${(event.clientY-rect.top-rect.height/2)*.13-3}px)`;});node.addEventListener("pointerleave",()=>{node.style.transform="";}); }); }

  function bindEvents() {
    const languageSelect = $("#languageSelect");
    if (languageSelect) languageSelect.addEventListener("change", () => { currentLang = SUPPORTED_LANGUAGES.includes(languageSelect.value) ? languageSelect.value : "bg"; applyLanguage(); void loadHistory(); void loadSystemStatus(); });
    const legacyButton = $("#languageBtn");
    if (legacyButton) legacyButton.addEventListener("click", () => { currentLang = SUPPORTED_LANGUAGES[(SUPPORTED_LANGUAGES.indexOf(currentLang)+1)%SUPPORTED_LANGUAGES.length]; applyLanguage(); void loadHistory(); void loadSystemStatus(); });
    $("#downloadForm")?.addEventListener("submit",submitDownload);
    $("#mediaUrl")?.addEventListener("input",(event)=>{if($("#sourceSelect").value==="all"){const source=detectSource(event.target.value);if(source!=="all")$("#sourceSelect").value=source;}});
    $("#formatSelect")?.addEventListener("change",(event)=>{const quality=$("#qualitySelect");const lossless=["flac","wav"].includes(event.target.value);if(lossless&&!['best','lossless'].includes(quality.value))quality.value="best";else if(!lossless&&quality.value==="lossless")quality.value="best";});
    $("#pasteBtn")?.addEventListener("click",async()=>{try{const value=await navigator.clipboard.readText();$("#mediaUrl").value=value.trim();const source=detectSource(value);if(source!=="all")$("#sourceSelect").value=source;toast(t("copied"),"success");}catch{toast(t("clipboard_failed"),"error");}});
    $("#clearJobsBtn")?.addEventListener("click",()=>{jobs.forEach((_,id)=>closeStream(id));jobs.clear();renderJobs();});
    $("#refreshStatusBtn")?.addEventListener("click",()=>{void loadSystemStatus();void loadHistory();});
    $$(".telegram-link").forEach((link)=>link.addEventListener("click",(event)=>{event.preventDefault();openTelegram(link.dataset.telegramMode || "bot");}));
    $("#copyBotHandleBtn")?.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(`@${BOT_USERNAME}`);toast(t("bot_handle_copied"),"success");}catch{toast(t("clipboard_failed"),"error");}});
  }

  async function init() {
    const year=$("#year");if(year)year.textContent=String(new Date().getFullYear());
    applyLanguage();bindEvents();setupReveal();animateMetrics();setupCanvas();setupMagneticButtons();renderJobs();
    await Promise.allSettled([loadSystemStatus(),loadHistory()]);
  }

  addEventListener("beforeunload",()=>streams.forEach((source)=>source.close()));
  document.addEventListener("DOMContentLoaded",()=>void init());
})();