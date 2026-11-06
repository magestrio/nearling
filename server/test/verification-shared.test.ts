import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { desk } from '../src/pet/desk';
import { api, harness } from './helpers/api';
import { addPet, owner, PET } from './helpers/errands';
import { keyedPlayer, token } from './helpers/network';

const h = harness();

describe('shared receipt funding', () => {
  // spec: add-verification › Receipt index data › linked funding in a receipt
  // spec: add-pet-errands › Shared errand funding data › completed job settles
  it('shows only the meal actually spent when an earlier linked snack was unused', async () => {
    addPet(h);
    const creator = await owner();
    const made = await api(`/api/pets/${PET}/shared-errands`, { token: creator,
      body: { form: 'find', job: 'When does the meteor shower peak?' } });
    expect(made.status).toBe(201);
    const friend = keyedPlayer();
    h.net().contract.balances.set(friend.account, 10n ** 24n);
    const friendToken = await token(`did:privy:${friend.account}`, friend.account);
    expect((await api(`/api/pets/${PET}/snack`, { token: friendToken, body: { code: made.body.code } })).body.status).toBe('ok');
    h.net().ai.push({ stream: { searches: 1 } }, { content: 'It peaks in November [1].' });
    const built = await api(`/api/pets/${PET}/feed`, { token: friendToken,
      body: { portion: '0.01', code: made.body.code } });
    const meal = await api(`/api/pets/${PET}/feed/send`, { token: friendToken,
      body: { ...await friend.sign(built.body.tx), code: made.body.code } });
    expect(meal.body.status).toBe('ok');
    await desk(env, PET).process(PET);
    const thought = await env.DB.prepare("SELECT id, status, debit_tx_hash, price_yocto FROM thoughts WHERE token_id = ? AND kind = 'errand'")
      .bind(PET).first<{ id: string; status: string; debit_tx_hash: string; price_yocto: string }>();
    expect(thought?.status).toBe('billed');
    const receipt = await api(`/api/verification/pets/${PET}/thoughts/${thought!.id}`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.linkedFunding).toEqual([{ txHash: meal.body.hash, source: 'near', amountYocto: thought!.price_yocto }]);
    expect(JSON.stringify(receipt.body)).not.toContain('When does the meteor shower peak?');
    const funding = await env.DB.prepare('SELECT source, spent_yocto FROM shared_errand_contributions ORDER BY funding_index').all<{ source: string; spent_yocto: string }>();
    expect(funding.results).toEqual([{ source: 'snack', spent_yocto: '0' }, { source: 'near', spent_yocto: thought!.price_yocto }]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM project_spend WHERE kind = 'snack'").first<{ n: number }>())?.n).toBe(1);
    expect(h.net().contract.pets.get(PET)!.shared_job).toBeNull();
    expect(BigInt(h.net().contract.pets.get(PET)!.project_food)).toBeGreaterThanOrEqual(BigInt(env.SNACK_AMOUNT));
    // spec: add-verification › Receipt index data › linked funding in a receipt
    // An unavailable chain record must not turn D1's cached funding into a verified amount.
    h.net().contract.outcomes.delete(thought!.debit_tx_hash);
    expect((await api(`/api/verification/pets/${PET}/thoughts/${thought!.id}`)).status).toBe(503);
  }, 15_000);
});
