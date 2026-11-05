// The bearer stays in this tab only for the Google return. A code never enters the URL or Privy.
const KEY = 'nearling.judgeCode';
export const JUDGE_EXPIRES_AT = Date.parse('2026-11-19T00:00:00.000Z');

export function clearJudgeCode(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* storage may be blocked */ }
}

export function keepJudgeCode(code: string): void {
  if (Date.now() >= JUDGE_EXPIRES_AT) return;
  try { sessionStorage.setItem(KEY, code); } catch { /* the return will need another code */ }
}

export function readJudgeCode(): string | null {
  if (Date.now() >= JUDGE_EXPIRES_AT) {
    clearJudgeCode();
    return null;
  }
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}
