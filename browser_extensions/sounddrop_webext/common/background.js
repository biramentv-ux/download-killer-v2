(() => {
  const ext = globalThis.chrome || globalThis.browser;
  if (!ext) {
    return;
  }

  const DEFAULT_API_BASE = 'https://sounddrop.biramentv.workers.dev';
  const DEFAULTS = {
    apiBase: DEFAULT_API_BASE,
    format: 'mp3',
    quality: '320',
    source: 'all',
    autoDownload: true,
    syncKey: '',
    lang: 'bg',
  };

  const SUPPORTED_FORMATS = ['mp3', 'm4a', 'ogg', 'opus', 'flac', 'wav'];
  const LOSSLESS_FORMATS = new Set(['flac', 'wav']);
  const LOSSLESS_QUALITIES = new Set(['lossless', 'best']);
  const LOSSY_QUALITIES = new Set(['best', '320', '256', '192', '128', '96']);
  const SUPPORTED_SOURCES = new Set(['all', 'spotify', 'youtube', 'soundcloud', 'deezer', 'apple']);

  const MENU_IDS = {
    downloadLink: 'sounddrop-download-link',
    downloadMedia: 'sounddrop-download-media',
    downloadPage: 'sounddrop-download-page',
    openWeb: 'sounddrop-open-web',
  };

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getBrowserLang() {
    try {
      if (ext.i18n && typeof ext.i18n.getUILanguage === 'function') {
        const lang = String(ext.i18n.getUILanguage() || '').toLowerCase();
        return lang.startsWith('bg') ? 'bg' : 'en';
      }
    } catch {
      // ignore
    }
    return 'bg';
  }

  function normalizeApiBase(raw) {
    const candidate = String(raw || '').trim();
    if (!candidate) return DEFAULT_API_BASE;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return DEFAULT_API_BASE;
      }
      parsed.pathname = parsed.pathname.replace(/\/+$/g, '');
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return DEFAULT_API_BASE;
    }
  }

  function normalizeFormat(raw) {
    const value = String(raw || '').trim().toLowerCase();
    return SUPPORTED_FORMATS.includes(value) ? value : DEFAULTS.format;
  }

  function normalizeQuality(raw, format) {
    const value = String(raw || '').trim().toLowerCase();
    if (LOSSLESS_FORMATS.has(format)) {
      return LOSSLESS_QUALITIES.has(value) ? value : 'lossless';
    }
    return LOSSY_QUALITIES.has(value) ? value : '320';
  }

  function normalizeSource(raw) {
    const value = String(raw || '').trim().toLowerCase();
    return SUPPORTED_SOURCES.has(value) ? value : 'all';
  }

  function normalizeLang(raw) {
    const value = String(raw || '').trim().toLowerCase();
    return value === 'bg' ? 'bg' : 'en';
  }

  function safeMessage(error, fallback) {
    if (!error) return fallback;
    return String(error.message || error || fallback);
  }

  function callbackPromise(register) {
    return new Promise((resolve, reject) => {
      try {
        register((result) => {
          const runtimeError = ext.runtime && ext.runtime.lastError ? ext.runtime.lastError.message : '';
          if (runtimeError) {
            reject(new Error(runtimeError));
            return;
          }
          resolve(result);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function storageGet(keys) {
    return callbackPromise((done) => ext.storage.local.get(keys, done));
  }

  async function storageSet(payload) {
    await callbackPromise((done) => ext.storage.local.set(payload, done));
  }

  async function tabsCreate(createProperties) {
    return callbackPromise((done) => ext.tabs.create(createProperties, done));
  }

  async function tabsQuery(queryInfo) {
    return callbackPromise((done) => ext.tabs.query(queryInfo, done));
  }

  async function downloadsDownload(options) {
    return callbackPromise((done) => ext.downloads.download(options, done));
  }

  async function notificationsCreate(notificationId, options) {
    return callbackPromise((done) => ext.notifications.create(notificationId, options, done));
  }

  async function contextMenusCreate(options) {
    return callbackPromise((done) => ext.contextMenus.create(options, done));
  }

  async function contextMenusRemoveAll() {
    return callbackPromise((done) => ext.contextMenus.removeAll(done));
  }

  function generateSyncKey() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 24; i += 1) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  }

  function detectSourceFromUrl(rawUrl) {
    const value = String(rawUrl || '').toLowerCase();
    if (value.includes('youtube.com') || value.includes('youtu.be') || value.includes('music.youtube.com')) return 'youtube';
    if (value.includes('spotify.com')) return 'spotify';
    if (value.includes('soundcloud.com')) return 'soundcloud';
    if (value.includes('deezer.com')) return 'deezer';
    if (value.includes('music.apple.com') || value.includes('itunes.apple.com')) return 'apple';
    return 'all';
  }

  function isValidHttpUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function getActiveTabUrlFallback() {
    return tabsQuery({ active: true, currentWindow: true }).then((tabs) => {
      if (!Array.isArray(tabs) || tabs.length === 0) return '';
      const tab = tabs[0];
      return String(tab && tab.url ? tab.url : '');
    }).catch(() => '');
  }

  async function getConfig() {
    const stored = await storageGet([
      'sd_api_base',
      'sd_format',
      'sd_quality',
      'sd_source',
      'sd_auto_download',
      'sd_sync_key',
      'sd_lang',
    ]);

    const format = normalizeFormat(stored.sd_format);
    const quality = normalizeQuality(stored.sd_quality, format);
    const syncKey = String(stored.sd_sync_key || '').trim() || generateSyncKey();
    const lang = normalizeLang(stored.sd_lang || getBrowserLang());

    const config = {
      apiBase: normalizeApiBase(stored.sd_api_base),
      format,
      quality,
      source: normalizeSource(stored.sd_source),
      autoDownload: typeof stored.sd_auto_download === 'boolean' ? stored.sd_auto_download : DEFAULTS.autoDownload,
      syncKey,
      lang,
    };

    const updates = {};
    if (!stored.sd_sync_key) updates.sd_sync_key = syncKey;
    if (!stored.sd_lang) updates.sd_lang = lang;
    if (!stored.sd_api_base) updates.sd_api_base = config.apiBase;
    if (!stored.sd_format) updates.sd_format = config.format;
    if (!stored.sd_quality) updates.sd_quality = config.quality;
    if (!stored.sd_source) updates.sd_source = config.source;
    if (typeof stored.sd_auto_download !== 'boolean') updates.sd_auto_download = config.autoDownload;
    if (Object.keys(updates).length > 0) {
      await storageSet(updates);
    }

    return config;
  }

  async function saveConfig(patch) {
    const cfg = await getConfig();
    const merged = {
      apiBase: normalizeApiBase(patch.apiBase || cfg.apiBase),
      format: normalizeFormat(patch.format || cfg.format),
      source: normalizeSource(patch.source || cfg.source),
      autoDownload: typeof patch.autoDownload === 'boolean' ? patch.autoDownload : cfg.autoDownload,
      syncKey: String(patch.syncKey || cfg.syncKey).trim() || cfg.syncKey,
      lang: normalizeLang(patch.lang || cfg.lang),
    };
    merged.quality = normalizeQuality(patch.quality || cfg.quality, merged.format);

    await storageSet({
      sd_api_base: merged.apiBase,
      sd_format: merged.format,
      sd_quality: merged.quality,
      sd_source: merged.source,
      sd_auto_download: merged.autoDownload,
      sd_sync_key: merged.syncKey,
      sd_lang: merged.lang,
    });

    try {
      await fetch(`${merged.apiBase}/api/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: merged.syncKey, language: merged.lang }),
      });
    } catch {
      // sync preference is best-effort
    }

    return merged;
  }

  function buildWebUrl(cfg) {
    const url = new URL('/', cfg.apiBase);
    if (cfg.syncKey) url.searchParams.set('sync', cfg.syncKey);
    if (cfg.lang) url.searchParams.set('lang', cfg.lang);
    url.searchParams.set('client', 'extension');
    return url.toString();
  }

  async function notify(title, message) {
    try {
      await notificationsCreate(`sounddrop_${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title,
        message,
      });
    } catch {
      // notifications are optional
    }
  }

  async function queueDownload(apiBase, payload) {
    const response = await fetch(`${apiBase}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorText = body && body.error && body.error.message ? body.error.message : `HTTP ${response.status}`;
      throw new Error(errorText);
    }
    if (!body.jobId) {
      throw new Error('Липсва jobId от /api/download');
    }
    return body;
  }

  async function getJob(apiBase, jobId) {
    const response = await fetch(`${apiBase}/api/job/${encodeURIComponent(jobId)}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorText = body && body.error && body.error.message ? body.error.message : `HTTP ${response.status}`;
      throw new Error(errorText);
    }
    return body.job || null;
  }

  function buildSuggestedFileName(job) {
    const title = String(job.title || 'track').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    const artist = String(job.artist || 'artist').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    const extName = String(job.format || 'mp3').toLowerCase();
    return `${artist} - ${title}.${extName}`.replace(/\s+/g, ' ').trim();
  }

  async function waitForJobDone(apiBase, jobId, maxMs) {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      const job = await getJob(apiBase, jobId);
      if (job && (job.status === 'done' || job.status === 'failed')) {
        return job;
      }
      await delay(1800);
    }
    throw new Error('Изтече времето за изчакване на задачата.');
  }

  async function openDownload(job, autoDownload) {
    const downloadUrl = job && job.download_url ? String(job.download_url) : '';
    if (!downloadUrl) {
      throw new Error('Няма генериран download линк.');
    }

    if (!autoDownload) {
      await tabsCreate({ url: downloadUrl });
      return { opened: true, method: 'tab' };
    }

    try {
      await downloadsDownload({
        url: downloadUrl,
        filename: buildSuggestedFileName(job),
        saveAs: true,
        conflictAction: 'uniquify',
      });
      return { opened: true, method: 'download' };
    } catch {
      await tabsCreate({ url: downloadUrl });
      return { opened: true, method: 'tab' };
    }
  }

  async function queueAndResolve(userInput) {
    const cfg = await getConfig();
    const url = String(userInput.url || '').trim();
    if (!isValidHttpUrl(url)) {
      throw new Error('Невалиден URL.');
    }

    const format = normalizeFormat(userInput.format || cfg.format);
    const quality = normalizeQuality(userInput.quality || cfg.quality, format);
    const source = normalizeSource(userInput.source || cfg.source || detectSourceFromUrl(url));

    const queuePayload = {
      url,
      format,
      quality,
      source,
    };

    const queued = await queueDownload(cfg.apiBase, queuePayload);
    const jobId = queued.jobId;
    const shortId = String(jobId).slice(0, 8);
    await notify('SoundDrop', `Задачата #${shortId} е добавена.`);

    const job = await waitForJobDone(cfg.apiBase, jobId, 7 * 60 * 1000);

    if (!job || job.status !== 'done') {
      const reason = job && job.error_message ? String(job.error_message) : 'Неуспешна обработка.';
      throw new Error(reason);
    }

    const openResult = await openDownload(job, cfg.autoDownload);
    const title = String(job.title || 'Track');
    await notify('SoundDrop', `Готово: ${title}`);

    return {
      job,
      openResult,
      queuePayload,
    };
  }

  async function handleContextDownload(url) {
    const targetUrl = String(url || '').trim();
    if (!isValidHttpUrl(targetUrl)) {
      await notify('SoundDrop', 'Липсва валиден линк за сваляне.');
      return;
    }

    try {
      const cfg = await getConfig();
      await queueAndResolve({
        url: targetUrl,
        format: cfg.format,
        quality: cfg.quality,
        source: detectSourceFromUrl(targetUrl) || cfg.source,
      });
    } catch (error) {
      await notify('SoundDrop', `Грешка: ${safeMessage(error, 'Неуспешно сваляне.')}`);
    }
  }

  async function openWebApp() {
    const cfg = await getConfig();
    await tabsCreate({ url: buildWebUrl(cfg) });
  }

  async function setupContextMenus() {
    try {
      await contextMenusRemoveAll();
      await contextMenusCreate({
        id: MENU_IDS.downloadLink,
        title: 'Свали линка със SoundDrop',
        contexts: ['link'],
      });
      await contextMenusCreate({
        id: MENU_IDS.downloadMedia,
        title: 'Свали медия със SoundDrop',
        contexts: ['audio', 'video'],
      });
      await contextMenusCreate({
        id: MENU_IDS.downloadPage,
        title: 'Свали текущата страница със SoundDrop',
        contexts: ['page'],
      });
      await contextMenusCreate({
        id: MENU_IDS.openWeb,
        title: 'Отвори SoundDrop Web App',
        contexts: ['action'],
      });
    } catch (error) {
      console.warn('Context menu setup failed', error);
    }
  }

  ext.runtime.onInstalled.addListener(() => {
    void setupContextMenus();
  });

  ext.runtime.onStartup?.addListener(() => {
    void setupContextMenus();
  });

  ext.contextMenus.onClicked.addListener((info) => {
    if (!info || !info.menuItemId) return;

    const menuId = String(info.menuItemId);
    if (menuId === MENU_IDS.openWeb) {
      void openWebApp();
      return;
    }

    if (menuId === MENU_IDS.downloadPage) {
      void handleContextDownload(info.pageUrl || '');
      return;
    }

    if (menuId === MENU_IDS.downloadLink) {
      void handleContextDownload(info.linkUrl || '');
      return;
    }

    if (menuId === MENU_IDS.downloadMedia) {
      const candidate = info.srcUrl || info.linkUrl || info.pageUrl || '';
      void handleContextDownload(candidate);
    }
  });

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const msg = message && typeof message === 'object' ? message : {};

    if (msg.type === 'ping') {
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'getConfig') {
      void getConfig()
        .then((cfg) => {
          sendResponse({ ok: true, config: cfg });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: safeMessage(error, 'Config error') });
        });
      return true;
    }

    if (msg.type === 'saveConfig') {
      void saveConfig(msg.config || {})
        .then((cfg) => {
          sendResponse({ ok: true, config: cfg });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: safeMessage(error, 'Save config failed') });
        });
      return true;
    }

    if (msg.type === 'queueDownload') {
      void queueAndResolve(msg.payload || {})
        .then((result) => {
          sendResponse({ ok: true, result });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: safeMessage(error, 'Queue failed') });
        });
      return true;
    }

    if (msg.type === 'openWebApp') {
      void openWebApp()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: safeMessage(error, 'Open web app failed') }));
      return true;
    }

    if (msg.type === 'getActiveTabUrl') {
      void getActiveTabUrlFallback()
        .then((url) => sendResponse({ ok: true, url }))
        .catch((error) => sendResponse({ ok: false, error: safeMessage(error, 'Tab URL error') }));
      return true;
    }

    sendResponse({ ok: false, error: 'Unknown message type' });
    return true;
  });
})();
