import { useEffect, useRef } from 'react';
import { useAuth } from '../seams/auth';
import { track } from '../track';

/** `/pet/<id>?via=feed` is the feed link (`Feed link sharing flow` › «ссылку открыли»): its opening is counted once, when the Pet
 *  screen mounts — not again on the return from Google (`freshSignIn`), and not for the same link out of an in-app browser, which
 *  `signin/openLink.ts` strips of the mark. The event carries no account and no token_id: the opening is not tied to the sharer. */
export function useFeedLinkOpened(): void {
  const { freshSignIn } = useAuth();
  const counted = useRef(false);
  useEffect(() => {
    if (counted.current || freshSignIn) return;
    counted.current = true;
    if (new URLSearchParams(window.location.search).get('via') === 'feed') track('feed_link_opened');
  }, [freshSignIn]);
}
