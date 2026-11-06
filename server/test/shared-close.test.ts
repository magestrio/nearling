import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { keyedPlayer, token } from './helpers/network';

const h = harness();
const PET = '5';
const JOB = 'When does the meteor shower peak?';

async function waiting() {
  const player = keyedPlayer();
  h.net().contract.addPet(PET, player.account);
  const tk = await token(`did:privy:${player.account}`, player.account);
  const created = await api(`/api/pets/${PET}/shared-errands`, { token: tk, body: { form: 'find', job: JOB } });
  expect(created.status).toBe(201);
  const hash = h.net().contract.pets.get(PET)!.shared_job!.hash;
  const path = `/api/pets/${PET}/errand/${created.body.code}/close`;
  return { player, tk, hash, path, code: created.body.code as string };
}

describe('shared job close', () => {
  // spec: add-pet-errands › Friend-funded errand flow › owner confirms closing an unsettled job
  // spec: add-pet-errands › Shared job close contract › owner closes a waiting job
  it('takes the current owner approval, confirms the chain close, then revokes the link', async () => {
    const { player, tk, hash, path, code } = await waiting();
    const other = keyedPlayer();
    const otherToken = await token(`did:privy:${other.account}`, other.account);
    expect((await api(path, { token: otherToken, body: { approval: await other.closeApproval(PET, hash) } })).status).toBe(403);
    const bad = await api(path, { token: tk, body: { approval: await other.closeApproval(PET, hash) } });
    expect(bad.body.code).toBe('close_refused');
    expect(h.net().contract.pets.get(PET)!.shared_job?.hash).toBe(hash);
    const closed = await api(path, { token: tk, body: { approval: await player.closeApproval(PET, hash) } });
    expect(closed).toMatchObject({ status: 200, body: { ok: true } });
    expect(h.net().contract.pets.get(PET)!.shared_job).toBeNull();
    expect((await api(`/api/pets/${PET}/errand/${code}`, { token: tk })).body.state).toBe('empty');
    expect((await env.DB.prepare('SELECT * FROM shared_errands WHERE token_id = ?').bind(PET).all()).results).toEqual([]);
    expect(await api(path, { token: tk, body: { approval: await player.closeApproval(PET, hash) } })).toMatchObject({ status: 200, body: { ok: true } });
  });

  // spec: add-pet-errands › Shared errand access data › close approval leaves the browser
  it('submits the signed hash and the job hash to NEAR, with no job words and no link code', async () => {
    const { player, tk, hash, path, code } = await waiting();
    // a signature over another job hash is no approval of this one
    const elsewhere = await api(path, { token: tk, body: { approval: await player.closeApproval(PET, 'f'.repeat(64)) } });
    expect(elsewhere.body.code).toBe('close_refused');
    const approval = await player.closeApproval(PET, hash);
    expect((await api(path, { token: tk, body: { approval } })).status).toBe(200);
    const close = h.net().contract.sends.filter((send) => send.method === 'shared_job_close' && send.args.owner_approval !== null).at(-1)!;
    expect(close.args).toMatchObject({ token_id: PET, job_hash: hash, owner_approval: approval });
    const everything = JSON.stringify(h.net().contract.sends);
    expect(everything).not.toContain(JOB);
    expect(everything).not.toMatch(/meteor/i);
    expect(everything).not.toContain(code);
  });

  // spec: add-pet-errands › Friend-funded errand flow › owner close fails
  it('leaves the link and reserve on a refused or unknown close', async () => {
    const { player, tk, hash, path, code } = await waiting();
    const approval = await player.closeApproval(PET, hash);
    h.net().contract.sharedCloseFails = 'bad_owner_approval';
    const refused = await api(path, { token: tk, body: { approval } });
    expect(refused).toMatchObject({ status: 409, body: { code: 'close_refused' } });
    expect((await api(`/api/pets/${PET}/errand/${code}`, { token: tk })).body.state).toBe('funding');
    h.net().contract.sharedCloseFails = null;
    h.net().contract.mode = 'lost';
    const unknown = await api(path, { token: tk, body: { approval } });
    expect(unknown.body.code).toBe('close_unknown');
    expect(h.net().contract.pets.get(PET)!.shared_job?.hash).toBe(hash);
    expect((await env.DB.prepare('SELECT job FROM shared_errands WHERE token_id = ?').bind(PET).first<{ job: string }>())?.job).toBe(JOB);
  });
});
