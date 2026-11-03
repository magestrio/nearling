import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/cron';
import { gasFor, MAX_LOG_BYTES_PER_DEBIT, receiptBytes } from '../src/debit';
import { harness } from './helpers/api';
import { callsOf, errand, owner, OWNER, PET, richPet, thoughtsOf } from './helpers/errands';

const h = harness();
const MIN = 60_000;
const later = () => Date.now() + 11 * MIN;
const JOB = 'When is the Leonids meteor shower?';

/** A session of the pet with `n` unbilled thoughts of `calls` calls each (an errand's), written the way the Worker writes them. */
async function seed(n: number, calls: number): Promise<void> {
  const session = 'seeded-session';
  await env.DB.prepare("INSERT INTO debit_sessions (id, token_id, day, opened_at, last_at, status) VALUES (?, ?, ?, ?, ?, 'open')").bind(session, PET, Math.floor(Date.now() / 86_400_000), Date.now(), Date.now()).run();
  for (let i = 0; i < n; i += 1) {
    const id = `t${i}`;
    await env.DB
      .prepare(
        "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, session_id, status, form, searches) VALUES (?, ?, ?, 'errand', NULL, NULL, ?, '1000', 1, 'pet', ?, 'unbilled', 'find', 2)",
      )
      .bind(id, PET, 1_000 + i, env.MODEL_ID, session)
      .run();
    for (let c = 0; c < calls; c += 1) {
      await env.DB
        .prepare(
          "INSERT INTO thought_calls (thought_id, n, req_bytes, res_bytes, req_sha256, res_sha256, signature, sig_kind, signer, completion_id, tokens_in, tokens_out, tokens_reasoning, cut, label) VALUES (?, ?, x'', x'', ?, ?, ?, ?, ?, ?, 100, 10, 0, 0, ?)",
        )
        .bind(id, c, 'a'.repeat(64), 'b'.repeat(64), c === 0 ? '0xsig' : '0xsig2', c === 0 ? 'gateway' : 'provider_tee', '0xsigner', `c${i}${c}`, ['search', 'data', 'report', 'reask'][c]!)
        .run();
    }
  }
}

