import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadRouter } from '../src/api';
import type { DownloadJob, Env, JobHistoryEvent } from '../src/types';

const JOB_ID = '11111111-1111-4111-8111-111111111111';

interface FakeJobRow {
  id: string;
  url?: string;
  source: string;
  format: string;
  quality: string;
  status: string;
  title: string;
  artist: string;
  duration?: number;
  file_size?: number;
  result_url?: string | null;
  r2_key?: string | null;
  fingerprint?: string;
  created_at?: string;
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
    if (this.sql.includes('COUNT(*) AS count') && this.sql.includes('FROM download_jobs j') && this.sql.includes('telegram_channel_publishes')) {
      const count = this.db.completedTelegramRows
        .filter((row) => this.db.channelPublishes.get(String(row.id))?.status !== 'published')
        .length;
      return { count } as T;
    }

    if (this.sql.includes('COUNT(*) AS total_links')) {
      return {
        total_links: this.db.workflowJobs.length,
        queued_count: this.db.workflowJobs.length,
        processing_count: 0,
        done_count: 0,
        failed_count: 0,
        deduped_count: 0,
      } as T;
    }

    if (this.sql.includes('SELECT control_state') && this.sql.includes('FROM playlist_workflows')) {
      const workflowId = String(this.values[0] ?? '');
      return { control_state: this.db.workflows.get(workflowId)?.control_state ?? 'active' } as T;
    }

    if (this.sql.includes('FROM download_jobs') && this.sql.includes('WHERE id = ?')) {
      const jobId = String(this.values[0] ?? '');
      return (this.db.jobs.get(jobId) ?? null) as T | null;
    }

    if (this.sql.includes('FROM download_jobs') && this.sql.includes('WHERE fingerprint = ?')) {
      return null;
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

    if (this.sql.includes('PRAGMA table_info(download_jobs)')) {
      return {
        results: [
          'parent_job_id',
          'variant_role',
          'sync_key',
          'playlist_folder',
          'playlist_index',
          'local_relpath',
        ].map((name) => ({ name })) as T[],
      };
    }
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

    if (this.sql.includes('INSERT INTO playlist_workflows')) {
      const workflowId = String(this.values[0] ?? '');
      this.db.workflows.set(workflowId, {
        workflow_id: workflowId,
        source_url: String(this.values[1] ?? ''),
        source: String(this.values[2] ?? ''),
        status: 'processing',
        phase: 'queued',
        total_tracks: 0,
        queued_count: 0,
        processing_count: 0,
        done_count: 0,
        failed_count: 0,
        deduped_count: 0,
        control_state: 'active',
      });
    }

    if (this.sql.includes('INSERT INTO download_jobs')) {
      const job: FakeJobRow = {
        id: String(this.values[0] ?? ''),
        url: String(this.values[1] ?? ''),
        source: String(this.values[2] ?? ''),
        format: String(this.values[3] ?? ''),
        quality: String(this.values[4] ?? ''),
        fingerprint: String(this.values[5] ?? ''),
        status: 'queued',
        title: String(this.values[14] ?? ''),
        artist: String(this.values[15] ?? ''),
        duration: 0,
        file_size: 0,
        result_url: null,
        r2_key: null,
        created_at: new Date().toISOString(),
      };
      this.db.jobs.set(job.id, job);
    }

    if (this.sql.includes('INSERT OR IGNORE INTO playlist_workflow_jobs')) {
      this.db.workflowJobs.push({
        workflow_id: String(this.values[0] ?? ''),
        job_id: String(this.values[1] ?? ''),
        is_deduped: Number(this.values[2] ?? 0),
      });
    }

    if (this.sql.includes('INSERT INTO telegram_channel_publishes')) {
      const jobId = String(this.values[0] ?? '');
      this.db.channelPublishes.set(jobId, {
        job_id: jobId,
        status: String(this.values[1] ?? ''),
        method: String(this.values[2] ?? ''),
        channel_id: String(this.values[3] ?? ''),
        attempts: 1,
        description: String(this.values[4] ?? ''),
      });
    }

    if (this.sql.includes('UPDATE playlist_workflows') && this.values.length >= 10) {
      const workflowId = String(this.values[9] ?? '');
      const row = this.db.workflows.get(workflowId);
      if (row) {
        row.status = String(this.values[0] ?? row.status);
        row.phase = String(this.values[1] ?? row.phase);
        row.total_tracks = Number(this.values[2] ?? row.total_tracks);
        row.queued_count = Number(this.values[3] ?? row.queued_count);
        row.processing_count = Number(this.values[4] ?? row.processing_count);
        row.done_count = Number(this.values[5] ?? row.done_count);
        row.failed_count = Number(this.values[6] ?? row.failed_count);
        row.deduped_count = Number(this.values[7] ?? row.deduped_count);
      }
    }

    return { success: true };
  }
}

