(() => {
  'use strict';

  const PRIMARY_URL = 'https://dyrakarmy.eu/';
  const MIRROR_URL = 'https://dyrakarmy.online/';
  const WINDOWS_CLIENT_URL = '/downloads/DyrakArmyDesktop.exe';

  const labels = {
    bg: { primary: 'Основен домейн: dyrakarmy.eu', mirror: 'Резервен домейн: dyrakarmy.online', windows: 'Свали Windows клиента', title: 'Отваря инсталирания Telegram клиент. Няма автоматичен Web fallback.' },
    en: { primary: 'Primary domain: dyrakarmy.eu', mirror: 'Backup domain: dyrakarmy.online', windows: 'Download Windows client', title: 'Opens the installed Telegram client. No automatic Web fallback.' },
    ru: { primary: 'Основной домен: dyrakarmy.eu', mirror: 'Резервный домен: dyrakarmy.online', windows: 'Скачать клиент Windows', title: 'Открывает установленный клиент Telegram без автоматического Web fallback.' },
    de: { primary: 'Primäre Domain: dyrakarmy.eu', mirror: 'Backup-Domain: dyrakarmy.online', windows: 'Windows-Client laden', title: 'Öffnet den installierten Telegram-Client ohne automatischen Web-Fallback.' },
  };

  function language() {
    const value = String(document.documentElement.lang || 'bg').slice(0, 2).toLowerCase();
    return labels[value] ? value : 'bg';
  }

  function apply() {
    document.body.dataset.daSurface = 'web';
    const copy = labels[language()];
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.href = PRIMARY_URL;

    const primary = document.querySelector('#canonicalDomainLink');
    if (primary) {
      primary.href = PRIMARY_URL;
      const text = primary.querySelector('span');
      if (text) text.textContent = 'dyrakarmy.eu';
    }

    const domainSwitch = document.querySelector('.domain-switch');
    if (domainSwitch) {
      const links = domainSwitch.querySelectorAll('a');
      const onPrimary = location.hostname.endsWith('dyrakarmy.eu');
      if (links[0]) links[0].href = onPrimary ? MIRROR_URL : PRIMARY_URL;
      if (links[1]) {
        links[1].href = onPrimary ? MIRROR_URL : PRIMARY_URL;
        const text = links[1].querySelector('span') || links[1];
        text.textContent = onPrimary ? copy.mirror : copy.primary;
      }
    }

    document.querySelectorAll('.telegram-link').forEach((link) => {
      link.title = copy.title;
      link.setAttribute('rel', 'external');
    });

    const actions = document.querySelector('.telegram-actions');
    if (actions && !document.querySelector('#windowsClientLink')) {
      const link = document.createElement('a');
      link.id = 'windowsClientLink';
      link.className = 'secondary-button';
      link.href = WINDOWS_CLIENT_URL;
      link.textContent = copy.windows;
      link.setAttribute('download', 'DyrakArmyDesktop.exe');
      actions.appendChild(link);
    } else {
      const link = document.querySelector('#windowsClientLink');
      if (link) link.textContent = copy.windows;
    }
  }

  function loadStylesheet(href) {
    if (document.querySelector(`link[href^="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${href}?v=19.0.0`;
    link.dataset.soundUniverse = '19.0.0';
    document.head.appendChild(link);
  }

  function loadScript(src, version = '18.0.0') {
    if (document.querySelector(`script[src^="${src}"]`)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${src}?v=${version}`;
      script.async = false;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  const init = () => {
    apply();
    loadStylesheet('/platform/sound-universe-v19.css');
    loadScript('/platform/i18n-v18.js')
      .then(() => loadScript('/platform/source-discovery-v18.js'))
      .then(() => loadScript('/platform/sound-universe-v19.js', '19.0.0'))
      .catch((error) => console.warn('Platform UI module failed to load', error));
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
  new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
})();
