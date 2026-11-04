import { WorkerError, type GiftOutcome } from '../seams/worker-types';

/** One tap may have only one signature and send, even if another tap arrives before React paints pending. */
export class GiftGate {
  private busy = false;
  take(): boolean { if (this.busy) return false; this.busy = true; return true; }
  release(): void { this.busy = false; }
  get locked(): boolean { return this.busy; }
}

/** The network's unresolved outcome stays pending; a retry must reconcile the same flight. */
export function giftPhase(status: string): 'pending' | 'given' | 'failed' | 'gas' | 'paused' | 'short' {
  if (status === 'ok') return 'given';
  if (status === 'failed') return 'failed';
  if (status === 'gas_rejected') return 'gas';
  if (status === 'paused') return 'paused';
  if (status === 'no_near') return 'short';
  return 'pending';
}

/** A no-flight poll can race the original send, so it only permits resending the same signed payload. */
export function noFlightAfterFailedSend(error: unknown, hasSignedPayload: boolean): boolean {
  return hasSignedPayload && error instanceof WorkerError && error.status === 409 && error.code === 'gift_unavailable';
}

/** Signed bytes live only in this sheet's memory until the transfer has a definite result. */
export class PendingGiftSend {
  private payload: { tx: string; signature: string } | null = null;

  retain(payload: { tx: string; signature: string }): void { this.payload = payload; }
  clear(): void { this.payload = null; }

  async resendOnNoFlight(
    error: unknown,
    send: (payload: { tx: string; signature: string }) => Promise<GiftOutcome>,
  ): Promise<GiftOutcome | null> {
    if (!noFlightAfterFailedSend(error, this.payload !== null)) return null;
    return send(this.payload!);
  }
}