class FakeD1 {
  jobs = new Map<string, FakeJobRow>();
  workflows = new Map<string, Record<string, unknown>>();
  workflowJobs: Array<{ workflow_id: string; job_id: string; is_deduped: number }> = [];
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
  vi.restoreAllMocks();
});

describe('share preview cards', () => {
  it('creates a share page and SVG card without creating a file download token', async () => {
    const { db, env } = createTestContext();
    db.jobs.set(JOB_ID, {
      id: JOB_ID,
      source: 'youtube',
      format: 'mp3',
      quality: '320',
      status: 'queued',
      title: 'One More Time',
      artist: 'Daft Punk',
      duration: 0,
      file_size: 0,
      result_url: null,
      r2_key: null,
      created_at: '2026-06-03T00:00:00Z',
    });

    const preview = await downloadRouter(new Request('https://dyrakarmy.online/api/share/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: JOB_ID }),
    }), env);
    expect(preview.status).toBe(200);
    const payload = await preview.json() as { share_url: string; card_image_url: string };
    expect(payload.share_url).toContain('/share/');
    expect(payload.card_image_url).toContain('/api/share/card/');

    const page = await downloadRouter(new Request(payload.share_url), env);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Type')).toContain('text/html');
    await expect(page.text()).resolves.toContain('og:title');

    const card = await downloadRouter(new Request(payload.card_image_url), env);
    expect(card.status).toBe(200);
    expect(card.headers.get('Content-Type')).toContain('image/svg+xml');
    await expect(card.text()).resolves.toContain('DyrakArmy');

    const pageHead = await downloadRouter(new Request(payload.share_url, { method: 'HEAD' }), env);
    expect(pageHead.status).toBe(200);
    expect(pageHead.headers.get('Content-Type')).toContain('text/html');

    const cardHead = await downloadRouter(new Request(payload.card_image_url, { method: 'HEAD' }), env);
    expect(cardHead.status).toBe(200);
    expect(cardHead.headers.get('Content-Type')).toContain('image/svg+xml');

    const token = payload.share_url.split('/share/')[1]!;
    const fileAttempt = await downloadRouter(new Request(`https://dyrakarmy.online/api/file/${token}`), env);
    expect(fileAttempt.status).not.toBe(200);
  });
});

describe('artist discography queue', () => {
  it('queues trusted yt-dlp search targets from downloader discography results', async () => {
    const { env, downloadQueue } = createTestContext();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/internal/artist/discography')) {
        return Response.json({
          title: 'Daft Punk Discography',
          source: 'artist',
          total: 1,
          tracks: [{
            id: 'mb-1',
            title: 'One More Time',
            artist: 'Daft Punk',
            duration: 320,
            source: 'youtube',
            url: 'ytsearch1:Daft Punk - One More Time audio',
          }],
        });
      }
      return Response.json({ ok: true });
    }));

    const response = await downloadRouter(new Request('https://dyrakarmy.online/api/artist/discography/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        artist: 'Daft Punk',
        source: 'spotify',
        format: 'mp3',
        quality: '320',
        sync_key: 'sync1234',
        limit: 1,
      }),
    }), env);

    expect(response.status).toBe(202);
    const payload = await response.json() as { queued: number; total: number; artist: string; job_ids: string[] };
    expect(payload.artist).toBe('Daft Punk');
    expect(payload.total).toBe(1);
    expect(payload.queued).toBe(1);
    expect(payload.job_ids).toHaveLength(1);
    expect(downloadQueue.messages).toHaveLength(1);
    expect(downloadQueue.messages[0]?.url).toBe('ytsearch1:Daft Punk - One More Time audio');
    expect(downloadQueue.messages[0]?.syncKey).toBe('sync1234');
  });
});

