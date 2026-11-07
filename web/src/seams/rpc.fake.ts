import { fakeState } from './fakes';
import type { NearRpc } from './rpc';

export const fakeNearRpc: NearRpc = {
  async viewFunction<T>(_contractId: string, methodName: string, args: Record<string, unknown>) {
    const configured = fakeState().rpc?.viewResults?.[methodName];
    if (configured && typeof configured === 'object' && 'fail' in configured) throw new Error(String(configured.fail));
    if (configured !== undefined) return configured as T;
    if (methodName === 'pet_view') {
      const id = String(args.token_id ?? '9');
      const pet = fakeState().worker?.pets?.[id];
      const shared = fakeState().worker?.sharedErrand;
      const oldReserve = pet?.owner?.oldSharedReserve;
      return { owner_id: 'a'.repeat(64), name: pet?.name ?? 'Pixel',
        character: id === '9' ? 'Curious and a little dramatic; counts things when nervous, loves small rituals.'
          : id === '5' ? 'Calm and precise; answers in short lines and finishes one thought before starting the next.'
            : `Curious ${pet?.name ?? 'pet'}.`,
        born_at: 1793034180000000000, stage: pet?.stage === 'baby' ? 'Baby' : pet?.stage === 'teen' ? 'Teen' : 'Adult',
        traits: [], outfits: [], shared_job: oldReserve
          ? { hash: oldReserve.jobHash, state: 'transferred', linked_near: oldReserve.amountYocto, linked_snack: '0' }
          : shared && 'state' in shared && shared.state !== 'empty'
            ? { hash: 'b'.repeat(64), state: 'funding', linked_near: shared.funded ?? '0', linked_snack: '0' } : null, } as T;
    }
    if (methodName === 'contract_source_metadata') return { version: '0.1.0', link: 'https://github.com/magestrio/nearling' } as T;
    if (methodName === 'experience_view') {
      const id = String(args.token_id ?? '9');
      if (!fakeState().worker?.pets?.[id]) return null as T;
      const counts = fakeState().worker?.workRecord;
      const c = counts && !('fail' in counts) ? counts.counts : { paidHires: 0, completedErrands: 0, countedSince: Date.UTC(2026, 10, 7) * 1_000_000 };
      return { token_id: id, paid_hires: c.paidHires, completed_errands: c.completedErrands, counted_since: c.countedSince } as T;
    }
    return (fakeState().rpc?.viewResult ?? '0.1.0') as T;
  },
  async getBalance() {
    return BigInt(fakeState().rpc?.balanceYocto ?? '100000000000000000000000');
  },
  async transaction(hash, _signerId, archive = false) {
    const rpc = fakeState().rpc;
    if (rpc?.transactionDelayMs && (!rpc.transactionDelayHash || rpc.transactionDelayHash === hash))
      await new Promise((resolve) => setTimeout(resolve, rpc.transactionDelayMs));
    const answer = archive && rpc?.archiveOutcome !== undefined ? rpc.archiveOutcome
      : rpc?.outcomes?.[hash] ?? rpc?.outcome;
    if (answer && typeof answer === 'object' && 'fail' in answer) throw new Error(String(answer.fail));
    return answer ?? null;
  },
  async transfer() {
    const s = fakeState().rpc;
    return { txHash: s?.txHash ?? 'FakeTxHash1111111111111111111111111111111111', ok: s?.txOk ?? true };
  },
};
