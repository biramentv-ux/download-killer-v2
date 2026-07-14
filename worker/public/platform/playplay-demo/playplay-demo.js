(() => {
  "use strict";

  const SAMPLE_SPOTIFY_URL = "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b";
  const DEMO_ROOT = "C:\\playplay-demo";
  const DEMO_CAPABILITIES = Object.freeze({
    network_access: false,
    subprocess_execution: false,
    credential_storage: false,
    cookie_loading: false,
    wvd_loading: false,
    key_loading: false,
    drm_decryption: false,
  });
  const SPOTIFY_REFERENCE_RE = /^(?:https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:track|album|playlist|show|episode)\/[A-Za-z0-9]+(?:\?.*)?|spotify:(?:track|album|playlist|show|episode):[A-Za-z0-9]+)$/i;

  const I18N = {
    bg: {
      safe_mode: "SAFE PREVIEW", back: "Към платформата", eyebrow: "PLAYPLAY · NON-EXECUTABLE RESEARCH UI",
      title_a: "Виж структурата.", title_b: "Не стартирай DRM.",
      intro: "Генерирай фиктивен config.json и command preview за UI тестове. Страницата не изпраща мрежови заявки, не стартира процеси и не зарежда cookies, WVD/CDM профили или ключове.",
      builder: "Demo builder", spotify_ref: "Публичен Spotify URL или URI", sample: "Пример", quality: "Demo качество",
      warning: "Не поставяй реални cookies, device.wvd, CDM профили, пароли, tokens или content keys. Тези данни не са нужни за демото.",
      generate: "Генерирай безопасен preview", preview: "Preview output", empty: "Няма генериран preview",
      empty_text: "Използвай примерния URL или въведи публична Spotify референция.", copy: "Копирай JSON", download: "Запази .demo.json",
      capabilities: "Твърдо изключени способности", capabilities_text: "Това са runtime ограничения, не маркетингови обещания, написани с дребен шрифт.",
      flow_input: "локална валидация", flow_config: "фиктивни placeholders", flow_export: "без изпълнение",
      footer: "Документационен и UI прототип. Не е downloader или decryptor.",
      invalid: "Въведи валиден публичен Spotify URL или URI.", generated: "Безопасният demo preview е генериран.",
      copied: "Demo JSON е копиран.", saved: "Файлът playplay.demo.json е записан.", clipboard_error: "Клипбордът не е достъпен.",
    },
    en: {
      safe_mode: "SAFE PREVIEW", back: "Back to platform", eyebrow: "PLAYPLAY · NON-EXECUTABLE RESEARCH UI",
      title_a: "Inspect the shape.", title_b: "Do not run DRM.",
      intro: "Generate a fake config.json and command preview for UI testing. The page makes no network requests, launches no processes, and loads no cookies, WVD/CDM profiles, or keys.",
      builder: "Demo builder", spotify_ref: "Public Spotify URL or URI", sample: "Sample", quality: "Demo quality",
      warning: "Do not enter real cookies, device.wvd files, CDM profiles, passwords, tokens, or content keys. They are not needed for this demo.",
      generate: "Generate safe preview", preview: "Preview output", empty: "No preview generated",
      empty_text: "Use the sample URL or enter a public Spotify reference.", copy: "Copy JSON", download: "Save .demo.json",
      capabilities: "Hard-disabled capabilities", capabilities_text: "These are runtime restrictions, not marketing promises written in tiny type.",
      flow_input: "local validation", flow_config: "fake placeholders", flow_export: "no execution",
      footer: "Documentation and UI prototype. It is not a downloader or decryptor.",
      invalid: "Enter a valid public Spotify URL or URI.", generated: "The safe demo preview was generated.",
      copied: "Demo JSON copied.", saved: "playplay.demo.json was saved.", clipboard_error: "Clipboard access is unavailable.",
    },
  };

  let currentLanguage = localStorage.getItem("da_platform_lang") === "en" ? "en" : "bg";
  let currentPayload = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const t = (key) => I18N[currentLanguage][key] || I18N.en[key] || key;

  function applyLanguage() {
    document.documentElement.lang = currentLanguage;
    localStorage.setItem("da_platform_lang", currentLanguage);
    $("#languageBtn").textContent = currentLanguage.toUpperCase();
    $$('[data-i18n]').forEach((node) => {
      const value = t(node.dataset.i18n);
      if (value) node.textContent = value;
    });
  }

  function toast(message, type = "success") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = message;
    $("#toastRegion").appendChild(node);
    window.setTimeout(() => node.remove(), 3600);
  }

  function normalizeReference(raw) {
    const value = String(raw || "").trim();
    return SPOTIFY_REFERENCE_RE.test(value) ? value : "";
  }

  function normalizeQuality(raw) {
    const value = Number.parseInt(String(raw || "320"), 10);
    return [96, 160, 320].includes(value) ? value : 320;
  }

  function buildDemoPayload(reference, quality) {
    const spotifyReference = normalizeReference(reference);
    if (!spotifyReference) throw new Error(t("invalid"));
    const normalizedQuality = normalizeQuality(quality);
    const configPreview = {
      cookies_path: `${DEMO_ROOT}\\DEMO_COOKIES_NOT_REAL.txt`,
      wvd_path: `${DEMO_ROOT}\\DEMO_DEVICE_NOT_REAL.wvd`,
      output_dir: `${DEMO_ROOT}\\output-DEMO-ONLY`,
      quality: normalizedQuality,
    };
    const commandPreview = [
      `${DEMO_ROOT}\\playplay-DEMO-ONLY.exe`,
      "--config",
      `${DEMO_ROOT}\\config.demo.json`,
      "--url",
      spotifyReference,
    ];
    return {
      demo_only: true,
      adapter: "playplay-safe-preview",
      version: "0.1.0",
      input: {
        spotify_reference: spotifyReference,
        quality_kbps: normalizedQuality,
      },
      config_preview: configPreview,
      command_preview: commandPreview,
      capabilities: { ...DEMO_CAPABILITIES },
      notice: "Preview only. No executable is launched and no protected credentials or device files are read.",
    };
  }

  function validateDemoPayload(payload) {
    if (!payload || payload.demo_only !== true || payload.adapter !== "playplay-safe-preview") return false;
    if (!payload.capabilities || Object.values(payload.capabilities).some((value) => value !== false)) return false;
    const config = payload.config_preview || {};
    const protectedPreviewValues = [config.cookies_path, config.wvd_path, config.output_dir];
    if (protectedPreviewValues.some((value) => !String(value || "").toUpperCase().includes("DEMO"))) return false;
    const command = Array.isArray(payload.command_preview) ? payload.command_preview : [];
    return command.length >= 5 && String(command[0]).toUpperCase().includes("DEMO");
  }

  function commandAsText(payload) {
    return payload.command_preview.map((part) => `"${String(part).replaceAll('"', '\\"')}"`).join(" ");
  }

  function renderPayload(payload) {
    if (!validateDemoPayload(payload)) throw new Error("Unsafe demo payload rejected.");
    currentPayload = payload;
    $("#emptyPreview").classList.add("hidden");
    $("#previewContent").classList.remove("hidden");
    $("#configPreview").textContent = JSON.stringify(payload, null, 2);
    $("#commandPreview").textContent = [
      "# PREVIEW ONLY · NOT EXECUTED",
      commandAsText(payload),
      "",
      "# capabilities",
      JSON.stringify(payload.capabilities, null, 2),
    ].join("\n");
    $("#previewState").textContent = "SAFE PAYLOAD READY";
  }

  async function copyPayload() {
    if (!currentPayload) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(currentPayload, null, 2));
      toast(t("copied"));
    } catch {
      toast(t("clipboard_error"), "error");
    }
  }

  function downloadPayload() {
    if (!currentPayload || !validateDemoPayload(currentPayload)) return;
    const blob = new Blob([JSON.stringify(currentPayload, null, 2)], { type: "application/json;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "playplay.demo.json";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    toast(t("saved"));
  }

  function bindPreviewTabs() {
    $$('[data-preview-tab]').forEach((button) => {
      button.addEventListener("click", () => {
        $$('[data-preview-tab]').forEach((node) => node.classList.toggle("active", node === button));
        const configMode = button.dataset.previewTab === "config";
        $("#configPreview").classList.toggle("hidden", !configMode);
        $("#commandPreview").classList.toggle("hidden", configMode);
      });
    });
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
    }, { threshold: 0.12 });
    $$(".reveal").forEach((node) => observer.observe(node));
  }

  function setupCanvas() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = $("#demoCanvas");
    const context = canvas.getContext("2d", { alpha: true });
    let width = 0;
    let height = 0;
    let ratio = 1;
    let lines = [];

    const reset = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      lines = Array.from({ length: Math.min(42, Math.max(18, Math.floor(width / 30))) }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        speed: .12 + Math.random() * .28,
        length: 30 + Math.random() * 120,
        alpha: .025 + Math.random() * .08,
      }));
    };
    reset();
    window.addEventListener("resize", reset, { passive: true });

    const frame = () => {
      context.clearRect(0, 0, width, height);
      for (const line of lines) {
        line.y += line.speed;
        if (line.y - line.length > height) {
          line.y = -line.length;
          line.x = Math.random() * width;
        }
        const gradient = context.createLinearGradient(line.x, line.y - line.length, line.x, line.y);
        gradient.addColorStop(0, "rgba(140,121,255,0)");
        gradient.addColorStop(1, `rgba(200,255,88,${line.alpha})`);
        context.strokeStyle = gradient;
        context.beginPath();
        context.moveTo(line.x, line.y - line.length);
        context.lineTo(line.x, line.y);
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
    $("#sampleBtn").addEventListener("click", () => {
      $("#spotifyReference").value = SAMPLE_SPOTIFY_URL;
      $("#spotifyReference").focus();
    });
    $("#playplayDemoForm").addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        const payload = buildDemoPayload($("#spotifyReference").value, $("#qualitySelect").value);
        renderPayload(payload);
        toast(t("generated"));
      } catch (error) {
        toast(error.message || String(error), "error");
        $("#spotifyReference").focus();
      }
    });
    $("#copyBtn").addEventListener("click", () => void copyPayload());
    $("#downloadBtn").addEventListener("click", downloadPayload);
    bindPreviewTabs();
  }

  function init() {
    applyLanguage();
    bindEvents();
    setupReveal();
    setupCanvas();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
