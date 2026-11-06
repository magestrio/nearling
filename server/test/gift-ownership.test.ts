import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { enqueueJob, desk } from '../src/pet/desk';
import { buildMessages } from '../src/prompt';
import { petView } from '../src/chain';
import { sealText, writeSkill } from '../src/work/skill';
import { until } from './helpers/work';
import { api, harness, say } from './helpers/api';
import { keyedPlayer, NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const PET = '94';
const GIVER = NEAR_ACCOUNT(51);
const RECEIVER = NEAR_ACCOUNT(52);
const giver = () => token('did:privy:gift-memory-giver', GIVER);
const receiver = () => token('did:privy:gift-memory-receiver', RECEIVER);

async function seed() {
  h.net().contract.addPet(PET, GIVER);
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, 1, ?)').bind(PET, GIVER, '').run();
  const old = await giver();
  const next = await receiver();
  return { old, next };
}

async function thought(id: string, at: number, player: string | null, reply: string, owner: string | null = null, sentAt: number | null = null, kind = 'reply') {
  await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status, origin_owner, origin_sent_at) VALUES (?, ?, ?, ?, ?, ?, 'm', '1', 0, 'pet', 'unbilled', ?, ?)")
    .bind(id, PET, at, kind, player, reply, owner, sentAt).run();
}

