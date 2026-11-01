import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi, type OutfitSlug, type WardrobeView } from '../seams/worker';

// The Wardrobe screen's state (`Wardrobe screen`, `Connection rule`): the Worker's wardrobe of the pet, read when the screen stands
// and then every 5 s while it stands and not in a hidden tab, at once on return. It is called from the Pet screen, which stays under
// the Wardrobe, so the pet's poll, the line being typed and a job on its way outlive the visit. A first read that fails with nothing to
// show is the screen's «error»; one that fails over a wardrobe already shown is the connection line over it (`Connection rule`).
// What the pet is wearing is also on the pet's own view (`/state`): «Wear» and «Take off» put the answer here at once and ask the
// Pet screen to look, so the two never disagree for longer than a poll.
// A purchase (`Outfit purchase flow`) is the server's: «Buy» sends one POST and the rest is read. The tab remembers three things the
// server does not say to every tab: the item it tapped before a read holds it in `buying`, the id it watches (its POST's, or the one
// it saw in `buying`) so that only a tab that watched a purchase draws its outcome line, and the two lines — «is wearing…» and
// «didn't go through» — which go at the next action and on leaving, so a reload never shows an old one.
export type WardrobeLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; view: WardrobeView }
  /** the first read failed: nothing to draw but the line and «Try again» */
  | { kind: 'error' };

export type WardrobeBanner = 'offline' | 'busy' | null;

export const POLL_WARDROBE_MS = 5000;
/** While a purchase is on its way the wardrobe is read faster, so the outcome reaches the screen soon after it lands. */
export const POLL_BUYING_MS = 1500;

const statusOf = (e: unknown) => (e instanceof WorkerError ? e.status : 0);

