import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_RAID_CARDS,
  archiveRaidCardForRoll,
  archiveRaidDayKey,
  calculateArchiveRaidOutcome,
} from './archive_raid';

describe('Archive Raid', () => {
  it('uses stable UTC daily rotation keys', () => {
    expect(archiveRaidDayKey(new Date('2026-07-20T23:59:59.000Z'))).toBe('2026-07-20');
  });

  it('contains every documented collectible category and rarity', () => {
    expect(new Set(ARCHIVE_RAID_CARDS.map((card) => card.category))).toEqual(new Set([
      'genre', 'waveform', 'bot_skin', 'server_core', 'badge', 'artist_archetype', 'profile_effect',
    ]));
    expect(new Set(ARCHIVE_RAID_CARDS.map((card) => card.rarity))).toEqual(new Set([
      'Common', 'Rare', 'Epic', 'Legendary', 'Army Exclusive',
    ]));
  });

  it('maps high rolls to rarer cards', () => {
    expect(archiveRaidCardForRoll(10).rarity).toBe('Common');
    expect(archiveRaidCardForRoll(60).rarity).toBe('Rare');
    expect(archiveRaidCardForRoll(84).rarity).toBe('Epic');
    expect(archiveRaidCardForRoll(95).rarity).toBe('Legendary');
    expect(archiveRaidCardForRoll(99).rarity).toBe('Army Exclusive');
  });

  it('produces deterministic server-side outcomes', () => {
    const choices = Array.from({ length: 5 }, (_, room) => ({
      room_index: room,
      route: room % 2 === 0 ? 'breach' as const : 'extract' as const,
      response_ms: 650 + room * 40,
    }));
    const first = calculateArchiveRaidOutcome(123456, choices);
    const repeated = calculateArchiveRaidOutcome(123456, choices);
    expect(repeated).toEqual(first);
    expect(first.successful_rooms + first.failed_rooms).toBe(5);
    expect(first.score).toBeGreaterThanOrEqual(0);
    expect(first.xp).toBeGreaterThanOrEqual(30);
    expect(first.drops.length).toBeLessThanOrEqual(4);
  });

  it('accepts only the first choice per room', () => {
    const result = calculateArchiveRaidOutcome(98765, [
      { room_index: 0, route: 'scan', response_ms: 500 },
      { room_index: 0, route: 'breach', response_ms: 1 },
      { room_index: 99, route: 'breach', response_ms: 1 },
    ]);
    expect(result.successful_rooms + result.failed_rooms).toBe(5);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
