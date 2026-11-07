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
import { ChainUnreachable, isNodeRefusal, petView, txStatus } from './chain';
import { utcDay } from './http';
import { wakeIfFed } from './pet/wake';
import { gasShareYocto, nearUsdRate, yoctoToUsdMicros } from './pricing';
import { gasIsLow } from './servicePause';
import { track } from './track';
import { recordExperienceEvent } from './experience/events';
import { settleSocietyPending } from './society/settlement';
import { noteWishSavings } from './will/purchase';

const SESSION_QUIET_MS = 10 * 60_000;
export const MAX_THOUGHTS_PER_DEBIT = 12;
/** The log bytes a batch may add up to, of the contract's 16,384 for one call (`Session debit contract`, stage 1 of
 * `add-pet-errands`: a four-call receipt at the longest field lengths is 2,265 bytes, the plain two-call one ≈ 1,250,
 * 12 plain ones 15,192). A batch of errands would fail whole at the limit, so it closes here with margin. */
export const MAX_LOG_BYTES_PER_DEBIT = 14_000;
/** A receipt's log at its longest: fixed and per-call bytes, plus the worker field and the separate hire event.
 * The first two terms cover the stage-1 receipt measure; the latter terms keep a hire batch below the log cap. */
// The receipt now serializes `completed_errand` even when false (25 bytes including JSON punctuation).
const RECEIPT_BASE_BYTES = 275;
const RECEIPT_CALL_BYTES = 510;
const WORKER_BYTES = 60;
const HIRE_EVENT_BYTES = 300;
export const receiptBytes = (calls: number, worker = false, hire = false): number =>
  RECEIPT_BASE_BYTES + RECEIPT_CALL_BYTES * calls + (worker ? WORKER_BYTES : 0) + (hire ? HIRE_EVENT_BYTES : 0);
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
  job_hash: string | null;
  /** How many calls the receipt holds: the batch is cut by the size of its logs, not by the thoughts alone. */
  calls: number;
  model: string;
  price_yocto: string;
  /** The pet whose answer this thought is (advice, a hire's answer), also an answer with no words: it travels
   * with the receipt (`Hire food data`). Null for every thought of the paying pet itself. */
  worker: string | null;
  /** The hire this answer is the fee of, while it is not settled; null for none. */
  hire_id: string | null;
  hire_kind: 'player' | 'pet' | null;
  hire_mode: 'auto' | 'manual' | null;
  hire_skilled: number | null;
  /** 1 when the answer read a data source (`pet_hired { adapter }`). */
  hire_adapter: number | null;
  hire_experience: number | null;
  hire_discounted: number | null;
  hire_fee: string | null;
  /** Only a shown, successful owner errand can carry the chain marker. */
  completed_errand: number;
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

/** First counted debit measured 2.588626 Tgas vs 2.409617 Tgas ordinary (experience.rs);
 * 0.17901 × 1.5 rounds to 0.27 Tgas per counted receipt. Existing categories keep their margins. */
