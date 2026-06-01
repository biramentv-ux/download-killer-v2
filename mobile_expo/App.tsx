import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type Language = 'en' | 'bg' | 'es' | 'ru' | 'de';
type TabKey = 'download' | 'history' | 'settings';
type Source = 'all' | 'spotify' | 'youtube' | 'soundcloud' | 'deezer' | 'apple';
type AudioFormat = 'mp3' | 'm4a' | 'ogg' | 'opus' | 'flac' | 'wav';
type AudioQuality = 'best' | '320' | '256' | '192' | '128' | '96' | 'lossless';

interface QueueItem {
  id: string;
  url: string;
  format: AudioFormat;
  quality: AudioQuality;
  status: string;
  downloadUrl?: string | null;
  error?: string | null;
}

interface HistoryItem {
  id: string;
  title?: string | null;
  artist?: string | null;
  status: string;
  format: string;
  download_url?: string | null;
}

interface RuntimeDownloads {
  windows_exe?: string;
  macos_portable?: string;
  extension_chrome?: string;
  extension_firefox?: string;
}

interface RuntimeTelegram {
  available?: boolean;
  deep_link?: string;
  download_link?: string;
}

interface RuntimeConfig {
  api_base?: string;
  public_base?: string;
  downloads?: RuntimeDownloads;
  telegram?: RuntimeTelegram;
  updates?: {
    channel?: string;
    desktop_windows?: {
      latest?: string;
      minimum_supported?: string;
      download_url?: string;
    };
    desktop_macos?: {
      latest?: string;
      minimum_supported?: string;
      download_url?: string;
    };
    extension?: {
      latest?: string;
      minimum_supported?: string;
      chrome_zip_url?: string;
      firefox_zip_url?: string;
    };
    mobile_expo?: {
      latest?: string;
      minimum_supported?: string;
      update_url?: string;
    };
  };
  client_min_versions?: {
    mobile_expo?: string;
  };
  preference_defaults?: {
    language?: Language;
    source?: Source;
    format?: AudioFormat;
    quality?: AudioQuality;
    download_directory?: string;
    telegram_link_mode?: string;
  };
}

const DEFAULT_API_BASE = 'https://dyrakarmy.online';
const MOBILE_APP_VERSION = '1.0.0';
const STORAGE_KEY = 'dyrakarmy_mobile_settings_v2';
const RUNTIME_STORAGE_KEY = 'dyrakarmy_mobile_runtime_v1';
const RUNTIME_CACHE_TTL_MS = 5 * 60 * 1000;
const SOURCES: Source[] = ['all', 'spotify', 'youtube', 'soundcloud', 'deezer', 'apple'];
const FORMATS: AudioFormat[] = ['mp3', 'm4a', 'ogg', 'opus', 'flac', 'wav'];
const LOSSLESS_FORMATS = new Set<AudioFormat>(['flac', 'wav']);
const LOSSLESS_QUALITIES: AudioQuality[] = ['lossless', 'best'];
const LOSSY_QUALITIES: AudioQuality[] = ['best', '320', '256', '192', '128', '96'];
const LANG_OPTIONS: Array<{ value: Language; label: string }> = [
  { value: 'bg', label: 'рџ‡§рџ‡¬ BG' },
  { value: 'en', label: 'рџ‡¬рџ‡§ EN' },
  { value: 'es', label: 'рџ‡Єрџ‡ё ES' },
  { value: 'ru', label: 'рџ‡·рџ‡є RU' },
  { value: 'de', label: 'рџ‡©рџ‡Є DE' },
];

