import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi, type OutfitSlug } from '../seams/worker';
import { useErrandSurfaceOpen } from '../errands/surfaces';
import { known } from './catalogue';

// New outfit notice (`New outfit notice screen`): the earned item that has no notice yet comes from the owner's view (`notices`), and
// the Pet screen opens it by itself over the Pet or Diary page (`useSelfOpen` decides when). Opening it is «shown»: one POST, once,
// from this tab; a reload with it open does not bring it back, the item waits in the wardrobe. A POST that fails leaves it unseen, so it
// shows again at the next load, and `shown` keeps it from reopening in this tab. Two at once: the second opens when the first closes.
// «Wear it» is `Outfit rule`'s «надел» with no optimism: the notice stays, busy, until the answer.
const statusOf = (e: unknown) => (e instanceof WorkerError ? e.status : 0);

export function useNotice({
  tokenId,
  owner,
  notices,
  look,
  reread,
}: {
  tokenId: string;
  /** the page is the owner's: a pet that is someone else's now takes the notice with it */
  owner: boolean;
  /** the earned items whose notice has not been shown, from the owner's view */
  notices: readonly string[];
  /** the pet's own view is read again at once (the worn item changed) */
  look: () => void;
  /** the pet is not this player's any more (`403`): the Pet screen reads it again */
  reread: () => void;
}) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const [open, setOpen] = useState<OutfitSlug | null>(null);
  // the items whose notice was opened in this tab, shown or not seen by the server
  const [shown, setShown] = useState<OutfitSlug[]>([]);
  const shownRef = useRef(new Set<OutfitSlug>());
  const [wearing, setWearing] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;

  // The next notice that is due: none while one stands, and none while Errand sheet, Adapter sheet, Skill code sheet or Verdict card is
  // open (`add-pet-errands`): it opens when they close.
  const errandSurface = useErrandSurfaceOpen();
  const due = !owner || open !== null || errandSurface ? null : (known(notices).find((s) => !shown.includes(s)) ?? null);

  useEffect(() => {
    if (!owner) setOpen(null);
  }, [owner]);

  const tokenOf = useCallback(async () => {
    const a = authRef.current;
    if (!a.authenticated) return null;
    const token = await a.getIdentityToken();
    // a token keeper with no token for a signed-in page: the session ended, as a `401` says it
    if (token === null) throw new WorkerError(401, 'signed_out');
    return token;
  }, []);

  /** The notice for `slug` opens: it is shown from now on, and the server is told once. */
  const show = useCallback(
    (slug: OutfitSlug) => {
      // a render the effect ran twice for (StrictMode) opens it once
      if (shownRef.current.has(slug)) return;
      shownRef.current.add(slug);
      setShown((now) => [...now, slug]);
      setFailed(false);
      setOpen(slug);
      void (async () => {
        try {
          await workerApi.seenOutfit(await tokenOf(), tokenId, slug);
        } catch (e) {
          // not told: it is unseen to the server and shows again at the next load, which is the rule; only an ended session is news
          if (statusOf(e) === 401) authRef.current.endSession(true);
        }
      })();
    },
    [tokenOf, tokenId],
  );

  /** «Later», Close, Esc and the scrim: the item waits in the wardrobe. */
  const later = useCallback(() => setOpen(null), []);

  /** «Wear it». The ended session closes the notice so the page's own line can be seen; its item waits. */
  const wear = useCallback(async () => {
    const item = openRef.current;
    if (item === null || busy.current) return;
    if (!authRef.current.needSession()) {
      setOpen(null);
      return;
    }
    busy.current = true;
    setWearing(true);
    try {
      await workerApi.wear(await tokenOf(), tokenId, item);
      setOpen(null);
      look();
    } catch (e) {
      const status = statusOf(e);
      if (status === 401) {
        authRef.current.endSession(true, true);
        setOpen(null);
      } else if (status === 403) {
        setOpen(null);
        reread();
      } else setFailed(true);
    } finally {
      busy.current = false;
      setWearing(false);
    }
  }, [tokenOf, tokenId, look, reread]);

  return { due, open, show, later, wear, wearing, failed };
}
