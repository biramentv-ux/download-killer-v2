(() => {
  'use strict';

  const GAMES = [
    { number: 1, slug: 'queue-commander', title: 'Queue Commander', icon: '📡', description: 'Priority queue, retry, dedupe и idempotency.', command: 'queuegame' },
    { number: 2, slug: 'beat-hunter', title: 'Beat Hunter', icon: '🥁', description: 'Ритми, beatgrid, фразиране и DJ структура.', command: 'beat' },
    { number: 3, slug: 'dyrakarmy-arena', title: 'DyrakArmy Arena', icon: '⚔️', description: 'Отбори, дневни мисии, седмични лиги и сезони.', command: 'arena' },
    { number: 4, slug: 'format-forge', title: 'Format Forge', icon: '⚒', description: 'Формати, bitrate, lossless и device compatibility.', command: 'formatgame' },
    { number: 5, slug: 'server-defender', title: 'Server Defender', icon: '🛡', description: 'SSRF, secrets, webhook, CORS и rate limiting.', command: 'defender' },
    { number: 6, slug: 'metadata-detective', title: 'Metadata Detective', icon: '🕵', description: 'Artist, title, album, year, cover и ISRC разследвания.', command: 'detective' },
    { number: 7, slug: 'link-runner', title: 'Link Runner', icon: '🔗', description: 'Безопасни URL схеми, redirects и DNS защита.', command: 'linkrunner' },
    { number: 8, slug: 'archive-raid', title: 'Archive Raid', icon: '🗃', description: 'Collectible карти, crates и профилни ефекти.', command: 'raid' },
    { number: 9, slug: 'latency-strike', title: 'Latency Strike', icon: '⚡', description: 'Пет реакционни рунда, XP и седмична класация.', command: 'game' },
    { number: 10, slug: 'bot-vs-human', title: 'Bot vs Human', icon: '🤖', description: 'Privacy-aware разпознаване на автоматизация.', command: 'botvhuman' },
  ];

  const copy = {
    bg: {
      nav: 'Игри', tag: 'DYRAKARMY GAMES 1–10', title: 'Една система. Десет игри.',
      intro: 'Всички игри използват един Telegram профил, общ XP, рангове, козметични награди и седмични класации.',
      play: 'Играй', telegram: 'Telegram', profile: 'общ профил', modules: 'игрови модула', rankings: 'класации',
    },
    en: {
      nav: 'Games', tag: 'DYRAKARMY GAMES 1–10', title: 'One system. Ten games.',
      intro: 'Every game shares one Telegram profile, XP, ranks, cosmetic rewards and weekly leaderboards.',
      play: 'Play', telegram: 'Telegram', profile: 'shared profile', modules: 'game modules', rankings: 'leaderboards',
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
    section.setAttribute('aria-label', GAMES.map((game) => game.title).join(', '));
    section.innerHTML = `
      <div class="games-heading">
        <div><span class="kicker" data-games-i18n="tag">DYRAKARMY GAMES 1–10</span><h2 data-games-i18n="title">Една система. Десет игри.</h2></div>
        <p data-games-i18n="intro">Всички игри използват един Telegram профил, общ XP, рангове, козметични награди и седмични класации.</p>
      </div>
      <div class="games-overview">
        <article><strong>10</strong><span data-games-i18n="modules">игрови модула</span></article>
        <article><strong>1</strong><span data-games-i18n="profile">общ профил</span></article>
        <article><strong>10</strong><span data-games-i18n="rankings">класации</span></article>
      </div>
      <div class="game-library-grid">${GAMES.map(gameMarkup).join('')}</div>
      <div class="games-system-note"><b>COMMON PROFILE CORE</b><span>XP · Rank · Frame · Icon · Animated Badge · Waveform · Theme · Title · Weekly Position</span></div>`;

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

  function gameMarkup(game) {
    const webPath = `/games/${game.slug}/`;
    const telegramPath = game.slug === 'latency-strike'
      ? 'tg://resolve?domain=dyrakarmy_bot&game=latency_strike'
      : `tg://resolve?domain=dyrakarmy_bot&startapp=${game.slug.replaceAll('-', '_')}`;
    return `<article class="game-tile" data-platform-module="${game.slug}">
      <div class="game-tile-top"><span class="game-number">${String(game.number).padStart(2, '0')}</span><i>${game.icon}</i></div>
      <h3>${game.title}</h3><p>${game.description}</p>
      <div class="game-command">/${game.command}</div>
      <div class="game-tile-actions"><a href="${webPath}"><span data-games-i18n="play">Играй</span> →</a><a href="${telegramPath}" rel="external"><span data-games-i18n="telegram">Telegram</span></a></div>
    </article>`;
  }

  function applyCopy() {
    const strings = copy[language()];
    $$('[data-games-i18n]').forEach((node) => {
      const value = strings[node.dataset.gamesI18n];
      if (value) node.textContent = value;
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    ensureGamesSection();
    applyCopy();
    new MutationObserver(applyCopy).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  });
})();
