import { describe, expect, it } from 'vitest';
import { validateTelegramInitData } from './telegram_platform';
import { createSyntheticTelegramInitData } from './latency_strike_native';

describe('Latency Strike native Telegram Games bridge', () => {
  it('creates initData accepted by the existing Telegram validator', async () => {
    const token = '123456789:TEST_NATIVE_GAME_TOKEN';
    const now = 1_784_550_000;
    const initData = await createSyntheticTelegramInitData({
      id: 99001122,
      first_name: 'Dyrak',
      username: 'queue_master',
      language_code: 'bg',
    }, token, now);

    const result = await validateTelegramInitData(initData, token, 900, now);
    expect(result.ok).toBe(true);
    expect(result.user?.id).toBe(99001122);
    expect(result.user?.username).toBe('queue_master');
    expect(result.queryId).toMatch(/^native_/);
  });

  it('rejects a generated payload when a different bot token validates it', async () => {
    const now = 1_784_550_000;
    const initData = await createSyntheticTelegramInitData({
      id: 123,
      first_name: 'Player',
    }, '111:SOURCE_TOKEN', now);

    const result = await validateTelegramInitData(initData, '222:DIFFERENT_TOKEN', 900, now);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Telegram signature mismatch');
  });
});
