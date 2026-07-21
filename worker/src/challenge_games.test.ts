import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_GAMES,
  calculateChallengeScore,
  challengeDayKey,
  challengeGameSlugs,
  challengeQuestionsForDay,
} from './challenge_games';

const EXPECTED = [
  ['queue-commander', 1],
  ['beat-hunter', 2],
  ['format-forge', 4],
  ['server-defender', 5],
  ['metadata-detective', 6],
  ['link-runner', 7],
  ['bot-vs-human', 10],
] as const;

describe('DyrakArmy challenge games 1-10 engine', () => {
  it('registers every missing game with its original number', () => {
    expect(challengeGameSlugs()).toHaveLength(7);
    for (const [slug, number] of EXPECTED) {
      expect(CHALLENGE_GAMES[slug].number).toBe(number);
      expect(CHALLENGE_GAMES[slug].questions.length).toBeGreaterThanOrEqual(CHALLENGE_GAMES[slug].rounds);
      expect(CHALLENGE_GAMES[slug].reward_id).toBeTruthy();
    }
  });

  it('uses a stable UTC daily rotation', () => {
    expect(challengeDayKey(new Date('2026-07-21T23:59:59.000Z'))).toBe('2026-07-21');
  });

  for (const [slug] of EXPECTED) {
    const game = CHALLENGE_GAMES[slug];

    it(`${game.title}: selects deterministic unique daily rounds`, () => {
      const first = challengeQuestionsForDay(game, '2026-07-21');
      const repeated = challengeQuestionsForDay(game, '2026-07-21');
      expect(first).toHaveLength(game.rounds);
      expect(new Set(first.map((question) => question.id)).size).toBe(game.rounds);
      expect(repeated.map((question) => question.id)).toEqual(first.map((question) => question.id));
    });

    it(`${game.title}: perfect run unlocks its reward`, () => {
      const questions = challengeQuestionsForDay(game, '2026-07-21');
      const answers = questions.map((question, index) => ({
        question_id: question.id,
        option_index: question.correct,
        response_ms: 700 + index * 50,
      }));
      const result = calculateChallengeScore(game, questions, answers);
      expect(result.correct).toBe(game.rounds);
      expect(result.accuracy).toBe(100);
      expect(result.best_combo).toBe(game.rounds);
      expect(result.reward_unlocked).toBe(true);
      expect(result.score).toBeGreaterThan(5000);
      expect(result.xp).toBeGreaterThan(200);
    });
  }

  it('keeps only the first answer for each question', () => {
    const game = CHALLENGE_GAMES['queue-commander'];
    const questions = challengeQuestionsForDay(game, '2026-07-21');
    const first = questions[0];
    expect(first).toBeDefined();
    if (!first) return;
    const result = calculateChallengeScore(game, questions, [
      { question_id: first.id, option_index: first.correct, response_ms: 500 },
      { question_id: first.id, option_index: 99, response_ms: 1 },
      { question_id: 'unknown', option_index: 0, response_ms: 1 },
    ]);
    expect(result.correct).toBe(1);
    expect(result.best_combo).toBe(1);
  });

  it('never produces negative score or XP', () => {
    const game = CHALLENGE_GAMES['server-defender'];
    const questions = challengeQuestionsForDay(game, '2026-07-21');
    const result = calculateChallengeScore(game, questions, []);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.xp).toBeGreaterThanOrEqual(30);
    expect(result.reward_unlocked).toBe(false);
  });
});
