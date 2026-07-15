(() => {
  'use strict';

  const ext = globalThis.browser || globalThis.chrome;
  if (!ext || !ext.runtime || !ext.runtime.sendMessage) return;

  const BUTTON_CLASS = 'dyrakarmy-track-download';
  const ROW_SELECTORS = [
    '[data-testid="tracklist-row"]',
    '[data-testid="track-row"]',
    '[role="row"]',
  ];
  const MAX_PARALLEL_SUBMISSIONS = 3;
  const queue = [];
  const pendingUrls = new Set();
  let activeSubmissions = 0;
  let scanTimer = null;

  function isBulgarian() {
    return String(document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('bg');
  }

  function labels() {
    if (isBulgarian()) {
      return {
        idle: 'Свали с DyrakArmy',
        queued: 'Добавено в опашката',
        working: 'Добавяне…',
        error: 'Грешка при добавяне',
      };
    }
    return {
      idle: 'Download with DyrakArmy',
      queued: 'Added to queue',
      working: 'Adding…',
      error: 'Queue error',
    };
  }

  function normalizeTrackUrl(rawHref) {
    try {
      const url = new URL(String(rawHref || ''), location.origin);
      if (url.hostname !== 'open.spotify.com') return '';
      const match = url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?track\/([A-Za-z0-9]+)(?:\/|$)/i);
      if (!match) return '';
      return `https://open.spotify.com/track/${match[1]}`;
    } catch {
      return '';
    }
  }

  function findTrackUrl(row) {
    const links = row.querySelectorAll('a[href*="/track/"]');
    for (const link of links) {
      const normalized = normalizeTrackUrl(link.getAttribute('href') || link.href);
      if (normalized) return normalized;
    }
    return '';
  }

  function sendRuntimeMessage(message) {
    if (globalThis.browser && ext === globalThis.browser) {
      return Promise.resolve(ext.runtime.sendMessage(message));
    }

    return new Promise((resolve, reject) => {
      try {
        ext.runtime.sendMessage(message, (response) => {
          const runtimeError = ext.runtime.lastError ? ext.runtime.lastError.message : '';
          if (runtimeError) {
            reject(new Error(runtimeError));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function setButtonState(button, state, message = '') {
    const text = labels();
    button.dataset.state = state;
    button.disabled = state === 'working';
    button.textContent = state === 'working' ? '…' : state === 'queued' ? '✓' : state === 'error' ? '!' : '↓';
    button.title = message || text[state] || text.idle;
    button.setAttribute('aria-label', button.title);
  }

  function enqueueSubmission(trackUrl, button) {
    if (!trackUrl || pendingUrls.has(trackUrl)) return;
    pendingUrls.add(trackUrl);
    queue.push({ trackUrl, button });
    setButtonState(button, 'working');
    void processQueue();
  }

  async function processQueue() {
    while (activeSubmissions < MAX_PARALLEL_SUBMISSIONS && queue.length > 0) {
      const item = queue.shift();
      activeSubmissions += 1;
      void submitTrack(item)
        .catch(() => undefined)
        .finally(() => {
          activeSubmissions -= 1;
          pendingUrls.delete(item.trackUrl);
          void processQueue();
        });
    }
  }

  async function submitTrack({ trackUrl, button }) {
    try {
      const response = await sendRuntimeMessage({
        type: 'queueDownload',
        payload: {
          url: trackUrl,
          source: 'spotify',
        },
      });

      if (!response || response.ok !== true) {
        throw new Error(String((response && response.error) || labels().error));
      }

      setButtonState(button, 'queued');
      window.setTimeout(() => {
        if (button.isConnected) setButtonState(button, 'idle');
      }, 5000);
    } catch (error) {
      const message = String(error && error.message ? error.message : labels().error);
      setButtonState(button, 'error', message);
      window.setTimeout(() => {
        if (button.isConnected) setButtonState(button, 'idle');
      }, 5000);
    }
  }

  function injectButton(row) {
    if (!(row instanceof HTMLElement)) return;
    if (row.querySelector(`.${BUTTON_CLASS}`)) return;

    const trackUrl = findTrackUrl(row);
    if (!trackUrl) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    setButtonState(button, 'idle');

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      enqueueSubmission(trackUrl, button);
    });

    const actions = row.querySelector('[data-testid="more-button"]')?.parentElement;
    if (actions && actions.parentElement) {
      actions.parentElement.insertBefore(button, actions);
    } else {
      row.appendChild(button);
    }
  }

  function scanRows() {
    scanTimer = null;
    const seen = new Set();
    for (const selector of ROW_SELECTORS) {
      for (const row of document.querySelectorAll(selector)) {
        if (seen.has(row)) continue;
        seen.add(row);
        injectButton(row);
      }
    }
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(scanRows, 120);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scheduleScan();
})();
