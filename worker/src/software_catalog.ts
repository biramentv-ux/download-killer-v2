import type { Env } from './types';

export type SoftwarePlatform = 'windows' | 'macos' | 'browser' | 'mobile' | 'web';
export type SoftwareAction = 'download' | 'install';

export type SoftwareReleaseEntry = {
  id: string;
  title: string;
  description: string;
  version: string;
  channel: string;
  platform: SoftwarePlatform;
  architecture: string;
  filename: string | null;
  url: string;
  action: SoftwareAction;
  featured: boolean;
  tags: string[];
  requirements: string[];
};

type SoftwareCatalogEnv = Env & {
  LATEST_DESKTOP_WINDOWS_VERSION?: string;
  LATEST_DESKTOP_MACOS_VERSION?: string;
  LATEST_MOBILE_EXPO_VERSION?: string;
  LATEST_EXTENSION_VERSION?: string;
  LATEST_WEB_VERSION?: string;
  RELEASE_CHANNEL?: string;
  RELEASE_GITHUB_REPOSITORY?: string;
  PUBLIC_BASE_URL?: string;
};

const DEFAULT_REPOSITORY = 'biramentv-ux/download-killer-v2';
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function cleanVersion(value: string | undefined, fallback: string): string {
  const version = String(value || '').trim();
  return /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/.test(version) ? version : fallback;
}

function cleanChannel(value: string | undefined): string {
  const channel = String(value || 'stable').trim().toLowerCase();
  return ['stable', 'beta', 'preview'].includes(channel) ? channel : 'stable';
}

function releaseRepository(env: SoftwareCatalogEnv): string {
  const configured = String(env.RELEASE_GITHUB_REPOSITORY || '').trim();
  return SAFE_REPOSITORY.test(configured) ? configured : DEFAULT_REPOSITORY;
}

function latestAssetUrl(repository: string, filename: string): string {
  return `https://github.com/${repository}/releases/latest/download/${encodeURIComponent(filename)}`;
}

