import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type Language = 'bg' | 'en' | 'es' | 'ru' | 'de';
type TabKey = 'download' | 'history' | 'settings';
type Source = 'all' | 'spotify' | 'youtube' | 'soundcloud' | 'deezer' | 'apple' | 'podcast';
type AudioFormat = 'mp3' | 'm4a' | 'ogg' | 'opus' | 'flac' | 'wav';
type AudioQuality = 'best' | '320' | '256' | '192' | '128' | '96' | 'lossless';
type AudioProfile = 'low' | 'high' | 'lossless' | 'hifi';
type TelegramMode = 'bot' | 'download';

interface RuntimeConfig {
  api_base?: string;
  public_base?: string;
  downloads?: {
    windows_exe?: string;
    macos_portable?: string;
    extension_chrome?: string;
    extension_firefox?: string;
  };
  telegram?: {
    available?: boolean;
    deep_link?: string;
    download_link?: string;
  };
  client_min_versions?: {
    mobile_expo?: string;
  };
  updates?: {
    mobile_expo?: {
      update_url?: string;
    };
  };
}

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
  quality?: string;
  download_url?: string | null;
  error_message?: string | null;
}

interface SettingsState {
  apiBase: string;
  syncKey: string;
  language: Language;
  source: Source;
  format: AudioFormat;
  quality: AudioQuality;
  audioProfile: AudioProfile;
  resultView: 'message' | 'list' | 'compact';
  archiveUploads: boolean;
  directLinks: boolean;
  spekZip: boolean;
  albumPreview: boolean;
  qualityCaptions: boolean;
  trackCover: boolean;
  albumCover: boolean;
  playlistTrackNumbers: boolean;
  playlistNameAsAlbum: boolean;
  downloadDirectory: string;
  telegramMode: TelegramMode;
  prefsRevision: number;
  serviceQuality: Record<string, string>;
  codecConversion: {
    aac: string;
    alac: string;
    flac: string;
  };
}

const DEFAULT_API_BASE = 'https://dyrakarmy.online';
const APP_VERSION = '1.0.1';
const STORAGE_KEY = 'dyrakarmy_mobile_settings_v3';
const RUNTIME_CACHE_KEY = 'dyrakarmy_mobile_runtime_v2';
const RUNTIME_CACHE_TTL_MS = 5 * 60 * 1000;
const SOURCES: Source[] = ['all', 'spotify', 'youtube', 'soundcloud', 'deezer', 'apple', 'podcast'];
const FORMATS: AudioFormat[] = ['mp3', 'm4a', 'ogg', 'opus', 'flac', 'wav'];
const LOSSLESS_FORMATS = new Set<AudioFormat>(['flac', 'wav']);
const LOSSLESS_QUALITIES: AudioQuality[] = ['lossless', 'best'];
const LOSSY_QUALITIES: AudioQuality[] = ['best', '320', '256', '192', '128', '96'];
const SERVICE_QUALITY = ['Amazon', 'Apple', 'Beatport', 'Deezer', 'Kkbox', 'Qobuz', 'Tidal'];
const CODEC_OPTIONS = ['Original', 'AAC 256', 'ALAC', 'FLAC', 'WAV'];

const LANG_OPTIONS: Array<{ value: Language; label: string; name: string }> = [
  { value: 'bg', label: '🇧🇬 BG', name: 'Български' },
  { value: 'en', label: '🇬🇧 EN', name: 'English' },
  { value: 'es', label: '🇪🇸 ES', name: 'Español' },
  { value: 'ru', label: '🇷🇺 RU', name: 'Русский' },
  { value: 'de', label: '🇩🇪 DE', name: 'Deutsch' },
];

