import { describe, expect, it } from 'vitest';
import type { PetState, PetView } from '../../web/src/seams/worker-types';
import { api, harness, say } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

// The answers the client is typed against, read from the real routes. The fakes of web/ (and so every e2e test) stand
// on these shapes: two defects lived behind fakes that differed from the real answers (`stage`, and `/state` without
// `name`). Each list is exhaustive by type: a field added to the client's type does not compile until it is here.
type OwnerView = Extract<PetView, { viewer: 'owner' }>;
const OWNER_VIEW: Record<keyof OwnerView, 'always' | 'sometimes'> = {
  viewer: 'always',
  tokenId: 'always',
  name: 'always',
  stage: 'always',
  fullness: 'always',
  tired: 'always',
  until: 'sometimes',
  paused: 'always',
  deepPrice: 'always',
  hello: 'always',
  pendingJob: 'always',
  pendingMode: 'always',
  pendingKind: 'always',
  pendingText: 'always',
  lastThought: 'always',
  memoryEpoch: 'always',
  ownedCount: 'always',
};
const STATE: Record<keyof PetState, 'always' | 'sometimes'> = {
  tokenId: 'always',
  name: 'always',
  stage: 'always',
  fullness: 'always',
  tired: 'always',
  until: 'sometimes',
  paused: 'always',
  deepPrice: 'always',
  hello: 'always',
  pendingJob: 'always',
  pendingMode: 'always',
  pendingKind: 'always',
  pendingText: 'always',
  lastThought: 'always',
  memoryEpoch: 'always',
  events: 'always',
  pending: 'sometimes',
  jobKind: 'sometimes',
  thought: 'sometimes',
  code: 'sometimes',
  friend: 'sometimes',
};

const always = (fields: Record<string, 'always' | 'sometimes'>) => Object.entries(fields).filter(([, when]) => when === 'always').map(([key]) => key);
const known = (fields: Record<string, 'always' | 'sometimes'>) => Object.keys(fields);

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const owner = () => token('did:privy:owner', OWNER);

describe('the answers the client is typed against', () => {
  // spec: add-pet › Pet screen › success (владелец)
  it('gives the owner every field of the owner view of `GET /api/pets/:id`, the stage in the client\'s word', async () => {
    h.net().contract.addPet('5', OWNER);
    const { body } = await api('/api/pets/5', { token: await owner() });
    for (const field of always(OWNER_VIEW)) expect(body, field).toHaveProperty(field);
    expect(known(OWNER_VIEW)).toEqual(expect.arrayContaining(Object.keys(body)));
    expect(body.stage).toBe('baby');
  });

  // spec: add-pet › Pet screen › success (гость)
  it('gives a guest and a visitor the base of a pet with the same stage word', async () => {
    h.net().contract.addPet('5', OWNER);
    const guest = await api('/api/pets/5', { token: await token('did:privy:other', NEAR_ACCOUNT(2)) });
    const visitor = await api('/api/pets/5');
    for (const { body } of [guest, visitor]) {
      expect(Object.keys(body).sort()).toEqual(['fullness', 'name', 'stage', 'tokenId', 'viewer']);
      expect(body.stage).toBe('baby');
    }
  });

  // spec: add-pet › Pet screen › success (владелец)
  it('gives every field of `PetState` on the idle poll: the page never loses the name or the stage', async () => {
    h.net().contract.addPet('5', OWNER, { name: 'Pixel', stage: 'Teen' });
    const { body } = await api('/api/pets/5/state', { token: await owner() });
    for (const field of always(STATE)) expect(body, field).toHaveProperty(field);
    expect(known(STATE)).toEqual(expect.arrayContaining(Object.keys(body)));
    expect(body).toMatchObject({ tokenId: '5', name: 'Pixel', stage: 'teen', events: [] });
  });

  // spec: add-pet › Conversation flow › Ответ
  it('carries the same fields with the outcome of a job, and the kind of the job', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    const out = await say(tk, '5', 'Hello!');
    for (const field of always(STATE)) expect(out, field).toHaveProperty(field);
    expect(known(STATE)).toEqual(expect.arrayContaining(Object.keys(out)));
    expect(out).toMatchObject({ name: 'Pixel', stage: 'baby', jobKind: 'reply', lastThought: out.thought.id });
  });
});
