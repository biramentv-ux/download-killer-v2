import type { Env, JobHistoryEvent, JobStatus } from './types';

let historySchemaReady: Promise<void> | null = null;

export async function enqueueHistoryEvent(
  env: Env,
  input: {
    jobId: string;
    event: JobHistoryEvent['event'];
    status: JobStatus;
    source?: string;
    detail?: string;
  },
): Promise<void> {
  const event: JobHistoryEvent = {
    kind: 'history_event',
    id: crypto.randomUUID(),
    jobId: input.jobId,
    event: input.event,
    status: input.status,
    source: input.source,
    detail: input.detail?.slice(0, 1000),
    createdAt: new Date().toISOString(),
  };

  try {
    if (env.HISTORY_QUEUE) {
      await env.HISTORY_QUEUE.send(event);
      return;
    }
    await writeHistoryEvent(env, event);
  } catch (error) {
    console.warn('History event enqueue skipped', error);
  }
}

export async function processHistoryEventBatch(
  env: Env,
  events: JobHistoryEvent[],
): Promise<void> {
  if (!events.length) return;
  await ensureHistoryTable(env);
  const statements = events.map((event) => env.DB.prepare(
    `INSERT OR IGNORE INTO job_history_events (
       id, job_id, event, status, source, detail, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    event.id,
    event.jobId,
    event.event,
    event.status,
    event.source ?? null,
    event.detail ?? null,
    event.createdAt,
  ));
  await env.DB.batch(statements);
}

async function writeHistoryEvent(env: Env, event: JobHistoryEvent): Promise<void> {
  await processHistoryEventBatch(env, [event]);
}

async function ensureHistoryTable(env: Env): Promise<void> {
  if (historySchemaReady) {
    await historySchemaReady;
    return;
  }

  historySchemaReady = (async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS job_history_events (
        id         TEXT PRIMARY KEY,
        job_id     TEXT NOT NULL,
        event      TEXT NOT NULL,
        status     TEXT NOT NULL,
        source     TEXT,
        detail     TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_job_history_events_job_created ON job_history_events(job_id, created_at DESC)',
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_job_history_events_created ON job_history_events(created_at DESC)',
    ).run();
  })();

  try {
    await historySchemaReady;
  } finally {
    historySchemaReady = null;
  }
}
