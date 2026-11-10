import { registerAction } from '../screens/pet/parts';
import { openAddNear, openFeed, type AddNearRequest, type FeedRequest } from './feedRequest';

// «Feed {name}» of the Pet screen opens Feed sheet (add-pet › design: the parts other changes own). A tap after a sign-in
// runs through the same handler (`queueAction`/`takePendingAction`), as the owner's or as a guest's.
registerAction('feed', ({ tokenId, name, elsewhere, returnFocusTo }) =>
  openFeed({ tokenId, name, label: elsewhere ? `your ${name}` : name, elsewhere: Boolean(elsewhere), returnFocusTo }),
);

// e2e and screens only (VITE_FAKES): the way a test reaches «Feed your {my_pet}» and the Gift sheet's «Add NEAR» before
// `add-pet-work` and `add-gift` build their buttons.
if (import.meta.env.VITE_FAKES === 'true') {
  const g = globalThis as { __nearlingOpenFeed?: (request: FeedRequest) => void; __nearlingOpenAddNear?: (request: AddNearRequest) => void };
  g.__nearlingOpenFeed = openFeed;
  g.__nearlingOpenAddNear = openAddNear;
}
