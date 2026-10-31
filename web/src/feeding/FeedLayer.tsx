import { Toast } from '../ds';
import { toastHeld } from '../seams/worker';
import type { Fullness } from '../seams/worker-types';
import { AddNearLayer } from './AddNearSheet';
import { closeFeed, showFeedToast, useFeedRequest, useFeedToast } from './feedRequest';
import { FeedSheet } from './FeedSheet';

// Where Feed sheet stands: inside the Pet screen, so the pet's accent reaches it. The owner's page gives it its conversation
// column (`column`); a guest's page has one centred column, so the sheet is the DS's panel at the page's right (design.md ›
// «Sheet over a guest page»). The Add NEAR sheet another surface opens stands here too, and so does the Toast of a copy: it runs
// out on its own time, also after the sheet that made it was closed.
const hideToast = () => showFeedToast(null);

export function FeedLayer({ column, pageFullness }: { column?: boolean; pageFullness?: Fullness }) {
  const request = useFeedRequest();
  const toast = useFeedToast();
  return (
    <>
      {request ? <FeedSheet key={`${request.tokenId}:${request.elsewhere}`} request={request} onClose={closeFeed} column={column} pageFullness={pageFullness} /> : null}
      <AddNearLayer />
      {toast ? (
        <Toast icon="check" silent onDone={toastHeld() ? undefined : hideToast}>
          {toast}
        </Toast>
      ) : null}
    </>
  );
}
