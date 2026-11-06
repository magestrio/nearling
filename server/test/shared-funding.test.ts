import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { desk } from '../src/pet/desk';
import { finishDueShared } from '../src/errands/sharedSettle';
import { api, harness } from './helpers/api';
import { addPet, owner, OWNER, PET } from './helpers/errands';
import { keyedPlayer, token } from './helpers/network';

const h = harness();
const JOB = 'When does the meteor shower peak?';
const MEAL = 10n ** 22n;

async function setup() {
  addPet(h, { project_food: '0', given_food: '0' });
  const creator = await owner();
  const made = await api(`/api/pets/${PET}/shared-errands`, { token: creator, body: { form: 'find', job: JOB } });
  expect(made.status).toBe(201);
  const friend = keyedPlayer();
  h.net().contract.balances.set(friend.account, 10n ** 24n);
  const friendToken = await token(`did:privy:${friend.account}`, friend.account);
  const path = `/api/pets/${PET}/errand/${made.body.code}`;
  return { creator, friend, friendToken, code: made.body.code as string, path };
}

describe('linked feeding', () => {
  // spec: add-pet-errands › Shared errand funding data › completed job settles × chain refusal and retry
  it('keeps a confirmed paid receipt when the close call fails and retries only the close', async () => {
    const { friend, friendToken, code } = await setup();
    h.net().contract.pets.get(PET)!.project_food = env.STARTER_FOOD;
    h.net().contract.sharedCloseFails = 'temporary_refusal';
    h.net().ai.push({ stream: { searches: 1 } }, { content: 'It peaks in November [1].' });
    const built = await api(`/api/pets/${PET}/feed`, { token: friendToken, body: { portion: '0.01', code } });
    await api(`/api/pets/${PET}/feed/send`, { token: friendToken, body: { ...await friend.sign(built.body.tx), code } });
    await desk(env, PET).process(PET);
    expect(h.net().contract.pets.get(PET)!.shared_job?.state).toBe('Settled');
    expect(h.net().contract.debits).toHaveLength(1);
    h.net().contract.sharedCloseFails = null;
    await finishDueShared(env);
    expect(h.net().contract.pets.get(PET)!.shared_job).toBeNull();
    expect(h.net().contract.debits).toHaveLength(1);
  });
  // spec: add-pet-errands › Shared errand screen › funded while waking
  // spec: add-pet-errands › Friend-funded errand flow › friend adds a snack
  it('wakes a sleeping pet on the first linked snack while keeping the job waiting for its allowance', async () => {
    const { friendToken, code } = await setup();
    await env.DB.prepare('INSERT OR IGNORE INTO pets (token_id, hatched_by, born_at, birth_tx, slept_at) VALUES (?, ?, 1, ?, ?)')
      .bind(PET, OWNER, '', Date.now() - 1_000).run();
    await env.DB.prepare('UPDATE pets SET slept_at = ? WHERE token_id = ?').bind(Date.now() - 1_000, PET).run();
    expect((await api(`/api/pets/${PET}/snack`, { token: friendToken, body: { code } })).body.status).toBe('ok');
    const pet = await env.DB.prepare('SELECT slept_at, wake_seq FROM pets WHERE token_id = ?').bind(PET).first<{ slept_at: number | null; wake_seq: number }>();
    expect(pet).toMatchObject({ slept_at: null, wake_seq: 1 });
    expect((await env.DB.prepare('SELECT state FROM shared_errands WHERE token_id = ?').bind(PET).first<{ state: string }>())?.state).toBe('funding');
  });
  // spec: add-pet-errands › Friend-funded errand flow › friend adds a NEAR meal
  // spec: add-pet-errands › Shared errand funding data › confirmed funding missing from D1
  it('records the confirmed meal event before deleting its flight and grants sponsor access', async () => {
    const { friend, friendToken, code, path } = await setup();
    const built = await api(`/api/pets/${PET}/feed`, { token: friendToken, body: { portion: '0.01', code } });
    expect(built.status).toBe(200);
    const signed = await friend.sign(built.body.tx);
    const sent = await api(`/api/pets/${PET}/feed/send`, { token: friendToken, body: { ...signed, code } });
    expect(sent.body.status).toBe('ok');
    const row = await env.DB.prepare('SELECT contributor_account, amount_yocto, source, funding_index FROM shared_errand_contributions').first<any>();
    expect(row).toMatchObject({ contributor_account: friend.account, amount_yocto: MEAL.toString(), source: 'near', funding_index: 0 });
    expect((await api(path, { token: friendToken })).body).toMatchObject({ funded: MEAL.toString(), viewer: 'sponsor' });
    expect(await env.DB.prepare('SELECT 1 FROM feedings').first()).toBeNull();
  });

  // spec: add-pet-errands › Shared errand funding data › confirmed funding missing from D1
  it('recovers a confirmed event left in an in-flight row before a link read', async () => {
    const { friend, friendToken, code, path } = await setup();
    const shared = await env.DB.prepare('SELECT job_hash FROM shared_errands WHERE token_id = ?').bind(PET).first<{ job_hash: string }>();
    const built = await api(`/api/pets/${PET}/feed`, { token: friendToken, body: { portion: '0.01', code } });
    const result = await api(`/api/pets/${PET}/feed/send`, { token: friendToken, body: { ...await friend.sign(built.body.tx), code } });
    expect(result.body.status).toBe('ok');
    await env.DB.prepare('DELETE FROM shared_errand_contributions').run();
    await env.DB.prepare("INSERT INTO feedings (id, sub, account, token_id, source, via, deposit_yocto, tx_hash, created_at, job_hash) VALUES (?, ?, ?, ?, 'near', 'link', ?, ?, ?, ?)")
      .bind(result.body.hash, `did:privy:${friend.account}`, friend.account, PET, MEAL.toString(), result.body.hash, Date.now(), shared!.job_hash).run();
    expect(await env.DB.prepare('SELECT 1 FROM shared_errand_contributions').first()).toBeNull();
    const read = await api(path, { token: friendToken });
    expect(read.body).toMatchObject({ viewer: 'sponsor', funded: MEAL.toString() });
    expect(await env.DB.prepare('SELECT 1 FROM feedings').first()).toBeNull();
  });

  // spec: add-pet-errands › Friend-funded errand flow › friend adds a snack
  it('records a tagged free snack from its confirmed event', async () => {
    const { friend, friendToken, code, path } = await setup();
    const answer = await api(`/api/pets/${PET}/snack`, { token: friendToken, body: { code } });
    expect(answer.body.status).toBe('ok');
    expect(await env.DB.prepare('SELECT contributor_account, amount_yocto, source, funding_index FROM shared_errand_contributions').first())
      .toMatchObject({ contributor_account: friend.account, amount_yocto: env.SNACK_AMOUNT, source: 'snack', funding_index: 0 });
    expect((await api(path, { token: friendToken })).body.viewer).toBe('sponsor');
  });

  // spec: add-pet-errands › Friend-funded errand flow › late friend cannot add food
  it('refuses owner funding and a second tagged contribution after the allowance is covered', async () => {
    const { creator, friend, friendToken, code } = await setup();
    expect((await api(`/api/pets/${PET}/feed`, { token: creator, body: { portion: '0.01', code } })).body.code).toBe('shared_owner_cannot_fund');
    const built = await api(`/api/pets/${PET}/feed`, { token: friendToken, body: { portion: '0.01', code } });
    await api(`/api/pets/${PET}/feed/send`, { token: friendToken, body: { ...await friend.sign(built.body.tx), code } });
    expect((await api(`/api/pets/${PET}/snack`, { token: friendToken, body: { code } })).body.code).toBe('shared_funding_closed');
    expect(h.net().contract.sends.filter((send) => send.method === 'pet_snack')).toHaveLength(0);
  });
});
