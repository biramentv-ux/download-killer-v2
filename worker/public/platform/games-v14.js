(() => {
  'use strict';

  const copy = {
    bg: {
      nav: 'Игри', tag: 'TELEGRAM GAMES', title: 'DyrakArmy Games',
      intro: 'Две свързани игри използват един профил, общ XP, рангове, награди и седмични класации.',
      arenaText: 'Създай отбор, изпълнявай осем дневни мисии и се състезавай в седмични лиги и месечни сезони.',
      playWeb: 'Играй в браузъра', playTelegram: 'Отвори в Telegram', latencyText: 'Пет бързи рунда измерват реакцията ти и отключват профилни награди.',
      teams: 'активни отбора', week: 'седмица', season: 'сезон', top: 'Топ отбори тази седмица',
    },
    en: {
      nav: 'Games', tag: 'TELEGRAM GAMES', title: 'DyrakArmy Games',
      intro: 'Two connected games share one profile, XP, ranks, rewards and weekly leaderboards.',
      arenaText: 'Build a team, complete eight daily missions and compete in weekly leagues and monthly seasons.',
      playWeb: 'Play in browser', playTelegram: 'Open in Telegram', latencyText: 'Five fast rounds measure your reaction and unlock profile rewards.',
      teams: 'active teams', week: 'week', season: 'season', top: 'Top teams this week',
    },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const language = () => document.documentElement.lang?.slice(0, 2) === 'en' ? 'en' : 'bg';

  function applyCopy() {
    const strings = copy[language()];
    $$('[data-games-i18n]').forEach((node) => {
      const value = strings[node.dataset.gamesI18n];
      if (value) node.textContent = value;
    });
  }

  async function loadArenaData() {
    const list = $('#arenaTopTeams');
    if (!list) return;
    try {
      const [configResponse, leaderboardResponse] = await Promise.all([
        fetch('/api/games/dyrakarmy-arena/config', { cache: 'no-store' }),
        fetch('/api/games/dyrakarmy-arena/leaderboard?scope=teams&period=week&limit=5', { cache: 'no-store' }),
      ]);
      const config = await configResponse.json();
      const leaderboard = await leaderboardResponse.json();
      $('#arenaWeekKey').textContent = config.week_key || '—';
      $('#arenaSeasonKey').textContent = config.season_key || '—';
      const entries = leaderboard.entries || [];
      $('#arenaTeamCount').textContent = String(entries.length);
      list.innerHTML = entries.length ? entries.map((entry) => `
        <div class="arena-team-row"><strong>#${entry.position}</strong><div><b>${escapeHtml(entry.name || 'Arena Team')}</b><small>${Number(entry.members || 0)} members · ${Number(entry.games || 0)} games</small></div><em>${Number(entry.points || 0).toLocaleString()}</em></div>`).join('') : '<div class="arena-team-row"><strong>—</strong><div><b>Няма класирани отбори</b><small>Създай първия отбор в Arena.</small></div><em>0</em></div>';
    } catch (error) {
      list.innerHTML = `<div class="arena-team-row"><strong>!</strong><div><b class="games-error">Arena data unavailable</b><small>${escapeHtml(error.message || String(error))}</small></div><em>—</em></div>`;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character]));
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyCopy();
    void loadArenaData();
    new MutationObserver(applyCopy).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  });
})();
