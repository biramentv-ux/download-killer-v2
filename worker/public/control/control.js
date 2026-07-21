(() => {
  'use strict';

  const tg = window.Telegram?.WebApp || null;
  const initData = String(tg?.initData || '');
  const state = { snapshot: null, moduleEditing: null, contentEditing: null };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function haptic(type = 'light') {
    try { tg?.HapticFeedback?.impactOccurred(type); } catch { /* no-op */ }
  }

  function toast(message, type = '') {
    const node = $('#controlToast');
    node.textContent = message;
    node.className = `control-toast show ${type}`.trim();
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.className = 'control-toast'; }, 3200);
  }

  async function control(action, data = {}) {
    const response = await fetch('/api/platform/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ init_data: initData, action, ...data }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.error) {
      const error = new Error(body?.error?.message || `HTTP ${response.status}`);
      error.code = body?.error?.code || 'CONTROL_FAILED';
      throw error;
    }
    return body;
  }

  async function bootstrap() {
    tg?.ready?.();
    tg?.expand?.();
    try { tg?.setHeaderColor?.('#070a18'); tg?.setBackgroundColor?.('#070a18'); } catch { /* no-op */ }
    bindEvents();
    if (!initData) {
      setAccess('denied', 'Изисква Telegram');
      $('#accessDetail').textContent = 'Отвори @dyrakarmy_bot и изпрати /control.';
      return;
    }
    await refreshSnapshot();
  }

  function bindEvents() {
    $$('.control-tabs button').forEach((button) => button.addEventListener('click', () => openTab(button.dataset.tab)));
    $$('[data-open-tab]').forEach((button) => button.addEventListener('click', () => openTab(button.dataset.openTab)));
    $('#refreshControlBtn').addEventListener('click', () => void refreshSnapshot());
    $('#reloadAuditBtn').addEventListener('click', () => void refreshSnapshot('audit'));
    $('#exportControlBtn').addEventListener('click', () => void exportSnapshot());
    $('#newModuleBtn').addEventListener('click', () => openModuleDialog());
    $('#newContentBtn').addEventListener('click', () => openContentDialog());
    $('#moduleForm').addEventListener('submit', (event) => { event.preventDefault(); void saveModule(); });
    $('#contentForm').addEventListener('submit', (event) => { event.preventDefault(); void saveContent(); });
    $('#settingsForm').addEventListener('submit', (event) => { event.preventDefault(); void saveSettings(); });
  }

  function openTab(name) {
    $$('.control-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
    $$('.control-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === name));
    const target = $(`.control-tabs button[data-tab="${cssEscape(name)}"]`);
    target?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }

  async function refreshSnapshot(openAfter = '') {
    try {
      setAccess('', 'Проверка');
      const snapshot = await control('snapshot');
      state.snapshot = snapshot;
      $('#accessCard').hidden = true;
      $('#controlWorkspace').hidden = false;
      setAccess('online', snapshot.admin?.display_name || 'Admin');
      renderAll();
      if (openAfter) openTab(openAfter);
    } catch (error) {
      $('#accessCard').hidden = false;
      $('#controlWorkspace').hidden = true;
      setAccess('denied', error.code === 'ADMIN_REQUIRED' ? 'Няма достъп' : 'Auth грешка');
      $('#accessDetail').textContent = error.message || String(error);
      toast(error.message || String(error), 'error');
    }
  }

  function setAccess(className, label) {
    const node = $('#controlAuth');
    node.className = `control-auth ${className}`.trim();
    node.querySelector('span').textContent = label;
  }

  function renderAll() {
    renderOverview();
    renderModules();
    renderContent();
    renderSettings();
    renderAudit();
  }

  function renderOverview() {
    const modules = state.snapshot?.modules || [];
    const content = state.snapshot?.content || [];
    const audit = state.snapshot?.audit || [];
    $('#metricEnabled').textContent = String(modules.filter((module) => module.enabled).length);
    $('#metricTotal').textContent = `от ${modules.length}`;
    $('#metricContent').textContent = String(content.length);
    $('#metricGames').textContent = String(modules.filter((module) => module.kind === 'game' && module.enabled).length);
    $('#metricUpdated').textContent = audit[0]?.created_at ? shortDate(audit[0].created_at) : '—';
  }

  function renderModules() {
    const modules = state.snapshot?.modules || [];
    const container = $('#moduleList');
    container.innerHTML = modules.length ? modules.map((module) => `
      <article class="module-row" data-module-id="${escapeAttr(module.id)}">
        <span class="module-icon">${escapeHtml(module.icon || '◈')}</span>
        <div class="row-main"><b>${escapeHtml(module.title)}</b><small>${escapeHtml(module.description || '')}</small><div class="row-meta"><span class="pill ${module.enabled ? '' : 'off'}">${module.enabled ? 'PUBLIC' : 'HIDDEN'}</span><span class="pill">${escapeHtml(module.kind)}</span>${module.system ? '<span class="pill">SYSTEM</span>' : ''}</div></div>
        <div class="row-actions"><button class="switch ${module.enabled ? 'on' : ''}" data-action="toggle" title="Покажи или скрий"></button><button class="icon-button" data-action="edit" title="Редактирай">✎</button>${module.system ? '' : '<button class="icon-button danger" data-action="delete" title="Изтрий">×</button>'}</div>
      </article>`).join('') : '<div class="empty-state">Няма модули.</div>';
    container.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => {
      const row = button.closest('[data-module-id]');
      const module = modules.find((item) => item.id === row?.dataset.moduleId);
      if (!module) return;
      const action = button.dataset.action;
      if (action === 'toggle') void toggleModule(module);
      if (action === 'edit') openModuleDialog(module);
      if (action === 'delete') void deleteModule(module);
    }));
  }

  function renderContent() {
    const content = state.snapshot?.content || [];
    const container = $('#contentList');
    container.innerHTML = content.length ? content.map((item) => `
      <article class="content-row" data-content-id="${escapeAttr(item.id)}">
        <span class="content-icon">${escapeHtml(item.icon || '◈')}</span>
        <div class="row-main"><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.body || '')}</small><div class="row-meta"><span class="pill">${escapeHtml(item.slot)}</span><span class="pill ${item.visible ? '' : 'off'}">${item.visible ? 'PUBLIC' : 'HIDDEN'}</span></div></div>
        <div class="row-actions"><button class="icon-button" data-action="edit" title="Редактирай">✎</button><button class="icon-button danger" data-action="delete" title="Изтрий">×</button></div>
      </article>`).join('') : '<div class="empty-state">Няма добавено публично съдържание.</div>';
    container.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => {
      const row = button.closest('[data-content-id]');
      const item = content.find((value) => value.id === row?.dataset.contentId);
      if (!item) return;
      if (button.dataset.action === 'edit') openContentDialog(item);
      if (button.dataset.action === 'delete') void deleteContent(item);
    }));
  }

  function renderSettings() {
    const settings = state.snapshot?.settings || {};
    const form = $('#settingsForm');
    Object.entries(settings).forEach(([key, value]) => {
      const field = form.elements.namedItem(key);
      if (!field) return;
      if (field.type === 'checkbox') field.checked = value === true;
      else field.value = value ?? '';
    });
  }

  function renderAudit() {
    const audit = state.snapshot?.audit || [];
    $('#auditList').innerHTML = audit.length ? audit.map((item) => `
      <article class="audit-row"><time>${escapeHtml(shortDate(item.created_at))}</time><div><b>${escapeHtml(item.action)}</b><small>${escapeHtml(item.target_type)} · ${escapeHtml(item.target_id)} · ${escapeHtml(item.admin_name)}</small></div><em>ID ${escapeHtml(item.admin_user_id)}</em></article>`).join('') : '<div class="empty-state">Все още няма промени.</div>';
  }

  function openModuleDialog(module = null) {
    state.moduleEditing = module;
    const form = $('#moduleForm');
    form.reset();
    $('#moduleDialogTitle').textContent = module ? 'Редакция на модул' : 'Нов модул';
    if (module) fillForm(form, module);
    else {
      form.elements.enabled.checked = true;
      form.elements.sort_order.value = 100;
      form.elements.icon.value = '◈';
      form.elements.kind.value = 'link';
    }
    form.elements.id.readOnly = Boolean(module?.system);
    $('#moduleDialog').showModal();
  }

  async function saveModule() {
    const form = $('#moduleForm');
    const data = Object.fromEntries(new FormData(form).entries());
    data.enabled = form.elements.enabled.checked;
    data.sort_order = Number(data.sort_order || 100);
    try {
      const snapshot = await control('module.upsert', { module: data });
      state.snapshot = snapshot;
      $('#moduleDialog').close();
      renderAll();
      toast('Модулът е публикуван.', 'success');
      haptic('medium');
    } catch (error) {
      toast(error.message || String(error), 'error');
      haptic('heavy');
    }
  }

  async function toggleModule(module) {
    try {
      const snapshot = await control('module.toggle', { id: module.id, enabled: !module.enabled });
      state.snapshot = snapshot;
      renderAll();
      toast(`${module.title}: ${module.enabled ? 'скрит' : 'публикуван'}.`, 'success');
      haptic('light');
    } catch (error) { toast(error.message || String(error), 'error'); }
  }

  async function deleteModule(module) {
    if (!confirm(`Да изтрия ли модула „${module.title}“?`)) return;
    try {
      const snapshot = await control('module.delete', { id: module.id });
      state.snapshot = snapshot;
      renderAll();
      toast('Модулът е изтрит.', 'success');
    } catch (error) { toast(error.message || String(error), 'error'); }
  }

  function openContentDialog(item = null) {
    state.contentEditing = item;
    const form = $('#contentForm');
    form.reset();
    $('#contentDialogTitle').textContent = item ? 'Редакция на публичен запис' : 'Нов публичен запис';
    if (item) {
      fillForm(form, item);
      form.elements.starts_at.value = localDateValue(item.starts_at);
      form.elements.ends_at.value = localDateValue(item.ends_at);
    } else {
      form.elements.id.value = `update-${Date.now().toString(36)}`;
      form.elements.visible.checked = true;
      form.elements.sort_order.value = 100;
      form.elements.icon.value = '◈';
    }
    $('#contentDialog').showModal();
  }

  async function saveContent() {
    const form = $('#contentForm');
    const data = Object.fromEntries(new FormData(form).entries());
    data.visible = form.elements.visible.checked;
    data.sort_order = Number(data.sort_order || 100);
    data.starts_at = data.starts_at ? new Date(data.starts_at).toISOString() : null;
    data.ends_at = data.ends_at ? new Date(data.ends_at).toISOString() : null;
    try {
      const snapshot = await control('content.upsert', { content: data });
      state.snapshot = snapshot;
      $('#contentDialog').close();
      renderAll();
      toast('Съдържанието е публично.', 'success');
      haptic('medium');
    } catch (error) {
      toast(error.message || String(error), 'error');
      haptic('heavy');
    }
  }

  async function deleteContent(item) {
    if (!confirm(`Да изтрия ли „${item.title}“?`)) return;
    try {
      const snapshot = await control('content.delete', { id: item.id });
      state.snapshot = snapshot;
      renderAll();
      toast('Публичният запис е изтрит.', 'success');
    } catch (error) { toast(error.message || String(error), 'error'); }
  }

  async function saveSettings() {
    const form = $('#settingsForm');
    const values = Object.fromEntries(new FormData(form).entries());
    values['announcement.enabled'] = form.elements.namedItem('announcement.enabled').checked;
    values['theme.radius'] = Number(values['theme.radius'] || 18);
    try {
      for (const [key, value] of Object.entries(values)) {
        const snapshot = await control('setting.set', { key, value });
        state.snapshot = snapshot;
      }
      renderAll();
      toast('Визията е обновена публично.', 'success');
      haptic('medium');
    } catch (error) {
      toast(error.message || String(error), 'error');
      haptic('heavy');
    }
  }

  async function exportSnapshot() {
    try {
      const snapshot = await control('export');
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `dyrakarmy-control-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      toast('Export файлът е създаден.', 'success');
    } catch (error) { toast(error.message || String(error), 'error'); }
  }

  function fillForm(form, values) {
    Object.entries(values || {}).forEach(([key, value]) => {
      const field = form.elements.namedItem(key);
      if (!field) return;
      if (field.type === 'checkbox') field.checked = Boolean(value);
      else if (value !== null && value !== undefined) field.value = value;
    });
  }

  function localDateValue(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function shortDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || '—') : date.toLocaleString('bg-BG', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function cssEscape(value) {
    return window.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-z0-9_-]/gi, '');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character]));
  }

  function escapeAttr(value) { return escapeHtml(value); }

  document.addEventListener('DOMContentLoaded', () => void bootstrap());
})();
