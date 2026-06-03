import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  backfillTelegramChannelPublishes,
  getTelegramChannelPublishStatus,
  handleTelegramUpdate,
  notifyTelegramFailure,
  publishTelegramChannelDownload,
} from '../src/telegram';
import type { DownloadJob, DownloaderDownloadResult, Env } from '../src/types';
import { createJobFingerprint } from '../src/utils';

interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

interface TelegramTestOptions {
  archiveTracks?: Array<Record<string, unknown>>;
  archiveTotal?: number;
  preview?: Record<string, unknown>;
  archivePack?: Record<string, unknown>;
}

class MemoryKv {
  store = new Map<string, string>();

  async get(key: string, options?: { type?: 'json' }): Promise<unknown> {
    const value = this.store.get(key) ?? null;
    if (options?.type === 'json' && typeof value === 'string') return JSON.parse(value);
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

class FakeStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): FakeStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('COUNT(*) AS count') && this.sql.includes('FROM download_jobs j')) {
      const count = this.db.completedTelegramRows
        .filter((row) => this.db.channelPublishes.get(String(row.id))?.status !== 'published')
        .length;
      return { count } as T;
    }
    if (this.sql.includes('FROM user_preferences')) {
      const key = String(this.values[0] ?? '');
      const payload = this.db.preferences.get(key);
      return payload ? { payload } as T : null;
    }
    if (this.sql.includes('FROM download_jobs') && this.sql.includes('fingerprint')) {
      const fingerprint = String(this.values[0] ?? '');
      return (this.db.completedJobs.get(fingerprint) ?? null) as T | null;
    }
    if (this.sql.includes('FROM telegram_channel_publishes')) {
      const jobId = String(this.values[0] ?? '');
      return (this.db.channelPublishes.get(jobId) ?? null) as T | null;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('SELECT status, COUNT(*) AS count') && this.sql.includes('FROM telegram_channel_publishes')) {
      const counts = new Map<string, number>();
      for (const row of this.db.channelPublishes.values()) {
        const status = String(row.status ?? 'unknown');
        counts.set(status, (counts.get(status) ?? 0) + 1);
      }
      return { results: Array.from(counts.entries()).map(([status, count]) => ({ status, count })) as T[] };
    }
    if (this.sql.includes('FROM download_jobs j') && this.sql.includes('telegram_channel_publishes')) {
      return {
        results: this.db.completedTelegramRows
          .filter((row) => this.db.channelPublishes.get(String(row.id))?.status !== 'published') as T[],
      };
    }
    return { results: [] };
  }

  async run(): Promise<{ success: boolean }> {
    this.db.runs.push({ sql: this.sql, values: this.values });
    if (this.sql.includes('user_preferences')) {
      const key = String(this.values[0] ?? '');
      const payload = String(this.values[1] ?? '');
      if (key && payload) this.db.preferences.set(key, payload);
    }
    if (this.sql.includes('INSERT INTO telegram_channel_publishes')) {
      const jobId = String(this.values[0] ?? '');
      const current = this.db.channelPublishes.get(jobId);
      this.db.channelPublishes.set(jobId, {
        job_id: jobId,
        status: String(this.values[1] ?? ''),
        method: String(this.values[2] ?? ''),
        channel_id: String(this.values[3] ?? ''),
        attempts: Number(current?.attempts ?? 0) + 1,
        description: String(this.values[4] ?? ''),
      });
    }
    return { success: true };
  }
}

