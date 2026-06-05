import type { AudioFormat, AudioQuality, Env } from './types';
import { getClientAddress, jsonError, jsonOk, parseJson, rateLimit } from './utils';

export interface QualityScore {
  total: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  breakdown: {
    thumbnail: number;
    tags: number;
    audio: number;
    cleanliness: number;
  };
  issues: string[];
  suggestions: string[];
  scoredAt: string;
}

interface ScoreJobBody {
  jobId?: string;
  job_id?: string;
}

interface JobMetadata {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  release_year: string | null;
  track_number: number | null;
  format: AudioFormat | string;
  quality: AudioQuality | string;
  file_size: number | null;
  duration: number | null;
  thumbnail_url: string | null;
  status: string;
}

interface QualitySummaryRow {
  avg_score: number | null;
  min_score: number | null;
  max_score: number | null;
  total: number;
  grade_a: number;
  grade_b: number;
  grade_c: number;
  grade_d: number;
  grade_f: number;
}

const GARBAGE_PATTERNS = [
  /\(official (video|audio|music video|lyric video)\)/i,
  /\[official\]/i,
  /\(hd\)/i,
  /\(4k\)/i,
  /\bvevo\b/i,
  /\(topic\)/i,
  /\blyrics?\b/i,
  /[\[\(].*?[\]\)]/g,
];

export function calculateQualityScore(job: JobMetadata): QualityScore {
  const issues: string[] = [];
  const suggestions: string[] = [];
  let thumbnail = 0;
  let tags = 0;
  let audio = 0;
  let cleanliness = 15;

  const artwork = job.thumbnail_url?.trim() ?? '';
  if (!artwork) {
    issues.push('No album artwork');
    suggestions.push('Re-download with a source that provides artwork');
  } else if (/maxresdefault|1500|original|hq720|sddefault/i.test(artwork)) {
    thumbnail = 25;
  } else if (/mqdefault|medium|640/i.test(artwork)) {
    thumbnail = 20;
    suggestions.push('Artwork may be medium resolution; fetch higher-resolution artwork when available');
  } else {
    thumbnail = 15;
    suggestions.push('Consider fetching higher-resolution artwork');
  }

  const tagWeights: Array<[keyof JobMetadata, number, string, string]> = [
    ['title', 10, 'Track title is missing', 'Add title metadata'],
    ['artist', 10, 'Artist name is missing', 'Add artist metadata'],
    ['album', 7, 'Album name is missing', 'Add album metadata'],
    ['release_year', 4, 'Release year is missing', 'Add release year metadata'],
    ['genre', 2, 'Genre tag is missing', 'Add genre metadata'],
    ['track_number', 2, 'Track number is missing', 'Add track number metadata'],
  ];
  for (const [field, points, issue, suggestion] of tagWeights) {
    const value = job[field];
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      tags += points;
    } else {
      issues.push(issue);
      suggestions.push(suggestion);
    }
  }

  const qualityNum = Number.parseInt(String(job.quality ?? ''), 10) || 0;
  const format = String(job.format ?? '').trim().toLowerCase();
  if (['flac', 'wav', 'aiff'].includes(format)) {
    audio = 25;
  } else if (format === 'opus' || format === 'ogg') {
    audio = qualityNum >= 256 ? 23 : qualityNum >= 128 ? 18 : 12;
    if (qualityNum > 0 && qualityNum < 128) {
      issues.push(`${format.toUpperCase()} ${qualityNum}kbps is low quality`);
      suggestions.push('Use at least 256kbps for transparent lossy audio');
    }
  } else if (format === 'mp3') {
    audio = qualityNum >= 320 ? 20 : qualityNum >= 256 ? 16 : qualityNum >= 192 ? 12 : 6;
    if (qualityNum < 192) {
      issues.push(`MP3 ${qualityNum || 'unknown'}kbps is low quality`);
      suggestions.push('Use MP3 320kbps or switch to FLAC/WAV');
    } else if (qualityNum < 320) {
      suggestions.push('Consider MP3 320kbps or FLAC for better quality');
    }
  } else if (['m4a', 'aac'].includes(format)) {
    audio = qualityNum >= 256 ? 22 : qualityNum >= 128 ? 16 : 10;
  } else {
    audio = 10;
    issues.push(`Unknown format: ${format || 'empty'}`);
  }

  if (!job.duration || job.duration < 10) {
    audio = Math.max(0, audio - 5);
    issues.push('Track duration seems too short; possible incomplete download');
    suggestions.push('Verify the file plays correctly from start to end');
  }

  if (job.duration && job.file_size && qualityNum > 0 && !['flac', 'wav', 'aiff'].includes(format)) {
    const expectedBytes = (qualityNum * 1000 / 8) * job.duration;
    const ratio = expectedBytes > 0 ? job.file_size / expectedBytes : 1;
    if (ratio < 0.5) {
      audio = Math.max(0, audio - 5);
      issues.push('File size is much smaller than expected for declared bitrate');
      suggestions.push('Actual bitrate may be lower than declared');
    }
  }

  const title = job.title ?? '';
  for (const pattern of GARBAGE_PATTERNS) {
    const match = title.match(pattern)?.[0];
    if (match) {
      cleanliness -= 4;
      issues.push(`Title contains noise: ${match}`);
      suggestions.push('Clean title by removing official video, HD, lyrics and bracket noise');
      break;
    }
  }

  if (job.artist && /vevo|official|music$/i.test(job.artist)) {
    cleanliness -= 5;
    issues.push('Artist name may be a channel name, not the actual artist');
    suggestions.push('Correct artist name metadata');
  }

  if (title.length > 3 && (title === title.toUpperCase() || title === title.toLowerCase())) {
    cleanliness -= 2;
    issues.push('Title is all-caps or all-lowercase');
    suggestions.push('Use proper title case for better organization');
  }
  cleanliness = Math.max(0, cleanliness);

  const total = Math.min(100, thumbnail + tags + audio + cleanliness);
  const grade = total >= 90 ? 'A' : total >= 75 ? 'B' : total >= 60 ? 'C' : total >= 40 ? 'D' : 'F';
  return {
    total,
    grade,
    breakdown: { thumbnail, tags, audio, cleanliness },
    issues: [...new Set(issues)],
    suggestions: [...new Set(suggestions)],
    scoredAt: new Date().toISOString(),
  };
}

