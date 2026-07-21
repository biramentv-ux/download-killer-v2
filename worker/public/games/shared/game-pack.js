(() => {
  'use strict';

  const tg = window.Telegram?.WebApp || null;
  const initData = String(tg?.initData || '');
  const gameId = document.body.dataset.gameId || location.pathname.split('/').filter(Boolean).at(-1) || '';
  const GAME_NUMBERS = {
    'queue-commander': '01/10', 'beat-hunter': '02/10', 'format-forge': '04/10',
    'server-defender': '05/10', 'metadata-detective': '06/10', 'link-runner': '07/10',
    'bot-vs-human': '10/10',
  };
  const SAFETY_NOTES = {
    'beat-hunter': 'Използват се само синтетични BPM и waveform clues, без защитено или чуждо аудио.',
    'server-defender': 'Defensive симулация без достъп до реална инфраструктура.',
    'metadata-detective': 'Виртуални metadata казуси, които не променят реални файлове.',
    'link-runner': 'URL примерите са симулации. Private, loopback и file адресите се блокират.',
    'bot-vs-human': 'DK Core е детерминиран виртуален противник без скрит достъп до данни.',
  };
  const state = { config: null, profile: null, sessionId: '', practice: false, questions: [], answers: [], index: 0, startedAt: 0 };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('show'), 2800);
  }
  function haptic(type = 'light') { try { tg?.HapticFeedback?.impactOccurred(type); } catch { /* no-op */ } }
  async function api(action, body = null) {
    const response = await fetch(`/api/games/${gameId}/${action}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      cache: 'no-store',
      body: body ? JSON.stringify({ init_data: initData, ...body }) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
    return payload;
  }

  async function boot() {
    tg?.ready?.();
    tg?.expand?.();
    try { tg?.setHeaderColor?.('#070916'); tg?.setBackgroundColor?.('#070916'); } catch { /* no-op */ }
    bind();
    $('#gameNumber').textContent = GAME_NUMBERS[gameId] || '--/10';
    $('#safeNote').textContent = SAFETY_NOTES[gameId] || 'Един профил, XP, рангове и награди за всичките 10 игри.';
    try {
      const payload = await api('config');
      state.config = payload;
      renderConfig();
      if (initData) {
        $('#identity').classList.add('online');
        $('#identity span').textContent = tg?.initDataUnsafe?.user?.first_name || 'Telegram';
        await loadProfile();
      }
      await loadLeaderboard();
    } catch (error) { toast(error.message || String(error)); }
  }

  function bind() {
    $$('.pack-tabs button').forEach((button) => button.addEventListener('click', () => openTab(button.dataset.tab)));
    $('#startRankedBtn').addEventListener('click', () => void startGame(false));
    $('#startPracticeBtn').addEventListener('click', () => void startGame(true));
    $('#playAgainBtn').addEventListener('click', resetGame);
    $('#reloadLeaderboardBtn').addEventListener('click', () => void loadLeaderboard());
  }
  function openTab(name) {
    $$('.pack-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
    $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === name));
  }

  function renderConfig() {
    const game = state.config?.game || {};
    document.title = `${game.title || 'DyrakArmy Game'} · DyrakArmy`;
    $('#gameIcon').textContent = game.icon || '🎮';
    $('#gameTitle').textContent = game.title || 'DyrakArmy Game';
    $('#gameDescription').textContent = game.description || '';
    $('#gameMechanic').textContent = game.mechanic || '';
    $('#gameReward').textContent = game.reward_title || 'Profile reward';
    $('#dailyLimit').textContent = String(state.config?.daily_attempts || 5);
    $('#roundCount').textContent = String(state.config?.rounds || 5);
    $('#startTitle').textContent = game.mechanic || game.title || 'Start game';
  }

  async function loadProfile() {
    if (!initData) return;
    try {
      state.profile = await api('profile', {});
      renderProfile();
    } catch (error) { toast(error.message || String(error)); }
  }
  function renderProfile() {
    const profile = state.profile?.profile || {};
    const stats = state.profile?.game_stats || {};
    $('#profileName').textContent = profile.display_name || 'DyrakArmy Player';
    $('#profileMeta').textContent = `${profile.rank?.name || 'Recruit'} · ${profile.username ? `@${profile.username}` : gameId}`;
    $('#profileXp').textContent = Number(profile.total_xp || 0).toLocaleString();
    $('#profileGames').textContent = Number(stats.games || 0).toLocaleString();
    $('#profileBest').textContent = Number(stats.best_score || 0).toLocaleString();
    $('#profileAttempts').textContent = `${state.profile?.attempts_today || 0}/${state.profile?.attempts_limit || 5}`;
    $('#sharedXp').textContent = Number(profile.total_xp || 0).toLocaleString();
    $('#sharedRank').textContent = profile.rank?.name || 'Recruit';
    $('#weeklyPosition').textContent = state.profile?.weekly_position ? `#${state.profile.weekly_position}` : '—';
  }

  async function startGame(practice) {
    if (!practice && !initData) { toast('Ranked режимът изисква отваряне през Telegram.'); return; }
    try {
      const payload = await api('session', { practice });
      state.sessionId = payload.session_id;
      state.practice = practice;
      state.questions = payload.questions || [];
      state.answers = [];
      state.index = 0;
      $('#startCard').hidden = true;
      $('#resultCard').hidden = true;
      $('#questionCard').hidden = false;
      $('#opponentTarget').textContent = payload.opponent ? `DK Core target: ${Number(payload.opponent.target_score || 0).toLocaleString()}` : '';
      renderQuestion();
      haptic('medium');
    } catch (error) { toast(error.message || String(error)); }
  }

  function renderQuestion() {
    const question = state.questions[state.index];
    if (!question) { void submitScore(); return; }
    $('#roundLabel').textContent = `${state.index + 1}/${state.questions.length}`;
    $('#progressBar').style.width = `${(state.index / state.questions.length) * 100}%`;
    $('#questionPrompt').textContent = question.prompt || '';
    const clue = String(question.clue || '');
    $('#questionClue').hidden = !clue;
    $('#questionClue').textContent = clue;
    $('#optionList').innerHTML = (question.options || []).map((option, index) => `<button type="button" data-option="${index}">${escapeHtml(option)}</button>`).join('');
    $$('[data-option]').forEach((button) => button.addEventListener('click', () => answerQuestion(Number(button.dataset.option))));
    state.startedAt = performance.now();
  }
  function answerQuestion(optionIndex) {
    const question = state.questions[state.index];
    if (!question) return;
    state.answers.push({ question_id: question.id, option_index: optionIndex, response_ms: Math.max(250, Math.round(performance.now() - state.startedAt)) });
    state.index += 1;
    haptic('light');
    renderQuestion();
  }

  async function submitScore() {
    $('#questionCard').hidden = true;
    try {
      const payload = await api('score', { session_id: state.sessionId, practice: state.practice, answers: state.answers });
      state.sessionId = '';
      renderResult(payload);
      if (!payload.practice) {
        state.profile = payload;
        renderProfile();
        await loadLeaderboard();
      }
      haptic('medium');
    } catch (error) { toast(error.message || String(error)); resetGame(); }
  }

  function renderResult(payload) {
    const result = payload.result || {};
    $('#resultCard').hidden = false;
    $('#resultMode').textContent = payload.practice ? 'PRACTICE COMPLETE' : 'RANKED RESULT';
    $('#resultTitle').textContent = result.won_duel === true ? 'DK Core defeated' : result.won_duel === false ? 'DK Core wins this round' : 'Играта приключи';
    $('#resultScore').textContent = Number(result.score || 0).toLocaleString();
    $('#resultXp').textContent = `+${Number(result.xp || 0)}`;
    $('#resultAccuracy').textContent = `${Number(result.accuracy || 0)}%`;
    $('#resultCombo').textContent = String(result.best_combo || 0);
    $('#duelResult').hidden = result.bot_score === null || result.bot_score === undefined;
    $('#duelResult').textContent = result.bot_score !== null && result.bot_score !== undefined ? `Ти: ${Number(result.score || 0).toLocaleString()} · DK Core: ${Number(result.bot_score || 0).toLocaleString()}` : '';
    $('#explanations').innerHTML = (payload.explanations || []).map((item) => `<article>${escapeHtml(item.explanation || '')}</article>`).join('');
    const unlocks = payload.unlocks || [];
    $('#unlockBox').hidden = !unlocks.length;
    $('#unlockBox').textContent = unlocks.length ? `Отключено: ${unlocks.join(', ')}` : '';
    $('#progressBar').style.width = '100%';
  }

  function resetGame() {
    state.sessionId = '';
    state.questions = [];
    state.answers = [];
    state.index = 0;
    $('#startCard').hidden = false;
    $('#questionCard').hidden = true;
    $('#resultCard').hidden = true;
  }

  async function loadLeaderboard() {
    try {
      const payload = await api('leaderboard?limit=30');
      $('#leaderboard').innerHTML = (payload.entries || []).length
        ? payload.entries.map((entry) => `<article class="leader-row"><strong>#${entry.position}</strong><div><b>${escapeHtml(entry.display_name || entry.username || 'Player')}</b><small>${Number(entry.games || 0)} games · ${Math.round(Number(entry.avg_accuracy || 0))}% accuracy</small></div><em>${Number(entry.points || 0).toLocaleString()}</em></article>`).join('')
        : '<div class="empty">Все още няма ranked резултати тази седмица.</div>';
    } catch (error) { $('#leaderboard').innerHTML = `<div class="empty">${escapeHtml(error.message || String(error))}</div>`; }
  }

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character])); }
  document.addEventListener('DOMContentLoaded', () => void boot());
})();
