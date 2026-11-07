// Who may ask, and what the asker's pet may spend (`add-pet-work` › `Hire access data`).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { HIRE_FEE_MIN_YOCTO } from '../src/pricing';
import { api, harness, say } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';
import { addHirer, addPets, addWorker, advise, PAYER, payerToken, postAdvice, WORKER, workerToken } from './helpers/work';

const h = harness();
const rows = async (sql: string, ...bind: unknown[]) => (await env.DB.prepare(sql).bind(...bind).all<any>()).results;
const ask = (n = 1, question = 'How do I grow radishes?') => ({ content: `ASK ${n}: ${question}` });
const lines = async (tk: string, id = PAYER) => (await api(`/api/pets/${id}/conversation`, { token: tk })).body.lines as any[];

describe('Conversation of a hire', () => {
  // spec: add-pet-work › Pet hire flow › спросил
  it('shows the owner\'s line once, the question to the worker, the worker\'s answer with its receipt owner, and the price under the pet\'s own reply', async () => {
    addHirer(h);
    await addWorker(h, '6', 2);
    const tk = await payerToken();
    h.net().ai.push(ask(), { content: 'Plant them in spring.' }, { content: 'Spring, says Worker6.' });
    await say(tk, PAYER, 'What should I plant?');

    const out = await lines(tk);
    expect(out.map((l) => l.who)).toEqual(['player', 'pet', 'worker', 'pet']);
    // the owner's line is the decision thought's; the own reply stores it again and shows none of its own
    expect(out.filter((l) => l.who === 'player')).toEqual([expect.objectContaining({ text: 'What should I plant?' })]);
    expect(out[1]).toMatchObject({ text: 'How do I grow radishes?', hireTo: 'Worker6', cut: null });
    expect(out[2]).toMatchObject({ text: 'Plant them in spring.', worker: { tokenId: '6', name: 'Worker6' }, skilled: false });
    expect(out[2]).not.toHaveProperty('hire');
    expect(out[3]).toMatchObject({ text: 'Spring, says Worker6.', hire: { worker: 'Worker6', price: HIRE_FEE_MIN_YOCTO.toString(), priceCents: expect.any(Number) } });
    // the question and the worker's answer each have a thought id of their own to check
    expect(new Set(out.map((l) => l.id)).size).toBe(4);
  });

  // spec: add-pet-work › Pet hire flow › свой ответ не пришёл
  it('puts the price under the worker\'s answer while the pet\'s own reply is missing', async () => {
    addHirer(h);
    await addWorker(h, '6', 2);
    const tk = await payerToken();
    h.net().ai.push(ask(), { content: 'Plant them in spring.' }, { status: 500 });
    await say(tk, PAYER, 'What should I plant?');
    const out = await lines(tk);
    expect(out.map((l) => l.who)).toEqual(['player', 'pet', 'worker']);
    expect(out[2]).toMatchObject({ hire: { worker: 'Worker6', price: HIRE_FEE_MIN_YOCTO.toString() } });
  });

  // spec: add-pet-work › Pet hire flow › найм не записан в сети
  it('says «no fee» under the answer of a hire the network refused, without a reload', async () => {
    addHirer(h);
    await addWorker(h, '6', 2);
    const tk = await payerToken();
    h.net().ai.push(ask(), { content: 'Plant them in spring.' }, { content: 'Spring.' });
    await say(tk, PAYER, 'What should I plant?');
    await env.DB.prepare("UPDATE hires SET status = 'dropped', dropped_code = 'cap'").run();
    const out = await lines(tk);
    expect(out.at(-1)).toMatchObject({ who: 'pet', text: 'Spring.', hire: { worker: 'Worker6', noFee: true } });
    expect((await api(`/api/pets/${PAYER}/state`, { token: tk })).body.hiresSeen).toBe(1);
  });

  // spec: add-pet-work › Pet hire flow › найм не состоялся
  // spec: add-pet-work › Pet hire flow › работник ответил пусто
  it('tells a hire that did not happen as an event line with a code, no price, and the pet\'s own reply after it', async () => {
    addHirer(h);
    await addWorker(h, '6', 2);
    const tk = await payerToken();
    h.net().ai.push({ ...ask(), during: () => void (h.net().contract.pets.get('6')!.project_food = '0') }, { content: 'Alone.' });
    await say(tk, PAYER, 'Hi');
    let out = await lines(tk);
    expect(out.map((l) => l.who)).toEqual(['player', 'pet', 'event', 'pet']);
    expect(out[2]).toMatchObject({ code: 'hire_failed', worker: { tokenId: '6', name: 'Worker6' } });
    expect(out[2]).not.toHaveProperty('text');
    expect(out[3]).not.toHaveProperty('hire');

    // an empty answer paid by the pet (its fourth of the day) is the other code
    await env.DB.exec('DELETE FROM thoughts');
    await env.DB.exec('DELETE FROM jobs');
    h.net().contract.pets.get('6')!.project_food = (10n * BigInt(env.STARTER_FOOD)).toString();
    await env.DB.prepare('INSERT INTO empty_answers (token_id, day, n) VALUES (?, ?, 3)').bind(PAYER, Math.floor(Date.now() / 86_400_000)).run();
    h.net().ai.push(ask(), { content: '', tokensOut: 12 }, { content: 'Alone.' });
    await say(tk, PAYER, 'Hi');
    out = await lines(tk);
    expect(out.map((l) => l.who)).toEqual(['player', 'pet', 'event', 'pet']);
    expect(out[2]).toMatchObject({ code: 'hire_empty' });
  });

  // spec: add-pet-work › Advice flow › ответ
  // spec: add-pet-society › Society hire price contract › post-answer hire rejection
  it('keeps paid advice without a fee label and shows the exact answer cost after a rejected hire', async () => {
    addPets(h);
    const tk = await payerToken();
    await advise(tk);
    const out = await lines(tk);
    expect(out.map((l) => l.who)).toEqual(['player', 'worker']);
    expect(out[0]).toMatchObject({ text: 'What should I plant?' });
    expect(out[1]).toMatchObject({ worker: { tokenId: WORKER, name: 'Biscuit' }, skilled: false });
    // A settled advice keeps its old line; a post-answer rejection gives the exact usage price.
    expect(out[1]).not.toHaveProperty('hire');
    await env.DB.prepare("UPDATE hires SET status = 'dropped', dropped_code = 'cap'").run();
    const cost = await env.DB.prepare("SELECT price_yocto FROM thoughts WHERE kind = 'advice'").first<{ price_yocto: string }>();
    expect((await lines(tk))[1]).toMatchObject({ hire: { noFee: true, answerPrice: cost!.price_yocto } });
  });
});