export async function handleScoreJob(request: Request, env: Env): Promise<Response> {
  const ip = getClientAddress(request);
  const rl = await rateLimit(env.CACHE, `quality-score:${ip}`, 20, 60);
  if (rl.limited) {
    return jsonError(request, env, 'RATE_LIMITED', 'Too many quality score requests', 429, true);
  }

  const body = await parseJson<ScoreJobBody>(request);
  const jobId = String(body?.jobId ?? body?.job_id ?? '').trim();
  if (!jobId) return jsonError(request, env, 'INVALID_JOB_ID', 'jobId is required', 400);

  const job = await readQualityJob(env, jobId);
  if (!job) return jsonError(request, env, 'JOB_NOT_FOUND', 'Job not found', 404);
  if (job.status !== 'done') return jsonError(request, env, 'JOB_NOT_DONE', 'Job must be completed before scoring', 409, true);

  const score = calculateQualityScore(job);
  await writeQualityScore(env, jobId, score);

  return jsonOk(request, env, { job_id: jobId, score });
}

export async function handleGetScore(request: Request, env: Env, jobId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, quality_score, quality_grade, quality_details
     FROM download_jobs
     WHERE id = ?`,
  ).bind(jobId).first<{
    id: string;
    quality_score: number | null;
    quality_grade: QualityScore['grade'] | null;
    quality_details: string | null;
  }>();

  if (!row) return jsonError(request, env, 'JOB_NOT_FOUND', 'Job not found', 404);
  if (row.quality_score === null || row.quality_score === undefined) {
    return jsonError(request, env, 'QUALITY_NOT_SCORED', 'Not yet scored. POST /api/quality/score first.', 404, true);
  }

  return jsonOk(request, env, {
    job_id: row.id,
    score: row.quality_score,
    grade: row.quality_grade,
    details: safeParseQualityDetails(row.quality_details),
  });
}

export async function handleQualityReport(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const syncKey = String(url.searchParams.get('syncKey') ?? url.searchParams.get('sync_key') ?? '').trim();
  const limit = Math.max(1, Math.min(50, Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20));
  if (!syncKey) return jsonError(request, env, 'INVALID_SYNC_KEY', 'syncKey is required', 400);

  const { results: unscored } = await env.DB.prepare(
    `SELECT id, title, artist, album, genre, release_year, track_number,
            format, quality, file_size, duration, thumbnail_url, status
     FROM download_jobs
     WHERE sync_key = ? AND status = 'done' AND quality_score IS NULL
     ORDER BY created_at DESC
     LIMIT 20`,
  ).bind(syncKey).all<JobMetadata>();

  if (unscored.length) {
    await env.DB.batch(unscored.map((job) => {
      const score = calculateQualityScore(job);
      return env.DB.prepare(
        `UPDATE download_jobs
         SET quality_score = ?, quality_grade = ?, quality_details = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).bind(score.total, score.grade, JSON.stringify(score), job.id);
    }));
  }

  const stats = await env.DB.prepare(
    `SELECT
       AVG(quality_score) AS avg_score,
       MIN(quality_score) AS min_score,
       MAX(quality_score) AS max_score,
       COUNT(*) AS total,
       SUM(CASE WHEN quality_grade = 'A' THEN 1 ELSE 0 END) AS grade_a,
       SUM(CASE WHEN quality_grade = 'B' THEN 1 ELSE 0 END) AS grade_b,
       SUM(CASE WHEN quality_grade = 'C' THEN 1 ELSE 0 END) AS grade_c,
       SUM(CASE WHEN quality_grade = 'D' THEN 1 ELSE 0 END) AS grade_d,
       SUM(CASE WHEN quality_grade = 'F' THEN 1 ELSE 0 END) AS grade_f
     FROM download_jobs
     WHERE sync_key = ? AND status = 'done' AND quality_score IS NOT NULL`,
  ).bind(syncKey).first<QualitySummaryRow>();

  const { results: worst } = await env.DB.prepare(
    `SELECT id, title, artist, quality_score, quality_grade, quality_details
     FROM download_jobs
     WHERE sync_key = ? AND status = 'done' AND quality_score IS NOT NULL
     ORDER BY quality_score ASC, created_at DESC
     LIMIT ?`,
  ).bind(syncKey, limit).all<{
    id: string;
    title: string | null;
    artist: string | null;
    quality_score: number;
    quality_grade: QualityScore['grade'];
    quality_details: string | null;
  }>();

  return jsonOk(request, env, {
    stats: normalizeStats(stats),
    worst: worst.map((job) => ({
      job_id: job.id,
      title: job.title,
      artist: job.artist,
      score: job.quality_score,
      grade: job.quality_grade,
      details: safeParseQualityDetails(job.quality_details),
    })),
    auto_scored: unscored.length,
  });
}

