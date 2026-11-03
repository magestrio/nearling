import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { tick } from '../src/cron';
import { MAX_LOG_BYTES_PER_DEBIT, receiptBytes, gasFor } from '../src/debit';
import { DAILY_CAP_YOCTO, gasShareYocto, minCallPrice } from '../src/pricing';
import { run } from '../src/spend';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const MIN = 60_000;
const BIG_FOOD = (100n * BigInt(env.STARTER_FOOD)).toString();

/** `n` ordinary thoughts of pet 5, answered by the desk's own code path (no HTTP). */
async function think(n: number, id = '5') {
  for (let i = 0; i < n; i += 1) {
    const out = await run(env, id, { kind: 'reply', mode: 'chat', text: `line ${i}` });
    expect('thoughtId' in out, JSON.stringify(out)).toBe(true);
  }
}
const statuses = async () => (await env.DB.prepare('SELECT status, COUNT(*) AS n FROM thoughts GROUP BY status').all<{ status: string; n: number }>()).results;
const spend = async () => (await env.DB.prepare('SELECT kind, usd_micros FROM project_spend ORDER BY rowid').all<{ kind: string; usd_micros: number }>()).results;
/** Ten quiet minutes after the last thought: the session closes at the next cron. */
const later = (ms = 11 * MIN) => Date.now() + ms;