const I18N: Record<Language, Record<string, string>> = {
  bg: {
    title: 'DyrakArmy Mobile',
    subtitle: 'Синхронизиран iOS/Android shell',
    download: 'Сваляне',
    history: 'История',
    settings: 'Настройки',
    searchInput: 'Постави URL или текст за търсене',
    queue: 'Добави за сваляне',
    source: 'Източник',
    format: 'Формат',
    quality: 'Качество',
    queueEmpty: 'Опашката е празна.',
    refreshHistory: 'Обнови история',
    historyEmpty: 'Няма задачи.',
    general: 'General',
    language: 'Език',
    defaultSearch: 'Default Search Service',
    resultView: 'Search Result View',
    audioQuality: 'Audio Quality',
    perServiceQuality: 'Per-Service Quality',
    downloads: 'Downloads',
    archiveUploads: 'Enable Archive Uploads',
    directLinks: 'Use Direct Links',
    spekZip: 'Spek ZIP For Tracks',
    albumPreview: 'Album Link Preview',
    qualityCaptions: 'Show Quality Info In Captions',
    codecConversion: 'Codec Conversion',
    fileNaming: 'File Naming',
    captions: 'Captions',
    syncKey: 'Sync ключ',
    apiUrl: 'API URL',
    downloadDirectory: 'Папка за сваляне',
    telegramMode: 'Telegram режим',
    save: 'Save Changes',
    openWeb: 'Отвори Web App',
    openTelegram: 'Отвори Telegram бота',
    ready: 'Готово.',
    working: 'Обработка...',
    updateRequired: 'Нужен е ъпдейт на приложението.',
  },
  en: {
    title: 'DyrakArmy Mobile',
    subtitle: 'Synced iOS/Android shell',
    download: 'Download',
    history: 'History',
    settings: 'Settings',
    searchInput: 'Paste URL or search text',
    queue: 'Queue Download',
    source: 'Source',
    format: 'Format',
    quality: 'Quality',
    queueEmpty: 'Queue is empty.',
    refreshHistory: 'Refresh History',
    historyEmpty: 'No jobs yet.',
    general: 'General',
    language: 'Language',
    defaultSearch: 'Default Search Service',
    resultView: 'Search Result View',
    audioQuality: 'Audio Quality',
    perServiceQuality: 'Per-Service Quality',
    downloads: 'Downloads',
    archiveUploads: 'Enable Archive Uploads',
    directLinks: 'Use Direct Links',
    spekZip: 'Spek ZIP For Tracks',
    albumPreview: 'Album Link Preview',
    qualityCaptions: 'Show Quality Info In Captions',
    codecConversion: 'Codec Conversion',
    fileNaming: 'File Naming',
    captions: 'Captions',
    syncKey: 'Sync key',
    apiUrl: 'API URL',
    downloadDirectory: 'Download directory',
    telegramMode: 'Telegram mode',
    save: 'Save Changes',
    openWeb: 'Open Web App',
    openTelegram: 'Open Telegram Bot',
    ready: 'Ready.',
    working: 'Working...',
    updateRequired: 'App update required.',
  },
  es: {
    title: 'DyrakArmy Mobile',
    subtitle: 'Shell iOS/Android sincronizado',
    download: 'Descargar',
    history: 'Historial',
    settings: 'Ajustes',
    searchInput: 'Pega URL o texto',
    queue: 'Poner en cola',
    source: 'Fuente',
    format: 'Formato',
    quality: 'Calidad',
    queueEmpty: 'La cola está vacía.',
    refreshHistory: 'Actualizar historial',
    historyEmpty: 'Sin tareas.',
    general: 'General',
    language: 'Idioma',
    defaultSearch: 'Servicio de búsqueda',
    resultView: 'Vista de resultados',
    audioQuality: 'Calidad de audio',
    perServiceQuality: 'Calidad por servicio',
    downloads: 'Descargas',
    archiveUploads: 'Subidas en archivo',
    directLinks: 'Usar enlaces directos',
    spekZip: 'Spek ZIP',
    albumPreview: 'Vista previa de álbum',
    qualityCaptions: 'Calidad en captions',
    codecConversion: 'Conversión de códec',
    fileNaming: 'Nombres de archivo',
    captions: 'Captions',
    syncKey: 'Clave Sync',
    apiUrl: 'API URL',
    downloadDirectory: 'Carpeta de descarga',
    telegramMode: 'Modo Telegram',
    save: 'Guardar cambios',
    openWeb: 'Abrir Web App',
    openTelegram: 'Abrir bot Telegram',
    ready: 'Listo.',
    working: 'Procesando...',
    updateRequired: 'Se requiere actualizar la app.',
  },
  ru: {
    title: 'DyrakArmy Mobile',
    subtitle: 'Синхронизированный iOS/Android shell',
    download: 'Скачать',
    history: 'История',
    settings: 'Настройки',
    searchInput: 'Вставьте URL или текст',
    queue: 'Добавить в очередь',
    source: 'Источник',
    format: 'Формат',
    quality: 'Качество',
    queueEmpty: 'Очередь пуста.',
    refreshHistory: 'Обновить историю',
    historyEmpty: 'Задач нет.',
    general: 'General',
    language: 'Язык',
    defaultSearch: 'Сервис поиска',
    resultView: 'Вид результатов',
    audioQuality: 'Качество аудио',
    perServiceQuality: 'Качество по сервисам',
    downloads: 'Загрузки',
    archiveUploads: 'Архивные загрузки',
    directLinks: 'Прямые ссылки',
    spekZip: 'Spek ZIP',
    albumPreview: 'Превью альбома',
    qualityCaptions: 'Качество в captions',
    codecConversion: 'Конвертация кодека',
    fileNaming: 'Имена файлов',
    captions: 'Captions',
    syncKey: 'Sync ключ',
    apiUrl: 'API URL',
    downloadDirectory: 'Папка загрузки',
    telegramMode: 'Telegram режим',
    save: 'Сохранить',
    openWeb: 'Открыть Web App',
    openTelegram: 'Открыть Telegram бот',
    ready: 'Готово.',
    working: 'Обработка...',
    updateRequired: 'Требуется обновление приложения.',
  },
  de: {
    title: 'DyrakArmy Mobile',
    subtitle: 'Synchronisierte iOS/Android Shell',
    download: 'Download',
    history: 'Verlauf',
    settings: 'Einstellungen',
    searchInput: 'URL oder Suchtext einfügen',
    queue: 'In Warteschlange',
    source: 'Quelle',
    format: 'Format',
    quality: 'Qualität',
    queueEmpty: 'Warteschlange ist leer.',
    refreshHistory: 'Verlauf aktualisieren',
    historyEmpty: 'Keine Aufgaben.',
    general: 'General',
    language: 'Sprache',
    defaultSearch: 'Suchdienst',
    resultView: 'Ergebnisansicht',
    audioQuality: 'Audioqualität',
    perServiceQuality: 'Qualität pro Dienst',
    downloads: 'Downloads',
    archiveUploads: 'Archiv-Uploads',
    directLinks: 'Direkte Links',
    spekZip: 'Spek ZIP',
    albumPreview: 'Album-Vorschau',
    qualityCaptions: 'Qualitätsinfos',
    codecConversion: 'Codec-Konvertierung',
    fileNaming: 'Dateinamen',
    captions: 'Captions',
    syncKey: 'Sync-Schlüssel',
    apiUrl: 'API URL',
    downloadDirectory: 'Download-Ordner',
    telegramMode: 'Telegram-Modus',
    save: 'Änderungen speichern',
    openWeb: 'Web App öffnen',
    openTelegram: 'Telegram Bot öffnen',
    ready: 'Bereit.',
    working: 'Verarbeitung...',
    updateRequired: 'App-Update erforderlich.',
  },
};