describe('ops Telegram channel endpoint', () => {
  it('requires an ops token before returning channel status', async () => {
    const { env } = createTestContext();

    const response = await downloadRouter(new Request('https://dyrakarmy.online/api/ops/telegram-channel'), env);

    expect(response.status).toBe(403);
  });

  it('returns channel publish status for viewer tokens', async () => {
    const { env, db } = createTestContext();
    db.channelPublishes.set('published-job', { status: 'published' });
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

    const response = await downloadRouter(new Request('https://dyrakarmy.online/api/ops/telegram-channel', {
      headers: { Authorization: 'Bearer read-token' },
    }), env);
    const payload = await response.json() as {
      telegram_channel: {
        channel_id: string;
        pending_backfill_count: number;
        publish_counts: Record<string, number>;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.telegram_channel.channel_id).toBe('-1003904304047');
    expect(payload.telegram_channel.pending_backfill_count).toBe(1);
    expect(payload.telegram_channel.publish_counts.published).toBe(1);
  });

  it('runs a manual channel backfill for admin tokens', async () => {
    const { env, db } = createTestContext();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      headers: { 'Content-Type': 'application/json' },
    })));
    db.completedTelegramRows.push({
      id: '00000000-0000-4000-8000-000000000099',
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

    const response = await downloadRouter(new Request('https://dyrakarmy.online/api/ops/telegram-channel/backfill', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limit: 5 }),
    }), env);
    const payload = await response.json() as { published: number };

    expect(response.status).toBe(200);
    expect(payload.published).toBe(1);
    expect(db.channelPublishes.get('00000000-0000-4000-8000-000000000099')?.status).toBe('published');
  });
});

function createTestContext(): {
  db: FakeD1;
  env: Env;
  downloadQueue: FakeQueue<DownloadJob>;
} {
  const db = new FakeD1();
  const kv = new MemoryKv();
  const downloadQueue = new FakeQueue<DownloadJob>();
  const historyQueue = new FakeQueue<JobHistoryEvent>();
  const env = {
    DB: db,
    CACHE: kv,
    DOWNLOAD_QUEUE: downloadQueue,
    HISTORY_QUEUE: historyQueue,
    ASSETS: { fetch: async () => new Response('asset') },
    DOWNLOADER_API_URL: 'https://downloader.test',
    DOWNLOADER_ORIGINS_JSON: '[{"base_url":"https://downloader.test","priority":0,"id":"test"}]',
    DOWNLOADER_API_KEY: 'test-key',
    DOWNLOAD_TOKEN_SECRET: 'download-secret',
    PUBLIC_BASE_URL: 'https://dyrakarmy.online',
    DOWNLOAD_DEDUPE_TTL_SECONDS: '120',
    SHARE_TOKEN_TTL_SECONDS: '3600',
    ARTIST_DISCOGRAPHY_MAX_TRACKS: '20',
    AUTO_MOBILE_VARIANT_ENABLED: '0',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_DOWNLOAD_CHANNEL_ID: 'https://t.me/boost?c=3904304047',
    TELEGRAM_CHANNEL_FORCE_BOT_DOWNLOADS: '1',
    OPS_READ_TOKEN: 'read-token',
    OPS_ADMIN_TOKEN: 'admin-token',
    DOWNLOAD_URL_ALLOWLIST: 'youtube.com,*.youtube.com,youtu.be,spotify.com,*.spotify.com',
    URL_BLOCKLIST: 'localhost,*.localhost',
  } as unknown as Env;
  return { db, env, downloadQueue };
}
