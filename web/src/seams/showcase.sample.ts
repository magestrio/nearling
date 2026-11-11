import type { ShowcaseCopy } from './worker-types';

// The public pets and counters drawn in design/bundle/screens/account.js. Fake Worker only.
export const SAMPLE_SHOWCASE: ShowcaseCopy = {
  pets: [
    { tokenId: '40', name: 'Juniper', stage: 'adult', fullness: 'full', worn: null },
    { tokenId: '49', name: 'Waffle', stage: 'adult', fullness: 'full', worn: 'party-hat' },
    { tokenId: '47', name: 'Lumen', stage: 'teen', fullness: 'asleep', worn: null },
    { tokenId: '42', name: 'Pip', stage: 'baby', fullness: 'full', worn: null },
    { tokenId: '45', name: 'Ember', stage: 'adult', fullness: 'hungry', worn: null },
    { tokenId: '52', name: 'Tofu', stage: 'adult', fullness: 'full', worn: null },
    { tokenId: '46', name: 'Nori', stage: 'adult', fullness: 'full', worn: null },
    { tokenId: '41', name: 'Mochi', stage: 'adult', fullness: 'asleep', worn: null },
    { tokenId: '298', name: 'Pebble', stage: 'adult', fullness: 'full', worn: null },
    { tokenId: '43', name: 'Kiwi', stage: 'teen', fullness: 'full', worn: null },
  ],
  numbers: { pets_hatched: 1204, thoughts_paid: 58310, spent: '41200000000000000000000000', hires_completed: 312, friend_snacks: 87, counted_since: 0 },
  nearUsdPrice: 188.6 / 41.2,
};
