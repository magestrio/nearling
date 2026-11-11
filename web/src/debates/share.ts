import { workerApi, type DebateRead } from '../seams/worker';

export function validShareCode(code: string): boolean { return /^[0-9a-f]{32}$/.test(code); }

/** The code never enters a request URL, analytics body, or persistent browser storage. */
export async function readShared(code: string): Promise<DebateRead> {
  if (!validShareCode(code)) throw new Error('invalid_share_code');
  return workerApi.debateShared(code);
}

const tabId = crypto.randomUUID();
export function debateOpen(read: DebateRead, name: 'debate_link_opened' | 'debate_receipt_opened'): void {
  if (!/^[0-9a-f]{64}$/.test(read.analyticsId ?? '')) return;
  void workerApi.debateOpen({ eventId: crypto.randomUUID(), tabId, debateId: read.analyticsId!, name }).catch(() => {});
}
