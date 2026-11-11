// The queue of the project keys' transactions: one instance, one transaction at a time, one
// `Account` with its nonce cache. The `server` instance carries the server key's calls (a birth from
// a request and a batch from the cron meet here, so they never sign with the same nonce); the `gas`
// instance carries the gas account's transfers (`Feeding gas data`; `add-gift` reuses it). Two
// instances because two keys have two sets of nonces. It writes nothing to storage of its own; a call that
// may write an item notes the hash of each transaction it signs in `item_sends` before the broadcast.
import { DurableObject } from 'cloudflare:workers';
import type { Account, KeyPairSigner } from 'near-api-js';
import { ChainUnreachable, gasAccount, serverAccount, signAndSend, signAndSendTransfer, type SendResult, type ServerCall } from '../chain';
import { noteItemSend } from '../pet/itemTx';

export type ServerKeyAnswer = SendResult | { status: 'unreachable' };

export class ServerKey extends DurableObject<Env> {
  private keys: { account: Account; signer: KeyPairSigner } | null = null;
  private gasKeys: { account: Account; signer: KeyPairSigner } | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  /** Sends one call after the ones already queued; the answer is the transaction's outcome. */
  send(call: ServerCall): Promise<ServerKeyAnswer> {
    return this.enqueue(async () => {
      this.keys ??= serverAccount(this.env);
      const { writes } = call;
      return signAndSend(this.env, this.keys, call, writes === undefined ? undefined : async (hash, bytes) => {
        if (writes.kind === 'shared_open') {
          const noted = await this.env.DB.prepare("UPDATE shared_errands SET open_tx_hash = ?, open_signed_bytes = ? WHERE token_id = ? AND job_hash = ? AND state = 'opening'")
            .bind(hash, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), writes.tokenId, writes.jobHash).run();
          if (noted.meta.changes !== 1) throw new ChainUnreachable();
        } else if (writes.kind === 'shared_debit') {
          const noted = await this.env.DB.prepare('UPDATE debit_sessions SET tx_hash = ? WHERE id = ? AND debit_id = ?')
            .bind(hash, writes.sessionId, writes.debitId).run();
          if (noted.meta.changes !== 1) throw new ChainUnreachable();
        } else if (writes.kind === 'debate_debit') {
          const noted = await this.env.DB.prepare(`UPDATE debate_debit_operations SET tx_hash = ?, signed_tx = ?, status = 'sending'
            WHERE debate_id = ? AND line_order = ? AND operation_id = ? AND status = 'prepared'
              AND EXISTS (SELECT 1 FROM debates WHERE id = ? AND status = 'running')`)
            .bind(hash, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
              writes.debateId, writes.lineOrder, writes.operationId, writes.debateId).run();
          if (noted.meta.changes !== 1) throw new ChainUnreachable();
        } else if (writes.kind === 'will_start' || writes.kind === 'will_release') {
          const noted = await this.env.DB.prepare("UPDATE will_operations SET tx_hash = ?, signed_bytes = ? WHERE id = ? AND status = 'sending'")
            .bind(hash, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), writes.op).run();
          if (noted.meta.changes !== 1) throw new ChainUnreachable();
        } else {
          await noteItemSend(this.env.DB, writes, hash, Date.now(), bytes);
        }
      });
    });
  }

  /** Sends NEAR from the gas account to `receiver` (the `gas` instance). */
  transfer(receiver: string, yocto: string, giftClaim?: { sub: string; claimedAt: number; op: string }): Promise<ServerKeyAnswer> {
    return this.enqueue(async () => {
      this.gasKeys ??= gasAccount(this.env);
      return signAndSendTransfer(this.gasKeys, receiver, BigInt(yocto), giftClaim === undefined ? undefined : async (hash, bytes) => {
        const noted = await this.env.DB.prepare('UPDATE players SET gift_topup_flight = ?1, gift_topup_signed_bytes = ?2 WHERE sub = ?3 AND gift_topup_at = ?4 AND gift_topup_op = ?5')
          .bind(hash, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), giftClaim.sub, giftClaim.claimedAt, giftClaim.op).run();
        if (noted.meta.changes !== 1) throw new ChainUnreachable();
      });
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
