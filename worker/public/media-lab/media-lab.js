(() => {
  "use strict";

  const API = "/api";
  const LANGS = ["bg", "en", "ru", "de"];
  let lang = LANGS.includes(localStorage.getItem("da_platform_lang"))
    ? localStorage.getItem("da_platform_lang")
    : "bg";

  const COPY = {
    bg: {
      nav: "Media Lab", kicker: "SAVEHERE + FLUENTDL IDEAS", title: "Инспекция и интелигентно съпоставяне",
      intro: "Провери публичен линк преди задача и намери най-близките съвпадения между различни източници.", badge: "URL INSPECT · MATCH SCORE",
      inspectTitle: "Инспектор на публичен URL", inspectText: "Показва крайния адрес, filename, MIME тип, размер, redirects и поддръжка на HTTP Range.", inspect: "Провери текущия URL",
      matchTitle: "Cross-source Match Finder", matchText: "Извлича метаданни, търси алтернативни публични резултати и ги подрежда по заглавие, изпълнител, албум и продължителност.", match: "Намери алтернативи",
      emptyInspect: "Постави публичен URL в web конзолата и натисни проверка.", emptyMatch: "Постави линк към песен и стартирай съпоставянето.", loading: "Проверка…", matching: "Търсене и оценяване…",
      noUrl: "Първо въведи валиден публичен URL в конзолата.", inspectFailed: "Инспекцията не успя", matchFailed: "Съпоставянето не успя", noMatches: "Няма намерени подходящи алтернативи.",
      filename: "Име", type: "Тип", size: "Размер", status: "HTTP", range: "Resume / Range", redirects: "Redirects", finalHost: "Краен адрес", cache: "Cache", yes: "Да", no: "Не", use: "Използвай", source: "Източник", confidence: "Увереност",
      high: "висока", medium: "средна", low: "ниска", applied: "Резултатът е поставен в конзолата.", attribution: "Функционалните идеи са адаптирани от SaveHere (Apache-2.0) и FluentDL (MIT); реализацията е оригинална за Download Killer.",
    },
    en: {
      nav: "Media Lab", kicker: "SAVEHERE + FLUENTDL IDEAS", title: "Inspection and intelligent matching",
      intro: "Inspect a public link before queueing it and find the closest matches across different sources.", badge: "URL INSPECT · MATCH SCORE",
      inspectTitle: "Public URL inspector", inspectText: "Shows the final address, filename, MIME type, size, redirects and HTTP Range support.", inspect: "Inspect current URL",
      matchTitle: "Cross-source Match Finder", matchText: "Reads metadata, searches public alternatives and ranks them by title, artist, album and duration.", match: "Find alternatives",
      emptyInspect: "Paste a public URL in the web console and run inspection.", emptyMatch: "Paste a track link and start matching.", loading: "Inspecting…", matching: "Searching and scoring…",
      noUrl: "Enter a valid public URL in the console first.", inspectFailed: "Inspection failed", matchFailed: "Matching failed", noMatches: "No suitable alternatives were found.",
      filename: "Filename", type: "Type", size: "Size", status: "HTTP", range: "Resume / Range", redirects: "Redirects", finalHost: "Final address", cache: "Cache", yes: "Yes", no: "No", use: "Use", source: "Source", confidence: "Confidence",
      high: "high", medium: "medium", low: "low", applied: "The result was placed in the console.", attribution: "Feature ideas adapted from SaveHere (Apache-2.0) and FluentDL (MIT); implementation is original to Download Killer.",
    },
    ru: {
      nav: "Media Lab", kicker: "ИДЕИ SAVEHERE + FLUENTDL", title: "Проверка и интеллектуальное сопоставление",
      intro: "Проверьте публичную ссылку перед добавлением в очередь и найдите ближайшие совпадения в разных источниках.", badge: "URL INSPECT · MATCH SCORE",
      inspectTitle: "Инспектор публичного URL", inspectText: "Показывает конечный адрес, имя файла, MIME-тип, размер, перенаправления и поддержку HTTP Range.", inspect: "Проверить текущий URL",
      matchTitle: "Поиск совпадений между источниками", matchText: "Получает метаданные, ищет публичные альтернативы и сортирует их по названию, исполнителю, альбому и длительности.", match: "Найти альтернативы",
      emptyInspect: "Вставьте публичный URL в веб-консоль и запустите проверку.", emptyMatch: "Вставьте ссылку на трек и запустите сопоставление.", loading: "Проверка…", matching: "Поиск и оценка…",
      noUrl: "Сначала введите корректный публичный URL.", inspectFailed: "Проверка не удалась", matchFailed: "Сопоставление не удалось", noMatches: "Подходящие альтернативы не найдены.",
      filename: "Имя", type: "Тип", size: "Размер", status: "HTTP", range: "Resume / Range", redirects: "Redirects", finalHost: "Конечный адрес", cache: "Cache", yes: "Да", no: "Нет", use: "Выбрать", source: "Источник", confidence: "Уверенность",
      high: "высокая", medium: "средняя", low: "низкая", applied: "Результат помещён в консоль.", attribution: "Идеи функций адаптированы из SaveHere (Apache-2.0) и FluentDL (MIT); реализация оригинальна для Download Killer.",
    },
    de: {
      nav: "Media Lab", kicker: "SAVEHERE + FLUENTDL IDEEN", title: "Prüfung und intelligentes Matching",
      intro: "Prüfe einen öffentlichen Link vor dem Einreihen und finde die ähnlichsten Treffer über mehrere Quellen.", badge: "URL INSPECT · MATCH SCORE",
      inspectTitle: "Inspektor für öffentliche URLs", inspectText: "Zeigt Zieladresse, Dateiname, MIME-Typ, Größe, Weiterleitungen und HTTP-Range-Unterstützung.", inspect: "Aktuelle URL prüfen",
      matchTitle: "Quellenübergreifender Match Finder", matchText: "Liest Metadaten, sucht öffentliche Alternativen und bewertet Titel, Künstler, Album und Dauer.", match: "Alternativen finden",
      emptyInspect: "Füge eine öffentliche URL in die Web-Konsole ein und starte die Prüfung.", emptyMatch: "Füge einen Track-Link ein und starte das Matching.", loading: "Prüfung…", matching: "Suche und Bewertung…",
      noUrl: "Gib zuerst eine gültige öffentliche URL ein.", inspectFailed: "Prüfung fehlgeschlagen", matchFailed: "Matching fehlgeschlagen", noMatches: "Keine passenden Alternativen gefunden.",
      filename: "Dateiname", type: "Typ", size: "Größe", status: "HTTP", range: "Resume / Range", redirects: "Redirects", finalHost: "Zieladresse", cache: "Cache", yes: "Ja", no: "Nein", use: "Verwenden", source: "Quelle", confidence: "Konfidenz",
      high: "hoch", medium: "mittel", low: "niedrig", applied: "Der Treffer wurde in die Konsole übernommen.", attribution: "Funktionsideen aus SaveHere (Apache-2.0) und FluentDL (MIT); die Implementierung ist eigenständig für Download Killer.",
    },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const t = (key) => COPY[lang]?.[key] || COPY.en[key] || key;
  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  async function api(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${API}${path}`, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || payload?.detail || `HTTP ${response.status}`);
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  function validUrl(raw) {
    try {
      const url = new URL(raw);
      return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.hostname.endsWith(".local") && !url.hostname.endsWith(".onion");
    } catch {
      return false;
    }
  }

  function currentUrl() {
    return $("#mediaUrl")?.value?.trim() || "";
  }

  function toast(message, type = "success") {
    const region = $("#toastRegion");
    if (!region) return;
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = message;
    region.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }

  function insertUi() {
    if ($("#mediaLab")) return;
    const consoleSection = $("#console");
    if (!consoleSection) return;

    const section = document.createElement("section");
    section.id = "mediaLab";
    section.className = "media-lab-section reveal visible";
    section.innerHTML = `
      <div class="media-lab-heading">
        <div><span class="kicker" data-ml="kicker"></span><h2 data-ml="title"></h2><p data-ml="intro"></p></div>
        <div class="media-lab-badge" data-ml="badge"></div>
      </div>
      <div class="media-lab-grid">
        <article class="media-lab-panel">
          <div class="media-lab-panel-header"><div><span>DIRECT LINK</span><h3 data-ml="inspectTitle"></h3></div><code>POST /api/media-lab/inspect</code></div>
          <p class="media-lab-attribution" data-ml="inspectText"></p>
          <div class="media-lab-actions"><button class="media-lab-button primary" id="mediaInspectBtn" type="button" data-ml="inspect"></button></div>
          <div class="media-lab-result" id="mediaInspectResult"></div>
        </article>
        <article class="media-lab-panel">
          <div class="media-lab-panel-header"><div><span>MATCH ENGINE</span><h3 data-ml="matchTitle"></h3></div><code>PREVIEW → SEARCH → RANK</code></div>
          <p class="media-lab-attribution" data-ml="matchText"></p>
          <div class="media-lab-actions"><button class="media-lab-button primary" id="mediaMatchBtn" type="button" data-ml="match"></button></div>
          <div class="media-lab-result" id="mediaMatchResult"></div>
        </article>
      </div>
      <p class="media-lab-attribution" data-ml="attribution"></p>`;
    consoleSection.insertAdjacentElement("afterend", section);

    const nav = $(".nav-links");
    if (nav && !nav.querySelector('a[href="#mediaLab"]')) {
      const link = document.createElement("a");
      link.href = "#mediaLab";
      link.dataset.ml = "nav";
      nav.insertBefore(link, nav.querySelector('a[href="#telegram"]') || null);
    }

    $("#mediaInspectBtn")?.addEventListener("click", inspectUrl);
    $("#mediaMatchBtn")?.addEventListener("click", findMatches);
    renderLanguage();
  }

  function renderLanguage() {
    document.querySelectorAll("[data-ml]").forEach((node) => {
      node.textContent = t(node.dataset.ml);
    });
    const inspect = $("#mediaInspectResult");
    const matches = $("#mediaMatchResult");
    if (inspect && !inspect.dataset.rendered) inspect.innerHTML = `<div class="media-lab-empty">${esc(t("emptyInspect"))}</div>`;
    if (matches && !matches.dataset.rendered) matches.innerHTML = `<div class="media-lab-empty">${esc(t("emptyMatch"))}</div>`;
  }

  function loading(target, message) {
    target.dataset.rendered = "1";
    target.innerHTML = `<div class="media-lab-loading">${esc(message)}</div>`;
  }

  function error(target, prefix, err) {
    target.dataset.rendered = "1";
    target.innerHTML = `<div class="media-lab-error">${esc(prefix)}: ${esc(err?.message || err)}</div>`;
  }

  async function inspectUrl() {
    const url = currentUrl();
    const target = $("#mediaInspectResult");
    const button = $("#mediaInspectBtn");
    if (!validUrl(url)) return toast(t("noUrl"), "error");
    button.disabled = true;
    loading(target, t("loading"));
    try {
      const payload = await api("/media-lab/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      renderInspection(payload.inspection || {});
    } catch (err) {
      error(target, t("inspectFailed"), err);
    } finally {
      button.disabled = false;
    }
  }

  function renderInspection(row) {
    const target = $("#mediaInspectResult");
    target.dataset.rendered = "1";
    const finalUrl = String(row.final_url || row.requested_url || "");
    const host = (() => { try { return new URL(finalUrl).hostname; } catch { return finalUrl; } })();
    const warnings = Array.isArray(row.warnings) ? row.warnings : [];
    target.innerHTML = `<div class="media-lab-inspection">
      ${stat(t("filename"), row.filename || "—")}
      ${stat(t("type"), `${row.category || "unknown"} · ${row.content_type || "unknown"}`)}
      ${stat(t("size"), row.size_text || "unknown")}
      ${stat(t("status"), `${row.status || "—"} · ${row.method || "—"}`)}
      ${stat(t("range"), row.supports_ranges ? t("yes") : t("no"), row.supports_ranges ? "good" : "")}
      ${stat(t("redirects"), String((row.redirects || []).length))}
      ${stat(t("finalHost"), `<a href="${esc(finalUrl)}" target="_blank" rel="noreferrer">${esc(host || "—")}</a>`, "", true)}
      ${stat(t("cache"), row.cache_control || row.etag || "—")}
      <div class="media-lab-stat wide"><small>Signals</small><div class="media-lab-chip-row">
        <span class="media-lab-chip ${row.ok ? "good" : ""}">${row.ok ? "reachable" : "unavailable"}</span>
        <span class="media-lab-chip ${row.supports_ranges ? "good" : ""}">${row.supports_ranges ? "range-ready" : "single-stream"}</span>
        ${warnings.map((item) => `<span class="media-lab-chip">${esc(item)}</span>`).join("")}
      </div></div>
    </div>`;
  }

  function stat(label, value, className = "", raw = false) {
    return `<div class="media-lab-stat ${className}"><small>${esc(label)}</small><strong>${raw ? value : esc(value)}</strong></div>`;
  }

  async function findMatches() {
    const url = currentUrl();
    const target = $("#mediaMatchResult");
    const button = $("#mediaMatchBtn");
    if (!validUrl(url)) return toast(t("noUrl"), "error");
    button.disabled = true;
    loading(target, t("matching"));
    try {
      const selectedSource = $("#sourceSelect")?.value || "all";
      const preview = await api("/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: url, url, source: selectedSource }),
      });
      const title = preview.title || preview.track || "";
      const artist = preview.artist || preview.uploader || "";
      if (!title) throw new Error("Metadata preview did not return a title");
      const query = [artist, title].filter(Boolean).join(" ");
      const search = await api("/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, source: "all", limit: 20 }),
      });
      const candidates = Array.isArray(search) ? search : (search.results || search.items || []);
      if (!candidates.length) return renderMatches([]);
      const ranked = await api("/media-lab/rank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference: { title, artist, album: preview.album || null, duration: preview.duration || 0, source: preview.source || selectedSource },
          candidates,
        }),
      });
      renderMatches(ranked.results || []);
    } catch (err) {
      error(target, t("matchFailed"), err);
    } finally {
      button.disabled = false;
    }
  }

  function renderMatches(rows) {
    const target = $("#mediaMatchResult");
    target.dataset.rendered = "1";
    const useful = rows.filter((row) => row.url).slice(0, 7);
    if (!useful.length) {
      target.innerHTML = `<div class="media-lab-empty">${esc(t("noMatches"))}</div>`;
      return;
    }
    target.innerHTML = `<div class="media-lab-match-list">${useful.map((row, index) => {
      const confidence = ["high", "medium", "low"].includes(row.confidence) ? row.confidence : "low";
      const reasons = Array.isArray(row.reasons) ? row.reasons.join(" · ") : "";
      return `<article class="media-lab-match">
        <div class="media-lab-score ${confidence}">${esc(row.score || 0)}%</div>
        <div class="media-lab-match-copy"><strong>${esc(row.title || "Media result")}</strong><span>${esc(row.artist || "—")} · ${esc(String(row.source || "unknown").toUpperCase())}</span><small>${esc(`${t("confidence")}: ${t(confidence)}${reasons ? ` · ${reasons}` : ""}`)}</small></div>
        <button class="media-lab-use" type="button" data-index="${index}">${esc(t("use"))}</button>
      </article>`;
    }).join("")}</div>`;
    target.querySelectorAll(".media-lab-use").forEach((button) => {
      button.addEventListener("click", () => {
        const row = useful[Number(button.dataset.index)];
        const input = $("#mediaUrl");
        if (input) {
          input.value = row.url;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        if ($("#sourceSelect") && row.source) $("#sourceSelect").value = String(row.source).toLowerCase();
        toast(t("applied"));
      });
    });
  }

  function bindLanguage() {
    const select = $("#languageSelect");
    if (!select) return;
    select.addEventListener("change", () => {
      lang = LANGS.includes(select.value) ? select.value : "bg";
      setTimeout(renderLanguage, 0);
    });
  }

  function init() {
    insertUi();
    bindLanguage();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