function normalizeBase(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return DEFAULT_API_BASE;
  const withScheme = value.startsWith('http://') || value.startsWith('https://') ? value : `https://${value}`;
  try {
    const parsed = new URL(withScheme);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/g, '')}`;
  } catch {
    return DEFAULT_API_BASE;
  }
}

function stripApiSuffix(raw: string): string {
  const base = normalizeBase(raw);
  try {
    const parsed = new URL(base);
    let path = parsed.pathname.replace(/\/+$/g, '');
    if (path.endsWith('/api')) {
      path = path.slice(0, -4);
    }
    return `${parsed.origin}${path}`;
  } catch {
    return DEFAULT_API_BASE;
  }
}

function buildDefaultDownloads(base: string) {
  const normalized = stripApiSuffix(base);
  return {
    windowsExe: `${normalized}/downloads/DyrakArmyDesktop.exe`,
    macosPortable: `${normalized}/downloads/DyrakArmyDesktop-macOS.zip`,
    chromeExtension: `${normalized}/downloads/DyrakArmy-Extension-Chrome.zip`,
    firefoxExtension: `${normalized}/downloads/DyrakArmy-Extension-Firefox.zip`,
  };
}

function deriveBaseFromRuntime(config: RuntimeConfig, fallbackBase: string): string {
  if (typeof config.public_base === 'string' && config.public_base.trim()) {
    return stripApiSuffix(config.public_base);
  }
  if (typeof config.api_base === 'string' && config.api_base.trim()) {
    return stripApiSuffix(config.api_base);
  }
  return stripApiSuffix(fallbackBase);
}

const I18N: Record<Language, Record<string, string>> = {
  en: {
    title: 'DyrakArmy Mobile',
    subtitle: 'Retro Wave shell sync',
    tab_download: 'Download',
    tab_history: 'History',
    tab_settings: 'Settings',
    input_placeholder: 'Paste URL or search text',
    queue_btn: 'Queue Download',
    queue_empty: 'Queue is empty.',
    queue_wait: 'Waiting for queue result...',
    status_idle: 'Ready.',
    status_loading: 'Working...',
    source: 'Source',
    format: 'Format',
    quality: 'Quality',
    history_load: 'Refresh History',
    history_empty: 'No jobs yet.',
    settings_sync: 'Sync key',
    settings_api: 'API URL',
    settings_lang: 'Language',
    settings_download_dir: 'Download directory',
    settings_tg_mode: 'Telegram mode',
    settings_tg_mode_bot: 'Bot link',
    settings_tg_mode_download: 'Download link',
    settings_save: 'Save settings',
    settings_open_web: 'Open Web App',
    settings_open_tg: 'Open Telegram',
    settings_win: 'Download Windows EXE',
    settings_mac: 'Download macOS Portable',
    settings_chrome: 'Download Chrome Extension',
    settings_firefox: 'Download Firefox Extension',
    update_now: 'Update now',
  },
  bg: {
    title: 'DyrakArmy Mobile',
    subtitle: 'Retro Wave shell sync',
    tab_download: 'РЎРІР°Р»СЏРЅРµ',
    tab_history: 'РСЃС‚РѕСЂРёСЏ',
    tab_settings: 'РќР°СЃС‚СЂРѕР№РєРё',
    input_placeholder: 'РџРѕСЃС‚Р°РІРё URL РёР»Рё С‚РµРєСЃС‚ Р·Р° С‚СЉСЂСЃРµРЅРµ',
    queue_btn: 'Р”РѕР±Р°РІРё Р·Р° СЃРІР°Р»СЏРЅРµ',
    queue_empty: 'РћРїР°С€РєР°С‚Р° Рµ РїСЂР°Р·РЅР°.',
    queue_wait: 'РР·С‡Р°РєРІР°РЅРµ РЅР° СЂРµР·СѓР»С‚Р°С‚...',
    status_idle: 'Р“РѕС‚РѕРІРѕ.',
    status_loading: 'РћР±СЂР°Р±РѕС‚РєР°...',
    source: 'РР·С‚РѕС‡РЅРёРє',
    format: 'Р¤РѕСЂРјР°С‚',
    quality: 'РљР°С‡РµСЃС‚РІРѕ',
    history_load: 'РћР±РЅРѕРІРё РёСЃС‚РѕСЂРёСЏ',
    history_empty: 'РќСЏРјР° Р·Р°РґР°С‡Рё.',
    settings_sync: 'Sync РєР»СЋС‡',
    settings_api: 'API URL',
    settings_lang: 'Р•Р·РёРє',
    settings_save: 'Р—Р°РїР°Р·Рё РЅР°СЃС‚СЂРѕР№РєРё',
    settings_open_web: 'РћС‚РІРѕСЂРё Web App',
    settings_open_tg: 'РћС‚РІРѕСЂРё Telegram',
    settings_win: 'РЎРІР°Р»Рё Windows EXE',
    settings_mac: 'РЎРІР°Р»Рё macOS Portable',
    settings_chrome: 'РЎРІР°Р»Рё Chrome СЂР°Р·С€РёСЂРµРЅРёРµ',
    settings_firefox: 'РЎРІР°Р»Рё Firefox СЂР°Р·С€РёСЂРµРЅРёРµ',
  },
  es: {
    title: 'DyrakArmy Mobile',
    subtitle: 'SincronizaciГіn Retro Wave',
    tab_download: 'Descargar',
    tab_history: 'Historial',
    tab_settings: 'Ajustes',
    input_placeholder: 'Pega URL o texto de bГєsqueda',
    queue_btn: 'Poner en cola',
    queue_empty: 'La cola estГЎ vacГ­a.',
    queue_wait: 'Esperando resultado...',
    status_idle: 'Listo.',
    status_loading: 'Procesando...',
    source: 'Fuente',
    format: 'Formato',
    quality: 'Calidad',
    history_load: 'Actualizar historial',
    history_empty: 'Sin tareas.',
    settings_sync: 'Clave Sync',
    settings_api: 'API URL',
    settings_lang: 'Idioma',
    settings_save: 'Guardar ajustes',
    settings_open_web: 'Abrir Web App',
    settings_open_tg: 'Abrir Telegram',
    settings_win: 'Descargar Windows EXE',
    settings_mac: 'Descargar macOS Portable',
    settings_chrome: 'Descargar extensiГіn Chrome',
    settings_firefox: 'Descargar extensiГіn Firefox',
  },
  ru: {
    title: 'DyrakArmy Mobile',
    subtitle: 'РЎРёРЅС…СЂРѕРЅРёР·Р°С†РёСЏ Retro Wave',
    tab_download: 'РЎРєР°С‡Р°С‚СЊ',
    tab_history: 'РСЃС‚РѕСЂРёСЏ',
    tab_settings: 'РќР°СЃС‚СЂРѕР№РєРё',
    input_placeholder: 'Р’СЃС‚Р°РІСЊС‚Рµ URL РёР»Рё С‚РµРєСЃС‚ РїРѕРёСЃРєР°',
    queue_btn: 'Р”РѕР±Р°РІРёС‚СЊ РІ РѕС‡РµСЂРµРґСЊ',
    queue_empty: 'РћС‡РµСЂРµРґСЊ РїСѓСЃС‚Р°.',
    queue_wait: 'РћР¶РёРґР°РЅРёРµ СЂРµР·СѓР»СЊС‚Р°С‚Р°...',
    status_idle: 'Р“РѕС‚РѕРІРѕ.',
    status_loading: 'РћР±СЂР°Р±РѕС‚РєР°...',
    source: 'РСЃС‚РѕС‡РЅРёРє',
    format: 'Р¤РѕСЂРјР°С‚',
    quality: 'РљР°С‡РµСЃС‚РІРѕ',
    history_load: 'РћР±РЅРѕРІРёС‚СЊ РёСЃС‚РѕСЂРёСЋ',
    history_empty: 'Р—Р°РґР°С‡ РЅРµС‚.',
    settings_sync: 'Sync РєР»СЋС‡',
    settings_api: 'API URL',
    settings_lang: 'РЇР·С‹Рє',
    settings_save: 'РЎРѕС…СЂР°РЅРёС‚СЊ РЅР°СЃС‚СЂРѕР№РєРё',
    settings_open_web: 'РћС‚РєСЂС‹С‚СЊ Web App',
    settings_open_tg: 'РћС‚РєСЂС‹С‚СЊ Telegram',
    settings_win: 'РЎРєР°С‡Р°С‚СЊ Windows EXE',
    settings_mac: 'РЎРєР°С‡Р°С‚СЊ macOS Portable',
    settings_chrome: 'РЎРєР°С‡Р°С‚СЊ СЂР°СЃС€РёСЂРµРЅРёРµ Chrome',
    settings_firefox: 'РЎРєР°С‡Р°С‚СЊ СЂР°СЃС€РёСЂРµРЅРёРµ Firefox',
  },
  de: {
    title: 'DyrakArmy Mobile',
    subtitle: 'Retro-Wave-Sync',
    tab_download: 'Download',
    tab_history: 'Verlauf',
    tab_settings: 'Einstellungen',
    input_placeholder: 'URL oder Suchtext einfГјgen',
    queue_btn: 'In Warteschlange',
    queue_empty: 'Warteschlange ist leer.',
    queue_wait: 'Warte auf Ergebnis...',
    status_idle: 'Bereit.',
    status_loading: 'Verarbeitung...',
    source: 'Quelle',
    format: 'Format',
    quality: 'QualitГ¤t',
    history_load: 'Verlauf aktualisieren',
    history_empty: 'Keine Aufgaben.',
    settings_sync: 'Sync-SchlГјssel',
    settings_api: 'API URL',
    settings_lang: 'Sprache',
    settings_save: 'Einstellungen speichern',
    settings_open_web: 'Web App Г¶ffnen',
    settings_open_tg: 'Telegram Г¶ffnen',
    settings_win: 'Windows EXE herunterladen',
    settings_mac: 'macOS Portable herunterladen',
    settings_chrome: 'Chrome-Erweiterung herunterladen',
    settings_firefox: 'Firefox-Erweiterung herunterladen',
  },
};

function normalizeLang(raw: string | null | undefined): Language {
  const value = String(raw || '').toLowerCase();
  if (value.startsWith('bg')) return 'bg';
  if (value.startsWith('es')) return 'es';
  if (value.startsWith('ru')) return 'ru';
  if (value.startsWith('de')) return 'de';
  return 'en';
}

function detectSource(url: string): Source {
  const lower = url.toLowerCase();
  if (lower.includes('spotify.com')) return 'spotify';
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
  if (lower.includes('soundcloud.com')) return 'soundcloud';
  if (lower.includes('deezer.com')) return 'deezer';
  if (lower.includes('music.apple.com') || lower.includes('itunes.apple.com')) return 'apple';
  return 'all';
}

function generateSyncKey() {
  return `sync_${Math.random().toString(36).slice(2, 14)}`;
}

function qualityOptions(format: AudioFormat) {
  return LOSSLESS_FORMATS.has(format) ? LOSSLESS_QUALITIES : LOSSY_QUALITIES;
}

function parseVersion(raw: string) {
  return String(raw || '0.0.0')
    .split('.')
    .map((entry) => Number.parseInt(entry, 10))
    .map((num) => (Number.isFinite(num) ? num : 0))
    .slice(0, 3);
}

function compareVersions(a: string, b: string) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  while (left.length < 3) left.push(0);
  while (right.length < 3) right.push(0);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function normalizeRevision(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? '0'), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function deriveMobileUpdateUrl(config: RuntimeConfig, fallbackBase: string): string {
  const fallback = new URL('/', stripApiSuffix(fallbackBase)).toString();
  const updateUrl = config.updates?.mobile_expo?.update_url;
  if (typeof updateUrl === 'string' && updateUrl.trim()) return updateUrl.trim();
  return fallback;
}

export default function App() {
  const defaultDownloads = useMemo(() => buildDefaultDownloads(DEFAULT_API_BASE), []);
  const [tab, setTab] = useState<TabKey>('download');
  const [lang, setLang] = useState<Language>('bg');
  const [syncKey, setSyncKey] = useState(generateSyncKey());
  const [apiBase, setApiBase] = useState(stripApiSuffix(DEFAULT_API_BASE));
  const [publicBase, setPublicBase] = useState(stripApiSuffix(DEFAULT_API_BASE));
  const [source, setSource] = useState<Source>('all');
  const [format, setFormat] = useState<AudioFormat>('mp3');
  const [quality, setQuality] = useState<AudioQuality>('320');
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('Ready.');
  const [busy, setBusy] = useState(false);
  const [blockedMessage, setBlockedMessage] = useState('');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [telegramUrl, setTelegramUrl] = useState('https://t.me/dyrakarmy_bot');
  const [downloadLinks, setDownloadLinks] = useState(defaultDownloads);
  const [downloadDirectory, setDownloadDirectory] = useState('');
  const [telegramLinkMode, setTelegramLinkMode] = useState<'bot' | 'download'>('bot');
  const [prefsRevision, setPrefsRevision] = useState(0);
  const [updateUrl, setUpdateUrl] = useState('');

  const t = (key: string) => I18N[lang][key] ?? I18N.en[key] ?? key;
  const currentQualityOptions = useMemo(() => qualityOptions(format), [format]);

  useEffect(() => {
    if (!currentQualityOptions.includes(quality)) {
      setQuality(currentQualityOptions[0]);
    }
  }, [currentQualityOptions, quality]);

  useEffect(() => {
    const hydrate = async () => {
      let nextLang: Language = lang;
      let nextSyncKey = syncKey;
      let nextApiBase = apiBase;

      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<{
            lang: Language;
            syncKey: string;
            apiBase: string;
            source: Source;
            format: AudioFormat;
            quality: AudioQuality;
            downloadDirectory: string;
            telegramLinkMode: 'bot' | 'download';
            prefsRevision: number;
          }>;
          if (parsed.lang) nextLang = normalizeLang(parsed.lang);
          if (parsed.syncKey) nextSyncKey = parsed.syncKey;
          if (parsed.apiBase) nextApiBase = stripApiSuffix(parsed.apiBase);
          if (parsed.source) setSource(parsed.source);
          if (parsed.format) setFormat(parsed.format);
          if (parsed.quality) setQuality(parsed.quality);
          if (typeof parsed.downloadDirectory === 'string') setDownloadDirectory(parsed.downloadDirectory);
          if (parsed.telegramLinkMode === 'bot' || parsed.telegramLinkMode === 'download') {
            setTelegramLinkMode(parsed.telegramLinkMode);
          }
          if (Object.prototype.hasOwnProperty.call(parsed, 'prefsRevision')) {
            setPrefsRevision(normalizeRevision(parsed.prefsRevision));
          }
        }
      } catch {
        // ignore
      }

      try {
        const runtimeRaw = await AsyncStorage.getItem(RUNTIME_STORAGE_KEY);
        if (runtimeRaw) {
          const runtimeCache = JSON.parse(runtimeRaw) as { savedAt?: number; config?: RuntimeConfig };
          const savedAt = Number(runtimeCache?.savedAt ?? 0);
          if (savedAt > 0 && Date.now() - savedAt < RUNTIME_CACHE_TTL_MS && runtimeCache.config) {
            const derived = deriveBaseFromRuntime(runtimeCache.config, nextApiBase);
            nextApiBase = derived;
            setPublicBase(derived);
            const runtimeDownloads = runtimeCache.config.downloads ?? {};
            setDownloadLinks({
              windowsExe: runtimeDownloads.windows_exe || `${derived}/downloads/DyrakArmyDesktop.exe`,
              macosPortable: runtimeDownloads.macos_portable || `${derived}/downloads/DyrakArmyDesktop-macOS.zip`,
              chromeExtension: runtimeDownloads.extension_chrome || `${derived}/downloads/DyrakArmy-Extension-Chrome.zip`,
              firefoxExtension: runtimeDownloads.extension_firefox || `${derived}/downloads/DyrakArmy-Extension-Firefox.zip`,
            });
            if (runtimeCache.config.telegram?.available && runtimeCache.config.telegram.deep_link) {
              setTelegramUrl(runtimeCache.config.telegram.deep_link);
            }
            setUpdateUrl(deriveMobileUpdateUrl(runtimeCache.config, derived));
          }
        }
      } catch {
        // ignore cache errors
      }

      try {
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) {
          const parsed = Linking.parse(initialUrl);
          const query = parsed.queryParams ?? {};
          const qLang = query.lang ? normalizeLang(String(query.lang)) : null;
          const qSync = query.sync ? String(query.sync) : null;
          const qApi = query.api ? stripApiSuffix(String(query.api)) : null;
          if (qLang) nextLang = qLang;
          if (qSync) nextSyncKey = qSync;
          if (qApi) nextApiBase = qApi;
        }
      } catch {
        // ignore
      }

      setLang(nextLang);
      setSyncKey(nextSyncKey);
      setApiBase(nextApiBase);
      setPublicBase(nextApiBase);
      setDownloadLinks(buildDefaultDownloads(nextApiBase));
    };

    void hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const normalizedBase = stripApiSuffix(apiBase);
    if (normalizedBase !== apiBase) {
      setApiBase(normalizedBase);
      return;
    }

    const syncRemotePreferences = async () => {
      try {
        const response = await fetch(`${normalizedBase}/api/preferences?key=${encodeURIComponent(syncKey)}`);
        const payload = await response.json() as {
          language?: string;
          source?: string;
          format?: string;
          quality?: string;
          download_directory?: string;
          telegram_link_mode?: string;
          revision?: number;
        };
        if (response.ok && payload) {
          if (payload.language) setLang(normalizeLang(payload.language));
          if (payload.source && SOURCES.includes(payload.source as Source)) {
            setSource(payload.source as Source);
          }
          if (payload.format && FORMATS.includes(payload.format as AudioFormat)) {
            setFormat(payload.format as AudioFormat);
          }
          if (payload.quality) {
            setQuality(payload.quality as AudioQuality);
          }
          if (typeof payload.download_directory === 'string') {
            setDownloadDirectory(payload.download_directory);
          }
          if (payload.telegram_link_mode === 'bot' || payload.telegram_link_mode === 'download') {
            setTelegramLinkMode(payload.telegram_link_mode);
          }
          if (Object.prototype.hasOwnProperty.call(payload, 'revision')) {
            setPrefsRevision(normalizeRevision(payload.revision));
          }
        }
      } catch {
        // optional remote sync
      }
    };

    void syncRemotePreferences();
  }, [apiBase, syncKey]);

  useEffect(() => {
    const normalizedBase = stripApiSuffix(apiBase);
    const loadRuntimeConfig = async () => {
      try {
        const response = await fetch(`${normalizedBase}/api/runtime-config`);
        const payload = await response.json() as RuntimeConfig;
        if (!response.ok || !payload) {
          return;
        }

        const nextBase = deriveBaseFromRuntime(payload, normalizedBase);
        if (nextBase !== normalizedBase) {
          setApiBase(nextBase);
        }
        setPublicBase(nextBase);

        const runtimeDownloads = payload.downloads ?? {};
        setDownloadLinks({
          windowsExe: runtimeDownloads.windows_exe || `${nextBase}/downloads/DyrakArmyDesktop.exe`,
          macosPortable: runtimeDownloads.macos_portable || `${nextBase}/downloads/DyrakArmyDesktop-macOS.zip`,
          chromeExtension: runtimeDownloads.extension_chrome || `${nextBase}/downloads/DyrakArmy-Extension-Chrome.zip`,
          firefoxExtension: runtimeDownloads.extension_firefox || `${nextBase}/downloads/DyrakArmy-Extension-Firefox.zip`,
        });

        if (payload.telegram?.available && payload.telegram.deep_link) {
          setTelegramUrl(payload.telegram.deep_link);
        }

        const nextUpdateUrl = deriveMobileUpdateUrl(payload, nextBase);
        setUpdateUrl(nextUpdateUrl);

        const minVersion = String(payload.client_min_versions?.mobile_expo || '0.0.0');
        if (compareVersions(MOBILE_APP_VERSION, minVersion) < 0) {
          setBlockedMessage(`Update required: minimum ${minVersion}, current ${MOBILE_APP_VERSION}.`);
        } else {
          setBlockedMessage('');
        }

        await AsyncStorage.setItem(
          RUNTIME_STORAGE_KEY,
          JSON.stringify({
            savedAt: Date.now(),
            config: payload,
          }),
        );
      } catch {
        // runtime config is optional
      }
    };

    void loadRuntimeConfig();
  }, [apiBase]);

  const saveSettings = async () => {
    const normalizedBase = stripApiSuffix(apiBase);
    let nextRevision = prefsRevision;
    const persistedPayload = {
      lang,
      syncKey,
      apiBase: normalizedBase,
      source,
      format,
      quality,
      downloadDirectory,
      telegramLinkMode,
      prefsRevision: nextRevision,
    };
    try {
      const response = await fetch(`${normalizedBase}/api/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: syncKey,
          language: lang,
          source,
          format,
          quality,
          download_directory: downloadDirectory,
          telegram_link_mode: telegramLinkMode,
          base_revision: prefsRevision,
          client_updated_at: new Date().toISOString(),
          client_id: 'mobile_expo',
        }),
      });
      const payload = await response.json().catch(() => null) as {
        revision?: number;
        language?: string;
        source?: string;
        format?: string;
        quality?: string;
        download_directory?: string;
        telegram_link_mode?: string;
      } | null;
      if (response.ok && payload) {
        if (Object.prototype.hasOwnProperty.call(payload, 'revision')) {
          nextRevision = normalizeRevision(payload.revision);
          setPrefsRevision(nextRevision);
          persistedPayload.prefsRevision = nextRevision;
        }
        if (payload.language) setLang(normalizeLang(payload.language));
        if (payload.source && SOURCES.includes(payload.source as Source)) setSource(payload.source as Source);
        if (payload.format && FORMATS.includes(payload.format as AudioFormat)) setFormat(payload.format as AudioFormat);
        if (payload.quality) setQuality(payload.quality as AudioQuality);
        if (typeof payload.download_directory === 'string') setDownloadDirectory(payload.download_directory);
        if (payload.telegram_link_mode === 'bot' || payload.telegram_link_mode === 'download') {
          setTelegramLinkMode(payload.telegram_link_mode);
        }
      }
    } catch {
      // best effort
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(persistedPayload));
    setApiBase(normalizedBase);
    setStatus(`${t('settings_save')} вњ…`);
  };

  const queueDownload = async () => {
    if (blockedMessage) {
      setStatus(blockedMessage);
      return;
    }
    const value = input.trim();
    if (!value) {
      setStatus(t('input_placeholder'));
      return;
    }

    const sourceValue = source === 'all' ? detectSource(value) : source;
    const normalizedBase = stripApiSuffix(apiBase);
    setBusy(true);
    setStatus(t('status_loading'));

    try {
      const queuedResp = await fetch(`${normalizedBase}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: value, source: sourceValue, format, quality }),
      });
      const queued = await queuedResp.json() as { jobId?: string; error?: { message?: string } };
      if (!queuedResp.ok || !queued.jobId) {
        throw new Error(queued?.error?.message || `HTTP ${queuedResp.status}`);
      }

      const jobId = queued.jobId;
      setQueue((prev) => [
        { id: jobId, url: value, format, quality, status: 'queued' },
        ...prev,
      ].slice(0, 20));
      setStatus(`${t('queue_wait')} #${jobId.slice(0, 8)}`);

      for (let i = 0; i < 60; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusResp = await fetch(`${normalizedBase}/api/job/${encodeURIComponent(jobId)}`);
        const statusBody = await statusResp.json() as {
          job?: {
            id: string;
            status: string;
            download_url?: string | null;
            error_message?: string | null;
          };
        };
        const job = statusBody.job;
        if (!job) continue;

        setQueue((prev) =>
          prev.map((item) =>
            item.id === jobId
              ? {
                ...item,
                status: job.status,
                downloadUrl: job.download_url ?? null,
                error: job.error_message ?? null,
              }
              : item,
          ),
        );

        if (job.status === 'done' || job.status === 'failed') {
          setStatus(job.status === 'done' ? 'вњ… Done' : `вќЊ ${job.error_message || 'Failed'}`);
          break;
        }
      }
    } catch (error) {
      setStatus(`вќЊ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const loadHistory = async () => {
    setBusy(true);
    setStatus(t('status_loading'));
    try {
      const response = await fetch(`${stripApiSuffix(apiBase)}/api/history?limit=25&offset=0`);
      const body = await response.json() as { history?: HistoryItem[]; error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message || `HTTP ${response.status}`);
      }
      setHistory(body.history ?? []);
      setStatus(`${t('history_load')} вњ…`);
    } catch (error) {
      setStatus(`вќЊ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const loadTelegramInfo = async () => {
      try {
        const response = await fetch(`${stripApiSuffix(apiBase)}/api/telegram/info`);
        const body = await response.json() as { available?: boolean; deepLink?: string };
        if (response.ok && body.available && body.deepLink) {
          setTelegramUrl(body.deepLink);
        }
      } catch {
        // optional
      }
    };
    void loadTelegramInfo();
  }, [apiBase]);

  const openWebApp = () => {
    const normalizedBase = stripApiSuffix(publicBase || apiBase);
    const url = `${normalizedBase}/?sync=${encodeURIComponent(syncKey)}&lang=${encodeURIComponent(lang)}&client=mobile_expo&appver=${encodeURIComponent(MOBILE_APP_VERSION)}`;
    void Linking.openURL(url);
  };

  const platformTag = Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : 'Mobile';

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <LinearGradient colors={['#05010d', '#130624', '#070212']} style={styles.root}>
        <View pointerEvents="none" style={styles.backGlowTop} />
        <View pointerEvents="none" style={styles.backGlowBottom} />

        <View style={styles.headerCard}>
          <View style={styles.headerTopRow}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoGlyph}>в†“</Text>
            </View>
            <View style={styles.headerTextWrap}>
              <Text style={styles.title}>{t('title')}</Text>
              <Text style={styles.subtitle}>{t('subtitle')}</Text>
            </View>
            <View style={styles.platformPill}>
              <Text style={styles.platformPillText}>{platformTag}</Text>
            </View>
          </View>
        </View>

        {blockedMessage ? (
          <View style={styles.blockedBanner}>
            <Text style={styles.blockedBannerText}>{blockedMessage}</Text>
            {updateUrl ? (
              <Pressable style={styles.blockedBannerBtn} onPress={() => void Linking.openURL(updateUrl)}>
                <Text style={styles.blockedBannerBtnText}>{t('update_now')}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={styles.tabRow}>
          {(['download', 'history', 'settings'] as TabKey[]).map((entry) => (
            <Pressable
              key={entry}
              style={[styles.tabBtn, tab === entry ? styles.tabBtnActive : null]}
              onPress={() => setTab(entry)}
            >
              <Text style={[styles.tabBtnText, tab === entry ? styles.tabBtnTextActive : null]}>
                {entry === 'download' ? t('tab_download') : entry === 'history' ? t('tab_history') : t('tab_settings')}
              </Text>
            </Pressable>
          ))}
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {tab === 'download' ? (
            <View style={styles.card}>
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder={t('input_placeholder')}
                placeholderTextColor="#b782dd"
                style={styles.input}
                autoCapitalize="none"
              />

              <Text style={styles.label}>{t('source')}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsRow}>
                {SOURCES.map((entry) => (
                  <Pressable
                    key={entry}
                    style={[styles.chip, source === entry ? styles.chipActive : null]}
                    onPress={() => setSource(entry)}
                  >
                    <Text style={[styles.chipText, source === entry ? styles.chipTextActive : null]}>{entry}</Text>
                  </Pressable>
                ))}
              </ScrollView>

              <Text style={styles.label}>{t('format')}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsRow}>
                {FORMATS.map((entry) => (
                  <Pressable
                    key={entry}
                    style={[styles.chip, format === entry ? styles.chipActive : null]}
                    onPress={() => setFormat(entry)}
                  >
                    <Text style={[styles.chipText, format === entry ? styles.chipTextActive : null]}>{entry.toUpperCase()}</Text>
                  </Pressable>
                ))}
              </ScrollView>

              <Text style={styles.label}>{t('quality')}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsRow}>
                {currentQualityOptions.map((entry) => (
                  <Pressable
                    key={entry}
                    style={[styles.chip, quality === entry ? styles.chipActive : null]}
                    onPress={() => setQuality(entry)}
                  >
                    <Text style={[styles.chipText, quality === entry ? styles.chipTextActive : null]}>{entry}</Text>
                  </Pressable>
                ))}
              </ScrollView>

              <Pressable style={styles.primaryBtnWrap} onPress={queueDownload} disabled={busy}>
                <LinearGradient colors={['#ff47d6', '#60f4ff']} style={styles.primaryBtn}>
                  <Text style={styles.primaryBtnText}>{t('queue_btn')}</Text>
                </LinearGradient>
              </Pressable>
            </View>
          ) : null}

          {tab === 'history' ? (
            <View style={styles.card}>
              <Pressable style={styles.secondaryBtn} onPress={() => void loadHistory()} disabled={busy}>
                <Text style={styles.secondaryBtnText}>{t('history_load')}</Text>
              </Pressable>
              {history.length === 0 ? <Text style={styles.metaText}>{t('history_empty')}</Text> : null}
              {history.map((row) => (
                <View key={row.id} style={styles.listCard}>
                  <Text style={styles.listTitle}>{row.artist || 'Unknown'} - {row.title || 'Track'}</Text>
                  <Text style={styles.metaText}>#{row.id.slice(0, 8)} | {row.format} | {row.status}</Text>
                  {row.download_url ? (
                    <Pressable onPress={() => void Linking.openURL(row.download_url as string)}>
                      <Text style={styles.linkText}>{row.download_url}</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}

          {tab === 'settings' ? (
            <View style={styles.card}>
              <Text style={styles.label}>{t('settings_api')}</Text>
              <TextInput value={apiBase} onChangeText={setApiBase} style={styles.input} autoCapitalize="none" />

              <Text style={styles.label}>{t('settings_sync')}</Text>
              <TextInput value={syncKey} onChangeText={setSyncKey} style={styles.input} autoCapitalize="none" />

              <Text style={styles.label}>{t('settings_lang')}</Text>
              <View style={styles.inlineRow}>
                {LANG_OPTIONS.map((entry) => (
                  <Pressable
                    key={entry.value}
                    style={[styles.chip, lang === entry.value ? styles.chipActive : null]}
                    onPress={() => setLang(entry.value)}
                  >
                    <Text style={[styles.chipText, lang === entry.value ? styles.chipTextActive : null]}>{entry.label}</Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.label}>{t('settings_download_dir')}</Text>
              <TextInput
                value={downloadDirectory}
                onChangeText={setDownloadDirectory}
                style={styles.input}
                autoCapitalize="none"
              />

              <Text style={styles.label}>{t('settings_tg_mode')}</Text>
              <View style={styles.inlineRow}>
                <Pressable
                  style={[styles.chip, telegramLinkMode === 'bot' ? styles.chipActive : null]}
                  onPress={() => setTelegramLinkMode('bot')}
                >
                  <Text style={[styles.chipText, telegramLinkMode === 'bot' ? styles.chipTextActive : null]}>
                    {t('settings_tg_mode_bot')}
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.chip, telegramLinkMode === 'download' ? styles.chipActive : null]}
                  onPress={() => setTelegramLinkMode('download')}
                >
                  <Text style={[styles.chipText, telegramLinkMode === 'download' ? styles.chipTextActive : null]}>
                    {t('settings_tg_mode_download')}
                  </Text>
                </Pressable>
              </View>

              <Pressable style={styles.secondaryBtn} onPress={() => void saveSettings()}>
                <Text style={styles.secondaryBtnText}>{t('settings_save')}</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={openWebApp}>
                <Text style={styles.secondaryBtnText}>{t('settings_open_web')}</Text>
              </Pressable>
              <Pressable
                style={styles.secondaryBtn}
                onPress={() => {
                  const target = telegramLinkMode === 'download'
                    ? `${telegramUrl}${telegramUrl.includes('?') ? '&' : '?'}start=download`
                    : telegramUrl;
                  void Linking.openURL(target);
                }}
              >
                <Text style={styles.secondaryBtnText}>{t('settings_open_tg')}</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={() => void Linking.openURL(downloadLinks.windowsExe)}>
                <Text style={styles.secondaryBtnText}>{t('settings_win')}</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={() => void Linking.openURL(downloadLinks.macosPortable)}>
                <Text style={styles.secondaryBtnText}>{t('settings_mac')}</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={() => void Linking.openURL(downloadLinks.chromeExtension)}>
                <Text style={styles.secondaryBtnText}>{t('settings_chrome')}</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={() => void Linking.openURL(downloadLinks.firefoxExtension)}>
                <Text style={styles.secondaryBtnText}>{t('settings_firefox')}</Text>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.card}>
            <View style={styles.statusRow}>
              <Text style={styles.statusText}>{busy ? `${t('status_loading')} ` : ''}{status || t('status_idle')}</Text>
            </View>
            {busy ? <ActivityIndicator color="#66f7ff" style={{ marginTop: 10 }} /> : null}
            {queue.length === 0 ? <Text style={styles.metaText}>{t('queue_empty')}</Text> : null}
            {queue.map((item) => (
              <View key={item.id} style={styles.listCard}>
                <Text style={styles.listTitle}>{item.url}</Text>
                <Text style={styles.metaText}>#{item.id.slice(0, 8)} | {item.format} {item.quality} | {item.status}</Text>
                {item.downloadUrl ? (
                  <Pressable onPress={() => void Linking.openURL(String(item.downloadUrl))}>
                    <Text style={styles.linkText}>{String(item.downloadUrl)}</Text>
                  </Pressable>
                ) : null}
                {item.error ? <Text style={styles.errorText}>{item.error}</Text> : null}
              </View>
            ))}
          </View>
        </ScrollView>
      </LinearGradient>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#05010d' },
  root: { flex: 1, paddingHorizontal: 14, position: 'relative' },
  backGlowTop: {
    position: 'absolute',
    width: 360,
    height: 360,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 71, 214, 0.18)',
    top: -160,
    left: -120,
    transform: [{ scaleX: 1.2 }, { scaleY: 0.8 }],
  },
  backGlowBottom: {
    position: 'absolute',
    width: 360,
    height: 360,
    borderRadius: 999,
    backgroundColor: 'rgba(96, 244, 255, 0.15)',
    bottom: -190,
    right: -120,
    transform: [{ scaleX: 1.25 }, { scaleY: 0.85 }],
  },
  headerCard: {
    marginTop: 10,
    marginBottom: 10,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255, 132, 228, 0.36)',
    backgroundColor: 'rgba(30, 9, 52, 0.76)',
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  headerTopRow: { flexDirection: 'row', alignItems: 'center' },
  logoBadge: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 168, 238, 0.85)',
    backgroundColor: 'rgba(255, 71, 214, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  logoGlyph: { color: '#ffe8fa', fontSize: 20, fontWeight: '800' },
  headerTextWrap: { flex: 1, minWidth: 0 },
  platformPill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(108, 246, 255, 0.7)',
    backgroundColor: 'rgba(89, 240, 255, 0.2)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginLeft: 8,
  },
  platformPillText: { color: '#e9feff', fontWeight: '700', fontSize: 11 },
  title: { fontSize: 26, fontWeight: '800', color: '#ffe9ff', letterSpacing: -0.4 },
  subtitle: { marginTop: 4, color: '#dcb1f6', fontSize: 12 },
  blockedBanner: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,120,120,0.7)',
    backgroundColor: 'rgba(78,12,22,0.7)',
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginBottom: 10,
  },
  blockedBannerText: { color: '#ffd0d6', fontWeight: '700', fontSize: 12 },
  blockedBannerBtn: {
    marginTop: 8,
    alignSelf: 'flex-start',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 209, 224, 0.75)',
    backgroundColor: 'rgba(255, 71, 214, 0.26)',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  blockedBannerBtnText: { color: '#ffe8f7', fontWeight: '700', fontSize: 11 },
  tabRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  tabBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(212,131,255,0.38)',
    backgroundColor: 'rgba(52,17,83,0.56)',
    alignItems: 'center',
  },
  tabBtnActive: {
    backgroundColor: 'rgba(255, 71, 214, 0.92)',
    borderColor: '#ffd4f4',
  },
  tabBtnText: { color: '#f2d7ff', fontWeight: '700', fontSize: 12 },
  tabBtnTextActive: { color: '#290229' },
  content: { paddingBottom: 28, gap: 10 },
  card: {
    borderWidth: 1,
    borderColor: 'rgba(255,132,228,0.3)',
    backgroundColor: 'rgba(36,11,62,0.72)',
    borderRadius: 14,
    padding: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: 'rgba(209,129,255,0.48)',
    borderRadius: 11,
    backgroundColor: 'rgba(23,9,40,0.92)',
    color: '#f9e9ff',
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 10,
  },
  label: { color: '#f6cbff', fontWeight: '700', marginBottom: 6, marginTop: 2, fontSize: 12 },
  chipsRow: { marginBottom: 10 },
  chip: {
    borderWidth: 1,
    borderColor: 'rgba(204,126,255,0.42)',
    borderRadius: 999,
    backgroundColor: 'rgba(52,17,83,0.63)',
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginRight: 8,
    marginBottom: 8,
  },
  chipActive: { backgroundColor: 'rgba(96,244,255,0.94)', borderColor: '#ffd6f4' },
  chipText: { color: '#f1d3ff', fontWeight: '700', fontSize: 12 },
  chipTextActive: { color: '#2b032a' },
  primaryBtnWrap: { marginTop: 4, borderRadius: 12, overflow: 'hidden' },
  primaryBtn: { borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  primaryBtnText: { color: '#2a0229', fontWeight: '800' },
  secondaryBtn: {
    borderRadius: 11,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(208,128,255,0.4)',
    backgroundColor: 'rgba(48,16,78,0.68)',
    marginBottom: 8,
  },
  secondaryBtnText: { color: '#ffe8ff', fontWeight: '700', fontSize: 12 },
  inlineRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  statusRow: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(94, 240, 255, 0.22)',
    backgroundColor: 'rgba(23, 9, 40, 0.74)',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  statusText: { color: '#ffd6f6', fontWeight: '700', fontSize: 12 },
  listCard: {
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,132,228,0.28)',
    backgroundColor: 'rgba(28,9,49,0.74)',
    padding: 10,
  },
  listTitle: { color: '#ffedf9', fontWeight: '700', fontSize: 12 },
  metaText: { color: '#d7b4f2', marginTop: 4, fontSize: 11, lineHeight: 16 },
  linkText: { color: '#74f5ff', marginTop: 6, fontSize: 11, textDecorationLine: 'underline' },
  errorText: { marginTop: 6, color: '#ff9eb8', fontSize: 11 },
});

