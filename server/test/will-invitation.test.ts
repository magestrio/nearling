import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { tick } from '../src/cron';
import { api, harness } from './helpers/api';
import { keyedPlayer, NEAR_ACCOUNT, token } from './helpers/network';
import { invitationOffer, invitationStatement } from '../src/will/invitation';
import { petView } from '../src/chain';

const h = harness();
const OWNER = NEAR_ACCOUNT(701);
const RECIPIENT = NEAR_ACCOUNT(702);
const THIRD = NEAR_ACCOUNT(703);
const day = (n: number) => Date.UTC(2036, 10, n, 0, 5);
const utc = (at: number) => Math.floor(at / 86_400_000);

async function pet(id: string, owner: string, name: string, wish = false): Promise<void> {
  h.net().contract.addPet(id, owner, { name, wish_active: wish,
    given_food: (5n * BigInt(env.STARTER_FOOD)).toString() });
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, 1, ?)')
    .bind(id, owner, '').run();
  if (id !== '701') await env.DB.prepare('UPDATE pets SET born_at = ? WHERE token_id = ?')
    .bind(Date.now(), id).run();
  if (wish) await env.DB.prepare(`INSERT INTO pet_wishes
    (token_id, item, reason, status, owner_generation, memory_epoch, diary_day, start_op, created_at)
    VALUES (?, 'bow-tie', 'It fits me', 'active', 0, 0, 1, ?, 1)`)
    .bind(id, `start-${id}`).run();
}

async function relation(sender: string, recipient: string, stance = 'neutral'): Promise<void> {
  await env.DB.prepare('INSERT INTO society_relations (token_id, other_id, stance, created_at) VALUES (?, ?, ?, ?)')
    .bind(sender, recipient, stance, Date.now()).run();
  h.net().contract.known.add(`${sender}:${h.net().contract.pets.get(recipient)!.owner_id}`);
}

async function invite(sender: string, recipient: string, created: number, id = 'a'.repeat(24)): Promise<void> {
  await env.DB.prepare(`INSERT INTO work_invitations
    (id, sender_token, recipient_token, day, created_at, expires_at, sender_generation, recipient_generation)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0)`)
    .bind(id, sender, recipient, utc(created), created, (utc(created) + 1) * 86_400_000).run();
}

