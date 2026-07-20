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

  function ensureGamesSection() {
    if ($('#games')) return;
    const section = document.createElement('section');
    section.className = 'games-section reveal';
    section.id = 'games';
    section.dataset.platformModule = 'games';
    section.innerHTML = `
      <div class="games-heading"><div><span class="kicker" data-games-i18n="tag">TELEGRAM GAMES</span><h2 data-games-i18n="title">DyrakArmy Games</h2></div><p data-games-i18n="intro">Две свързани игри използват един профил, общ XP, рангове, награди и седмични класации.</p></div>
      <div class="games-grid">
        <article class="game-showcase" data-platform-module="dyrakarmy-arena">
          <span class="game-label">⚔ TEAM ARENA · NEW</span>
          <h3>DyrakArmy <em>Arena</em></h3>
          <p data-games-i18n="arenaText">Създай отбор, изпълнявай осем дневни мисии и се състезавай в седмични лиги и месечни сезони.</p>
          <div class="game-feature-row"><span>8 дневни мисии</span><span>3 ranked опита</span><span>Отборни кодове</span><span>Общ XP профил</span></div>
          <div class="game-buttons"><a class="primary-button" href="/games/dyrakarmy-arena/"><span data-games-i18n="playWeb">Играй в браузъра</span><b>→</b></a><a class="secondary-button" href="tg://resolve?domain=dyrakarmy_bot&startapp=arena" rel="external"><span data-games-i18n="playTelegram">Отвори в Telegram</span><b>⚔</b></a></div>
          <div class="arena-emblem"><b>DA</b></div>
        </article>
        <article class="secondary-game" data-platform-module="latency-strike">
          <div><div class="latency-orb">⚡</div><h3>Latency Strike</h3><p data-games-i18n="latencyText">Пет бързи рунда измерват реакцията ти и отключват профилни награди.</p></div>
          <div class="game-buttons"><a class="primary-button" href="/games/latency-strike/"><span data-games-i18n="playWeb">Играй в браузъра</span><b>→</b></a><a class="secondary-button" href="tg://resolve?domain=dyrakarmy_bot&game=latency_strike" rel="external"><span data-games-i18n="playTelegram">Отвори в Telegram</span></a></div>
        </article>
      </div>
      <div class="game-live-strip">
        <article class="game-live-card"><span data-games-i18n="week">седмица</span><strong id="arenaWeekKey">—</strong><small>Weekly League</small></article>
        <article class="game-live-card"><span data-games-i18n="season">сезон</span><strong id="arenaSeasonKey">—</strong><small>Monthly Arena</small></article>
        <article class="game-live-card"><span data-games-i18n="teams">активни отбора</span><strong id="arenaTeamCount">0</strong><small data-games-i18n="top">Топ отбори тази седмица</small></article>
      </div>
      <div class="arena-top-teams" id="arenaTopTeams"><div class="games-skeleton"></div><div class="games-skeleton"></div><div class="games-skeleton"></div></div>`;
    const engines = $('#engines');
    const consoleSection = $('#console');
    const parent = engines?.parentNode || consoleSection?.parentNode || document.querySelector('main');
    if (engines?.nextSibling) parent?.insertBefore(section, engines.nextSibling);
    else parent?.insertBefore(section, consoleSection || null);

    const nav = $('#mainNav');
    if (nav && !nav.querySelector('a[href="#games"]')) {
      const link = document.createElement('a');
      link.href = '#games';
      link.dataset.gamesI18n = 'nav';
      link.textContent = 'Игри';
      const consoleLink = nav.querySelector('a[href="#console"]');
      nav.insertBefore(link, consoleLink || null);
    }
  }

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
      if (!configResponse.ok || !leaderboardResponse.ok) throw new Error(config?.error?.message || leaderboard?.error?.message || 'Arena unavailable');
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
    ensureGamesSection();
    applyCopy();
    void loadArenaData();
    new MutationObserver(applyCopy).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  });
})();
