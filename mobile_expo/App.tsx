import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type Language = 'en' | 'bg';
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
  created_at?: string;
}

const DEFAULT_API_BASE = 'https://sounddrop.biramentv.workers.dev';
const STORAGE_KEY = 'sounddrop_mobile_settings_v1';
const SOURCES: Source[] = ['all', 'spotify', 'youtube', 'soundcloud', 'deezer', 'apple'];
const FORMATS: AudioFormat[] = ['mp3', 'm4a', 'ogg', 'opus', 'flac', 'wav'];
const LOSSLESS_FORMATS = new Set<AudioFormat>(['flac', 'wav']);
const LOSSLESS_QUALITIES: AudioQuality[] = ['lossless', 'best'];
const LOSSY_QUALITIES: AudioQuality[] = ['best', '320', '256', '192', '128', '96'];

const I18N: Record<Language, Record<string, string>> = {
  en: {
    title: 'SoundDrop Mobile',
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
    settings_save: 'Save settings',
    settings_open_web: 'Open Web App',
    settings_open_tg: 'Open Telegram',
    settings_win: 'Download Windows EXE',
    settings_mac: 'Download macOS Portable',
    settings_chrome: 'Download Chrome Extension',
    settings_firefox: 'Download Firefox Extension',
  },
  bg: {
    title: 'SoundDrop Mobile',
    subtitle: 'Retro Wave shell sync',
    tab_download: 'Сваляне',
    tab_history: 'История',
    tab_settings: 'Настройки',
    input_placeholder: 'Постави URL или текст за търсене',
    queue_btn: 'Добави за сваляне',
    queue_empty: 'Опашката е празна.',
    queue_wait: 'Изчакване на резултат...',
    status_idle: 'Готово.',
    status_loading: 'Обработка...',
    source: 'Източник',
    format: 'Формат',
    quality: 'Качество',
    history_load: 'Обнови история',
    history_empty: 'Няма задачи.',
    settings_sync: 'Sync ключ',
    settings_api: 'API URL',
    settings_lang: 'Език',
    settings_save: 'Запази настройки',
    settings_open_web: 'Отвори Web App',
    settings_open_tg: 'Отвори Telegram',
    settings_win: 'Свали Windows EXE',
    settings_mac: 'Свали macOS Portable',
    settings_chrome: 'Свали Chrome разширение',
    settings_firefox: 'Свали Firefox разширение',
  },
};

