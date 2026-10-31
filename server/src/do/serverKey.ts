// The queue of the project keys' transactions: one instance, one transaction at a time, one
// `Account` with its nonce cache. The `server` instance carries the server key's calls (a birth from
// a request and a batch from the cron meet here, so they never sign with the same nonce); the `gas`
// instance carries the gas account's transfers (`Feeding gas data`; `add-gift` reuses it). Two
// instances because two keys have two sets of nonces. It writes nothing to storage.
import { DurableObject } from 'cloudflare:workers';
import type { Account, KeyPairSigner } from 'near-api-js';
import { ChainUnreachable, gasAccount, serverAccount, signAndSend, signAndSendTransfer, type SendResult, type ServerCall } from '../chain';

export type ServerKeyAnswer = SendResult | { status: 'unreachable' };

export class ServerKey extends DurableObject<Env> {
  private keys: { account: Account; signer: KeyPairSigner } | null = null;
  private gasKeys: { account: Account; signer: KeyPairSigner } | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  /** Sends one call after the ones already queued; the answer is the transaction's outcome. */
  send(call: ServerCall): Promise<ServerKeyAnswer> {
    return this.enqueue(async () => {
      this.keys ??= serverAccount(this.env);
      return signAndSend(this.env, this.keys, call);
    });
  }

  /** Sends NEAR from the gas account to `receiver` (the `gas` instance). */
  transfer(receiver: string, yocto: string): Promise<ServerKeyAnswer> {
    return this.enqueue(async () => {
      this.gasKeys ??= gasAccount(this.env);
      return signAndSendTransfer(this.gasKeys, receiver, BigInt(yocto));
    });
  }

  private enqueue(work: () => Promise<SendResult>): Promise<ServerKeyAnswer> {
    const run = this.tail.then(() => this.run(work));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async run(work: () => Promise<SendResult>): Promise<ServerKeyAnswer> {
    try {
      return await work();
    } catch (e) {
      if (e instanceof ChainUnreachable) return { status: 'unreachable' };
      throw e;
    }
  }
}
