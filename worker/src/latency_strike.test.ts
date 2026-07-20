import { describe, expect, it } from 'vitest';
import {
  calculateLatencyStrikeScore,
  eligibleLatencyStrikeRewards,
  latencyStrikeRank,
  latencyStrikeWeekKey,
} from './latency_strike';

describe('Latency Strike scoring', () => {
  it('rewards fast clean reactions', () => {
    const result = calculateLatencyStrikeScore([
      { reaction_ms: 210 },
      { reaction_ms: 230 },
      { reaction_ms: 250 },
      { reaction_ms: 240 },
      { reaction_ms: 220 },
    ]);
    expect(result.falseStarts).toBe(0);
    expect(result.accuracy).toBe(100);
    expect(result.bestReactionMs).toBe(210);
    expect(result.avgReactionMs).toBe(230);
    expect(result.score).toBeGreaterThan(12000);
    expect(result.xp).toBeGreaterThan(500);
  });

  it('penalizes false starts and invalid reactions', () => {
    const result = calculateLatencyStrikeScore([
      { false_start: true },
      { reaction_ms: 50 },
      { reaction_ms: 2600 },
      { reaction_ms: 500 },
      { reaction_ms: 600 },
    ]);
    expect(result.falseStarts).toBe(3);
    expect(result.accuracy).toBe(40);
    expect(result.bestReactionMs).toBe(500);
    expect(result.score).toBeLessThan(5000);
  });

  it('always normalizes the run to five rounds', () => {
    const result = calculateLatencyStrikeScore([{ reaction_ms: 300 }]);
    expect(result.rounds).toBe(5);
    expect(result.falseStarts).toBe(4);
  });
});

describe('Latency Strike progression', () => {
  it('resolves all rank thresholds', () => {
    expect(latencyStrikeRank(0).id).toBe('recruit');
    expect(latencyStrikeRank(250).id).toBe('runner');
    expect(latencyStrikeRank(700).id).toBe('operator');
    expect(latencyStrikeRank(1500).id).toBe('commander');
    expect(latencyStrikeRank(3000).id).toBe('queue_master');
  });

  it('unlocks XP, reaction, streak and leaderboard rewards', () => {
    const rewards = eligibleLatencyStrikeRewards({
      total_xp: 3200,
      total_games: 40,
      best_reaction_ms: 205,
      current_streak: 7,
    }, 2);
    expect(rewards).toContain('title_queue_master');
    expect(rewards).toContain('badge_precision');
    expect(rewards).toContain('badge_hot_streak');
    expect(rewards).toContain('frame_champion');
    expect(rewards).toContain('theme_gold');
  });

  it('does not grant leaderboard rewards without placement', () => {
    const rewards = eligibleLatencyStrikeRewards({
      total_xp: 5000,
      total_games: 100,
      best_reaction_ms: 180,
      current_streak: 20,
    }, null);
    expect(rewards).not.toContain('frame_champion');
    expect(rewards).not.toContain('icon_crown');
  });

  it('produces an ISO week key', () => {
    expect(latencyStrikeWeekKey(new Date('2026-07-20T00:00:00Z'))).toBe('2026-W30');
  });
});
