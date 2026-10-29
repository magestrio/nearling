import { fakeState } from './fakes';
import type { NearRpc } from './rpc';

export const fakeNearRpc: NearRpc = {
  async viewFunction<T>() {
    return (fakeState().rpc?.viewResult ?? '0.1.0') as T;
  },
  async getBalance() {
    return BigInt(fakeState().rpc?.balanceYocto ?? '100000000000000000000000');
  },
  async transfer() {
    const s = fakeState().rpc;
    return { txHash: s?.txHash ?? 'FakeTxHash1111111111111111111111111111111111', ok: s?.txOk ?? true };
  },
};
