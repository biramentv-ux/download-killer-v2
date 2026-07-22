import { describe, expect, it } from 'vitest';
import { buildArchiveReconcileJob } from './telegram_archive_reconcile';

describe('Telegram historical archive reconciliation', () => {
  it('requeues an already completed job without creating a second identity', () => {
    const job = buildArchiveReconcileJob({
      id: 'job-history-1',
      url: 'https://archive.org/download/item/track.mp3',
      source: 'internet_archive',
      format: 'mp3',
      quality: 'best',
      fingerprint: 'fingerprint-1',
      parent_job_id: null,
      variant_role: null,
      sync_key: 'sync-user-1',
      playlist_folder: 'Archive',
      playlist_index: 3,
      local_relpath: 'Archive/track.mp3',
      chat_id: 123456,
      created_at: '2026-07-01T00:00:00.000Z',
    });
    expect(job.id).toBe('job-history-1');
    expect(job.fingerprint).toBe('fingerprint-1');
    expect(job.chatId).toBe(123456);
    expect(job.playlistIndex).toBe(3);
    expect(job.requestedAt).toBe('2026-07-01T00:00:00.000Z');
  });
});
