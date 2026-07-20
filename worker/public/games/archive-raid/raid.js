(() => {
  'use strict';

  const tg = window.Telegram?.WebApp || null;
  const initData = String(tg?.initData || '');
  const state = {
    catalog: [],
    profile: null,
    inventory: [],
    sessionId: '',
    practice: false,
    room: 0,
    choices: [],
    roomStartedAt: 0,
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('show'), 2800);
  }

  function haptic(type = 'light') {
    try { tg?.HapticFeedback?.impactOccurred(type); } catch { /* no-op */ }
  }

  async function api(path, body = null) {
    const options = { headers: { Accept: 'application/json' }, cache: 'no-store' };
    if (body) {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify({ init_data: initData, ...body });
    }
    const response = await fetch(`/api/games/archive-raid/${path}`, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
    return payload;
  }

  async function boot() {
    tg?.ready?.();
    tg?.expand?.();
    try { tg?.setHeaderColor?.('#080914'); tg?.setBackgroundColor?.('#080914'); } catch { /* no-op */ }
    bind();
    const catalog = await api('catalog');
    state.catalog = catalog.cards || [];
    if (initData) {
      $('#identity').classList.add('online');
      $('#identity span').textContent = tg?.initDataUnsafe?.user?.first_name || 'Telegram';
      await loadProfile();
    }
    renderCollection();
    await loadLeaderboard();
  }

  function bind() {
    $$('.raid-tabs button').forEach((button) => button.addEventListener('click', () => openTab(button.dataset.tab)));
    $('#startRaidBtn').addEventListener('click', () => void startRaid(false));
    $('#practiceRaidBtn').addEventListener('click', () => void startRaid(true));
    $('#dailyCrateBtn').addEventListener('click', () => void claimDailyCrate());
    $$('.route-grid button').forEach((button) => button.addEventListener('click', () => chooseRoute(button.dataset.route)));
    $('#rarityFilter').addEventListener('change', renderCollection);
    $('#reloadLeaderboardBtn').addEventListener('click', () => void loadLeaderboard());
    $('#closeDropBtn').addEventListener('click', () => $('#dropDialog').close());
  }

  function openTab(name) {
    $$('.raid-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
    $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === name));
  }

  async function loadProfile() {
    if (!initData) return;
    try {
      const payload = await api('profile', {});
      applyProfile(payload);
    } catch (error) {
      toast(error.message || String(error));
    }
  }

  function applyProfile(payload) {
    state.profile = payload.profile || null;
    state.inventory = payload.inventory || [];
    const profile = state.profile || {};
    $('#sharedXp').textContent = Number(profile.total_xp || 0).toLocaleString();
    $('#sharedRank').textContent = profile.rank?.name || 'Recruit';
    $('#collectionCount').textContent = `${payload.collection?.unique || 0}/${payload.collection?.catalog_total || state.catalog.length}`;
    $('#profileName').textContent = profile.display_name || 'Archive Raider';
    $('#profileMeta').textContent = `${profile.rank?.name || 'Recruit'} · ${profile.username ? `@${profile.username}` : 'DyrakArmy'}`;
    $('#profileXp').textContent = Number(profile.total_xp || 0).toLocaleString();
    $('#profileGames').textContent = Number(profile.total_games || 0).toLocaleString();
    $('#profileAttempts').textContent = `${payload.attempts_today || 0}/${payload.attempts_limit || 4}`;
    $('#profileCards').textContent = Number(payload.collection?.total || 0).toLocaleString();
    $('#profileIcon').textContent = iconForEquipped(profile.equipped_icon);
    renderCollection();
  }

  async function startRaid(practice) {
    if (!practice && !initData) {
      toast('Ranked режимът изисква отваряне през Telegram.');
      return;
    }
    try {
      const payload = await api('session', { practice });
      state.sessionId = payload.session_id;
      state.practice = practice;
      state.room = 0;
      state.choices = [];
      $('#raidIntro').hidden = true;
      $('#raidResult').hidden = true;
      $('#sectorTrack').hidden = false;
      $('#routePicker').hidden = false;
      renderSectors();
      beginRoom();
      haptic('medium');
    } catch (error) {
      toast(error.message || String(error));
    }
  }

  function beginRoom() {
    state.roomStartedAt = performance.now();
    $('#sectorLabel').textContent = `Сектор ${state.room + 1}/5`;
    renderSectors();
  }

  function chooseRoute(route) {
    if (!state.sessionId || state.room >= 5) return;
    const responseMs = Math.max(250, Math.round(performance.now() - state.roomStartedAt));
    state.choices.push({ room_index: state.room, route, response_ms: responseMs });
    state.room += 1;
    haptic(route === 'breach' ? 'heavy' : 'light');
    if (state.room >= 5) void resolveRaid();
    else beginRoom();
  }

  function renderSectors() {
    $('#sectorTrack').innerHTML = Array.from({ length: 5 }, (_, index) => {
      const status = index < state.room ? 'done' : index === state.room ? 'active' : '';
      return `<div class="sector ${status}"><b>${index < state.room ? '✓' : index + 1}</b><small>SECTOR</small></div>`;
    }).join('');
  }

  async function resolveRaid() {
    $('#routePicker').hidden = true;
    try {
      const payload = await api('resolve', {
        session_id: state.sessionId,
        practice: state.practice,
        choices: state.choices,
      });
      state.sessionId = '';
      const outcome = payload.outcome || {};
      $('#raidResult').hidden = false;
      $('#raidResult').innerHTML = `
        <span class="eyebrow">${payload.practice ? 'PRACTICE COMPLETE' : 'RAID RECORDED'}</span>
        <h2>${outcome.successful_rooms === 5 ? 'Flawless extraction' : 'Архивният рейд приключи'}</h2>
        <div class="result-metrics">
          <article><small>Точки</small><strong>${Number(outcome.score || 0).toLocaleString()}</strong></article>
          <article><small>XP</small><strong>+${Number(outcome.xp || 0)}</strong></article>
          <article><small>Shards</small><strong>+${Number(outcome.shards || 0)}</strong></article>
          <article><small>Успешни</small><strong>${outcome.successful_rooms || 0}/5</strong></article>
        </div>
        <div class="drop-list">${(outcome.drops || []).length ? outcome.drops.map(dropMarkup).join('') : '<div class="empty">Този рейд не отключи нова карта.</div>'}</div>
        <button class="primary" id="raidAgainBtn" type="button">Нов рейд</button>`;
      $('#raidAgainBtn').addEventListener('click', resetRaid);
      if (outcome.drops?.[0]) showDrop(outcome.drops[0]);
      if (!payload.practice) applyProfile(payload);
      haptic('medium');
    } catch (error) {
      toast(error.message || String(error));
      resetRaid();
    }
  }

  function resetRaid() {
    state.sessionId = '';
    state.room = 0;
    state.choices = [];
    $('#raidIntro').hidden = false;
    $('#sectorTrack').hidden = true;
    $('#routePicker').hidden = true;
    $('#raidResult').hidden = true;
  }

  async function claimDailyCrate() {
    if (!initData) {
      toast('Дневният crate изисква Telegram профил.');
      return;
    }
    try {
      const payload = await api('daily-crate', {});
      applyProfile(payload);
      if (payload.card) showDrop(payload.card, payload.already_claimed ? 'Вече получена днес' : 'Дневен crate');
      haptic('medium');
    } catch (error) {
      toast(error.message || String(error));
    }
  }

  function renderCollection() {
    const filter = $('#rarityFilter')?.value || 'all';
    const owned = new Map(state.inventory.map((item) => [item.card_id, item]));
    const cards = state.catalog.filter((card) => filter === 'all' || card.rarity === filter);
    $('#collectionGrid').innerHTML = cards.length ? cards.map((card) => {
      const item = owned.get(card.id);
      const equip = item && ['waveform', 'bot_skin', 'server_core', 'badge', 'artist_archetype', 'profile_effect'].includes(card.category);
      return `<article class="collectible-card ${item ? '' : 'locked'}" data-card-id="${escapeAttr(card.id)}">
        <span class="card-icon">${escapeHtml(item ? card.icon : '◈')}</span>
        <h3>${escapeHtml(item ? card.title : 'Locked Card')}</h3>
        <p>${escapeHtml(item ? card.description : `${card.category.replaceAll('_', ' ')} collectible`)}</p>
        <span class="rarity">${escapeHtml(card.rarity)}${item ? ` · x${Number(item.quantity || 1)}` : ''}</span>
        ${equip ? '<button type="button" data-equip>Екипирай</button>' : ''}
      </article>`;
    }).join('') : '<div class="empty">Няма карти за този филтър.</div>';
    $$('[data-equip]').forEach((button) => button.addEventListener('click', () => {
      const id = button.closest('[data-card-id]')?.dataset.cardId;
      if (id) void equipCard(id);
    }));
  }

  async function equipCard(cardId) {
    try {
      const payload = await api('equip', { card_id: cardId });
      applyProfile(payload);
      toast(`${payload.equipped?.title || 'Картата'} е екипирана.`);
      haptic('light');
    } catch (error) {
      toast(error.message || String(error));
    }
  }

  async function loadLeaderboard() {
    try {
      const payload = await api('leaderboard?limit=30');
      $('#leaderboard').innerHTML = (payload.entries || []).length ? payload.entries.map((entry) => `
        <article class="leader-row"><strong>#${entry.position}</strong><div><b>${escapeHtml(entry.display_name || entry.username || 'Raider')}</b><small>${Number(entry.raids || 0)} raids · ${Number(entry.shards || 0)} shards</small></div><em>${Number(entry.points || 0).toLocaleString()}</em></article>`).join('') : '<div class="empty">Все още няма ranked рейдове тази седмица.</div>';
    } catch (error) {
      $('#leaderboard').innerHTML = `<div class="empty">${escapeHtml(error.message || String(error))}</div>`;
    }
  }

  function showDrop(card, prefix = 'NEW DROP') {
    $('#dropIcon').textContent = card.icon || '🃏';
    $('#dropRarity').textContent = `${prefix} · ${card.rarity || 'Common'}`.toUpperCase();
    $('#dropTitle').textContent = card.title || 'Collectible card';
    $('#dropDescription').textContent = card.description || '';
    $('#dropDialog').showModal();
  }

  function dropMarkup(card) {
    return `<article class="drop-chip"><span>${escapeHtml(card.icon || '🃏')}</span><b>${escapeHtml(card.title || '')}</b><small>${escapeHtml(card.rarity || '')}</small></article>`;
  }

  function iconForEquipped(id) {
    return state.catalog.find((card) => card.id === id)?.icon || '◉';
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character]));
  }

  function escapeAttr(value) { return escapeHtml(value); }

  document.addEventListener('DOMContentLoaded', () => void boot());
})();