function normalizeLang(raw: string | null | undefined): Language {
  return String(raw || '').toLowerCase().startsWith('bg') ? 'bg' : 'en';
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

export default function App() {
  const [tab, setTab] = useState<TabKey>('download');
  const [lang, setLang] = useState<Language>('bg');
  const [syncKey, setSyncKey] = useState(generateSyncKey());
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [source, setSource] = useState<Source>('all');
  const [format, setFormat] = useState<AudioFormat>('mp3');
  const [quality, setQuality] = useState<AudioQuality>('320');
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('Ready.');
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [telegramUrl, setTelegramUrl] = useState('https://t.me/dyrakarmy_bot');

  const t = (key: string) => I18N[lang][key] ?? key;
  const currentQualityOptions = useMemo(() => qualityOptions(format), [format]);

  useEffect(() => {
    if (!currentQualityOptions.includes(quality)) {
      setQuality(currentQualityOptions[0]);
    }
  }, [currentQualityOptions, quality]);

  useEffect(() => {
    const hydrate = async () => {
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
          }>;
          if (parsed.lang) setLang(normalizeLang(parsed.lang));
          if (parsed.syncKey) setSyncKey(parsed.syncKey);
          if (parsed.apiBase) setApiBase(parsed.apiBase);
          if (parsed.source) setSource(parsed.source);
          if (parsed.format) setFormat(parsed.format);
          if (parsed.quality) setQuality(parsed.quality);
        }
      } catch {
        // ignore cached state failures
      }

      try {
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) {
          const parsed = Linking.parse(initialUrl);
          const query = parsed.queryParams ?? {};
          const qLang = query.lang ? normalizeLang(String(query.lang)) : null;
          const qSync = query.sync ? String(query.sync) : null;
          const qApi = query.api ? String(query.api) : null;
          if (qLang) setLang(qLang);
          if (qSync) setSyncKey(qSync);
          if (qApi) setApiBase(qApi);
        }
      } catch {
        // no deep link available
      }
    };

    void hydrate();
  }, []);

  const saveSettings = async () => {
    const payload = { lang, syncKey, apiBase, source, format, quality };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    try {
      await fetch(`${apiBase.replace(/\/+$/, '')}/api/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: syncKey, language: lang }),
      });
    } catch {
      // language sync is best-effort
    }
    setStatus(`${t('settings_save')} ✅`);
  };

  const queueDownload = async () => {
    const value = input.trim();
    if (!value) {
      setStatus(t('input_placeholder'));
      return;
    }
    const sourceValue = source === 'all' ? detectSource(value) : source;
    const normalizedBase = apiBase.replace(/\/+$/, '');
    setBusy(true);
    setStatus(t('status_loading'));
    try {
      const queuedResp = await fetch(`${normalizedBase}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: value,
          source: sourceValue,
          format,
          quality,
        }),
      });
      const queued = await queuedResp.json() as { jobId?: string; error?: { message?: string } };
      if (!queuedResp.ok || !queued.jobId) {
        throw new Error(queued?.error?.message || `HTTP ${queuedResp.status}`);
      }

      const queueItem: QueueItem = {
        id: queued.jobId,
        url: value,
        format,
        quality,
        status: 'queued',
      };
      setQueue((prev) => [queueItem, ...prev].slice(0, 20));
      setStatus(`${t('queue_wait')} #${queued.jobId.slice(0, 8)}`);

      const maxChecks = 60;
      for (let i = 0; i < maxChecks; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusResp = await fetch(`${normalizedBase}/api/job/${encodeURIComponent(queued.jobId)}`);
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
            item.id === queued.jobId
              ? { ...item, status: job.status, downloadUrl: job.download_url ?? null, error: job.error_message ?? null }
              : item,
          ),
        );

        if (job.status === 'done' || job.status === 'failed') {
          setStatus(job.status === 'done' ? '✅ Done' : `❌ ${job.error_message || 'Failed'}`);
          break;
        }
      }
    } catch (error) {
      setStatus(`❌ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const loadHistory = async () => {
    const normalizedBase = apiBase.replace(/\/+$/, '');
    setBusy(true);
    setStatus(t('status_loading'));
    try {
      const response = await fetch(`${normalizedBase}/api/history?limit=25&offset=0`);
      const body = await response.json() as { jobs?: HistoryItem[]; error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message || `HTTP ${response.status}`);
      }
      setHistory(body.jobs ?? []);
      setStatus(`${t('history_load')} ✅`);
    } catch (error) {
      setStatus(`❌ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const loadTelegramInfo = async () => {
    const normalizedBase = apiBase.replace(/\/+$/, '');
    try {
      const response = await fetch(`${normalizedBase}/api/telegram/info`);
      const body = await response.json() as { available?: boolean; deepLink?: string };
      if (response.ok && body.available && body.deepLink) {
        setTelegramUrl(body.deepLink);
      }
    } catch {
      // optional
    }
  };

  useEffect(() => {
    void loadTelegramInfo();
  }, [apiBase]);

  const openWebApp = () => {
    const normalizedBase = apiBase.replace(/\/+$/, '');
    const url = `${normalizedBase}/?sync=${encodeURIComponent(syncKey)}&lang=${encodeURIComponent(lang)}&client=mobile_expo`;
    void Linking.openURL(url);
  };

  const renderTabButton = (key: TabKey, label: string) => (
    <Pressable
      key={key}
      onPress={() => setTab(key)}
      style={[styles.tabBtn, tab === key ? styles.tabBtnActive : null]}
    >
      <Text style={[styles.tabBtnText, tab === key ? styles.tabBtnTextActive : null]}>{label}</Text>
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title}>{t('title')}</Text>
          <Text style={styles.subtitle}>{t('subtitle')}</Text>
        </View>

        <View style={styles.tabRow}>
          {renderTabButton('download', t('tab_download'))}
          {renderTabButton('history', t('tab_history'))}
          {renderTabButton('settings', t('tab_settings'))}
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {tab === 'download' && (
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
                    onPress={() => setSource(entry)}
                    style={[styles.chip, source === entry ? styles.chipActive : null]}
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
                    onPress={() => setFormat(entry)}
                    style={[styles.chip, format === entry ? styles.chipActive : null]}
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
                    onPress={() => setQuality(entry)}
                    style={[styles.chip, quality === entry ? styles.chipActive : null]}
                  >
                    <Text style={[styles.chipText, quality === entry ? styles.chipTextActive : null]}>{entry}</Text>
                  </Pressable>
                ))}
              </ScrollView>

              <Pressable style={styles.primaryBtn} onPress={queueDownload} disabled={busy}>
                <Text style={styles.primaryBtnText}>{t('queue_btn')}</Text>
              </Pressable>
            </View>
          )}

          {tab === 'history' && (
            <View style={styles.card}>
              <Pressable style={styles.secondaryBtn} onPress={loadHistory} disabled={busy}>
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
          )}

          {tab === 'settings' && (
            <View style={styles.card}>
              <Text style={styles.label}>{t('settings_api')}</Text>
              <TextInput value={apiBase} onChangeText={setApiBase} style={styles.input} autoCapitalize="none" />

              <Text style={styles.label}>{t('settings_sync')}</Text>
              <TextInput value={syncKey} onChangeText={setSyncKey} style={styles.input} autoCapitalize="none" />

              <Text style={styles.label}>{t('settings_lang')}</Text>
              <View style={styles.inlineRow}>
                <Pressable style={[styles.chip, lang === 'en' ? styles.chipActive : null]} onPress={() => setLang('en')}>
                  <Text style={[styles.chipText, lang === 'en' ? styles.chipTextActive : null]}>EN</Text>
                </Pressable>
                <Pressable style={[styles.chip, lang === 'bg' ? styles.chipActive : null]} onPress={() => setLang('bg')}>
                  <Text style={[styles.chipText, lang === 'bg' ? styles.chipTextActive : null]}>BG</Text>
                </Pressable>
              </View>

              <Pressable style={styles.secondaryBtn} onPress={() => void saveSettings()}>
                <Text style={styles.secondaryBtnText}>{t('settings_save')}</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={openWebApp}>
                <Text style={styles.secondaryBtnText}>{t('settings_open_web')}</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={() => void Linking.openURL(telegramUrl)}>
                <Text style={styles.secondaryBtnText}>{t('settings_open_tg')}</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={() => void Linking.openURL(`${apiBase.replace(/\/+$/, '')}/downloads/SoundDropDesktop.exe`)}>
                <Text style={styles.secondaryBtnText}>{t('settings_win')}</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={() => void Linking.openURL(`${apiBase.replace(/\/+$/, '')}/downloads/SoundDropDesktop-macOS.zip`)}>
                <Text style={styles.secondaryBtnText}>{t('settings_mac')}</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={() => void Linking.openURL(`${apiBase.replace(/\/+$/, '')}/downloads/SoundDrop-Extension-Chrome.zip`)}>
                <Text style={styles.secondaryBtnText}>{t('settings_chrome')}</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={() => void Linking.openURL(`${apiBase.replace(/\/+$/, '')}/downloads/SoundDrop-Extension-Firefox.zip`)}>
                <Text style={styles.secondaryBtnText}>{t('settings_firefox')}</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.statusText}>{busy ? `${t('status_loading')} ` : ''}{status || t('status_idle')}</Text>
            {busy ? <ActivityIndicator color="#59f0ff" style={{ marginTop: 10 }} /> : null}
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
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0a0217',
  },
  root: {
    flex: 1,
    backgroundColor: '#0a0217',
    paddingHorizontal: 14,
  },
  header: {
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ffe9ff',
  },
  subtitle: {
    marginTop: 4,
    color: '#d1a3f1',
    fontSize: 12,
  },
  tabRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(212,131,255,0.42)',
    backgroundColor: 'rgba(52,17,83,0.7)',
    alignItems: 'center',
  },
  tabBtnActive: {
    backgroundColor: '#ff47d6',
    borderColor: '#ffd8f6',
  },
  tabBtnText: {
    color: '#f0d3ff',
    fontWeight: '700',
    fontSize: 12,
  },
  tabBtnTextActive: {
    color: '#2a0328',
  },
  content: {
    paddingBottom: 28,
    gap: 10,
  },
  card: {
    borderWidth: 1,
    borderColor: 'rgba(255,132,228,0.26)',
    backgroundColor: 'rgba(37,11,62,0.68)',
    borderRadius: 14,
    padding: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: 'rgba(209,129,255,0.44)',
    borderRadius: 11,
    backgroundColor: 'rgba(23,9,40,0.88)',
    color: '#f9e9ff',
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 10,
  },
  label: {
    color: '#f6cbff',
    fontWeight: '700',
    marginBottom: 6,
    marginTop: 2,
    fontSize: 12,
  },
  chipsRow: {
    marginBottom: 10,
  },
  chip: {
    borderWidth: 1,
    borderColor: 'rgba(204,126,255,0.42)',
    borderRadius: 999,
    backgroundColor: 'rgba(52,17,83,0.68)',
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginRight: 8,
  },
  chipActive: {
    backgroundColor: '#61f2ff',
    borderColor: '#ffd7f5',
  },
  chipText: {
    color: '#f1d3ff',
    fontWeight: '700',
    fontSize: 12,
  },
  chipTextActive: {
    color: '#2b032a',
  },
  primaryBtn: {
    marginTop: 4,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#ff47d6',
    borderWidth: 1,
    borderColor: '#ffd7f5',
  },
  primaryBtnText: {
    color: '#2a0229',
    fontWeight: '800',
  },
  secondaryBtn: {
    borderRadius: 11,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(208,128,255,0.4)',
    backgroundColor: 'rgba(48,16,78,0.68)',
    marginBottom: 8,
  },
  secondaryBtnText: {
    color: '#ffe8ff',
    fontWeight: '700',
  },
  inlineRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  statusText: {
    color: '#ffd6f6',
    fontWeight: '700',
  },
  listCard: {
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,132,228,0.28)',
    backgroundColor: 'rgba(28,9,49,0.74)',
    padding: 10,
  },
  listTitle: {
    color: '#ffedf9',
    fontWeight: '700',
    fontSize: 12,
  },
  metaText: {
    color: '#d7b4f2',
    marginTop: 4,
    fontSize: 11,
  },
  linkText: {
    color: '#74f5ff',
    marginTop: 6,
    fontSize: 11,
  },
  errorText: {
    marginTop: 6,
    color: '#ff9eb8',
    fontSize: 11,
  },
});
