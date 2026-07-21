(() => {
  const ext = globalThis.browser || globalThis.chrome;
  if (!ext) return;

  const IS_PROMISE_API = Boolean(globalThis.browser && ext === globalThis.browser);
  const DEFAULT_API_BASE = 'https://dyrakarmy.eu';
  const MIRROR_API_BASE = 'https://dyrakarmy.online';
  const DEFAULTS = {
    apiBase: DEFAULT_API_BASE,
    format: 'mp3',
    quality: '320',
    source: 'all',
    autoDownload: true,
    syncKey: '',
    lang: 'bg',
    downloadDirectory: '',
    telegramLinkMode: 'bot',
  };

  const RUNTIME_CONFIG_CACHE_KEY = 'sd_runtime_config_cache';
  const RUNTIME_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;
  const PREFS_REVISION_KEY = 'sd_prefs_revision_v2';
  const RECENT_JOBS_KEY = 'sd_recent_jobs_v2';
  const JOB_POLL_INTERVAL_MS = 8000;
  const JOB_MAX_WAIT_MS = 12 * 60 * 1000;
  const SUPPORTED_LANGS = new Set(['bg', 'en', 'es', 'ru', 'de']);
  const SUPPORTED_FORMATS = ['mp3', 'm4a', 'ogg', 'opus', 'flac', 'wav'];
  const LOSSLESS_FORMATS = new Set(['flac', 'wav']);
  const LOSSLESS_QUALITIES = new Set(['lossless', 'best']);
  const LOSSY_QUALITIES = new Set(['best', '320', '256', '192', '128', '96']);
  const SUPPORTED_SOURCES = new Set(['all', 'spotify', 'youtube', 'soundcloud', 'deezer', 'apple', 'podcast']);
  const SYNC_KEY_RE = /^[a-zA-Z0-9_-]{8,64}$/;
  const EXTENSION_VERSION = String((ext.runtime && ext.runtime.getManifest && ext.runtime.getManifest().version) || '0.0.0');

  const MENU_IDS = {
    downloadLink: 'dyrakarmy-download-link',
    downloadMedia: 'dyrakarmy-download-media',
    downloadPage: 'dyrakarmy-download-page',
    openWeb: 'dyrakarmy-open-web',
  };

  const activeTasks = new Map();

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function safeMessage(error, fallback) {
    if (!error) return fallback;
    return String(error.message || error || fallback);
  }

  function apiCall(namespace, method, ...args) {
    const target = namespace && namespace[method];
    if (typeof target !== 'function') {
      return Promise.reject(new Error(`Missing extension API: ${method}`));
    }

    if (IS_PROMISE_API) {
      try {
        return Promise.resolve(target.apply(namespace, args));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    return new Promise((resolve, reject) => {
      try {
        target.apply(namespace, [
          ...args,
          (result) => {
            const runtimeError = ext.runtime && ext.runtime.lastError ? ext.runtime.lastError.message : '';
            if (runtimeError) {
              reject(new Error(runtimeError));
              return;
            }
            resolve(result);
          },
        ]);
      } catch (error) {
        reject(error);
      }
    });
  }

  async function storageGet(keys) {
    return apiCall(ext.storage.local, 'get', keys);
  }

  async function storageSet(payload) {
    await apiCall(ext.storage.local, 'set', payload);
  }

  async function tabsCreate(createProperties) {
    return apiCall(ext.tabs, 'create', createProperties);
  }

  async function tabsQuery(queryInfo) {
    return apiCall(ext.tabs, 'query', queryInfo);
  }

  async function downloadsDownload(options) {
    return apiCall(ext.downloads, 'download', options);
  }

  async function notificationsCreate(notificationId, options) {
    if (!ext.notifications) return null;
    return apiCall(ext.notifications, 'create', notificationId, options);
  }

  async function contextMenusCreate(options) {
    if (!ext.contextMenus) return null;
    return apiCall(ext.contextMenus, 'create', options);
  }

  async function contextMenusRemoveAll() {
    if (!ext.contextMenus) return null;
    return apiCall(ext.contextMenus, 'removeAll');
  }

  function parseVersion(value) {
    return String(value || '0.0.0')
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((num) => (Number.isFinite(num) ? num : 0))
      .slice(0, 3);
  }

  function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    while (left.length < 3) left.push(0);
    while (right.length < 3) right.push(0);
    for (let i = 0; i < 3; i += 1) {
      if (left[i] > right[i]) return 1;
      if (left[i] < right[i]) return -1;
    }
    return 0;
  }

  function getBrowserLang() {
    try {
      if (ext.i18n && typeof ext.i18n.getUILanguage === 'function') {
        const lang = String(ext.i18n.getUILanguage() || '').toLowerCase();
        for (const code of SUPPORTED_LANGS) {
          if (lang.startsWith(code)) return code;
        }
        return 'en';
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
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return DEFAULT_API_BASE;
      parsed.pathname = parsed.pathname.replace(/\/+$/g, '');
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return DEFAULT_API_BASE;
    }
  }

  function stripApiSuffix(raw) {
    const normalized = normalizeApiBase(raw);
    try {
      const parsed = new URL(normalized);
      let path = parsed.pathname.replace(/\/+$/g, '');
      if (path.endsWith('/api')) path = path.slice(0, -4);
      return `${parsed.origin}${path}`;
    } catch {
      return DEFAULT_API_BASE;
    }
  }

  function resolveBaseFromRuntimePayload(payload, fallbackBase) {
    if (!payload || typeof payload !== 'object') return stripApiSuffix(fallbackBase);
    if (typeof payload.public_base === 'string' && payload.public_base.trim()) {
      return normalizeApiBase(payload.public_base);
    }
    if (typeof payload.api_base === 'string' && payload.api_base.trim()) {
      return stripApiSuffix(payload.api_base);
    }
    return stripApiSuffix(fallbackBase);
  }

  async function fetchRuntimeConfig(base) {
    const apiBase = stripApiSuffix(base);
    const response = await fetch(`${apiBase}/api/runtime-config`, { method: 'GET' });
    if (!response.ok) throw new Error(`runtime-config HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || typeof payload !== 'object') throw new Error('runtime-config payload invalid');
    return payload;
  }

  async function resolveApiBaseWithRuntime(base) {
    const normalizedBase = stripApiSuffix(base);
    const now = Date.now();
    const cachedWrap = await storageGet([RUNTIME_CONFIG_CACHE_KEY]);
    const cached = cachedWrap ? cachedWrap[RUNTIME_CONFIG_CACHE_KEY] : null;
    if (cached && typeof cached === 'object') {
      const savedAt = Number(cached.savedAt || 0);
      const cachedBase = normalizeApiBase(cached.baseUrl || normalizedBase);
      if (savedAt > 0 && now - savedAt < RUNTIME_CONFIG_CACHE_TTL_MS) return cachedBase;
    }

    const candidates = Array.from(new Set([
      normalizedBase,
      stripApiSuffix(DEFAULT_API_BASE),
      stripApiSuffix(MIRROR_API_BASE),
    ]));
    for (const candidate of candidates) {
      try {
        const payload = await fetchRuntimeConfig(candidate);
        const resolvedBase = resolveBaseFromRuntimePayload(payload, candidate);
        await storageSet({
          [RUNTIME_CONFIG_CACHE_KEY]: {
            savedAt: now,
            baseUrl: resolvedBase,
            payload,
          },
        });
        return normalizeApiBase(resolvedBase);
      } catch {
        // try next candidate
      }
    }

    if (cached && typeof cached === 'object' && cached.baseUrl) return normalizeApiBase(cached.baseUrl);
    return normalizedBase;
  }

  function normalizeFormat(raw) {
    const value = String(raw || '').trim().toLowerCase();
    return SUPPORTED_FORMATS.includes(value) ? value : DEFAULTS.format;
  }

  function normalizeQuality(raw, format) {
    const value = String(raw || '').trim().toLowerCase();
    if (LOSSLESS_FORMATS.has(format)) return LOSSLESS_QUALITIES.has(value) ? value : 'lossless';
    return LOSSY_QUALITIES.has(value) ? value : '320';
  }

  function normalizeSource(raw) {
    const value = String(raw || '').trim().toLowerCase();
    return SUPPORTED_SOURCES.has(value) ? value : 'all';
  }

  function normalizeLang(raw) {
    const value = String(raw || '').trim().toLowerCase();
    return SUPPORTED_LANGS.has(value) ? value : 'en';
  }

  function normalizeDownloadDirectory(raw) {
    return String(raw || '').trim().slice(0, 240);
  }

  function normalizeTelegramLinkMode(raw) {
    return String(raw || '').trim().toLowerCase() === 'download' ? 'download' : 'bot';
  }

  function normalizeRevision(raw) {
    const parsed = Number.parseInt(String(raw || '0'), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  function getExtensionUpdateUrlFromRuntime(payload, fallbackBase) {
    const fallback = `${stripApiSuffix(fallbackBase)}/downloads/DyrakArmy-Extension-Chrome.zip`;
    if (!payload || typeof payload !== 'object') return fallback;
    const updates = payload.updates && typeof payload.updates === 'object' ? payload.updates : null;
    const extension = updates && updates.extension && typeof updates.extension === 'object' ? updates.extension : null;
    if (!extension) return fallback;

    const ua = String((globalThis.navigator && globalThis.navigator.userAgent) || '').toLowerCase();
    if (ua.includes('firefox') && typeof extension.firefox_zip_url === 'string' && extension.firefox_zip_url.trim()) {
      return extension.firefox_zip_url.trim();
    }
    if (typeof extension.chrome_zip_url === 'string' && extension.chrome_zip_url.trim()) return extension.chrome_zip_url.trim();
    return fallback;
  }

  function generateSyncKey() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 24; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function detectSourceFromUrl(rawUrl) {
    const value = String(rawUrl || '').toLowerCase();
    if (value.includes('youtube.com') || value.includes('youtu.be') || value.includes('music.youtube.com')) return 'youtube';
    if (value.includes('spotify.com')) {
      if (value.includes('/show/') || value.includes('/episode/')) return 'podcast';
      return 'spotify';
    }
    if (value.includes('podcasts.apple.com') || value.includes('/podcast/') || value.includes('/show/')) return 'podcast';
    if (value.includes('soundcloud.com')) return 'soundcloud';
    if (value.includes('deezer.com')) return 'deezer';
    if (value.includes('music.apple.com') || value.includes('itunes.apple.com')) return 'apple';
    if (value.includes('/feed') || value.includes('rss') || value.endsWith('.xml')) return 'podcast';
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

  async function getActiveTabUrlFallback() {
    const tabs = await tabsQuery({ active: true, currentWindow: true });
    if (!Array.isArray(tabs) || tabs.length === 0) return '';
    const tab = tabs[0];
    return String(tab && tab.url ? tab.url : '');
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
      'sd_download_directory',
      'sd_telegram_link_mode',
      PREFS_REVISION_KEY,
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
      downloadDirectory: normalizeDownloadDirectory(stored.sd_download_directory || DEFAULTS.downloadDirectory),
      telegramLinkMode: normalizeTelegramLinkMode(stored.sd_telegram_link_mode || DEFAULTS.telegramLinkMode),
      prefsRevision: normalizeRevision(stored[PREFS_REVISION_KEY]),
      blocked: false,
      requiredVersion: '',
      updateUrl: '',
    };

    try {
      config.apiBase = normalizeApiBase(await resolveApiBaseWithRuntime(config.apiBase));
    } catch {
      // runtime config is optional
    }

    try {
      const prefs = await fetch(`${config.apiBase}/api/preferences?key=${encodeURIComponent(syncKey)}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (prefs && typeof prefs === 'object') {
        if (prefs.language) config.lang = normalizeLang(prefs.language);
        if (prefs.source) config.source = normalizeSource(prefs.source);
        if (prefs.format) config.format = normalizeFormat(prefs.format);
        if (prefs.quality) config.quality = normalizeQuality(prefs.quality, config.format);
        if (typeof prefs.download_directory === 'string') config.downloadDirectory = normalizeDownloadDirectory(prefs.download_directory);
        if (prefs.telegram_link_mode) config.telegramLinkMode = normalizeTelegramLinkMode(prefs.telegram_link_mode);
        if (Object.prototype.hasOwnProperty.call(prefs, 'revision')) config.prefsRevision = normalizeRevision(prefs.revision);
      }
    } catch {
      // optional preference sync
    }

    try {
      const runtimeCache = (await storageGet([RUNTIME_CONFIG_CACHE_KEY]))[RUNTIME_CONFIG_CACHE_KEY];
      const payload = runtimeCache && runtimeCache.payload ? runtimeCache.payload : null;
      const minVersion = payload && payload.client_min_versions ? String(payload.client_min_versions.extension || '0.0.0') : '0.0.0';
      config.updateUrl = getExtensionUpdateUrlFromRuntime(payload, config.apiBase);
      config.requiredVersion = minVersion;
      config.blocked = compareVersions(EXTENSION_VERSION, minVersion) < 0;
    } catch {
      config.requiredVersion = '0.0.0';
      config.blocked = false;
      config.updateUrl = `${stripApiSuffix(config.apiBase)}/downloads/DyrakArmy-Extension-Chrome.zip`;
    }

    await storageSet({
      sd_api_base: config.apiBase,
      sd_format: config.format,
      sd_quality: config.quality,
      sd_source: config.source,
      sd_auto_download: config.autoDownload,
      sd_sync_key: config.syncKey,
      sd_lang: config.lang,
      sd_download_directory: config.downloadDirectory,
      sd_telegram_link_mode: config.telegramLinkMode,
      [PREFS_REVISION_KEY]: config.prefsRevision,
    });

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
      downloadDirectory: normalizeDownloadDirectory(patch.downloadDirectory || cfg.downloadDirectory),
      telegramLinkMode: normalizeTelegramLinkMode(patch.telegramLinkMode || cfg.telegramLinkMode),
      prefsRevision: normalizeRevision(cfg.prefsRevision),
      updateUrl: cfg.updateUrl,
      blocked: cfg.blocked,
      requiredVersion: cfg.requiredVersion,
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
      sd_download_directory: merged.downloadDirectory,
      sd_telegram_link_mode: merged.telegramLinkMode,
      [PREFS_REVISION_KEY]: merged.prefsRevision,
    });

    try {
      const response = await fetch(`${merged.apiBase}/api/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: merged.syncKey,
          language: merged.lang,
          source: merged.source,
          format: merged.format,
          quality: merged.quality,
          download_directory: merged.downloadDirectory,
          telegram_link_mode: merged.telegramLinkMode,
          base_revision: merged.prefsRevision,
          client_updated_at: new Date().toISOString(),
          client_id: 'extension',
        }),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && typeof payload === 'object') {
        if (Object.prototype.hasOwnProperty.call(payload, 'revision')) merged.prefsRevision = normalizeRevision(payload.revision);
        if (payload.language) merged.lang = normalizeLang(payload.language);
        if (payload.source) merged.source = normalizeSource(payload.source);
        if (payload.format) merged.format = normalizeFormat(payload.format);
        if (payload.quality) merged.quality = normalizeQuality(payload.quality, merged.format);
        if (typeof payload.download_directory === 'string') merged.downloadDirectory = normalizeDownloadDirectory(payload.download_directory);
        if (payload.telegram_link_mode) merged.telegramLinkMode = normalizeTelegramLinkMode(payload.telegram_link_mode);
        await storageSet({
          sd_lang: merged.lang,
          sd_source: merged.source,
          sd_format: merged.format,
          sd_quality: merged.quality,
          sd_download_directory: merged.downloadDirectory,
          sd_telegram_link_mode: merged.telegramLinkMode,
          [PREFS_REVISION_KEY]: merged.prefsRevision,
        });
      }
    } catch {
      // preference sync is best-effort
    }

    return merged;
  }

  function buildWebUrl(cfg) {
    const url = new URL('/', cfg.apiBase);
    if (cfg.syncKey) url.searchParams.set('sync', cfg.syncKey);
    if (cfg.lang) url.searchParams.set('lang', cfg.lang);
    url.searchParams.set('client', 'extension');
    url.searchParams.set('extver', EXTENSION_VERSION);
    return url.toString();
  }

  async function notify(title, message) {
    try {
      await notificationsCreate(`dyrakarmy_${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title,
        message,
      });
    } catch {
      // notifications are optional
    }
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorText = payload && payload.error && payload.error.message ? payload.error.message : `HTTP ${response.status}`;
      throw new Error(errorText);
    }
    return payload;
  }

  async function queueDownload(apiBase, payload, syncKey) {
    if (SYNC_KEY_RE.test(String(syncKey || ''))) {
      try {
        const sharedPayload = await postJson(`${apiBase}/api/shared-queue`, {
          key: syncKey,
          ...payload,
          added_by: 'browser-extension',
        });
        if (sharedPayload && sharedPayload.jobId) return sharedPayload;
      } catch (error) {
        console.warn('Shared queue failed; falling back to direct queue', error);
      }
    }

    const directPayload = await postJson(`${apiBase}/api/download`, payload);
    if (!directPayload.jobId) throw new Error('Липсва jobId от /api/download');
    return directPayload;
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
    const dir = String(job.downloadDirectory || '').replace(/[\\]+$/g, '').trim();
    const base = `${artist} - ${title}.${extName}`.replace(/\s+/g, ' ').trim();
    return dir ? `${dir}/${base}` : base;
  }

  async function openDownload(job, autoDownload, downloadDirectory) {
    const downloadUrl = job && job.download_url ? String(job.download_url) : '';
    if (!downloadUrl) throw new Error('Няма генериран download линк.');

    if (!autoDownload) {
      await tabsCreate({ url: downloadUrl });
      return { opened: true, method: 'tab' };
    }

    try {
      await downloadsDownload({
        url: downloadUrl,
        filename: buildSuggestedFileName({ ...job, downloadDirectory }),
        saveAs: true,
        conflictAction: 'uniquify',
      });
      return { opened: true, method: 'download' };
    } catch {
      await tabsCreate({ url: downloadUrl });
      return { opened: true, method: 'tab' };
    }
  }

  async function updateRecentJob(jobId, patch) {
    const stored = await storageGet([RECENT_JOBS_KEY]).catch(() => ({}));
    const jobs = stored && Array.isArray(stored[RECENT_JOBS_KEY]) ? stored[RECENT_JOBS_KEY] : [];
    const withoutCurrent = jobs.filter((item) => item && item.jobId !== jobId);
    const next = [{ jobId, updatedAt: new Date().toISOString(), ...patch }, ...withoutCurrent].slice(0, 20);
    await storageSet({ [RECENT_JOBS_KEY]: next });
    return next[0];
  }

  async function watchJobAndOpen(apiBase, jobId, options) {
    if (activeTasks.has(jobId)) return activeTasks.get(jobId);

    const task = (async () => {
      const started = Date.now();
      await updateRecentJob(jobId, { apiBase, status: 'queued', ...options });
      while (Date.now() - started < JOB_MAX_WAIT_MS) {
        const job = await getJob(apiBase, jobId);
        if (job) await updateRecentJob(jobId, { apiBase, status: job.status, job, ...options });
        if (job && job.status === 'done') {
          await openDownload(job, options.autoDownload !== false, options.downloadDirectory || '');
          await notify('DyrakArmy', `Готово: ${job.title || 'файлът е готов'}`);
          return job;
        }
        if (job && job.status === 'failed') {
          const reason = job.error_message ? String(job.error_message) : 'Неуспешна обработка.';
          await notify('DyrakArmy', `Грешка: ${reason.slice(0, 180)}`);
          return job;
        }
        await delay(JOB_POLL_INTERVAL_MS);
      }
      throw new Error('Изтече времето за изчакване на задачата.');
    })().catch(async (error) => {
      await updateRecentJob(jobId, { apiBase, status: 'failed', error: safeMessage(error, 'Неуспешно сваляне.'), ...options });
      await notify('DyrakArmy', `Грешка: ${safeMessage(error, 'Неуспешно сваляне.').slice(0, 180)}`);
      throw error;
    }).finally(() => {
      activeTasks.delete(jobId);
    });

    activeTasks.set(jobId, task);
    return task;
  }

  async function queueAndStart(userInput) {
    const cfg = await getConfig();
    if (cfg.blocked) {
      throw new Error(`Update required: minimum extension version ${cfg.requiredVersion}, current ${EXTENSION_VERSION}`);
    }

    const url = String(userInput.url || '').trim();
    if (!isValidHttpUrl(url)) throw new Error('Невалиден URL.');

    const format = normalizeFormat(userInput.format || cfg.format);
    const quality = normalizeQuality(userInput.quality || cfg.quality, format);
    const source = normalizeSource(userInput.source || cfg.source || detectSourceFromUrl(url));
    const queuePayload = { url, format, quality, source };
    const queued = await queueDownload(cfg.apiBase, queuePayload, cfg.syncKey);
    const jobId = queued.jobId;
    const job = {
      id: jobId,
      status: queued.status || 'queued',
      format,
      quality,
      source,
      url,
    };

    await updateRecentJob(jobId, {
      apiBase: cfg.apiBase,
      status: job.status,
      job,
      autoDownload: cfg.autoDownload,
      downloadDirectory: cfg.downloadDirectory,
    });
    await notify('DyrakArmy', `Задачата #${String(jobId).slice(0, 8)} е добавена.`);
    void watchJobAndOpen(cfg.apiBase, jobId, {
      autoDownload: cfg.autoDownload,
      downloadDirectory: cfg.downloadDirectory,
    }).catch(() => undefined);

    return { job, queuePayload, autoDownload: cfg.autoDownload };
  }

  async function getTrackedJobStatus(jobId, apiBase) {
    const cfg = await getConfig();
    const base = normalizeApiBase(apiBase || cfg.apiBase);
    const job = await getJob(base, jobId);
    await updateRecentJob(jobId, {
      apiBase: base,
      status: job ? job.status : 'unknown',
      job,
      autoDownload: cfg.autoDownload,
      downloadDirectory: cfg.downloadDirectory,
    });
    return job;
  }

  async function handleContextDownload(url) {
    const targetUrl = String(url || '').trim();
    if (!isValidHttpUrl(targetUrl)) {
      await notify('DyrakArmy', 'Липсва валиден линк за сваляне.');
      return;
    }

    try {
      const cfg = await getConfig();
      await queueAndStart({
        url: targetUrl,
        format: cfg.format,
        quality: cfg.quality,
        source: detectSourceFromUrl(targetUrl) || cfg.source,
      });
    } catch (error) {
      await notify('DyrakArmy', `Грешка: ${safeMessage(error, 'Неуспешно сваляне.')}`);
    }
  }

  async function openWebApp() {
    const cfg = await getConfig();
    await tabsCreate({ url: buildWebUrl(cfg) });
  }

  async function createMenuSafe(options) {
    try {
      await contextMenusCreate(options);
    } catch (error) {
      console.warn(`Context menu skipped: ${options.id}`, error);
    }
  }

  async function setupContextMenus() {
    try {
      await contextMenusRemoveAll();
    } catch (error) {
      console.warn('Context menu cleanup failed', error);
    }

    await createMenuSafe({ id: MENU_IDS.downloadLink, title: 'Свали линка с DyrakArmy', contexts: ['link'] });
    await createMenuSafe({ id: MENU_IDS.downloadMedia, title: 'Свали медия с DyrakArmy', contexts: ['audio', 'video'] });
    await createMenuSafe({ id: MENU_IDS.downloadPage, title: 'Свали текущата страница с DyrakArmy', contexts: ['page'] });
    await createMenuSafe({ id: MENU_IDS.openWeb, title: 'Отвори DyrakArmy Web App', contexts: ['action'] });
  }

  async function handleRuntimeMessage(message) {
    const msg = message && typeof message === 'object' ? message : {};
    if (msg.type === 'ping') return { ok: true };
    if (msg.type === 'getConfig') return { ok: true, config: await getConfig() };
    if (msg.type === 'saveConfig') return { ok: true, config: await saveConfig(msg.config || {}) };
    if (msg.type === 'queueDownload') return { ok: true, result: await queueAndStart(msg.payload || {}) };
    if (msg.type === 'getJobStatus') return { ok: true, job: await getTrackedJobStatus(String(msg.jobId || ''), msg.apiBase) };
    if (msg.type === 'openWebApp') {
      await openWebApp();
      return { ok: true };
    }
    if (msg.type === 'getActiveTabUrl') return { ok: true, url: await getActiveTabUrlFallback() };
    return { ok: false, error: 'Unknown message type' };
  }

  ext.runtime.onInstalled.addListener(() => {
    void setupContextMenus();
  });

  if (ext.runtime.onStartup) {
    ext.runtime.onStartup.addListener(() => {
      void setupContextMenus();
    });
  }

  if (ext.contextMenus && ext.contextMenus.onClicked) {
    ext.contextMenus.onClicked.addListener((info) => {
      if (!info || !info.menuItemId) return;
      const menuId = String(info.menuItemId);
      if (menuId === MENU_IDS.openWeb) {
        void openWebApp();
      } else if (menuId === MENU_IDS.downloadPage) {
        void handleContextDownload(info.pageUrl || '');
      } else if (menuId === MENU_IDS.downloadLink) {
        void handleContextDownload(info.linkUrl || '');
      } else if (menuId === MENU_IDS.downloadMedia) {
        void handleContextDownload(info.srcUrl || info.linkUrl || info.pageUrl || '');
      }
    });
  }

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const promise = handleRuntimeMessage(message)
      .catch((error) => ({ ok: false, error: safeMessage(error, 'Extension error') }));

    if (IS_PROMISE_API) return promise;
    promise.then(sendResponse);
    return true;
  });
})();
