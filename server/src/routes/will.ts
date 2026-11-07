import { Hono } from 'hono';
import type { AppEnv } from '../http';
import { ownedPet } from './thoughts';
import { privateWish, startPendingWish } from '../will/diary';
import { memoryEpoch } from '../pet/forget';
import { processWishRelease, requestWishRelease } from '../will/purchase';
import { ChainUnreachable, petView } from '../chain';
import { validInvitation, type InvitationRow } from '../will/invitation';
import { track } from '../track';
import { recordWillEvent } from '../will/events';

export const willRoutes = new Hono<AppEnv>();

// spec: add-pet-will › Wish state data › diary input
willRoutes.get('/api/pets/:id/wish', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const release = await c.env.DB.prepare("SELECT status FROM will_operations WHERE token_id = ? AND kind = 'release' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(owned.id).first<{ status: string }>();
  const releaseStatus = release === null ? null : release.status === 'confirmed' || release.status === 'failed' ? release.status : 'unknown';
  return c.json({ wish: await privateWish(c.env.DB, owned.id, owned.pet),
    reserveYocto: owned.pet.wish_reserve ?? '0',
    active: owned.pet.wish_active ?? false, releaseStatus });
});

// spec: add-pet-will › Refusal privacy data › worker owner views refusal
willRoutes.get('/api/pets/:id/activity', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const rows = await c.env.DB.prepare("SELECT created_at, worker_code FROM will_refusals WHERE worker_token = ? AND worker_generation = ? ORDER BY created_at DESC")
    .bind(owned.id, owned.pet.transfer_generation).all<{ created_at: number; worker_code: string }>();
  return c.json({ activity: rows.results.map((row) => ({ at: row.created_at, code: row.worker_code })) });
});

// spec: add-pet-will › Wish pursuit flow › owner cancels
willRoutes.post('/api/pets/:id/wish/cancel', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  await requestWishRelease(c.env, owned.id);
  await processWishRelease(c.env, owned.id);
  const wish = await privateWish(c.env.DB, owned.id, owned.pet);
  return c.json({ status: wish === null ? 'released' : 'pending' }, wish === null ? 200 : 202);
});

// spec: add-pet-will › Will ownership rule › new owner continues
willRoutes.post('/api/pets/:id/wish/continue', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const wish = await c.env.DB.prepare("SELECT status, owner_generation, memory_epoch FROM pet_wishes WHERE token_id = ?")
    .bind(owned.id).first<{ status: string; owner_generation: number; memory_epoch: number }>();
  if (wish === null || wish.memory_epoch !== await memoryEpoch(c.env.DB, owned.id)) return c.json({ code: 'no_wish' }, 404);
  if (await c.env.DB.prepare("SELECT 1 FROM will_operations WHERE token_id = ? AND kind = 'release' AND status IN ('queued', 'sending', 'unknown')")
    .bind(owned.id).first() !== null) return c.json({ code: 'wish_pending' }, 202);
  if (wish.status === 'active' && wish.owner_generation === owned.pet.transfer_generation && owned.pet.wish_active)
    return c.json({ status: 'active' });
  if (wish.status === 'starting' && wish.owner_generation === owned.pet.transfer_generation) {
    await startPendingWish(c.env, owned.id);
  } else if (wish.status === 'paused' || wish.owner_generation !== owned.pet.transfer_generation || !owned.pet.wish_active) {
    const op = crypto.randomUUID().replaceAll('-', '');
    const result = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE pet_wishes SET status = 'starting', owner_generation = ?, start_op = ? WHERE token_id = ? AND status IN ('paused', 'active', 'buying', 'waiting_day') AND owner_generation = ? RETURNING token_id")
        .bind(owned.pet.transfer_generation, op, owned.id, wish.owner_generation),
      c.env.DB.prepare("INSERT INTO will_operations (id, token_id, kind, status, created_at, purpose) SELECT ?, ?, 'start', 'queued', ?, 'resume' WHERE changes() > 0")
        .bind(op, owned.id, Date.now()),
    ]);
    if (result[0]?.meta.changes !== 1) return c.json({ code: 'wish_pending' }, 202);
    await startPendingWish(c.env, owned.id);
  } else return c.json({ code: 'wish_pending' }, 202);
  const fresh = await petView(c.env, owned.id);
  if (fresh === null || fresh.owner_id !== c.get('session')?.accountId) return c.json({ code: 'not_owner' }, 403);
  const result = await privateWish(c.env.DB, owned.id, fresh);
  return c.json({ status: result?.status ?? 'pending' }, result?.status === 'active' ? 200 : 202);
});

