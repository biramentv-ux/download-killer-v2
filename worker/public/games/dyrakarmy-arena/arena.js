(() => {
  'use strict';

  const API = '/api/games/dyrakarmy-arena';
  const tg = window.Telegram?.WebApp || null;
  const initData = String(tg?.initData || '');
  const state = {
    config: null,
    profile: null,
    team: null,
    sessionId: '',
    practice: false,
    questions: [],
    answers: [],
    index: 0,
    questionStartedAt: 0,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function haptic(type = 'light') {
    try { tg?.HapticFeedback?.impactOccurred(type); } catch { /* no-op */ }
  }

  function toast(message, type = '') {
    const node = $('#arenaToast');
    node.textContent = message;
    node.className = `arena-toast show ${type}`.trim();
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.className = 'arena-toast'; }, 3400);
  }

  async function api(path, payload = null) {
    const response = await fetch(`${API}${path}`, payload === null ? {
      headers: { Accept: 'application/json' },
    } : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.error) {
      const error = new Error(body?.error?.message || `HTTP ${response.status}`);
      error.code = body?.error?.code || 'REQUEST_FAILED';
      throw error;
    }
    return body;
  }

  function authPayload(extra = {}) {
    return { init_data: initData, ...extra };
  }

  async function bootstrap() {
    tg?.ready?.();
    tg?.expand?.();
    try { tg?.setHeaderColor?.('#070a18'); tg?.setBackgroundColor?.('#060916'); } catch { /* no-op */ }
    bindEvents();
    try {
      state.config = await api('/config');
      $('#dayKey').textContent = state.config.day_key;
      if (initData) {
        $('#authStatus').classList.add('online');
        $('#authStatus span').textContent = 'Telegram профил';
        await loadProfile();
      } else {
        $('#authStatus').classList.add('practice');
        $('#authStatus span').textContent = 'Practice режим';
        $('#startArenaBtn').textContent = 'Отвори през Telegram за ranked игра';
      }
      await loadLeaderboard();
    } catch (error) {
      toast(error.message || String(error), 'error');
      $('#authStatus span').textContent = 'Offline';
    }
  }

  function bindEvents() {
    $$('.arena-tabs button').forEach((button) => button.addEventListener('click', () => openTab(button.dataset.tab)));
    $('#startArenaBtn').addEventListener('click', () => {
      if (!initData) {
        window.location.href = 'tg://resolve?domain=dyrakarmy_bot&startapp=arena';
        return;
      }
      void startGame(false);
    });
    $('#practiceBtn').addEventListener('click', () => void startGame(true));
    $('#createTeamBtn').addEventListener('click', () => void teamAction('create'));
    $('#joinTeamBtn').addEventListener('click', () => void teamAction('join'));
    $('#leaderScope').addEventListener('change', () => void loadLeaderboard());
    $('#leaderPeriod').addEventListener('change', () => void loadLeaderboard());
  }

  function openTab(name) {
    $$('.arena-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
    $$('.arena-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === name));
    if (name === 'leaderboard') void loadLeaderboard();
    if (name === 'profile' && initData) void loadProfile();
  }

  async function loadProfile() {
    if (!initData) return;
    const payload = await api('/profile', authPayload());
    state.profile = payload.profile;
    state.team = payload.team;
    renderProfile(payload);
    renderTeam(payload.team);
    const attempts = Number(payload.attempts_today || 0);
    const limit = Number(payload.attempts_limit || 3);
    $('#attemptsText').textContent = `${attempts} / ${limit}`;
    $('#attemptsBar').style.width = `${Math.min(100, (attempts / limit) * 100)}%`;
    $('#startArenaBtn').disabled = attempts >= limit;
    if (attempts >= limit) $('#startArenaBtn').textContent = 'Ranked опитите са изчерпани';
  }

  function renderProfile(payload) {
    const profile = payload.profile || {};
    const name = profile.display_name || tg?.initDataUnsafe?.user?.first_name || 'Arena Player';
    const rank = profile.rank?.name || 'Recruit';
    $('#profileName').textContent = name;
    $('#profileRank').textContent = `Ранг: ${rank}`;
    $('#profileTitle').textContent = String(profile.equipped_title || rank).replace(/^title_/, '').replaceAll('_', ' ');
    $('#profileXp').textContent = Number(profile.total_xp || 0).toLocaleString('bg-BG');
    $('#profilePosition').textContent = payload.weekly_position ? `#${payload.weekly_position}` : '—';
    $('#profileBest').textContent = Number(profile.best_score || 0).toLocaleString('bg-BG');
    $('#profileAvatar').textContent = initials(name);
    $('#profileAvatar').dataset.frame = profile.equipped_frame || 'frame_neon';
  }

  function renderTeam(team) {
    const container = $('#teamContent');
    if (!team) {
      container.innerHTML = `
        <article class="team-empty glass"><span>🛡</span><h3>Все още нямаш отбор</h3><p>Създай нова армия или използвай шестцифрен код за присъединяване.</p></article>
        <div class="team-actions glass">
          <label><span>Име на нов отбор</span><input id="teamNameInput" maxlength="28" placeholder="Dark Operators"></label>
          <button id="createTeamBtn" class="primary" type="button">Създай отбор</button>
          <div class="or"><i></i><span>или</span><i></i></div>
          <label><span>Код за присъединяване</span><input id="teamCodeInput" maxlength="6" placeholder="A7X9Q2" autocapitalize="characters"></label>
          <button id="joinTeamBtn" class="secondary" type="button">Присъедини се</button>
        </div>`;
      $('#createTeamBtn').addEventListener('click', () => void teamAction('create'));
      $('#joinTeamBtn').addEventListener('click', () => void teamAction('join'));
      return;
    }
    container.innerHTML = `
      <article class="team-card glass">
        <span class="eyebrow">ACTIVE SQUAD</span>
        <h2>${escapeHtml(team.name)}</h2>
        <div class="team-code">${escapeHtml(team.code)}</div>
        <p>Сподели кода с хората, които искаш в отбора.</p>
        <div class="team-stats">
          <div><strong>${Number(team.member_count || 1)}</strong><span>членове</span></div>
          <div><strong>${Number(team.weekly_points || 0).toLocaleString('bg-BG')}</strong><span>седмични точки</span></div>
          <div><strong>${Number(team.season_points || 0).toLocaleString('bg-BG')}</strong><span>сезонни точки</span></div>
        </div>
      </article>
      <div class="team-actions glass">
        <span class="eyebrow">TEAM CONTROL</span>
        <h3>Роля: ${escapeHtml(team.role || 'member')}</h3>
        <button class="secondary" id="copyTeamCodeBtn" type="button">Копирай кода</button>
        <button class="secondary" id="shareTeamBtn" type="button">Покани приятели</button>
        <button class="secondary" id="leaveTeamBtn" type="button">Напусни отбора</button>
      </div>`;
    $('#copyTeamCodeBtn').addEventListener('click', async () => {
      await navigator.clipboard?.writeText(team.code);
      toast('Кодът на отбора е копиран.', 'success');
    });
    $('#shareTeamBtn').addEventListener('click', () => shareTeam(team));
    $('#leaveTeamBtn').addEventListener('click', () => void teamAction('leave'));
  }

  async function teamAction(action) {
    if (!initData) {
      toast('Отборите изискват отваряне през @dyrakarmy_bot.', 'error');
      return;
    }
    try {
      const payload = { action };
      if (action === 'create') payload.name = String($('#teamNameInput')?.value || '').trim();
      if (action === 'join') payload.code = String($('#teamCodeInput')?.value || '').trim().toUpperCase();
      const result = await api('/team', authPayload(payload));
      state.team = result.team;
      renderTeam(result.team);
      toast(action === 'leave' ? 'Напусна отбора.' : 'Отборът е обновен.', 'success');
      haptic('medium');
      await loadLeaderboard();
    } catch (error) {
      toast(error.message || String(error), 'error');
      haptic('heavy');
    }
  }

  async function startGame(practice) {
    try {
      $('#startArenaBtn').disabled = true;
      $('#practiceBtn').disabled = true;
      const session = await api('/session', authPayload({ practice }));
      state.sessionId = session.session_id;
      state.practice = Boolean(session.practice);
      state.questions = session.questions || [];
      state.answers = [];
      state.index = 0;
      openTab('battle');
      renderQuestion();
      haptic('medium');
    } catch (error) {
      if (error.code === 'DAILY_LIMIT') {
        toast('Трите ranked опита са завършени. Practice режимът остава активен.', 'error');
      } else {
        toast(error.message || String(error), 'error');
      }
      $('#startArenaBtn').disabled = false;
      $('#practiceBtn').disabled = false;
    }
  }

  function renderQuestion() {
    const question = state.questions[state.index];
    if (!question) {
      void finishGame();
      return;
    }
    state.questionStartedAt = performance.now();
    const progress = ((state.index + 1) / state.questions.length) * 100;
    $('#battleStage').innerHTML = `
      <div class="question-shell">
        <div class="question-progress"><span>МИСИЯ ${state.index + 1}/${state.questions.length}</span><span>${state.practice ? 'PRACTICE' : 'RANKED'}</span></div>
        <div class="progress-line"><i style="width:${progress}%"></i></div>
        <span class="question-category">${escapeHtml(question.category)}</span>
        <h3>${escapeHtml(question.prompt)}</h3>
        <div class="option-grid">${question.options.map((option, index) => `<button class="option-button" data-option="${index}" type="button"><b>${String.fromCharCode(65 + index)}.</b> ${escapeHtml(option)}</button>`).join('')}</div>
      </div>`;
    $$('.option-button').forEach((button) => button.addEventListener('click', () => selectAnswer(Number(button.dataset.option))));
  }

  function selectAnswer(optionIndex) {
    const question = state.questions[state.index];
    const responseMs = Math.round(performance.now() - state.questionStartedAt);
    state.answers.push({ question_id: question.id, option_index: optionIndex, response_ms: responseMs });
    $$('.option-button').forEach((button) => {
      button.disabled = true;
      button.classList.toggle('selected', Number(button.dataset.option) === optionIndex);
    });
    haptic('light');
    state.index += 1;
    setTimeout(renderQuestion, 280);
  }

  async function finishGame() {
    $('#battleStage').innerHTML = '<div class="battle-idle"><span class="mission-icon">⌛</span><h3>Изчисляване на резултата</h3><p>Worker-ът валидира сесията и точките.</p></div>';
    try {
      const result = await api('/score', authPayload({
        practice: state.practice,
        session_id: state.sessionId,
        answers: state.answers,
      }));
      renderResult(result);
      if (!state.practice) {
        await loadProfile();
        await loadLeaderboard();
      }
    } catch (error) {
      toast(error.message || String(error), 'error');
      $('#battleStage').innerHTML = '<div class="battle-idle"><span class="mission-icon">!</span><h3>Резултатът не беше записан</h3><p>Стартирай нова сесия и опитай отново.</p></div>';
    } finally {
      $('#startArenaBtn').disabled = false;
      $('#practiceBtn').disabled = false;
    }
  }

  function renderResult(payload) {
    const result = payload.result || {};
    $('#battleStage').innerHTML = `
      <div class="result-card">
        <span class="eyebrow">${state.practice ? 'PRACTICE COMPLETE' : 'ARENA RUN COMPLETE'}</span>
        <div class="result-score">${Number(result.score || 0).toLocaleString('bg-BG')}</div>
        <p>${state.practice ? 'Practice резултатът не влиза в класацията.' : `+${Number(result.xp || 0)} XP · +${Number(result.team_points || 0)} отборни точки`}</p>
        <div class="result-grid">
          <div><strong>${result.correct || 0}/${result.total || 0}</strong><span>верни</span></div>
          <div><strong>${result.accuracy || 0}%</strong><span>точност</span></div>
          <div><strong>${result.avg_response_ms || 0} ms</strong><span>средно време</span></div>
          <div><strong>x${result.best_combo || 0}</strong><span>най-добро combo</span></div>
        </div>
        <div class="hero-actions"><button class="primary" id="playAgainBtn" type="button">Играй отново</button><button class="secondary" id="shareScoreBtn" type="button">Сподели резултата</button></div>
      </div>`;
    $('#playAgainBtn').addEventListener('click', () => void startGame(state.practice));
    $('#shareScoreBtn').addEventListener('click', () => shareScore(result));
    haptic(result.accuracy >= 75 ? 'medium' : 'heavy');
  }

  async function loadLeaderboard() {
    const scope = $('#leaderScope')?.value || 'teams';
    const period = $('#leaderPeriod')?.value || 'week';
    try {
      const payload = await api(`/leaderboard?scope=${encodeURIComponent(scope)}&period=${encodeURIComponent(period)}&limit=30`);
      renderLeaderboard(payload.entries || [], scope);
    } catch (error) {
      $('#leaderList').innerHTML = `<div class="leader-row"><strong>!</strong><div><b>Класацията не е достъпна</b><small>${escapeHtml(error.message || String(error))}</small></div></div>`;
    }
  }

  function renderLeaderboard(entries, scope) {
    const podium = $('#podium');
    const top = entries.slice(0, 3);
    podium.innerHTML = top.map((entry, index) => `
      <article class="podium-card"><b>${['🥇', '🥈', '🥉'][index]}</b><strong>${escapeHtml(entry.name || entry.display_name || 'Arena')}</strong><span>${Number(entry.points || 0).toLocaleString('bg-BG')} точки</span></article>`).join('');
    $('#leaderList').innerHTML = entries.length ? entries.map((entry) => `
      <div class="leader-row"><strong>#${entry.position}</strong><div><b>${escapeHtml(entry.name || entry.display_name || 'Arena Player')}</b><small>${scope === 'teams' ? `${entry.members || 0} членове · ${entry.games || 0} игри` : `${entry.games || 0} игри · best ${Number(entry.best_score || 0).toLocaleString('bg-BG')}`}</small></div><em>${Number(entry.points || 0).toLocaleString('bg-BG')}</em></div>`).join('') : '<div class="leader-row"><strong>—</strong><div><b>Все още няма резултати</b><small>Бъди първият в Arena.</small></div><em>0</em></div>';
  }

  function shareTeam(team) {
    const text = `⚔️ Присъедини се към ${team.name} в DyrakArmy Arena. Код: ${team.code}`;
    shareText(text);
  }

  function shareScore(result) {
    shareText(`⚔️ DyrakArmy Arena: ${Number(result.score || 0).toLocaleString('bg-BG')} точки, ${result.accuracy || 0}% точност. Предизвиквам те в @dyrakarmy_bot`);
  }

  function shareText(text) {
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent('https://dyrakarmy.eu/games/dyrakarmy-arena/')}&text=${encodeURIComponent(text)}`;
    try { tg?.openTelegramLink?.(shareUrl); } catch { window.open(shareUrl, '_blank', 'noopener'); }
  }

  function initials(name) {
    return String(name).split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'DA';
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character]));
  }

  document.addEventListener('DOMContentLoaded', () => void bootstrap());
})();