describe('ownership at the gift boundary', () => {
  // spec: add-gift › Gift ownership data › cleared running job survives gift
  it('shows the new owner a word-free reserve and takes only their Release approval', async () => {
    const first = keyedPlayer();
    h.net().contract.addPet(PET, first.account);
    const firstToken = await token(`did:privy:${first.account}`, first.account);
    const made = await api(`/api/pets/${PET}/shared-errands`, { token: firstToken, body: { form: 'find', job: 'Secret named job' } });
    expect(made.status).toBe(201);
    const pet = h.net().contract.pets.get(PET)!;
    const hash = pet.shared_job!.hash;
    pet.shared_job!.state = 'Running';
    pet.shared_job!.linked_near = '123';
    await env.DB.prepare("UPDATE shared_errands SET state = 'running' WHERE token_id = ?").bind(PET).run();
    h.net().contract.sharedCloseFails = 'temporarily_unavailable';
    expect((await api(`/api/pets/${PET}/memory/clear`, { token: firstToken, body: { approval: await first.closeApproval(PET, hash) } })).body.code).toBe('close_retry');
    h.net().contract.sharedCloseFails = null;
    const next = keyedPlayer();
    pet.owner_id = next.account;
    pet.transfer_generation += 1;
    pet.shared_job!.state = 'Transferred';
    const nextToken = await token(`did:privy:${next.account}`, next.account);
    const oldView = await api(`/api/pets/${PET}`, { token: firstToken });
    expect(oldView.body).not.toHaveProperty('oldSharedReserve');
    const view = await api(`/api/pets/${PET}`, { token: nextToken });
    expect(view.body.oldSharedReserve).toEqual({ jobHash: hash, amountYocto: '123' });
    expect(JSON.stringify(view.body)).not.toContain('Secret named job');
    expect((await api(`/api/pets/${PET}/shared-errands`, { token: nextToken, body: { form: 'find', job: 'Another job' } })).body.code).toBe('shared_job_active');
    const released = await api(`/api/pets/${PET}/shared-close`, { token: nextToken, body: { approval: await next.closeApproval(PET, hash) } });
    expect(released).toMatchObject({ status: 200, body: { ok: true } });
    expect((await api(`/api/pets/${PET}`, { token: nextToken })).body.oldSharedReserve).toBeNull();
  });
  // spec: add-pet-errands › Shared errand access data › gift during a running shared job
  // spec: add-pet-errands › Friend-funded errand flow › gifted while away
  it('revokes the sponsor link at transfer while the old shared job spends linked food once for the new owner', async () => {
    const { old, next } = await seed();
    const made = await api(`/api/pets/${PET}/shared-errands`, { token: old,
      body: { form: 'find', job: 'When does the meteor shower peak?' } });
    expect(made.status).toBe(201);
    const friend = keyedPlayer();
    h.net().contract.balances.set(friend.account, 10n ** 24n);
    const friendToken = await token(`did:privy:${friend.account}`, friend.account);
    const built = await api(`/api/pets/${PET}/feed`, { token: friendToken,
      body: { portion: '0.01', code: made.body.code } });
    const fed = await api(`/api/pets/${PET}/feed/send`, { token: friendToken,
      body: { ...await friend.sign(built.body.tx), code: made.body.code } });
    expect(fed.body.status).toBe('ok');
    const before = h.net().contract.pets.get(PET)!;
    const ordinary = before.project_food;
    h.net().ai.push({ stream: { searches: 1 }, during: async () => {
      const pet = h.net().contract.pets.get(PET)!;
      pet.owner_id = RECEIVER;
      pet.transfer_generation += 1;
      pet.shared_job!.state = 'Transferred';
      await env.DB.prepare('UPDATE pets SET last_gift_block_at = ? WHERE token_id = ?').bind(Date.now() + 1, PET).run();
    } }, { content: 'It peaks in November [1].' });
    await desk(env, PET).process(PET);
    expect((await api(`/api/pets/${PET}/errand/${made.body.code}`, { token: friendToken })).body.state).toBe('empty');
    const thought = await env.DB.prepare("SELECT status, price_yocto FROM thoughts WHERE token_id = ? AND kind = 'errand'")
      .bind(PET).first<{ status: string; price_yocto: string }>();
    expect(thought?.status).toBe('billed');
    expect(h.net().contract.pets.get(PET)!.project_food).toBe(ordinary);
    expect(h.net().contract.pets.get(PET)!.shared_job).toBeNull();
    expect(h.net().contract.debits).toHaveLength(1);
    const lines = (await api(`/api/pets/${PET}/conversation`, { token: next })).body.lines;
    expect(lines.find((line: any) => line.text === 'It peaks in November.')).toMatchObject({ previousOwner: true });
  }, 15_000);
  // spec: add-gift › Gift rule › дарящий после подарка
  // spec: add-gift › Gift ownership data › открытая вкладка дарящего × second owner action
  it('rejects the giver on every owner route, including Wear and mode changes', async () => {
    const { old, next } = await seed();
    h.net().contract.pets.get(PET)!.owner_id = RECEIVER;
    expect((await api(`/api/pets/${PET}`, { token: old })).body.viewer).toBe('guest');
    expect((await api(`/api/pets/${PET}/conversation`, { token: old })).status).toBe(403);
    expect((await api(`/api/pets/${PET}/diary`, { token: old })).status).toBe(403);
    expect((await api(`/api/pets/${PET}/skill`, { token: old })).status).toBe(403);
    expect((await api(`/api/pets/${PET}/hire-mode`, { token: old, method: 'PUT', body: { mode: 'manual' } })).status).toBe(403);
    expect((await api(`/api/pets/${PET}/thoughts`, { token: old, body: { text: 'Still mine?', mode: 'chat' } })).status).toBe(403);
    expect((await api(`/api/pets/${PET}/conversation`, { token: next })).status).toBe(200);
    expect(h.net().ai.calls).toHaveLength(0);
  });

  // spec: add-gift › Gift rule › ответ после подарка × queued old-owner line/transfer
  it('stops a queued giver line before inference and hides its pending text from the receiver', async () => {
    const { next } = await seed();
    const job = await enqueueJob(env.DB, PET, { kind: 'reply', mode: 'chat', text: 'Old private words' }, GIVER);
    h.net().contract.pets.get(PET)!.owner_id = RECEIVER;
    const received = await api(`/api/pets/${PET}`, { token: next });
    expect(received.body.pendingText).toBeNull();
    expect(received.body.hello).toBe(true);
    expect((await api(`/api/pets/${PET}/state?job=${job}`, { token: next })).status).toBe(404);
    await desk(env, PET).process(PET);
    expect((await env.DB.prepare('SELECT status, payload FROM jobs WHERE id = ?').bind(job).first())).toEqual({ status: 'failed', payload: null });
    expect(h.net().ai.calls).toHaveLength(0);
  });

  // spec: add-gift › Gift rule › ответ после подарка × running thought/reply lands
  it('keeps a reply already in inference beside the former owner line after transfer', async () => {
    const { old, next } = await seed();
    const chain = h.net().contract;
    h.net().ai.push({ content: 'A late answer.', during: async () => {
      chain.pets.get(PET)!.owner_id = RECEIVER;
      await env.DB.prepare('UPDATE pets SET last_gift_block_at = ? WHERE token_id = ?').bind(Date.now() + 1, PET).run();
    } });
    await say(old, PET, 'A line before the gift.');
    const lines = (await api(`/api/pets/${PET}/conversation`, { token: next })).body.lines;
    expect(lines.map((line: any) => line.who)).toEqual(['player', 'pet', 'event']);
    expect(lines[0]).toMatchObject({ text: 'A line before the gift.', previousOwner: true });
    expect(lines[1]).toMatchObject({ text: 'A late answer.', previousOwner: true });
    expect(h.net().ai.calls).toHaveLength(1);
  });

  // spec: add-gift › Gift rule › ответ после подарка
  // spec: add-gift › Gift rule › ordinary errand after gift
  it('orders late replies and reports with the former owner above the gift event', async () => {
    const { next } = await seed();
    const at = Date.now();
    await thought('old', at - 2_000, 'Before gift', 'Old answer', GIVER, at - 2_000);
    await thought('advice', at - 1_500, 'Old question', 'A worker answered', GIVER, at - 1_500, 'advice');
    await thought('late', at + 1_000, 'On its way', 'Late answer', GIVER, at - 1_000);
    await thought('errand', at + 2_000, 'Old job', 'Late report', GIVER, at - 500, 'errand');
    await thought('new', at + 3_000, 'Hello', 'Welcome', RECEIVER, at + 3_000);
    await env.DB.prepare('UPDATE pets SET last_gift_block_at = ? WHERE token_id = ?').bind(at, PET).run();
    h.net().contract.pets.get(PET)!.owner_id = RECEIVER;
    const result = await api(`/api/pets/${PET}/conversation`, { token: next });
    expect(result.status).toBe(200);
    expect(result.body.lines.map((line: any) => line.id)).toEqual(['old:you', 'old', 'advice:you', 'advice', 'late:you', 'late', 'errand:you', 'errand', `gift:${at}`, 'new:you', 'new']);
    expect(result.body.lines.find((line: any) => line.id === 'advice')).toMatchObject({ who: 'worker', previousOwner: true });
    expect(result.body.lines.filter((line: any) => line.previousOwner).map((line: any) => line.id)).toHaveLength(8);
    expect((await api(`/api/pets/${PET}`, { token: next })).body.hello).toBe(false);
  });

  // spec: add-gift › Gift rule › ordinary errand after gift × transfer/result lands
  it('lets a running ordinary errand finish on the pet food under Previous owner', async () => {
    const { old, next } = await seed();
    const chain = h.net().contract;
    h.net().ai.push({ content: 'The text says it will rain.', during: async () => {
      chain.pets.get(PET)!.owner_id = RECEIVER;
      await env.DB.prepare('UPDATE pets SET last_gift_block_at = ? WHERE token_id = ?').bind(Date.now() + 1, PET).run();
    } });
    const sent = await api(`/api/pets/${PET}/errand`, { token: old, body: { form: 'read', job: 'The note says rain tomorrow.' } });
    expect(sent.status).toBe(202);
    await until(async () => (await env.DB.prepare('SELECT status FROM jobs WHERE id = ?').bind(sent.body.job).first<{ status: string }>())?.status === 'done');
    const row = await env.DB.prepare("SELECT origin_owner, price_yocto FROM thoughts WHERE token_id = ? AND kind = 'errand'").bind(PET).first<{ origin_owner: string; price_yocto: string }>();
    expect(row?.origin_owner).toBe(GIVER);
    expect(BigInt(row?.price_yocto ?? '0')).toBeGreaterThan(0n);
    const conversation = await api(`/api/pets/${PET}/conversation`, { token: next });
    expect(conversation.body.lines.map((line: any) => line.who)).toEqual(['player', 'pet', 'event']);
    expect(conversation.body.lines[0]).toMatchObject({ text: 'The note says rain tomorrow.', previousOwner: true });
    expect(conversation.body.lines[1]).toMatchObject({ text: 'The text says it will rain.', previousOwner: true });
    expect((await api(`/api/pets/${PET}`, { token: next })).body.fullness.level).toBeLessThan(1);
  });

  // spec: add-gift › Gift ownership data › запись дневника до подарка
  it('tags the earlier diary without opening it and keeps reading available to the receiver', async () => {
    const { next } = await seed();
    const at = Date.now();
    await thought('diary-old', at - 1_000, null, 'Yesterday was quiet.\nHow was yours?', GIVER, at - 1_000, 'diary');
    await env.DB.prepare('UPDATE pets SET last_gift_block_at = ? WHERE token_id = ?').bind(at, PET).run();
    h.net().contract.pets.get(PET)!.owner_id = RECEIVER;
    const view = await api(`/api/pets/${PET}`, { token: next });
    expect(view.body.diaryUnread).toBe(false);
    const diary = await api(`/api/pets/${PET}/diary`, { token: next });
    expect(diary.body.entry).toMatchObject({ kind: 'text', previousOwner: true });
    expect(diary.body.read).toBe(false);
    expect((await api(`/api/pets/${PET}/diary/read`, { token: next, body: { day: diary.body.day } })).status).toBe(200);
    expect((await api(`/api/pets/${PET}/diary`, { token: next })).body.read).toBe(true);
  });

  // spec: add-gift › Gift rule › серия в день подарка
  it('keeps a completed ritual, streak and freezes on the pet for the receiver', async () => {
    const { next } = await seed();
    const day = Math.floor(Date.now() / 86_400_000);
    const pet = h.net().contract.pets.get(PET)!;
    pet.streak = 4;
    pet.freezes = 2;
    pet.last_streak_day = day;
    await env.DB.prepare('INSERT INTO ritual_days (token_id, day, completed_at, marked_at) VALUES (?, ?, ?, ?)')
      .bind(PET, day, Date.now(), Date.now()).run();
    pet.owner_id = RECEIVER;
    const diary = await api(`/api/pets/${PET}/diary`, { token: next });
    expect(diary.body.complete).toBe(true);
    expect(diary.body.streak).toMatchObject({ days: 4, freezes: 2 });
    expect((await env.DB.prepare('SELECT completed_at, marked_at FROM ritual_days WHERE token_id = ? AND day = ?').bind(PET, day).first<{ completed_at: number; marked_at: number }>())?.completed_at).toBeTruthy();
  });

  // spec: add-gift › Gift ownership data › память у нового владельца
  it('marks retained old memory as belonging to the previous owner and omits erased words', async () => {
    const { next } = await seed();
    const at = Date.now();
    await thought('old', at - 1_000, 'Old owner said hello', 'Old pet reply', GIVER, at - 1_000);
    await thought('erased', at - 900, null, '', GIVER, at - 900);
    await env.DB.prepare('UPDATE thoughts SET reply_text = NULL, erased_at = ? WHERE id = ?').bind(at - 800, 'erased').run();
    await env.DB.prepare('UPDATE pets SET last_gift_block_at = ? WHERE token_id = ?').bind(at, PET).run();
    h.net().contract.pets.get(PET)!.owner_id = RECEIVER;
    const pet = (await petView(env, PET))!;
    const messages = await buildMessages(env.DB, PET, pet, { kind: 'reply', mode: 'chat', text: 'Do you remember?' }, { mood: null, energyPercent: 100 });
    const body = JSON.stringify(messages);
    expect(body).toContain('previous owner');
    expect(body).toContain('[Previous owner] Old owner said hello');
    expect(body).not.toContain('erased');
    await say(next, PET, 'Do you remember?');
    const sent = new TextDecoder().decode(h.net().ai.calls[0]!.reqBytes);
    expect(sent).toContain('[Previous owner] Old owner said hello');
    expect(sent).toContain('previous owner');
    expect(sent).not.toContain('erased');
  });

  // spec: add-gift › Gift ownership data › навык с данными и кодом
  // spec: add-gift › Gift rule › жизнь и вещи
  it('keeps token-id skill, code, source, catalog, mode and outfits for the receiver only', async () => {
    const { old, next } = await seed();
    const chain = h.net().contract;
    chain.pets.get(PET)!.outfits = [0, 1];
    chain.pets.get(PET)!.streak = 4;
    await writeSkill(env, PET, { label: 'Daybook', instruction: 'Private skill instruction' }, Date.now());
    const sealed = await sealText(env, `${PET}:code`, 'function answer() { return 1; }');
    await env.DB.prepare('INSERT INTO skill_code (token_id, ct, iv, hash, functions, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(PET, sealed.ct, sealed.iv, 'hash', '[]', Date.now()).run();
    await env.DB.prepare("INSERT INTO data_sources (id, token_id, added_by, label, addr_ct, addr_iv, tools, created_at, updated_at) VALUES (?, ?, ?, 'Private source', x'00', x'00', '[]', 1, 1)")
      .bind('a'.repeat(24), PET, GIVER).run();
    await env.DB.prepare("INSERT INTO catalog_entries (id, token_id, source_id, name, address, tools, pet_name, published_at) VALUES (?, ?, ?, 'Listed source', 'https://example.com', '[]', 'Pixel', 1)")
      .bind('b'.repeat(24), PET, 'a'.repeat(24)).run();
    await env.DB.prepare("INSERT INTO hire_modes (token_id, mode) VALUES (?, 'manual')").bind(PET).run();
    chain.pets.get(PET)!.owner_id = RECEIVER;
    expect((await api(`/api/pets/${PET}`, { token: old })).body).not.toHaveProperty('hireMode');
    expect((await api(`/api/pets/${PET}/skill`, { token: old })).status).toBe(403);
    expect((await api(`/api/pets/${PET}/code`, { token: old })).status).toBe(403);
    const owner = await api(`/api/pets/${PET}`, { token: next });
    expect(owner.body).toMatchObject({ viewer: 'owner', hireMode: 'manual', outfits: ['daisy-crown', 'cozy-scarf'] });
    expect(chain.pets.get(PET)!.streak).toBe(4);
    const skill = await api(`/api/pets/${PET}/skill`, { token: next });
    expect(skill.body.skill).toMatchObject({ label: 'Daybook', instruction: 'Private skill instruction' });
    expect(skill.body.sources).toMatchObject([{ label: 'Private source', gift: true }]);
    expect(JSON.stringify(skill.body)).not.toContain('https://example.com');
    expect((await api(`/api/pets/${PET}/code`, { token: next })).body.code).toBe('function answer() { return 1; }');
    expect((await api('/api/adapters')).body.entries).toMatchObject([{ name: 'Listed source' }]);
    expect((await api(`/api/pets/${PET}/sources/${'a'.repeat(24)}/publish`, { token: next, method: 'POST' })).body.code).toBe('gift');
  });
});
