import type { PublicGift } from '../seams/worker-types';

/** The link is public; only a session with the accepted account may see its private outcome. */
export type ReceiverState = 'offered' | 'signed-out-held' | 'giver' | 'accepted' | 'received';

export function receiverState(gift: PublicGift, authenticated: boolean): ReceiverState {
  if (!authenticated && gift.status !== 'waiting') return 'signed-out-held';
  if (authenticated && gift.viewer === 'giver') return 'giver';
  if (authenticated && gift.viewer === 'receiver' && gift.status === 'transferred') return 'received';
  if (authenticated && gift.viewer === 'receiver' && gift.status === 'accepted') return 'accepted';
  return 'offered';
}
