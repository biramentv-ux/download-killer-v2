(() => {
  "use strict";

  const nativeFetch = window.fetch.bind(window);
  const slots = new Map();
  const STATUS_PATH = /^\/api\/job\/[0-9a-f-]{36}$/i;
  const MIN_INTERVAL_MS = 5000;
  const MAX_RETRY_MS = 30000;

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function retryDelay(response) {
    const seconds = Number.parseInt(response.headers.get("Retry-After") || "0", 10);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(MAX_RETRY_MS, seconds * 1000);
    return 10000;
  }

  window.fetch = async function resilientFetch(input, init = {}) {
    let request;
    try {
      request = input instanceof Request ? input : new Request(input, init);
    } catch {
      return nativeFetch(input, init);
    }

    const url = new URL(request.url, location.href);
    if (request.method.toUpperCase() !== "GET" || !STATUS_PATH.test(url.pathname)) {
      return nativeFetch(input, init);
    }

    const key = url.toString();
    const slot = slots.get(key) || { inflight: null, cached: null, nextAllowedAt: 0 };
    slots.set(key, slot);

    if (slot.inflight) {
      const shared = await slot.inflight;
      return shared.clone();
    }

    if (slot.cached && Date.now() < slot.nextAllowedAt) {
      return slot.cached.clone();
    }

    slot.inflight = (async () => {
      let response = await nativeFetch(input, init);
      if (response.status === 429) {
        const delay = retryDelay(response);
        slot.nextAllowedAt = Date.now() + delay;
        if (slot.cached) return slot.cached.clone();
        await sleep(delay);
        response = await nativeFetch(input, init);
      }

      if (response.ok) {
        slot.cached = response.clone();
        slot.nextAllowedAt = Date.now() + MIN_INTERVAL_MS;
      }
      return response;
    })();

    try {
      const response = await slot.inflight;
      return response.clone();
    } finally {
      slot.inflight = null;
    }
  };
})();
