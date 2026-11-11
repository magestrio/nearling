import { useSyncExternalStore } from 'react';
import { Button, Sheet, Stack } from '../ds';
import { openAddress, openPay } from './request';

interface GuestFeedRequest { tokenId: string; name: string; signIn: () => void }
let current: GuestFeedRequest | null = null;
const listeners = new Set<() => void>();
function publish(value: GuestFeedRequest | null) {
  current = value;
  for (const listener of listeners) listener();
}
export function openGuestFeed(request: GuestFeedRequest) { publish(request); }
export function closeGuestFeed() { publish(null); }
export function guestFeedNow(): GuestFeedRequest | null { return current; }
export function useGuestFeed(): GuestFeedRequest | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => current, () => null);
}
export function GuestFeedSheet({ request, column }: { request: GuestFeedRequest; column?: boolean }) {
  return <Sheet title={`Feed ${request.name}`} onClose={closeGuestFeed} column={column}>
    <Stack gap={3}>
      <Button block onClick={() => { closeGuestFeed(); openPay({ tokenId: request.tokenId, name: request.name,
        backAction: () => openGuestFeed(request) }); }}>Pay from another chain</Button>
      <Button variant="secondary" block onClick={() => { closeGuestFeed(); openAddress({ tokenId: request.tokenId, name: request.name,
        backAction: () => openGuestFeed(request) }); }}>
        {`Send USDC to ${request.name}'s address`}
      </Button>
      <Button variant="secondary" block onClick={() => { closeGuestFeed(); request.signIn(); }}>Sign in</Button>
    </Stack>
  </Sheet>;
}
