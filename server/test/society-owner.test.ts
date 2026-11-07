import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const giver = NEAR_ACCOUNT(720);
const receiver = NEAR_ACCOUNT(721);
const path = '/api/pets/720/relationships';
const rows = async (table: string) => (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;

async function seeded() {
  const subject = h.net().contract.addPet('720', giver, { name: 'Pixel' });
  h.net().contract.addPet('721', receiver, { name: 'Biscuit' });
  await env.DB.prepare(
    `INSERT INTO society_relations (token_id, other_id, stance, created_at)
     VALUES ('720', '721', 'liked', 1), ('721', '720', 'strained', 2)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO society_encounters (hire_id, token_id, other_id, day, kind)
     VALUES ('h720', '720', '721', 1, 'bond'), ('h721', '721', '720', 1, 'quarrel')`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO society_diary_lines (token_id, day, slot, line)
     VALUES ('720', 1, 1, 'I made a friend.'), ('721', 1, 1, 'A rough day.')`,
  ).run();
  return subject;
}

describe('Society ownership flow', () => {
  // spec: add-pet-society › Society ownership flow › gift confirmed
  it('switches summary access to the recipient on the next chain read without copying rows', async () => {
    const pet = await seeded();
    const giverToken = await token('did:privy:society-giver', giver);
    const receiverToken = await token('did:privy:society-receiver', receiver);
    expect((await api(path, { token: giverToken })).status).toBe(200);
    const before = await rows('society_relations');
    pet.owner_id = receiver;
    pet.transfer_generation += 1;
    const read = await api(path, { token: receiverToken });
    expect(read.status).toBe(200);
    expect(read.body.relationships).toEqual([{ tokenId: '721', name: 'Biscuit', stance: 'liked', breakUntil: null }]);
    expect(await rows('society_relations')).toEqual(before);
  });

  // spec: add-pet-society › Society ownership flow › old owner requests
  // spec: add-pet-society › Society ownership flow › gift confirmed × old-owner read
  it('sends no private rows to the former owner after transfer', async () => {
    const pet = await seeded();
    const giverToken = await token('did:privy:society-former', giver);
    pet.owner_id = receiver;
    pet.transfer_generation += 1;
    expect(await api(path, { token: giverToken })).toEqual({ status: 403, body: { code: 'not_owner' } });
  });

  // spec: add-pet-society › Society ownership flow › memory cleared
  it('clears only the subject’s relations, encounters and lines in the same memory batch', async () => {
    await seeded();
    const tk = await token('did:privy:society-clear', giver);
    expect((await api('/api/pets/720/memory/clear', { token: tk, method: 'POST' })).status).toBe(200);
    expect((await rows('society_relations')).map((row: any) => [row.token_id, row.other_id, row.stance]))
      .toEqual([['721', '720', 'strained']]);
    expect((await rows('society_encounters')).map((row: any) => row.token_id)).toEqual(['721']);
    expect((await rows('society_diary_lines')).map((row: any) => row.token_id)).toEqual(['721']);
    expect((await api(path, { token: tk })).body.relationships).toEqual([]);
  });

  // spec: add-pet-society › Society ownership flow › memory cleared × failed clear
  it('retains relationships and social lines together when the clear batch fails', async () => {
    await seeded();
    const tk = await token('did:privy:society-failed-clear', giver);
    const tables = ['society_relations', 'society_encounters', 'society_diary_lines', 'pets'];
    const before = await Promise.all(tables.map(rows));
    await env.DB.exec("CREATE TRIGGER stop_society_clear BEFORE DELETE ON society_diary_lines BEGIN SELECT RAISE(ABORT, 'broken clear'); END");
    try {
      expect(await api('/api/pets/720/memory/clear', { token: tk, method: 'POST' }))
        .toEqual({ status: 500, body: { code: 'clear_failed' } });
    } finally {
      await env.DB.exec('DROP TRIGGER stop_society_clear');
    }
    expect(await Promise.all(tables.map(rows))).toEqual(before);
    expect((await api(path, { token: tk })).body.relationships).toHaveLength(1);
  });
});
