import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sendErrand as queueErrand } from '../src/errands/store';
import { desk } from '../src/pet/desk';
import { harness } from './helpers/api';
import { addPet, errandRow, noEnergy, owner, OWNER, pauseServices, PET, quote, stateOf, thoughtsOf, tiredToday } from './helpers/errands';

const h = harness();

/** Another tab's spend: the pet has only this much food left. */
async function spend(food: string): Promise<void> {
  const pet = h.net().contract.pets.get(PET)!;
  pet.project_food = food;
  pet.given_food = '0';
}

/** An errand that passed every check at «Send», then a world that changed before the desk began its job. */
async function startedInAnotherWorld(form: 'read' | 'find', change: () => Promise<void>) {
  addPet(h, { given_food: (3n * BigInt(env.STARTER_FOOD)).toString() });
  const job = form === 'read' ? 'A text to read in a moment.' : 'Where do the Leonids come from?';
  const queued = await queueErrand(env.DB, { tokenId: PET, owner: OWNER, form, job, now: Date.now() });
  expect(queued).not.toBeNull();
  await change();
  await desk(env, PET).process(PET);
  return { job, tk: await owner() };
}

describe('Errand flow › blocked after Send', () => {
  const blocks: [string, 'read' | 'find', () => Promise<void>][] = [
    ['paused', 'read', () => pauseServices()],
    ['food', 'read', () => spend('1000000000000000000000')],
    ['asleep', 'find', () => spend('100000000000000000000')],
    ['energy', 'read', () => noEnergy().then(() => undefined)],
    ['cap', 'find', () => tiredToday()],
  ];

  for (const [reason, form, change] of blocks) {
    // spec: add-pet-errands › Errand flow › blocked after Send
    it(`spends nothing and keeps the errand when ${reason} holds as the job starts`, async () => {
      const { job, tk } = await startedInAnotherWorld(form, change);
      // nothing was reserved, called, searched or stored
      expect(h.net().ai.calls).toHaveLength(0);
      expect(h.net().web.requests).toEqual([]);
      expect(await thoughtsOf()).toEqual([]);
      expect(await env.DB.prepare('SELECT 1 FROM pet_spend').first()).toBeNull();
      expect(await env.DB.prepare('SELECT 1 FROM project_spend').first()).toBeNull();
      // the pet is back, its errand kept with the form and the job
      expect(await errandRow()).toMatchObject({ state: 'failed', reason: 'blocked', form, job });
      expect((await stateOf(tk)).errand).toEqual({ state: 'failed', form, job, reason: 'blocked' });
      expect(h.events().filter((e) => e.name === 'errand_failed')).toEqual([
        { name: 'errand_failed', props: { form, reason: 'blocked', searches: 0, price_usd: 0, cost_usd: 0, cut: false, project_usd: 0 } },
      ]);
      // and the sheet that opens with them tells the block, as «several blocks at once» orders them
      const block = (await quote(tk, form)).body.block;
      expect(block?.reason).toBe(reason);
    });
  }

  // spec: add-pet-errands › Errand flow › blocked after Send
  it('tells only the first block when two hold as the job starts', async () => {
    const { tk } = await startedInAnotherWorld('read', async () => {
      await noEnergy();
      await tiredToday();
    });
    expect((await stateOf(tk)).errand).toMatchObject({ state: 'failed', reason: 'blocked' });
    expect((await quote(tk, 'read')).body.block?.reason).toBe('energy');
  });
});
