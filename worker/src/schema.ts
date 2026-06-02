import type { Env } from './types';

let playlistWorkflowSchemaReady: Promise<void> | null = null;

export function ensurePlaylistWorkflowSchema(env: Env): Promise<void> {
  if (!playlistWorkflowSchemaReady) {
    playlistWorkflowSchemaReady = ensurePlaylistWorkflowSchemaInternal(env).catch((error) => {
      playlistWorkflowSchemaReady = null;
      throw error;
    });
  }
  return playlistWorkflowSchemaReady;
}

async function ensurePlaylistWorkflowSchemaInternal(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS playlist_workflows (
      workflow_id       TEXT PRIMARY KEY,
      source_url        TEXT NOT NULL,
      source            TEXT NOT NULL DEFAULT 'unknown',
      status            TEXT NOT NULL DEFAULT 'queued',
      phase             TEXT NOT NULL DEFAULT 'init',
      total_tracks      INTEGER NOT NULL DEFAULT 0,
      queued_count      INTEGER NOT NULL DEFAULT 0,
      processing_count  INTEGER NOT NULL DEFAULT 0,
      done_count        INTEGER NOT NULL DEFAULT 0,
      failed_count      INTEGER NOT NULL DEFAULT 0,
      deduped_count     INTEGER NOT NULL DEFAULT 0,
      control_state     TEXT NOT NULL DEFAULT 'active',
      archive_status    TEXT,
      archive_url       TEXT,
      archive_error     TEXT,
      archive_finished_at TEXT,
      error_code        TEXT,
      error_message     TEXT,
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at       TEXT
    )`,
  ).run();

  const info = await env.DB.prepare('PRAGMA table_info(playlist_workflows)').all<{ name: string }>();
  const existing = new Set((info.results ?? []).map((row) => row.name));
  const requiredColumns: Array<[string, string]> = [
    ['control_state', "TEXT NOT NULL DEFAULT 'active'"],
    ['archive_status', 'TEXT'],
    ['archive_url', 'TEXT'],
    ['archive_error', 'TEXT'],
    ['archive_finished_at', 'TEXT'],
  ];

  for (const [name, definition] of requiredColumns) {
    if (!existing.has(name)) {
      await env.DB.prepare(`ALTER TABLE playlist_workflows ADD COLUMN ${name} ${definition}`).run();
    }
  }

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS playlist_workflow_jobs (
      workflow_id  TEXT NOT NULL,
      job_id       TEXT NOT NULL,
      is_deduped   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workflow_id, job_id),
      FOREIGN KEY (workflow_id) REFERENCES playlist_workflows(workflow_id) ON DELETE CASCADE
    )`,
  ).run();

  await env.DB.batch([
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_playlist_workflows_status ON playlist_workflows(status)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_playlist_workflows_created ON playlist_workflows(created_at DESC)'),
    env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_playlist_workflow_jobs_workflow ON playlist_workflow_jobs(workflow_id)',
    ),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_playlist_workflow_jobs_job ON playlist_workflow_jobs(job_id)'),
  ]);
}
