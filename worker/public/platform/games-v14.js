(() => {
  'use strict';

  const GAMES = [
    { id: 'dyrakarmy-arena', title: 'DyrakArmy Arena', icon: '⚔️', text: 'Отбори, дневни мисии, седмични лиги и сезони.', path: '/games/dyrakarmy-arena/', tg: 'tg://resolve?domain=dyrakarmy_bot&startapp=arena', badge: 'TEAM ARENA' },
    { id: 'latency-strike', title: 'Latency Strike', icon: '⚡', text: 'Пет reaction рунда, общ XP и профилни награди.', path: '/games/latency-strike/', tg: 'tg://resolve?domain=dyrakarmy_bot&game=latency_strike', badge: 'REACTION' },
    { id: 'archive-raid', title: 'Archive Raid', icon: '🗃', text: 'Collectible карти, дневни crates и Army Exclusive rewards.', path: '/games/archive-raid/', tg: 'tg://resolve?domain=dyrakarmy_bot&startapp=archive_raid', badge: 'COLLECTION' },
    { id: 'queue-commander', title: 'Queue Commander', icon: '🎛', text: 'Стратегия за queues, retries, dedupe и backpressure.', path: '/games/queue-commander/', tg: 'tg://resolve?domain=dyrakarmy_bot&startapp=queue_commander', badge: 'STRATEGY' },
    { id: 'beat-hunter', title: 'Beat Hunter', icon: '🎧', text: 'Познай жанр, BPM и структура по синтетични waveform clues.', path: '/games/beat-hunter/', tg: 'tg://resolve?domain=dyrakarmy_bot&startapp=beat_hunter', badge: 'MUSIC' },
    { id: 'format-forge', title: 'Format Forge', icon: '⚒', text: 'Избери формат, качество и съвместимост за всяка цел.', path: '/games/format-forge/', tg: 'tg://resolve?domain=dyrakarmy_bot&startapp=format_forge', badge: 'FORMAT' },
    { id: 'server-defender', title: 'Server Defender', icon: '🛡', text: 'Защити Worker, Queue, D1, KV и FFmpeg backend.', path: '/games/server-defender/', tg: 'tg://resolve?domain=dyrakarmy_bot&startapp=server_defender', badge: 'DEFENSE' },
    { id: 'metadata-detective', title: 'Metadata Detective', icon: '🔎', text: 'Разследвай title, artist, ISRC, duration и artwork match.', path: '/games/metadata-detective/', tg: 'tg://resolve?domain=dyrakarmy_bot&startapp=metadata_detective', badge: 'DETECTIVE' },
    { id: 'link-runner', title: 'Link Runner', icon: '🔗', text: 'Маршрутизирай URL-и и блокирай SSRF рискове.', path: '/games/link-runner/', tg: 'tg://resolve?domain=dyrakarmy_bot&startapp=link_runner', badge: 'RUNNER' },
    { id: 'bot-vs-human', title: 'Bot vs Human', icon: '🤖', text: 'Адаптивен decision дуел срещу DK Core.', path: '/games/bot-vs-human/', tg: 'tg://resolve?domain=dyrakarmy_bot&startapp=bot_vs_human', badge: 'DUEL' },
  ];

  const $ = (selector, root = document) => root.querySelector(selector);
  const language = () => document.documentElement.lang?.slice(0, 2) === 'en' ? 'en' : 'bg';

  function ensureStyles() {
    if (document.querySelector('link[href="/platform/games-pack.css"]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/platform/games-pack.css';
    document.head.append(link);
  }

  function ensureGamesSection() {
    if ($('#games')) return;
    const section = document.createElement('section');
    section.className = 'games-section reveal';
    section.id = 'games';
    section.dataset.platformModule = 'games';
    section.setAttribute('aria-label', '10 DyrakArmy Games');
    section.innerHTML = `
      <div class="games-heading"><div><span class="kicker">10 CONNECTED GAMES</span><h2>DyrakArmy Games</h2></div><p>Десет игри използват един Telegram профил, общ XP, рангове, награди и отделни седмични класации.</p></div>
      <article class="game-showcase" data-platform-module="dyrakarmy-arena">
        <span class="game-label">⚔ TEAM ARENA · CORE GAME</span>
        <h3>DyrakArmy <em>Arena</em></h3>
        <p>Създай отбор, изпълнявай осем дневни мисии и се състезавай в седмични лиги и месечни сезони.</p>
        <div class="game-feature-row"><span>8 дневни мисии</span><span>3 ranked опита</span><span>Отборни кодове</span><span>Общ XP профил</span></div>
        <div class="game-buttons"><a class="primary-button" href="/games/dyrakarmy-arena/"><span>Играй</span><b>→</b></a><a class="secondary-button" href="tg://resolve?domain=dyrakarmy_bot&startapp=arena" rel="external"><span>Telegram</span><b>⚔</b></a></div>
        <div class="arena-emblem"><b>10</b></div>
      </article>
      <div class="game-catalog-grid">${GAMES.slice(1).map(gameCard).join('')}</div>
      <div class="game-live-strip">
        <article class="game-live-card"><span>общ брой игри</span><strong>10</strong><small>One shared profile</small></article>
        <article class="game-live-card"><span>седмица</span><strong id="arenaWeekKey">—</strong><small>Weekly rankings</small></article>
        <article class="game-live-card"><span>сезон</span><strong id="arenaSeasonKey">—</strong><small>Monthly Arena</small></article>
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
      link.textContent = language() === 'en' ? 'Games' : 'Игри';
      const consoleLink = nav.querySelector('a[href="#console"]');
      nav.insertBefore(link, consoleLink || null);
    }
  }

  function gameCard(game) {
    return `<article class="game-catalog-card" data-platform-module="${game.id}">
      <div class="game-card-top"><span>${game.icon}</span><small>${game.badge}</small></div>
      <h3>${game.title}</h3><p>${game.text}</p>
      <div class="game-card-links"><a href="${game.path}">Играй →</a><a href="${game.tg}" rel="external">Telegram</a></div>
    </article>`;
  }

  function applyRegistry(registry) {
    const modules = registry?.modules || [];
    modules.forEach((module) => {
      document.querySelectorAll(`[data-platform-module="${cssEscape(module.id)}"]`).forEach((node) => {
        node.dataset.platformHidden = module.enabled ? 'false' : 'true';
      });
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
      list.innerHTML = entries.length ? entries.map((entry) => `
        <div class="arena-team-row"><strong>#${entry.position}</strong><div><b>${escapeHtml(entry.name || 'Arena Team')}</b><small>${Number(entry.members || 0)} members · ${Number(entry.games || 0)} games</small></div><em>${Number(entry.points || 0).toLocaleString()}</em></div>`).join('') : '<div class="arena-team-row"><strong>—</strong><div><b>Няма класирани отбори</b><small>Създай първия отбор в Arena.</small></div><em>0</em></div>';
    } catch (error) {
      list.innerHTML = `<div class="arena-team-row"><strong>!</strong><div><b class="games-error">Arena data unavailable</b><small>${escapeHtml(error.message || String(error))}</small></div><em>—</em></div>`;
    }
  }

  function cssEscape(value) { return window.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-z0-9_-]/gi, ''); }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character])); }

  document.addEventListener('platform-registry-ready', (event) => applyRegistry(event.detail));
  document.addEventListener('DOMContentLoaded', () => { ensureStyles(); ensureGamesSection(); void loadArenaData(); });
})();
