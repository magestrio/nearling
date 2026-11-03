import { describe, expect, it } from 'vitest';
import type { PetState, PetView, WardrobeView } from '../../web/src/seams/worker-types';
import { OUTFITS as CLIENT_OUTFITS } from '../../web/src/wardrobe/catalogue';
import { OUTFITS as SERVER_OUTFITS } from '../src/pet/outfits';
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
  mood: 'always',
  myFeed: 'always',
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
  wakes: 'always',
  traits: 'always',
  energy: 'always',
  diaryUnread: 'always',
  pendingQuestion: 'always',
  ownedCount: 'always',
  worn: 'always',
  skill: 'always',
  outfits: 'always',
  notices: 'always',
  outfitPrice: 'always',
  hireMode: 'always',
  offer: 'always',
  pendingProgress: 'always',
  hiresSeen: 'always',
  // only `GET …/state` carries the errand (`Errand flow`): the pet's own page does not
  errand: 'sometimes',
};
const STATE: Record<keyof PetState, 'always' | 'sometimes'> = {
  tokenId: 'always',
  name: 'always',
  stage: 'always',
  fullness: 'always',
  mood: 'always',
  myFeed: 'sometimes',
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
  wakes: 'always',
  traits: 'always',
  energy: 'always',
  diaryUnread: 'always',
  pendingQuestion: 'always',
  worn: 'always',
  // `ownerFields` carries it since add-pet-work group 8
  skill: 'always',
  outfits: 'always',
  notices: 'always',
  outfitPrice: 'always',
  hireMode: 'always',
  offer: 'always',
  pendingProgress: 'always',
  hiresSeen: 'always',
  // the errand away or kept after a failure, or null (`add-pet-errands` › `Errand flow`)
  errand: 'always',
  events: 'always',
  pending: 'sometimes',
  jobKind: 'sometimes',
  thought: 'sometimes',
  code: 'sometimes',
  // the outcome of the tab's own job only (`own_lost`, `price_rose`), never of `ownerFields`
  ownLost: 'sometimes',
  // with `data_failed` of an advice: whether the paying pet's food paid for the data call
  paid: 'sometimes',
  price: 'sometimes',
  friend: 'sometimes',
};

const WARDROBE: Record<keyof WardrobeView, 'always' | 'sometimes'> = {
  owned: 'always',
  worn: 'always',
  price: 'always',
  short: 'always',
  shopPaused: 'always',
  buying: 'always',
  outcome: 'always',
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
    // a signed-in viewer also gets `myFeed` (their own meal on its way for this pet); a visitor has none
    // and the mood of the day, which every viewer's face shows (`add-pet-life` › `Pet life display rule`)
    expect(Object.keys(guest.body).sort()).toEqual(['fullness', 'mood', 'myFeed', 'name', 'skill', 'stage', 'tokenId', 'viewer', 'worn']);
    expect(Object.keys(visitor.body).sort()).toEqual(['fullness', 'mood', 'name', 'skill', 'stage', 'tokenId', 'viewer', 'worn']);
    for (const { body } of [guest, visitor]) expect(body.stage).toBe('baby');
  });

  // spec: add-pet › Pet screen › success (владелец)
  it('gives every field of `PetState` on the idle poll: the page never loses the name or the stage', async () => {
    h.net().contract.addPet('5', OWNER, { name: 'Pixel', stage: 'Teen' });
    const { body } = await api('/api/pets/5/state', { token: await owner() });
    for (const field of always(STATE)) expect(body, field).toHaveProperty(field);
    expect(known(STATE)).toEqual(expect.arrayContaining(Object.keys(body)));
    expect(body).toMatchObject({ tokenId: '5', name: 'Pixel', stage: 'teen', events: [] });
  });

  // spec: add-wardrobe › Wardrobe screen › success
  it('gives every field of `WardrobeView` on the wardrobe read, the items as slugs', async () => {
    h.net().contract.addPet('5', OWNER);
    const { body } = await api('/api/pets/5/wardrobe', { token: await owner() });
    for (const field of always(WARDROBE)) expect(body, field).toHaveProperty(field);
    expect(known(WARDROBE).sort()).toEqual(Object.keys(body).sort());
    expect(body).toMatchObject({ owned: [], worn: null, buying: null, outcome: null });
  });

  // spec: add-wardrobe › Outfit catalogue rule › умные очки × the catalogue of the client
  it("holds the client's catalogue to the server's: the same slugs, in the same order, of the same kinds", () => {
    expect(CLIENT_OUTFITS.map((o) => [o.slug, o.kind])).toEqual(SERVER_OUTFITS.map((o) => [o.slug, o.kind]));
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