describe('Session debit contract', () => {
  // spec: add-pet-errands › Errand debit contract › errand recorded
  it('splits eleven two-call hires with longest receipt fields before their receipt and hire logs can exceed the bound', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: BIG_FOOD });
    const stamp = Date.now();
    const session = 'long-hire-session';
    await env.DB.prepare("INSERT INTO debit_sessions (id, token_id, day, opened_at, last_at, status) VALUES (?, ?, ?, ?, ?, 'open')")
      .bind(session, '5', Math.floor(stamp / 86_400_000), stamp, stamp).run();
    for (let i = 0; i < 11; i += 1) {
      const id = `long-hire-${i}`;
      const worker = String(i + 6).padStart(32, '0');
      h.net().contract.addPet(worker, NEAR_ACCOUNT(2));
      await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, model, price_yocto, price_usd_micros, payer, session_id, status, worker_id, worker_name, skilled) VALUES (?, '5', ?, 'advice', ?, ?, 0, 'pet', ?, 'unbilled', ?, 'Worker', 1)")
        .bind(id, stamp + i, 'm'.repeat(64), '100000000000000000000', session, worker).run();
      for (let n = 0; n < 2; n += 1) {
        await env.DB.prepare('INSERT INTO thought_calls (thought_id, n, req_bytes, res_bytes, req_sha256, res_sha256, signature, sig_kind, signer, completion_id, tokens_in, tokens_out, tokens_reasoning, cut) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)')
          .bind(id, n, new Uint8Array(0), new Uint8Array(0), 'a'.repeat(64), 'b'.repeat(64), `0x${'c'.repeat(130)}`, 'provider_tee', 'd'.repeat(64), `call-${i}-${n}`, 1_000_000_000, 1_000_000_000, 1_000_000_000).run();
      }
      await env.DB.prepare("INSERT INTO hires (id, hirer_id, worker_id, worker_name, kind, skilled, fee_yocto, fee_usd_micros, answer_thought_id, session_id, status, created_at) VALUES (?, '5', ?, 'Worker', 'player', 1, ?, 0, ?, ?, 'unbilled', ?)")
        .bind(`hire-${i}`, worker, '1000000000000000000000', id, session, stamp + i).run();
    }
    expect(receiptBytes(2, true, true) * 9).toBeGreaterThan(MAX_LOG_BYTES_PER_DEBIT);
    await tick(env, later());
    expect(h.net().contract.debits.map((d) => d.thoughts.length)).toEqual([8, 3]);
    expect(await statuses()).toEqual([{ status: 'billed', n: 11 }]);
  });

  // Measured in design.md › Контракт › Gas and logs: 1.47 Tgas per four-call thought, ×1.5 = 2.25.
  // spec: add-pet-errands › Errand debit contract › errand recorded
  it('budgets 2.25 Tgas per three-to-four-call thought with the five Tgas floor', () => {
    expect(gasFor(7, 0, 7)).toBe('16000000000000');
  });

  // spec: add-pet › Session debit contract › больше 12 мыслей в пачке × сессия длиннее 12 мыслей закрылась
  it('splits a session of 25 thoughts into batches of 12, 12 and 1, in the order of debit_id, one after the other', async () => {
    const pet = h.net().contract.addPet('5', OWNER, { project_food: BIG_FOOD, last_debit_id: 6 });
    await think(25);
    await tick(env, later());
    const chain = h.net().contract;
    expect(chain.debits.map((d) => d.thoughts.length)).toEqual([12, 12, 1]);
    expect(chain.debits.map((d) => d.debitId)).toEqual([7, 8, 9]);
    expect(chain.debits.every((d) => d.thoughts.length > 0)).toBe(true);
    expect(pet.last_debit_id).toBe(9);
    expect(await statuses()).toEqual([{ status: 'billed', n: 25 }]);
    // the sum of the batches left the food
    const prices = (await env.DB.prepare('SELECT price_yocto FROM thoughts').all<{ price_yocto: string }>()).results.reduce((s, r) => s + BigInt(r.price_yocto), 0n);
    expect(BigInt(pet.project_food)).toBe(BigInt(BIG_FOOD) - prices);
    // the session is done and nothing is sent again
    await tick(env, later(30 * MIN));
    expect(chain.debits).toHaveLength(3);
    expect((await env.DB.prepare('SELECT status FROM debit_sessions').first<{ status: string }>())!.status).toBe('done');
  });

  // Design: the batch's arguments are the fields of the receipts (design.md › Worker).
  it('sends the arguments of a batch as the fields of the receipts it holds, to the contract only after the quiet', async () => {
    h.net().contract.addPet('5', OWNER);
    await think(2);
    await tick(env, later(5 * MIN));
    expect(h.net().contract.debits).toEqual([]);
    await tick(env, later());
    const [batch] = h.net().contract.debits;
    expect(batch!.tokenId).toBe('5');
    const rows = (await env.DB.prepare('SELECT * FROM thoughts ORDER BY created_at, rowid').all<any>()).results;
    expect(batch!.thoughts).toHaveLength(2);
    for (const [i, row] of rows.entries()) {
      const call = (await env.DB.prepare('SELECT * FROM thought_calls WHERE thought_id = ?').bind(row.id).first<any>())!;
      expect(batch!.thoughts[i]).toEqual({
        model: env.MODEL_ID,
        price: row.price_yocto,
        calls: [
          {
            req_sha256: call.req_sha256,
            res_sha256: call.res_sha256,
            signature: call.signature,
            sig_kind: 'provider_tee',
            signer: call.signer,
            tokens_in: call.tokens_in,
            tokens_out: call.tokens_out,
            tokens_reasoning: call.tokens_reasoning,
            cut: false,
          },
        ],
      });
    }
    // no reply text, no line, no account in anything that went to the chain
    const sent = JSON.stringify(h.net().contract.sends);
    expect(sent).not.toMatch(/Hello there|line 0/);
  });

  // Design: an unknown outcome is looked up by hash before a second signature (design.md › Решения).
  it('does not sign a batch again while the network may have it, and asks for its status by hash first', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    await think(2);
    const chain = h.net().contract;
    // the transaction executes but the answer is lost
    chain.mode = 'executed-but-silent';
    await tick(env, later());
    expect(chain.attempts).toBe(1);
    expect(chain.debits).toHaveLength(1);
    // the status by hash says it went through: the thoughts are billed, no second signature
    expect(await statuses()).toEqual([{ status: 'billed', n: 2 }]);
    expect(pet.last_debit_id).toBe(1);
    chain.mode = 'normal';
    await tick(env, later(20 * MIN));
    expect(chain.attempts).toBe(1);
  });

  // spec: add-feeding › Feeding outcome rule › не прошло × a batch the node refused
  it('keeps a batch the node refused: the contract never saw it, so it stays to be billed and is no rejected batch', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    await think(2);
    const chain = h.net().contract;
    chain.mode = 'not-enough-balance';
    await tick(env, later());
    expect(await statuses()).toEqual([{ status: 'unbilled', n: 2 }]);
    expect(await spend()).toEqual([]);
    chain.mode = 'normal';
    await tick(env, later(13 * MIN));
    await tick(env, later(40 * MIN));
    expect(await statuses()).toEqual([{ status: 'billed', n: 2 }]);
    expect(pet.last_debit_id).toBe(1);
  });

  // Design: an unknown outcome is looked up by hash before a second signature (design.md › Решения).
  it('waits when the network has not heard of the transaction, and signs again only long after', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    await think(2);
    const chain = h.net().contract;
    chain.mode = 'lost';
    await tick(env, later());
    expect(chain.attempts).toBe(1);
    expect(await statuses()).toEqual([{ status: 'unbilled', n: 2 }]);
    chain.mode = 'normal';
    await tick(env, later(13 * MIN)); // two minutes on: still waiting
    expect(chain.attempts).toBe(1);
    // the same debit_id once the transaction is long past
    vi.setSystemTime(Date.now() + 25 * MIN);
    await tick(env);
    expect(chain.attempts).toBe(2);
    expect(chain.debits.map((d) => d.debitId)).toEqual([1]);
    expect(pet.last_debit_id).toBe(1);
    expect(await statuses()).toEqual([{ status: 'billed', n: 2 }]);
  });

  // Design: an unknown outcome is looked up by hash before a second signature (design.md › Решения).
  it('moves the thoughts of a refused batch to the project and takes the same debit_id for the next one', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    await think(2);
    const chain = h.net().contract;
    chain.debitFails = 'daily_cap';
    await tick(env, later());
    expect(await statuses()).toEqual([{ status: 'project', n: 2 }]);
    expect((await spend()).map((r) => r.kind)).toEqual(['rejected_batch']);
    expect((await spend())[0]!.usd_micros).toBeGreaterThan(0);
    expect(pet.last_debit_id).toBe(0);
    // the food the server counts is the contract's again: nothing unbilled
    expect((await api('/api/pets/5')).body.fullness.level).toBe(1);
    chain.debitFails = null;
    vi.setSystemTime(Date.now() + 20 * MIN);
    await think(1);
    await tick(env, later());
    expect(chain.debits.map((d) => d.debitId)).toEqual([1]);
    expect(pet.last_debit_id).toBe(1);
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('sends nothing again when the batch landed and its mark was lost: the next tick reads the contract first', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    await think(2);
    const chain = h.net().contract;
    // the transaction lands and the write of its outcome throws (a transient D1 error, a dead tick)
    const batch = vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('D1_ERROR'));
    await tick(env, later());
    batch.mockRestore();
    expect(chain.attempts).toBe(1);
    expect(await statuses()).toEqual([{ status: 'unbilled', n: 2 }]);
    expect((await env.DB.prepare('SELECT debit_id, tx_hash FROM debit_sessions').first<any>())).toMatchObject({ debit_id: 1, tx_hash: null });

    await tick(env, later(12 * MIN));
    expect(chain.attempts).toBe(1);
    expect(chain.debits).toHaveLength(1);
    expect(pet.last_debit_id).toBe(1);
    expect(await statuses()).toEqual([{ status: 'billed', n: 2 }]);
    expect((await env.DB.prepare('SELECT debit_id, status FROM debit_sessions').first<any>())).toEqual({ debit_id: null, status: 'done' });
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('takes a session once when two crons overlap: one send, no false refusal', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    await think(2);
    const chain = h.net().contract;
    const at = later();
    await Promise.all([tick(env, at), tick(env, at)]);
    expect(chain.attempts).toBe(1);
    expect(pet.last_debit_id).toBe(1);
    expect(await statuses()).toEqual([{ status: 'billed', n: 2 }]);
    expect(await spend()).toEqual([]);
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('leaves a session a live tick holds, and takes it over once that claim is long dead', async () => {
    h.net().contract.addPet('5', OWNER);
    await think(1);
    const chain = h.net().contract;
    const at = later();
    await env.DB.prepare("UPDATE debit_sessions SET status = 'sending', claimed_at = ?").bind(at - MIN).run();
    await tick(env, at);
    expect(chain.attempts).toBe(0);
    await tick(env, at + 6 * MIN);
    expect(chain.attempts).toBe(1);
    expect((await env.DB.prepare('SELECT claimed_at FROM debit_sessions').first<any>()).claimed_at).toBeNull();
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('keeps a pet\'s sessions in order: the later one waits while an earlier batch has no known outcome', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    await think(1);
    const chain = h.net().contract;
    chain.mode = 'lost';
    const at = later();
    await tick(env, at);
    expect(chain.attempts).toBe(1);
    // a new session of the same pet is due while the first is unresolved
    chain.mode = 'normal';
    await think(1);
    await tick(env, at + 2 * MIN);
    expect(chain.attempts).toBe(1);
    // the first goes under its own id, then the second under the next
    await tick(env, at + 11 * MIN);
    expect(chain.debits.map((d) => d.debitId)).toEqual([1, 2]);
    expect(pet.last_debit_id).toBe(2);
    expect(await statuses()).toEqual([{ status: 'billed', n: 2 }]);
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('falls through to the contract when the status of a lost batch answers with a timeout, as nearcore does', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    await think(2);
    const chain = h.net().contract;
    chain.mode = 'lost';
    chain.unseenTx = 'timeout';
    await tick(env, later());
    expect(chain.attempts).toBe(1);
    chain.mode = 'normal';
    await tick(env, later(13 * MIN)); // still waiting, the session not lost
    expect(chain.attempts).toBe(1);
    vi.setSystemTime(Date.now() + 25 * MIN);
    await tick(env);
    expect(chain.attempts).toBe(2);
    expect(chain.debits.map((d) => d.debitId)).toEqual([1]);
    expect(pet.last_debit_id).toBe(1);
    expect(await statuses()).toEqual([{ status: 'billed', n: 2 }]);
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('does not call a batch refused when the contract says only that its id is out of order', async () => {
    h.net().contract.addPet('5', OWNER);
    await think(1);
    const chain = h.net().contract;
    chain.debitFails = 'bad_debit_id';
    await tick(env, later());
    expect(await statuses()).toEqual([{ status: 'unbilled', n: 1 }]);
    expect(await spend()).toEqual([]);
    chain.debitFails = null;
    await tick(env, later(2 * MIN));
    expect(await statuses()).toEqual([{ status: 'billed', n: 1 }]);
    expect(chain.debits.map((d) => d.debitId)).toEqual([1]);
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('takes a session as its claim finds it: a tick that read the sessions before another tick sent sends nothing', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    await think(2);
    const chain = h.net().contract;
    const at = later();
    // this tick has read the sessions; before it claims one, the other tick sends and hears nothing
    chain.meanwhile.view_account = async () => {
      chain.mode = 'executed-but-silent';
      chain.txBlind = true;
      await tick(env, at);
      chain.mode = 'normal';
      chain.txBlind = false;
    };
    await tick(env, at);
    expect(chain.attempts).toBe(1);
    expect(chain.debits.map((d) => d.debitId)).toEqual([1]);
    expect(pet.last_debit_id).toBe(1);
    expect(await statuses()).toEqual([{ status: 'billed', n: 2 }]);
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('does not bill the next batch on the word of a snapshot whose batch was settled since', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: BIG_FOOD });
    await think(13);
    const chain = h.net().contract;
    const at = later();
    chain.mode = 'executed-but-silent';
    chain.txBlind = true;
    await tick(env, at);
    expect((await env.DB.prepare('SELECT debit_id FROM debit_sessions').first<any>()).debit_id).toBe(1);
    chain.txBlind = false;
    // this tick has read `debit_id = 1`; the other settles it and loses the next batch under 2
    chain.meanwhile.view_account = async () => {
      chain.mode = 'lost';
      await tick(env, at + MIN);
      chain.mode = 'normal';
    };
    await tick(env, at + MIN);
    expect(chain.debits.map((d) => d.debitId)).toEqual([1]);
    expect(await statuses()).toEqual([{ status: 'billed', n: 12 }, { status: 'unbilled', n: 1 }]);
    expect((await env.DB.prepare('SELECT debit_id FROM debit_sessions').first<any>()).debit_id).toBe(2);
  });

  // spec: add-pet › Session debit contract › повтор списания
  it.each([
    ['the send left no hash', 'no-hash'],
    ['the hash was never seen', 'unseen'],
  ] as const)('resends under the saved id when a read lags behind another: %s', async (_case, way) => {
    const pet = h.net().contract.addPet('5', OWNER);
    await think(2);
    const chain = h.net().contract;
    const at = later();
    // the batch lands under 1 and nothing here learns of it
    const batch = way === 'no-hash' ? vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('D1_ERROR')) : null;
    if (way === 'unseen') {
      chain.mode = 'executed-but-silent';
      chain.txBlind = true;
    }
    await tick(env, at);
    batch?.mockRestore();
    chain.mode = 'normal';
    expect(chain.debits.map((d) => d.debitId)).toEqual([1]);
    // the first read comes from a node before that block, the next from one after it
    chain.lag = [1, 0];
    await tick(env, at + 11 * MIN);
    expect(chain.sends.filter((s) => s.method === 'debit_session').map((s) => s.args.debit_id)).toEqual([1, 1]);
    expect(chain.debits.map((d) => d.debitId)).toEqual([1]);
    expect(pet.last_debit_id).toBe(1);
    expect(await statuses()).toEqual([{ status: 'billed', n: 2 }]);
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('keeps the saved id when a resend is refused and the read after it lags: the next tick finds the batch on the chain', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    await think(2);
    const chain = h.net().contract;
    const at = later();
    const batch = vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('D1_ERROR'));
    await tick(env, at);
    batch.mockRestore();
    // the read before the resend and the read after its refusal both come from an old block
    chain.lag = [1, 1];
    await tick(env, at + MIN);
    expect((await env.DB.prepare('SELECT debit_id FROM debit_sessions').first<any>()).debit_id).toBe(1);
    await tick(env, at + 2 * MIN);
    expect(chain.debits.map((d) => d.debitId)).toEqual([1]);
    expect(pet.last_debit_id).toBe(1);
    expect(await statuses()).toEqual([{ status: 'billed', n: 2 }]);
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('never goes back to an id it has just seen accepted, from one session of a pet to the next', async () => {
    h.net().contract.addPet('5', OWNER);
    await think(1);
    const chain = h.net().contract;
    const at = later();
    await env.DB.prepare("UPDATE debit_sessions SET opened_at = opened_at - 1, day = day - 1").run();
    await think(1);
    await env.DB.prepare("UPDATE debit_sessions SET status = 'sending'").run();
    // the first session's read is current; the second's comes from before the first's batch
    chain.lag = [0, 1];
    await tick(env, at);
    expect(chain.sends.filter((s) => s.method === 'debit_session').map((s) => s.args.debit_id)).toEqual([1, 2]);
    expect(await statuses()).toEqual([{ status: 'billed', n: 2 }]);
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('does not call a first send billed when its lost answer was a refusal of a stale id', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    await think(1);
    const chain = h.net().contract;
    const at = later();
    await tick(env, at);
    await think(1);
    // the read comes from before the batch above, so the id is taken, and the refusal is not heard
    chain.lag = [1];
    chain.mode = 'executed-but-silent';
    await tick(env, at + 11 * MIN);
    chain.mode = 'normal';
    expect(await statuses()).toEqual([{ status: 'billed', n: 1 }, { status: 'unbilled', n: 1 }]);
    await tick(env, at + 12 * MIN);
    expect(chain.debits.map((d) => d.debitId)).toEqual([1, 2]);
    expect(pet.last_debit_id).toBe(2);
    expect(await statuses()).toEqual([{ status: 'billed', n: 2 }]);
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('renews its claim at every batch: a cron minutes into a long tick leaves the session to it', async () => {
    const pet = h.net().contract.addPet('5', OWNER, { project_food: BIG_FOOD });
    await think(25);
    const chain = h.net().contract;
    const at = later();
    // each batch takes four minutes; the cron of minute 8 meets the tick at its second batch
    chain.meanwhile.pet_view = async () => {
      vi.setSystemTime(Date.now() + 4 * MIN);
      chain.meanwhile.pet_view = async () => {
        vi.setSystemTime(Date.now() + 4 * MIN);
        await tick(env, at + 8 * MIN);
      };
    };
    await tick(env, at);
    expect(chain.debits.map((d) => d.debitId)).toEqual([1, 2, 3]);
    expect(chain.debits.map((d) => d.thoughts.length)).toEqual([12, 12, 1]);
    expect(pet.last_debit_id).toBe(3);
    expect(await statuses()).toEqual([{ status: 'billed', n: 25 }]);
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('signs nothing once another tick has taken the session, and leaves that tick its claim', async () => {
    h.net().contract.addPet('5', OWNER);
    await think(1);
    const chain = h.net().contract;
    const at = later();
    // this tick stalls on its read for longer than a claim lives; another takes the session
    chain.meanwhile.pet_view = async () => {
      await env.DB.prepare('UPDATE debit_sessions SET claimed_at = ?').bind(at + 6 * MIN).run();
    };
    await tick(env, at);
    expect(chain.attempts).toBe(0);
    expect((await env.DB.prepare('SELECT debit_id, claimed_at FROM debit_sessions').first<any>())).toEqual({ debit_id: null, claimed_at: at + 6 * MIN });
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('leaves the batch of the tick that took over when its own late answer comes', async () => {
    h.net().contract.addPet('5', OWNER);
    await think(1);
    const chain = h.net().contract;
    const at = later();
    // while this tick waits on its send, another takes the session and signs its next batch under 2
    chain.meanwhile.send_tx = async () => {
      await env.DB.prepare("UPDATE debit_sessions SET debit_id = 2, tx_hash = 'theirs', claimed_at = ?").bind(at + 6 * MIN).run();
    };
    await tick(env, at);
    expect((await env.DB.prepare('SELECT debit_id, tx_hash, claimed_at FROM debit_sessions').first<any>())).toEqual({ debit_id: 2, tx_hash: 'theirs', claimed_at: at + 6 * MIN });
  });

  // spec: add-pet › Session debit contract › повтор списания
  it('keeps the id when the refusal of the first signature comes to a tick that lost the session: the new tick may have signed', async () => {
    h.net().contract.addPet('5', OWNER);
    await think(1);
    const chain = h.net().contract;
    const at = later();
    chain.debitFails = 'bad_debit_id';
    chain.meanwhile.send_tx = async () => {
      await env.DB.prepare('UPDATE debit_sessions SET claimed_at = ?').bind(at + 6 * MIN).run();
    };
    await tick(env, at);
    expect((await env.DB.prepare('SELECT debit_id FROM debit_sessions').first<any>()).debit_id).toBe(1);
  });

  // Design: the gas of a short last batch above its share is the project's (Траты проекта).
  it('charges the project the gas of a last batch of fewer than 4 thoughts above its share', async () => {
    h.net().contract.addPet('5', OWNER);
    await think(2);
    const burnt = gasShareYocto(env) * 2n + 3_000_000_000_000_000_000_000n;
    h.net().contract.burnt = burnt.toString();
    await tick(env, later());
    const extra = burnt - gasShareYocto(env) * 2n;
    const rate = Number(env.NEAR_USD_RATE);
    expect((await spend()).map((r) => r.kind)).toEqual(['gas']);
    expect(Math.abs((await spend())[0]!.usd_micros - Math.ceil((Number(extra) / 1e24) * rate * 1e6))).toBeLessThanOrEqual(1);
  });
});

describe('Pet food data', () => {
  // spec: add-pet › Pet food data › мысль ещё не списана × пачка исполнилась после полуночи
  it('counts the unbilled thoughts of yesterday\'s session in the new day, and the old day\'s debits not at all', async () => {
    vi.setSystemTime(new Date(Date.UTC(2036, 10, 3, 23, 50, 0)));
    // yesterday the pet reached its cap (the contract's record is of the old day)
    h.net().contract.addPet('5', OWNER, { project_food: BIG_FOOD, debited_today: DAILY_CAP_YOCTO.toString() });
    const min0 = minCallPrice(env, 0);
    const insert = (price: bigint) =>
      env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status, session_id) VALUES (?, '5', ?, 'reply', 'q', 'a', 'm', ?, 0, 'pet', 'unbilled', 'old-session')")
        .bind(crypto.randomUUID(), Date.now(), price.toString())
        .run();
    await insert(DAILY_CAP_YOCTO - min0 + 1n);
    const tk = await token('did:privy:owner', OWNER);
    // 00:00:30 of the new day, the batch has not run yet
    vi.setSystemTime(new Date(Date.UTC(2036, 10, 4, 0, 0, 30)));
    const view = await api('/api/pets/5', { token: tk });
    expect(view.body.tired).toBe(true);
    expect(view.body.until).toBe(new Date(Date.UTC(2036, 10, 5, 0, 0, 0)).toISOString());
    // a yocto less of it and the cap left pays the cheapest call: not tired
    await env.DB.exec("UPDATE thoughts SET price_yocto = '" + (DAILY_CAP_YOCTO - min0).toString() + "'");
    await env.DB.exec('UPDATE pets SET tired_day = NULL');
    expect((await api('/api/pets/5', { token: tk })).body.tired).toBe(false);
  });
});
