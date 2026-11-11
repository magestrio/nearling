/** An unsent invitation belongs to this tab, never to a public URL or another browser. */
export interface DebateDraft {
  accountId: string;
  tokenId: string;
  epoch: number;
  selectedPet: string;
  topic: string;
  openerPet: string;
  open: boolean;
}

export const DRAFT_KEY = 'debate:draft';

export function readDraft(tokenId: string, accountId: string, storage: Pick<Storage, 'getItem'> = sessionStorage, epoch?: number): DebateDraft | null {
  try {
    const raw = storage.getItem(DRAFT_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const row = value as Record<string, unknown>;
    return row.tokenId === tokenId && row.accountId === accountId && Number.isSafeInteger(row.epoch) && (epoch === undefined || row.epoch === epoch) &&
      typeof row.selectedPet === 'string' && typeof row.topic === 'string' &&
      typeof row.openerPet === 'string' && typeof row.open === 'boolean'
      ? { accountId, tokenId, epoch: row.epoch as number, selectedPet: row.selectedPet, topic: row.topic, openerPet: row.openerPet, open: row.open } : null;
  } catch { return null; }
}

export function saveDraft(draft: DebateDraft, storage: Pick<Storage, 'setItem'> = sessionStorage): void {
  try { storage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* tab storage can be unavailable */ }
}

export function eraseDraft(storage: Pick<Storage, 'removeItem'> = sessionStorage): void {
  try { storage.removeItem(DRAFT_KEY); } catch { /* site data was erased */ }
}

export function utcDay(at: number): number { return Math.floor(at / 86_400_000); }
export function needsEligibilityRecheck(checkedAt: number, now: number): boolean { return utcDay(checkedAt) !== utcDay(now); }