class FakeD1 {
  preferences = new Map<string, string>();
  completedJobs = new Map<string, Record<string, unknown>>();
  channelPublishes = new Map<string, Record<string, unknown>>();
  completedTelegramRows: Array<Record<string, unknown>> = [];
  runs: Array<{ sql: string; values: unknown[] }> = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<Array<{ success: boolean }>> {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Telegram callback format flow', () => {
  it('opens quality picker when a track format button is selected', async () => {
    const { env, calls } = createTelegramTestContext();

    await handleTelegramUpdate(telegramRequest({
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 123, type: 'private' },
        text: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      },
    }), env);

    const picker = calls.find((call) => call.method === 'sendMessage' && hasCallback(call.body, 'fmt:', 'flac'));
    expect(picker).toBeTruthy();
    const flacCallback = findCallback(picker!.body, 'fmt:', 'flac');
    expect(flacCallback).toBeTruthy();

    await handleTelegramUpdate(telegramRequest({
      update_id: 2,
      callback_query: {
        id: 'cb-format',
        from: { id: 123, first_name: 'Tester' },
        message: { message_id: 42, chat: { id: 123, type: 'private' } },
        data: flacCallback,
      },
    }), env);

    const answer = calls.find((call) => call.method === 'answerCallbackQuery' && call.body.callback_query_id === 'cb-format');
    expect(answer?.body.text).toBe('Формат: FLAC. Избери качество.');

    const edit = [...calls].reverse().find((call) => call.method === 'editMessageText');
    expect(edit).toBeTruthy();
    expect(hasCallback(edit!.body, `dl:${flacCallback!.split(':')[1]}:flac:`, 'lossless')).toBe(true);
  });

  it('persists settings format changes and keeps the user in the format panel', async () => {
    const { env, calls, kv } = createTelegramTestContext();

    await handleTelegramUpdate(telegramRequest({
      update_id: 3,
      callback_query: {
        id: 'cb-settings-format',
        from: { id: 123, first_name: 'Tester' },
        message: { message_id: 77, chat: { id: 123, type: 'private' } },
        data: 's:setfmt:flac',
      },
    }), env);

    const stored = JSON.parse(kv.store.get('tg:settings:123') ?? '{}') as { defaultFormat?: string; defaultQuality?: string };
    expect(stored.defaultFormat).toBe('flac');
    expect(stored.defaultQuality).toBe('lossless');

    const answer = calls.find((call) => call.method === 'answerCallbackQuery' && call.body.callback_query_id === 'cb-settings-format');
    expect(answer?.body.text).toBe('Форматът е сменен на FLAC.');

    const edit = [...calls].reverse().find((call) => call.method === 'editMessageText');
    expect(edit).toBeTruthy();
    const selectedFlac = allCallbackButtons(edit!.body).find((button) => button.callback_data === 's:setfmt:flac');
    expect(selectedFlac?.text).toContain('✅');
  });
});

