// Closing the sessions of thoughts and debiting them (Session debit contract, ADR-004). A session
// closes after 10 minutes without a thought and at 00:00 UTC. Its unbilled thoughts go to the
// contract in batches of at most 12, one batch at a time, each only after the outcome of the one
// before; `debit_id` is the last one the contract accepted plus one.
//
// One tick at a time: a tick claims a session before it works on it (`claimed_at`), and a pet's
// sessions go one after the other, because `debit_id` is the pet's, not the session's. What a tick
// knows of a session comes from its claim, never from a list read before it, and it signs only
// while the claim is still its own.
// `debit_sessions.debit_id` is written before a batch is signed and cleared in the same write that
// settles the batch, so a set `debit_id` means «signed, outcome not written down»: whatever died in
// between, the next tick looks at the chain before it signs anything, and a batch that may be on
// the chain only ever goes out under that id. A second id for it is the one way to debit it twice.
import { ChainUnreachable, petView, txStatus } from './chain';
import { utcDay } from './http';
import { gasShareYocto, nearUsdRate, yoctoToUsdMicros } from './pricing';
import { gasIsLow } from './servicePause';

const SESSION_QUIET_MS = 10 * 60_000;
export const MAX_THOUGHTS_PER_DEBIT = 12;
/** A claim older than this belongs to a tick that died; a live tick renews it at every batch. */
const CLAIM_STALE_MS = 5 * 60_000;
const TGAS = 1_000_000_000_000n;

interface Session {
  id: string;
  token_id: string;
  debit_id: number | null;
  tx_hash: string | null;
  last_at: number;
}

interface ThoughtRow {
  id: string;
  model: string;
  price_yocto: string;
}

interface CallRow {
  thought_id: string;
  req_sha256: string;
  res_sha256: string;
  signature: string;
  sig_kind: string;
  signer: string;
  tokens_in: number;
  tokens_out: number;
  tokens_reasoning: number;
  cut: number;
}

function micros(env: Env, yocto: bigint): number {
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  return rate === null ? 0 : yoctoToUsdMicros(yocto, rate);
}

/** The gas to attach: 15 Tgas for a batch of 12 (the sandbox measured 9.78 with a margin of 1.5),
 * fewer thoughts less, never under 5. */
export function gasFor(thoughts: number): string {
  const tgas = Math.min(15, Math.max(5, Math.ceil(thoughts * 1.25)));
  return (BigInt(tgas) * TGAS).toString();
}

/** A tick's hold on a session: `stamp` is what `claimed_at` says while the session is this tick's. */
interface Claim {
  stamp: number;
  clock: () => number;
}

/** Takes the session for this tick, and with it the session as it stands now; null when a live tick
 * holds it. */
function claim(env: Env, sessionId: string, stamp: number): Promise<Session | null> {
  return env.DB.prepare(
    "UPDATE debit_sessions SET claimed_at = ? WHERE id = ? AND status = 'sending' AND (claimed_at IS NULL OR claimed_at < ?) RETURNING id, token_id, debit_id, tx_hash, last_at",
  )
    .bind(stamp, sessionId, stamp - CLAIM_STALE_MS)
    .first<Session>();
}

/** Renews the claim; false when another tick has taken the session: this tick leaves it at once. */
async function renew(env: Env, sessionId: string, held: Claim): Promise<boolean> {
  const stamp = held.clock();
  const kept = await env.DB.prepare('UPDATE debit_sessions SET claimed_at = ? WHERE id = ? AND claimed_at = ?').bind(stamp, sessionId, held.stamp).run();
  if (kept.meta.changes !== 1) return false;
  held.stamp = stamp;
  return true;
}

/** Closes the sessions that are due and debits what every closed session still owes. */
export async function closeAndDebit(env: Env, nowMs: number): Promise<void> {
  await env.DB.prepare("UPDATE debit_sessions SET status = 'sending' WHERE status = 'open' AND (last_at <= ? OR day < ?)")
    .bind(nowMs - SESSION_QUIET_MS, utcDay(nowMs))
    .run();
  const due = await env.DB.prepare("SELECT id, token_id FROM debit_sessions WHERE status = 'sending' ORDER BY opened_at, rowid").all<Pick<Session, 'id' | 'token_id'>>();
  if (due.results.length === 0) return;
  // The balance is read before the debits too; a pause does not stop them (Service pause data).
  await gasIsLow(env, nowMs).catch(() => false);
  // A pet whose earlier session is not finished (or is another tick's) waits: its ids go in order.
  const waiting = new Set<string>();
  // `nowMs` is when the tick began and a tick can run for minutes; the offset keeps a given `nowMs`.
  const startedAt = Date.now();
  const clock = () => nowMs + (Date.now() - startedAt);
  // The last id each pet had accepted in this tick: an RPC may answer from a block before it.
  const accepted = new Map<string, number>();
  for (const { id, token_id } of due.results) {
    if (waiting.has(token_id)) continue;
    waiting.add(token_id);
    const stamp = clock();
    const session = await claim(env, id, stamp);
    if (session === null) continue;
    const held: Claim = { stamp, clock };
    try {
      if (await debitSession(env, session, held, accepted)) waiting.delete(token_id);
    } catch (e) {
      if (!(e instanceof ChainUnreachable)) console.log('debit_failed');
    } finally {
      await env.DB.prepare('UPDATE debit_sessions SET claimed_at = NULL WHERE id = ? AND claimed_at = ?').bind(id, held.stamp).run();
    }
  }
}

