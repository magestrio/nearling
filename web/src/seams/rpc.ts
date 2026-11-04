// The only module that talks to the NEAR RPC.
import { Account, JsonRpcProvider, type Signer } from 'near-api-js';
import { config } from '../config';

export interface TransferResult {
  txHash: string;
  ok: boolean;
}

/** Raw NEAR RPC transaction response. The verifier validates its shape before trusting it. */
export type TransactionOutcome = unknown;

export interface NearRpc {
  viewFunction<T>(contractId: string, methodName: string, args: Record<string, unknown>): Promise<T>;
  getBalance(accountId: string): Promise<bigint>;
  /** Public, keyless transaction read; archive is used only after a missing old transaction. */
  transaction(hash: string, signerId: string, archive?: boolean): Promise<TransactionOutcome>;
  /** Signs with `signer` and sends a plain transfer from `accountId`. */
  transfer(args: { accountId: string; signer: Signer; receiverId: string; amountYocto: bigint }): Promise<TransferResult>;
}

function createRealRpc(): NearRpc {
  const provider = new JsonRpcProvider({ url: config.nearRpcUrl });
  const archive = new JsonRpcProvider({ url: config.nearNetwork === 'testnet'
    ? 'https://archival-rpc.testnet.fastnear.com'
    : 'https://archival-rpc.mainnet.fastnear.com' });
  return {
    async viewFunction<T>(contractId: string, methodName: string, args: Record<string, unknown>) {
      return (await provider.callFunction({ contractId, method: methodName, args })) as T;
    },
    async getBalance(accountId) {
      return new Account(accountId, provider).getBalance();
    },
    async transaction(hash, signerId, useArchive = false) {
      return (useArchive ? archive : provider).viewTransactionStatus({
        txHash: hash, accountId: signerId, waitUntil: 'EXECUTED_OPTIMISTIC',
      });
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
