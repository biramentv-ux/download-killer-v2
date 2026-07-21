(() => {
  'use strict';

  const tg = window.Telegram?.WebApp || null;
  const initData = String(tg?.initData || '');
  const slug = String(document.body.dataset.game || '').trim();
  const state = { config: null, profile: null, sessionId: '', practice: false, questions: [], index: 0, answers: [], startedAt: 0 };
  const $ = (selector, root = document) => root.querySelector(selector);

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

  async function api(action, body = null) {
    const options = { cache: 'no-store', headers: { Accept: 'application/json' } };
    if (body) {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify({ init_data: initData, ...body });
    }
    const response = await fetch(`/api/games/${slug}/${action}`, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
    return payload;
  }

  async function boot() {
    tg?.ready?.();
    tg?.expand?.();
    try { tg?.setHeaderColor?.('#070914'); tg?.setBackgroundColor?.('#070914'); } catch { /* no-op */ }
    bind();
    state.config = await api('config');
    renderConfig();
    if (initData) {
      $('#identity').classList.add('online');
      $('#identity span').textContent = tg?.initDataUnsafe?.user?.first_name || 'Telegram';
      await loadProfile();
    }
    await loadLeaderboard();
  }

  function bind() {
    $('#rankedBtn').addEventListener('click', () => void start(false));
    $('#practiceBtn').addEventListener('click', () => void start(true));
    $('#againBtn').addEventListener('click', reset);
  }

  function renderConfig() {
    const config = state.config || {};
    document.title = config.title || 'DyrakArmy Game';
    $('#gameNumber').textContent = `GAME ${config.number || '—'} / 10`;
    $('#gameTitle').textContent = config.title || '';
    $('#gameTitleAccent').textContent = config.mode ? config.mode.toUpperCase() : 'CHALLENGE';
    $('#gameDescription').textContent = config.description || '';
    $('#gameIcon').textContent = config.icon || '🎮';
    $('#roundCount').textContent = String(config.rounds || 0);
    $('#attemptLimit').textContent = String(config.daily_attempts || 0);
    $('#rewardLabel').textContent = config.reward?.label || 'Perfect-run reward';
  }

  async function loadProfile() {
    try {
      const payload = await api('profile', {});
      state.profile = payload;
      const profile = payload.profile || {};
      $('#sharedXp').textContent = Number(profile.total_xp || 0).toLocaleString();
      $('#sharedRank').textContent = profile.rank?.name || 'Recruit';
      $('#bestScore').textContent = Number(payload.best_game_score || 0).toLocaleString();
      $('#attempts').textContent = `${payload.attempts_today || 0}/${payload.attempts_limit || 0}`;
      $('#rewardStatus').textContent = payload.reward?.unlocked ? 'Отключена' : 'Заключена';
      $('#rewardBox').classList.toggle('locked', !payload.reward?.unlocked);
    } catch (error) {
      toast(error.message || String(error));
    }
  }

  async function start(practice) {
    if (!practice && !initData) {
      toast('Ranked режимът изисква отваряне през Telegram.');
      return;
    }
    try {
      const payload = await api('session', { practice });
      state.sessionId = payload.session_id;
      state.practice = practice;
      state.questions = payload.questions || [];
      state.index = 0;
      state.answers = [];
      $('#startView').hidden = true;
      $('#resultView').hidden = true;
      $('#questionView').hidden = false;
      renderQuestion();
      haptic('medium');
    } catch (error) {
      toast(error.message || String(error));
    }
  }

  function renderQuestion() {
    const question = state.questions[state.index];
    if (!question) {
      void submit();
      return;
    }
    $('#progress').innerHTML = state.questions.map((_, index) => `<span class="${index < state.index ? 'done' : index === state.index ? 'active' : ''}"></span>`).join('');
    $('#questionCounter').textContent = `ROUND ${state.index + 1}/${state.questions.length}`;
    $('#questionPrompt').textContent = question.prompt;
    const options = $('#options');
    options.innerHTML = question.options.map((option, index) => `<button type="button" data-option="${index}"><b>${String.fromCharCode(65 + index)}</b>${escapeHtml(option)}</button>`).join('');
    options.querySelectorAll('[data-option]').forEach((button) => button.addEventListener('click', () => answer(Number(button.dataset.option))));
    state.startedAt = performance.now();
  }

  function answer(optionIndex) {
    const question = state.questions[state.index];
    if (!question) return;
    state.answers.push({
      question_id: question.id,
      option_index: optionIndex,
      response_ms: Math.max(250, Math.round(performance.now() - state.startedAt)),
    });
    state.index += 1;
    haptic('light');
    renderQuestion();
  }

  async function submit() {
    $('#questionView').hidden = true;
    try {
      const payload = await api('score', {
        practice: state.practice,
        session_id: state.sessionId,
        answers: state.answers,
      });
      state.sessionId = '';
      const result = payload.result || {};
      $('#resultView').hidden = false;
      $('#resultMode').textContent = payload.practice ? 'PRACTICE COMPLETE' : 'RANKED RESULT';
      $('#resultTitle').textContent = result.accuracy === 100 ? 'Perfect run' : 'Предизвикателството приключи';
      $('#resultText').textContent = result.reward_unlocked ? 'Отключи специалната награда за тази игра.' : 'Подобри точността и времето за perfect-run наградата.';
      $('#resultScore').textContent = Number(result.score || 0).toLocaleString();
      $('#resultXp').textContent = `+${Number(result.xp || 0)}`;
      $('#resultAccuracy').textContent = `${Number(result.accuracy || 0)}%`;
      $('#resultCombo').textContent = String(result.best_combo || 0);
      if (!payload.practice) {
        state.profile = payload;
        await loadProfile();
        await loadLeaderboard();
      }
      haptic(result.accuracy === 100 ? 'heavy' : 'medium');
    } catch (error) {
      toast(error.message || String(error));
      reset();
    }
  }

  function reset() {
    state.sessionId = '';
    state.questions = [];
    state.answers = [];
    state.index = 0;
    $('#startView').hidden = false;
    $('#questionView').hidden = true;
    $('#resultView').hidden = true;
  }

  async function loadLeaderboard() {
    try {
      const payload = await api('leaderboard?limit=10');
      const entries = payload.entries || [];
      $('#leaderList').innerHTML = entries.length ? entries.map((entry) => `
        <article class="leader-row"><strong>#${entry.position}</strong><div><b>${escapeHtml(entry.display_name || entry.username || 'Player')}</b><small>${Number(entry.games || 0)} games · ${Number(entry.accuracy || 0)}% accuracy</small></div><em>${Number(entry.points || 0).toLocaleString()}</em></article>`).join('') : '<div class="empty">Все още няма ranked резултати тази седмица.</div>';
    } catch (error) {
      $('#leaderList').innerHTML = `<div class="empty">${escapeHtml(error.message || String(error))}</div>`;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character]));
  }

  document.addEventListener('DOMContentLoaded', () => void boot());
})();
