// The queue of the server key's transactions: one instance, one transaction at a time, one
// `Account` with its nonce cache. A birth from a request and a batch from the cron meet here, so
// they never sign with the same nonce (design.md › Решения). It writes nothing to storage.
import { DurableObject } from 'cloudflare:workers';
import type { Account, KeyPairSigner } from 'near-api-js';
import { ChainUnreachable, serverAccount, signAndSend, type SendResult, type ServerCall } from '../chain';

export type ServerKeyAnswer = SendResult | { status: 'unreachable' };

export class ServerKey extends DurableObject<Env> {
  private keys: { account: Account; signer: KeyPairSigner } | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  /** Sends one call after the ones already queued; the answer is the transaction's outcome. */
  send(call: ServerCall): Promise<ServerKeyAnswer> {
    const run = this.tail.then(() => this.run(call));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async run(call: ServerCall): Promise<ServerKeyAnswer> {
    try {
      this.keys ??= serverAccount(this.env);
      return await signAndSend(this.env, this.keys, call);
    } catch (e) {
      if (e instanceof ChainUnreachable) return { status: 'unreachable' };
      throw e;
    }
  }
}
