(() => {
  "use strict";

  const VERSION = "12.2.0";
  const HEALTH_URL = "/api/telegram/v12/health";
  const nativeFetch = window.fetch.bind(window);
  let lastFailure = null;
  let healthTimer = null;

  window.DK_MINIAPP_VERSION = VERSION;

  function dispatch(detail) {
    window.dispatchEvent(new CustomEvent("dk:telegram-api", { detail }));
  }

  window.fetch = async function diagnosticFetch(input, init) {
    const requestUrl = (() => {
      try {
        return new URL(input instanceof Request ? input.url : String(input), location.href);
      } catch {
        return null;
      }
    })();

    try {
      const response = await nativeFetch(input, init);
      if (requestUrl?.pathname.startsWith("/api/telegram/") && !response.ok) {
        const payload = await response.clone().json().catch(() => ({}));
        dispatch({
          ok: false,
          status: response.status,
          path: requestUrl.pathname,
          code: payload?.error?.code || `HTTP_${response.status}`,
          message: payload?.error?.message || payload?.detail || `HTTP ${response.status}`,
        });
      } else if (requestUrl?.pathname.startsWith("/api/telegram/") && response.ok) {
        dispatch({ ok: true, status: response.status, path: requestUrl.pathname });
      }
      return response;
    } catch (error) {
      if (requestUrl?.pathname.startsWith("/api/telegram/")) {
        dispatch({
          ok: false,
          status: 0,
          path: requestUrl.pathname,
          code: "NETWORK_ERROR",
          message: error?.message || String(error),
        });
      }
      throw error;
    }
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  function localized(bg, en) {
    return document.documentElement.lang === "en" ? en : bg;
  }

  function describeFailure(detail) {
    if (!navigator.onLine || detail.status === 0) {
      return localized(
        "Няма мрежова връзка до Cloudflare Worker. Провери интернет връзката и основния домейн.",
        "No network connection to the Cloudflare Worker. Check your connection and primary domain.",
      );
    }
    if (detail.status === 401 || detail.code === "TELEGRAM_AUTH_FAILED") {
      return localized(
        "API работи, но Telegram сесията е невалидна. Затвори Mini App и го отвори от текущия бот, след като webhook-ът е настроен със същия bot token.",
        "The API is online, but the Telegram session is invalid. Close the Mini App and reopen it from the current bot after its webhook and token are synchronized.",
      );
    }
    if (detail.status === 403) {
      return localized(
        "Cloudflare отказва достъпа до API. Провери WAF/Access правилата и custom domain route-а.",
        "Cloudflare is denying API access. Check WAF/Access rules and the custom-domain route.",
      );
    }
    if (detail.status === 404) {
      return localized(
        "Зареден е стар Worker без Mini App v12 API. Нужен е нов deploy.",
        "An older Worker without the Mini App v12 API is deployed. A new deployment is required.",
      );
    }
    if (detail.status >= 500) {
      return localized(
        `Worker-ът върна сървърна грешка ${detail.status}. ${detail.message || ""}`.trim(),
        `The Worker returned server error ${detail.status}. ${detail.message || ""}`.trim(),
      );
    }
    return localized(
      `Mini App API проблем: ${detail.message || detail.code || "неизвестна грешка"}.`,
      `Mini App API problem: ${detail.message || detail.code || "unknown error"}.`,
    );
  }

  function setDiagnostic(state, title, detail) {
    const panel = $("#runtimeDiagnostic");
    if (!panel) return;
    panel.dataset.state = state;
    $("#runtimeDiagnosticTitle").textContent = title;
    $("#runtimeDiagnosticDetail").textContent = detail;
    panel.hidden = false;
  }

  function clearDiagnostic() {
    const panel = $("#runtimeDiagnostic");
    if (!panel) return;
    panel.hidden = true;
    panel.dataset.state = "online";
  }

  function setConnection(state, label) {
    const node = $("#connectionState");
    if (!node) return;
    node.dataset.state = state;
    const text = node.querySelector("b");
    if (text && label) text.textContent = label;
  }

  async function healthCheck(showSuccess = false) {
    try {
      const response = await nativeFetch(`${HEALTH_URL}?v=${encodeURIComponent(VERSION)}&ts=${Date.now()}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        throw Object.assign(new Error(payload?.error?.message || `HTTP ${response.status}`), {
          status: response.status,
          code: payload?.error?.code,
        });
      }

      $$("[data-miniapp-version]").forEach((node) => { node.textContent = `v${payload.version || VERSION}`; });
      const endpoint = $("#runtimeEndpoint");
      if (endpoint) endpoint.textContent = new URL(payload.public_base_url || location.origin).host;

      if (!lastFailure) {
        setConnection("online", "ONLINE");
        if (showSuccess) {
          setDiagnostic(
            "online",
            localized("Mini App е свързан", "Mini App connected"),
            localized(`Worker ${payload.version || VERSION} отговаря през ${location.host}.`, `Worker ${payload.version || VERSION} is responding through ${location.host}.`),
          );
          window.setTimeout(clearDiagnostic, 2500);
        } else {
          clearDiagnostic();
        }
      } else if (lastFailure.status === 401) {
        setConnection("auth", "AUTH");
      } else {
        setConnection("degraded", "API ONLINE");
      }
      return true;
    } catch (error) {
      const detail = {
        status: Number(error?.status || 0),
        code: String(error?.code || "HEALTH_FAILED"),
        message: error?.message || String(error),
      };
      lastFailure = detail;
      setConnection("offline", "OFFLINE");
      setDiagnostic(
        "error",
        localized("Mini App няма връзка", "Mini App is offline"),
        describeFailure(detail),
      );
      return false;
    }
  }

  async function hardRefresh() {
    const button = $("#runtimeRetryBtn");
    if (button) button.disabled = true;
    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.allSettled(registrations.map((registration) => registration.update()));
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.allSettled(keys
          .filter((key) => key.startsWith("download-killer-static-"))
          .map((key) => caches.delete(key)));
      }
    } catch {
      // Cache cleanup is best-effort inside Telegram WebView.
    }
    const url = new URL(location.href);
    url.searchParams.set("v", VERSION);
    url.searchParams.set("refresh", String(Date.now()));
    location.replace(url.toString());
  }

  function bindNavigation() {
    $$("[data-open-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        const target = button.dataset.openTab;
        const tab = document.querySelector(`[data-tab="${CSS.escape(target)}"]`);
        if (tab) tab.click();
        document.querySelector(".tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    $("#runtimeRetryBtn")?.addEventListener("click", () => void hardRefresh());
    $("#runtimeHealthBtn")?.addEventListener("click", () => void healthCheck(true));
  }

  window.addEventListener("dk:telegram-api", (event) => {
    const detail = event.detail || {};
    if (detail.ok) {
      if (detail.path === "/api/telegram/v10/miniapp/profile") {
        lastFailure = null;
        clearDiagnostic();
      }
      return;
    }
    lastFailure = detail;
    const state = detail.status === 401 ? "auth" : detail.status >= 500 || detail.status === 0 ? "error" : "warning";
    setConnection(detail.status === 401 ? "auth" : "offline", detail.status === 401 ? "AUTH" : "OFFLINE");
    setDiagnostic(
      state,
      detail.status === 401
        ? localized("Telegram сесията не е приета", "Telegram session rejected")
        : localized("Mini App API грешка", "Mini App API error"),
      describeFailure(detail),
    );
  });

  window.addEventListener("online", () => void healthCheck(true));
  window.addEventListener("offline", () => {
    lastFailure = { status: 0, code: "BROWSER_OFFLINE", message: "Browser offline" };
    setConnection("offline", "OFFLINE");
    setDiagnostic("error", localized("Няма интернет връзка", "No internet connection"), describeFailure(lastFailure));
  });

  document.addEventListener("DOMContentLoaded", () => {
    bindNavigation();
    void healthCheck(false);
    healthTimer = window.setInterval(() => void healthCheck(false), 30000);
  });

  window.addEventListener("beforeunload", () => {
    if (healthTimer) window.clearInterval(healthTimer);
  });
})();
