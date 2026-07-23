(() => {
  'use strict';

  const tg = window.Telegram?.WebApp || null;
  const initData = typeof tg?.initData === 'string' ? tg.initData : '';
  let language = localStorage.getItem('dyrakarmy.telegram.language.v20') === 'en' ? 'en' : 'bg';

  const copy = {
    bg: {
      checking: 'Проверка', online: 'Готово', guest: 'Гост',
      hero_kicker: 'DYRAKARMY В TELEGRAM', hero_title: 'Твоят свят. В един жест.',
      hero_text: 'Откривай музика, влизай в игрите и развивай общия си DyrakArmy профил.',
      explore: 'Открий', games: 'Игри', profile: 'Профил', community: 'Общност', control: 'Управление',
      tab_explore: 'Открий', tab_games: 'Игри', tab_profile: 'Профил',
      search_title: 'Намери музика', search_text: 'Търси по песен, изпълнител или албум и отвори избрания резултат в неговия официален източник.',
      search_placeholder: 'Изпълнител – песен', search_button: 'Търси', searching: 'Търсене…', empty: 'Започни с име на песен или изпълнител.', no_results: 'Няма намерени резултати.', open: 'Отвори',
      games_title: 'Games 1–10', games_text: 'Десет свързани игри с общ XP, рангове и награди.',
      profile_title: 'Твоят DyrakArmy профил', profile_text: 'Една идентичност за Mini App, игрите и Control Center.', open_profile: 'Отвори профила', open_bot: 'Отвори @dyrakarmy_bot',
      error: 'Възникна проблем. Опитай отново.',
    },
    en: {
      checking: 'Checking', online: 'Ready', guest: 'Guest',
      hero_kicker: 'DYRAKARMY IN TELEGRAM', hero_title: 'Your world. One gesture away.',
      hero_text: 'Discover music, enter the games and grow your shared DyrakArmy profile.',
      explore: 'Discover', games: 'Games', profile: 'Profile', community: 'Community', control: 'Control',
      tab_explore: 'Discover', tab_games: 'Games', tab_profile: 'Profile',
      search_title: 'Find music', search_text: 'Search by track, artist or album and open the selected result in its official source.',
      search_placeholder: 'Artist – track', search_button: 'Search', searching: 'Searching…', empty: 'Start with a track or artist name.', no_results: 'No results found.', open: 'Open',
      games_title: 'Games 1–10', games_text: 'Ten connected games with shared XP, ranks and rewards.',
      profile_title: 'Your DyrakArmy profile', profile_text: 'One identity for the Mini App, games and Control Center.', open_profile: 'Open profile', open_bot: 'Open @dyrakarmy_bot',
      error: 'Something went wrong. Try again.',
    },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const t = (key) => copy[language]?.[key] || copy.bg[key] || key;
  const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  function applyLanguage() {
    document.documentElement.lang = language;
    localStorage.setItem('dyrakarmy.telegram.language.v20', language);
    $('#languageBtn').textContent = language.toUpperCase();
    $$('[data-copy]').forEach((node) => {
      const value = t(node.dataset.copy);
      if (value) node.textContent = value;
    });
    const input = $('#musicSearch');
    if (input) input.placeholder = t('search_placeholder');
  }

  function applyTelegramTheme() {
    if (!tg) return;
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.('#03040b');
    tg.setBackgroundColor?.('#03040b');
  }

  function activateTab(name) {
    $$('[data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
    $$('[data-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === name));
  }

  function setConnection(ready = true) {
    const state = $('#connectionState');
    if (!state) return;
    state.dataset.state = ready ? 'ready' : 'checking';
    $('b', state).textContent = t(ready ? 'online' : 'checking');
  }

  async function loadProfile() {
    if (!initData) {
      $('#profileName').textContent = t('guest');
      $('#profileMeta').textContent = 'Telegram Mini App';
      setConnection(true);
      return;
    }
    try {
      const response = await fetch('/api/telegram/v10/miniapp/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ init_data: initData }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const payload = await response.json();
      const user = payload.user || {};
      const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || t('guest');
      $('#profileName').textContent = name;
      $('#profileMeta').textContent = user.username ? `@${user.username}` : 'DyrakArmy Member';
      $('#profileAvatar').textContent = String(user.first_name || 'DA').slice(0, 2).toUpperCase();
      $('#profileCardName').textContent = name;
      $('#profileCardRole').textContent = String(payload.role || payload.profile?.role || 'MEMBER').toUpperCase();
      const game = payload.game_profile || payload.profile?.game_profile || {};
      $('#profileXp').textContent = String(game.xp || payload.xp || 0);
      $('#profileRank').textContent = String(game.rank || payload.rank || 'Recruit');
      setConnection(true);
    } catch {
      $('#profileName').textContent = t('guest');
      setConnection(true);
    }
  }

  async function runSearch(query, source) {
    const list = $('#searchResults');
    list.innerHTML = `<div class="da20-empty">${escapeHtml(t('searching'))}</div>`;
    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, source }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const payload = await response.json();
      const rows = (Array.isArray(payload) ? payload : payload.results || []).filter((row) => row?.url).slice(0, 12);
      if (!rows.length) {
        list.innerHTML = `<div class="da20-empty">${escapeHtml(t('no_results'))}</div>`;
        return;
      }
      list.innerHTML = rows.map((row) => `<article class="da20-result">
        <span class="da20-result-icon">♪</span>
        <div><b>${escapeHtml(row.artist || 'DyrakArmy')} — ${escapeHtml(row.title || 'Untitled')}</b><small>${escapeHtml(row.source || source || 'music')}</small></div>
        <a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('open'))} ↗</a>
      </article>`).join('');
    } catch {
      list.innerHTML = `<div class="da20-empty">${escapeHtml(t('error'))}</div>`;
    }
  }

  function bindEvents() {
    $('#languageBtn').addEventListener('click', () => {
      language = language === 'bg' ? 'en' : 'bg';
      applyLanguage();
    });
    $$('[data-tab]').forEach((button) => button.addEventListener('click', () => activateTab(button.dataset.tab)));
    $$('[data-open-tab]').forEach((button) => button.addEventListener('click', () => {
      activateTab(button.dataset.openTab);
      document.querySelector('.da20-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    $('#searchForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const query = $('#musicSearch').value.trim();
      if (query) void runSearch(query, $('#musicSource').value);
    });
  }

  function init() {
    applyTelegramTheme();
    applyLanguage();
    bindEvents();
    setConnection(false);
    void loadProfile();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
