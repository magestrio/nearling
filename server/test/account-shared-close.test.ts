import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { recoverDueSharedCloses } from '../src/errands/sharedClose';
import { desk } from '../src/pet/desk';
import { api, harness } from './helpers/api';
import { keyedPlayer, token } from './helpers/network';

const h = harness();
const PET = '5';
const JOB = 'When does the meteor shower peak?';

async function shared() {
  const player = keyedPlayer();
  h.net().contract.addPet(PET, player.account);
  const tk = await token(`did:privy:${player.account}`, player.account);
  const created = await api(`/api/pets/${PET}/shared-errands`, { token: tk, body: { form: 'find', job: JOB } });
  expect(created.status).toBe(201);
  const hash = h.net().contract.pets.get(PET)!.shared_job!.hash;
  const approval = await player.closeApproval(PET, hash);
  return { player, tk, hash, approval, code: created.body.code as string };
}

describe('Clear memory with a shared job', () => {
  // spec: add-account › Shared job close recovery data › close before deletion
  it('refuses deletion when chain still reserves a job whose D1 words are missing', async () => {
    const { tk } = await shared();
    await env.DB.prepare('DELETE FROM shared_errands WHERE token_id = ?').bind(PET).run();
    const result = await api(`/api/pets/${PET}/memory/clear`, { token: tk, body: {} });
    expect(result).toMatchObject({ status: 503, body: { code: 'close_unknown' } });
    expect(h.net().contract.pets.get(PET)!.shared_job).not.toBeNull();
    expect((await env.DB.prepare('SELECT memory_epoch FROM pets WHERE token_id = ?').bind(PET).first<{ memory_epoch: number }>())?.memory_epoch ?? 0).toBe(0);
  });

  // spec: add-account › Memory deletion data › shared job and watch erased
  it('clears an already settled job without asking for an unsettled-close approval', async () => {
    const { tk, code } = await shared();
    h.net().contract.pets.get(PET)!.shared_job!.state = 'Settled';
    await env.DB.prepare("UPDATE shared_errands SET state = 'reported', report = 'Finished job' WHERE token_id = ?").bind(PET).run();
    const result = await api(`/api/pets/${PET}/memory/clear`, { token: tk, body: {} });
    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(h.net().contract.pets.get(PET)!.shared_job).toBeNull();
    expect((await api(`/api/pets/${PET}/errand/${code}`, { token: tk })).body.state).toBe('empty');
  });

  // spec: add-account › Memory deletion data › стёрто не всё
  // spec: add-account › Shared job close recovery data › running job erased
  it('rolls back the recovery row, epoch and words when the deletion batch fails', async () => {
    const { tk, hash, approval } = await shared();
    const pet = h.net().contract.pets.get(PET)!;
    pet.shared_job!.state = 'Running';
    await env.DB.prepare("UPDATE shared_errands SET state = 'running' WHERE token_id = ?").bind(PET).run();
    await env.DB.exec("CREATE TRIGGER fail_forget_shared BEFORE DELETE ON shared_errands BEGIN SELECT RAISE(ABORT, 'forced_batch_failure'); END");
    try {
      const failed = await api(`/api/pets/${PET}/memory/clear`, { token: tk, body: { approval } });
      expect(failed).toMatchObject({ status: 500, body: { code: 'clear_failed' } });
      expect((await env.DB.prepare('SELECT job FROM shared_errands WHERE token_id = ?').bind(PET).first<{ job: string }>())?.job).toBe(JOB);
      expect((await env.DB.prepare('SELECT * FROM shared_job_close_recovery WHERE token_id = ? AND job_hash = ?').bind(PET, hash).all()).results).toEqual([]);
      expect((await env.DB.prepare('SELECT memory_epoch FROM pets WHERE token_id = ?').bind(PET).first<{ memory_epoch: number }>())?.memory_epoch ?? 0).toBe(0);
    } finally {
      await env.DB.exec('DROP TRIGGER fail_forget_shared');
    }
  });

  // spec: add-account › Shared job close recovery data › close before deletion
  // spec: add-account › Memory deletion flow › unsettled shared job
  it('closes a waiting job on chain before deleting its link, words and contributors', async () => {
    const { tk, hash, approval, code } = await shared();
    await env.DB.prepare("INSERT INTO shared_errand_contributions (tx_hash, token_id, job_hash, contributor_account, source, amount_yocto, confirmed_at) VALUES ('t1', ?, ?, 'friend', 'near', '100', 1)")
      .bind(PET, hash).run();
    const refused = await api(`/api/pets/${PET}/memory/clear`, { token: tk, body: {} });
    expect(refused.body.code).toBe('close_refused');
    expect((await env.DB.prepare('SELECT job FROM shared_errands WHERE token_id = ?').bind(PET).first<{ job: string }>())?.job).toBe(JOB);
    const result = await api(`/api/pets/${PET}/memory/clear`, { token: tk, body: { approval } });
    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(h.net().contract.pets.get(PET)!.shared_job).toBeNull();
    expect((await api(`/api/pets/${PET}/errand/${code}`, { token: tk })).body.state).toBe('empty');
    expect((await env.DB.prepare('SELECT * FROM shared_errand_contributions WHERE token_id = ?').bind(PET).all()).results).toEqual([]);
    expect((await env.DB.prepare('SELECT * FROM shared_job_close_recovery WHERE token_id = ?').bind(PET).all()).results).toEqual([]);
  });

  // spec: add-account › Shared job close recovery data › running job erased
  // spec: add-account › Memory deletion data › shared job and watch erased
  // spec: add-pet-errands › Shared errand access data › memory clear closes the link
  it('keeps only approval and hash after an unconfirmed running close, with the watch and access erased', async () => {
    const { tk, hash, approval, code } = await shared();
    h.net().contract.pets.get(PET)!.shared_job!.state = 'Running';
    await env.DB.prepare("UPDATE shared_errands SET state = 'running', report = 'secret report' WHERE token_id = ?").bind(PET).run();
    await env.DB.prepare("INSERT INTO watch_targets (token_id, kind, target, saved_hour_utc, owner_generation, updated_at) VALUES (?, 'topic', 'private target', 10, 0, 1)").bind(PET).run();
    await env.DB.prepare("INSERT INTO watch_observations (token_id, revision, named_content, source_urls, observed_day) VALUES (?, 1, 'secret baseline', '[]', 1)").bind(PET).run();
    await env.DB.prepare("INSERT INTO shared_errand_contributions (tx_hash, token_id, job_hash, contributor_account, source, amount_yocto, confirmed_at) VALUES ('t1', ?, ?, 'friend', 'near', '100', 1)")
      .bind(PET, hash).run();
    h.net().contract.sharedCloseFails = 'temporarily_unavailable';
    const result = await api(`/api/pets/${PET}/memory/clear`, { token: tk, body: { approval } });
    expect(result).toMatchObject({ status: 202, body: { code: 'close_retry' } });
    expect((await env.DB.prepare('SELECT * FROM shared_errands WHERE token_id = ?').bind(PET).all()).results).toEqual([]);
    expect((await env.DB.prepare('SELECT * FROM shared_errand_contributions WHERE token_id = ?').bind(PET).all()).results).toEqual([]);
    expect((await env.DB.prepare('SELECT * FROM watch_targets WHERE token_id = ?').bind(PET).all()).results).toEqual([]);
    expect((await env.DB.prepare('SELECT * FROM watch_observations WHERE token_id = ?').bind(PET).all()).results).toEqual([]);
    const recovery = await env.DB.prepare('SELECT token_id, job_hash, approval, close_state FROM shared_job_close_recovery WHERE token_id = ?').bind(PET).first<any>();
    expect(recovery).toMatchObject({ token_id: PET, job_hash: hash, close_state: 'unknown' });
    expect(JSON.stringify(recovery)).not.toMatch(/meteor|secret|friend|private target|baseline|errand\//i);
    expect((await api(`/api/pets/${PET}/errand/${code}`, { token: tk })).body.state).toBe('empty');
    expect((await env.DB.prepare('SELECT memory_epoch FROM pets WHERE token_id = ?').bind(PET).first<{ memory_epoch: number }>())?.memory_epoch).toBe(1);
    expect((await api(`/api/pets/${PET}/memory/clear`, { token: tk, body: {} })).body.code).toBe('close_retry');
    expect((await env.DB.prepare('SELECT memory_epoch FROM pets WHERE token_id = ?').bind(PET).first<{ memory_epoch: number }>())?.memory_epoch).toBe(1);
    h.net().contract.sharedCloseFails = null;
    await recoverDueSharedCloses(env);
    expect(h.net().contract.pets.get(PET)!.shared_job).toBeNull();
    expect((await env.DB.prepare('SELECT * FROM shared_job_close_recovery WHERE token_id = ?').bind(PET).all()).results).toEqual([]);
  });

  // spec: add-pet-errands › Shared errand funding data › memory clear during a shared run
  // spec: add-account › Memory deletion data › ответ в пути
  // spec: add-pet-errands › Friend-funded errand flow › memory cleared while away
  it('rejects late shared report words while preserving the paid call for settlement', async () => {
    const { tk, hash, approval, code } = await shared();
    const friend = keyedPlayer();
    h.net().contract.balances.set(friend.account, 10n ** 24n);
    const friendToken = await token(`did:privy:${friend.account}`, friend.account);
    const built = await api(`/api/pets/${PET}/feed`, { token: friendToken, body: { portion: '0.01', code } });
    expect(built.status).toBe(200);
    expect((await api(`/api/pets/${PET}/feed/send`, { token: friendToken, body: { ...await friend.sign(built.body.tx), code } })).body.status).toBe('ok');
    h.net().ai.push({ stream: { searches: 1 }, tokensIn: 200, tokensOut: 30 }, {
      content: 'A private report that must be erased [1].', tokensIn: 200, tokensOut: 30,
      during: async () => {
        const cleared = await api(`/api/pets/${PET}/memory/clear`, { token: tk, body: { approval } });
        expect(cleared.body.code).toBe('close_retry');
      },
    });
    await desk(env, PET).process(PET);
    const thoughts = (await env.DB.prepare('SELECT status, player_text, reply_text, erased_at, price_yocto FROM thoughts WHERE token_id = ? AND shared_job_hash = ?')
      .bind(PET, hash).all<any>()).results;
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toMatchObject({ player_text: null, reply_text: null });
    expect(thoughts[0].status).toBe('billed');
    expect(thoughts[0].erased_at).not.toBeNull();
    expect(BigInt(thoughts[0].price_yocto)).toBeGreaterThan(0n);
    expect(h.net().contract.debits).toHaveLength(1);
    expect((await api(`/api/pets/${PET}/errand/${code}`, { token: friendToken })).body.state).toBe('empty');
    expect((await env.DB.prepare('SELECT * FROM shared_errands WHERE token_id = ?').bind(PET).all()).results).toEqual([]);
  }, 15_000);

  // spec: add-account › Shared job close recovery data › retry after deletion
  // spec: add-gift › Gift ownership data › cleared running job after transfer
  it('rejects the former owner after a gift and releases with the new owner approval', async () => {
    const { player, tk, hash, approval } = await shared();
    h.net().contract.pets.get(PET)!.shared_job!.state = 'Running';
    await env.DB.prepare("UPDATE shared_errands SET state = 'running' WHERE token_id = ?").bind(PET).run();
    h.net().contract.sharedCloseFails = 'temporarily_unavailable';
    expect((await api(`/api/pets/${PET}/memory/clear`, { token: tk, body: { approval } })).body.code).toBe('close_retry');
    h.net().contract.sharedCloseFails = null;
    const next = keyedPlayer();
    const pet = h.net().contract.pets.get(PET)!;
    pet.owner_id = next.account;
    pet.transfer_generation += 1;
    pet.shared_job!.state = 'Transferred';
    await recoverDueSharedCloses(env);
    expect(pet.shared_job?.hash).toBe(hash);
    expect((await api(`/api/pets/${PET}/shared-close`, { token: tk, body: { approval: await player.closeApproval(PET, hash) } })).status).toBe(403);
    const nextToken = await token(`did:privy:${next.account}`, next.account);
    const released = await api(`/api/pets/${PET}/shared-close`, { token: nextToken, body: { approval: await next.closeApproval(PET, hash) } });
    expect(released).toMatchObject({ status: 200, body: { ok: true } });
    expect(pet.shared_job).toBeNull();
    expect((await env.DB.prepare('SELECT * FROM shared_job_close_recovery WHERE token_id = ?').bind(PET).all()).results).toEqual([]);
  });
});
