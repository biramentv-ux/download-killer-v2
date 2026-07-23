(() => {
  'use strict';

  const SUPPORTED = ['bg', 'en', 'ru', 'de'];
  const STORAGE_KEY = 'dyrakarmy.product.language.v20';
  let deferredInstall = null;
  let language = localStorage.getItem(STORAGE_KEY) || 'bg';
  if (!SUPPORTED.includes(language)) language = 'bg';

  const copy = {
    bg: {
      nav_overview: 'Начало', nav_experiences: 'Изживявания', nav_games: 'Игри', nav_community: 'Общност', nav_profile: 'Профил',
      hero_kicker: 'ЕДНА ТВОРЧЕСКА ЕКОСИСТЕМА', hero_title_a: 'ТВОЯТА МУЗИКА.', hero_title_b: 'ТВОЯТА АРМИЯ.',
      hero_text: 'DyrakArmy събира музика, игри, общност и персонален прогрес в едно последователно изживяване — в браузъра и Telegram.',
      explore: 'Разгледай платформата', open_telegram: 'Отвори Telegram', ready: 'Всичко е готово', profile: 'Един профил навсякъде',
      experiences_kicker: 'DYRAKARMY EXPERIENCES', experiences_title: 'Всичко важно. Без излишен шум.', experiences_text: 'Всеки модул има ясна роля и общ визуален език.',
      games_kicker: 'GAMES 1–10', games_title: 'Играй. Печели XP. Изграждай профила си.', games_text: 'Десет свързани изживявания с общи рангове, награди и класации.',
      community_kicker: 'COMMUNITY', community_title: 'Твоето място в DyrakArmy.', community_text: 'Влизай през Telegram, следи новостите и развивай един общ профил.',
      community_button: 'Влез в общността', miniapp_button: 'Отвори Mini App', support: 'Поддръжка', privacy: 'Поверителност',
    },
    en: {
      nav_overview: 'Home', nav_experiences: 'Experiences', nav_games: 'Games', nav_community: 'Community', nav_profile: 'Profile',
      hero_kicker: 'ONE CREATIVE ECOSYSTEM', hero_title_a: 'YOUR MUSIC.', hero_title_b: 'YOUR ARMY.',
      hero_text: 'DyrakArmy brings music, games, community and personal progress into one consistent experience across web and Telegram.',
      explore: 'Explore the platform', open_telegram: 'Open Telegram', ready: 'Everything is ready', profile: 'One profile everywhere',
      experiences_kicker: 'DYRAKARMY EXPERIENCES', experiences_title: 'Everything important. Nothing noisy.', experiences_text: 'Every module has a clear role and one shared visual language.',
      games_kicker: 'GAMES 1–10', games_title: 'Play. Earn XP. Build your profile.', games_text: 'Ten connected experiences with shared ranks, rewards and leaderboards.',
      community_kicker: 'COMMUNITY', community_title: 'Your place inside DyrakArmy.', community_text: 'Join through Telegram, follow updates and grow one shared profile.',
      community_button: 'Join the community', miniapp_button: 'Open Mini App', support: 'Support', privacy: 'Privacy',
    },
    ru: {
      nav_overview: 'Главная', nav_experiences: 'Разделы', nav_games: 'Игры', nav_community: 'Сообщество', nav_profile: 'Профиль',
      hero_kicker: 'ЕДИНАЯ ТВОРЧЕСКАЯ ЭКОСИСТЕМА', hero_title_a: 'ТВОЯ МУЗЫКА.', hero_title_b: 'ТВОЯ АРМИЯ.',
      hero_text: 'DyrakArmy объединяет музыку, игры, сообщество и личный прогресс в одном цельном опыте для web и Telegram.',
      explore: 'Открыть платформу', open_telegram: 'Открыть Telegram', ready: 'Всё готово', profile: 'Один профиль везде',
      experiences_kicker: 'DYRAKARMY EXPERIENCES', experiences_title: 'Всё важное. Ничего лишнего.', experiences_text: 'Каждый модуль имеет ясную роль и общий визуальный язык.',
      games_kicker: 'GAMES 1–10', games_title: 'Играй. Получай XP. Развивай профиль.', games_text: 'Десять связанных игр с общими рангами, наградами и таблицами лидеров.',
      community_kicker: 'COMMUNITY', community_title: 'Твоё место в DyrakArmy.', community_text: 'Входи через Telegram, следи за новостями и развивай единый профиль.',
      community_button: 'Войти в сообщество', miniapp_button: 'Открыть Mini App', support: 'Поддержка', privacy: 'Конфиденциальность',
    },
    de: {
      nav_overview: 'Start', nav_experiences: 'Erlebnisse', nav_games: 'Spiele', nav_community: 'Community', nav_profile: 'Profil',
      hero_kicker: 'EIN KREATIVES ÖKOSYSTEM', hero_title_a: 'DEINE MUSIK.', hero_title_b: 'DEINE ARMEE.',
      hero_text: 'DyrakArmy verbindet Musik, Spiele, Community und persönlichen Fortschritt in einem konsistenten Erlebnis für Web und Telegram.',
      explore: 'Plattform entdecken', open_telegram: 'Telegram öffnen', ready: 'Alles ist bereit', profile: 'Ein Profil überall',
      experiences_kicker: 'DYRAKARMY EXPERIENCES', experiences_title: 'Alles Wichtige. Kein unnötiger Lärm.', experiences_text: 'Jedes Modul hat eine klare Rolle und eine gemeinsame visuelle Sprache.',
      games_kicker: 'GAMES 1–10', games_title: 'Spielen. XP verdienen. Profil aufbauen.', games_text: 'Zehn verbundene Erlebnisse mit gemeinsamen Rängen, Belohnungen und Bestenlisten.',
      community_kicker: 'COMMUNITY', community_title: 'Dein Platz in DyrakArmy.', community_text: 'Über Telegram beitreten, Neuigkeiten verfolgen und ein gemeinsames Profil entwickeln.',
      community_button: 'Community öffnen', miniapp_button: 'Mini App öffnen', support: 'Support', privacy: 'Datenschutz',
    },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function applyLanguage(next = language) {
    language = SUPPORTED.includes(next) ? next : 'bg';
    localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language;
    $$('[data-copy]').forEach((node) => {
      const value = copy[language]?.[node.dataset.copy];
      if (value) node.textContent = value;
    });
    $$('[data-language]').forEach((button) => button.classList.toggle('active', button.dataset.language === language));
  }

  function bindNavigation() {
    const menu = $('#productMenu');
    const nav = $('#productNav');
    menu?.addEventListener('click', () => {
      const open = nav?.classList.toggle('open') || false;
      menu.setAttribute('aria-expanded', String(open));
    });
    $$('#productNav a').forEach((link) => link.addEventListener('click', () => nav?.classList.remove('open')));
    $$('[data-language]').forEach((button) => button.addEventListener('click', () => applyLanguage(button.dataset.language)));
  }

  async function verifyExperience() {
    const node = $('#experienceStatus');
    if (!node) return;
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 6500);
      const response = await fetch(`/api/health?surface=product-v20&ts=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
      window.clearTimeout(timer);
      if (!response.ok) throw new Error(String(response.status));
      node.dataset.state = 'ready';
    } catch {
      node.dataset.state = 'available';
    }
  }

  async function loadPublicProfile() {
    const name = $('#profileName');
    const role = $('#profileRole');
    if (!name || !role) return;
    try {
      const response = await fetch('/api/platform/public', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json();
      const profile = payload.profile || payload.identity || {};
      if (profile.display_name) name.textContent = String(profile.display_name);
      if (profile.role) role.textContent = String(profile.role).toUpperCase();
    } catch {
      // Guest presentation remains intentionally usable without identity data.
    }
  }

  function bindPwa() {
    const button = $('#installProduct');
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstall = event;
      if (button) button.hidden = false;
    });
    button?.addEventListener('click', async () => {
      if (!deferredInstall) return;
      await deferredInstall.prompt();
      deferredInstall = null;
      button.hidden = true;
    });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  function bindScrollState() {
    const sections = $$('main section[id]');
    const links = $$('#productNav a[href^="#"]');
    const update = () => {
      const marker = window.scrollY + 180;
      let active = sections[0]?.id || 'overview';
      for (const section of sections) if (section.offsetTop <= marker) active = section.id;
      links.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${active}`));
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
  }

  function init() {
    document.body.classList.add('product-redesign-v20');
    applyLanguage();
    bindNavigation();
    bindPwa();
    bindScrollState();
    void verifyExperience();
    void loadPublicProfile();
    const year = $('#year');
    if (year) year.textContent = String(new Date().getFullYear());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
