import { useSyncExternalStore } from 'react';
import { registerAction } from '../screens/pet/parts';

export interface GiftRequest { tokenId: string; name: string; self?: boolean; given?: boolean; friend?: string }
let current: GiftRequest | null = null;
const listeners = new Set<() => void>();
function publish(next: GiftRequest | null) { current = next; for (const listener of listeners) listener(); }
export function openGift(request: GiftRequest) { publish(request); }
export function closeGift() { publish(null); }
export function giftOpenNow() { return current; }
export function markGiftGiven(tokenId: string, friend: string) { if (current?.tokenId === tokenId) publish({ ...current, given: true, friend }); }
export function useGiftRequest() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => current, () => null);
}
registerAction('gift', ({ tokenId, name }) => openGift({ tokenId, name }));
