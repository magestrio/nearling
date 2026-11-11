import { WorkerError, type DebateRead } from '../seams/worker-types';
import { debateCopy as copy } from './copy';

export type Check = 'idle' | 'loading' | 'ready' | 'error' | 'asleep' | 'unknown_pair' | 'same_owner' | 'daily_slot_used' | 'society_refusal' | 'open_pair_invitation';
export type VisibleStatus = 'invited' | 'accepted' | 'declined' | 'expired' | 'gift' | 'cleared';

export function checkFrom(error: unknown): Check {
  if (!(error instanceof WorkerError)) return 'error';
  if (['asleep', 'unknown_pair', 'same_owner', 'daily_slot_used', 'society_refusal', 'open_pair_invitation'].includes(error.code)) return error.code as Check;
  return 'error';
}

export function checkLine(check: Check, name: string): string {
  if (check === 'loading') return copy.loading;
  if (check === 'error') return copy.error;
  if (check === 'asleep') return `${name} is asleep. Feed ${name} before debating.`;
  if (check === 'unknown_pair') return copy.unknownPair;
  if (check === 'same_owner') return copy.sameOwner;
  if (check === 'daily_slot_used') return `${name} has debated today. Try again tomorrow.`;
  if (check === 'society_refusal') return `${name} does not want to meet today.`;
  if (check === 'open_pair_invitation') return copy.openPair(name);
  return '';
}

/** The Pet status line names the consent outcome; later paid turns belong to the transcript. */
export function visibleStatus(status: DebateRead['status']): VisibleStatus {
  if (status === 'declined' || status === 'expired' || status === 'gift' || status === 'cleared') return status;
  return status === 'invited' ? 'invited' : 'accepted';
}
