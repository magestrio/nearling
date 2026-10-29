// The only module that talks to the NEAR RPC.
import { Account, JsonRpcProvider, type Signer } from 'near-api-js';
import { config } from '../config';

export interface TransferResult {
  txHash: string;
  ok: boolean;
}

export interface NearRpc {
  viewFunction<T>(contractId: string, methodName: string, args: Record<string, unknown>): Promise<T>;
  getBalance(accountId: string): Promise<bigint>;
  /** Signs with `signer` and sends a plain transfer from `accountId`. */
  transfer(args: { accountId: string; signer: Signer; receiverId: string; amountYocto: bigint }): Promise<TransferResult>;
}

function createRealRpc(): NearRpc {
  const provider = new JsonRpcProvider({ url: config.nearRpcUrl });
  return {
    async viewFunction<T>(contractId: string, methodName: string, args: Record<string, unknown>) {
      return (await provider.callFunction({ contractId, method: methodName, args })) as T;
    },
    async getBalance(accountId) {
      return new Account(accountId, provider).getBalance();
    },
    async transfer({ accountId, signer, receiverId, amountYocto }) {
      const outcome = await new Account(accountId, provider, signer).transfer({ receiverId, amount: amountYocto });
      const status = outcome.status;
      const ok = typeof status === 'object' && status !== null && 'SuccessValue' in status;
      return { txHash: outcome.transaction.hash as string, ok };
    },
  };
}

export const nearRpc: NearRpc =
  import.meta.env.VITE_FAKES === 'true' ? (await import('./rpc.fake')).fakeNearRpc : createRealRpc();
