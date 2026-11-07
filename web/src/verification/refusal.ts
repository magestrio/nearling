/** Private Worker evidence contains the signed response bytes; the visible mark is its signature, never a receipt pointer. */
export function refusalSignature(base64: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof value !== 'object' || value === null || !('signature' in value) || typeof value.signature !== 'string') return null;
    return value.signature.trim() ? value.signature : null;
  } catch { return null; }
}
