(() => {
  'use strict';

  const MODULE_TARGETS = {
    home: '#home',
    'how-it-works': '#tutorial',
    features: '#engines',
    games: '#games',
    'queue-commander': '[data-platform-module="queue-commander"]',
    'beat-hunter': '[data-platform-module="beat-hunter"]',
    'dyrakarmy-arena': '[data-platform-module="dyrakarmy-arena"]',
    'format-forge': '[data-platform-module="format-forge"]',
    'server-defender': '[data-platform-module="server-defender"]',
    'metadata-detective': '[data-platform-module="metadata-detective"]',
    'link-runner': '[data-platform-module="link-runner"]',
    'archive-raid': '[data-platform-module="archive-raid"]',
    'latency-strike': '[data-platform-module="latency-strike"]',
    'bot-vs-human': '[data-platform-module="bot-vs-human"]',
    downloads: '#console',
    'media-lab': '#media-lab',
    telegram: '#telegram',
    status: '#status',
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  async function loadRegistry() {
    document.documentElement.classList.add('platform-public-loading');
    try {
      const response = await fetch('/api/platform/public', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const registry = await response.json();
      if (!response.ok || !registry?.ok) throw new Error(registry?.error?.message || `HTTP ${response.status}`);
      const settings = registry.settings || {};
      applySettings(settings);
      applyModules(registry.modules || []);
      applyContent(registry.content || [], settings);
      document.dispatchEvent(new CustomEvent('platform-registry-ready', { detail: registry }));
      document.documentElement.classList.add('platform-public-ready');
    } catch (error) {
      console.warn('Platform registry unavailable:', error);
    } finally {
      document.documentElement.classList.remove('platform-public-loading');
    }
  }

  function applySettings(settings) {
    const root = document.documentElement;
    if (validColor(settings['theme.accent'])) root.style.setProperty('--remote-accent', settings['theme.accent']);
    if (validColor(settings['theme.accent_secondary'])) root.style.setProperty('--remote-accent-2', settings['theme.accent_secondary']);
    if (validColor(settings['theme.background'])) root.style.setProperty('--remote-bg', settings['theme.background']);
    const radius = Number(settings['theme.radius']);
    if (Number.isFinite(radius)) root.style.setProperty('--remote-radius', `${Math.min(48, Math.max(0, radius))}px`);
    const siteTitle = String(settings['site.title'] || '').trim();
    if (siteTitle) {
      document.title = `${siteTitle} Platform`;
      $$('.brand span:last-child, .footer-brand span:last-child').forEach((node) => {
        if (!node.querySelector('strong')) return;
        const words = siteTitle.split(/\s+/);
        node.innerHTML = `<strong>${escapeHtml(words[0] || siteTitle)}</strong>${escapeHtml(words.slice(1).join(' '))}`;
      });
    }
    const footerText = String(settings['site.footer'] || '').trim();
    const footerParagraph = $('footer [data-i18n="footer_text"]');
    if (footerText && footerParagraph) footerParagraph.textContent = footerText;
    document.body.style.backgroundColor = settings['theme.background'] || '';
    const season = String(settings['games.season_label'] || '').trim();
    if (season) document.querySelectorAll('[data-season-label]').forEach((node) => { node.textContent = season; });
  }

  function applyModules(modules) {
    const byId = new Map(modules.map((module) => [module.id, module]));
    Object.entries(MODULE_TARGETS).forEach(([id, selector]) => {
      const module = byId.get(id);
      if (!module) return;
      $$(selector).forEach((node) => {
        node.dataset.platformModule = id;
        node.setAttribute('data-platform-hidden', module.enabled ? 'false' : 'true');
      });
    });

    const nav = $('#mainNav');
    if (nav) {
      nav.querySelectorAll('[data-managed-nav]').forEach((node) => node.remove());
      modules
        .filter((module) => module.enabled && ['game', 'tool', 'section', 'link'].includes(module.kind) && !MODULE_TARGETS[module.id])
        .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
        .slice(0, 6)
        .forEach((module) => {
          const href = module.public_url || module.telegram_url;
          if (!href) return;
          const link = document.createElement('a');
          link.href = href;
          link.textContent = module.title;
          link.dataset.managedNav = module.id;
          link.className = 'managed-nav-link';
          if (/^(https:|tg:)/.test(href)) link.rel = 'external noopener';
          nav.append(link);
        });
    }

    renderManagedModules(modules.filter((module) => module.enabled && !module.system && !MODULE_TARGETS[module.id]));
  }

  function applyContent(content, settings) {
    const grouped = Object.groupBy ? Object.groupBy(content, (item) => item.slot) : groupContent(content);
    renderAnnouncement(settings['announcement.enabled'] === false ? [] : grouped.announcement || []);
    renderManagedContent(grouped.updates || [], 'updates');
    renderManagedContent(grouped.home || [], 'home');
    renderManagedContent(grouped.games || [], 'games');
    renderFooterContent(grouped.footer || []);
    renderNavigationContent(grouped.navigation || []);
  }

  function renderAnnouncement(items) {
    document.querySelectorAll('.platform-announcement').forEach((node) => node.remove());
    const item = items[0];
    if (!item) return;
    const bar = document.createElement('div');
    bar.className = 'platform-announcement';
    const icon = document.createElement('strong');
    icon.textContent = item.icon || '📣';
    const text = document.createElement('span');
    text.textContent = [item.title, item.body].filter(Boolean).join(' · ');
    bar.append(icon, text);
    if (item.action_url && item.action_label) {
      const link = document.createElement('a');
      link.href = item.action_url;
      link.textContent = `${item.action_label} →`;
      link.rel = 'external noopener';
      bar.append(link);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Затвори');
    close.addEventListener('click', () => bar.remove());
    bar.append(close);
    document.body.prepend(bar);
  }

  function renderManagedModules(modules) {
    let section = $('#managedModules');
    if (!modules.length) {
      section?.remove();
      return;
    }
    if (!section) {
      section = document.createElement('section');
      section.id = 'managedModules';
      section.className = 'managed-section reveal';
      const consoleSection = $('#console');
      (consoleSection?.parentNode || document.querySelector('main'))?.insertBefore(section, consoleSection || null);
    }
    section.innerHTML = `
      <div class="managed-heading"><div><span class="kicker">REMOTE MODULES</span><h2>Нови публични модули</h2></div><p>Тази секция се управлява дистанционно през DyrakArmy Control Center.</p></div>
      <div class="managed-grid">${modules.map(cardMarkup).join('')}</div>`;
  }

  function renderManagedContent(items, slot) {
    const id = `managed-${slot}`;
    let section = document.getElementById(id);
    if (!items.length) {
      section?.remove();
      return;
    }
    if (!section) {
      section = document.createElement('section');
      section.id = id;
      section.className = 'managed-section reveal';
      const anchor = slot === 'games' ? $('#games') : slot === 'home' ? $('#tutorial') : $('#console');
      (anchor?.parentNode || document.querySelector('main'))?.insertBefore(section, anchor || null);
    }
    section.innerHTML = `
      <div class="managed-heading"><div><span class="kicker">${escapeHtml(slot.toUpperCase())}</span><h2>${slot === 'updates' ? 'Последни публични обновявания' : 'DyrakArmy Platform'}</h2></div></div>
      <div class="managed-grid">${items.map(cardMarkup).join('')}</div>`;
  }

  function renderFooterContent(items) {
    const footer = document.querySelector('footer');
    if (!footer) return;
    footer.querySelectorAll('.managed-footer-note').forEach((node) => node.remove());
    items.forEach((item) => {
      const note = document.createElement('small');
      note.className = 'managed-footer-note';
      note.textContent = [item.icon, item.title, item.body].filter(Boolean).join(' ');
      footer.append(note);
    });
  }

  function renderNavigationContent(items) {
    const nav = $('#mainNav');
    if (!nav) return;
    items.forEach((item) => {
      if (!item.action_url) return;
      const link = document.createElement('a');
      link.href = item.action_url;
      link.textContent = item.title;
      link.dataset.managedNav = item.id;
      nav.append(link);
    });
  }

  function cardMarkup(item) {
    const url = item.action_url || item.public_url || item.telegram_url || '';
    const label = item.action_label || (url ? 'Отвори' : '');
    return `<article class="managed-card"><span>${escapeHtml(item.icon || '◈')}</span><h3>${escapeHtml(item.title || '')}</h3><p>${escapeHtml(item.body || item.description || '')}</p>${url && label ? `<a href="${escapeAttr(url)}" rel="external noopener">${escapeHtml(label)} →</a>` : ''}</article>`;
  }

  function groupContent(items) {
    return items.reduce((groups, item) => {
      const key = item.slot || 'updates';
      (groups[key] ||= []).push(item);
      return groups;
    }, {});
  }

  function validColor(value) { return /^#[0-9a-f]{6}$/i.test(String(value || '')); }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character])); }
  function escapeAttr(value) { return escapeHtml(value); }

  document.addEventListener('DOMContentLoaded', () => void loadRegistry());
})();