// spec: add-pet-will › Invitation delivery data › private delivery
// spec: add-pet-will › Work invitation card screen › several valid invitations
willRoutes.get('/api/pets/:id/invitations', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const now = Date.now();
  const rows = await c.env.DB.prepare(`SELECT id, sender_token, recipient_token, sender_generation,
    recipient_generation, created_at, expires_at, status FROM work_invitations
    WHERE recipient_token = ? AND status = 'open' AND expires_at > ?
    ORDER BY created_at DESC, id DESC`).bind(owned.id, now).all<InvitationRow>();
  try {
    const cards = [];
    for (const row of rows.results) {
      const card = await validInvitation(c.env, row, owned.pet, now);
      if (card !== null) cards.push(card);
      else if (row.recipient_generation !== owned.pet.transfer_generation ||
        (await petView(c.env, row.sender_token))?.transfer_generation !== row.sender_generation) {
        await c.env.DB.prepare("UPDATE work_invitations SET status = 'expired' WHERE id = ? AND status = 'open'")
          .bind(row.id).run();
      }
    }
    const again = await ownedPet(c);
    if (again instanceof Response) return again;
    if (again.pet.transfer_generation !== owned.pet.transfer_generation) return c.json({ code: 'not_owner' }, 403);
    return c.json({ invitations: cards });
  } catch (e) {
    if (e instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw e;
  }
});

const INVITATION_ID = /^[0-9a-f]{24}$/;

async function invitationAction(c: Parameters<typeof ownedPet>[0], action: 'dismissed' | 'accepted') {
  const id = c.req.param('invitationId') ?? '';
  if (!INVITATION_ID.test(id)) return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const row = await c.env.DB.prepare(`SELECT id, sender_token, recipient_token, sender_generation,
    recipient_generation, created_at, expires_at, status FROM work_invitations
    WHERE id = ? AND recipient_token = ?`).bind(id, owned.id).first<InvitationRow>();
  if (row === null) return c.json({ code: 'invitation_ended' }, 409);
  const now = Date.now();
  try {
    const sender = await petView(c.env, row.sender_token);
    if (row.status !== 'open' || row.expires_at <= now ||
      row.recipient_generation !== owned.pet.transfer_generation || sender === null ||
      sender.transfer_generation !== row.sender_generation || sender.owner_id === owned.pet.owner_id) {
      await c.env.DB.prepare("UPDATE work_invitations SET status = 'expired' WHERE id = ? AND status = 'open'")
        .bind(id).run();
      return c.json({ code: 'invitation_ended' }, 409);
    }
    const card = action === 'accepted' ? await validInvitation(c.env, row, owned.pet, now) : null;
    if (action === 'accepted' && card === null) return c.json({ code: 'invitation_ended' }, 409);
    const again = await ownedPet(c);
    if (again instanceof Response) return again;
    if (again.pet.transfer_generation !== owned.pet.transfer_generation) return c.json({ code: 'not_owner' }, 403);
    const changed = await c.env.DB.prepare(`UPDATE work_invitations SET status = ? WHERE id = ?
      AND status = 'open' AND expires_at > ? AND recipient_generation = ? AND sender_generation = ?`)
      .bind(action, id, now, owned.pet.transfer_generation, sender.transfer_generation).run();
    if (changed.meta.changes !== 1) return c.json({ code: 'invitation_ended' }, 409);
    if (action === 'accepted') {
      track('pet_work_invitation_accepted');
      await recordWillEvent(c.env, 'pet_work_invitation_accepted', { id });
    }
    return action === 'accepted'
      ? c.json({ workerId: card!.workerId, name: card!.name, label: card!.label,
        price: card!.price, question: '' })
      : c.json({ status: 'dismissed' });
  } catch (e) {
    if (e instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw e;
  }
}

// spec: add-pet-will › Work seeking flow › recipient dismisses
willRoutes.post('/api/pets/:id/invitations/:invitationId/dismiss', (c) => invitationAction(c, 'dismissed'));

// spec: add-pet-will › Work seeking flow › recipient accepts
willRoutes.post('/api/pets/:id/invitations/:invitationId/accept', (c) => invitationAction(c, 'accepted'));