describe('Telegram channel publishing', () => {
  it('captures a channel id from channel posts and publishes completed downloads there', async () => {
    const { env, calls, kv } = createTelegramTestContext();

    await handleTelegramUpdate(telegramRequest({
      update_id: 10,
      channel_post: {
        message_id: 501,
        chat: { id: -1001234567890, type: 'channel', title: 'DyrakArmy Downloads' },
        text: 'channel probe',
      },
    }), env);

    expect(kv.store.get('tg:download_channel_id')).toBe('-1001234567890');
    expect(kv.store.get('tg:download_channel_title')).toBe('DyrakArmy Downloads');

    const result = await publishTelegramChannelDownload(createDownloadJob(), createDownloadResult(), env);

    expect(result.ok).toBe(true);
    expect(result.method).toBe('sendAudio');
    const audio = calls.find((call) => call.method === 'sendAudio');
    expect(audio?.body.chat_id).toBe('-1001234567890');
    expect(kv.store.has('tg:last_channel_publish')).toBe(true);
  });

  it('captures a private channel from a forwarded post and shows channel status instead of treating it as a search', async () => {
    const { env, calls, kv } = createTelegramTestContext();

    await handleTelegramUpdate(telegramRequest({
      update_id: 11,
      message: {
        message_id: 77,
        chat: { id: 123, type: 'private' },
        text: 'forwarded post text',
        forward_origin: {
          type: 'channel',
          chat: { id: -1009876543210, type: 'channel', title: 'Private Downloads' },
          message_id: 9,
          date: 1710000000,
        },
      },
    }), env);

    expect(kv.store.get('tg:download_channel_id')).toBe('-1009876543210');
    expect(kv.store.get('tg:download_channel_title')).toBe('Private Downloads');
    expect(calls.some((call) => call.method === 'sendMessage' && String(call.body.text ?? '').includes('Telegram канал'))).toBe(true);
    expect(calls.some((call) => call.method === 'sendMessage' && String(call.body.text ?? '').includes('Търся:'))).toBe(false);
  });

  it('sends a manual test post from the channel settings callback', async () => {
    const { env, calls, kv } = createTelegramTestContext();
    await kv.put('tg:download_channel_id', '-1001234567890');

    await handleTelegramUpdate(telegramRequest({
      update_id: 12,
      callback_query: {
        id: 'cb-channel-test',
        from: { id: 123, first_name: 'Tester' },
        message: { message_id: 77, chat: { id: 123, type: 'private' } },
        data: 's:channel:test',
      },
    }), env);

    const channelMessage = calls.find((call) => call.method === 'sendMessage' && call.body.chat_id === '-1001234567890');
    expect(channelMessage?.body.text).toContain('DyrakArmy test publish');
    expect(kv.store.has('tg:last_channel_publish')).toBe(true);
  });

  it('normalizes a Telegram boost URL channel id from config', async () => {
    const { env, calls } = createTelegramTestContext();
    env.TELEGRAM_DOWNLOAD_CHANNEL_ID = 'https://t.me/boost?c=3904304047';

    const result = await publishTelegramChannelDownload(createDownloadJob(), createDownloadResult(), env);

    expect(result.ok).toBe(true);
    const audio = calls.find((call) => call.method === 'sendAudio');
    expect(audio?.body.chat_id).toBe('-1003904304047');
  });

  it('forces channel publishing for bot-origin downloads even when the user toggle is off', async () => {
    const { env, calls, kv } = createTelegramTestContext();
    env.TELEGRAM_DOWNLOAD_CHANNEL_ID = '-1003904304047';
    await kv.put('tg:settings:123', JSON.stringify({
      defaultFormat: 'mp3',
      defaultQuality: '320',
      defaultSource: 'all',
      language: 'bg',
      channelAutoPublish: false,
    }));

    const result = await publishTelegramChannelDownload(createDownloadJob(), createDownloadResult(), env);

    expect(result.ok).toBe(true);
    expect(result.method).toBe('sendAudio');
    expect(calls.some((call) => call.method === 'sendAudio' && call.body.chat_id === '-1003904304047')).toBe(true);
  });

  it('still honors the global channel publishing kill switch', async () => {
    const { env, calls } = createTelegramTestContext();
    env.TELEGRAM_CHANNEL_PUBLISH_ENABLED = '0';

    const result = await publishTelegramChannelDownload(createDownloadJob(), createDownloadResult(), env);

    expect(result.ok).toBe(true);
    expect(result.method).toBe('skipped');
    expect(calls.some((call) => call.method === 'sendAudio')).toBe(false);
  });

  it('does not publish the same Telegram-origin job twice after a successful channel publish', async () => {
    const { env, calls, db } = createTelegramTestContext();
    env.TELEGRAM_DOWNLOAD_CHANNEL_ID = '-1003904304047';

    const first = await publishTelegramChannelDownload(createDownloadJob(), createDownloadResult(), env);
    const second = await publishTelegramChannelDownload(createDownloadJob(), createDownloadResult(), env);

    expect(first.method).toBe('sendAudio');
    expect(second.method).toBe('skipped');
    expect(second.description).toBe('Already published');
    expect(calls.filter((call) => call.method === 'sendAudio' && call.body.chat_id === '-1003904304047')).toHaveLength(1);
    expect(db.channelPublishes.get('00000000-0000-4000-8000-000000000001')?.status).toBe('published');
  });

  it('backfills completed Telegram-origin jobs that missed channel publishing', async () => {
    const { env, calls, db } = createTelegramTestContext();
    env.TELEGRAM_DOWNLOAD_CHANNEL_ID = '-1003904304047';
    db.completedTelegramRows.push({
      id: '00000000-0000-4000-8000-000000000099',
      url: 'hashed-url',
      source: 'youtube',
      format: 'mp3',
      quality: '320',
      fingerprint: 'fp-backfill',
      chat_id: 123,
      message_id: 77,
      sync_key: 'tg_123',
      created_at: '2026-06-03T00:00:00Z',
      title: 'Backfill Track',
      artist: 'Backfill Artist',
      duration: 181,
      file_size: 123456,
      result_url: 'https://files.example/backfill.mp3',
    });

    const published = await backfillTelegramChannelPublishes(env, 10);

    expect(published).toBe(1);
    expect(calls.some((call) => call.method === 'sendAudio' && call.body.chat_id === '-1003904304047')).toBe(true);
    expect(db.channelPublishes.get('00000000-0000-4000-8000-000000000099')?.status).toBe('published');
  });

  it('reports Telegram channel publish status and pending backfill count', async () => {
    const { env, kv, db } = createTelegramTestContext();
    env.TELEGRAM_DOWNLOAD_CHANNEL_ID = 'https://t.me/boost?c=3904304047';
    await kv.put('tg:last_channel_publish', JSON.stringify({ ok: true, method: 'sendAudio' }));
    db.channelPublishes.set('published-job', { status: 'published' });
    db.channelPublishes.set('failed-job', { status: 'failed' });
    db.completedTelegramRows.push({
      id: 'pending-job',
      url: 'hashed-url',
      source: 'youtube',
      format: 'mp3',
      quality: '320',
      fingerprint: 'fp-pending',
      chat_id: 123,
      message_id: 77,
      sync_key: 'tg_123',
      created_at: '2026-06-03T00:00:00Z',
      title: 'Pending Track',
      artist: 'Pending Artist',
      duration: 181,
      file_size: 123456,
      result_url: 'https://files.example/pending.mp3',
    });

    const status = await getTelegramChannelPublishStatus(env);

    expect(status.channel_id).toBe('-1003904304047');
    expect(status.pending_backfill_count).toBe(1);
    expect(status.publish_counts.published).toBe(1);
    expect(status.publish_counts.failed).toBe(1);
    expect(status.last_publish?.method).toBe('sendAudio');
  });

  it('does not suggest cookie-based bypasses for Render YouTube bot-gate failures', async () => {
    const { env, calls } = createTelegramTestContext();

    await notifyTelegramFailure(
      createDownloadJob(),
      "Downloader API failed (502): Sign in to confirm you're not a bot",
      env,
    );

    const edit = calls.find((call) => call.method === 'editMessageText');
    const text = String(edit?.body.text ?? '');
    expect(text).toContain('Render origin');
    expect(text).toContain('shared/free host');
    expect(text).not.toContain('YTDLP_COOKIES');
    expect(text.toLowerCase()).not.toContain('cookies-from-browser');
  });

  it('captures forwarded channel media posts even when they have no text', async () => {
    const { env, calls, kv } = createTelegramTestContext();

    await handleTelegramUpdate(telegramRequest({
      update_id: 13,
      message: {
        message_id: 88,
        chat: { id: 123, type: 'private' },
        forward_origin: {
          type: 'channel',
          chat: { id: -1007778889990, type: 'channel', title: 'Media Channel' },
          message_id: 10,
          date: 1710000000,
        },
      },
    }), env);

    expect(kv.store.get('tg:download_channel_id')).toBe('-1007778889990');
    expect(kv.store.get('tg:download_channel_title')).toBe('Media Channel');
    expect(calls.some((call) => call.method === 'sendMessage' && String(call.body.text ?? '').includes('Telegram канал'))).toBe(true);
  });

  it('publishes to the channel when a bot download is served from an existing completed job', async () => {
    const { env, calls, kv, db } = createTelegramTestContext();
    await kv.put('tg:download_channel_id', '-1003904304047');
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const fingerprint = await createJobFingerprint(url, 'mp3', '320');
    db.completedJobs.set(fingerprint, {
      id: 'cached-job-1',
      title: 'Cached Track',
      artist: 'Cached Artist',
      duration: 181,
      file_size: 123456,
    });
    await kv.put('tg:url:ready', url);
    await kv.put('tg:result:ready', JSON.stringify({
      url,
      title: 'Cached Track',
      artist: 'Cached Artist',
      source: 'youtube',
      archive: false,
    }));

    await handleTelegramUpdate(telegramRequest({
      update_id: 14,
      callback_query: {
        id: 'cb-cached-download',
        from: { id: 123, first_name: 'Tester' },
        message: { message_id: 77, chat: { id: 123, type: 'private' } },
        data: 'dl:ready:mp3:320',
      },
    }), env);

    const audioCalls = calls.filter((call) => call.method === 'sendAudio');
    expect(audioCalls.some((call) => call.body.chat_id === 123)).toBe(true);
    expect(audioCalls.some((call) => call.body.chat_id === '-1003904304047')).toBe(true);
    expect(kv.store.has('tg:last_channel_publish')).toBe(true);
    const syncUpdate = db.runs.find((run) => run.sql.includes('UPDATE download_jobs') && run.sql.includes('sync_key'));
    expect(syncUpdate?.values).toEqual(['tg_123', 'cached-job-1']);
  });

  it('queues new bot downloads with the Telegram sync key for cross-platform history', async () => {
    const { env, kv, db, queueMessages } = createTelegramTestContext();
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    await kv.put('tg:url:ready', url);
    await kv.put('tg:result:ready', JSON.stringify({
      url,
      title: 'Queued Track',
      artist: 'Queued Artist',
      source: 'youtube',
      archive: false,
    }));

    await handleTelegramUpdate(telegramRequest({
      update_id: 15,
      callback_query: {
        id: 'cb-new-download',
        from: { id: 123, first_name: 'Tester' },
        message: { message_id: 77, chat: { id: 123, type: 'private' } },
        data: 'dl:ready:mp3:320',
      },
    }), env);

    const insert = db.runs.find((run) => run.sql.includes('INSERT INTO download_jobs') && run.sql.includes('sync_key'));
    expect(insert).toBeTruthy();
    expect(insert?.values[6]).toBe(123);
    expect(insert?.values[7]).toBe(77);
    expect(insert?.values[8]).toBe('tg_123');
    expect(queueMessages).toHaveLength(1);
    expect(queueMessages[0]).toMatchObject({
      url,
      source: 'youtube',
      format: 'mp3',
      quality: '320',
      syncKey: 'tg_123',
      chatId: 123,
      messageId: 77,
    });
  });

  it('renders server archive filenames instead of unknown fallback names', async () => {
    const { env, calls } = createTelegramTestContext({
      archiveTotal: 1341,
      archiveTracks: [
        {
          id: 'archive-track-1',
          kind: 'audio',
          filename: 'Audio Influenza - The Storm - RestlessLegsSound Remix.flac',
          size_bytes: 182455000,
          format: 'FLAC',
        },
      ],
    });

    await handleTelegramUpdate(telegramRequest({
      update_id: 16,
      message: {
        message_id: 88,
        chat: { id: 123, type: 'private' },
        text: '/archive',
      },
    }), env);

    const archiveMessage = calls.find((call) => call.method === 'sendMessage' && String(call.body.text ?? '').includes('Audio Influenza'));
    expect(archiveMessage).toBeTruthy();
    const text = String(archiveMessage?.body.text ?? '');
    expect(text).toContain('Audio Influenza - The Storm - RestlessLegsSound Remix');
    expect(text).not.toContain('\u041d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u0435\u043d - \u0411\u0435\u0437 \u0437\u0430\u0433\u043b\u0430\u0432\u0438\u0435');
  });

  it('sends direct archive files without queueing a new downloader job', async () => {
    const { env, calls, kv, queueMessages } = createTelegramTestContext();
    const archiveUrl = 'https://dyrakarmy.online/api/archive/file/archive-track-1';
    await kv.put('tg:url:archivekey', archiveUrl);
    await kv.put('tg:result:archivekey', JSON.stringify({
      url: archiveUrl,
      title: 'The Storm - RestlessLegsSound Remix',
      artist: 'Audio Influenza',
      source: 'archive',
      archive: true,
      directArchiveFile: true,
      archiveFileId: 'archive-track-1',
      duration: 469,
      fileSize: 182455000,
    }));

    await handleTelegramUpdate(telegramRequest({
      update_id: 17,
      callback_query: {
        id: 'cb-archive-download',
        from: { id: 123, first_name: 'Tester' },
        message: { message_id: 77, chat: { id: 123, type: 'private' } },
        data: 'dl:archivekey:mp3:320',
      },
    }), env);

    expect(queueMessages).toHaveLength(0);
    expect(calls.some((call) => call.method === 'sendAudio' && call.body.chat_id === 123 && call.body.audio === archiveUrl)).toBe(true);
  });

  it('shows archive action panel for URLs already present in the server archive', async () => {
    const archiveId = 'a'.repeat(64);
    const { env, calls, kv, queueMessages } = createTelegramTestContext({
      preview: {
        title: 'Inception',
        artist: 'Floree',
      },
      archiveTracks: [
        {
          id: archiveId,
          kind: 'audio',
          filename: 'Floree - Inception.flac',
          title: 'Inception',
          artist: 'Floree',
          duration: 222,
          size_bytes: 12345678,
          format: 'FLAC',
          stream_url: `/api/archive/file/${archiveId}`,
        },
      ],
    });

    await handleTelegramUpdate(telegramRequest({
      update_id: 18,
      message: {
        message_id: 89,
        chat: { id: 123, type: 'private' },
        text: 'https://open.spotify.com/track/5msPBVPfpNMt36L9hsPD0B',
      },
    }), env);

    const archiveMessage = calls.find((call) => (
      call.method === 'sendMessage'
      && String(call.body.text ?? '').includes('Floree - Inception')
    ));
    expect(archiveMessage).toBeTruthy();
    expect(queueMessages).toHaveLength(0);

    const buttons = allCallbackButtons(archiveMessage?.body ?? {});
    expect(buttons.some((button) => button.callback_data.startsWith('arch_audio:'))).toBe(true);
    expect(buttons.some((button) => button.callback_data.startsWith('arch_doc:'))).toBe(true);
    expect(buttons.some((button) => button.callback_data.startsWith('arch_sel:'))).toBe(true);
    expect(buttons.some((button) => button.callback_data.startsWith('fmt:'))).toBe(false);

    const resultKey = buttons.find((button) => button.callback_data.startsWith('arch_audio:'))?.callback_data.split(':')[1];
    expect(resultKey).toBeTruthy();
    const cached = await kv.get(`tg:result:${resultKey}`, { type: 'json' }) as Record<string, unknown> | null;
    expect(cached).toMatchObject({
      title: 'Inception',
      artist: 'Floree',
      archive: true,
      directArchiveFile: true,
      archiveFileId: archiveId,
    });
  });

  it('supports multi-select archive actions and pack creation for five selected files', async () => {
    const { env, calls, kv } = createTelegramTestContext({
      archivePack: {
        filename: 'telegram-selected-test.zip',
        file_size: 12345,
        file_count: 5,
        archive_format: 'zip',
        requested_format: '7z',
        fallback_used: true,
      },
    });
    const ids = ['a', 'b', 'c', 'd', 'e'].map((char) => char.repeat(64));

    for (let index = 0; index < ids.length; index += 1) {
      const key = `archive${index}`;
      const url = `https://dyrakarmy.online/api/archive/file/${ids[index]}`;
      await kv.put(`tg:url:${key}`, url);
      await kv.put(`tg:result:${key}`, JSON.stringify({
        url,
        title: `Track ${index + 1}`,
        artist: 'Archive Artist',
        source: 'archive',
        archive: true,
        directArchiveFile: true,
        archiveFileId: ids[index],
        duration: 180 + index,
        fileSize: 1000 + index,
        formatLabel: 'FLAC',
      }));

      await handleTelegramUpdate(telegramRequest({
        update_id: 30 + index,
        callback_query: {
          id: `cb-select-${index}`,
          from: { id: 123, first_name: 'Tester' },
          message: { message_id: 90, chat: { id: 123, type: 'private' } },
          data: `arch_sel:${key}`,
        },
      }), env);
    }

    await handleTelegramUpdate(telegramRequest({
      update_id: 40,
      callback_query: {
        id: 'cb-archive-list',
        from: { id: 123, first_name: 'Tester' },
        message: { message_id: 90, chat: { id: 123, type: 'private' } },
        data: 'arch_list',
      },
    }), env);

    const selectionPanel = calls.filter((call) => call.method === 'editMessageText').at(-1);
    expect(String(selectionPanel?.body.text ?? '')).toContain('Track 1');
    expect(hasCallback(selectionPanel?.body ?? {}, 'arch_each', '')).toBe(true);
    expect(hasCallback(selectionPanel?.body ?? {}, 'arch_pack_7z', '')).toBe(true);
    expect(hasCallback(selectionPanel?.body ?? {}, 'arch_pack_zip', '')).toBe(true);

    await handleTelegramUpdate(telegramRequest({
      update_id: 41,
      callback_query: {
        id: 'cb-archive-each',
        from: { id: 123, first_name: 'Tester' },
        message: { message_id: 90, chat: { id: 123, type: 'private' } },
        data: 'arch_each',
      },
    }), env);

    const sentDocuments = calls.filter((call) => (
      call.method === 'sendDocument'
      && String(call.body.document ?? '').includes('/api/archive/file/')
    ));
    expect(sentDocuments).toHaveLength(5);

    await handleTelegramUpdate(telegramRequest({
      update_id: 42,
      callback_query: {
        id: 'cb-archive-pack',
        from: { id: 123, first_name: 'Tester' },
        message: { message_id: 90, chat: { id: 123, type: 'private' } },
        data: 'arch_pack_7z',
      },
    }), env);

    expect(calls.some((call) => (
      call.method === 'sendDocument'
      && call.body.document === 'https://dyrakarmy.online/api/archive/packed/telegram-selected-test.zip'
    ))).toBe(true);
  });
});