export function buildSoftwareCatalog(env: SoftwareCatalogEnv, requestOrigin = ''): {
  ok: true;
  product: string;
  channel: string;
  generated_at: string;
  source: { repository: string; release_page: string };
  releases: SoftwareReleaseEntry[];
  telegram: { bot: string; command: string; games_command: string };
  safety: { external_engine_is_separate: boolean; user_rights_required: boolean };
} {
  const repository = releaseRepository(env);
  const channel = cleanChannel(env.RELEASE_CHANNEL);
  const desktopWindows = cleanVersion(env.LATEST_DESKTOP_WINDOWS_VERSION, '7.2.1');
  const desktopMacos = cleanVersion(env.LATEST_DESKTOP_MACOS_VERSION, desktopWindows);
  const extension = cleanVersion(env.LATEST_EXTENSION_VERSION, '1.2.0');
  const mobile = cleanVersion(env.LATEST_MOBILE_EXPO_VERSION, '1.0.1');
  const web = cleanVersion(env.LATEST_WEB_VERSION, '16.0.0');
  const publicBase = String(env.PUBLIC_BASE_URL || requestOrigin || 'https://dyrakarmy.eu').replace(/\/+$/, '');
  const asset = (filename: string) => latestAssetUrl(repository, filename);

  const releases: SoftwareReleaseEntry[] = [
    {
      id: 'desktop-windows',
      title: 'DyrakArmy Desktop for Windows',
      description: 'Portable desktop package for the DyrakArmy audio workflow, local save dialogs, playlists and DJ-ready formats.',
      version: desktopWindows,
      channel,
      platform: 'windows',
      architecture: 'x64 portable',
      filename: 'DyrakArmyDesktop.exe',
      url: asset('DyrakArmyDesktop.exe'),
      action: 'download',
      featured: true,
      tags: ['desktop', 'portable', 'local-downloads', 'dj-workflow'],
      requirements: ['Windows 10/11', 'Internet connection for first tool setup'],
    },
    {
      id: 'desktop-macos',
      title: 'DyrakArmy Desktop for macOS',
      description: 'Portable macOS bundle using the same profile, formats, history and production endpoints.',
      version: desktopMacos,
      channel,
      platform: 'macos',
      architecture: 'universal bootstrap',
      filename: 'DyrakArmyDesktop-macOS.zip',
      url: asset('DyrakArmyDesktop-macOS.zip'),
      action: 'download',
      featured: true,
      tags: ['desktop', 'portable', 'macos', 'dj-workflow'],
      requirements: ['Supported macOS release', 'Allow the downloaded app in system security settings when prompted'],
    },
    {
      id: 'mix-engine-windows',
      title: 'DyrakArmy OGG/MP4 Engine GUI',
      description: 'Optional Windows interface for a separately installed Spotify OGG/MP4 engine and mixing-preparation workflow.',
      version: desktopWindows,
      channel,
      platform: 'windows',
      architecture: 'x64 portable',
      filename: 'DyrakArmySpotifyOggMp4Engine.exe',
      url: asset('DyrakArmySpotifyOggMp4Engine.exe'),
      action: 'download',
      featured: true,
      tags: ['mixing-toolkit', 'ogg', 'mp4', 'external-engine'],
      requirements: ['Windows 10/11', 'External engine installed and configured independently'],
    },
    {
      id: 'extension-chrome',
      title: 'DyrakArmy Chrome Companion',
      description: 'Canonical browser companion for sending supported public links directly to DyrakArmy.',
      version: extension,
      channel,
      platform: 'browser',
      architecture: 'Chrome Manifest V3',
      filename: 'DyrakArmy-Extension-Chrome.zip',
      url: asset('DyrakArmy-Extension-Chrome.zip'),
      action: 'download',
      featured: false,
      tags: ['chrome', 'extension', 'browser'],
      requirements: ['Chromium-based browser with unpacked-extension support'],
    },
    {
      id: 'extension-firefox',
      title: 'DyrakArmy Firefox Companion',
      description: 'Firefox package connected to the same Worker API, sync profile and download workflow.',
      version: extension,
      channel,
      platform: 'browser',
      architecture: 'WebExtension',
      filename: 'DyrakArmy-Extension-Firefox.zip',
      url: asset('DyrakArmy-Extension-Firefox.zip'),
      action: 'download',
      featured: false,
      tags: ['firefox', 'extension', 'browser'],
      requirements: ['Firefox with temporary or signed add-on installation support'],
    },
    {
      id: 'extension-legacy-chrome',
      title: 'Legacy Chrome Companion',
      description: 'Compatibility build retained for older Chromium environments.',
      version: extension,
      channel,
      platform: 'browser',
      architecture: 'legacy Chromium',
      filename: 'DyrakArmy-Extension-Legacy-Chrome.zip',
      url: asset('DyrakArmy-Extension-Legacy-Chrome.zip'),
      action: 'download',
      featured: false,
      tags: ['chrome', 'legacy', 'compatibility'],
      requirements: ['Use only when the canonical Chrome package is unsupported'],
    },
    {
      id: 'expo-web',
      title: 'DyrakArmy Expo Web Bundle',
      description: 'Exported web bundle for testing and controlled hosting of the mobile shell.',
      version: mobile,
      channel,
      platform: 'web',
      architecture: 'Expo web',
      filename: 'SoundDrop-Expo-Web.zip',
      url: asset('SoundDrop-Expo-Web.zip'),
      action: 'download',
      featured: false,
      tags: ['expo', 'web', 'mobile-shell'],
      requirements: ['Static hosting or local development server'],
    },
    {
      id: 'expo-native-update',
      title: 'DyrakArmy Native Update Bundle',
      description: 'Expo native update payload used by the iOS and Android shell validation flow.',
      version: mobile,
      channel,
      platform: 'mobile',
      architecture: 'iOS / Android update bundle',
      filename: 'SoundDrop-Expo-Native-Update.zip',
      url: asset('SoundDrop-Expo-Native-Update.zip'),
      action: 'download',
      featured: false,
      tags: ['expo', 'ios', 'android', 'update'],
      requirements: ['Compatible DyrakArmy Expo shell'],
    },
    {
      id: 'pwa',
      title: 'DyrakArmy PWA',
      description: 'Install the current public platform directly from the browser with offline shell support.',
      version: web,
      channel,
      platform: 'web',
      architecture: 'PWA',
      filename: null,
      url: `${publicBase}/#home`,
      action: 'install',
      featured: true,
      tags: ['pwa', 'web', 'offline-shell'],
      requirements: ['Modern browser with PWA installation support'],
    },
  ];

  return {
    ok: true,
    product: 'DyrakArmy Software & Mixing Toolkit',
    channel,
    generated_at: new Date().toISOString(),
    source: {
      repository,
      release_page: `https://github.com/${repository}/releases/latest`,
    },
    releases,
    telegram: {
      bot: '@dyrakarmy_bot',
      command: '/software',
      games_command: '/games',
    },
    safety: {
      external_engine_is_separate: true,
      user_rights_required: true,
    },
  };
}

export async function handleSoftwareCatalogApi(
  request: Request,
  env: SoftwareCatalogEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/api/software/releases') return null;

  return Response.json(buildSoftwareCatalog(env, url.origin), {
    headers: {
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=900',
      'Content-Type': 'application/json; charset=utf-8',
      'X-DyrakArmy-Software-Catalog': 'v1',
    },
  });
}
