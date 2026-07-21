(() => {
  'use strict';

  const API = '/api/games/latency-strike';
  const tg = window.Telegram?.WebApp || null;
  const initData = String(tg?.initData || '');
  const state = {
    config: null,
    profile: null,
    rewards: [],
    unlocked: new Set(),
    leaderboard: [],
    sessionId: '',
    running: false,
    acceptingTap: false,
    round: 0,
    rounds: [],
    readyAt: 0,
    timer: null,
    sound: true,
    filter: 'all',
    lastResult: null,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const rewardMap = () => new Map((state.rewards || []).map((reward) => [reward.id, reward]));

  function haptic(type = 'light') {
    try { tg?.HapticFeedback?.impactOccurred(type); } catch { /* optional */ }
  }

  function notify(type = 'success') {
    try { tg?.HapticFeedback?.notificationOccurred(type); } catch { /* optional */ }
  }

  function beep(frequency = 560, duration = 0.07) {
    if (!state.sound) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.08, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + duration);
      oscillator.addEventListener('ended', () => context.close());
    } catch { /* audio is optional */ }
  }

  function toast(message, type = '') {
    const region = $('#toastRegion');
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.textContent = message;
    region.appendChild(item);
    setTimeout(() => item.remove(), 4200);
  }

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      cache: 'no-store',
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      throw new Error(payload?.error?.message || `HTTP ${response.status}`);
    }
    return payload;
  }

  function authBody(extra = {}) {
    return JSON.stringify({ init_data: initData, ...extra });
  }

  async function bootstrap() {
    tg?.ready?.();
    tg?.expand?.();
    try { tg?.setHeaderColor?.('#080511'); tg?.setBackgroundColor?.('#080511'); } catch { /* older clients */ }

    renderRoundDots();
    bindEvents();

    try {
      state.config = await api('/config');
      state.rewards = state.config.rewards || [];
      $('#roundTotal').textContent = String(state.config.rounds || 5);
      $('#weekLabel').textContent = `Седмица ${state.config.week_key || ''}`;
    } catch (error) {
      toast(`Конфигурацията не се зареди: ${error.message}`, 'bad');
    }

    if (initData) {
      try {
        const profilePayload = await api('/profile', { method: 'POST', body: authBody() });
        applyProfilePayload(profilePayload);
      } catch (error) {
        toast(`Telegram профилът не е валидиран: ${error.message}`, 'bad');
      }
    } else {
      toast('Practice режим: отвори играта от @dyrakarmy_bot за XP и награди.');
      renderGuestProfile();
    }

    await loadLeaderboard();
    renderRewards();
  }

  function bindEvents() {
    $('#startBtn').addEventListener('click', startRun);
    $('#resetBtn').addEventListener('click', resetRun);
    $('#arena').addEventListener('pointerdown', handleArenaTap);
    $('#arena').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleArenaTap();
      }
    });
    $('#soundBtn').addEventListener('click', () => {
      state.sound = !state.sound;
      $('#soundBtn').textContent = state.sound ? '♪' : '×';
      toast(state.sound ? 'Звукът е включен.' : 'Звукът е изключен.');
    });
    $('#shareBtn').addEventListener('click', shareResult);
    $('#refreshLeaderboardBtn').addEventListener('click', loadLeaderboard);
    $('#rewardFilters').addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      state.filter = button.dataset.filter || 'all';
      $$('#rewardFilters button').forEach((item) => item.classList.toggle('active', item === button));
      renderRewards();
    });
    $('#rewardGrid').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-equip]');
      if (!button) return;
      await equipReward(button.dataset.equip || '');
    });
  }

  async function startRun() {
    if (state.running) return;
    resetRun(false);
    $('#startBtn').disabled = true;
    $('#resetBtn').disabled = false;
    state.running = true;

    if (initData) {
      try {
        const session = await api('/session', { method: 'POST', body: authBody() });
        state.sessionId = session.session_id;
      } catch (error) {
        state.running = false;
        $('#startBtn').disabled = false;
        toast(`Сесията не стартира: ${error.message}`, 'bad');
        return;
      }
    } else {
      state.sessionId = `guest-${Date.now()}`;
    }

    log('RUN STARTED · следи фазите внимателно');
    nextRound();
  }

  function nextRound() {
    if (!state.running) return;
    if (state.round >= 5) {
      finishRun();
      return;
    }
    state.round += 1;
    $('#roundCurrent').textContent = String(state.round);
    state.acceptingTap = true;
    setArena('queued', 'QUEUED', 'ИЗЧАКАЙ', 'Заявката влиза в опашката…');
    beep(300, 0.05);

    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (!state.running) return;
      setArena('processing', 'PROCESSING', 'НЕ НАТИСКАЙ', 'Сигналът се обработва…');
      const delay = 850 + Math.floor(Math.random() * 1750);
      state.timer = setTimeout(showReady, delay);
    }, 550 + Math.floor(Math.random() * 450));
  }

  function showReady() {
    if (!state.running) return;
    state.readyAt = performance.now();
    setArena('ready', 'READY', 'УДАРИ СЕГА', 'Натисни екрана възможно най-бързо.');
    beep(920, 0.09);
    haptic('medium');
    state.timer = setTimeout(() => {
      if (!state.running || !state.acceptingTap) return;
      completeRound({ reaction_ms: 2000, false_start: false }, 'TIMEOUT', false);
    }, 2000);
  }

  function handleArenaTap() {
    if (!state.running || !state.acceptingTap) return;
    const arenaState = $('#arena').dataset.state;
    if (arenaState !== 'ready') {
      completeRound({ reaction_ms: null, false_start: true }, 'FALSE START', false);
      return;
    }
    const reaction = Math.max(80, Math.round(performance.now() - state.readyAt));
    completeRound({ reaction_ms: reaction, false_start: false }, `${reaction} ms`, true);
  }

  function completeRound(round, label, good) {
    clearTimeout(state.timer);
    state.acceptingTap = false;
    state.rounds.push(round);
    $('#reactionValue').textContent = round.false_start ? '!' : String(round.reaction_ms);
    setArena(good ? 'hit' : 'false', good ? 'LOCKED' : 'ERROR', label, good ? 'Сигналът е отчетен.' : 'Рундът е загубен.');
    updateRoundDot(state.round - 1, good);
    log(`R${state.round} · ${label}`, good ? 'good' : 'bad');
    good ? notify('success') : notify('error');
    beep(good ? 680 : 150, 0.12);
    setTimeout(nextRound, 850);
  }

  async function finishRun() {
    state.running = false;
    state.acceptingTap = false;
    setArena('idle', 'COMPLETE', 'RUN ЗАВЪРШЕН', 'Резултатът се изчислява server-side.');
    $('#startBtn').disabled = false;
    $('#startBtn span').textContent = 'PLAY AGAIN';

    if (!initData) {
      const result = calculateGuestResult(state.rounds);
      applyRunResult(result);
      log('Practice резултат · без XP и класация');
      $('#shareBtn').disabled = false;
      return;
    }

    try {
      const payload = await api('/score', {
        method: 'POST',
        body: authBody({ session_id: state.sessionId, rounds: state.rounds }),
      });
      state.lastResult = payload.result;
      applyRunResult(payload.result);
      applyProfilePayload(payload);
      $('#shareBtn').disabled = false;
      if (payload.newly_unlocked?.length) {
        payload.newly_unlocked.forEach((reward) => toast(`Отключено: ${reward.name}`, 'good'));
        notify('success');
      }
      await loadLeaderboard();
      renderRewards();
      log(`SERVER VERIFIED · +${payload.result.xp} XP`, 'good');
    } catch (error) {
      toast(`Резултатът не беше записан: ${error.message}`, 'bad');
      log(`SUBMIT ERROR · ${error.message}`, 'bad');
    }
  }

  function calculateGuestResult(rounds) {
    const valid = rounds.filter((round) => !round.false_start && Number.isFinite(round.reaction_ms));
    const falseStarts = 5 - valid.length;
    const values = valid.map((round) => Number(round.reaction_ms));
    const best = values.length ? Math.min(...values) : 2000;
    const average = values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 2000;
    const accuracy = Math.round((valid.length / 5) * 100);
    const reactionPoints = values.reduce((sum, value) => sum + Math.max(0, 1300 - value) * 2, 0);
    const score = Math.max(0, Math.round(reactionPoints + accuracy * 20 + (falseStarts ? 0 : 1000) - falseStarts * 700));
    return { score, xp: 0, accuracy, avgReactionMs: average, bestReactionMs: best, falseStarts };
  }

  function applyRunResult(result) {
    state.lastResult = result;
    $('#runScore').textContent = Number(result.score || 0).toLocaleString('bg-BG');
    $('#runAverage').textContent = String(result.avgReactionMs ?? '—');
    $('#runAccuracy').textContent = String(result.accuracy ?? 0);
    $('#runXp').textContent = String(result.xp ?? 0);
  }

  function resetRun(clearLog = true) {
    clearTimeout(state.timer);
    state.running = false;
    state.acceptingTap = false;
    state.round = 0;
    state.rounds = [];
    state.sessionId = '';
    $('#roundCurrent').textContent = '0';
    $('#reactionValue').textContent = '—';
    $('#runScore').textContent = '0';
    $('#runAverage').textContent = '—';
    $('#runAccuracy').textContent = '0';
    $('#runXp').textContent = '0';
    $('#startBtn').disabled = false;
    $('#resetBtn').disabled = true;
    $('#shareBtn').disabled = true;
    setArena('idle', 'STANDBY', 'Натисни START', 'Пет рунда. Не натискай преди READY.');
    renderRoundDots();
    if (clearLog) $('#runLog').innerHTML = '<p>Системата е готова за нов опит.</p>';
  }

  function setArena(status, code, label, hint) {
    $('#arena').dataset.state = status;
    $('#phaseCode').textContent = code;
    $('#phaseLabel').textContent = label;
    $('#phaseHint').textContent = hint;
  }

  function renderRoundDots() {
    $('#roundDots').innerHTML = Array.from({ length: 5 }, () => '<i></i>').join('');
  }

  function updateRoundDot(index, good) {
    const dot = $$('#roundDots i')[index];
    if (dot) dot.className = good ? 'good' : 'bad';
  }

  function log(message, type = '') {
    const paragraph = document.createElement('p');
    paragraph.className = type;
    paragraph.textContent = `${new Date().toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${message}`;
    $('#runLog').prepend(paragraph);
  }

  function applyProfilePayload(payload) {
    if (!payload?.profile) return;
    state.profile = payload.profile;
    state.unlocked = new Set((payload.unlocked_rewards || []).map((reward) => reward.id));
    const profile = state.profile;
    const rewards = rewardMap();
    const equipped = profile.equipped || {};
    $('#profileName').textContent = profile.display_name || 'Latency Player';
    $('#profileRank').textContent = profile.rank?.name || 'Recruit';
    $('#profileTitle').textContent = rewards.get(equipped.title)?.name || profile.rank?.name || 'Recruit';
    $('#profileXp').textContent = Number(profile.total_xp || 0).toLocaleString('bg-BG');
    $('#weeklyRank').textContent = profile.weekly_rank ? `#${profile.weekly_rank}` : '—';
    $('#profileShell').dataset.frame = equipped.frame || 'frame_neon';
    $('#profileAvatar').dataset.icon = equipped.icon || 'icon_pulse';
    $('#profileBadge').dataset.badge = equipped.badge || 'badge_recruit';
    $('#profileBadge').textContent = rewards.get(equipped.badge)?.glyph || 'R';
    $('#profileWaveform').dataset.waveform = equipped.waveform || 'waveform_pulse';
    document.body.dataset.theme = equipped.theme || 'theme_violet';
    const nextXp = profile.rank?.nextXp;
    const minXp = profile.rank?.minXp || 0;
    const progress = nextXp ? ((profile.total_xp - minXp) / (nextXp - minXp)) * 100 : 100;
    $('#xpBar').style.width = `${Math.max(0, Math.min(100, progress))}%`;
    renderRewards();
  }

  function renderGuestProfile() {
    $('#profileName').textContent = 'Practice Player';
    $('#profileTitle').textContent = 'Guest';
    $('#profileRank').textContent = 'Practice';
    $('#profileXp').textContent = '0';
    $('#weeklyRank').textContent = '—';
  }

  function renderRewards() {
    const equipped = state.profile?.equipped || {};
    const items = (state.rewards || []).filter((reward) => state.filter === 'all' || reward.type === state.filter);
    $('#rewardGrid').innerHTML = items.map((reward) => {
      const unlocked = state.unlocked.has(reward.id) || reward.unlock?.xp === 0;
      const isEquipped = equipped[reward.type] === reward.id;
      return `
        <article class="reward-card ${unlocked ? '' : 'locked'} ${isEquipped ? 'equipped' : ''}">
          <div class="reward-glyph">${escapeHtml(reward.glyph)}</div>
          <h3>${escapeHtml(reward.name)}</h3>
          <p>${escapeHtml(reward.description)}</p>
          <div class="reward-meta">
            <span class="rarity ${reward.rarity}">${escapeHtml(reward.rarity)}</span>
            ${unlocked ? `<button class="equip-button" type="button" data-equip="${escapeHtml(reward.id)}" ${isEquipped ? 'disabled' : ''}>${isEquipped ? 'Избрано' : 'Избери'}</button>` : '<span>🔒</span>'}
          </div>
        </article>`;
    }).join('') || '<p>Няма награди в тази категория.</p>';
  }

  async function equipReward(rewardId) {
    if (!initData) {
      toast('Наградите се оборудват само през Telegram профил.');
      return;
    }
    try {
      const payload = await api('/equip', { method: 'POST', body: authBody({ reward_id: rewardId }) });
      applyProfilePayload(payload);
      haptic('light');
      toast('Профилът е обновен.', 'good');
    } catch (error) {
      toast(`Наградата не беше избрана: ${error.message}`, 'bad');
    }
  }

  async function loadLeaderboard() {
    $('#refreshLeaderboardBtn').disabled = true;
    try {
      const payload = await api('/leaderboard?limit=50');
      state.leaderboard = payload.entries || [];
      $('#weekLabel').textContent = `Седмица ${payload.week_key || ''}`;
      renderLeaderboard();
    } catch (error) {
      toast(`Класацията не се зареди: ${error.message}`, 'bad');
    } finally {
      $('#refreshLeaderboardBtn').disabled = false;
    }
  }

  function renderLeaderboard() {
    const top = state.leaderboard.slice(0, 3);
    $('#podium').innerHTML = top.map((entry) => `
      <article class="podium-card">
        <span class="podium-rank">#${entry.rank}</span>
        <b>${escapeHtml(entry.display_name)}</b>
        <small>${Number(entry.score).toLocaleString('bg-BG')} pts · ${entry.avg_reaction_ms} ms</small>
      </article>`).join('') || '<p>Класацията очаква първия играч.</p>';

    $('#leaderboardList').innerHTML = state.leaderboard.map((entry) => `
      <article class="leaderboard-row">
        <span class="position">#${entry.rank}</span>
        <b>${escapeHtml(entry.display_name)}</b>
        <small>${entry.avg_reaction_ms} ms</small>
        <strong>${Number(entry.score).toLocaleString('bg-BG')}</strong>
      </article>`).join('');
  }

  function shareResult() {
    if (!state.lastResult) return;
    const text = `Latency Strike ⚡ ${Number(state.lastResult.score || 0).toLocaleString('bg-BG')} точки · ${state.lastResult.avgReactionMs || '—'} ms · @dyrakarmy_bot`;
    const url = 'https://dyrakarmy.eu/games/latency-strike/';
    const nativeLink = `tg://msg_url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
    window.location.href = nativeLink;
    haptic('light');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  document.addEventListener('DOMContentLoaded', bootstrap);
})();