async function nextBatch(env: Env, sessionId: string): Promise<ThoughtRow[]> {
  return (
    await env.DB.prepare("SELECT id, model, price_yocto FROM thoughts WHERE session_id = ? AND status = 'unbilled' ORDER BY created_at, rowid LIMIT ?")
      .bind(sessionId, MAX_THOUGHTS_PER_DEBIT)
      .all<ThoughtRow>()
  ).results;
}

/** Writes a batch's outcome and clears the batch in flight, in one write. Returns how many thoughts
 * changed: a thought that is not `unbilled` any more keeps its status. `debitId` is the batch's own
 * (null: never signed): a late answer never clears the next batch of the tick that took over. */
async function settle(env: Env, sessionId: string, debitId: number | null, ids: string[], status: 'billed' | 'project'): Promise<number> {
  const [marked] = await env.DB.batch([
    env.DB.prepare(`UPDATE thoughts SET status = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'unbilled'`).bind(status, ...ids),
    env.DB.prepare('UPDATE debit_sessions SET debit_id = NULL, tx_hash = NULL WHERE id = ? AND debit_id IS ?').bind(sessionId, debitId),
  ]);
  return marked?.meta.changes ?? 0;
}

/** The only signature of a batch was refused for its id: nothing of it is on the chain, the next
 * tick takes a fresh id. Not for a tick that lost the session: the new tick may have signed again. */
async function forget(env: Env, sessionId: string, debitId: number, held: Claim): Promise<void> {
  await env.DB.prepare('UPDATE debit_sessions SET debit_id = NULL, tx_hash = NULL WHERE id = ? AND debit_id = ? AND claimed_at = ?').bind(sessionId, debitId, held.stamp).run();
}

/** What became of a batch signed under `debitId`: the transaction's own status when its hash is
 * known, then the contract's `last_debit_id`. A pet's sessions run one at a time, so that id can
 * only be this batch. */
async function outcomeOf(env: Env, tokenId: string, debitId: number, tx: string | null): Promise<'billed' | 'unknown' | { refused: string }> {
  if (tx !== null) {
    const known = await txStatus(env, tx, env.SERVER_ACCOUNT_ID);
    if (known?.status === 'ok') return 'billed';
    if (known?.status === 'failed' && known.code !== 'bad_debit_id') return { refused: known.code };
  }
  const pet = await petView(env, tokenId);
  return pet !== null && pet.last_debit_id >= debitId ? 'billed' : 'unknown';
}

