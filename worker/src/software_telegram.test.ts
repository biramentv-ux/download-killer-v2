import { describe, expect, it } from 'vitest';
import { buildSoftwareCatalog } from './software_catalog';
import {
  buildGamesInlineKeyboard,
  buildSoftwareInlineKeyboard,
  parseSoftwareTelegramCommand,
} from './software_telegram';

describe('Telegram software and Games 1-10 menus', () => {
  it('parses software and games command aliases safely', () => {
    expect(parseSoftwareTelegramCommand('/software')).toBe('software');
    expect(parseSoftwareTelegramCommand('/software@dyrakarmy_bot details')).toBe('software');
    expect(parseSoftwareTelegramCommand('/mix')).toBe('software');
    expect(parseSoftwareTelegramCommand('/games')).toBe('games');
    expect(parseSoftwareTelegramCommand('/gamehub@dyrakarmy_bot')).toBe('games');
    expect(parseSoftwareTelegramCommand('/download')).toBeNull();
    expect(parseSoftwareTelegramCommand(undefined)).toBeNull();
  });

  it('builds direct latest-release buttons without untrusted domains', () => {
    const catalog = buildSoftwareCatalog({ PUBLIC_BASE_URL: 'https://dyrakarmy.eu' } as never);
    const keyboard = buildSoftwareInlineKeyboard(catalog.releases, 'https://dyrakarmy.eu');
    const buttons = keyboard.flat();
    const urls = buttons.map((button) => button.url).filter((url): url is string => Boolean(url));

    expect(buttons.some((button) => button.callback_data === 'games:menu')).toBe(true);
    expect(urls).toContain('https://dyrakarmy.eu/#software');
    expect(urls.some((url) => url.endsWith('/DyrakArmyDesktop.exe'))).toBe(true);
    expect(urls.some((url) => url.endsWith('/DyrakArmySpotifyOggMp4Engine.exe'))).toBe(true);
    expect(urls.every((url) => /^https:\/\/(github\.com|dyrakarmy\.eu)(\/|$)/.test(url))).toBe(true);
  });

  it('exposes exactly all ten games through the canonical Telegram bot', () => {
    const keyboard = buildGamesInlineKeyboard('dyrakarmy_bot');
    const buttons = keyboard.flat();
    const gameButtons = buttons.filter((button) => button.url?.includes('?startapp='));
    const retiredMarker = ['download', 'killer'].join('_');

    expect(gameButtons).toHaveLength(10);
    expect(buttons.some((button) => button.callback_data === 'software:menu')).toBe(true);
    for (const button of gameButtons) {
      expect(button.url).toMatch(/^https:\/\/t\.me\/dyrakarmy_bot\?startapp=/);
      expect(button.url).not.toContain(retiredMarker);
    }
  });

  it('sanitizes a malformed Telegram username before building links', () => {
    const keyboard = buildGamesInlineKeyboard('@bad/user?x=1');
    const urls = keyboard.flat().map((button) => button.url).filter(Boolean);
    expect(urls.filter((url) => url?.includes('?startapp=')).every((url) => url?.startsWith('https://t.me/baduserx1?startapp='))).toBe(true);
  });
});