describe('one private work invitation per diary opportunity', () => {
  // spec: add-pet-will › Work seeking flow › invitation created
  it('selects a liked known other-owner pet in the paid diary without another model call', async () => {
    vi.setSystemTime(day(2));
    await pet('701', OWNER, 'Pixel', true);
    await pet('702', RECIPIENT, 'Moss');
    await pet('703', THIRD, 'Dot');
    await relation('701', '702', 'neutral');
    await relation('701', '703', 'liked');
    h.net().ai.push({ content: 'INVITE 1\nI have a story.\nHow was your day?' });
    await tick(env, Date.now());
    expect(h.net().ai.calls).toHaveLength(1);
    const prompt = JSON.stringify(h.net().ai.calls[0]!.body.messages);
    expect(prompt.indexOf('Dot')).toBeLessThan(prompt.indexOf('Moss'));
    expect(prompt).not.toContain(RECIPIENT);
    expect(prompt).not.toContain(THIRD);
    const rows = (await env.DB.prepare('SELECT sender_token, recipient_token FROM work_invitations').all<{
      sender_token: string; recipient_token: string;
    }>()).results;
    expect(rows).toEqual([{ sender_token: '701', recipient_token: '703' }]);
    expect(h.events().filter((event) => event.name === 'pet_work_invited')).toHaveLength(1);
  });

  // spec: add-pet-will › Work seeking flow › invitation created
  it('can choose a new wish and a work invitation in the same paid thought', async () => {
    vi.setSystemTime(day(2));
    await pet('701', OWNER, 'Pixel');
    await pet('702', RECIPIENT, 'Moss');
    await relation('701', '702');
    h.net().ai.push({ content: 'WISH bow-tie | It fits me | I imagine a bow tie.\nINVITE 1\nHow are you?' });
    await tick(env, Date.now());
    expect(h.net().ai.calls).toHaveLength(1);
    expect(h.net().contract.pets.get('701')?.wish_active).toBe(true);
    expect(h.events().filter((event) => event.name === 'pet_work_invited')).toHaveLength(1);
    const reader = await token('did:privy:invitation-reader', RECIPIENT);
    expect((await api('/api/pets/702/invitations', { token: reader })).body.invitations).toHaveLength(1);
  });

  // spec: add-pet-will › Work seeking flow › invitation created
  it('removes a provisional invitation when the wish cannot start', async () => {
    vi.setSystemTime(day(2));
    await pet('701', OWNER, 'Pixel');
    await pet('702', RECIPIENT, 'Moss');
    await relation('701', '702');
    h.net().contract.willStartFails = 'pool_empty';
    h.net().ai.push({ content: 'WISH bow-tie | It fits me | I imagine a bow tie.\nINVITE 1\nHow are you?' });
    await tick(env, Date.now());
    expect((await env.DB.prepare('SELECT * FROM work_invitations').all()).results).toHaveLength(0);
    expect(h.events().filter((event) => event.name === 'pet_work_invited')).toHaveLength(0);
  });

  // spec: add-pet-will › Work seeking flow › no eligible acquaintance
  it('sends nothing for no acquaintance, same-owner acquaintance or a refused pair', async () => {
    vi.setSystemTime(day(2));
    await pet('701', OWNER, 'Pixel', true);
    await pet('702', OWNER, 'Same');
    await pet('703', THIRD, 'Other');
    await relation('701', '702');
    await relation('701', '703');
    await env.DB.prepare('UPDATE society_relations SET break_until = ? WHERE token_id = ? AND other_id = ?')
      .bind(day(3), '701', '703').run();
    h.net().ai.push({ content: 'INVITE 1\nHow are you?' });
    await tick(env, Date.now());
    expect((await env.DB.prepare('SELECT * FROM work_invitations').all()).results).toHaveLength(0);
  });

  // spec: add-pet-will › Work seeking flow › pet asleep
  it('sends no invitation when the sender is asleep', async () => {
    vi.setSystemTime(day(2));
    await pet('701', OWNER, 'Pixel', true);
    await pet('702', RECIPIENT, 'Moss');
    await relation('701', '702');
    await env.DB.prepare('UPDATE pets SET slept_at = ? WHERE token_id = ?').bind(Date.now(), '701').run();
    await tick(env, Date.now());
    expect((await env.DB.prepare('SELECT * FROM work_invitations').all()).results).toHaveLength(0);
    expect(h.net().ai.calls).toHaveLength(0);
  });

  // spec: add-pet-will › Work seeking flow › invitation created
  it('keeps the unique sender/day row under concurrent attempts, then allows the next UTC day', async () => {
    vi.setSystemTime(day(2));
    await pet('701', OWNER, 'Pixel', true);
    await pet('702', RECIPIENT, 'Moss');
    await relation('701', '702');
    await invite('701', '702', Date.now());
    await Promise.all([env.DB.prepare(`INSERT OR IGNORE INTO work_invitations
      (id, sender_token, recipient_token, day, created_at, expires_at, sender_generation, recipient_generation)
      VALUES (?, '701', '702', ?, ?, ?, 0, 0)`).bind('b'.repeat(24), utc(Date.now()), Date.now(), day(3)).run(),
    env.DB.prepare(`INSERT OR IGNORE INTO work_invitations
      (id, sender_token, recipient_token, day, created_at, expires_at, sender_generation, recipient_generation)
      VALUES (?, '701', '702', ?, ?, ?, 0, 0)`).bind('c'.repeat(24), utc(Date.now()), Date.now(), day(3)).run()]);
    expect((await env.DB.prepare('SELECT * FROM work_invitations').all()).results).toHaveLength(1);
    vi.setSystemTime(day(3));
    const sender = (await petView(env, '701'))!;
    const offer = await invitationOffer(env, '701', sender, utc(Date.now()), Date.now(), true);
    expect(offer.candidates.map((candidate) => candidate.tokenId)).toEqual(['702']);
    await invitationStatement(env.DB, '701', offer.senderGeneration, offer.candidates[0]!, utc(Date.now()), 0, Date.now()).run();
    expect((await env.DB.prepare('SELECT * FROM work_invitations').all()).results).toHaveLength(2);
  });
});