function normalizeBase(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return DEFAULT_API_BASE;
  const withScheme = value.startsWith('http://') || value.startsWith('https://') ? value : `https://${value}`;
  try {
    const parsed = new URL(withScheme);
    let path = parsed.pathname.replace(/\/+$/g, '');
    if (path.endsWith('/api')) path = path.slice(0, -4);
    return `${parsed.origin}${path}`;
  } catch {
    return DEFAULT_API_BASE;
  }
}

function normalizeLang(raw: string | null | undefined): Language {
  const value = String(raw || '').toLowerCase();
  if (value.startsWith('bg')) return 'bg';
  if (value.startsWith('es')) return 'es';
  if (value.startsWith('ru')) return 'ru';
  if (value.startsWith('de')) return 'de';
  return 'en';
}

function compareVersions(a: string, b: string): number {
  const parse = (value: string) => String(value || '0.0.0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] || 0) > (right[i] || 0)) return 1;
    if ((left[i] || 0) < (right[i] || 0)) return -1;
  }
  return 0;
}

function generateSyncKey(): string {
  return `sync_${Math.random().toString(36).slice(2, 18)}`;
}

function defaultSettings(): SettingsState {
  return {
    apiBase: DEFAULT_API_BASE,
    syncKey: generateSyncKey(),
    language: 'bg',
    source: 'spotify',
    format: 'mp3',
    quality: '320',
    audioProfile: 'hifi',
    resultView: 'message',
    archiveUploads: false,
    directLinks: false,
    spekZip: true,
    albumPreview: true,
    qualityCaptions: false,
    trackCover: true,
    albumCover: true,
    playlistTrackNumbers: false,
    playlistNameAsAlbum: false,
    downloadDirectory: '',
    telegramMode: 'bot',
    prefsRevision: 0,
    serviceQuality: {
      Amazon: 'FLAC (Ultra HD)',
      Apple: 'ALAC (Hi-Res)',
      Beatport: 'FLAC (CD)',
      Deezer: 'FLAC (CD)',
      Kkbox: 'FLAC (24b)',
      Qobuz: 'FLAC (Hi-Res)',
      Tidal: 'FLAC (Hi-Res)',
    },
    codecConversion: {
      aac: 'Original',
      alac: 'Original',
      flac: 'Original',
    },
  };
}

function qualityOptions(format: AudioFormat): AudioQuality[] {
  return LOSSLESS_FORMATS.has(format) ? LOSSLESS_QUALITIES : LOSSY_QUALITIES;
}

function detectSource(value: string): Source {
  const lower = value.toLowerCase();
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
  if (lower.includes('spotify.com')) {
    if (lower.includes('/show/') || lower.includes('/episode/')) return 'podcast';
    return 'spotify';
  }
  if (lower.includes('podcasts.apple.com') || lower.includes('/podcast/') || lower.includes('/show/')) return 'podcast';
  if (lower.includes('soundcloud.com')) return 'soundcloud';
  if (lower.includes('deezer.com')) return 'deezer';
  if (lower.includes('music.apple.com') || lower.includes('itunes.apple.com')) return 'apple';
  if (lower.includes('/feed') || lower.includes('rss') || lower.endsWith('.xml')) return 'podcast';
  return 'all';
}

function boolLabel(value: boolean): string {
  return value ? 'ON' : 'OFF';
}