export function useWardrobe({
  tokenId,
  active,
  reread,
  askLook,
}: {
  tokenId: string;
  /** the Wardrobe stands now: the owner's pet, at its address */
  active: boolean;
  /** the pet is not this player's any more (`403`): the Pet screen reads it again, and its page is the guest's */
  reread: () => void;
  /** the pet's own view is read again at once (the worn item changed) */
  askLook: () => void;
}) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const ended = auth.sessionEnded;

  const [load, setLoad] = useState<WardrobeLoad>({ kind: 'loading' });
  const [banner, setBanner] = useState<WardrobeBanner>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  // the slug of the tile whose «Wear» or «Take off» is on its way: its button is busy until the answer
  const [wearing, setWearing] = useState<OutfitSlug | null>(null);
  const wearingRef = useRef(false);
  const inFlight = useRef(false);
  // the newest request wins: a read after a wear must not be overtaken by a poll that began before it
  const seq = useRef(0);
  // a stand of the Wardrobe: an answer that belongs to an earlier one is dropped
  const stand = useRef(0);
  const retryRef = useRef<() => void>(() => undefined);

  // the item whose «Buy» was tapped in this tab, before a read holds it in `buying`
  const [tapped, setTapped] = useState<OutfitSlug | null>(null);
  // the item whose purchase did not go through: «Try again» in its Buy's place (the tab's memory)
  const [failed, setFailed] = useState<OutfitSlug | null>(null);
  // the item bought and watched here: «{name} is wearing the {item}!» under the pet (the tab's memory)
  const [bought, setBought] = useState<OutfitSlug | null>(null);
  const posting = useRef(false);
  const watching = useRef<{ id: string; item: OutfitSlug } | null>(null);
  const askLookRef = useRef(askLook);
  askLookRef.current = askLook;

  /** What a read says of the purchase this tab watches. The POST's own answer is not in yet while `posting`: a read of that time may
   *  not hold the row. */
  const settle = useCallback((view: WardrobeView) => {
    if (posting.current) return;
    const w = watching.current;
    if (!w) {
      // a purchase on its way that this tab did not start (a reload, a second tab): watched from now on
      if (view.buying) watching.current = { id: view.buying.id, item: view.buying.item };
      return;
    }
    if (view.buying?.id === w.id) return;
    const done = (status: 'bought' | 'failed' | null) => {
      watching.current = null;
      setTapped(null);
      if (status === 'bought') {
        setFailed(null);
        setBought(w.item);
        askLookRef.current();
      } else if (status === 'failed') setFailed(w.item);
    };
    if (view.outcome?.id === w.id) done(view.outcome.status);
    // its outcome was overtaken by a newer one: the chain says what it came to
    else if (view.owned.includes(w.item)) done('bought');
    // another purchase is open ahead of it: it is queued behind
    else if (view.buying) return;
    else done(null);
  }, []);

  const tokenOf = useCallback(async () => {
    const a = authRef.current;
    if (!a.authenticated) return null;
    const token = await a.getIdentityToken();
    // a token keeper with no token for a signed-in page: the session ended, as a `401` says it
    if (token === null) throw new WorkerError(401, 'signed_out');
    return token;
  }, []);

  /** Reads the wardrobe. `force`: a read the screen asks for itself (after a wear), which a poll in flight does not stand in for. */
  const fetchWardrobe = useCallback(
    async (force = false) => {
      if (inFlight.current && !force) return;
      inFlight.current = true;
      const mine = stand.current;
      const order = (seq.current += 1);
      try {
        const view = await workerApi.wardrobe(await tokenOf(), tokenId);
        if (mine !== stand.current || order !== seq.current) return;
        setLoad({ kind: 'ready', view });
        setBanner(null);
        settle(view);
      } catch (e) {
        if (mine !== stand.current || order !== seq.current) return;
        retryRef.current = () => void fetchWardrobe(true);
        const status = statusOf(e);
        if (status === 401) {
          // nothing drawn yet: the page has no other way to say it, so it gets the line and «Sign in»
          authRef.current.endSession(true, loadRef.current.kind !== 'ready');
          return;
        }
        if (status === 403) {
          reread();
          return;
        }
        if (loadRef.current.kind === 'ready') setBanner(status === 429 ? 'busy' : 'offline');
        else setLoad({ kind: 'error' });
      } finally {
        if (order === seq.current) inFlight.current = false;
      }
    },
    [tokenOf, tokenId, reread, settle],
  );

  // Opening: a wardrobe is read afresh each time the screen stands (`Wardrobe screen` › «loading»); the polls follow. What the tab
  // remembered of the last stand — the lines, the watched purchase — is gone: a reload and Back never show an old line.
  useEffect(() => {
    if (!active) return undefined;
    stand.current += 1;
    setLoad({ kind: 'loading' });
    setBanner(null);
    setTapped(null);
    setFailed(null);
    setBought(null);
    watching.current = null;
    void fetchWardrobe();
    return () => {
      stand.current += 1;
      inFlight.current = false;
    };
  }, [active, fetchWardrobe]);

  // Kept current — a pause lifting, the food, an item earned — not in a hidden tab, at once on return, not after the session ended
  // (`Session expiry flow`). Faster while a purchase is on its way.
  const quick = tapped !== null || (load.kind === 'ready' && load.view.buying !== null);
  useEffect(() => {
    if (!active || ended) return undefined;
    const timer = setInterval(
      () => {
        if (!document.hidden) void fetchWardrobe();
      },
      quick ? POLL_BUYING_MS : POLL_WARDROBE_MS,
    );
    const onVisible = () => {
      if (!document.hidden) void fetchWardrobe();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, ended, quick, fetchWardrobe]);

  /** «Wear» (`item` the slug) and «Take off» (`item` null) of the tile `tile`. No optimism: the tile's button is busy until the
   *  answer; then the pet and the labels change, and the Pet screen looks (`Outfit rule`). The caller has asked for the session. */
  const wear = useCallback(
    async (tile: OutfitSlug, item: OutfitSlug | null) => {
      if (wearingRef.current) return;
      wearingRef.current = true;
      // the next action on the page: the line about what was bought would say what isn't so any more
      setBought(null);
      setWearing(tile);
      const mine = stand.current;
      try {
        const { worn } = await workerApi.wear(await tokenOf(), tokenId, item);
        if (mine !== stand.current) return;
        // a poll that began before the wear holds the old outfit: its answer is dropped, and the next read starts afresh
        seq.current += 1;
        inFlight.current = false;
        setLoad((now) => (now.kind === 'ready' ? { kind: 'ready', view: { ...now.view, worn } } : now));
        setBanner(null);
        askLook();
      } catch (e) {
        const status = statusOf(e);
        if (status === 401) {
          authRef.current.endSession(true, true);
        } else if (status === 403) {
          reread();
        } else if (status === 409) {
          // not_owned: this tab is behind the chain; the wardrobe says what the pet has
          void fetchWardrobe(true);
        } else if (status !== 400) {
          setBanner(status === 429 ? 'busy' : 'offline');
          retryRef.current = () => void fetchWardrobe(true);
        }
      } finally {
        wearingRef.current = false;
        setWearing(null);
      }
    },
    [tokenOf, tokenId, askLook, reread, fetchWardrobe],
  );

  /** «Buy · {price}» and «Try again»: one POST, no signing (the server writes the purchase), then the wardrobe is read until it says
   *  how it ended. The caller has asked for the session. A refusal that says the purchase was not made draws «didn't go through»; an
   *  answer that never came draws the connection line and leaves the purchase to the next read, which holds it if it was made. */
  const buy = useCallback(
    async (item: OutfitSlug) => {
      const now = loadRef.current;
      if (posting.current || watching.current || now.kind !== 'ready' || now.view.buying) return;
      posting.current = true;
      setBought(null);
      setFailed(null);
      setTapped(item);
      const mine = stand.current;
      try {
        const { id } = await workerApi.buy(await tokenOf(), tokenId, item);
        if (mine !== stand.current) return;
        watching.current = { id, item };
        setBanner(null);
        posting.current = false;
        void fetchWardrobe(true);
      } catch (e) {
        if (mine !== stand.current) return;
        setTapped(null);
        const status = statusOf(e);
        if (status === 401) {
          authRef.current.endSession(true, true);
        } else if (status === 403) {
          reread();
        } else if (status === 409 || status === 400) {
          // owned: the item is the pet's already (a second tab); paused: the pause line is in the next read
          setFailed(item);
          if (e instanceof WorkerError && e.code === 'paused') void fetchWardrobe(true);
        } else {
          setBanner(status === 429 ? 'busy' : 'offline');
          retryRef.current = () => void fetchWardrobe(true);
        }
      } finally {
        posting.current = false;
      }
    },
    [tokenOf, tokenId, reread, fetchWardrobe],
  );
  /** The failed line goes with its tile or when Buy turns off (the screen says so). */
  const dropFailed = useCallback(() => setFailed(null), []);

  const tryAgain = useCallback(() => retryRef.current(), []);
  /** «Try again» of the error line: a first read again. */
  const retryRead = useCallback(() => {
    setLoad({ kind: 'loading' });
    void fetchWardrobe(true);
  }, [fetchWardrobe]);
  /** A read now: the screen has a reason to think the wardrobe moved. */
  const read = useCallback(() => void fetchWardrobe(true), [fetchWardrobe]);

  const view = load.kind === 'ready' ? load.view : null;
  return { load, view, banner, wearing, wear, buy, tapped, failed, bought, dropFailed, tryAgain, retryRead, read };
}
