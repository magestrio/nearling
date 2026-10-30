// Who is on a phone, and who is inside the in-app browser of X or Telegram, where Google refuses to sign anyone in
// (`disallowed_useragent`). The patterns are one table. [unconfirmed for 2026: `web-client` facts §3.4 — the real strings of X
// and Telegram on a real Android and a real iPhone are recorded by hand, design.md › Риски]. A miss is no loss: the player
// meets `Sign-in flow` › «запасной путь на телефоне». Never a spoofed user agent (`web-client` › Pitfalls).
export type InApp = 'x' | 'telegram';
export interface BrowserInfo {
  inApp: InApp | null;
  os: 'android' | 'ios' | 'other';
  phone: boolean;
}

const IN_APP: ReadonlyArray<readonly [InApp, RegExp]> = [
  ['x', /\bTwitter(?:ForiPhone|Android)?\b|\bTwitter for (?:iPhone|Android)\b/i],
  ['telegram', /\bTelegram(?:-Android)?\b|\bTelegramBot\b/i],
];

/** `maxTouchPoints`: an iPad asks for the desktop site and says it is a Mac; only touch points tell it apart. */
export function browserOf(userAgent: string, maxTouchPoints = 0): BrowserInfo {
  const inApp = IN_APP.find(([, pattern]) => pattern.test(userAgent))?.[0] ?? null;
  const android = /\bAndroid\b/i.test(userAgent);
  const iphone = /\b(?:iPhone|iPod)\b/.test(userAgent);
  const ipad = /\biPad\b/.test(userAgent) || (/\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1);
  const os = android ? 'android' : iphone || ipad ? 'ios' : 'other';
  // an Android phone says `Mobile`, an Android tablet does not
  const phone = iphone || (android && /\bMobile\b/i.test(userAgent));
  return { inApp, os, phone };
}

/** The browser the code runs in. */
export function thisBrowser(): BrowserInfo {
  return browserOf(navigator.userAgent, navigator.maxTouchPoints);
}
