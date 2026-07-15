import { describe, expect, it } from 'vitest';
import { parseShareMediaId } from './telegram_master_menu';

describe('parseShareMediaId', () => {
  it('accepts a positive media id', () => {
    expect(parseShareMediaId('share:42')).toBe(42);
    expect(parseShareMediaId('  SHARE:7  ')).toBe(7);
  });

  it('rejects malformed or unsafe values', () => {
    expect(parseShareMediaId('share:0')).toBeNull();
    expect(parseShareMediaId('share:-2')).toBeNull();
    expect(parseShareMediaId('share:not-a-number')).toBeNull();
    expect(parseShareMediaId('song:12')).toBeNull();
  });
});