describe('recipient cards', () => {
  // spec: add-pet-will › Invitation delivery data › private delivery
  // spec: add-pet-will › Work invitation card screen › several valid invitations
  it('returns every valid card newest first, with public worker fields only', async () => {
    vi.setSystemTime(day(2));
    await pet('701', OWNER, 'Pixel', true);
    await pet('702', RECIPIENT, 'Moss');
    await pet('703', THIRD, 'Dot', true);
    await invite('701', '702', Date.now() - 20_000);
    await invite('703', '702', Date.now() - 10_000, 'b'.repeat(24));
    const tk = await token('did:privy:recipient', RECIPIENT);
    const read = await api('/api/pets/702/invitations', { token: tk });
    expect(read.status).toBe(200);
    expect(read.body.invitations.map((card: { name: string }) => card.name)).toEqual(['Dot', 'Pixel']);
    expect(JSON.stringify(read.body)).not.toMatch(/owner|reason|stance|question|account/i);
    expect(read.body.invitations[0].price.yocto).toMatch(/^\d+$/);
  });

  // spec: add-pet-will › Work seeking flow › recipient dismisses
  // spec: add-pet-will › Work invitation card screen › several valid invitations × Dismiss on one card
  it('dismisses only the selected card without food, energy or relationship movement', async () => {
    vi.setSystemTime(day(2));
    await pet('701', OWNER, 'Pixel', true);
    await pet('702', RECIPIENT, 'Moss');
    await pet('703', THIRD, 'Dot', true);
    await invite('701', '702', Date.now() - 20_000);
    await invite('703', '702', Date.now() - 10_000, 'b'.repeat(24));
    const before = JSON.stringify([...h.net().contract.pets]);
    const tk = await token('did:privy:recipient', RECIPIENT);
    expect((await api(`/api/pets/702/invitations/${'a'.repeat(24)}/dismiss`, { token: tk, method: 'POST' })).status).toBe(200);
    expect((await api('/api/pets/702/invitations', { token: tk })).body.invitations).toHaveLength(1);
    expect(JSON.stringify([...h.net().contract.pets])).toBe(before);
    expect((await env.DB.prepare('SELECT * FROM society_relations').all()).results).toHaveLength(0);
    expect((await env.DB.prepare('SELECT * FROM hires').all()).results).toHaveLength(0);
  });

  // spec: add-pet-will › Work seeking flow › recipient accepts
  // spec: add-pet-will › Work invitation card screen › several valid invitations × Ask {worker} on one card
  it('accepts only the selected card with a fresh quote and blank question, without a hire', async () => {
    vi.setSystemTime(day(2));
    await pet('701', OWNER, 'Pixel', true);
    await pet('702', RECIPIENT, 'Moss');
    await pet('703', THIRD, 'Dot', true);
    await invite('701', '702', Date.now() - 20_000);
    await invite('703', '702', Date.now() - 10_000, 'b'.repeat(24));
    const tk = await token('did:privy:recipient', RECIPIENT);
    await env.DB.prepare("INSERT INTO skills (token_id, label, ct, iv, updated_at) VALUES ('701', 'Stories', x'00', x'00', ?)")
      .bind(Date.now()).run();
    const original = (await api('/api/pets/702/invitations', { token: tk })).body.invitations[1].price.yocto;
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n) VALUES (?, ?, 1)')
      .bind('701', utc(Date.now())).run();
    const result = await api(`/api/pets/702/invitations/${'a'.repeat(24)}/accept`, { token: tk, method: 'POST' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ workerId: '701', question: '', name: 'Pixel' });
    expect(BigInt(result.body.price.yocto)).toBeGreaterThan(BigInt(original));
    expect(h.events().filter((event) => event.name === 'pet_work_invitation_accepted')).toHaveLength(1);
    expect((await api(`/api/pets/702/invitations/${'a'.repeat(24)}/accept`, { token: tk, method: 'POST' })).status).toBe(409);
    expect(h.events().filter((event) => event.name === 'pet_work_invitation_accepted')).toHaveLength(1);
    expect((await api('/api/pets/702/invitations', { token: tk })).body.invitations).toHaveLength(1);
    expect((await env.DB.prepare('SELECT * FROM hires').all()).results).toHaveLength(0);
  });

  // spec: add-pet-will › Invitation delivery data › former recipient
  // spec: add-pet-will › Invitation delivery data › former recipient × Gift after accept
  it('withholds a recipient gift, including from its new owner and after reload', async () => {
    vi.setSystemTime(day(2));
    await pet('701', OWNER, 'Pixel', true);
    await pet('702', RECIPIENT, 'Moss');
    await invite('701', '702', Date.now());
    const old = await token('did:privy:recipient', RECIPIENT);
    expect((await api('/api/pets/702/invitations', { token: old })).body.invitations).toHaveLength(1);
    expect((await api(`/api/pets/702/invitations/${'a'.repeat(24)}/accept`, { token: old, method: 'POST' })).status).toBe(200);
    h.net().contract.pets.get('702')!.owner_id = THIRD;
    h.net().contract.pets.get('702')!.transfer_generation += 1;
    expect((await api('/api/pets/702/invitations', { token: old })).status).toBe(403);
    expect((await api('/api/pets/701/advice?payer=702', { token: old })).status).toBe(403);
    const next = await token('did:privy:new', THIRD);
    expect((await api('/api/pets/702/invitations', { token: next })).body.invitations).toHaveLength(0);
  });

  // spec: add-pet-will › Will ownership rule › gift confirmed × Sender gift
  it('withholds a card after an outside-app sender transfer', async () => {
    vi.setSystemTime(day(2));
    await pet('701', OWNER, 'Pixel', true);
    await pet('702', RECIPIENT, 'Moss');
    await invite('701', '702', Date.now());
    h.net().contract.pets.get('701')!.owner_id = THIRD;
    h.net().contract.pets.get('701')!.transfer_generation += 1;
    const tk = await token('did:privy:recipient', RECIPIENT);
    expect((await api('/api/pets/702/invitations', { token: tk })).body.invitations).toHaveLength(0);
    expect((await env.DB.prepare('SELECT status FROM work_invitations').first<{ status: string }>())?.status).toBe('expired');
  });

  // spec: add-pet-will › Will ownership rule › gift confirmed × Sender gift
  it('expires an open card in the confirmed gift batch', async () => {
    vi.setSystemTime(day(2));
    const giver = keyedPlayer();
    await pet('701', giver.account, 'Pixel', true);
    await pet('702', RECIPIENT, 'Moss');
    await invite('701', '702', Date.now());
    h.net().contract.balances.set(giver.account, 10n ** 23n);
    const giverToken = await token('did:privy:invitation-giver', giver.account);
    const friendToken = await token('did:privy:invitation-friend', THIRD);
    await env.DB.prepare('UPDATE players SET first_name = ? WHERE account_id = ?').bind('Friend', THIRD).run();
    const link = await api('/api/pets/701/gift', { token: giverToken, method: 'POST' });
    expect(link.status).toBe(200);
    expect((await api(`/api/gifts/${link.body.code}/accept`, { token: friendToken, method: 'POST' })).status).toBe(200);
    const prepared = await api('/api/pets/701/gift/prepare', { token: giverToken, method: 'POST' });
    expect(prepared.body.status).toBe('ready');
    const sent = await api('/api/pets/701/gift/send', { token: giverToken, body: await giver.sign(prepared.body.tx) });
    expect(sent.body.status).toBe('ok');
    expect((await env.DB.prepare('SELECT status FROM work_invitations').first<{ status: string }>())?.status).toBe('expired');
  });

  // spec: add-pet-will › Invitation delivery data › private delivery × Memory clear
  it('expires open invitations on memory clear, without changing other pets', async () => {
    vi.setSystemTime(day(2));
    await pet('701', OWNER, 'Pixel');
    await pet('702', RECIPIENT, 'Moss');
    await pet('703', THIRD, 'Dot', true);
    await invite('701', '702', Date.now());
    await invite('703', '702', Date.now(), 'b'.repeat(24));
    const tk = await token('did:privy:invitation-clear', OWNER);
    expect((await api('/api/pets/701/memory/clear', { token: tk, method: 'POST' })).status).toBe(200);
    const reader = await token('did:privy:invitation-reader', RECIPIENT);
    const cards = (await api('/api/pets/702/invitations', { token: reader })).body.invitations;
    expect(cards.map((card: { workerId: string }) => card.workerId)).toEqual(['703']);
  });

  // spec: add-pet-will › Work invitation card screen › error × 00:00 UTC
  it('ends a card at UTC reset but preserves an unexpired card across reads', async () => {
    vi.setSystemTime(day(2));
    await pet('701', OWNER, 'Pixel', true);
    await pet('702', RECIPIENT, 'Moss');
    await invite('701', '702', Date.now());
    const tk = await token('did:privy:recipient', RECIPIENT);
    expect((await api('/api/pets/702/invitations', { token: tk })).body.invitations).toHaveLength(1);
    expect((await api('/api/pets/702/invitations', { token: tk })).body.invitations).toHaveLength(1);
    vi.setSystemTime(day(3));
    const fresh = await token('did:privy:recipient', RECIPIENT);
    expect((await api(`/api/pets/702/invitations/${'a'.repeat(24)}/accept`, { token: fresh, method: 'POST' })).status).toBe(409);
    expect((await api('/api/pets/702/invitations', { token: fresh })).body.invitations).toHaveLength(0);
  });
});
