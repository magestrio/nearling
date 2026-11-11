import { useSyncExternalStore } from 'react';
import { closeFeed, openFeed, type FeedRequest } from '../feeding/feedRequest';
import type { Fullness } from '../seams/worker-types';

export interface PayRequest {
  tokenId: string; name: string; back?: FeedRequest; backAction?: () => void;
  /** The pet's fullness the sheet it was opened from showed: the phone's sheet carries it in its head. */
  fullness?: Fullness; elsewhere?: boolean;
}
let current: PayRequest | null = null;
const listeners = new Set<() => void>();
let addressRequest: PayRequest | null = null;
const addressListeners = new Set<() => void>();
function publish(request: PayRequest | null) {
  current = request;
  for (const listener of listeners) listener();
}
export function openPay(request: PayRequest) { closeFeed(); closeAddress(); publish(request); }
export function closePay() { publish(null); }
export function payRequestNow(): PayRequest | null { return current; }
export function openAddress(request: PayRequest) {
  closeFeed();
  closePay();
  addressRequest = request;
  for (const listener of addressListeners) listener();
}
export function closeAddress() {
  addressRequest = null;
  for (const listener of addressListeners) listener();
}
export function backAddress() {
  const previous = addressRequest?.back;
  const backAction = addressRequest?.backAction;
  closeAddress();
  if (previous) openFeed(previous);
  else backAction?.();
}
export function addressRequestNow(): PayRequest | null { return addressRequest; }
export function useAddressRequest(): PayRequest | null {
  return useSyncExternalStore((listener) => { addressListeners.add(listener); return () => addressListeners.delete(listener); },
    () => addressRequest, () => null);
}
export function backPay() {
  const previous = current?.back;
  const backAction = current?.backAction;
  closePay();
  if (previous) openFeed(previous);
  else backAction?.();
}
export function usePayRequest(): PayRequest | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => current, () => null);
}
