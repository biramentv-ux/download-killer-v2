import { ensureDeadLetterSchema, ensureDownloadJobMetadataSchema, ensurePlaylistWorkflowSchema } from './schema';
import type { Env } from './types';
import { readEnvInt } from './utils';

export interface RetentionCleanupResult {
  skipped: boolean;
  cutoff_days: number;
  jobs_scanned: number;
  jobs_deleted: number;
  workflows_scanned: number;
  workflows_deleted: number;
  r2_keys_scanned: number;
  r2_keys_deleted: number;
  r2_keys_failed: number;
}

interface OldJobRow {
  id: string;
  r2_key: string | null;
}

interface OldWorkflowRow {
  workflow_id: string;
  archive_r2_key: string | null;
}

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_RETENTION_BATCH_SIZE = 100;

export function shouldRunRetentionCleanup(cron: string | undefined): boolean {
  const value = String(cron ?? '').trim();
  if (!value) return false;
  return /^\d+\s+\d+\s+\*\s+\*\s+\*$/.test(value);
}

export async function cleanupExpiredJobsAndFiles(env: Env): Promise<RetentionCleanupResult> {
  const days = readEnvInt(env.JOB_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const batchSize = Math.min(500, readEnvInt(env.JOB_RETENTION_BATCH_SIZE, DEFAULT_RETENTION_BATCH_SIZE));
  const result: RetentionCleanupResult = {
    skipped: env.JOB_RETENTION_ENABLED === '0',
    cutoff_days: days,
    jobs_scanned: 0,
    jobs_deleted: 0,
    workflows_scanned: 0,
    workflows_deleted: 0,
    r2_keys_scanned: 0,
    r2_keys_deleted: 0,
    r2_keys_failed: 0,
  };

  if (result.skipped) return result;

  await ensureDownloadJobMetadataSchema(env);
  await ensurePlaylistWorkflowSchema(env);
  await ensureDeadLetterSchema(env);

  const cutoffModifier = `-${days} days`;
  const oldJobs = await env.DB.prepare(
    `SELECT id, r2_key
     FROM download_jobs
     WHERE status IN ('done', 'failed')
       AND datetime(created_at) < datetime('now', ?)
     ORDER BY created_at ASC
     LIMIT ?`,
  ).bind(cutoffModifier, batchSize).all<OldJobRow>();
  const jobs = oldJobs.results ?? [];
  result.jobs_scanned = jobs.length;

  const oldWorkflows = await env.DB.prepare(
    `SELECT workflow_id, archive_r2_key
     FROM playlist_workflows
     WHERE status IN ('done', 'failed')
       AND datetime(created_at) < datetime('now', ?)
     ORDER BY created_at ASC
     LIMIT ?`,
  ).bind(cutoffModifier, batchSize).all<OldWorkflowRow>();
  const workflows = oldWorkflows.results ?? [];
  result.workflows_scanned = workflows.length;

  const r2Keys = new Set<string>();
  for (const row of jobs) {
    if (row.r2_key) r2Keys.add(row.r2_key);
  }
  for (const row of workflows) {
    if (row.archive_r2_key) r2Keys.add(row.archive_r2_key);
  }

  if (jobs.length > 0) {
    const jobIds = jobs.map((row) => row.id);
    await deleteByIds(env, 'job_history_events', 'job_id', jobIds);
    await deleteByIds(env, 'shared_queue_items', 'job_id', jobIds);
    await deleteByIds(env, 'playlist_workflow_jobs', 'job_id', jobIds);
    await deleteByIds(env, 'dead_letter_jobs', 'job_id', jobIds);
    result.jobs_deleted = await deleteByIds(env, 'download_jobs', 'id', jobIds);
  }

  if (workflows.length > 0) {
    const workflowIds = workflows.map((row) => row.workflow_id);
    await deleteByIds(env, 'playlist_workflow_jobs', 'workflow_id', workflowIds);
    result.workflows_deleted = await deleteByIds(env, 'playlist_workflows', 'workflow_id', workflowIds);
  }

  await env.DB.prepare(
    `DELETE FROM dead_letter_jobs
     WHERE datetime(created_at) < datetime('now', ?)`,
  ).bind(cutoffModifier).run();

  result.r2_keys_scanned = r2Keys.size;
  if (!env.FILES || r2Keys.size === 0) return result;

  for (const key of r2Keys) {
    try {
      const jobRef = await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM download_jobs WHERE r2_key = ?',
      ).bind(key).first<{ count: number }>();
      const workflowRef = await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM playlist_workflows WHERE archive_r2_key = ?',
      ).bind(key).first<{ count: number }>();

      if ((jobRef?.count ?? 0) === 0 && (workflowRef?.count ?? 0) === 0) {
        await env.FILES.delete(key);
        result.r2_keys_deleted += 1;
      }
    } catch (error) {
      result.r2_keys_failed += 1;
      console.warn(`Retention cleanup failed for R2 key ${key}`, error);
    }
  }

  return result;
}

async function deleteByIds(env: Env, table: string, column: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  let deleted = 0;
  for (const chunk of chunkArray(ids, 50)) {
    const placeholders = chunk.map(() => '?').join(',');
    const statement = await env.DB.prepare(
      `DELETE FROM ${table} WHERE ${column} IN (${placeholders})`,
    ).bind(...chunk).run();
    deleted += Number(statement.meta?.changes ?? chunk.length);
  }
  return deleted;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