/** True when nothing of the session is left to debit; false when the next tick has to go on. */
async function debitSession(env: Env, session: Session, held: Claim, accepted: Map<string, number>): Promise<boolean> {
  // A batch signed under this id whose outcome was never written down.
  let inFlight = session.debit_id;
  let tx = session.tx_hash;
  let lastAt = session.last_at;
  for (;;) {
    if (!(await renew(env, session.id, held))) return false;
    const batch = await nextBatch(env, session.id);
    if (batch.length === 0) {
      await env.DB.prepare("UPDATE debit_sessions SET status = 'done', debit_id = NULL, tx_hash = NULL WHERE id = ?").bind(session.id).run();
      return true;
    }
    const ids = batch.map((t) => t.id);

    const resend = inFlight !== null;
    if (inFlight !== null) {
      // The network's word first, a second signature only after that.
      const outcome = await outcomeOf(env, session.token_id, inFlight, tx);
      if (outcome === 'billed') {
        await settle(env, session.id, inFlight, ids, 'billed');
        accepted.set(session.token_id, inFlight);
        inFlight = null;
        tx = null;
        continue;
      }
      if (outcome !== 'unknown') {
        await reject(env, session.id, inFlight, batch, outcome.refused);
        inFlight = null;
        tx = null;
        continue;
      }
      // Not seen and not applied: wait, and sign again only once the transaction is long past.
      if (tx !== null && held.stamp - lastAt < SESSION_QUIET_MS) return false;
      tx = null;
    }

    // A batch that may be on the chain keeps its id: «not applied» may be a read from an old block,
    // and the contract takes the same batch under the next id. Only a fresh batch gets a fresh id.
    let debitId = inFlight;
    if (debitId === null) {
      const pet = await petView(env, session.token_id);
      if (pet === null) {
        await reject(env, session.id, null, batch, 'no_pet');
        continue;
      }
      debitId = Math.max(pet.last_debit_id, accepted.get(session.token_id) ?? 0) + 1;
    }
    const calls = (
      await env.DB.prepare(
        `SELECT thought_id, req_sha256, res_sha256, signature, sig_kind, signer, tokens_in, tokens_out, tokens_reasoning, cut FROM thought_calls WHERE thought_id IN (${ids.map(() => '?').join(',')}) ORDER BY thought_id, n`,
      )
        .bind(...ids)
        .all<CallRow>()
    ).results;
    const thoughts = batch.map((t) => ({
      model: t.model,
      price: t.price_yocto,
      calls: calls
        .filter((c) => c.thought_id === t.id)
        .map((c) => ({
          req_sha256: c.req_sha256,
          res_sha256: c.res_sha256,
          signature: c.signature,
          sig_kind: c.sig_kind,
          signer: c.signer,
          tokens_in: c.tokens_in,
          tokens_out: c.tokens_out,
          tokens_reasoning: c.tokens_reasoning,
          cut: c.cut === 1,
        })),
    }));
    // The last write before a signature: a tick that lost the session stops here, not on the chain.
    const signedAt = held.clock();
    const kept = await env.DB.prepare('UPDATE debit_sessions SET debit_id = ?, tx_hash = NULL, last_at = ?, claimed_at = ? WHERE id = ? AND claimed_at = ?')
      .bind(debitId, signedAt, signedAt, session.id, held.stamp)
      .run();
    if (kept.meta.changes !== 1) return false;
    held.stamp = signedAt;
    lastAt = signedAt;
    const answer = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
      methodName: 'debit_session',
      args: { token_id: session.token_id, debit_id: debitId, thoughts },
      gas: gasFor(batch.length),
    });
    if (answer.status === 'unreachable') return false;
    if (answer.status === 'ok') {
      await settle(env, session.id, debitId, ids, 'billed');
      accepted.set(session.token_id, debitId);
      inFlight = null;
      await gasOfShortBatch(env, batch.length, answer.burnt);
      continue;
    }
    if (answer.status === 'failed') {
      if (answer.code === 'bad_debit_id') {
        // Out of order, not a refusal of the thoughts.
        if (!resend) {
          await forget(env, session.id, debitId, held);
          return false;
        }
        // A resend is refused only once its id is taken: billed as soon as a read shows it. Until
        // then the id stays, the record of the batch: the read may come from an old block.
        const after = await petView(env, session.token_id);
        if (after === null || after.last_debit_id < debitId) return false;
        await settle(env, session.id, debitId, ids, 'billed');
        accepted.set(session.token_id, debitId);
        inFlight = null;
        continue;
      }
      await reject(env, session.id, debitId, batch, answer.code);
      inFlight = null;
      continue;
    }
    // unknown: remember the hash; the next minute asks the network before signing again
    await env.DB.prepare('UPDATE debit_sessions SET tx_hash = ? WHERE id = ? AND debit_id = ?').bind(answer.txHash, session.id, debitId).run();
    inFlight = debitId;
    tx = answer.txHash;
    // one look now; if the network has not heard of it yet, wait for the next minute
    const look = await txStatus(env, answer.txHash, env.SERVER_ACCOUNT_ID);
    if (look?.status === 'ok') {
      await settle(env, session.id, debitId, ids, 'billed');
      accepted.set(session.token_id, debitId);
      inFlight = null;
      tx = null;
      continue;
    }
    if (look?.status === 'failed' && look.code !== 'bad_debit_id') {
      await reject(env, session.id, debitId, batch, look.code);
      inFlight = null;
      tx = null;
      continue;
    }
    // `bad_debit_id` under the only signature: the same as hearing it above.
    if (look?.status === 'failed' && !resend) await forget(env, session.id, debitId, held);
    return false;
  }
}

/** The contract refused a batch: its thoughts become the project's spend, the unbilled mark is
 * gone, the next batch takes the same `debit_id`. */
async function reject(env: Env, sessionId: string, debitId: number | null, batch: ThoughtRow[], code: string): Promise<void> {
  const total = batch.reduce((sum, t) => sum + BigInt(t.price_yocto), 0n);
  const changed = await settle(env, sessionId, debitId, batch.map((t) => t.id), 'project');
  const usd = changed > 0 ? micros(env, total) : 0;
  if (usd > 0) await env.DB.prepare("INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, 'rejected_batch', ?)").bind(Date.now(), usd).run();
  console.log(`debit_rejected:${code}`);
}

/** A batch of fewer than 4 thoughts burns more gas than the share its thoughts bring: the
 * difference is the project's (`tokens_burnt` of the outcome). */
async function gasOfShortBatch(env: Env, thoughts: number, burnt: string | undefined): Promise<void> {
  if (burnt === undefined || thoughts >= 4) return;
  const extra = BigInt(burnt) - gasShareYocto(env) * BigInt(thoughts);
  const usd = extra > 0n ? micros(env, extra) : 0;
  if (usd > 0) await env.DB.prepare("INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, 'gas', ?)").bind(Date.now(), usd).run();
}
