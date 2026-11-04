import { useCallback, useEffect, useState } from 'react';
import { config } from '../config';
import { nearRpc, type NearRpc } from '../seams/rpc';
import { workerApi, type VerificationIndex } from '../seams/worker';
import { characterHash, eventFromOutcome, type ChainPetRecord } from './record';
import { outcomeFor } from './checkMachine';

export type SealState = { kind: 'checking' | 'unavailable' | 'mismatch'; hash: null }
  | { kind: 'checked'; hash: string };

export async function readSeal(rpc: NearRpc, index: () => Promise<VerificationIndex>, tokenId: string,
  contractId: string, signerId: string): Promise<SealState> {
  try {
    const pet = await rpc.viewFunction<ChainPetRecord | null>(contractId, 'pet_view', { token_id: tokenId });
    if (!pet || typeof pet.character !== 'string') return { kind: 'unavailable', hash: null };
    const hash = await characterHash(pet.character);
    // The Worker only holds a pointer to the hatch transaction. It cannot decide whether
    // the current character was read from NEAR, so an index outage does not erase that Seal.
    const record = await index().catch(() => null);
    if (record === null || record.tokenId !== tokenId) return { kind: 'checked', hash };
    const birth = record.transactions.find((tx) => tx.kind === 'birth' && tx.ref === 'birth');
    if (birth) {
      const result = await outcomeFor(rpc, birth.txHash, signerId, birth.at);
      if (result.kind !== 'found') return { kind: 'checked', hash };
      const event = eventFromOutcome(result.outcome, tokenId, contractId);
      if (event?.event === 'pet_born' && typeof event.data.character_sha256 === 'string'
        && event.data.character_sha256.toLowerCase() !== hash) return { kind: 'mismatch', hash: null };
    }
    return { kind: 'checked', hash };
  } catch { return { kind: 'unavailable', hash: null }; }
}

/** Pet's Seal lives only in tab memory. Navigation, re-visibility and record changes re-read NEAR. */
export function useSeal(tokenId: string, resetKey = '') {
  const [state, setState] = useState<SealState>({ kind: 'checking', hash: null });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) retry(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', retry);
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('pageshow', retry); };
  }, [retry]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const midnight = () => {
      const now = Date.now();
      const next = Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000;
      timer = setTimeout(() => { retry(); midnight(); }, next - now);
    };
    midnight();
    return () => clearTimeout(timer);
  }, [retry]);
  useEffect(() => {
    let current = true;
    setState({ kind: 'checking', hash: null });
    void readSeal(nearRpc, () => workerApi.verificationIndex(tokenId), tokenId,
      config.contractId, config.serverAccountId).then((result) => { if (current) setState(result); });
    return () => { current = false; };
  }, [tokenId, resetKey, attempt]);
  return { state, retry };
}
