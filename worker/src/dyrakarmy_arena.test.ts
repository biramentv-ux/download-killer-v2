import { describe, expect, it } from 'vitest';
import {
  arenaDayKey,
  arenaQuestionsForDay,
  arenaSeasonKey,
  calculateArenaScore,
} from './dyrakarmy_arena';

describe('DyrakArmy Arena', () => {
  it('uses stable UTC day and season keys', () => {
    const date = new Date('2026-07-20T23:59:59.000Z');
    expect(arenaDayKey(date)).toBe('2026-07-20');
    expect(arenaSeasonKey(date)).toBe('2026-07');
  });

  it('selects eight deterministic questions per day', () => {
    const first = arenaQuestionsForDay('2026-07-20');
    const repeated = arenaQuestionsForDay('2026-07-20');
    const next = arenaQuestionsForDay('2026-07-21');
    expect(first).toHaveLength(8);
    expect(new Set(first.map((question) => question.id)).size).toBe(8);
    expect(repeated.map((question) => question.id)).toEqual(first.map((question) => question.id));
    expect(next.map((question) => question.id)).not.toEqual(first.map((question) => question.id));
  });

  it('rewards correct fast answers and combo streaks', () => {
    const questions = arenaQuestionsForDay('2026-07-20');
    const answers = questions.map((question, index) => ({
      question_id: question.id,
      option_index: question.correct,
      response_ms: 500 + index * 20,
    }));
    const result = calculateArenaScore(questions, answers);
    expect(result.correct).toBe(8);
    expect(result.accuracy).toBe(100);
    expect(result.best_combo).toBe(8);
    expect(result.score).toBeGreaterThan(10_000);
    expect(result.xp).toBeGreaterThan(300);
    expect(result.team_points).toBe(result.score);
  });

  it('accepts only the first answer for each known question', () => {
    const questions = arenaQuestionsForDay('2026-07-20');
    const result = calculateArenaScore(questions, [
      { question_id: questions[0].id, option_index: questions[0].correct, response_ms: 300 },
      { question_id: 'unknown-question', option_index: 0, response_ms: 1 },
      { question_id: questions[0].id, option_index: 99, response_ms: 1 },
    ]);
    expect(result.correct).toBe(1);
    expect(result.accuracy).toBe(13);
    expect(result.best_combo).toBe(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.xp).toBeGreaterThanOrEqual(35);
  });
});
