(() => {
  'use strict';

  const SOURCE_LABELS = {
    bg: { all: 'Автоматично', youtube: 'YouTube / YouTube Music', spotify: 'Spotify resolver', soundcloud: 'SoundCloud', deezer: 'Deezer resolver', apple: 'Apple Music / iTunes', podcast: 'Podcast / RSS', internet_archive: 'Internet Archive', wikimedia_commons: 'Wikimedia Commons', audius: 'Audius', jamendo: 'Jamendo', direct: 'Директен разрешен аудио URL', musicbrainz: 'MusicBrainz метаданни' },
    en: { all: 'Automatic', youtube: 'YouTube / YouTube Music', spotify: 'Spotify resolver', soundcloud: 'SoundCloud', deezer: 'Deezer resolver', apple: 'Apple Music / iTunes', podcast: 'Podcast / RSS', internet_archive: 'Internet Archive', wikimedia_commons: 'Wikimedia Commons', audius: 'Audius', jamendo: 'Jamendo', direct: 'Direct authorized audio URL', musicbrainz: 'MusicBrainz metadata' },
    ru: { all: 'Автоматически', youtube: 'YouTube / YouTube Music', spotify: 'Spotify resolver', soundcloud: 'SoundCloud', deezer: 'Deezer resolver', apple: 'Apple Music / iTunes', podcast: 'Podcast / RSS', internet_archive: 'Internet Archive', wikimedia_commons: 'Wikimedia Commons', audius: 'Audius', jamendo: 'Jamendo', direct: 'Прямой разрешённый аудио URL', musicbrainz: 'Метаданные MusicBrainz' },
    de: { all: 'Automatisch', youtube: 'YouTube / YouTube Music', spotify: 'Spotify-Resolver', soundcloud: 'SoundCloud', deezer: 'Deezer-Resolver', apple: 'Apple Music / iTunes', podcast: 'Podcast / RSS', internet_archive: 'Internet Archive', wikimedia_commons: 'Wikimedia Commons', audius: 'Audius', jamendo: 'Jamendo', direct: 'Direkte autorisierte Audio-URL', musicbrainz: 'MusicBrainz-Metadaten' }
  };

  const state = { catalog: [], results: [], controller: null };
  const t = (key) => window.DyrakI18n?.t?.(key) || key;
  const lang = () => window.DyrakI18n?.language || document.documentElement.lang || 'bg';

  function injectStyle() {
    if (document.querySelector('#sourceDiscoveryV18Style')) return;
    const style = document.createElement('style');
    style.id = 'sourceDiscoveryV18Style';
    style.textContent = `
      .source-discovery-v18{margin:0 0 26px;padding:22px;border:1px solid rgba(0,219,255,.22);border-radius:22px;background:linear-gradient(135deg,rgba(5,17,35,.92),rgba(10,7,28,.9));box-shadow:0 20px 60px rgba(0,0,0,.22)}
      .source-discovery-head{display:flex;gap:18px;align-items:end;justify-content:space-between;flex-wrap:wrap}.source-discovery-head h3{margin:0 0 6px;font-size:clamp(1.15rem,2vw,1.7rem)}.source-discovery-head p{margin:0;color:#8da9c8;max-width:720px}
      .source-discovery-form{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:10px;margin-top:18px}.source-discovery-form input{min-width:0;border:1px solid rgba(0,219,255,.22);border-radius:13px;background:#030b17;color:#eefaff;padding:14px 16px;font:inherit}.source-discovery-form button{border:0;border-radius:13px;padding:0 22px;background:linear-gradient(100deg,#10d6e9,#178fff);font-weight:800;cursor:pointer}.source-discovery-form button:disabled{opacity:.55;cursor:wait}
      .source-provider-chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.source-provider-chip{font-size:.72rem;border:1px solid rgba(143,172,213,.22);border-radius:999px;padding:6px 9px;color:#96abc8}.source-provider-chip[data-enabled="true"]{border-color:rgba(0,219,255,.35);color:#bffaff}.source-provider-chip[data-mode="metadata"]{border-style:dashed}
      .source-results{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:18px}.source-result{display:grid;grid-template-columns:54px 1fr;gap:12px;padding:13px;border:1px solid rgba(120,150,190,.2);border-radius:15px;background:rgba(2,9,20,.7)}.source-result img{width:54px;height:54px;object-fit:cover;border-radius:10px;background:#091528}.source-result-main{min-width:0}.source-result b,.source-result small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.source-result small{color:#8ea9c8;margin-top:3px}.source-result-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.source-result-meta span{font-size:.66rem;border:1px solid rgba(0,219,255,.25);border-radius:999px;padding:3px 6px}.source-result button{grid-column:1/-1;border:1px solid rgba(0,219,255,.3);border-radius:10px;background:#07172c;color:#eafaff;padding:9px;font-weight:750;cursor:pointer}.source-result button:disabled{opacity:.5;cursor:not-allowed}.source-discovery-status{margin-top:14px;color:#94abc8}.source-rights{margin:14px 0 0;font-size:.76rem;color:#7792b3}
      @media(max-width:620px){.source-discovery-form{grid-template-columns:1fr}.source-discovery-form button{min-height:46px}}
    `;
    document.head.append(style);
  }

  function createPanel() {
    const consoleSection = document.querySelector('#console');
    const grid = consoleSection?.querySelector('.console-grid');
    if (!consoleSection || !grid || document.querySelector('#sourceDiscoveryV18')) return;
    const panel = document.createElement('section');
    panel.id = 'sourceDiscoveryV18';
    panel.className = 'source-discovery-v18';
    panel.innerHTML = `
      <div class="source-discovery-head"><div><h3 data-source-i18n="sources_title"></h3><p data-source-i18n="sources_text"></p></div></div>
      <form class="source-discovery-form" id="sourceDiscoveryForm"><input id="sourceDiscoveryQuery" type="search" minlength="2" maxlength="240" autocomplete="off"><button id="sourceDiscoverySubmit" type="submit"></button></form>
      <div class="source-provider-chips" id="sourceProviderChips"></div>
      <div class="source-discovery-status" id="sourceDiscoveryStatus" hidden></div>
      <div class="source-results" id="sourceDiscoveryResults"></div>
      <p class="source-rights" data-source-i18n="rights_notice"></p>`;
    consoleSection.insertBefore(panel, grid);
    panel.querySelector('#sourceDiscoveryForm').addEventListener('submit', search);
    applyLanguage();
  }

  async function loadCatalog() {
    try {
      const response = await fetch('/api/sources', { headers: { Accept: 'application/json' } });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
      state.catalog = payload.sources || [];
      renderCatalog();
    } catch (error) {
      console.warn('Source catalog unavailable', error);
    }
  }

  function renderCatalog() {
    const select = document.querySelector('#sourceSelect');
    if (select) {
      const current = select.value;
      const enabled = state.catalog.filter((source) => source.enabled && source.mode !== 'metadata');
      select.innerHTML = [`<option value="all">${escapeHtml(sourceLabel('all'))}</option>`, ...enabled.map((source) => `<option value="${escapeHtml(source.id)}">${escapeHtml(sourceLabel(source.id))}</option>`)].join('');
      select.value = [...select.options].some((option) => option.value === current) ? current : 'all';
    }
    const chips = document.querySelector('#sourceProviderChips');
    if (chips) chips.innerHTML = state.catalog.map((source) => `<span class="source-provider-chip" data-enabled="${Boolean(source.enabled)}" data-mode="${escapeHtml(source.mode)}" title="${escapeHtml(source.rights || '')}">${escapeHtml(sourceLabel(source.id))}${source.enabled ? '' : ' · API KEY'}</span>`).join('');
  }

  async function search(event) {
    event.preventDefault();
    const query = String(document.querySelector('#sourceDiscoveryQuery')?.value || '').trim();
    if (query.length < 2) return;
    state.controller?.abort();
    state.controller = new AbortController();
    setBusy(true, t('sources_loading'));
    try {
      const response = await fetch('/api/search/multi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, limit: 36 }),
        signal: state.controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
      state.results = payload.results || [];
      renderResults();
      setBusy(false, state.results.length ? `${state.results.length} results · ${Object.keys(payload.providers || {}).length} providers` : t('sources_empty'));
    } catch (error) {
      if (error.name === 'AbortError') return;
      setBusy(false, `${t('request_failed')} ${error.message}`);
      state.results = [];
      renderResults();
    }
  }

  function renderResults() {
    const root = document.querySelector('#sourceDiscoveryResults');
    if (!root) return;
    if (!state.results.length) { root.innerHTML = ''; return; }
    root.innerHTML = state.results.map((result, index) => {
      const usable = result.delivery !== 'metadata' && result.downloadable !== false;
      return `<article class="source-result" data-index="${index}">
        ${result.thumbnail ? `<img src="${escapeHtml(result.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div style="width:54px;height:54px;border-radius:10px;background:#091528;display:grid;place-items:center">♫</div>'}
        <div class="source-result-main"><b>${escapeHtml(result.title)}</b><small>${escapeHtml(result.artist || '')}</small><div class="source-result-meta"><span>${escapeHtml(sourceLabel(result.source))}</span><span>${escapeHtml(result.delivery)}</span>${result.license ? `<span title="${escapeHtml(result.license)}">${escapeHtml(t('license'))}</span>` : ''}</div></div>
        <button type="button" ${usable ? '' : 'disabled'}>${escapeHtml(usable ? t('use_result') : t('metadata_only'))}</button>
      </article>`;
    }).join('');
    root.querySelectorAll('.source-result button:not(:disabled)').forEach((button) => button.addEventListener('click', () => useResult(Number(button.closest('[data-index]').dataset.index))));
  }

  function useResult(index) {
    const result = state.results[index];
    if (!result?.url) return;
    const mediaUrl = document.querySelector('#mediaUrl');
    const source = document.querySelector('#sourceSelect');
    if (mediaUrl) { mediaUrl.value = result.url; mediaUrl.dispatchEvent(new Event('input', { bubbles: true })); }
    if (source && [...source.options].some((option) => option.value === result.source)) source.value = result.source;
    document.querySelector('#downloadForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function setBusy(busy, message) {
    const button = document.querySelector('#sourceDiscoverySubmit');
    const status = document.querySelector('#sourceDiscoveryStatus');
    if (button) button.disabled = busy;
    if (status) { status.hidden = false; status.textContent = message || ''; }
  }

  function applyLanguage() {
    document.querySelectorAll('[data-source-i18n]').forEach((node) => { node.textContent = t(node.dataset.sourceI18n); });
    const query = document.querySelector('#sourceDiscoveryQuery');
    if (query) query.placeholder = t('sources_placeholder');
    const button = document.querySelector('#sourceDiscoverySubmit');
    if (button) button.textContent = t('sources_search');
    renderCatalog();
    renderResults();
  }

  function sourceLabel(id) { return SOURCE_LABELS[lang()]?.[id] || SOURCE_LABELS.en[id] || id.replaceAll('_', ' '); }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

  const init = () => { injectStyle(); createPanel(); loadCatalog(); document.addEventListener('dyrakarmy:language', applyLanguage); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
