import { describe, expect, it } from 'vitest';
import { browserOf } from './inApp';

// The base strings are the ordinary ones of Safari on iPhone, Chrome on Android and Safari on a Mac. The in-app tokens
// added to them are the documented names of the apps; the real strings of X and Telegram in 2026 are not recorded yet —
// they are recorded by hand on a real phone (design.md › Риски, «Проверить руками»).
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

describe('browserOf', () => {
  // spec: add-account › Sign-in flow › встроенный браузер
  it.each([
    ['X on iPhone', `${IPHONE} Twitter for iPhone`, { inApp: 'x', os: 'ios', phone: true }],
    ['X on Android', `${ANDROID} TwitterAndroid`, { inApp: 'x', os: 'android', phone: true }],
    ['Telegram on iPhone', `${IPHONE} Telegram/10.14`, { inApp: 'telegram', os: 'ios', phone: true }],
    ['Telegram on Android', `${ANDROID} Telegram-Android/10.14.0`, { inApp: 'telegram', os: 'android', phone: true }],
  ] as const)('knows %s', (_name, userAgent, expected) => {
    expect(browserOf(userAgent)).toEqual(expected);
  });

  // spec: add-account › Sign-in flow › запасной путь на телефоне
  it.each([
    ['Safari on iPhone', IPHONE, { inApp: null, os: 'ios', phone: true }],
    ['Chrome on an Android phone', ANDROID, { inApp: null, os: 'android', phone: true }],
    ['Chrome on an Android tablet', ANDROID_TABLET, { inApp: null, os: 'android', phone: false }],
    ['Safari on a Mac', MAC, { inApp: null, os: 'other', phone: false }],
  ] as const)('does not take %s for an in-app browser', (_name, userAgent, expected) => {
    expect(browserOf(userAgent, 0)).toEqual(expected);
  });

  // spec: add-account › Sign-in flow › запасной путь на телефоне
  it('takes an iPad that asks for the desktop site for an iPad, by its touch points, and not for a phone', () => {
    expect(browserOf(MAC, 5)).toEqual({ inApp: null, os: 'ios', phone: false });
    expect(browserOf(MAC, 0)).toEqual({ inApp: null, os: 'other', phone: false });
  });
});