export function gasFor(thoughts: number, hires = 0, manyCalls = 0, counted = 0): string {
  // A thought of 3–4 calls burns 1.47 Tgas in the sandbox: ×1.5 is 2.25 (`add-pet-errands`).
  const tgas = Math.max(5, Math.ceil((thoughts - hires - manyCalls) * 1.25 + hires * 1.9 + manyCalls * 2.25 + counted * 0.27));
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

/** The shared errand's own session is sent as soon as its paid outcome is stored. */
export async function debitSharedNow(env: Env, tokenId: string, jobHash: string): Promise<void> {
  const row = await env.DB.prepare('SELECT id FROM debit_sessions WHERE token_id = ? AND shared_job_hash = ?')
    .bind(tokenId, jobHash).first<{ id: string }>();
  if (row === null) return;
  await env.DB.prepare("UPDATE debit_sessions SET status = 'sending' WHERE id = ? AND status = 'open'").bind(row.id).run();
  const stamp = Date.now();
  const session = await claim(env, row.id, stamp);
  if (session === null) return;
  const held: Claim = { stamp, clock: () => Date.now() };
  try { await debitSession(env, session, held, new Map()); }
  finally { await env.DB.prepare('UPDATE debit_sessions SET claimed_at = NULL WHERE id = ? AND claimed_at = ?').bind(row.id, held.stamp).run(); }
}

/** A watch owns one session, separate from the owner's conversation. Close it as soon as its
 * signed call has been stored so a quiet check can expose a real receipt. */
export async function debitWatchNow(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare("UPDATE debit_sessions SET status = 'sending' WHERE id = ? AND status = 'open'").bind(sessionId).run();
  const stamp = Date.now();
  const session = await claim(env, sessionId, stamp);
  if (session === null) return;
  const held: Claim = { stamp, clock: () => Date.now() };
  try { await debitSession(env, session, held, new Map()); }
  finally { await env.DB.prepare('UPDATE debit_sessions SET claimed_at = NULL WHERE id = ? AND claimed_at = ?').bind(sessionId, held.stamp).run(); }
}

/** The next thoughts to debit. A worker's answer (kind `advice` or `hire_answer`, a hire question is the paying pet's
 * own thought) carries its worker whatever came of it; an unsettled hire of it rides along. */
async function nextBatch(env: Env, sessionId: string): Promise<ThoughtRow[]> {
  const rows = (
    await env.DB.prepare(
      `SELECT t.id, t.model, t.price_yocto, t.shared_job_hash AS job_hash, CASE WHEN t.kind IN ('advice', 'hire_answer') THEN t.worker_id END AS worker,
              t.completed_errand,
              (SELECT COUNT(*) FROM thought_calls c WHERE c.thought_id = t.id) AS calls,
              h.id AS hire_id, h.kind AS hire_kind, h.mode AS hire_mode, h.skilled AS hire_skilled, h.fee_yocto AS hire_fee, (t.data_labels IS NOT NULL) AS hire_adapter, h.experience AS hire_experience, h.society_discounted AS hire_discounted
       FROM thoughts t LEFT JOIN hires h ON h.answer_thought_id = t.id AND h.status = 'unbilled'
       WHERE t.session_id = ? AND t.status = 'unbilled' ORDER BY t.created_at, t.rowid LIMIT ?`,
    )
      .bind(sessionId, MAX_THOUGHTS_PER_DEBIT)
      .all<ThoughtRow>()
  ).results;
  // The batch closes at 12 thoughts or at the size of the logs it would write, whichever comes first; one thought
  // always goes (its own receipt is far under the limit).
  let bytes = 0;
  const batch: ThoughtRow[] = [];
  for (const row of rows) {
    bytes += receiptBytes(row.calls, row.worker !== null, row.hire_id !== null) + (row.job_hash === null ? 0 : 700);
    if (batch.length > 0 && bytes > MAX_LOG_BYTES_PER_DEBIT) break;
    batch.push(row);
  }
  return batch;
}

/** Writes a batch's outcome and clears the batch in flight, in one write. Returns how many thoughts
 * changed: a thought that is not `unbilled` any more keeps its status. `debitId` is the batch's own
 * (null: never signed): a late answer never clears the next batch of the tick that took over. */
async function settle(env: Env, session: Pick<Session, 'id' | 'token_id'>, debitId: number | null, batch: ThoughtRow[], status: 'billed' | 'project', rejected = '', txHash: string | null = null): Promise<number> {
  const ids = batch.map((t) => t.id);
  const inIds = `(${ids.map(() => '?').join(',')})`;
  const hires = batch.filter((t) => t.hire_id !== null);
  const statements: D1PreparedStatement[] = [];
  // The hires of the batch settle in the same write as their answers, never after: a hire whose answer is billed
  // and which is still `unbilled` would take its fee out of the food a second time (`Pet food data`). They go first,
  // while their answers are still `unbilled`: a batch another tick settled already moves nothing.
  const live = `answer_thought_id IN ${inIds} AND status = 'unbilled' AND EXISTS (SELECT 1 FROM thoughts t WHERE t.id = hires.answer_thought_id AND t.status = 'unbilled')`;
  if (hires.length > 0 && status === 'billed') {
    // The hirer as the network has it after the batch: the day of the record is the contract's, and the name is
    // the hirer's in the work record. A stale read (the batch not in it yet) gives the Worker's clock.
    const pet = await petView(env, session.token_id);
    const day = pet !== null && debitId !== null && pet.last_debit_id >= debitId ? pet.debit_day : utcDay(Date.now());
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO work_records (hire_id, worker_id, hirer_id, hirer_name, fee_yocto, answer_yocto, earned_usd_micros, kind, day, recorded_at)
         SELECT hires.id, hires.worker_id, hires.hirer_id, ?, hires.fee_yocto, (SELECT price_yocto FROM thoughts t WHERE t.id = hires.answer_thought_id),
                MAX(hires.fee_usd_micros - (SELECT price_usd_micros FROM thoughts t WHERE t.id = hires.answer_thought_id), 0), hires.kind, ?, ?
         FROM hires WHERE ${live}`,
      ).bind(pet?.name ?? '', day, Date.now(), ...ids),
      env.DB.prepare(`UPDATE hires SET status = 'recorded', record_day = ? WHERE ${live}`).bind(day, ...ids),
    );
  } else if (hires.length > 0) {
    statements.push(env.DB.prepare(`UPDATE hires SET status = 'dropped', dropped_code = ? WHERE ${live}`).bind(rejected, ...ids));
  }
  const hasStaged = (await env.DB.prepare(`SELECT source_thought_id FROM experience_notes WHERE source_thought_id IN ${inIds} AND status = 'staged' LIMIT 1`).bind(...ids).first()) !== null;
  let noteActivationAt: number | null = null;
  if (hasStaged) {
    // A confirmed debit can race a gift or a memory clear. Read the current chain owner before the atomic
    // status change; a failed read leaves the batch in flight for reconciliation instead of approving stale data.
    const current = status === 'billed' ? await petView(env, session.token_id) : null;
    noteActivationAt = statements.length;
    statements.push(env.DB.prepare(
      `UPDATE experience_notes SET status = 'active' WHERE source_thought_id IN ${inIds} AND status = 'staged'
       AND owner_account = ? AND owner_generation = ? AND memory_epoch = (SELECT memory_epoch FROM pets WHERE token_id = experience_notes.token_id)
       AND EXISTS (SELECT 1 FROM thoughts t WHERE t.id = experience_notes.source_thought_id AND t.status = 'unbilled' AND t.erased_at IS NULL)`,
    ).bind(...ids, current?.owner_id ?? '', current?.transfer_generation ?? -1));
    statements.push(env.DB.prepare(`DELETE FROM experience_notes WHERE source_thought_id IN ${inIds} AND status = 'staged'`).bind(...ids));
    if (status === 'billed') statements.push(env.DB.prepare(
      `DELETE FROM experience_notes WHERE token_id = ? AND status = 'active' AND source_thought_id NOT IN
       (SELECT source_thought_id FROM experience_notes WHERE token_id = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 6)`,
    ).bind(session.token_id, session.token_id));
    if (status === 'billed') statements.push(env.DB.prepare(
      `DELETE FROM experience_field WHERE token_id = ? AND source_thought_id NOT IN
       (SELECT source_thought_id FROM experience_notes WHERE token_id = ? AND status = 'active')`,
    ).bind(session.token_id, session.token_id));
  }
  const at = statements.length;
  statements.push(
    env.DB.prepare(`UPDATE thoughts SET status = ?, debit_tx_hash = ?, debit_refusal_code = ? WHERE id IN ${inIds} AND status = 'unbilled'`)
      .bind(status, status === 'billed' ? txHash : null, status === 'project' ? rejected || null : null, ...ids),
    env.DB.prepare('UPDATE debit_sessions SET debit_id = NULL, tx_hash = NULL WHERE id = ? AND debit_id IS ?').bind(session.id, debitId),
  );
  const results = await env.DB.batch(statements);
  const changed = results[at]?.meta.changes ?? 0;
  if (changed > 0 && status === 'billed' && noteActivationAt !== null) {
    for (let i = 0; i < (results[noteActivationAt]?.meta.changes ?? 0); i += 1) {
      track('experience_note_saved', { source: 'errand' });
      await recordExperienceEvent(env, 'experience_note_saved');
    }
  }
  if (changed > 0 && status === 'billed') {
    const accepted = hires.filter((h) => h.hire_id !== null);
    const recorded: ThoughtRow[] = [];
    for (const hire of accepted) {
      const row = await env.DB.prepare("SELECT 1 AS found FROM hires WHERE id = ? AND status = 'recorded'")
        .bind(hire.hire_id).first();
      if (row !== null) recorded.push(hire);
    }
    await afterRecord(env, recorded);
    await noteWishSavings(env, recorded.map((hire) => hire.worker).filter((id): id is string => id !== null));
    await settleSocietyPending(env).catch(() => console.log('society_settle_failed'));
  }
  return changed;
}

/** What follows a hire the network took: the worker wakes on the earning, the event is counted (`Worker rule` ›
 * «заработок записан»). Best effort: the batch is settled whatever happens here, and the worker's owner wakes it
 * with the next poll otherwise. */
async function afterRecord(env: Env, hires: ThoughtRow[]): Promise<void> {
  for (const hire of hires) {
    track('pet_hired', { by: hire.hire_kind ?? 'player', ...(hire.hire_kind === 'pet' && hire.hire_mode !== null ? { mode: hire.hire_mode } : {}), skill: hire.hire_skilled === 1, adapter: hire.hire_adapter === 1, experience: hire.hire_experience === 1, discounted: hire.hire_discounted === 1 });
    await recordExperienceEvent(env, 'pet_hired', { experience: hire.hire_experience === 1,
      discounted: hire.hire_discounted === 1, id: hire.hire_id ?? undefined });
  }
  for (const worker of new Set(hires.map((t) => t.worker))) {
    if (worker === null) continue;
    await wakeIfFed(env, worker, 'work').catch(() => console.log('work_wake_failed'));
  }
}

/** The only signature of a batch was refused for its id: nothing of it is on the chain, the next
 * tick takes a fresh id. Not for a tick that lost the session: the new tick may have signed again. */
async function forget(env: Env, sessionId: string, debitId: number, held: Claim): Promise<void> {
  await env.DB.prepare('UPDATE debit_sessions SET debit_id = NULL, tx_hash = NULL WHERE id = ? AND debit_id = ? AND claimed_at = ?').bind(sessionId, debitId, held.stamp).run();
}

/** What became of a batch signed under `debitId`: the transaction's own status when its hash is
 * known, then the contract's `last_debit_id`. A pet's sessions run one at a time, so that id can
 * only be this batch. */
async function outcomeOf(env: Env, tokenId: string, debitId: number, tx: string | null): Promise<{ billed: string | null } | 'unknown' | { refused: string }> {
  if (tx !== null) {
    const known = await txStatus(env, tx, env.SERVER_ACCOUNT_ID);
    if (known?.status === 'ok') return { billed: tx };
    if (known?.status === 'failed' && known.code !== 'bad_debit_id') return { refused: known.code };
  }
  const pet = await petView(env, tokenId);
  return pet !== null && pet.last_debit_id >= debitId ? { billed: null } : 'unknown';
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
      if (typeof outcome === 'object' && 'billed' in outcome) {
        await settle(env, session, inFlight, batch, 'billed', '', outcome.billed);
        accepted.set(session.token_id, inFlight);
        inFlight = null;
        tx = null;
        continue;
      }
      if (outcome !== 'unknown') {
        await refuse(env, session, inFlight, batch, outcome.refused);
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
        await reject(env, session, null, batch, 'no_pet');
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
      // The worker of an answer, and the hire it is the fee of: the contract writes `hire` right after the receipt.
      ...(t.worker !== null ? { worker: t.worker } : {}),
      ...(t.job_hash === null ? {} : { job_hash: t.job_hash }),
      ...(t.completed_errand === 1 ? { completed_errand: true } : {}),
      ...(t.worker !== null && t.hire_id !== null ? { hire: { kind: t.hire_kind, skill: t.hire_skilled === 1, fee: t.hire_fee } } : {}),
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
    const shared = batch.find((thought) => thought.job_hash !== null);
    const answer = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
      methodName: 'debit_session',
      args: { token_id: session.token_id, debit_id: debitId, thoughts },
      gas: gasFor(batch.length, thoughts.filter((t) => 'hire' in t).length, batch.filter((t, i) => t.calls > 2 && !('hire' in thoughts[i]!)).length, thoughts.filter((t) => 'hire' in t || 'completed_errand' in t).length),
      ...(shared === undefined ? {} : { writes: { kind: 'shared_debit' as const, sessionId: session.id, debitId } }),
    });
    if (answer.status === 'unreachable') return false;
    if (answer.status === 'ok') {
      await settle(env, session, debitId, batch, 'billed', '', answer.txHash);
      accepted.set(session.token_id, debitId);
      inFlight = null;
      await gasOfShortBatch(env, batch.length, answer.burnt);
      continue;
    }
    if (answer.status === 'failed' && !isNodeRefusal(answer.code)) {
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
        await settle(env, session, debitId, batch, 'billed');
        accepted.set(session.token_id, debitId);
        inFlight = null;
        continue;
      }
      await refuse(env, session, debitId, batch, answer.code);
      inFlight = null;
      continue;
    }
    // unknown, or refused by the node (the contract saw nothing, so the thoughts stay to be billed):
    // remember the hash; the next minute asks the network before signing again
    await env.DB.prepare('UPDATE debit_sessions SET tx_hash = ? WHERE id = ? AND debit_id = ?').bind(answer.txHash, session.id, debitId).run();
    inFlight = debitId;
    tx = answer.txHash;
    // one look now; if the network has not heard of it yet, wait for the next minute
    const look = await txStatus(env, answer.txHash, env.SERVER_ACCOUNT_ID);
    if (look?.status === 'ok') {
      await settle(env, session, debitId, batch, 'billed', '', answer.txHash);
      accepted.set(session.token_id, debitId);
      inFlight = null;
      tx = null;
      continue;
    }
    if (look?.status === 'failed' && look.code !== 'bad_debit_id') {
      await refuse(env, session, debitId, batch, look.code);
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
async function reject(env: Env, session: Pick<Session, 'id' | 'token_id'>, debitId: number | null, batch: ThoughtRow[], code: string): Promise<void> {
  const total = batch.reduce((sum, t) => sum + BigInt(t.price_yocto), 0n);
  const changed = await settle(env, session, debitId, batch, 'project', code);
  const usd = changed > 0 ? micros(env, total) : 0;
  if (usd > 0) await env.DB.prepare("INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, 'rejected_batch', ?)").bind(Date.now(), usd).run();
  console.log(`debit_rejected:${code}`);
}

/** The contract's refusal of a batch. `hire:<i>:<code>` is the refusal of one hire (`Hire food data` › «повтор без
 * найма»): the contract applied nothing, that hire is dropped and the same batch goes again under the same `debit_id`
 * with its answer billed by usage and no `hire`. Any other code sends the batch to the project. */
async function refuse(env: Env, session: Pick<Session, 'id' | 'token_id'>, debitId: number | null, batch: ThoughtRow[], code: string): Promise<void> {
  const refused = /^hire:(\d+):([a-z_]+)$/.exec(code);
  const hireId = refused === null ? undefined : batch[Number(refused[1])]?.hire_id;
  if (refused === null || hireId == null) return reject(env, session, debitId, batch, code);
  await env.DB.batch([
    env.DB.prepare("UPDATE hires SET status = 'dropped', dropped_code = ? WHERE id = ? AND status = 'unbilled'").bind(refused[2] ?? '', hireId),
    env.DB.prepare('UPDATE debit_sessions SET debit_id = NULL, tx_hash = NULL WHERE id = ? AND debit_id IS ?').bind(session.id, debitId),
  ]);
  console.log(`hire_dropped:${refused[2]}`);
}

/** A batch of fewer than 4 thoughts burns more gas than the share its thoughts bring: the
 * difference is the project's (`tokens_burnt` of the outcome). */
async function gasOfShortBatch(env: Env, thoughts: number, burnt: string | undefined): Promise<void> {
  if (burnt === undefined || thoughts >= 4) return;
  const extra = BigInt(burnt) - gasShareYocto(env) * BigInt(thoughts);
  const usd = extra > 0n ? micros(env, extra) : 0;
  if (usd > 0) await env.DB.prepare("INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, 'gas', ?)").bind(Date.now(), usd).run();
}
