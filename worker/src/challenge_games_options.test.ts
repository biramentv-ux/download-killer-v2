import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_GAMES,
  calculateChallengeScore,
  challengeQuestionsForDay,
  type ChallengeGameSlug,
} from './challenge_games';

const EXPECTED: Record<ChallengeGameSlug, {
  number: number;
  command: string;
  mode: string;
  minimumQuestions: number;
}> = {
  'queue-commander': { number: 1, command: 'queuegame', mode: 'priority', minimumQuestions: 8 },
  'beat-hunter': { number: 2, command: 'beat', mode: 'rhythm', minimumQuestions: 8 },
  'format-forge': { number: 4, command: 'formatgame', mode: 'format', minimumQuestions: 8 },
  'server-defender': { number: 5, command: 'defender', mode: 'defense', minimumQuestions: 8 },
  'metadata-detective': { number: 6, command: 'detective', mode: 'detective', minimumQuestions: 8 },
  'link-runner': { number: 7, command: 'linkrunner', mode: 'route', minimumQuestions: 8 },
  'bot-vs-human': { number: 10, command: 'botvhuman', mode: 'classification', minimumQuestions: 8 },
};

const GAME_IDS = Object.keys(EXPECTED) as ChallengeGameSlug[];

describe('DyrakArmy challenge games — exhaustive option contracts', () => {
  it('keeps the canonical numbering, commands, modes and common limits', () => {
    expect(Object.keys(CHALLENGE_GAMES)).toEqual(GAME_IDS);
    for (const slug of GAME_IDS) {
      const game = CHALLENGE_GAMES[slug];
      const expected = EXPECTED[slug];
      expect(game.number).toBe(expected.number);
      expect(game.command).toBe(expected.command);
      expect(game.mode).toBe(expected.mode);
      expect(game.rounds).toBe(6);
      expect(game.daily_attempts).toBe(3);
      expect(game.score_multiplier).toBeGreaterThan(0);
      expect(game.questions.length).toBeGreaterThanOrEqual(expected.minimumQuestions);
      expect(game.reward_id).toBeTruthy();
      expect(game.reward_label).toBeTruthy();
    }
  });

  for (const slug of GAME_IDS) {
    const game = CHALLENGE_GAMES[slug];

    it(`${game.title}: validates every question and every selectable option`, () => {
      const ids = new Set<string>();
      for (const question of game.questions) {
        expect(question.id).toMatch(/^[a-z0-9-]+$/);
        expect(ids.has(question.id)).toBe(false);
        ids.add(question.id);

        expect(question.prompt.trim().length).toBeGreaterThan(5);
        expect(question.explanation.trim().length).toBeGreaterThan(5);
        expect(question.options).toHaveLength(4);
        expect(new Set(question.options).size).toBe(4);
        expect(question.options.every((option) => option.trim().length > 0)).toBe(true);
        expect(Number.isInteger(question.correct)).toBe(true);
        expect(question.correct).toBeGreaterThanOrEqual(0);
        expect(question.correct).toBeLessThan(question.options.length);

        for (let optionIndex = 0; optionIndex < question.options.length; optionIndex += 1) {
          const result = calculateChallengeScore(game, [question], [{
            question_id: question.id,
            option_index: optionIndex,
            response_ms: 750,
          }]);
          expect(result.total).toBe(1);
          expect(result.correct).toBe(optionIndex === question.correct ? 1 : 0);
          expect(result.accuracy).toBe(optionIndex === question.correct ? 100 : 0);
          expect(result.score).toBeGreaterThanOrEqual(0);
          expect(result.xp).toBeGreaterThanOrEqual(30);
        }
      }
    });

    it(`${game.title}: daily rotation reaches every authored question`, () => {
      const seen = new Set<string>();
      for (let day = 1; day <= 64; day += 1) {
        const date = new Date(Date.UTC(2026, 0, day));
        const dayKey = date.toISOString().slice(0, 10);
        for (const question of challengeQuestionsForDay(game, dayKey)) seen.add(question.id);
      }
      expect(seen).toEqual(new Set(game.questions.map((question) => question.id)));
    });

    it(`${game.title}: clamps response time and rejects duplicate answer replacement`, () => {
      const questions = challengeQuestionsForDay(game, '2026-07-23');
      const first = questions[0];
      expect(first).toBeDefined();
      if (!first) return;

      const fast = calculateChallengeScore(game, [first], [{
        question_id: first.id,
        option_index: first.correct,
        response_ms: 1,
      }]);
      expect(fast.avg_response_ms).toBe(250);

      const slow = calculateChallengeScore(game, [first], [{
        question_id: first.id,
        option_index: first.correct,
        response_ms: 999_999,
      }]);
      expect(slow.avg_response_ms).toBe(15_000);

      const duplicate = calculateChallengeScore(game, [first], [
        { question_id: first.id, option_index: first.correct, response_ms: 500 },
        { question_id: first.id, option_index: (first.correct + 1) % 4, response_ms: 250 },
      ]);
      expect(duplicate.correct).toBe(1);
    });
  }
});