describe('Hire access data', () => {
  // spec: add-pet-work › Hire access data › владелец работника
  it('gives the owner of the worker no question or answer of a hire in the worker\'s conversation, state or thoughts', async () => {
    addHirer(h);
    await addWorker(h, '6', 2);
    const tk = await payerToken();
    h.net().ai.push(ask(), { content: 'Plant them in spring.' }, { content: 'Spring.' });
    await say(tk, PAYER, 'A line for the hirer only');

    const wt = await workerToken();
    expect(await lines(wt, '6')).toEqual([]);
    const state = await api('/api/pets/6/state', { token: wt });
    expect(state.status).toBe(200);
    expect(JSON.stringify(state.body)).not.toMatch(/radishes|spring|hirer only/i);
    // nothing of it among the worker's own thoughts either, and the hirer's conversation is not the worker's to read
    expect(await rows('SELECT 1 FROM thoughts WHERE token_id = ?', '6')).toEqual([]);
    expect(await api(`/api/pets/${PAYER}/conversation`, { token: wt })).toMatchObject({ status: 403 });
    expect(JSON.stringify((await api('/api/pets/6', { token: wt })).body)).not.toMatch(/radishes|spring/i);
  });

  // spec: add-pet-work › Hire access data › стёрта память спросившего
  it('erases the words and the bytes of a hire when the asker\'s memory is cleared, and keeps the receipts and the hire row', async () => {
    addHirer(h);
    await addWorker(h, '6', 2);
    const tk = await payerToken();
    h.net().ai.push(ask(), { content: 'Plant them in spring.' }, { content: 'Spring.' });
    await say(tk, PAYER, 'What should I plant?');
    const hires = await rows('SELECT id, fee_yocto, status FROM hires');
    const receipts = await rows('SELECT id, price_yocto FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER);
    expect((await api(`/api/pets/${PAYER}/memory/clear`, { token: tk, method: 'POST' })).status).toBe(200);

    expect(await lines(tk)).toEqual([]);
    for (const t of await rows('SELECT player_text, reply_text, erased_at FROM thoughts WHERE token_id = ?', PAYER)) {
      expect(t).toMatchObject({ player_text: null, reply_text: null });
    }
    expect((await rows('SELECT sum(length(req_bytes) + length(res_bytes)) AS n FROM thought_calls'))[0]).toEqual({ n: 0 });
    // the receipt of each thought and the hire stand
    expect(await rows('SELECT id, price_yocto FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER)).toEqual(receipts);
    expect(await rows('SELECT id, fee_yocto, status FROM hires')).toEqual(hires);
    expect(await rows('SELECT req_sha256 FROM thought_calls')).toHaveLength(3);
  });

  // spec: add-pet-work › Hire access data › стёрта память при предложении
  it('takes the standing offer with the words: no buttons, nothing spent, and a late tap finds nothing', async () => {
    addHirer(h);
    await addWorker(h, '6', 2);
    await env.DB.prepare("INSERT INTO hire_modes (token_id, mode) VALUES (?, 'manual')").bind(PAYER).run();
    const tk = await payerToken();
    h.net().ai.push(ask());
    expect((await say(tk, PAYER, 'What should I plant?')).code).toBe('offer');
    const calls = h.net().ai.calls.length;
    expect((await api(`/api/pets/${PAYER}/memory/clear`, { token: tk, method: 'POST' })).status).toBe(200);

    expect(await rows('SELECT 1 FROM hire_offers')).toEqual([]);
    expect((await api(`/api/pets/${PAYER}/state`, { token: tk })).body.offer).toBeNull();
    expect(await lines(tk)).toEqual([]);
    expect(await api(`/api/pets/${PAYER}/offer/ask`, { token: tk, body: { price: HIRE_FEE_MIN_YOCTO.toString() } })).toMatchObject({ status: 409, body: { code: 'no_offer' } });
    expect(h.net().ai.calls).toHaveLength(calls);
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(await rows('SELECT 1 FROM worker_answers')).toEqual([]);
  });

  // spec: add-pet-work › Hire access data › стёрта память при предложении
  it('takes an offer that is made while the clear lands: the decision call was running', async () => {
    addHirer(h);
    await addWorker(h, '6', 2);
    await env.DB.prepare("INSERT INTO hire_modes (token_id, mode) VALUES (?, 'manual')").bind(PAYER).run();
    const tk = await payerToken();
    h.net().ai.push({ ...ask(), during: async () => void (await api(`/api/pets/${PAYER}/memory/clear`, { token: tk, method: 'POST' })) });
    expect((await say(tk, PAYER, 'A private line')).code).toBe('memory_cleared');
    expect(await rows('SELECT 1 FROM hire_offers')).toEqual([]);
    expect(await lines(tk)).toEqual([]);
  });
});

describe('Hire access data · advice', () => {
  // spec: add-pet-work › Hire access data › платит не свой питомец
  it('takes no question when the player names as the payer a pet they do not own: nothing is sent, held, reserved or spent', async () => {
    addPets(h);
    // a third player's pet, named as the payer by the player who owns neither it nor the worker
    h.net().contract.addPet('8', NEAR_ACCOUNT(3), { name: 'Nibbles' });
    const tk = await payerToken();
    const sent = await postAdvice(tk, { payer: '8' });
    expect(sent).toMatchObject({ status: 403, body: { code: 'not_payer' } });
    // the worker's own pet, or a pet that is not there, is no payer either
    expect((await postAdvice(tk, { payer: WORKER })).status).toBe(403);
    expect((await postAdvice(tk, { payer: '99' })).status).toBe(403);
    // the page that asks for the facts of that pair is turned away the same way
    expect((await api(`/api/pets/${WORKER}/advice?payer=8`, { token: tk })).status).toBe(403);

    expect(h.net().ai.calls).toHaveLength(0);
    expect(h.net().contract.sends).toEqual([]);
    for (const table of ['jobs', 'thoughts', 'hires', 'worker_answers', 'pet_spend', 'project_spend', 'debit_sessions']) {
      expect(await rows(`SELECT 1 FROM ${table}`)).toEqual([]);
    }
    // the owner of the pet it named is asked nothing and sees nothing of it
    expect((await api('/api/pets/8/conversation', { token: await token('did:privy:third', NEAR_ACCOUNT(3)) })).body.lines).toEqual([]);
    void PAYER;
  });

  // spec: add-pet-work › Hire access data › платит не свой питомец
  it('refuses a pet given away since the page was drawn: the old owner is `not_payer`, the new one may ask', async () => {
    addPets(h);
    const tk = await payerToken();
    // a gift: the contract now says another account owns the payer
    h.net().contract.pets.get(PAYER)!.owner_id = NEAR_ACCOUNT(4);
    expect(await postAdvice(tk, {})).toMatchObject({ status: 403, body: { code: 'not_payer' } });
    expect(h.net().ai.calls).toHaveLength(0);
    const next = await token('did:privy:next', NEAR_ACCOUNT(4));
    expect(await advise(next)).toMatchObject({ thought: { kind: 'advice' } });
  });
});
