(() => {
  'use strict';

  const state = {
    releases: [],
    filter: 'all',
    platform: 'web',
    loaded: false,
  };

  const PLATFORM_ICONS = {
    windows: '⊞',
    macos: '◆',
    browser: '⌬',
    mobile: '▣',
    web: '◎',
  };

  const PLATFORM_LABELS = {
    windows: 'WINDOWS',
    macos: 'MACOS',
    browser: 'BROWSER',
    mobile: 'MOBILE',
    web: 'WEB / PWA',
  };

  const FALLBACK_RELEASES = [
    {
      id: 'desktop-windows',
      title: 'DyrakArmy Desktop for Windows',
      description: 'Portable desktop package for local downloads, playlists and DJ-ready formats.',
      version: '7.2.1',
      channel: 'stable',
      platform: 'windows',
      architecture: 'x64 portable',
      filename: 'DyrakArmyDesktop.exe',
      url: 'https://github.com/biramentv-ux/download-killer-v2/releases/latest/download/DyrakArmyDesktop.exe',
      action: 'download',
      featured: true,
      tags: ['desktop', 'portable', 'dj-workflow'],
    },
    {
      id: 'desktop-macos',
      title: 'DyrakArmy Desktop for macOS',
      description: 'Portable macOS bundle using the same profile, formats and history.',
      version: '7.2.1',
      channel: 'stable',
      platform: 'macos',
      architecture: 'universal bootstrap',
      filename: 'DyrakArmyDesktop-macOS.zip',
      url: 'https://github.com/biramentv-ux/download-killer-v2/releases/latest/download/DyrakArmyDesktop-macOS.zip',
      action: 'download',
      featured: true,
      tags: ['desktop', 'portable', 'macos'],
    },
    {
      id: 'mix-engine-windows',
      title: 'DyrakArmy OGG/MP4 Engine GUI',
      description: 'Optional interface for a separately installed external engine and mixing-preparation workflow.',
      version: '7.2.1',
      channel: 'stable',
      platform: 'windows',
      architecture: 'x64 portable',
      filename: 'DyrakArmySpotifyOggMp4Engine.exe',
      url: 'https://github.com/biramentv-ux/download-killer-v2/releases/latest/download/DyrakArmySpotifyOggMp4Engine.exe',
      action: 'download',
      featured: true,
      tags: ['mixing-toolkit', 'ogg', 'mp4'],
    },
    {
      id: 'extension-chrome',
      title: 'DyrakArmy Chrome Companion',
      description: 'Browser companion connected to the same public Worker workflow.',
      version: '1.2.0',
      channel: 'stable',
      platform: 'browser',
      architecture: 'Manifest V3',
      filename: 'DyrakArmy-Extension-Chrome.zip',
      url: 'https://github.com/biramentv-ux/download-killer-v2/releases/latest/download/DyrakArmy-Extension-Chrome.zip',
      action: 'download',
      featured: false,
      tags: ['chrome', 'extension'],
    },
    {
      id: 'extension-firefox',
      title: 'DyrakArmy Firefox Companion',
      description: 'Firefox package with shared profile and download workflow integration.',
      version: '1.2.0',
      channel: 'stable',
      platform: 'browser',
      architecture: 'WebExtension',
      filename: 'DyrakArmy-Extension-Firefox.zip',
      url: 'https://github.com/biramentv-ux/download-killer-v2/releases/latest/download/DyrakArmy-Extension-Firefox.zip',
      action: 'download',
      featured: false,
      tags: ['firefox', 'extension'],
    },
    {
      id: 'expo-native-update',
      title: 'DyrakArmy Native Update Bundle',
      description: 'Expo update payload for the validated iOS and Android shell.',
      version: '1.0.1',
      channel: 'stable',
      platform: 'mobile',
      architecture: 'iOS / Android',
      filename: 'SoundDrop-Expo-Native-Update.zip',
      url: 'https://github.com/biramentv-ux/download-killer-v2/releases/latest/download/SoundDrop-Expo-Native-Update.zip',
      action: 'download',
      featured: false,
      tags: ['expo', 'ios', 'android'],
    },
    {
      id: 'pwa',
      title: 'DyrakArmy PWA',
      description: 'Install the public platform directly from the browser with offline shell support.',
      version: '16.0.0',
      channel: 'stable',
      platform: 'web',
      architecture: 'PWA',
      filename: null,
      url: '/#home',
      action: 'install',
      featured: true,
      tags: ['pwa', 'web', 'offline-shell'],
    },
  ];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function detectPlatform() {
    const platform = String(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '').toLowerCase();
    if (platform.includes('win')) return 'windows';
    if (platform.includes('mac')) return 'macos';
    if (/android|iphone|ipad|mobile/.test(platform)) return 'mobile';
    return 'web';
  }

  function preferredScore(release) {
    if (release.platform === state.platform) return 0;
    if (state.platform === 'mobile' && release.platform === 'web') return 1;
    if (release.featured) return 2;
    return 3;
  }

  function normalizeRelease(item) {
    const platform = ['windows', 'macos', 'browser', 'mobile', 'web'].includes(item?.platform) ? item.platform : 'web';
    const url = String(item?.url || '');
    const safeUrl = url.startsWith('/') || /^https:\/\/(github\.com|dyrakarmy\.(eu|online))(\/|$)/i.test(url) ? url : '#software';
    return {
      id: String(item?.id || crypto.randomUUID?.() || Math.random()),
      title: String(item?.title || 'DyrakArmy Software'),
      description: String(item?.description || ''),
      version: String(item?.version || 'latest'),
      channel: String(item?.channel || 'stable'),
      platform,
      architecture: String(item?.architecture || platform),
      filename: item?.filename ? String(item.filename) : null,
      url: safeUrl,
      action: item?.action === 'install' ? 'install' : 'download',
      featured: Boolean(item?.featured),
      tags: Array.isArray(item?.tags) ? item.tags.map(String).slice(0, 5) : [],
    };
  }

  function createCard(release) {
    const article = document.createElement('article');
    article.className = 'software-release-card';
    article.dataset.platform = release.platform;
    article.dataset.featured = String(release.featured);
    article.dataset.preferred = String(release.platform === state.platform);

    const top = document.createElement('div');
    top.className = 'software-card-top';
    const icon = document.createElement('span');
    icon.className = 'software-platform-icon';
    icon.textContent = PLATFORM_ICONS[release.platform] || '◎';
    const version = document.createElement('span');
    version.className = 'software-version';
    version.textContent = `v${release.version} · ${release.channel.toUpperCase()}`;
    top.append(icon, version);

    const title = document.createElement('h4');
    title.textContent = release.title;
    const description = document.createElement('p');
    description.textContent = release.description;

    const meta = document.createElement('div');
    meta.className = 'software-meta';
    [PLATFORM_LABELS[release.platform], release.architecture, ...release.tags.slice(0, 2)].filter(Boolean).forEach((value) => {
      const tag = document.createElement('span');
      tag.textContent = value;
      meta.append(tag);
    });

    const link = document.createElement('a');
    link.className = 'software-download-button';
    link.href = release.url;
    link.rel = 'noopener noreferrer';
    if (release.url.startsWith('https://github.com/')) link.target = '_blank';
    link.dataset.softwareRelease = release.id;
    link.innerHTML = `<span>${release.action === 'install' ? 'INSTALL / OPEN' : 'DIRECT DOWNLOAD'}</span><b>↓</b>`;

    if (release.action === 'install') {
      link.addEventListener('click', (event) => {
        const installButton = $('#installPwaBtn');
        if (installButton && !installButton.disabled) {
          event.preventDefault();
          installButton.click();
        }
      });
    }

    article.append(top, title, description, meta, link);
    return article;
  }

  function render() {
    const grid = $('#softwareReleaseGrid');
    if (!grid) return;
    const ordered = [...state.releases].sort((a, b) => preferredScore(a) - preferredScore(b) || Number(b.featured) - Number(a.featured) || a.title.localeCompare(b.title));
    grid.replaceChildren(...ordered.map(createCard));
    applyFilter();

    const detected = $('#detectedSoftwarePlatform');
    if (detected) detected.textContent = `DETECTED: ${PLATFORM_LABELS[state.platform] || state.platform.toUpperCase()}`;
    const count = $('#softwareReleaseCount');
    if (count) count.textContent = `${ordered.length} VERIFIED PACKAGES`;
  }

  function applyFilter() {
    $$('.software-release-card').forEach((card) => {
      card.hidden = state.filter !== 'all' && card.dataset.platform !== state.filter;
    });
    $$('[data-software-filter]').forEach((button) => button.classList.toggle('active', button.dataset.softwareFilter === state.filter));
  }

  function setupFilters() {
    $$('[data-software-filter]').forEach((button) => button.addEventListener('click', () => {
      state.filter = button.dataset.softwareFilter || 'all';
      applyFilter();
    }));
  }

  function setupActions() {
    $('#softwarePreferredDownload')?.addEventListener('click', (event) => {
      const preferred = state.releases.find((release) => release.platform === state.platform && release.featured)
        || state.releases.find((release) => release.platform === state.platform)
        || state.releases.find((release) => release.featured);
      if (!preferred) return;
      event.preventDefault();
      if (preferred.action === 'install') {
        $('#installPwaBtn')?.click();
      } else {
        window.open(preferred.url, '_blank', 'noopener,noreferrer');
      }
    });

    $('#softwareTelegramButton')?.addEventListener('click', () => {
      location.href = 'tg://resolve?domain=dyrakarmy_bot&start=software';
    });
  }

  async function loadCatalog() {
    try {
      const response = await fetch('/api/software/releases', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload?.ok || !Array.isArray(payload.releases)) throw new Error('Invalid software catalog');
      state.releases = payload.releases.map(normalizeRelease);
      const channel = $('#softwareChannel');
      if (channel) channel.textContent = String(payload.channel || 'stable').toUpperCase();
      const source = $('#softwareReleaseSource');
      if (source && payload.source?.release_page) source.href = payload.source.release_page;
    } catch {
      state.releases = FALLBACK_RELEASES.map(normalizeRelease);
      const channel = $('#softwareChannel');
      if (channel) channel.textContent = 'STABLE · FALLBACK';
    }
    state.loaded = true;
    render();
  }

  async function init() {
    if (!$('#softwareReleaseGrid')) return;
    state.platform = detectPlatform();
    setupFilters();
    setupActions();
    await loadCatalog();
  }

  document.addEventListener('DOMContentLoaded', () => void init());
  window.DyrakArmySoftware = Object.freeze({ loadCatalog, getState: () => ({ ...state, releases: [...state.releases] }) });
})();
