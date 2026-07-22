(() => {
  'use strict';
  const tg = window.Telegram?.WebApp || null;
  const initData = String(tg?.initData || '');
  const state = { snapshot: null, session: localStorage.getItem('dyrakarmy.platform.session.v2') || '', events: [], moduleOrder: [], linkTimer: 0, installPrompt: null };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const t = (key, values = {}) => window.DyrakControlI18n?.t?.(key, values) || key;

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
  function shortDate(value) { return window.DyrakControlI18n?.formatDate?.(value) || '—'; }
  function toast(message, type = '') { const node = $('#toast'); node.textContent = message; node.className = `toast show ${type}`.trim(); clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.className = 'toast'; }, 2800); }
  function setSync(mode, label) { const node = $('#syncState'); node.className = `status ${mode}`; node.textContent = label || t(mode === 'online' ? 'live' : mode === 'offline' ? 'error' : mode === 'waiting' ? 'sync' : 'login'); }
  function can(capability) { return (state.snapshot?.capabilities || []).includes(capability); }

  async function api(action, data = {}, allowAnonymous = false, retry = true) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (state.session) headers.Authorization = `Bearer ${state.session}`;
    let response;
    try {
      response = await fetch('/api/platform/governance', { method: 'POST', headers, body: JSON.stringify({ action, init_data: allowAnonymous ? '' : initData, ...data }) });
    } catch (networkError) {
      const error = new Error(t('api_unavailable'));
      error.code = 'NETWORK_ERROR';
      error.cause = networkError;
      throw error;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      const code = body?.error?.code || 'API_FAILED';
      if (retry && response.status >= 500 && ['identity.link.start', 'identity.link.status'].includes(action)) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return api(action, data, allowAnonymous, false);
      }
      const fallback = response.status >= 500 ? t('api_unavailable') : `HTTP ${response.status}`;
      const error = new Error(body?.error?.message || fallback);
      error.code = code;
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async function bootstrap() {
    tg?.ready?.(); tg?.expand?.();
    try { tg?.setHeaderColor?.('#080613'); tg?.setBackgroundColor?.('#080613'); } catch {}
    bind();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => undefined);
    if (initData && !state.session) {
      try { const result = await api('identity.telegram.session', { device_name: deviceLabel() }, true); saveSession(result.session_token); } catch (error) { $('#authError').textContent = error.message; }
    }
    if (state.session || initData) await refresh(); else showAuth();
  }

  function bind() {
    $$('.tabs button').forEach((button) => button.addEventListener('click', () => openTab(button.dataset.tab)));
    $('#refreshBtn').addEventListener('click', () => refresh());
    $('#linkDeviceBtn').addEventListener('click', () => startLink());
    $('#saveOrderBtn').addEventListener('click', () => saveOrder());
    $('#createVersionBtn').addEventListener('click', () => createVersion());
    $('#roleForm').addEventListener('submit', (event) => { event.preventDefault(); assignRole(event.currentTarget); });
    $('#profileForm').addEventListener('submit', (event) => { event.preventDefault(); saveProfile(event.currentTarget); });
    $('#logoutBtn').addEventListener('click', logout);
    window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); state.installPrompt = event; $('#installBtn').hidden = false; });
    $('#installBtn').addEventListener('click', async () => { await state.installPrompt?.prompt?.(); state.installPrompt = null; $('#installBtn').hidden = true; });
    document.addEventListener('dyrakarmy:control-language', () => { if (state.snapshot) render(); else showAuth(); });
  }

  function showAuth() { $('#authView').hidden = false; $('#workspace').hidden = true; setSync('offline', t('login')); }
  function showWorkspace() { $('#authView').hidden = true; $('#workspace').hidden = false; }
  function saveSession(token) { state.session = String(token || ''); if (state.session) localStorage.setItem('dyrakarmy.platform.session.v2', state.session); }
  function deviceLabel() { return `${navigator.platform || 'Device'} · ${navigator.userAgent.includes('Mobile') ? 'Mobile' : 'Desktop'}`.slice(0, 80); }

  async function refresh() {
    setSync('waiting', t('sync'));
    try {
      const snapshot = await api('snapshot');
      state.snapshot = snapshot;
      state.moduleOrder = (snapshot.modules || []).map((module) => module.id);
      render(); showWorkspace(); setSync('online', t('live')); connectRealtime();
      await loadProfile();
    } catch (error) {
      if (['AUTH_REQUIRED', 'TELEGRAM_AUTH_FAILED'].includes(error.code)) { saveSession(''); localStorage.removeItem('dyrakarmy.platform.session.v2'); showAuth(); }
      setSync('offline', t('error')); toast(error.message, 'error');
    }
  }

  async function startLink() {
    $('#authError').textContent = '';
    $('#linkDeviceBtn').disabled = true;
    try {
      const result = await api('identity.link.start', { device_name: $('#deviceName').value || deviceLabel() }, true);
      $('#linkBox').hidden = false;
      $('#linkCommand').textContent = result.command;
      $('#openTelegramLink').href = result.telegram_url;
      $('#linkStatus').textContent = t('waiting_confirmation');
      clearInterval(state.linkTimer);
      state.linkTimer = setInterval(() => checkLink(result.code), 1800);
      checkLink(result.code);
    } catch (error) {
      $('#authError').textContent = `${error.code ? `${error.code}: ` : ''}${error.message}`;
    } finally {
      $('#linkDeviceBtn').disabled = false;
    }
  }

  async function checkLink(code) {
    try {
      const result = await api('identity.link.status', { code }, true);
      if (result.status === 'approved') {
        clearInterval(state.linkTimer); saveSession(result.session_token); $('#linkStatus').textContent = t('connected'); toast(t('device_connected'), 'success'); await refresh();
      }
      if (result.status === 'expired') { clearInterval(state.linkTimer); $('#linkStatus').textContent = t('code_expired'); }
    } catch (error) {
      if (error.status >= 500) $('#linkStatus').textContent = t('kv_fallback');
    }
  }

  function openTab(name) { $$('.tabs button').forEach((button) => button.classList.toggle('active', button.dataset.tab === name)); $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === name)); }
  function render() { renderOverview(); renderModules(); renderUsers(); renderVersions(); renderIdentity(); }

  function renderOverview() {
    const modules = state.snapshot?.modules || [], content = state.snapshot?.content || [], users = state.snapshot?.users || [], versions = state.snapshot?.versions || [];
    $('#welcomeTitle').textContent = t('welcome', { name: state.snapshot?.actor?.display_name || 'DyrakArmy' });
    $('#actorLine').textContent = `${String(state.snapshot?.actor?.role || 'user').toUpperCase()} · ${state.snapshot?.actor?.auth_mode || 'session'} · Governance ${state.snapshot?.version || '2.0.0'}`;
    $('#revisionValue').textContent = versions[0]?.revision ? `r${versions[0].revision}` : 'r0';
    $('#metricEnabled').textContent = modules.filter((item) => item.enabled).length;
    $('#metricTotal').textContent = t('metric_from', { count: modules.length });
    $('#metricContent').textContent = content.filter((item) => item.visible).length;
    $('#metricUsers').textContent = users.length;
    $('#metricVersions').textContent = versions.length;
    renderEvents();
  }

  function renderEvents() {
    const list = $('#eventList');
    list.innerHTML = state.events.length ? state.events.slice(-30).reverse().map((event) => `<article class="row"><span class="row-icon">↻</span><div class="row-main"><b>${escapeHtml(event.event_type)}</b><small>${escapeHtml(event.target_type)} · ${escapeHtml(event.target_id)} · ${escapeHtml(shortDate(event.created_at))}</small></div><span class="pill">${event.revision ? `r${escapeHtml(event.revision)}` : 'LIVE'}</span></article>`).join('') : `<div class="empty">${escapeHtml(t('no_events'))}</div>`;
  }

  function renderModules() {
    const modules = state.moduleOrder.map((id) => (state.snapshot?.modules || []).find((item) => item.id === id)).filter(Boolean);
    $('#saveOrderBtn').hidden = !can('module.write');
    $('#moduleList').innerHTML = modules.length ? modules.map((module, index) => `<article class="row" data-id="${escapeHtml(module.id)}"><span class="row-icon">${escapeHtml(module.icon || '◈')}</span><div class="row-main"><b>${escapeHtml(module.title)}</b><small>${escapeHtml(module.description || '')}</small><div class="pills"><span class="pill ${module.enabled ? 'on' : 'off'}">${escapeHtml(t(module.enabled ? 'public' : 'hidden'))}</span><span class="pill">${escapeHtml(module.kind)}</span>${module.system ? `<span class="pill">${escapeHtml(t('system'))}</span>` : ''}</div></div><div class="row-actions">${can('module.write') ? `<button class="mini" data-move="up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="mini" data-move="down" ${index === modules.length - 1 ? 'disabled' : ''}>↓</button><button class="switch ${module.enabled ? 'on' : ''}" data-toggle aria-label="${escapeHtml(t('show_hide'))}"></button>` : ''}</div></article>`).join('') : `<div class="empty">${escapeHtml(t('no_modules'))}</div>`;
    $$('#moduleList [data-toggle]').forEach((button) => button.addEventListener('click', () => toggleModule(button.closest('[data-id]').dataset.id)));
    $$('#moduleList [data-move]').forEach((button) => button.addEventListener('click', () => moveModule(button.closest('[data-id]').dataset.id, button.dataset.move)));
  }

  async function toggleModule(id) { const module = (state.snapshot.modules || []).find((item) => item.id === id); try { const result = await api('module.toggle', { id, enabled: !module.enabled }); mergeSnapshot(result); toast(t(module.enabled ? 'module_hidden' : 'module_published', { title: module.title }), 'success'); } catch (error) { toast(error.message, 'error'); } }
  function moveModule(id, direction) { const index = state.moduleOrder.indexOf(id), next = direction === 'up' ? index - 1 : index + 1; if (index < 0 || next < 0 || next >= state.moduleOrder.length) return; [state.moduleOrder[index], state.moduleOrder[next]] = [state.moduleOrder[next], state.moduleOrder[index]]; renderModules(); }
  async function saveOrder() { try { const result = await api('module.reorder', { ids: state.moduleOrder }); mergeSnapshot(result); toast(t('order_saved'), 'success'); } catch (error) { toast(error.message, 'error'); } }

  function renderUsers() {
    const users = state.snapshot?.users || [];
    $('#roleForm').hidden = !can('roles.write');
    $('#userList').innerHTML = users.length ? users.map((user) => `<article class="row"><span class="row-icon">${escapeHtml((user.display_name || '?').slice(0, 1).toUpperCase())}</span><div class="row-main"><b>${escapeHtml(user.display_name || user.telegram_user_id)}</b><small>${user.username ? `@${escapeHtml(user.username)} · ` : ''}ID ${escapeHtml(user.telegram_user_id)} · ${escapeHtml(shortDate(user.last_seen_at))}</small></div><span class="pill ${user.role === 'owner' ? 'on' : ''}">${escapeHtml(user.role)}</span></article>`).join('') : `<div class="empty">${escapeHtml(t('no_roles'))}</div>`;
  }

  async function assignRole(form) { const values = Object.fromEntries(new FormData(form)); try { const result = await api('role.assign', { telegram_user_id: Number(values.telegram_user_id), role: values.role }); state.snapshot.users = result.users || []; renderUsers(); form.reset(); toast(t('role_updated'), 'success'); } catch (error) { toast(error.message, 'error'); } }

  function renderVersions() {
    const versions = state.snapshot?.versions || [];
    $('#createVersionBtn').hidden = !can('versions.write');
    $('#versionList').innerHTML = versions.length ? versions.map((version) => `<article class="row" data-revision="${escapeHtml(version.revision)}"><span class="row-icon">r${escapeHtml(version.revision)}</span><div class="row-main"><b>${escapeHtml(version.label)}</b><small>${escapeHtml(version.action)} · ${escapeHtml(version.created_by_name)} · ${escapeHtml(shortDate(version.created_at))}</small></div><div class="row-actions">${can('versions.rollback') ? '<button class="mini danger" data-rollback>↶</button>' : ''}</div></article>`).join('') : `<div class="empty">${escapeHtml(t('no_versions'))}</div>`;
    $$('#versionList [data-rollback]').forEach((button) => button.addEventListener('click', () => rollback(Number(button.closest('[data-revision]').dataset.revision))));
  }

  async function createVersion() { const label = prompt(t('snapshot_name'), t('snapshot_default')); if (!label) return; try { const result = await api('version.create', { label }); state.snapshot.versions.unshift(result.version); renderVersions(); renderOverview(); toast(t('snapshot_created'), 'success'); } catch (error) { toast(error.message, 'error'); } }
  async function rollback(revision) { if (!confirm(t('rollback_confirm', { revision }))) return; try { const result = await api('version.rollback', { revision }); mergeSnapshot(result); await refresh(); toast(t('restored', { revision }), 'success'); } catch (error) { toast(error.message, 'error'); } }

  async function loadProfile() { try { const result = await api('profile.get'); state.profile = result.profile; renderIdentity(); } catch {} }
  function renderIdentity() {
    const user = state.profile?.user || {}, profile = user.profile || {}, form = $('#profileForm');
    form.elements.display_name.value = user.display_name || ''; form.elements.bio.value = profile.bio || ''; form.elements.locale.value = profile.locale || user.language_code || ''; form.elements.theme.value = profile.theme || state.profile?.game_profile?.equipped_theme || ''; form.elements.avatar_url.value = profile.avatar_url || '';
    const game = state.profile?.game_profile;
    $('#gameProfile').innerHTML = game ? `<b>${escapeHtml(t('game_profile'))}</b><p>XP: ${escapeHtml(game.total_xp)} · ${escapeHtml(t('games'))}: ${escapeHtml(game.total_games)} · ${escapeHtml(t('best_score'))}: ${escapeHtml(game.best_score)}</p><small>${escapeHtml(game.equipped_title)} · ${escapeHtml(game.equipped_badge)} · ${escapeHtml(game.equipped_theme)}</small>` : `<span class="empty">${escapeHtml(t('game_profile_empty'))}</span>`;
  }
  async function saveProfile(form) { const profile = Object.fromEntries(new FormData(form)); try { const result = await api('profile.update', { profile }); state.profile = result.profile; renderIdentity(); toast(t('profile_synced'), 'success'); } catch (error) { toast(error.message, 'error'); } }

  function mergeSnapshot(result) { for (const key of ['modules', 'content', 'settings', 'audit']) if (result[key]) state.snapshot[key] = result[key]; if (result.governance) state.snapshot.versions = [result.governance, ...(state.snapshot.versions || [])]; state.moduleOrder = (state.snapshot.modules || []).map((item) => item.id); render(); }
  function connectRealtime() { if (state.eventSource) state.eventSource.close(); const since = state.events.at(-1)?.sequence || 0; const source = new EventSource(`/api/platform/realtime?since=${encodeURIComponent(since)}`); state.eventSource = source; source.onopen = () => setSync('online', t('live')); source.onmessage = consumeEvent; ['module.toggle','module.upsert','module.delete','content.upsert','content.delete','setting.set','module.reordered','version.rolled_back'].forEach((name) => source.addEventListener(name, consumeEvent)); source.addEventListener('heartbeat', () => setSync('online', t('live'))); source.onerror = () => setSync('waiting', t('sync')); }
  function consumeEvent(event) { try { const data = JSON.parse(event.data); if (!data.event_type) return; if (!state.events.some((item) => item.sequence === data.sequence)) state.events.push(data); state.events = state.events.slice(-100); renderEvents(); if (document.visibilityState === 'visible') refreshDebounced(); } catch {} }
  function refreshDebounced() { clearTimeout(refreshDebounced.timer); refreshDebounced.timer = setTimeout(() => refresh(), 700); }
  async function logout() { try { if (state.snapshot?.actor?.session_id) await api('session.revoke', { session_id: state.snapshot.actor.session_id }); } catch {} localStorage.removeItem('dyrakarmy.platform.session.v2'); state.session = ''; state.eventSource?.close(); showAuth(); }

  bootstrap();
})();
