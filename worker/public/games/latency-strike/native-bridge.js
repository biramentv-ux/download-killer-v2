(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const nativeSession = String(params.get('native_session') || '').trim();
  if (!/^[a-f0-9]{48}$/.test(nativeSession)) return;

  window.__LATENCY_NATIVE_SESSION__ = nativeSession;
  window.Telegram = window.Telegram || {};
  const currentWebApp = window.Telegram.WebApp || {};
  try {
    if (!currentWebApp.initData) {
      Object.defineProperty(currentWebApp, 'initData', {
        configurable: true,
        enumerable: true,
        value: 'native-game-session',
      });
    }
    window.Telegram.WebApp = currentWebApp;
  } catch {
    window.Telegram.WebApp = {
      ...currentWebApp,
      initData: 'native-game-session',
    };
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(requestUrl, window.location.href);
    if (
      url.origin === window.location.origin
      && url.pathname.startsWith('/api/games/latency-strike/')
      && String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase() === 'POST'
      && typeof init.body === 'string'
    ) {
      try {
        const body = JSON.parse(init.body);
        init = {
          ...init,
          body: JSON.stringify({ ...body, native_session: nativeSession }),
        };
      } catch {
        // Leave non-JSON requests unchanged.
      }
    }
    return nativeFetch(input, init);
  };

  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('#shareBtn') : null;
    if (!button || button.hasAttribute('disabled')) return;
    const proxy = window.TelegramGameProxy;
    if (proxy && typeof proxy.shareScore === 'function') {
      event.preventDefault();
      event.stopImmediatePropagation();
      proxy.shareScore();
    }
  }, true);
})();
