import { Toast } from '../ds';
import { toastHeld } from '../seams/worker';
import type { Fullness } from '../seams/worker-types';
import { AddNearLayer } from './AddNearSheet';
import { closeFeed, showFeedToast, useFeedRequest, useFeedToast } from './feedRequest';
import { FeedSheet } from './FeedSheet';
import { PaySheet } from '../any-chain/PaySheet';
import { backPay, closePay, usePayRequest, type PayRequest } from '../any-chain/request';
import { backAddress, closeAddress, useAddressRequest } from '../any-chain/request';
import { AddressSheet } from '../any-chain/AddressSheet';
import { GuestFeedSheet, useGuestFeed } from '../any-chain/guestFeed';

// Where Feed sheet stands: inside the Pet screen, so the pet's accent reaches it. The owner's page gives it its conversation
// column (`column`); a guest's page has one centred column, so the sheet is the DS's panel at the page's right (design.md ›
// «Sheet over a guest page»). The Add NEAR sheet another surface opens stands here too, and so does the Toast of a copy: it runs
// out on its own time, also after the sheet that made it was closed.
const hideToast = () => showFeedToast(null);

// A pay or address sheet carries the fullness of the Feed sheet it opened from; one opened from the guest sheet takes the page's plate
// (the guest sheet has none), which is the pet's own unless the own pet stands over a friend's page.
const withFullness = (request: PayRequest, pageFullness?: Fullness): PayRequest =>
  request.fullness || request.elsewhere || !pageFullness ? request : { ...request, fullness: pageFullness };

export function FeedLayer({ column, pageFullness }: { column?: boolean; pageFullness?: Fullness }) {
  const request = useFeedRequest();
  const pay = usePayRequest();
  const address = useAddressRequest();
  const guest = useGuestFeed();
  const toast = useFeedToast();
  return (
    <>
      {request ? <FeedSheet key={`${request.tokenId}:${request.elsewhere}`} request={request} onClose={closeFeed} column={column} pageFullness={pageFullness} /> : null}
      {pay ? <PaySheet key={pay.tokenId} request={withFullness(pay, pageFullness)} onClose={closePay} onBack={backPay} column={column} /> : null}
      {address ? <AddressSheet key={address.tokenId} request={withFullness(address, pageFullness)} onClose={closeAddress} onBack={backAddress} column={column} /> : null}
      {guest ? <GuestFeedSheet request={guest} column={column} /> : null}
      <AddNearLayer />
      {toast ? (
        <Toast icon="check" silent onDone={toastHeld() ? undefined : hideToast}>
          {toast}
        </Toast>
      ) : null}
    </>
  );
}
