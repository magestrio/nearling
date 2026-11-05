/** The typed name belongs to the signed-in account, and survives a reload while its signed birth is checked. */
const key = (account: string) => `nearling:hatch:${account}`;
const PREFIX = 'nearling:hatch:';
const posts = new Map<string, Promise<void>>();

/** A POST belongs to the account, not a particular Hatch mount. It starts before token retrieval. */
export function trackHatchPost(account: string | null, post: Promise<void>): void {
  if (account === null) return;
  posts.set(account, post);
  void post.then(() => {
    if (posts.get(account) === post) posts.delete(account);
  });
}

export function activeHatchPost(account: string | null): Promise<void> | null {
  return account === null ? null : posts.get(account) ?? null;
}

export function pendingName(account: string | null): string | null {
  if (account === null) return null;
  try { return sessionStorage.getItem(key(account)); } catch { return null; }
}

export function keepPendingName(account: string | null, name: string): void {
  if (account === null) return;
  try { sessionStorage.setItem(key(account), name); } catch { /* site storage can be unavailable */ }
}

export function clearPendingName(account: string | null): void {
  if (account === null) return;
  try { sessionStorage.removeItem(key(account)); } catch { /* site storage can be unavailable */ }
}

export function clearPendingBirths(): void {
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  } catch { /* site storage can be unavailable */ }
}
