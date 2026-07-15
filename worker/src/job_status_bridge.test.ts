import { describe, expect, it } from 'vitest';
import { configuredJobStatusLimit, matchJobStatusRequest } from './job_status_bridge';
import type { Env } from './types';

describe('matchJobStatusRequest', () => {
  it('matches only the exact GET status route', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(matchJobStatusRequest(new Request(`https://dyrakarmy.eu/api/job/${id}`))).toBe(id);
    expect(matchJobStatusRequest(new Request(`https://dyrakarmy.eu/api/job/${id}/events`))).toBeNull();
    expect(matchJobStatusRequest(new Request(`https://dyrakarmy.eu/api/job/${id}`, { method: 'POST' }))).toBeNull();
  });
});

describe('configuredJobStatusLimit', () => {
  it('uses a practical default and clamps unsafe values', () => {
    expect(configuredJobStatusLimit({} as Env)).toBe(120);
    expect(configuredJobStatusLimit({ JOB_STATUS_RATE_LIMIT_PER_MINUTE: '5' } as Env)).toBe(30);
    expect(configuredJobStatusLimit({ JOB_STATUS_RATE_LIMIT_PER_MINUTE: '9999' } as Env)).toBe(600);
  });
});
