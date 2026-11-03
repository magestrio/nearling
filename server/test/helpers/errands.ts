// What the tests of `add-pet-errands` share: the owner and the pet, an errand sent through the route and followed to
// its end, the rows an errand leaves, and a page of the fake web.
import { env } from 'cloudflare:workers';
import { upToFor } from '../../src/errands/price';
import { utcDay } from '../../src/http';
import { setPause } from '../../src/servicePause';
import { api, settle, type Harness } from './api';
import { NEAR_ACCOUNT, token, type FakePet } from './network';

export const OWNER = NEAR_ACCOUNT(1);
export const PET = '5';
export const owner = () => token('did:privy:owner', OWNER);
export const STARTER = BigInt(env.STARTER_FOOD);

/** A pet of the owner (Pixel, id 5), awake with its starter food unless `patch` says otherwise. */
export function addPet(h: Harness, patch: Partial<FakePet> = {}): void {
  h.net().contract.addPet(PET, OWNER, patch);
}

/** A pet whose food pays every form: three searches and their report. */
export function richPet(h: Harness, patch: Partial<FakePet> = {}): void {
  h.net().contract.addPet(PET, OWNER, { given_food: (50n * STARTER).toString(), ...patch });
}

/** A pet whose room pays `n` searches of a search errand and not one more (`searchQuote`). */
export function foodForSearches(h: Harness, n: 1 | 2 | 3): void {
  const room = upToFor(env, n).yocto + 10n ** 20n;
  h.net().contract.addPet(PET, OWNER, { given_food: (room - STARTER).toString() });
}

/** The owner's POST of an errand: the response only, nothing awaited. */
export const sendErrand = (tk: string, form: string, job: string, id = PET) => api(`/api/pets/${id}/errand`, { token: tk, body: { form, job } });

/** Sends an errand and waits for the desk to be done with it; the job's outcome from the state poll. */
export async function errand(tk: string, form: string, job: string, id = PET): Promise<any> {
  const sent = await sendErrand(tk, form, job, id);
  if (sent.status !== 202) return { sent: sent.status, ...sent.body };
  return settle(tk, id, sent.body.job);
}

export const quote = (tk: string, form = 'read', id = PET) => api(`/api/pets/${id}/errand?form=${form}`, { token: tk });
export const stateOf = async (tk: string, id = PET) => (await api(`/api/pets/${id}/state`, { token: tk })).body;
export const conversation = async (tk: string, id = PET) => (await api(`/api/pets/${id}/conversation`, { token: tk })).body;

export const errandRow = (id = PET) => env.DB.prepare('SELECT * FROM errands WHERE token_id = ?').bind(id).first<any>();
export const thoughtsOf = async (id = PET) => (await env.DB.prepare('SELECT * FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid').bind(id).all<any>()).results;
export const callsOf = async (thoughtId: string) => (await env.DB.prepare('SELECT * FROM thought_calls WHERE thought_id = ? ORDER BY n').bind(thoughtId).all<any>()).results;
export const spendKinds = async () => (await env.DB.prepare('SELECT kind, usd_micros FROM project_spend ORDER BY rowid').all<{ kind: string; usd_micros: number }>()).results;

/** The pet is out of energy for today. */
export const noEnergy = (id = PET) =>
  env.DB.prepare('INSERT INTO pet_life (token_id, energy_day, energy_used) VALUES (?1, ?2, 10) ON CONFLICT (token_id) DO UPDATE SET energy_day = ?2, energy_used = 10').bind(id, utcDay(Date.now())).run();

/** The pet is tired for today. */
export const tiredToday = async (id = PET) => {
  await env.DB.prepare("INSERT OR IGNORE INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, 'x', 1, '')").bind(id).run();
  await env.DB.prepare('UPDATE pets SET tired_day = ? WHERE token_id = ?').bind(utcDay(Date.now()), id).run();
};

/** The services are paused. */
export const pauseServices = () => setPause(env.DB, 'ai', Date.now());

/** A long text of `tokens` tokens at a token per four bytes. */
export const textOf = (tokens: number) => 'word '.repeat(Math.ceil((tokens * 4) / 5));

export const PAGE_URL = 'https://dreams.example.com/study';

/** A page of the fake web with a title and one paragraph. */
export function dreamsPage(h: Harness, url = PAGE_URL, body = '<html><head><title>x</title><script>alert(1)</script></head><body><h1>Dreams</h1><p>Sleeping cats dream about birds.</p></body></html>'): void {
  h.net().web.page(url, { body });
}
