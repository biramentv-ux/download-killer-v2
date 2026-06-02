import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleTelegramUpdate } from '../src/telegram';
import type { Env } from '../src/types';

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
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }

  async run(): Promise<{ success: boolean }> {
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

function createTelegramTestContext(): { env: Env; calls: TelegramCall[]; kv: MemoryKv } {
  const kv = new MemoryKv();
  const db = new FakeD1();
  const calls: TelegramCall[] = [];
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
  } as unknown as Env;

  return { env, calls, kv };
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
