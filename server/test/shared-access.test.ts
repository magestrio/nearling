import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { addPet, owner, OWNER, PET } from './helpers/errands';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const JOB = 'Which month is best to see the Leonids?';

async function opened() {
  addPet(h);
  const tk = await owner();
  const made = await api(`/api/pets/${PET}/shared-errands`, { token: tk, body: { form: 'find', job: JOB } });
  expect(made.status).toBe(201);
  const path = `/api/pets/${PET}/errand/${made.body.code}`;
  return { tk, path, code: made.body.code };
}

describe('Shared errand access data', () => {
  // spec: add-pet-errands › Shared errand access data › memory clear closes the link
  it('has the expand-only watch and recovery tables, with dependent rows erased atomically', async () => {
    const { path } = await opened();
    const row = await env.DB.prepare('SELECT job_hash FROM shared_errands WHERE token_id = ?').bind(PET).first<{ job_hash: string }>();
    await env.DB.prepare("INSERT INTO shared_errand_contributions (tx_hash, token_id, job_hash, contributor_account, source, amount_yocto, confirmed_at) VALUES ('tx-schema', ?, ?, ?, 'snack', '1700', 1)")
      .bind(PET, row!.job_hash, NEAR_ACCOUNT(8)).run();
    await env.DB.prepare("INSERT INTO watch_targets (token_id, kind, target, saved_hour_utc, owner_generation, updated_at) VALUES (?, 'topic', 'meteor shower', 10, 0, 1)").bind(PET).run();
    await env.DB.prepare("INSERT INTO watch_observations (token_id, revision, named_content, source_urls, observed_day) VALUES (?, 1, 'peak is in November', '[]', 1)").bind(PET).run();
    await env.DB.prepare("INSERT INTO watch_checks (token_id, day, revision, status, started_at) VALUES (?, 1, 1, 'started', 1)").bind(PET).run();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM shared_errands WHERE token_id = ?').bind(PET),
      env.DB.prepare('DELETE FROM watch_targets WHERE token_id = ?').bind(PET),
    ]);
    expect(await env.DB.prepare('SELECT 1 FROM shared_errand_contributions').first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM watch_observations').first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM watch_checks').first()).not.toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM shared_job_close_recovery').first()).toBeNull();
    expect((await api(path)).body.state).toBe('empty');
  });
  // spec: add-pet-errands › Shared errand access data › someone else asks for the report
  it('serves a public job and chain progress but no report, sources or receipt to a stranger', async () => {
    const { tk, path } = await opened();
    await env.DB.prepare("UPDATE shared_errands SET state = 'reported', report = ?, sources = ?, receipt_id = ? WHERE token_id = ?")
      .bind('The peak is in November.', '["Observatory"]', 'receipt-secret', PET).run();
    const stranger = await token('did:privy:stranger', NEAR_ACCOUNT(2));
    const publicView = await api(path, { token: stranger });
    expect(publicView).toMatchObject({ status: 200, body: { name: 'Pixel', job: JOB, funded: '0', state: 'reported', viewer: 'visitor' } });
    h.net().contract.pets.get(PET)!.shared_job!.linked_snack = '1700';
    expect((await api(path)).body.funded).toBe('1700');
    for (const field of ['report', 'sources', 'receiptId']) expect(publicView.body).not.toHaveProperty(field);
    expect((await api(path)).body.viewer).toBe('signed-out');
    const ownerView = await api(path, { token: tk });
    expect(ownerView.body).toMatchObject({ viewer: 'owner', report: 'The peak is in November.', sources: ['Observatory'], receiptId: 'receipt-secret' });
    expect(h.net().contract.reads.filter((r) => r.method === 'pet_view').length).toBeGreaterThanOrEqual(3);
  });

  // spec: add-pet-errands › Shared errand access data › someone else asks for the report
  it('fails closed when the chain owner or reserve cannot be read', async () => {
    const { path } = await opened();
    h.net().contract.failingViews.add('pet_view');
    expect(await api(path)).toMatchObject({ status: 503, body: { code: 'chain_unreachable' } });
  });

  // spec: add-pet-errands › Shared errand screen › funding closed
  it('uses the chain state to close funding when a D1 state update was lost', async () => {
    const { path } = await opened();
    h.net().contract.pets.get(PET)!.shared_job!.state = 'Running';
    expect((await api(path)).body.state).toBe('running');
    expect((await env.DB.prepare('SELECT state FROM shared_errands WHERE token_id = ?').bind(PET).first<{ state: string }>())?.state).toBe('running');
  });

  // spec: add-pet-errands › Shared errand access data › someone else asks for the report
  it('lets a confirmed contributor see the report while the link is live, and erases access with its link', async () => {
    const { path } = await opened();
    const sponsor = NEAR_ACCOUNT(3);
    const row = await env.DB.prepare('SELECT job_hash FROM shared_errands WHERE token_id = ?').bind(PET).first<{ job_hash: string }>();
    await env.DB.prepare("INSERT INTO shared_errand_contributions (tx_hash, token_id, job_hash, contributor_account, source, amount_yocto, confirmed_at) VALUES ('tx-one', ?, ?, ?, 'near', '100', 1)")
      .bind(PET, row!.job_hash, sponsor).run();
    await env.DB.prepare("UPDATE shared_errands SET state = 'reported', report = 'It peaks in November.' WHERE token_id = ?").bind(PET).run();
    expect((await api(path, { token: await token('did:privy:sponsor', sponsor) })).body.report).toBe('It peaks in November.');
    await env.DB.prepare('DELETE FROM shared_errands WHERE token_id = ?').bind(PET).run();
    expect(await env.DB.prepare('SELECT 1 FROM shared_errand_contributions').first()).toBeNull();
    expect((await api(path)).body.state).toBe('empty');
  });

  // spec: add-pet-errands › Shared errand access data › gift closes the link
  // spec: add-pet-errands › Shared errand access data › gift during a running shared job
  it('revokes the link and sponsor access when ownership generation moves, even if the hash survives', async () => {
    const { path } = await opened();
    const pet = h.net().contract.pets.get(PET)!;
    pet.owner_id = NEAR_ACCOUNT(7);
    pet.transfer_generation += 1;
    pet.shared_job!.state = 'Transferred';
    expect((await api(path)).body.state).toBe('empty');
    expect(await env.DB.prepare('SELECT 1 FROM shared_errands').first()).toBeNull();
  });

  // spec: add-pet-errands › Shared errand access data › memory clear closes the link
  it('revokes a link when the pet memory epoch changes', async () => {
    const { path } = await opened();
    await env.DB.prepare("INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, memory_epoch) VALUES (?, ?, 1, '', 1)").bind(PET, OWNER).run();
    expect((await api(path)).body.state).toBe('empty');
    expect(await env.DB.prepare('SELECT 1 FROM shared_errands').first()).toBeNull();
  });

  async function withSponsor(state: 'funding' | 'reported') {
    const made = await opened();
    const friend = NEAR_ACCOUNT(3);
    const row = await env.DB.prepare('SELECT job_hash FROM shared_errands WHERE token_id = ?').bind(PET).first<{ job_hash: string }>();
    await env.DB.prepare("INSERT INTO shared_errand_contributions (tx_hash, token_id, job_hash, contributor_account, source, amount_yocto, confirmed_at) VALUES ('tx-friend', ?, ?, ?, 'near', '100', 1)")
      .bind(PET, row!.job_hash, friend).run();
    if (state === 'reported') {
      await env.DB.prepare("UPDATE shared_errands SET state = 'reported', report = 'It peaks in November.', sources = '[]', receipt_id = 'rc1' WHERE token_id = ?").bind(PET).run();
      h.net().contract.pets.get(PET)!.shared_job = null;
    }
    return { ...made, sponsor: await token('did:privy:sponsor-closed', friend), visitor: await token('did:privy:visitor-closed', NEAR_ACCOUNT(4)) };
  }
  const gift = () => {
    // what `nft_transfer` does to the record (the contract tests prove the hook): the owner changes, a waiting job is dropped
    const pet = h.net().contract.pets.get(PET)!;
    pet.owner_id = NEAR_ACCOUNT(7);
    pet.transfer_generation += 1;
    if (pet.shared_job?.state === 'Funding') pet.shared_job = null;
  };

  // spec: add-pet-errands › Friend-funded errand flow › pet gifted
  it('closes the link for the sponsor, the stranger and the old owner when the pet is gifted, waiting or finished', async () => {
    for (const state of ['funding', 'reported'] as const) {
      const { tk, path, sponsor, visitor } = await withSponsor(state);
      // before the gift a sponsor reads a finished report, and never the stranger
      const before = await api(path, { token: sponsor });
      expect(before.body.state).toBe(state === 'reported' ? 'reported' : 'funding');
      if (state === 'reported') expect((await api(path, { token: visitor })).body).not.toHaveProperty('report');
      gift();
      for (const who of [sponsor, visitor, tk, undefined]) {
        const after = await api(path, who ? { token: who } : {});
        expect(after.body).toMatchObject({ state: 'empty', name: 'Pixel' });
        expect(JSON.stringify(after.body)).not.toMatch(/Leonids|November|rc1/);
      }
      // the words, the sponsor's access and the one-job state are gone with the link
      expect(await env.DB.prepare('SELECT 1 FROM shared_errands WHERE token_id = ?').bind(PET).first()).toBeNull();
      expect(await env.DB.prepare('SELECT 1 FROM shared_errand_contributions WHERE token_id = ?').bind(PET).first()).toBeNull();
      expect(h.net().contract.pets.get(PET)!.shared_job).toBeNull();
      // a waiting job ended with the gift: its reserve is no longer held, so the new owner may open another shared job
      if (state === 'funding') {
        const next = await token('did:privy:new-owner', NEAR_ACCOUNT(7));
        expect((await api(`/api/pets/${PET}/shared-errands`, { token: next, body: { form: 'find', job: 'A new owner job' } })).status).toBe(201);
      }
      h.net().contract.pets.get(PET)!.owner_id = OWNER;
      await env.DB.prepare('DELETE FROM shared_errands WHERE token_id = ?').bind(PET).run();
      h.net().contract.pets.get(PET)!.shared_job = null;
    }
  });

  // spec: add-pet-errands › Friend-funded errand flow › memory cleared
  it('closes the link for everyone, a sponsor with a finished report included, when the owner clears memory', async () => {
    const { tk, path, sponsor, visitor } = await withSponsor('reported');
    expect((await api(path, { token: sponsor })).body.report).toBe('It peaks in November.');
    const cleared = await api(`/api/pets/${PET}/memory/clear`, { token: tk, body: {} });
    expect(cleared).toMatchObject({ status: 200, body: { ok: true } });
    for (const who of [sponsor, visitor, tk, undefined]) {
      const after = await api(path, who ? { token: who } : {});
      expect(after.body).toMatchObject({ state: 'empty', name: 'Pixel' });
      expect(JSON.stringify(after.body)).not.toMatch(/Leonids|November|rc1/);
    }
    expect(await env.DB.prepare('SELECT 1 FROM shared_errands WHERE token_id = ?').bind(PET).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM shared_errand_contributions WHERE token_id = ?').bind(PET).first()).toBeNull();
  });

  // spec: add-pet-errands › Shared errand access data › link leaves the browser
  it('keeps public words off chain and only the code hash in D1', async () => {
    const { code } = await opened();
    const row = await env.DB.prepare('SELECT * FROM shared_errands WHERE token_id = ?').bind(PET).first<any>();
    expect(row.job).toBe(JOB);
    expect(JSON.stringify(row)).not.toContain(code);
    expect(JSON.stringify(h.net().contract.sends)).not.toContain(JOB);
    expect(JSON.stringify(h.net().contract.sends)).not.toContain(code);
  });
});
