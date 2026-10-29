// ADR-001 › Action item 4: Privy gets only the home address `/` as the return address; the place the
// tab was at waits in sessionStorage (add-account › Sign-in return data owns the real one).
const KEY = 'nearling.day1.return';

export function rememberReturnPlace(path: string): void {
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    // storage blocked: the page just stays at `/`
  }
}

export function takeReturnPlace(): string | null {
  try {
    const path = sessionStorage.getItem(KEY);
    if (path) sessionStorage.removeItem(KEY);
    return path;
  } catch {
    return null;
  }
}
