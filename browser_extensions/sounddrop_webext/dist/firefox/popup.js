(() => {
  const ext = globalThis.chrome || globalThis.browser;
  if (!ext) {
    return;
  }

  const LOSSLESS_FORMATS = new Set(['flac', 'wav']);
  const LOSSLESS_QUALITIES = ['lossless', 'best'];
  const LOSSY_QUALITIES = ['best', '320', '256', '192', '128', '96'];

  const el = {
    trackUrl: document.getElementById('trackUrl'),
    useTabBtn: document.getElementById('useTabBtn'),
    openWebBtn: document.getElementById('openWebBtn'),
    formatSelect: document.getElementById('formatSelect'),
    qualitySelect: document.getElementById('qualitySelect'),
    sourceSelect: document.getElementById('sourceSelect'),
    langSelect: document.getElementById('langSelect'),
    apiBaseInput: document.getElementById('apiBaseInput'),
    syncKeyInput: document.getElementById('syncKeyInput'),
    autoDownloadToggle: document.getElementById('autoDownloadToggle'),
    downloadDirectoryInput: document.getElementById('downloadDirectoryInput'),
    telegramModeSelect: document.getElementById('telegramModeSelect'),
    saveConfigBtn: document.getElementById('saveConfigBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    statusBox: document.getElementById('statusBox'),
  };
  let forcedUpdateUrl = '';

  function setStatus(text) {
    if (!el.statusBox) return;
    el.statusBox.textContent = String(text || '').trim() || '...';
  }

  function messagePromise(payload) {
    return new Promise((resolve, reject) => {
      try {
        ext.runtime.sendMessage(payload, (response) => {
          const runtimeError = ext.runtime && ext.runtime.lastError ? ext.runtime.lastError.message : '';
          if (runtimeError) {
            reject(new Error(runtimeError));
            return;
          }
          if (!response || response.ok !== true) {
            reject(new Error(response && response.error ? response.error : 'Unknown extension error'));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function renderQualityOptions(format, selectedQuality) {
    if (!el.qualitySelect) return;
    const options = LOSSLESS_FORMATS.has(format) ? LOSSLESS_QUALITIES : LOSSY_QUALITIES;
    el.qualitySelect.innerHTML = '';
    options.forEach((quality) => {
      const opt = document.createElement('option');
      opt.value = quality;
      opt.textContent = quality;
      el.qualitySelect.appendChild(opt);
    });
    if (selectedQuality && options.includes(selectedQuality)) {
      el.qualitySelect.value = selectedQuality;
    } else {
      el.qualitySelect.value = options[0];
    }
  }

  function readConfigFromForm() {
    const format = String(el.formatSelect?.value || 'mp3');
    return {
      apiBase: String(el.apiBaseInput?.value || '').trim(),
      format,
      quality: String(el.qualitySelect?.value || ''),
      source: String(el.sourceSelect?.value || 'all'),
      autoDownload: !!el.autoDownloadToggle?.checked,
      syncKey: String(el.syncKeyInput?.value || '').trim(),
      lang: String(el.langSelect?.value || 'bg'),
      downloadDirectory: String(el.downloadDirectoryInput?.value || '').trim(),
      telegramLinkMode: String(el.telegramModeSelect?.value || 'bot').toLowerCase() === 'download' ? 'download' : 'bot',
    };
  }

  async function loadConfig() {
    setStatus('Зареждане на настройките...');
    const response = await messagePromise({ type: 'getConfig' });
    const cfg = response.config || {};

    if (el.apiBaseInput) el.apiBaseInput.value = cfg.apiBase || '';
    if (el.formatSelect) el.formatSelect.value = cfg.format || 'mp3';
    renderQualityOptions(String(cfg.format || 'mp3'), String(cfg.quality || '320'));
    if (el.sourceSelect) el.sourceSelect.value = cfg.source || 'all';
    if (el.autoDownloadToggle) el.autoDownloadToggle.checked = !!cfg.autoDownload;
    if (el.syncKeyInput) el.syncKeyInput.value = cfg.syncKey || '';
    if (el.langSelect) el.langSelect.value = cfg.lang || 'bg';
    if (el.downloadDirectoryInput) el.downloadDirectoryInput.value = cfg.downloadDirectory || '';
    if (el.telegramModeSelect) el.telegramModeSelect.value = cfg.telegramLinkMode === 'download' ? 'download' : 'bot';

    if (cfg.blocked) {
      forcedUpdateUrl = String(cfg.updateUrl || '').trim();
      const updateHint = forcedUpdateUrl ? `\nUpdate: ${forcedUpdateUrl}` : '';
      setStatus(`Нужен е ъпдейт. Мин. версия: ${cfg.requiredVersion || 'n/a'}.${updateHint}`);
      if (el.downloadBtn) el.downloadBtn.disabled = true;
      if (el.openWebBtn) el.openWebBtn.textContent = 'Update';
    } else {
      forcedUpdateUrl = '';
      if (el.downloadBtn) el.downloadBtn.disabled = false;
      if (el.openWebBtn) el.openWebBtn.textContent = 'Open Web';
      setStatus('Готово.');
    }
  }

  async function saveConfig() {
    const patch = readConfigFromForm();
    setStatus('Запазване...');
    const response = await messagePromise({ type: 'saveConfig', config: patch });
    const cfg = response.config || patch;
    renderQualityOptions(String(cfg.format || patch.format), String(cfg.quality || patch.quality));
    setStatus('Настройките са запазени.');
    return cfg;
  }

  async function fillUrlFromActiveTab() {
    setStatus('Вземам URL от активния таб...');
    const response = await messagePromise({ type: 'getActiveTabUrl' });
    if (el.trackUrl) {
      el.trackUrl.value = String(response.url || '');
    }
    setStatus('URL е попълнен от текущия таб.');
  }

  async function queueDownloadNow() {
    const url = String(el.trackUrl?.value || '').trim();
    if (!url) {
      setStatus('Постави URL преди сваляне.');
      return;
    }

    const cfg = await saveConfig();
    if (cfg.blocked) {
      setStatus(`Нужен е ъпдейт. Мин. версия: ${cfg.requiredVersion || 'n/a'}`);
      return;
    }
    setStatus('Добавяне в опашка...');

    const response = await messagePromise({
      type: 'queueDownload',
      payload: {
        url,
        format: cfg.format,
        quality: cfg.quality,
        source: cfg.source,
      },
    });

    const job = response.result && response.result.job ? response.result.job : null;
    if (!job) {
      setStatus('Няма върнат резултат от задачата.');
      return;
    }

    const summary = [
      'Готово.',
      `ID: ${String(job.id || '').slice(0, 8)}`,
      `Статус: ${job.status}`,
      `${job.artist || 'Unknown'} - ${job.title || 'Track'}`,
      job.download_url ? `Линк: ${job.download_url}` : '',
    ].filter(Boolean).join('\n');

    setStatus(summary);
  }

  function bindEvents() {
    if (el.formatSelect) {
      el.formatSelect.addEventListener('change', () => {
        renderQualityOptions(String(el.formatSelect.value || 'mp3'), String(el.qualitySelect?.value || ''));
      });
    }

    el.useTabBtn?.addEventListener('click', () => {
      void fillUrlFromActiveTab().catch((error) => {
        setStatus(`Грешка: ${error && error.message ? error.message : error}`);
      });
    });

    el.openWebBtn?.addEventListener('click', () => {
      if (forcedUpdateUrl) {
        try {
          window.open(forcedUpdateUrl, '_blank', 'noopener,noreferrer');
          return;
        } catch {
          // fallback to background open
        }
      }
      void messagePromise({ type: 'openWebApp' }).catch((error) => {
        setStatus(`Грешка: ${error && error.message ? error.message : error}`);
      });
    });

    el.saveConfigBtn?.addEventListener('click', () => {
      void saveConfig().catch((error) => {
        setStatus(`Грешка: ${error && error.message ? error.message : error}`);
      });
    });

    el.downloadBtn?.addEventListener('click', () => {
      void queueDownloadNow().catch((error) => {
        setStatus(`Грешка: ${error && error.message ? error.message : error}`);
      });
    });
  }

  bindEvents();
  void loadConfig().catch((error) => {
    setStatus(`Init грешка: ${error && error.message ? error.message : error}`);
  });
})();
