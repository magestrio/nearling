// What the tests of `add-pet-work` share: a paying pet and a worker of two accounts, a skill written the way the route
// writes it, and an advice asked through the route and followed to its end.
import { env } from 'cloudflare:workers';
import { petView } from '../../src/chain';
import { utcDay } from '../../src/http';
import { priceOf } from '../../src/work/quote';
import { writeSkill } from '../../src/work/skill';
import { api, settle, type Harness } from './api';
import { NEAR_ACCOUNT, token, type FakePet } from './network';
import { foodState } from '../../src/pet/view';
import type { Hirer } from '../../src/work/candidates';

export const PAYER_OWNER = NEAR_ACCOUNT(1);
export const WORKER_OWNER = NEAR_ACCOUNT(2);
export const PAYER = '5';
export const WORKER = '6';
export const payerToken = () => token('did:privy:payer', PAYER_OWNER);
export const workerToken = () => token('did:privy:worker', WORKER_OWNER);

/** The paying pet (Pixel, id 5) and the worker (Biscuit, id 6) of two other owners. */
export function addPets(h: Harness, payer: Partial<FakePet> = {}, worker: Partial<FakePet> = {}): void {
  h.net().contract.addPet(PAYER, PAYER_OWNER, { name: 'Pixel', ...payer });
  h.net().contract.addPet(WORKER, WORKER_OWNER, { name: 'Biscuit', character: 'I am a grumpy biscuit.', ...worker });
}

/** A skill as the route stores it: sealed with the test key. */
export async function saveSkill(instruction: string, label = 'sums', tokenId = WORKER): Promise<void> {
  await writeSkill(env, tokenId, { label, instruction }, Date.now());
}

/** What the next asker pays the worker now, as the page would show it. */
export async function shownPrice(workerId = WORKER): Promise<string> {
  return (await priceOf(env, workerId, utcDay(Date.now()))).yocto.toString();
}

/** The worker as `pet_view` gives it, for a direct call of `workerCall`. */
export const workerRecord = async (workerId = WORKER) => (await petView(env, workerId))!;

/** Asks through the route: the response of the POST, nothing awaited. */
export async function postAdvice(tk: string, body: { text?: unknown; payer?: string; price?: string }, workerId = WORKER): Promise<{ status: number; body: any }> {
  return api(`/api/pets/${workerId}/advice`, { token: tk, body: { payer: PAYER, text: 'What should I plant?', price: await shownPrice(workerId), ...body } });
}

/** Asks and waits for the payer's job to end: the state poll of the payer with the job's outcome. */
export async function advise(tk: string, body: { text?: unknown; payer?: string; price?: string } = {}, workerId = WORKER): Promise<any> {
  const sent = await postAdvice(tk, body, workerId);
  if (sent.status !== 202) return { sent: sent.status, ...sent.body };
  return settle(tk, body.payer ?? PAYER, sent.body.job);
}

/** Polls (in memory) until a condition holds: what the test waits for while a call is in flight. */
export async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition did not come true');
}

const STARTER = BigInt(env.STARTER_FOOD);

/** The pet that hires (Pixel, id 5): awake, full by its own food, and with food given or earned to pay a fee. */
export function addHirer(h: Harness, patch: Partial<FakePet> = {}): void {
  h.net().contract.addPet(PAYER, PAYER_OWNER, { name: 'Pixel', given_food: (3n * STARTER).toString(), ...patch });
}

/** `hirer` knows the account: a feeding of it, in the contract's record and in the Worker's index (`Known pets rule`). */
export async function know(h: Harness, account: string, hirer = PAYER, inContract = true): Promise<void> {
  if (inContract) h.net().contract.known.add(`${hirer}:${account}`);
  await env.DB.prepare('INSERT OR IGNORE INTO known_index (token_id, account) VALUES (?, ?)').bind(hirer, account).run();
}

/** A worker the hirer knows: a pet of another account that fed it, awake with food of its own. */
export async function addWorker(h: Harness, id: string, account: number, patch: Partial<FakePet> = {}): Promise<string> {
  const owner = NEAR_ACCOUNT(account);
  h.net().contract.addPet(id, owner, { name: `Worker${id}`, character: `I am worker number ${id}.`, ...patch });
  await know(h, owner);
  return owner;
}

/** The hirer as the checks read it, from the contract and D1 now. */
export async function hirerNow(tokenId = PAYER): Promise<Hirer> {
  const pet = (await petView(env, tokenId))!;
  return { tokenId, pet, food: await foodState(env.DB, tokenId, pet, Date.now()) };
}
