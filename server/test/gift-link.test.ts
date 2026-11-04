import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { fullRead, view } from '../src/errands/price';
import { sendErrand } from '../src/errands/store';
import { invalidateMovedLink, linkForCode } from '../src/gift/link';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const PET = '91';
const GIVER = NEAR_ACCOUNT(1);
const FRIEND = NEAR_ACCOUNT(2);
const OTHER = NEAR_ACCOUNT(3);

const giver = () => token('did:privy:gift-giver', GIVER);
const friend = () => token('did:privy:gift-friend', FRIEND);
const other = () => token('did:privy:gift-other', OTHER);
const make = (tk: string) => api(`/api/pets/${PET}/gift`, { token: tk, method: 'POST' });
const read = (code: string, tk?: string) => api(`/api/gifts/${code}`, tk === undefined ? {} : { token: tk });
const accept = (code: string, tk: string) => api(`/api/gifts/${code}/accept`, { token: tk, method: 'POST' });

describe('gift link and acceptance', () => {
  // spec: add-gift › Gift flow › ссылка ждёт
  it('has one unexpired live code for a pet across concurrent creates and the next day', async () => {
    h.net().contract.addPet(PET, GIVER);
    const tk = await giver();
    const [a, b] = await Promise.all([make(tk), make(tk)]);
    expect(a.status).toBe(200);
    expect(b.body.code).toBe(a.body.code);
    expect(a.body.code).toMatch(/^[0-9a-f]{48}$/);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM gift_links').first<{ n: number }>())?.n).toBe(1);
    vi.setSystemTime(new Date(Date.now() + 2 * 86_400_000));
    expect((await read(a.body.code)).body.status).toBe('waiting');
  });

  // spec: add-gift › Gift accept flow › принял
  it('lets only the first friend accept; that friend can retry without replacing the name', async () => {
    h.net().contract.addPet(PET, GIVER);
    const code = (await make(await giver())).body.code;
    const friendTk = await friend();
    const otherTk = await other();
    await env.DB.prepare('UPDATE players SET first_name = ? WHERE account_id = ?').bind('Maya', FRIEND).run();
    const [a, b] = await Promise.all([accept(code, friendTk), accept(code, otherTk)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? FRIEND : OTHER;
    const winnerTk = a.status === 200 ? friendTk : otherTk;
    expect((await accept(code, winnerTk)).status).toBe(200);
    const row = await env.DB.prepare('SELECT accepted_account, accepted_name FROM gift_links WHERE code = ?').bind(code).first<{ accepted_account: string; accepted_name: string | null }>();
    expect(row?.accepted_account).toBe(winner);
    expect(row?.accepted_name).toBe(winner === FRIEND ? 'Maya' : null);
    expect((await read(code)).body.status).toBe('accepted');
  });

  // spec: add-gift › Gift flow › отменил
  it('cancels a waiting or accepted code and never revives the old URL on a new create', async () => {
    h.net().contract.addPet(PET, GIVER);
    const tk = await giver();
    const old = (await make(tk)).body.code;
    await accept(old, await friend());
    expect((await api(`/api/pets/${PET}/gift`, { token: tk, method: 'DELETE' })).body.status).toBe('cancelled');
    expect((await read(old)).status).toBe(404);
    const next = (await make(tk)).body.code;
    expect(next).not.toBe(old);
    expect((await accept(old, await friend())).status).toBe(404);
  });

  // spec: add-gift › Gift link data › former owner tries to cancel
  it('checks ownership afresh for every private route, including cancellation after a direct transfer', async () => {
    h.net().contract.addPet(PET, GIVER);
    const tk = await giver();
    const code = (await make(tk)).body.code;
    h.net().contract.pets.get(PET)!.owner_id = FRIEND;
    expect((await api(`/api/pets/${PET}/gift`, { token: tk, method: 'DELETE' })).status).toBe(403);
    expect((await api(`/api/pets/${PET}/gift`, { token: tk })).status).toBe(403);
    expect((await make(tk)).status).toBe(403);
    expect((await env.DB.prepare('SELECT status, code FROM gift_links WHERE token_id = ?').bind(PET).first())).toMatchObject({ status: 'waiting', code });
    expect((await read(code)).status).toBe(404);
    expect((await accept(code, await other())).status).toBe(404);
    expect((await env.DB.prepare('SELECT status, code FROM gift_links WHERE token_id = ?').bind(PET).first())).toMatchObject({ status: 'cancelled', code });
  });

  // spec: add-gift › Gift screen › success
  it('keeps the public read free of giver identity and owner-only state, and rejects unauthenticated mutations', async () => {
    h.net().contract.addPet(PET, GIVER);
    const code = (await make(await giver())).body.code;
    const response = await read(code);
    expect(response.body).toMatchObject({ tokenId: PET, name: 'Pixel', status: 'waiting', fullness: { state: 'full' } });
    const json = JSON.stringify(response.body);
    expect(json).not.toContain(GIVER);
    expect(json).not.toContain('acceptedAccount');
    expect((await make('')).status).toBe(401);
    expect((await accept(code, '')).status).toBe(401);
    expect((await api(`/api/pets/${PET}/gift`, { token: await other() })).status).toBe(403);
    expect((await accept(code, await giver())).status).toBe(403);
    expect((await read('x')).status).toBe(404);
  });

  // spec: add-gift › Gift screen › errand still running
  it('shows the sender-time maximum of a running ordinary errand before acceptance, without its words', async () => {
    h.net().contract.addPet(PET, GIVER);
    const code = (await make(await giver())).body.code;
    const displayed = view(fullRead(env));
    await sendErrand(env.DB, { tokenId: PET, owner: GIVER, form: 'read', job: 'Private words from the old owner', now: Date.now(), displayMax: displayed });
    const response = await read(code);
    expect(response.body.errand).toEqual({ running: true, maxCents: displayed.cents });
    const json = JSON.stringify(response.body);
    expect(json).not.toContain('Private words');
    expect(json).not.toContain(GIVER);
    expect(json).not.toContain('display_max_yocto');
    await env.DB.prepare("UPDATE errands SET state = 'done' WHERE token_id = ?").bind(PET).run();
    expect((await read(code)).body.errand).toBeNull();
  });

  // spec: add-gift › Gift screen › error
  it('hides a transferred link from the former giver while the recipient and a signed-out visitor can open it', async () => {
    h.net().contract.addPet(PET, GIVER);
    const giverTk = await giver();
    const friendTk = await friend();
    const code = (await make(giverTk)).body.code;
    await accept(code, friendTk);
    h.net().contract.pets.get(PET)!.owner_id = FRIEND;
    await env.DB.prepare("UPDATE gift_links SET status = 'transferred' WHERE code = ?").bind(code).run();
    expect((await read(code, giverTk)).status).toBe(404);
    expect((await read(code, friendTk)).body).toMatchObject({ status: 'transferred', viewer: 'receiver' });
    expect((await read(code)).body).toMatchObject({ status: 'transferred', viewer: 'visitor' });
  });

  // spec: add-gift › Gift flow › исход неизвестен
  it('does not erase acceptance when chain ownership changes during an unresolved gift flight', async () => {
    h.net().contract.addPet(PET, GIVER);
    const code = (await make(await giver())).body.code;
    await accept(code, await friend());
    await env.DB.prepare(
      "INSERT INTO gift_flights (token_id, code, sender, receiver, tx_hash, signed_bytes, state, created_at) VALUES (?, ?, ?, ?, 'hash', x'00', 'unknown', ?)",
    ).bind(PET, code, GIVER, FRIEND, Date.now()).run();
    h.net().contract.pets.get(PET)!.owner_id = FRIEND;
    await invalidateMovedLink(env.DB, (await linkForCode(env.DB, code))!);
    expect((await env.DB.prepare('SELECT status, accepted_account FROM gift_links WHERE code = ?').bind(code).first())).toMatchObject({ status: 'accepted', accepted_account: FRIEND });
  });

  // spec: add-gift › Gift screen › errand still running
  it('stores the maximum shown by the errand quote when the owner sends an ordinary errand', async () => {
    h.net().contract.addPet(PET, GIVER);
    const tk = await giver();
    const quoted = await api(`/api/pets/${PET}/errand?form=read`, { token: tk });
    expect(quoted.status).toBe(200);
    const sent = await api(`/api/pets/${PET}/errand`, { token: tk, body: { form: 'read', job: 'A short private task.' } });
    expect(sent.status).toBe(202);
    const row = await env.DB.prepare('SELECT display_max_yocto, display_max_cents FROM errands WHERE token_id = ?').bind(PET).first<{ display_max_yocto: string; display_max_cents: number }>();
    expect(row).toEqual({ display_max_yocto: view(fullRead(env)).yocto, display_max_cents: view(fullRead(env)).cents });
  });
});
