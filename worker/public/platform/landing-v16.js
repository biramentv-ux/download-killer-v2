(() => {
  'use strict';

  const SESSION_KEY = 'dyrakarmy.platform.session.v2';
  const state = {
    registry: null,
    snapshot: null,
    profile: null,
    installPrompt: null,
    session: localStorage.getItem(SESSION_KEY) || '',
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

  function setupLanguageSegment() {
    const select = $('#languageSelect');
    const buttons = $$('[data-lang]');
    if (!select || !buttons.length) return;
    const sync = () => buttons.forEach((button) => button.classList.toggle('active', button.dataset.lang === select.value));
    buttons.forEach((button) => button.addEventListener('click', () => {
      select.value = button.dataset.lang || 'bg';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
    }));
    select.addEventListener('change', sync);
    sync();
  }

  function setupInstallPrompt() {
    const button = $('#installPwaBtn');
    if (!button) return;
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      state.installPrompt = event;
      button.dataset.ready = 'true';
      button.hidden = false;
    });
    button.addEventListener('click', async () => {
      if (state.installPrompt) {
        await state.installPrompt.prompt();
        state.installPrompt = null;
        button.dataset.ready = 'false';
        return;
      }
      const registration = await navigator.serviceWorker?.getRegistration?.();
      if (!registration && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      location.hash = 'home';
    });
    window.addEventListener('appinstalled', () => {
      button.textContent = 'PWA INSTALLED';
      button.disabled = true;
    });
  }

  async function governanceApi(action, data = {}, allowAnonymous = false) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (state.session) headers.Authorization = `Bearer ${state.session}`;
    const initData = String(window.Telegram?.WebApp?.initData || '');
    const response = await fetch('/api/platform/governance', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, init_data: allowAnonymous ? '' : initData, ...data }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      const error = new Error(body?.error?.message || `HTTP ${response.status}`);
      error.code = body?.error?.code || 'API_FAILED';
      throw error;
    }
    return body;
  }

  async function ensureTelegramSession() {
    const initData = String(window.Telegram?.WebApp?.initData || '');
    if (!initData || state.session) return;
    try {
      const result = await governanceApi('identity.telegram.session', { device_name: `${navigator.platform || 'Device'} · Landing v16`.slice(0, 80) }, true);
      if (result.session_token) {
        state.session = result.session_token;
        localStorage.setItem(SESSION_KEY, state.session);
      }
    } catch {}
  }

  function updateRegistry(registry) {
    state.registry = registry;
    const modules = registry?.modules || [];
    const enabled = modules.filter((item) => item.enabled);
    $('#profileModules').textContent = String(enabled.length || modules.length || 0);
    const visiblePreview = enabled.sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)).slice(0, 4);
    if (visiblePreview.length) {
      $('#previewModuleList').innerHTML = visiblePreview.map((module) => `
        <div class="preview-row"><i>⋮⋮</i><span>${escapeHtml(module.title || module.id)}</span><b>${module.enabled ? 'Active' : 'Hidden'}</b><em>${escapeHtml(module.icon || '◉')}</em></div>`).join('');
    }
  }

  function yearFromDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : String(date.getFullYear());
  }

  function applyProfile() {
    const actor = state.snapshot?.actor || {};
    const user = state.profile?.user || {};
    const game = state.profile?.game_profile || {};
    const unlocks = state.profile?.unlocks || [];
    $('#profileName').textContent = user.display_name || actor.display_name || 'DyrakArmy Guest';
    $('#profileRole').textContent = String(actor.role || user.role || 'guest').toUpperCase();
    $('#profilePoints').textContent = game.total_xp == null ? '—' : Number(game.total_xp).toLocaleString();
    $('#profileRank').textContent = game.rank ? `#${game.rank}` : (game.equipped_title || '—');
    $('#profileMemberSince').textContent = yearFromDate(user.created_at || actor.created_at);
    $('#profileSync').textContent = state.session ? 'LIVE SESSION · SYNCED' : 'PUBLIC MODE';
    $('#rewardXp').textContent = Number(game.total_xp || 0).toLocaleString();
    $('#rewardRank').textContent = game.rank ? `#${game.rank}` : (game.equipped_title || '—');
    $('#rewardUnlocks').textContent = String(Array.isArray(unlocks) ? unlocks.length : Number(unlocks?.count || 0));
  }

  async function loadPrivateDashboard() {
    await ensureTelegramSession();
    if (!state.session) { applyProfile(); return; }
    try {
      state.snapshot = await governanceApi('snapshot');
      const profileResult = await governanceApi('profile.get');
      state.profile = profileResult.profile || null;
      if (state.snapshot?.modules) updateRegistry({ modules: state.snapshot.modules });
      applyProfile();
    } catch (error) {
      if (['AUTH_REQUIRED', 'TELEGRAM_AUTH_FAILED', 'SESSION_REVOKED'].includes(error.code)) {
        state.session = '';
        localStorage.removeItem(SESSION_KEY);
      }
      applyProfile();
    }
  }

  async function loadHealthExtras() {
    const primary = $('.environment-row[href="https://dyrakarmy.eu/"] em');
    const secondary = $('.environment-row[href="https://dyrakarmy.online/"] em');
    try {
      const [health, governance] = await Promise.all([
        fetch('/api/health', { cache: 'no-store' }).then((response) => response.json()),
        fetch('/api/platform/governance/health', { cache: 'no-store' }).then((response) => response.json()),
      ]);
      const ok = Boolean(health?.ok || health?.status === 'ok' || health?.status === 'healthy');
      if (primary) primary.textContent = ok ? 'PRIMARY · LIVE' : 'PRIMARY';
      if (secondary) secondary.textContent = governance?.ok ? 'SYNCED' : 'SECONDARY';
    } catch {}
  }

  function setupModuleEffects() {
    $$('.module-card').forEach((card) => card.addEventListener('pointermove', (event) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--pointer-x', `${event.clientX - rect.left}px`);
      card.style.setProperty('--pointer-y', `${event.clientY - rect.top}px`);
    }));
  }

  async function init() {
    setupLanguageSegment();
    setupInstallPrompt();
    setupModuleEffects();
    document.addEventListener('platform-registry-ready', (event) => updateRegistry(event.detail || {}));
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    await Promise.allSettled([loadPrivateDashboard(), loadHealthExtras()]);
  }

  document.addEventListener('DOMContentLoaded', () => void init());
})();