export async function handleBatchScore(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const syncKey = String(url.searchParams.get('syncKey') ?? url.searchParams.get('sync_key') ?? '').trim();
  if (!syncKey) return jsonError(request, env, 'INVALID_SYNC_KEY', 'syncKey is required', 400);

  const { results } = await env.DB.prepare(
    `SELECT id, title, artist, album, genre, release_year, track_number,
            format, quality, file_size, duration, thumbnail_url, status
     FROM download_jobs
     WHERE sync_key = ? AND status = 'done' AND quality_score IS NULL
     ORDER BY created_at DESC
     LIMIT 100`,
  ).bind(syncKey).all<JobMetadata>();

  if (!results.length) {
    return jsonOk(request, env, { scored: 0, message: 'All jobs already scored' });
  }

  const scores = results.map((job) => ({ job, score: calculateQualityScore(job) }));
  await env.DB.batch(scores.map(({ job, score }) => env.DB.prepare(
    `UPDATE download_jobs
     SET quality_score = ?, quality_grade = ?, quality_details = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(score.total, score.grade, JSON.stringify(score), job.id)));

  const grades = scores.reduce<Record<string, number>>((acc, { score }) => {
    acc[score.grade] = (acc[score.grade] ?? 0) + 1;
    return acc;
  }, {});
  const avgScore = Math.round(scores.reduce((sum, { score }) => sum + score.total, 0) / scores.length);

  return jsonOk(request, env, { scored: results.length, grades, avg_score: avgScore });
}

async function readQualityJob(env: Env, jobId: string): Promise<JobMetadata | null> {
  return env.DB.prepare(
    `SELECT id, title, artist, album, genre, release_year, track_number,
            format, quality, file_size, duration, thumbnail_url, status
     FROM download_jobs
     WHERE id = ?`,
  ).bind(jobId).first<JobMetadata>();
}

async function writeQualityScore(env: Env, jobId: string, score: QualityScore): Promise<void> {
  await env.DB.prepare(
    `UPDATE download_jobs
     SET quality_score = ?, quality_grade = ?, quality_details = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(score.total, score.grade, JSON.stringify(score), jobId).run();
}

function safeParseQualityDetails(raw: string | null): QualityScore | Record<string, never> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as QualityScore;
  } catch {
    return {};
  }
}

function normalizeStats(row: QualitySummaryRow | null): Record<string, number> {
  return {
    avg_score: Math.round(Number(row?.avg_score ?? 0)),
    min_score: Number(row?.min_score ?? 0),
    max_score: Number(row?.max_score ?? 0),
    total: Number(row?.total ?? 0),
    grade_a: Number(row?.grade_a ?? 0),
    grade_b: Number(row?.grade_b ?? 0),
    grade_c: Number(row?.grade_c ?? 0),
    grade_d: Number(row?.grade_d ?? 0),
    grade_f: Number(row?.grade_f ?? 0),
  };
}
