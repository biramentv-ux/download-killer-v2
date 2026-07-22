(() => {
  'use strict';

  const VERSION = '19.0.0';
  const PRIMARY_HOST = 'dyrakarmy.eu';
  const SECONDARY_HOST = 'dyrakarmy.online';
  const PRIMARY_URL = `https://${PRIMARY_HOST}`;
  const SECONDARY_URL = `https://${SECONDARY_HOST}`;
  const labels = {
    bg: { primary: 'Основна среда', secondary: 'Резервна среда', online: 'Синхронизирано', checking: 'Проверка', switchTo: 'Отвори другия домейн', banner: 'Sound Universe v19 използва еднакви функции и backend и на двата домейна.' },
    en: { primary: 'Primary environment', secondary: 'Backup environment', online: 'Synchronized', checking: 'Checking', switchTo: 'Open the other domain', banner: 'Sound Universe v19 uses the same functions and backend on both domains.' },
    ru: { primary: 'Основная среда', secondary: 'Резервная среда', online: 'Синхронизировано', checking: 'Проверка', switchTo: 'Открыть другой домен', banner: 'Sound Universe v19 использует одинаковые функции и backend на обоих доменах.' },
    de: { primary: 'Primäre Umgebung', secondary: 'Backup-Umgebung', online: 'Synchronisiert', checking: 'Prüfung', switchTo: 'Andere Domain öffnen', banner: 'Sound Universe v19 nutzt auf beiden Domains dieselben Funktionen und dasselbe Backend.' },
  };

  function language() {
    const code = String(document.documentElement.lang || 'bg').slice(0, 2).toLowerCase();
    return labels[code] ? code : 'bg';
  }

  function surface() {
    if (location.pathname.startsWith('/telegram')) return 'telegram';
    if (location.pathname.startsWith('/control-v2')) return 'control';
    return 'web';
  }

  function alternateUrl() {
    const target = location.hostname.endsWith(PRIMARY_HOST) ? SECONDARY_URL : PRIMARY_URL;
    return `${target}${location.pathname}${location.search}${location.hash}`;
  }

  function addDomainPill() {
    if (document.querySelector('.da-domain-pill')) return;
    const actionRoot = document.querySelector('.da-top-actions, .header-actions, .top-actions');
    if (!actionRoot) return;
    const onPrimary = location.hostname.endsWith(PRIMARY_HOST);
    const copy = labels[language()];
    const link = document.createElement('a');
    link.className = 'da-domain-pill';
    link.href = alternateUrl();
    link.title = copy.switchTo;
    link.dataset.state = 'checking';
    link.innerHTML = `<i></i><span>${onPrimary ? copy.primary : copy.secondary}</span><b>${onPrimary ? 'EU' : 'ONLINE'}</b>`;
    actionRoot.prepend(link);
  }

  function addRail() {
    if (surface() !== 'web' || document.querySelector('.sound-universe-rail')) return;
    const items = [
      ['#home', '◈', 'Discover'],
      ['#engines', '⌘', 'Modules'],
      ['#games', '◇', 'Games'],
      ['#software', '⇩', 'Software'],
      ['#console', '↓', 'Downloads'],
      ['#community', '◎', 'Community'],
      ['#status', '⌁', 'Status'],
      ['/control-v2/', '⚙', 'Control'],
    ];
    const rail = document.createElement('nav');
    rail.className = 'sound-universe-rail';
    rail.setAttribute('aria-label', 'Sound Universe navigation');
    rail.innerHTML = items.map(([href, icon, label]) => `<a href="${href}"><span aria-hidden="true">${icon}</span><small>${label}</small></a>`).join('');
    document.body.appendChild(rail);

    const sections = items.filter(([href]) => href.startsWith('#')).map(([href]) => document.querySelector(href)).filter(Boolean);
    const links = Array.from(rail.querySelectorAll('a[href^="#"]'));
    const setActive = () => {
      const marker = window.scrollY + 180;
      let active = sections[0]?.id || 'home';
      for (const section of sections) if (section.offsetTop <= marker) active = section.id;
      links.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${active}`));
    };
    setActive();
    window.addEventListener('scroll', setActive, { passive: true });
  }

  function addSyncBanner() {
    if (surface() === 'web' || document.querySelector('.sound-universe-sync-banner')) return;
    const main = document.querySelector('main');
    if (!main) return;
    const copy = labels[language()];
    const banner = document.createElement('div');
    banner.className = 'sound-universe-sync-banner';
    banner.innerHTML = `<span><b>DYRAKARMY SOUND UNIVERSE v${VERSION}</b> · ${copy.banner}</span><a href="${alternateUrl()}">${copy.switchTo} →</a>`;
    main.before(banner);
  }

  function applyHeroCopy() {
    if (surface() !== 'web') return;
    const kicker = document.querySelector('.hero-kicker');
    const title = document.querySelector('.da-hero h1');
    const description = document.querySelector('.hero-description');
    if (kicker) kicker.textContent = 'THE NEXT GENERATION MUSIC UNIVERSE';
    if (title) title.innerHTML = 'SOUND<br><span>WITHOUT LIMITS.</span>';
    if (description) description.textContent = 'Discover, connect, create and download through one synchronized DyrakArmy ecosystem — web, desktop, Telegram Mini App, games, software releases and Control Center.';
  }

  async function verifyRuntime() {
    const pill = document.querySelector('.da-domain-pill');
    if (!pill) return;
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 7000);
      const response = await fetch(`/api/health?surface=${encodeURIComponent(surface())}&v=${encodeURIComponent(VERSION)}&ts=${Date.now()}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(`HTTP ${response.status}`);
      pill.dataset.state = 'online';
      pill.querySelector('b').textContent = labels[language()].online.toUpperCase();
    } catch {
      pill.dataset.state = 'offline';
      pill.querySelector('b').textContent = 'DEGRADED';
    }
  }

  function markVersion() {
    document.documentElement.dataset.soundUniverse = VERSION;
    document.body.dataset.daSurface = document.body.dataset.daSurface || surface();
    document.body.classList.add('sound-universe-v19');
    let meta = document.querySelector('meta[name="sound-universe-version"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'sound-universe-version';
      document.head.appendChild(meta);
    }
    meta.content = VERSION;
  }

  function init() {
    markVersion();
    addDomainPill();
    addRail();
    addSyncBanner();
    applyHeroCopy();
    void verifyRuntime();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
  document.addEventListener('dyrakarmy:control-language', () => {
    document.querySelector('.da-domain-pill')?.remove();
    document.querySelector('.sound-universe-sync-banner')?.remove();
    addDomainPill();
    addSyncBanner();
    void verifyRuntime();
  });
})();
