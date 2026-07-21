import { describe, expect, it } from 'vitest';
import {
  GAME_PACK,
  calculateGamePackScore,
  gamePackDayKey,
  gamePackQuestions,
  type GamePackId,
} from './game_pack';

const GAME_IDS = Object.keys(GAME_PACK) as GamePackId[];

describe('DyrakArmy seven-game pack', () => {
  it('contains the seven missing games so the platform total is ten', () => {
    expect(GAME_IDS).toEqual([
      'queue-commander',
      'beat-hunter',
      'format-forge',
      'server-defender',
      'metadata-detective',
      'link-runner',
      'bot-vs-human',
    ]);
  });

  it('uses a stable UTC daily rotation', () => {
    expect(gamePackDayKey(new Date('2026-07-20T23:59:59.000Z'))).toBe('2026-07-20');
  });

  it.each(GAME_IDS)('%s selects five deterministic unique rounds', (gameId) => {
    const first = gamePackQuestions(gameId, '2026-07-20');
    const repeated = gamePackQuestions(gameId, '2026-07-20');
    expect(first).toHaveLength(5);
    expect(new Set(first.map((question) => question.id)).size).toBe(5);
    expect(repeated.map((question) => question.id)).toEqual(first.map((question) => question.id));
  });

  it.each(GAME_IDS)('%s rewards a perfect fast run', (gameId) => {
    const questions = gamePackQuestions(gameId, '2026-07-20');
    const answers = questions.map((question, index) => ({
      question_id: question.id,
      option_index: question.correct,
      response_ms: 500 + index * 30,
    }));
    const result = calculateGamePackScore(gameId, questions, answers, 5000);
    expect(result.correct).toBe(5);
    expect(result.accuracy).toBe(100);
    expect(result.best_combo).toBe(5);
    expect(result.score).toBeGreaterThan(7000);
    expect(result.xp).toBeGreaterThan(250);
  });

  it('Bot vs Human compares the player against deterministic DK Core score', () => {
    const questions = gamePackQuestions('bot-vs-human', '2026-07-20');
    const perfect = questions.map((question) => ({ question_id: question.id, option_index: question.correct, response_ms: 300 }));
    const winner = calculateGamePackScore('bot-vs-human', questions, perfect, 5000);
    expect(winner.bot_score).toBe(5000);
    expect(winner.won_duel).toBe(true);
    const loser = calculateGamePackScore('bot-vs-human', questions, [], 5000);
    expect(loser.won_duel).toBe(false);
  });

  it('ignores duplicate and unknown answers', () => {
    const questions = gamePackQuestions('queue-commander', '2026-07-20');
    const first = questions[0];
    expect(first).toBeDefined();
    if (!first) return;
    const result = calculateGamePackScore('queue-commander', questions, [
      { question_id: first.id, option_index: first.correct, response_ms: 500 },
      { question_id: first.id, option_index: 99, response_ms: 1 },
      { question_id: 'unknown', option_index: 0, response_ms: 1 },
    ]);
    expect(result.correct).toBe(1);
    expect(result.total).toBe(5);
  });
});