export default function App() {
  const [settings, setSettings] = useState<SettingsState>(() => defaultSettings());
  const [tab, setTab] = useState<TabKey>('download');
  const [query, setQuery] = useState('');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [telegram, setTelegram] = useState({
    deepLink: 'https://t.me/dyrakarmy_bot',
    downloadLink: 'https://t.me/dyrakarmy_bot?start=download',
  });
  const [downloads, setDownloads] = useState({
    windows: `${DEFAULT_API_BASE}/downloads/DyrakArmyDesktop.exe`,
    mac: `${DEFAULT_API_BASE}/downloads/DyrakArmyDesktop-macOS.zip`,
    chrome: `${DEFAULT_API_BASE}/downloads/DyrakArmy-Extension-Chrome.zip`,
    firefox: `${DEFAULT_API_BASE}/downloads/DyrakArmy-Extension-Firefox.zip`,
  });
  const [updateUrl, setUpdateUrl] = useState('');
  const [blocked, setBlocked] = useState('');

  const tr = (key: string) => I18N[settings.language][key] || I18N.en[key] || key;
  const apiBase = normalizeBase(settings.apiBase);
  const qualityList = useMemo(() => qualityOptions(settings.format), [settings.format]);

  useEffect(() => {
    void hydrate();
  }, []);

  useEffect(() => {
    if (!qualityList.includes(settings.quality)) {
      patchSettings({ quality: qualityList[0] });
    }
  }, [qualityList, settings.quality]);

  async function hydrate() {
    let next = defaultSettings();
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) next = { ...next, ...JSON.parse(raw) };
    } catch {
      // local cache is optional
    }

    try {
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl) {
        const parsed = Linking.parse(initialUrl);
        const queryParams = parsed.queryParams || {};
        if (queryParams.sync) next.syncKey = String(queryParams.sync);
        if (queryParams.lang) next.language = normalizeLang(String(queryParams.lang));
        if (queryParams.api) next.apiBase = normalizeBase(String(queryParams.api));
      }
    } catch {
      // deep-link params are optional
    }

    setSettings(next);
    await loadRuntimeConfig(next);
    await syncRemotePreferences(next);
  }

  async function loadRuntimeConfig(baseSettings = settings) {
    const base = normalizeBase(baseSettings.apiBase);
    try {
      const cachedRaw = await AsyncStorage.getItem(RUNTIME_CACHE_KEY);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw) as { savedAt?: number; payload?: RuntimeConfig };
        if (cached.savedAt && Date.now() - cached.savedAt < RUNTIME_CACHE_TTL_MS && cached.payload) {
          applyRuntime(cached.payload, base);
          return;
        }
      }
    } catch {
      // ignore cache
    }

    try {
      const response = await fetch(`${base}/api/runtime-config`);
      const payload = await response.json() as RuntimeConfig;
      if (response.ok) {
        await AsyncStorage.setItem(RUNTIME_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), payload }));
        applyRuntime(payload, base);
      }
    } catch {
      // runtime config falls back to defaults
    }
  }

  function applyRuntime(config: RuntimeConfig, fallbackBase: string) {
    const base = normalizeBase(config.public_base || config.api_base || fallbackBase);
    const d = config.downloads || {};
    setDownloads({
      windows: d.windows_exe || `${base}/downloads/DyrakArmyDesktop.exe`,
      mac: d.macos_portable || `${base}/downloads/DyrakArmyDesktop-macOS.zip`,
      chrome: d.extension_chrome || `${base}/downloads/DyrakArmy-Extension-Chrome.zip`,
      firefox: d.extension_firefox || `${base}/downloads/DyrakArmy-Extension-Firefox.zip`,
    });
    if (config.telegram?.available && config.telegram.deep_link) {
      setTelegram({
        deepLink: config.telegram.deep_link,
        downloadLink: config.telegram.download_link || config.telegram.deep_link,
      });
    }
    const minVersion = config.client_min_versions?.mobile_expo || '0.0.0';
    if (compareVersions(APP_VERSION, minVersion) < 0) {
      setBlocked(`${tr('updateRequired')} Min: ${minVersion}`);
      setUpdateUrl(config.updates?.mobile_expo?.update_url || base);
    }
  }

  async function syncRemotePreferences(baseSettings = settings) {
    const base = normalizeBase(baseSettings.apiBase);
    try {
      const response = await fetch(`${base}/api/preferences?key=${encodeURIComponent(baseSettings.syncKey)}`);
      const payload = await response.json() as Partial<{
        language: Language;
        source: Source;
        format: AudioFormat;
        quality: AudioQuality;
        download_directory: string;
        telegram_link_mode: TelegramMode;
        revision: number;
      }>;
      if (!response.ok) return;
      setSettings((prev) => ({
        ...prev,
        language: payload.language ? normalizeLang(payload.language) : prev.language,
        source: payload.source && SOURCES.includes(payload.source) ? payload.source : prev.source,
        format: payload.format && FORMATS.includes(payload.format) ? payload.format : prev.format,
        quality: payload.quality || prev.quality,
        downloadDirectory: typeof payload.download_directory === 'string' ? payload.download_directory : prev.downloadDirectory,
        telegramMode: payload.telegram_link_mode === 'download' ? 'download' : prev.telegramMode,
        prefsRevision: Number.isFinite(payload.revision) ? Number(payload.revision) : prev.prefsRevision,
      }));
    } catch {
      // preference sync is best effort
    }
  }

  async function persist(next: SettingsState) {
    setSettings(next);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  function patchSettings(patch: Partial<SettingsState>) {
    const next = { ...settings, ...patch };
    void persist(next);
  }

  async function saveSettings() {
    setBusy(true);
    setStatus(tr('working'));
    const base = normalizeBase(settings.apiBase);
    try {
      const response = await fetch(`${base}/api/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: settings.syncKey,
          language: settings.language,
          source: settings.source,
          format: settings.format,
          quality: settings.quality,
          download_directory: settings.downloadDirectory,
          telegram_link_mode: settings.telegramMode,
          base_revision: settings.prefsRevision,
          client_updated_at: new Date().toISOString(),
          client_id: 'mobile_expo',
        }),
      });
      const payload = await response.json() as { revision?: number; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || `HTTP ${response.status}`);
      const next = { ...settings, prefsRevision: Number(payload.revision || settings.prefsRevision) };
      await persist(next);
      setStatus(`${tr('save')} ✓`);
    } catch (error) {
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function queueDownload() {
    const value = query.trim();
    if (!value) {
      setStatus(tr('searchInput'));
      return;
    }
    setBusy(true);
    setStatus(tr('working'));
    try {
      const source = settings.source === 'all' ? detectSource(value) : settings.source;
      const response = await fetch(`${apiBase}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: value,
          source,
          format: settings.format,
          quality: settings.quality,
          sync_key: settings.syncKey,
          client_id: 'mobile_expo',
        }),
      });
      const body = await response.json() as {
        jobId?: string;
        mobile_variant_job_id?: string | null;
        error?: { message?: string };
      };
      if (!response.ok || !body.jobId) throw new Error(body.error?.message || `HTTP ${response.status}`);
      const jobId = body.jobId;
      setQueue((prev) => [{ id: jobId, url: value, format: settings.format, quality: settings.quality, status: 'queued' }, ...prev].slice(0, 20));
      setStatus(body.mobile_variant_job_id
        ? `#${jobId.slice(0, 8)} queued + mobile MP3`
        : `#${jobId.slice(0, 8)} queued`);

      for (let i = 0; i < 90; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusResponse = await fetch(`${apiBase}/api/job/${encodeURIComponent(jobId)}`);
        const statusBody = await statusResponse.json() as {
          job?: { id: string; status: string; download_url?: string | null; error_message?: string | null };
        };
        const job = statusBody.job;
        if (!job) continue;
        setQueue((prev) => prev.map((item) => item.id === jobId ? {
          ...item,
          status: job.status,
          downloadUrl: job.download_url,
          error: job.error_message,
        } : item));
        if (job.status === 'done' || job.status === 'failed') {
          setStatus(job.status === 'done' ? 'Done ✓' : `Failed: ${job.error_message || 'unknown'}`);
          break;
        }
      }
    } catch (error) {
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadHistory() {
    setBusy(true);
    setStatus(tr('working'));
    try {
      const historyUrl = `${apiBase}/api/history?limit=25&offset=0&sync_key=${encodeURIComponent(settings.syncKey)}`;
      const response = await fetch(historyUrl);
      const body = await response.json() as { history?: HistoryItem[]; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
      setHistory(body.history || []);
      setStatus(`${tr('refreshHistory')} ✓`);
    } catch (error) {
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function openWebApp() {
    const url = `${apiBase}/?sync=${encodeURIComponent(settings.syncKey)}&lang=${settings.language}&client=mobile_expo&appver=${APP_VERSION}`;
    void Linking.openURL(url);
  }

  function openTelegram() {
    const url = settings.telegramMode === 'download' ? telegram.downloadLink : telegram.deepLink;
    void Linking.openURL(url);
  }

  return (
    <View style={styles.safe}>
      <StatusBar style="light" />
      <LinearGradient colors={['#1d2630', '#202a30', '#10151c']} style={styles.root}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <View style={styles.avatar}>
              <Text style={styles.avatarIcon}>DA</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text selectable style={styles.title}>{tr('title')}</Text>
              <Text selectable style={styles.subtitle}>{tr('subtitle')}</Text>
            </View>
            <Text style={styles.badge}>v{APP_VERSION}</Text>
          </View>

          {blocked ? (
            <Pressable style={styles.warning} onPress={() => updateUrl ? Linking.openURL(updateUrl) : undefined}>
              <Text selectable style={styles.warningText}>{blocked}</Text>
            </Pressable>
          ) : null}

          <View style={styles.tabRow}>
            {(['download', 'history', 'settings'] as TabKey[]).map((item) => (
              <Pressable key={item} style={[styles.tab, tab === item && styles.tabActive]} onPress={() => setTab(item)}>
                <Text style={[styles.tabText, tab === item && styles.tabTextActive]}>
                  {item === 'download' ? tr('download') : item === 'history' ? tr('history') : tr('settings')}
                </Text>
              </Pressable>
            ))}
          </View>

          {tab === 'download' ? (
            <Panel>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={tr('searchInput')}
                placeholderTextColor="#a8b0b7"
                style={styles.input}
                autoCapitalize="none"
              />
              <Selector title={tr('source')} values={SOURCES} selected={settings.source} onSelect={(v) => patchSettings({ source: v as Source })} />
              <Selector title={tr('format')} values={FORMATS.map((v) => v.toUpperCase())} selected={settings.format.toUpperCase()} onSelect={(v) => patchSettings({ format: v.toLowerCase() as AudioFormat })} />
              <Selector title={tr('quality')} values={qualityList} selected={settings.quality} onSelect={(v) => patchSettings({ quality: v as AudioQuality })} />
              <Pressable disabled={busy} onPress={queueDownload}>
                <LinearGradient colors={['#a88bdf', '#7ec7e7']} style={styles.primary}>
                  <Text style={styles.primaryText}>{tr('queue')}</Text>
                </LinearGradient>
              </Pressable>
            </Panel>
          ) : null}

          {tab === 'history' ? (
            <Panel>
              <Button label={tr('refreshHistory')} onPress={() => void loadHistory()} />
              {history.length === 0 ? <Text style={styles.meta}>{tr('historyEmpty')}</Text> : null}
              {history.map((item) => (
                <ListItem key={item.id} title={`${item.artist || 'Unknown'} - ${item.title || 'Track'}`} meta={`#${item.id.slice(0, 8)} | ${item.format} ${item.quality || ''} | ${item.status}`} link={item.download_url || undefined} error={item.error_message || undefined} />
              ))}
            </Panel>
          ) : null}

          {tab === 'settings' ? (
            <>
              <Panel title={tr('general')}>
                <ProfileCard syncKey={settings.syncKey} />
                <Selector title={`🌐 ${tr('language')}`} values={LANG_OPTIONS.map((l) => l.label)} selected={LANG_OPTIONS.find((l) => l.value === settings.language)?.label || '🇧🇬 BG'} onSelect={(label) => patchSettings({ language: LANG_OPTIONS.find((l) => l.label === label)?.value || 'bg' })} />
                <Selector title={`🔎 ${tr('defaultSearch')}`} values={SOURCES} selected={settings.source} onSelect={(v) => patchSettings({ source: v as Source })} />
                <Selector title={`🔮 ${tr('resultView')}`} values={['message', 'list', 'compact']} selected={settings.resultView} onSelect={(v) => patchSettings({ resultView: v as SettingsState['resultView'] })} />
              </Panel>

              <Panel title={tr('audioQuality')}>
                <Selector title={tr('audioQuality')} values={['low', 'high', 'lossless', 'hifi']} selected={settings.audioProfile} onSelect={(v) => patchSettings({ audioProfile: v as AudioProfile })} />
                <Text style={styles.sectionHint}>Per-Service Quality</Text>
                {SERVICE_QUALITY.map((service) => (
                  <InlineChoice key={service} label={service} value={settings.serviceQuality[service] || 'Original'} values={['Original', 'MP3 320', 'AAC 256', 'FLAC (CD)', 'FLAC (Hi-Res)', 'ALAC (Hi-Res)']} onSelect={(value) => patchSettings({ serviceQuality: { ...settings.serviceQuality, [service]: value } })} />
                ))}
              </Panel>

              <Panel title={tr('downloads')}>
                <ToggleRow label={tr('archiveUploads')} value={settings.archiveUploads} onPress={() => patchSettings({ archiveUploads: !settings.archiveUploads })} />
                <ToggleRow label={tr('directLinks')} value={settings.directLinks} onPress={() => patchSettings({ directLinks: !settings.directLinks })} />
                <ToggleRow label={tr('spekZip')} value={settings.spekZip} onPress={() => patchSettings({ spekZip: !settings.spekZip })} />
                <ToggleRow label={tr('albumPreview')} value={settings.albumPreview} onPress={() => patchSettings({ albumPreview: !settings.albumPreview })} />
                <ToggleRow label={tr('qualityCaptions')} value={settings.qualityCaptions} onPress={() => patchSettings({ qualityCaptions: !settings.qualityCaptions })} />
              </Panel>

              <Panel title={tr('codecConversion')}>
                <InlineChoice label="AAC in M4A" value={settings.codecConversion.aac} values={CODEC_OPTIONS} onSelect={(v) => patchSettings({ codecConversion: { ...settings.codecConversion, aac: v } })} />
                <InlineChoice label="ALAC in M4A" value={settings.codecConversion.alac} values={CODEC_OPTIONS} onSelect={(v) => patchSettings({ codecConversion: { ...settings.codecConversion, alac: v } })} />
                <InlineChoice label="FLAC" value={settings.codecConversion.flac} values={CODEC_OPTIONS} onSelect={(v) => patchSettings({ codecConversion: { ...settings.codecConversion, flac: v } })} />
              </Panel>

              <Panel title={tr('fileNaming')}>
                <ToggleRow label="Playlist Position Track Numbers" value={settings.playlistTrackNumbers} onPress={() => patchSettings({ playlistTrackNumbers: !settings.playlistTrackNumbers })} />
                <ToggleRow label="Playlist Name As Album" value={settings.playlistNameAsAlbum} onPress={() => patchSettings({ playlistNameAsAlbum: !settings.playlistNameAsAlbum })} />
              </Panel>

              <Panel title={tr('captions')}>
                <ToggleRow label="Track Cover Image" value={settings.trackCover} onPress={() => patchSettings({ trackCover: !settings.trackCover })} />
                <ToggleRow label="Album Cover Image" value={settings.albumCover} onPress={() => patchSettings({ albumCover: !settings.albumCover })} />
              </Panel>

              <Panel>
                <Text style={styles.label}>{tr('apiUrl')}</Text>
                <TextInput value={settings.apiBase} onChangeText={(apiBase) => patchSettings({ apiBase })} style={styles.input} autoCapitalize="none" />
                <Text style={styles.label}>{tr('syncKey')}</Text>
                <TextInput value={settings.syncKey} onChangeText={(syncKey) => patchSettings({ syncKey })} style={styles.input} autoCapitalize="none" />
                <Text style={styles.label}>{tr('downloadDirectory')}</Text>
                <TextInput value={settings.downloadDirectory} onChangeText={(downloadDirectory) => patchSettings({ downloadDirectory })} style={styles.input} autoCapitalize="none" />
                <Selector title={tr('telegramMode')} values={['bot', 'download']} selected={settings.telegramMode} onSelect={(v) => patchSettings({ telegramMode: v as TelegramMode })} />
                <Button label={tr('save')} onPress={() => void saveSettings()} filled />
                <Button label={tr('openWeb')} onPress={openWebApp} />
                <Button label={tr('openTelegram')} onPress={openTelegram} />
                <Button label="Windows EXE" onPress={() => void Linking.openURL(downloads.windows)} />
                <Button label="macOS Portable" onPress={() => void Linking.openURL(downloads.mac)} />
                <Button label="Chrome Extension" onPress={() => void Linking.openURL(downloads.chrome)} />
                <Button label="Firefox Extension" onPress={() => void Linking.openURL(downloads.firefox)} />
              </Panel>
            </>
          ) : null}

          <Panel>
            <Text selectable style={styles.status}>{busy ? tr('working') : status || tr('ready')}</Text>
            {busy ? <ActivityIndicator color="#a88bdf" style={{ marginTop: 10 }} /> : null}
            {queue.length === 0 ? <Text style={styles.meta}>{tr('queueEmpty')}</Text> : null}
            {queue.map((item) => (
              <ListItem key={item.id} title={item.url} meta={`#${item.id.slice(0, 8)} | ${item.format} ${item.quality} | ${item.status}`} link={item.downloadUrl || undefined} error={item.error || undefined} />
            ))}
          </Panel>
        </ScrollView>
      </LinearGradient>
    </View>
  );
}

function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <View style={styles.panel}>
      {title ? <Text style={styles.panelTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

function ProfileCard({ syncKey }: { syncKey: string }) {
  return (
    <View style={styles.profileCard}>
      <View style={styles.profileIcon}><Text style={styles.profileIconText}>👤</Text></View>
      <View>
        <Text selectable style={styles.profileTitle}>Sync ID: {syncKey.slice(0, 14)}</Text>
        <Text style={styles.profileMeta}>Plan: Free</Text>
      </View>
    </View>
  );
}

function Selector({ title, values, selected, onSelect }: { title: string; values: string[]; selected: string; onSelect: (value: string) => void }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.label}>{title}</Text>
      <View style={styles.wrapRow}>
        {values.map((value) => (
          <Pressable key={value} style={[styles.choice, selected === value && styles.choiceActive]} onPress={() => onSelect(value)}>
            <Text style={[styles.choiceText, selected === value && styles.choiceTextActive]}>{value}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function InlineChoice({ label, value, values, onSelect }: { label: string; value: string; values: string[]; onSelect: (value: string) => void }) {
  const currentIndex = Math.max(0, values.indexOf(value));
  const next = values[(currentIndex + 1) % values.length] || values[0];
  return (
    <Pressable style={styles.inlineRow} onPress={() => onSelect(next)}>
      <Text style={styles.inlineLabel}>{label}</Text>
      <Text style={styles.inlineValue}>{value} ▾</Text>
    </Pressable>
  );
}

function ToggleRow({ label, value, onPress }: { label: string; value: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.toggleRow} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <Text style={styles.inlineLabel}>{label}</Text>
        <Text style={styles.meta}>{boolLabel(value)}</Text>
      </View>
      <View style={[styles.switchTrack, value && styles.switchTrackOn]}>
        <View style={[styles.switchKnob, value && styles.switchKnobOn]} />
      </View>
    </Pressable>
  );
}

function Button({ label, onPress, filled }: { label: string; onPress: () => void; filled?: boolean }) {
  if (filled) {
    return (
      <Pressable onPress={onPress}>
        <LinearGradient colors={['#a88bdf', '#c4a6f2']} style={styles.buttonFilled}>
          <Text style={styles.buttonFilledText}>{label}</Text>
        </LinearGradient>
      </Pressable>
    );
  }
  return (
    <Pressable style={styles.button} onPress={onPress}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function ListItem({ title, meta, link, error }: { title: string; meta: string; link?: string; error?: string }) {
  return (
    <View style={styles.listItem}>
      <Text selectable style={styles.listTitle}>{title}</Text>
      <Text selectable style={styles.meta}>{meta}</Text>
      {link ? (
        <Pressable onPress={() => void Linking.openURL(link)}>
          <Text selectable style={styles.link}>{link}</Text>
        </Pressable>
      ) : null}
      {error ? <Text selectable style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#1d2630' },
  root: { flex: 1 },
  scroll: { padding: 14, paddingBottom: 34, gap: 12 },
  header: {
    borderRadius: 20,
    backgroundColor: '#252e35',
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: '#313d45',
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: '#35404a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarIcon: { color: '#c7b3ff', fontSize: 18, fontWeight: '900' },
  title: { color: '#ffffff', fontSize: 25, fontWeight: '900' },
  subtitle: { color: '#a7b0b7', marginTop: 3, fontSize: 13 },
  badge: {
    color: '#ffffff',
    backgroundColor: '#a88bdf',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    overflow: 'hidden',
    fontWeight: '800',
    fontSize: 12,
  },
  warning: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d98b8b',
    backgroundColor: '#44272a',
    padding: 12,
  },
  warningText: { color: '#ffd8d8', fontWeight: '800' },
  tabRow: { flexDirection: 'row', gap: 10 },
  tab: {
    flex: 1,
    borderRadius: 16,
    paddingVertical: 12,
    backgroundColor: '#242d34',
    borderWidth: 1,
    borderColor: '#303b43',
    alignItems: 'center',
  },
  tabActive: { backgroundColor: '#a88bdf', borderColor: '#c9b6f2' },
  tabText: { color: '#dce1e5', fontWeight: '800' },
  tabTextActive: { color: '#20272e' },
  panel: {
    backgroundColor: '#252e35',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#303a42',
    padding: 14,
  },
  panelTitle: {
    color: '#b79dff',
    fontSize: 22,
    fontWeight: '900',
    marginBottom: 14,
  },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#20282f',
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
  },
  profileIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#343c43',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileIconText: { fontSize: 26 },
  profileTitle: { color: '#ffffff', fontWeight: '900', fontSize: 16 },
  profileMeta: { color: '#adb5bc', marginTop: 4 },
  input: {
    backgroundColor: '#343c43',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#414c55',
    color: '#ffffff',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    marginBottom: 12,
  },
  label: { color: '#ffffff', fontSize: 15, fontWeight: '900', marginBottom: 8 },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: {
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#303b43',
    backgroundColor: '#20282f',
    paddingHorizontal: 13,
    paddingVertical: 10,
    minWidth: 84,
    alignItems: 'center',
  },
  choiceActive: { backgroundColor: '#a88bdf', borderColor: '#cbb6f8' },
  choiceText: { color: '#ffffff', fontWeight: '800' },
  choiceTextActive: { color: '#20272e' },
  primary: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryText: { color: '#182027', fontSize: 16, fontWeight: '900' },
  sectionHint: { color: '#aab2b8', marginBottom: 8, fontWeight: '800' },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#303a42',
  },
  inlineLabel: { flex: 1, color: '#ffffff', fontSize: 16, fontWeight: '900' },
  inlineValue: {
    color: '#ffffff',
    backgroundColor: '#343c43',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    overflow: 'hidden',
    fontWeight: '800',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    borderTopWidth: 1,
    borderTopColor: '#303a42',
  },
  switchTrack: {
    width: 56,
    height: 32,
    borderRadius: 999,
    backgroundColor: '#4a535a',
    padding: 3,
    justifyContent: 'center',
  },
  switchTrackOn: { backgroundColor: '#a88bdf' },
  switchKnob: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#f3f3f3',
  },
  switchKnobOn: { transform: [{ translateX: 24 }] },
  button: {
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#3f4b53',
    backgroundColor: '#20282f',
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: { color: '#ffffff', fontWeight: '900' },
  buttonFilled: {
    borderRadius: 13,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonFilledText: { color: '#20272e', fontWeight: '900' },
  status: {
    color: '#ffffff',
    backgroundColor: '#343c43',
    borderRadius: 10,
    padding: 10,
    overflow: 'hidden',
    fontWeight: '800',
  },
  listItem: {
    marginTop: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#303a42',
    backgroundColor: '#20282f',
    padding: 12,
  },
  listTitle: { color: '#ffffff', fontWeight: '900' },
  meta: { color: '#a7b0b7', marginTop: 4, lineHeight: 20 },
  link: { color: '#85d9ff', marginTop: 8, textDecorationLine: 'underline' },
  error: { color: '#ff9baf', marginTop: 8 },
});
