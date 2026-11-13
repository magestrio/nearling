import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, harness, say, settle } from './helpers/api';
import { addPet, callsOf, conversation, errand, errandRow, owner, OWNER, PET, richPet, sendErrand, stateOf, STARTER, thoughtsOf } from './helpers/errands';
import { NEAR_ACCOUNT, token } from './helpers/network';
import { clean } from '../src/cron';
import { until } from './helpers/work';

const h = harness();
// a session ended by one test must not end the next test's
beforeEach(async () => {
  await env.DB.exec('DELETE FROM ended_sessions');
});
const LINK_404 = 'https://members.example.com/area';

describe('Errand flow', () => {
  // spec: add-pet-errands › Errand flow › sent
  it('takes the errand: the row, the job, the event, and the pet is away', async () => {
    addPet(h);
    const tk = await owner();
    h.net().ai.push({ delay: 300 });
    const sent = await sendErrand(tk, 'read', 'The lease says the deposit is two months.');
    expect(sent.status).toBe(202);
    expect(typeof sent.body.job).toBe('string');
    expect(h.events().filter((e) => e.name === 'errand_given')).toEqual([{ name: 'errand_given', props: { form: 'read' } }]);

    const away = await stateOf(tk);
    expect(away.errand).toMatchObject({ state: 'away', form: 'read', job: 'The lease says the deposit is two months.' });
    expect(typeof away.errand.sentAt).toBe('number');
    // the errand's job is not the thought the page waits for: no «is thinking…»
    expect(away.pendingJob).toBeNull();
    expect(await errandRow()).toMatchObject({ state: 'away', owner: OWNER, form: 'read' });
    await settle(tk, PET, sent.body.job);
    expect((await stateOf(tk)).errand).toBeNull();
  });

  // spec: add-pet-errands › Errand flow › sent
  // spec: add-pet-errands › Errand flow › sent × the Composer's send while away
  it('refuses a second errand and a line while the pet is away', async () => {
    addPet(h);
    const tk = await owner();
    // the errand must still be on its way when the second one comes: under a loaded full run 300 ms was not enough
    h.net().ai.push({ delay: 2000 });
    const first = await sendErrand(tk, 'read', 'First text to read.');
    expect(first.status).toBe(202);
    const second = await sendErrand(tk, 'read', 'Second text to read.');
    expect(second).toMatchObject({ status: 409, body: { code: 'away' } });
    const line = await api(`/api/pets/${PET}/thoughts`, { token: tk, body: { text: 'Hi', mode: 'chat' } });
    expect(line).toMatchObject({ status: 409, body: { code: 'away' } });
    // «Think hard» is a line too
    expect((await api(`/api/pets/${PET}/thoughts`, { token: tk, body: { text: 'Hi', mode: 'deep' } })).status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'reply'").first<{ n: number }>())?.n).toBe(0);
    expect(h.events().filter((e) => e.name === 'errand_given')).toHaveLength(1);
    await settle(tk, PET, first.body.job);
    // back: the pet answers a line again
    expect((await say(tk, PET, 'Welcome back')).thought.text).toBe('Hello there, friend.');
  });

  // spec: add-pet-errands › Errand flow › sent
  it('takes only a known form and a job with a visible character within the limits', async () => {
    addPet(h);
    const tk = await owner();
    for (const body of [{ form: 'nope', job: 'x' }, { form: 'read', job: '   ' }, { form: 'read' }, { job: 'x' }, { form: 'find', job: 'a'.repeat(501) }, { form: 'read', job: 'a'.repeat(30_001) }]) {
      expect((await api(`/api/pets/${PET}/errand`, { token: tk, body })).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(await errandRow()).toBeNull();
    // the limit itself passes: 500 code points for a search form (an emoji is one)
    h.net().contract.pets.get(PET)!.given_food = (3n * STARTER).toString();
    const edge = await sendErrand(tk, 'find', '😀'.repeat(500));
    expect(edge.status).toBe(202);
  });

  // spec: add-pet-errands › Errand flow › sent
  it('runs the owner\'s errand only for the owner', async () => {
    addPet(h);
    const stranger = await token('did:privy:stranger', NEAR_ACCOUNT(2));
    expect(await sendErrand(stranger, 'read', 'Hello there')).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect(await errandRow()).toBeNull();
    expect((await api(`/api/pets/${PET}/errand`, { body: { form: 'read', job: 'x' } })).status).toBe(401);
    expect(await env.DB.prepare('SELECT 1 FROM jobs').first()).toBeNull();
  });

  // spec: add-pet-errands › Errand flow › sent × another tab sent an errand
  it('goes on from a second tab: the stale tab\'s send meets the pet away', async () => {
    addPet(h);
    const tk = await owner();
    h.net().ai.push({ delay: 300 });
    const fromTab1 = await sendErrand(tk, 'read', 'One text from tab one.');
    // tab two never saw tab one's errand
    const fromTab2 = await sendErrand(tk, 'read', 'Another text from tab two.');
    expect(fromTab1.status).toBe(202);
    expect(fromTab2).toMatchObject({ status: 409, body: { code: 'away' } });
    // one row, one job, tab one's words
    expect((await errandRow()).job).toBe('One text from tab one.');
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'errand'").first<{ n: number }>())?.n).toBe(1);
    await settle(tk, PET, fromTab1.body.job);
  });

  // spec: add-pet-errands › Errand flow › sent × the Composer's send while away
  it('refuses the Composer\'s send while away and queues nothing for the pet to answer later', async () => {
    addPet(h);
    const tk = await owner();
    h.net().ai.push({ delay: 300 });
    const sent = await sendErrand(tk, 'read', 'A text to read.');
    const line = await api(`/api/pets/${PET}/thoughts`, { token: tk, body: { text: 'Are you there?', mode: 'chat' } });
    expect(line.status).toBe(409);
    await settle(tk, PET, sent.body.job);
    const spoken = (await thoughtsOf()).filter((t) => t.kind !== 'errand');
    expect(spoken).toEqual([]);
  });
});

describe('Errand flow › the errand goes on without the tab', () => {
  // spec: add-pet-errands › Errand flow › tab closed while away
  it('ends with the report in the conversation though nothing polled it', async () => {
    addPet(h);
    const tk = await owner();
    h.net().ai.push({ delay: 100, content: 'The lease asks for two months of deposit.' });
    const sent = await sendErrand(tk, 'read', 'The lease says the deposit is two months.');
    expect(sent.status).toBe(202);
    // no state poll, no settle: the tab is closed
    await until(async () => (await errandRow())?.state === 'done');
    const lines = (await conversation(tk)).lines;
    expect(lines.map((l: any) => l.who)).toEqual(['player', 'pet']);
    expect(lines[0]).toMatchObject({ kicker: 'read', text: 'The lease says the deposit is two months.' });
    expect(lines[1]).toMatchObject({ text: 'The lease asks for two months of deposit.', report: { form: 'read', searches: 0, sources: [{ label: 'Your text' }], verdict: null } });
    // reopened: the pet is back, nothing is away
    expect((await stateOf(tk)).errand).toBeNull();
  });

  // spec: add-pet-errands › Errand flow › tab closed while away × sign-out
  it('goes on after the session ends: sign-out is not the errand\'s end, and the next sign-in finds the report', async () => {
    addPet(h);
    const tk = await owner();
    h.net().ai.push({ delay: 300, content: 'It says the deposit is two months.' });
    const sent = await sendErrand(tk, 'read', 'The lease says the deposit is two months.');
    expect(sent.status).toBe(202);
    expect((await api('/api/session/end', { method: 'POST', token: tk })).status).toBe(204);
    // the ended session is turned away
    expect((await api(`/api/pets/${PET}/state`, { token: tk })).status).toBe(401);
    await until(async () => (await errandRow())?.state === 'done');
    const again = await token('did:privy:owner', NEAR_ACCOUNT(1), { sid: 'sid-after' });
    expect((await conversation(again)).lines.map((l: any) => l.who)).toEqual(['player', 'pet']);
  });

  // spec: add-pet-errands › Errand flow › report × the pet given away while away
  it('lands as the pet\'s thought when the pet was given away meanwhile: the new owner reads it, the old owner is turned away', async () => {
    addPet(h);
    const tk = await owner();
    const newOwner = NEAR_ACCOUNT(7);
    h.net().ai.push({
      content: 'Birds, mostly.',
      during: () => {
        h.net().contract.pets.get(PET)!.owner_id = newOwner;
      },
    });
    const sent = await sendErrand(tk, 'read', 'What do cats dream about, in this text?');
    expect(sent.status).toBe(202);
    await until(async () => (await errandRow())?.state === 'done');
    expect((await api(`/api/pets/${PET}/conversation`, { token: tk })).status).toBe(403);
    const next = await token('did:privy:next', newOwner);
    const lines = (await conversation(next)).lines;
    expect(lines.map((l: any) => l.who)).toEqual(['player', 'pet']);
    expect(lines[1].text).toBe('Birds, mostly.');
  });
});

describe('Errand flow › failed errand after a reload', () => {
  const readFails = async (tk: string) => {
    h.net().web.page(LINK_404, { status: 404, body: 'gone' });
    return errand(tk, 'read', LINK_404);
  };

  // spec: add-pet-errands › Errand flow › failed errand after a reload
  it('keeps the form, the job and the reason of an errand that came back without a report, across fresh reads', async () => {
    addPet(h);
    const tk = await owner();
    await readFails(tk);
    for (let reads = 0; reads < 2; reads += 1) {
      expect((await stateOf(tk)).errand).toEqual({ state: 'failed', form: 'read', job: LINK_404, reason: 'unreadable' });
    }
    expect(await errandRow()).toMatchObject({ state: 'failed', reason: 'unreadable', job: LINK_404 });
  });

  // spec: add-pet-errands › Errand flow › failed errand after a reload × a new errand sent
  it('is replaced by the next errand: one row, the new words', async () => {
    addPet(h);
    const tk = await owner();
    await readFails(tk);
    h.net().ai.push({ delay: 200 });
    const next = await sendErrand(tk, 'read', 'A better text to read, pasted this time.');
    expect(next.status).toBe(202);
    expect(await errandRow()).toMatchObject({ state: 'away', reason: null, job: 'A better text to read, pasted this time.' });
    await settle(tk, PET, next.body.job);
    expect((await stateOf(tk)).errand).toBeNull();
  });

  // spec: add-pet-errands › Errand access data › given away after a failed errand
  it('is erased at a gift: the new owner sees no failed errand and no «Try again»', async () => {
    addPet(h);
    const tk = await owner();
    await readFails(tk);
    const newOwner = NEAR_ACCOUNT(8);
    h.net().contract.pets.get(PET)!.owner_id = newOwner;
    const next = await token('did:privy:next', newOwner);
    expect((await stateOf(next)).errand).toBeNull();
    expect(await errandRow()).toBeNull();
  });

  // spec: add-pet-errands › Errand access data › given away after a failed errand
  it('leaves the receipt the old owner paid for without its words', async () => {
    addPet(h);
    const tk = await owner();
    // the pet's fourth empty report of the day is its own to pay: a thought with the job and no reply
    await env.DB.prepare('INSERT INTO empty_answers (token_id, day, n) VALUES (?, ?, 3)').bind(PET, Math.floor(Date.now() / 86_400_000)).run();
    h.net().ai.push({ content: '', tokensOut: 5 });
    await errand(tk, 'read', 'A text the pet cannot answer about.');
    const row = await errandRow();
    expect(row).toMatchObject({ state: 'failed', reason: 'empty' });
    const paid = (await thoughtsOf())[0];
    expect(paid).toMatchObject({ kind: 'errand', reply_text: null, player_text: 'A text the pet cannot answer about.' });
    const newOwner = NEAR_ACCOUNT(8);
    h.net().contract.pets.get(PET)!.owner_id = newOwner;
    expect((await stateOf(await token('did:privy:next', newOwner))).errand).toBeNull();
    const kept = (await thoughtsOf())[0];
    expect(kept).toMatchObject({ id: paid.id, price_yocto: paid.price_yocto, player_text: null, reply_text: null });
    expect(kept.erased_at).not.toBeNull();
    const [call] = await callsOf(paid.id);
    expect(call.req_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.from(call.req_bytes as ArrayLike<number>)).toEqual([]);
  });

  // spec: add-pet-errands › Errand access data › given away after a failed errand
  it('erases the giver\'s paid failed errand before the new owner reads conversation first', async () => {
    addPet(h);
    const tk = await owner();
    await env.DB.prepare('INSERT INTO empty_answers (token_id, day, n) VALUES (?, ?, 3)').bind(PET, Math.floor(Date.now() / 86_400_000)).run();
    h.net().ai.push({ content: '', tokensOut: 5 });
    await errand(tk, 'read', 'The giver\'s old job.');
    const [paid] = await thoughtsOf();
    const nextOwner = NEAR_ACCOUNT(8);
    h.net().contract.pets.get(PET)!.owner_id = nextOwner;
    const next = await token('did:privy:next', nextOwner);
    expect((await conversation(next)).lines).toEqual([]);
    expect(await errandRow()).toBeNull();
    expect((await thoughtsOf())[0]).toMatchObject({ id: paid.id, player_text: null, reply_text: null, price_yocto: paid.price_yocto });
  });
});

describe('Errand flow › a failed errand nobody came back to', () => {
  // spec: add-pet-errands › Errand flow › failed errand after a reload
  it('keeps its form, job and reason after 30 days until the owner returns', async () => {
    addPet(h);
    const tk = await owner();
    h.net().web.page(LINK_404, { status: 404 });
    await errand(tk, 'read', LINK_404);
    await clean(env, Date.now() + 29 * 86_400_000);
    expect(await errandRow()).not.toBeNull();
    await clean(env, Date.now() + 31 * 86_400_000);
    expect(await errandRow()).toMatchObject({ state: 'failed', form: 'read', job: LINK_404, reason: 'unreadable' });
    expect((await stateOf(tk)).errand).toMatchObject({ state: 'failed', form: 'read', job: LINK_404, reason: 'unreadable' });
  });
});

describe('Errand flow › the conversation of a search errand', () => {
  // spec: add-pet-errands › Errand flow › report
  it('gives a search report its sources, verdict, searches and price, and the job above it with its form', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 2 } }, { content: 'VERDICT: TRUE\nThree hearts, two sources [1][4].' });
    await errand(tk, 'check', 'Octopuses have three hearts.');
    const lines = (await conversation(tk)).lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ who: 'player', kicker: 'check', text: 'Octopuses have three hearts.' });
    expect(lines[1]).toEqual({
      id: expect.any(String),
      who: 'pet',
      text: 'Three hearts, two sources.',
      at: expect.any(Number),
      report: {
        form: 'check',
        sources: [
          { label: 'site11.example.com', url: 'https://www.site11.example.com/page' },
          { label: 'site21.example.com', url: 'https://www.site21.example.com/page' },
        ],
        verdict: 'true',
        searches: 2,
        priceCents: expect.any(Number),
        missed: [],
      },
    });
    expect(lines[1].report.priceCents).toBeGreaterThan(1);
  });

  // spec: add-pet-errands › Errand flow › tab closed while away
  it('keeps the away thought of the searches out of the log until the report lands', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 1 } }, { delay: 300, content: 'Found [1].' });
    const sent = await sendErrand(tk, 'find', 'What is the tallest tree?');
    await until(() => h.net().ai.calls.length === 2);
    // the search call is stored, the pet is still away: no half line in the conversation, the job is in the state
    expect((await conversation(tk)).lines).toEqual([]);
    expect((await stateOf(tk)).errand).toMatchObject({ state: 'away', form: 'find', job: 'What is the tallest tree?' });
    await settle(tk, PET, sent.body.job);
    expect((await conversation(tk)).lines.map((l: any) => l.who)).toEqual(['player', 'pet']);
  });
});