function createTelegramTestContext(options: TelegramTestOptions = {}): { env: Env; calls: TelegramCall[]; kv: MemoryKv; db: FakeD1; queueMessages: DownloadJob[] } {
  const kv = new MemoryKv();
  const db = new FakeD1();
  const calls: TelegramCall[] = [];
  const queueMessages: DownloadJob[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/internal/archive/pack')) {
      return new Response(JSON.stringify(options.archivePack ?? {
        filename: 'telegram-selected.zip',
        file_size: 0,
        file_count: 0,
        archive_format: 'zip',
        requested_format: 'zip',
        fallback_used: false,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/internal/preview')) {
      return new Response(JSON.stringify(options.preview ?? {}), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/internal/archive')) {
      const tracks = options.archiveTracks ?? [];
      return new Response(JSON.stringify({ tracks, total: options.archiveTotal ?? tracks.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/internal/search')) {
      return new Response(JSON.stringify({ results: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const method = String(input).split('/').pop() ?? 'unknown';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }));

  const env = {
    CACHE: kv,
    DB: db,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_SECRET_TOKEN: 'test-secret',
    DOWNLOAD_TOKEN_SECRET: 'download-secret',
    DOWNLOADER_API_KEY: 'downloader-secret',
    DOWNLOADER_API_URL: 'https://downloader.example',
    PUBLIC_BASE_URL: 'https://dyrakarmy.online',
    DOWNLOAD_QUEUE: {
      send: vi.fn(async (job: DownloadJob) => {
        queueMessages.push(job);
      }),
    },
  } as unknown as Env;

  return { env, calls, kv, db, queueMessages };
}

function createDownloadJob(): DownloadJob {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    source: 'youtube',
    format: 'mp3',
    quality: '320',
    fingerprint: 'fp-channel-test',
    chatId: 123,
    messageId: 77,
    requestedAt: new Date().toISOString(),
  };
}

function createDownloadResult(): DownloaderDownloadResult {
  return {
    download_url: 'https://files.example/track.mp3',
    title: 'Track',
    artist: 'Artist',
    duration: 180,
    file_size: 1234567,
    source: 'youtube',
  };
}

function telegramRequest(payload: Record<string, unknown>): Request {
  return new Request('https://dyrakarmy.online/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'test-secret',
    },
    body: JSON.stringify(payload),
  });
}

function hasCallback(body: Record<string, unknown>, startsWith: string, includes: string): boolean {
  return allCallbackButtons(body).some((button) => button.callback_data.startsWith(startsWith) && button.callback_data.includes(includes));
}

function findCallback(body: Record<string, unknown>, startsWith: string, includes: string): string | undefined {
  return allCallbackButtons(body).find((button) => button.callback_data.startsWith(startsWith) && button.callback_data.includes(includes))?.callback_data;
}

function allCallbackButtons(body: Record<string, unknown>): Array<{ text: string; callback_data: string }> {
  const replyMarkup = body.reply_markup as { inline_keyboard?: Array<Array<Record<string, unknown>>> } | undefined;
  return (replyMarkup?.inline_keyboard ?? [])
    .flat()
    .filter((button): button is { text: string; callback_data: string } => (
      typeof button.text === 'string' && typeof button.callback_data === 'string'
    ));
}