describe('Errand debit contract', () => {
  // spec: add-pet-errands › Errand debit contract › errand recorded
  it('sends an errand\'s receipt with its calls in order, the search call signed by the gateway, and nothing of the errand', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 2 }, tokensIn: 13_000, tokensOut: 60 }, { content: 'Peaks in November [1][4].', tokensIn: 900, tokensOut: 140 });
    await errand(tk, 'find', JOB);
    const [thought] = (await thoughtsOf()).filter((t) => t.kind === 'errand');
    const calls = await callsOf(thought.id);
    await tick(env, later());
    const [batch] = h.net().contract.debits;
    expect(batch!.thoughts).toHaveLength(1);
    const sent = batch!.thoughts[0]!;
    expect(sent.price).toBe(thought.price_yocto);
    // the search call (gateway), then the report (provider_tee): the order of the receipt
    expect(sent.calls).toEqual([
      expect.objectContaining({ req_sha256: calls[0].req_sha256, res_sha256: calls[0].res_sha256, sig_kind: 'gateway', tokens_in: 13_000, tokens_out: 60, cut: false }),
      expect.objectContaining({ req_sha256: calls[1].req_sha256, res_sha256: calls[1].res_sha256, sig_kind: 'provider_tee', tokens_in: 900, tokens_out: 140, cut: false }),
    ]);
    // the form, the job, the sources and the number of searches don't leave
    const args = JSON.stringify(h.net().contract.sends.map((s) => s.args));
    expect(args).not.toMatch(/Leonids|find|form|sources|searches|site11|November/);
    expect(Object.keys(sent).sort()).toEqual(['calls', 'model', 'price']);
    expect(await env.DB.prepare("SELECT status FROM thoughts WHERE id = ?").bind(thought.id).first()).toEqual({ status: 'billed' });
  });

  // spec: add-pet-errands › Errand debit contract › errand recorded
  it('sends a cut search call unsigned, with no tokens and marked cut', async () => {
    richPet(h);
    await env.DB.prepare("INSERT INTO debit_sessions (id, token_id, day, opened_at, last_at, status) VALUES ('s', ?, ?, ?, ?, 'open')").bind(PET, Math.floor(Date.now() / 86_400_000), Date.now(), Date.now()).run();
    await env.DB
      .prepare("INSERT INTO thoughts (id, token_id, created_at, kind, model, price_yocto, price_usd_micros, payer, session_id, status) VALUES ('t', ?, 1, 'errand', ?, '1000', 1, 'pet', 's', 'unbilled')")
      .bind(PET, env.MODEL_ID)
      .run();
    await env.DB
      .prepare("INSERT INTO thought_calls (thought_id, n, req_bytes, res_bytes, req_sha256, res_sha256, signature, sig_kind, signer, completion_id, tokens_in, tokens_out, tokens_reasoning, cut, label) VALUES ('t', 0, x'', x'', ?, ?, '', 'gateway', '', '', 0, 0, 0, 1, 'search')")
      .bind('a'.repeat(64), 'b'.repeat(64))
      .run();
    await tick(env, later());
    expect(h.net().contract.debits[0]!.thoughts[0]!.calls).toEqual([
      { req_sha256: 'a'.repeat(64), res_sha256: 'b'.repeat(64), signature: '', sig_kind: 'gateway', signer: '', tokens_in: 0, tokens_out: 0, tokens_reasoning: 0, cut: true },
    ]);
  });

  // spec: add-pet-errands › Errand debit contract › errand recorded
  it('splits a session of 12 four-call errands into two batches before the 16 kB log limit, with the gas of four calls', async () => {
    h.net().contract.addPet(PET, OWNER, { project_food: (100n * BigInt(env.STARTER_FOOD)).toString() });
    await seed(12, 4);
    await tick(env, later());
    const chain = h.net().contract;
    // 14,000 bytes hold 6 receipts at the longest field lengths (2,265 measured, 2,290 estimated)
    expect(Math.floor(MAX_LOG_BYTES_PER_DEBIT / receiptBytes(4))).toBe(6);
    expect(chain.debits.map((d) => d.thoughts.length)).toEqual([6, 6]);
    expect(chain.debits.map((d) => d.debitId)).toEqual([1, 2]);
    expect(chain.sends.map((s) => s.gas)).toEqual([gasFor(6, 0, 6), gasFor(6, 0, 6)]);
    // each thought's four calls travel, in order
    expect(chain.debits[0]!.thoughts[0]!.calls.map((c: any) => c.sig_kind)).toEqual(['gateway', 'provider_tee', 'provider_tee', 'provider_tee']);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM thoughts WHERE status = 'billed'").first<{ n: number }>())!.n).toBe(12);
  });

  // spec: add-pet-errands › Errand debit contract › errand recorded
  it('adds a per-thought estimate: errands and plain thoughts share a batch until the logs would reach the bound', async () => {
    h.net().contract.addPet(PET, OWNER, { project_food: (100n * BigInt(env.STARTER_FOOD)).toString() });
    await seed(3, 4);
    // 9 plain thoughts of one call: 3 × 2,290 + 9 × 760 = 13,710 < 14,000, so all 12 go together
    expect(3 * receiptBytes(4) + 9 * receiptBytes(1)).toBeLessThan(MAX_LOG_BYTES_PER_DEBIT);
    expect(3 * receiptBytes(4) + 10 * receiptBytes(1)).toBeGreaterThan(MAX_LOG_BYTES_PER_DEBIT);
    for (let i = 0; i < 9; i += 1) {
      await env.DB
        .prepare("INSERT INTO thoughts (id, token_id, created_at, kind, model, price_yocto, price_usd_micros, payer, session_id, status) VALUES (?, ?, ?, 'reply', ?, '1000', 1, 'pet', 'seeded-session', 'unbilled')")
        .bind(`p${i}`, PET, 5_000 + i, env.MODEL_ID)
        .run();
      await env.DB
        .prepare("INSERT INTO thought_calls (thought_id, n, req_bytes, res_bytes, req_sha256, res_sha256, signature, sig_kind, signer, completion_id, tokens_in, tokens_out, tokens_reasoning, cut) VALUES (?, 0, x'', x'', ?, ?, '0xs', 'provider_tee', '0xk', ?, 1, 1, 0, 0)")
        .bind(`p${i}`, 'a'.repeat(64), 'b'.repeat(64), `pc${i}`)
        .run();
    }
    await tick(env, later());
    expect(h.net().contract.debits.map((d) => d.thoughts.length)).toEqual([12]);
  });
});
