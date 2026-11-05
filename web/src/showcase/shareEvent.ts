import { workerApi, type CardKind, type Token } from '../seams/worker';

// Only allowlisted counters leave the browser. The ids are random, opaque playtest ids; no pet or player identifier is sent.
export function cardSharedPayload(kind: CardKind, delivery: 'save' | 'share') {
  return {
    at: Date.now(), kind, delivery,
    tabId: crypto.randomUUID(), playerId: crypto.randomUUID(), petId: crypto.randomUUID(),
  };
}

export async function sendCardShared(token: Token, kind: CardKind, delivery: 'save' | 'share'): Promise<void> {
  await workerApi.cardShared(token, cardSharedPayload(kind, delivery));
}
