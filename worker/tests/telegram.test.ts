import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleTelegramUpdate, publishTelegramChannelDownload } from '../src/telegram';
import type { DownloadJob, DownloaderDownloadResult, Env } from '../src/types';
import { createJobFingerprint } from '../src/utils';

interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
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
    if (this.sql.includes('FROM user_preferences')) {
      const key = String(this.values[0] ?? '');
      const payload = this.db.preferences.get(key);
      return payload ? { payload } as T : null;
    }
    if (this.sql.includes('FROM download_jobs') && this.sql.includes('fingerprint')) {
      const fingerprint = String(this.values[0] ?? '');
      return (this.db.completedJobs.get(fingerprint) ?? null) as T | null;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }

  async run(): Promise<{ success: boolean }> {
    this.db.runs.push({ sql: this.sql, values: this.values });
    if (this.sql.includes('user_preferences')) {
      const key = String(this.values[0] ?? '');
      const payload = String(this.values[1] ?? '');
      if (key && payload) this.db.preferences.set(key, payload);
    }
    return { success: true };
  }
}

class FakeD1 {
  preferences = new Map<string, string>();
  completedJobs = new Map<string, Record<string, unknown>>();
  runs: Array<{ sql: string; values: unknown[] }> = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
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
});

function createTelegramTestContext(): { env: Env; calls: TelegramCall[]; kv: MemoryKv; db: FakeD1; queueMessages: DownloadJob[] } {
  const kv = new MemoryKv();
  const db = new FakeD1();
  const calls: TelegramCall[] = [];
  const queueMessages: DownloadJob[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
