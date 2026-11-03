import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { tick } from '../src/cron';
import { errandPrice } from '../src/errands/price';
import { settleLate } from '../src/errands/late';
import { failErrand } from '../src/errands/store';
import { costUsd12, usd12ToMicros } from '../src/pricing';
import { harness, settle } from './helpers/api';
import { callsOf, conversation, errandRow, owner, OWNER, PET, richPet, sendErrand, spendKinds, stateOf, thoughtsOf } from './helpers/errands';
import { until } from './helpers/work';

const h = harness();
const JOB = 'When is the Leonids meteor shower?';
const SEARCH = { tokensIn: 13_000, tokensOut: 60 };
/** Three minutes and a second after «Send». */
const PAST = 181_000;
const later = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
const errandThoughts = async () => (await thoughtsOf()).filter((t) => t.kind === 'errand');
const reserve = () => env.DB.prepare('SELECT reserve_yocto FROM pet_spend WHERE token_id = ?').bind(PET).first<{ reserve_yocto: string }>();

describe('Errand flow', () => {
  // spec: add-pet-errands › Errand price data › report failed after searches
  it('does not erase a stored search receipt when a failure caller omits its fields', async () => {
    richPet(h);
    await env.DB.prepare("INSERT INTO errands (token_id, id, owner, form, job, state, sent_at, reserve_yocto, searches_ran, thought_id, price_yocto) VALUES (?, 'e1', ?, 'find', ?, 'away', ?, '0', 2, 't1', '123')").bind(PET, OWNER, JOB, Date.now()).run();
    const row = await errandRow();
    expect(await failErrand(env.DB, row, { reason: 'empty' })).toBe(true);
    expect(await errandRow()).toMatchObject({ state: 'failed', searches_ran: 2, thought_id: 't1', price_yocto: '123' });
  });

  // spec: add-pet-errands › Errand price data › report failed after searches
  it('settles stored searches when an unexpected exception interrupts the report path', async () => {
    richPet(h);
    const tk = await owner();
    // A malformed saved declaration makes the data step throw after the signed search has been stored.
    await env.DB.prepare("INSERT INTO skill_code (token_id, ct, iv, hash, functions, updated_at) VALUES (?, x'00', x'00', 'bad', '{', ?)").bind(PET, Date.now()).run();
    h.net().ai.push({ stream: { searches: 2 }, ...SEARCH });
    const sent = await sendErrand(tk, 'find', JOB);
    await settle(tk, PET, sent.body.job);
    const row = await errandRow();
    const [thought] = await errandThoughts();
    expect(row).toMatchObject({ state: 'failed', reason: 'empty', searches_ran: 2, thought_id: thought.id, price_yocto: thought.price_yocto });
    expect(thought).toMatchObject({ status: 'unbilled', player_text: JOB, searches: 2 });
    expect(BigInt(thought.price_yocto)).toBe(errandPrice(env, [SEARCH], 2));
    expect((await callsOf(thought.id)).map((c: any) => c.label)).toEqual(['search']);
    expect(await reserve()).toBeNull();
    expect(h.events().find((e) => e.name === 'errand_failed')!.props).toMatchObject({ reason: 'empty', searches: 2 });
    await tick(env, Date.now() + 11 * 60_000);
    expect(h.net().contract.debits[0]!.thoughts[0]).toMatchObject({ price: thought.price_yocto });
    expect(h.net().contract.debits[0]!.thoughts[0]!.calls).toHaveLength(1);
  });

  // spec: add-pet-errands › Errand flow › not back in 3 minutes
  it('comes back empty with nothing spent when the search call has not ended in 3 minutes', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ delay: 400, stream: { searches: 1 }, ...SEARCH });
    const sent = await sendErrand(tk, 'find', JOB);
    await until(() => h.net().ai.calls.length === 1);
    expect((await reserve())?.reserve_yocto).toBe((await errandRow()).reserve_yocto);
    expect(BigInt((await errandRow()).reserve_yocto)).toBeGreaterThan(0n);

    later(PAST);
    expect(await settleLate(env, PET)).toBe(true);
    // the pet is back, the errand is kept, the reserve is back, nothing was spent
    expect(await errandRow()).toMatchObject({ state: 'failed', reason: 'timeout', job: JOB, price_yocto: null, thought_id: null, reserve_yocto: '0' });
    expect(await reserve()).toBeNull();
    expect((await stateOf(tk)).errand).toEqual({ state: 'failed', form: 'find', job: JOB, reason: 'timeout' });
    expect(await errandThoughts()).toEqual([]);
    expect(h.events().find((e) => e.name === 'errand_failed')!.props).toEqual({ form: 'find', reason: 'timeout', searches: 0, price_usd: 0, cost_usd: 0, cut: false, project_usd: 0 });
    // the call still in flight is not waited for
    expect(h.events().filter((e) => e.name === 'thought_failed').map((e) => e.props)).toEqual([{ for: 'errand', reason: 'not_waited' }]);

    // the search call ends after the deadline: nothing is stored and the pet pays nothing; the project bears the call
    await settle(tk, PET, sent.body.job);
    expect(await errandThoughts()).toEqual([]);
    expect(h.net().ai.calls).toHaveLength(1);
    expect((await spendKinds()).map((k) => k.kind)).toEqual(['errand_late']);
    expect(await errandRow()).toMatchObject({ state: 'failed', reason: 'timeout' });
    expect(await reserve()).toBeNull();
  });

  // spec: add-pet-errands › Errand flow › not back in 3 minutes
  // spec: add-pet-errands › Errand flow › not back in 3 minutes × the job ends after the timeout
  it('pays only the searches that ran when the report is late, and stores nothing of a report that lands after it', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 2 }, ...SEARCH }, { delay: 400, content: 'A report that nobody may keep [1].', tokensIn: 900, tokensOut: 140 });
    const sent = await sendErrand(tk, 'find', JOB);
    await until(() => h.net().ai.calls.length === 2);
    // the search call is stored as soon as it is signed: an `away` thought, invisible in the conversation
    const [away] = await errandThoughts();
    expect(away).toMatchObject({ status: 'away', reply_text: null, player_text: null, searches: 2 });
    expect((await callsOf(away.id)).map((c: any) => [c.label, c.sig_kind])).toEqual([['search', 'gateway']]);
    expect((await conversation(tk)).lines).toEqual([]);
    expect(await errandRow()).toMatchObject({ state: 'away', thought_id: away.id, searches_ran: 2 });

    later(PAST);
    expect(await settleLate(env, PET)).toBe(true);
    // the searches that ran are billed: the search call's tokens and each search, ×1.2, and the gas share
    const [settled] = await errandThoughts();
    expect(settled).toMatchObject({ id: away.id, status: 'unbilled', player_text: JOB, reply_text: null });
    expect(BigInt(settled.price_yocto)).toBe(errandPrice(env, [SEARCH], 2));
    expect(await errandRow()).toMatchObject({ state: 'failed', reason: 'timeout', price_yocto: settled.price_yocto });
    expect(await reserve()).toBeNull();
    const failed = h.events().find((e) => e.name === 'errand_failed')!.props;
    expect(failed).toMatchObject({ form: 'find', reason: 'timeout', searches: 2 });
    expect(failed.price_usd as number).toBeGreaterThan(0.01);
    expect((await stateOf(tk)).errand).toMatchObject({ state: 'failed', reason: 'timeout', priceCents: expect.any(Number) });
    const lines = (await conversation(tk)).lines;
    expect(lines.map((l: any) => l.who)).toEqual(['player', 'error']);

    // the report lands after the deadline: not stored, not paid by the pet, the project bears its tokens
    await settle(tk, PET, sent.body.job);
    const [after] = await errandThoughts();
    expect(after).toMatchObject({ id: away.id, reply_text: null, price_yocto: settled.price_yocto });
    expect((await callsOf(away.id)).map((c: any) => c.label)).toEqual(['search']);
    expect(await spendKinds()).toEqual([{ kind: 'errand_late', usd_micros: usd12ToMicros(costUsd12(env, 900, 140)) }]);
    expect(h.logs()).toContain('errand_late');
    expect(h.events().filter((e) => e.name === 'errand_reported')).toEqual([]);
    expect(await reserve()).toBeNull();

    // its receipt is debited as any: the search call only, signed by the gateway
    await tick(env, Date.now() + 11 * 60_000);
    const [batch] = h.net().contract.debits;
    expect(batch!.thoughts).toHaveLength(1);
    expect(batch!.thoughts[0]!.calls.map((c: any) => c.sig_kind)).toEqual(['gateway']);
    expect(batch!.thoughts[0]!.price).toBe(settled.price_yocto);
  });

  // spec: add-pet-errands › Errand flow › not back in 3 minutes × the page open at 3:00
  it('is settled by the open page at 3:00, not a minute later', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ delay: 300, stream: { searches: 1 } });
    const sent = await sendErrand(tk, 'find', JOB);
    await until(() => h.net().ai.calls.length === 1);
    expect((await stateOf(tk)).errand).toMatchObject({ state: 'away' });
    later(PAST - 2_000);
    expect((await stateOf(tk)).errand).toMatchObject({ state: 'away' });
    later(3_000);
    // the state poll is the one that finds it: no cron ran
    expect((await stateOf(tk)).errand).toMatchObject({ state: 'failed', reason: 'timeout' });
    await settle(tk, PET, sent.body.job);
  });

  // spec: add-pet-errands › Errand flow › not back in 3 minutes × the desk dies
  it('is settled by the cron when no job is running any more', async () => {
    richPet(h);
    const tk = await owner();
    // an errand whose desk died: the row is away, the reserve is held, a job is left `running`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO errands (token_id, id, owner, form, job, state, sent_at, reserve_yocto) VALUES (?, 'e1', ?, 'find', ?, 'away', ?, '1000')").bind(PET, OWNER, JOB, Date.now() - PAST),
      env.DB.prepare("INSERT INTO pet_spend (token_id, reserve_yocto, job_id) VALUES (?, '1000', NULL)").bind(PET),
      env.DB.prepare("INSERT INTO jobs (id, token_id, kind, mode, payload, status, created_at) VALUES ('j1', ?, 'errand', NULL, '{}', 'running', ?)").bind(PET, Date.now() - PAST),
    ]);
    await tick(env, Date.now());
    expect(await errandRow()).toMatchObject({ state: 'failed', reason: 'timeout', job: JOB, price_yocto: null });
    expect(await reserve()).toBeNull();
    expect(h.events().find((e) => e.name === 'errand_failed')!.props).toMatchObject({ reason: 'timeout', searches: 0, price_usd: 0 });
    expect(h.events().filter((e) => e.name === 'thought_failed').map((e) => e.props)).toEqual([{ for: 'errand', reason: 'not_waited' }]);
    expect((await stateOf(tk)).errand).toMatchObject({ state: 'failed', reason: 'timeout' });
  });

  // spec: add-pet-errands › Errand flow › not back in 3 minutes
  it('leaves an errand alone before its 3 minutes are out', async () => {
    richPet(h);
    await env.DB.prepare("INSERT INTO errands (token_id, id, owner, form, job, state, sent_at) VALUES (?, 'e1', ?, 'find', ?, 'away', ?)").bind(PET, OWNER, JOB, Date.now() - 170_000).run();
    await tick(env, Date.now());
    expect(await errandRow()).toMatchObject({ state: 'away' });
    expect(h.events().filter((e) => e.name === 'errand_failed')).toEqual([]);
  });

  // spec: add-pet-errands › Errand flow › not back in 3 minutes
  it('is not settled twice, and a finished errand is never touched', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 1 } }, { content: 'Found [1].' });
    const sent = await sendErrand(tk, 'find', JOB);
    await settle(tk, PET, sent.body.job);
    later(PAST * 2);
    expect(await settleLate(env, PET)).toBe(false);
    expect(await errandRow()).toMatchObject({ state: 'done' });
  });
});
