import { describe, expect, it } from 'vitest';
import {
  buildTelegramDeepLinks,
  chooseTelegramUploadMode,
  parseBotCommand,
  validateTelegramInitData,
} from './telegram_platform';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function buildInitData(
  botToken: string,
  user: { id: number; first_name: string; username?: string },
  authDate: number,
): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAEAAAE',
    user: JSON.stringify(user),
  });
  const entries = Array.from(params.entries())
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const encoder = new TextEncoder();
  const seedKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const secretBytes = await crypto.subtle.sign('HMAC', seedKey, encoder.encode(botToken));
  const secretKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(entries));
  params.set('hash', bytesToHex(new Uint8Array(signature)));
  return params.toString();
}

describe('Telegram platform v10', () => {
  it('parses commands with bot username and arguments', () => {
    expect(parseBotCommand('/start@dyrakarmy_bot job_abc123')).toEqual({
      command: '/start',
      args: 'job_abc123',
    });
    expect(parseBotCommand('not a command')).toBeNull();
  });

  it('chooses upload modes according to Bot API limits', () => {
    expect(chooseTelegramUploadMode(10 * 1024 * 1024, 'mp3')).toBe('url');
    expect(chooseTelegramUploadMode(30 * 1024 * 1024, 'mp3')).toBe('multipart');
    expect(chooseTelegramUploadMode(10 * 1024 * 1024, 'flac')).toBe('multipart');
    expect(chooseTelegramUploadMode(80 * 1024 * 1024, 'flac')).toBe('link');
  });

  it('builds safe bot and Mini App handoff links', () => {
    expect(buildTelegramDeepLinks('@dyrakarmy_bot', 'abc-123')).toEqual({
      botUrl: 'tg://resolve?domain=dyrakarmy_bot&start=job_abc-123',
      miniAppUrl: 'tg://resolve?domain=dyrakarmy_bot&startapp=job_abc-123',
    });
  });

  it('validates signed Telegram Mini App initData', async () => {
    const now = 1_800_000_000;
    const token = '123456:TEST_BOT_TOKEN';
    const initData = await buildInitData(token, {
      id: 123456789,
      first_name: 'Yordan',
      username: 'tester',
    }, now);

    const valid = await validateTelegramInitData(initData, token, 900, now);
    expect(valid.ok).toBe(true);
    expect(valid.user?.id).toBe(123456789);

    const tampered = new URLSearchParams(initData);
    tampered.set('user', JSON.stringify({ id: 999, first_name: 'Attacker' }));
    const invalid = await validateTelegramInitData(tampered.toString(), token, 900, now);
    expect(invalid.ok).toBe(false);
  });
});
