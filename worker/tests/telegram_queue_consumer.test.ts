import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import type { DownloadJob, Env, JobHistoryEvent } from '../src/types';

interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

interface StoredJob {
  id: string;
  status: string;
  source: string;
  format: string;
  quality: string;
  title: string | null;
  artist: string | null;
  duration: number | null;
  file_size: number | null;
  result_url: string | null;
  r2_key: string | null;
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

class FakeQueue<T> {
  messages: T[] = [];

  async send(message: T): Promise<void> {
    this.messages.push(message);
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
    if (this.sql.includes('SELECT status FROM download_jobs WHERE id = ?')) {
      const job = this.db.jobs.get(String(this.values[0] ?? ''));
      return job ? { status: job.status } as T : null;
    }

    if (this.sql.includes('FROM playlist_workflow_jobs')) {
      return null;
    }

    if (this.sql.includes('FROM user_preferences')) {
      return null;
    }

    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('PRAGMA table_info(playlist_workflows)')) {
      return {
        results: [
          'control_state',
          'archive_status',
          'archive_url',
          'archive_r2_key',
          'archive_error',
          'archive_finished_at',
        ].map((name) => ({ name })) as T[],
      };
    }

    return { results: [] };
  }

  async run(): Promise<{ success: boolean }> {
    this.db.runs.push({ sql: this.sql, values: this.values });

    if (this.sql.includes("SET status = 'processing'")) {
      const job = this.db.jobs.get(String(this.values[1] ?? ''));
      if (job) job.status = 'processing';
    }

    if (this.sql.includes("SET status = 'done'")) {
      const job = this.db.jobs.get(String(this.values[8] ?? ''));
      if (job) {
        job.status = 'done';
        job.source = String(this.values[0] ?? job.source);
        job.result_url = String(this.values[1] ?? '');
        job.r2_key = this.values[2] ? String(this.values[2]) : null;
        job.title = String(this.values[4] ?? '');
        job.artist = String(this.values[5] ?? '');
        job.duration = Number(this.values[6] ?? 0);
        job.file_size = Number(this.values[7] ?? 0);
      }
    }

    return { success: true };
  }
}

class FakeD1 {
  jobs = new Map<string, StoredJob>();
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

describe('Telegram queue completion publishing', () => {
  it('notifies the bot user, publishes the completed download to the channel, and emits sync history', async () => {
    const { env, db, historyQueue, calls } = createConsumerContext();
    const job = createTelegramDownloadJob();
    db.jobs.set(job.id, {
      id: job.id,
      status: 'queued',
      source: job.source,
      format: job.format,
      quality: job.quality,
      title: null,
      artist: null,
      duration: null,
      file_size: null,
      result_url: null,
      r2_key: null,
    });

    const message = {
      body: job,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const batch = {
      queue: 'sounddrop-downloads',
      messages: [message],
    };

    await worker.queue?.(batch as unknown as MessageBatch<DownloadJob>, env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(db.jobs.get(job.id)?.status).toBe('done');
    expect(db.jobs.get(job.id)?.title).toBe('Queue Track');
    expect(historyQueue.messages.some((event) => event.event === 'done' && event.jobId === job.id)).toBe(true);
    expect(calls.some((call) => call.method === 'editMessageText' && call.body.chat_id === 123)).toBe(true);
    expect(calls.some((call) => call.method === 'sendAudio' && call.body.chat_id === 123)).toBe(true);
    expect(calls.some((call) => call.method === 'sendAudio' && call.body.chat_id === '-1003904304047')).toBe(true);
    expect(env.CACHE.store.has('tg:last_channel_publish')).toBe(true);
  });
});

function createConsumerContext(): {
  env: Env & { CACHE: MemoryKv };
  db: FakeD1;
  historyQueue: FakeQueue<JobHistoryEvent>;
  calls: TelegramCall[];
} {
  const db = new FakeD1();
  const cache = new MemoryKv();
  const historyQueue = new FakeQueue<JobHistoryEvent>();
  const calls: TelegramCall[] = [];

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://downloader.example/internal/download') {
      return Response.json({
        download_url: 'https://files.example/queue-track.mp3',
        title: 'Queue Track',
        artist: 'Queue Artist',
        duration: 201,
        file_size: 1234567,
        source: 'youtube',
        mime_type: 'audio/mpeg',
        filename: 'queue-track.mp3',
      });
    }

    if (url.startsWith('https://api.telegram.org/bot')) {
      const method = url.split('/').pop() ?? 'unknown';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ method, body });
      return Response.json({ ok: true, result: { message_id: 42 } });
    }

    return new Response('not found', { status: 404 });
  }));

  const env = {
    CACHE: cache,
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    DOWNLOAD_QUEUE: new FakeQueue<DownloadJob>(),
    HISTORY_QUEUE: historyQueue,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_SECRET_TOKEN: 'test-secret',
    TELEGRAM_DOWNLOAD_CHANNEL_ID: '-1003904304047',
    TELEGRAM_CHANNEL_PUBLISH_ENABLED: '1',
    TELEGRAM_CHANNEL_FORCE_BOT_DOWNLOADS: '1',
    TELEGRAM_CHANNEL_SEND_AUDIO: '1',
    DOWNLOADER_API_URL: 'https://downloader.example',
    DOWNLOADER_API_KEY: 'downloader-secret',
    DOWNLOAD_TOKEN_SECRET: 'download-secret',
    PUBLIC_BASE_URL: 'https://dyrakarmy.online',
  } as unknown as Env & { CACHE: MemoryKv };

  return { env, db, historyQueue, calls };
}

function createTelegramDownloadJob(): DownloadJob {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    source: 'youtube',
    format: 'mp3',
    quality: '320',
    fingerprint: 'fp-telegram-queue',
    syncKey: 'tg_123',
    chatId: 123,
    messageId: 77,
    requestedAt: new Date().toISOString(),
  };
}
