import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi } from '../seams/worker';
import type { CatalogEntryView, Token } from '../seams/worker-types';

// The state of Adapter catalog (`Adapter catalog screen`): the entries, read once and again at «Try again», and who is looking.
// Four viewers, from the session and the address: a visitor (no session); an owner (signed in, `?pet=` is a pet of theirs — «Back to
// {name}», «Connect to …»); a player (signed in with a pet of their own, browsing); a player with no pet. Everything is the tab's
// memory; the page holds nothing between visits.

export type CatalogRole =
  | { kind: 'visitor' }
  | { kind: 'player'; tokenId: string; name: string }
  | { kind: 'no-pet' }
  | { kind: 'unavailable' }
  /** `sources` — how many data sources the pet's skill holds: with 3 every «Connect» is off */
  | { kind: 'owner'; tokenId: string; name: string; sources: number };

export type CatalogView = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; entries: CatalogEntryView[] };

const statusOf = (e: unknown) => (e instanceof WorkerError ? e.status : 0);

export const MAX_SOURCES = 3;

export function useCatalog(pet: string | null) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const [list, setList] = useState<CatalogView>({ kind: 'loading' });
  const [role, setRole] = useState<CatalogRole | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [roleAttempt, setRoleAttempt] = useState(0);

  const tokenOf = useCallback(async (): Promise<Token> => {
    const a = authRef.current;
    if (!a.authenticated) return null;
    const token = await a.getIdentityToken();
    // a token keeper with no token for a signed-in page: the session ended (`Session expiry flow`), as a `401` says it
    if (token === null) throw new WorkerError(401, 'signed_out');
    return token;
  }, []);

  // The entries: anyone's, a visitor's too.
  useEffect(() => {
    if (!auth.ready) return undefined;
    let live = true;
    setList({ kind: 'loading' });
    void (async () => {
      try {
        const token = await tokenOf().catch((e: unknown) => {
          if (statusOf(e) === 401) return null;
          throw e;
        });
        const answer = await workerApi.adapters(token);
        if (live) setList({ kind: 'ready', entries: answer.entries });
      } catch {
        if (live) setList({ kind: 'error' });
      }
    })();
    return () => {
      live = false;
    };
    // the entries are read once per visit: a sign-in changes who is looking, not what is listed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.ready, attempt, tokenOf]);

  // Who is looking.
  useEffect(() => {
    if (!auth.ready) {
      setRole(null);
      return undefined;
    }
    if (!auth.authenticated) {
      setRole({ kind: 'visitor' });
      return undefined;
    }
    let live = true;
    void (async () => {
      try {
        const token = await tokenOf();
        if (pet !== null) {
          try {
            const view = await workerApi.pet(token, pet);
            if (view.viewer === 'owner') {
              // the skill's sources, for the fourth-source rule; a read that fails leaves the count to the server's `409 full`
              const sources = await workerApi.skill(token, pet).then(
                (s) => s.sources.length,
                () => 0,
              );
              if (live) setRole({ kind: 'owner', tokenId: pet, name: view.name, sources });
              return;
            }
          } catch (e) {
            if (statusOf(e) === 401) throw e;
            // a pet that can't be read is not the player's: they browse
          }
        }
        const me = await workerApi.me(token);
        if (!live) return;
        if (me.ownedCount === 0) { setRole({ kind: 'no-pet' }); return; }
        const mine = me.currentPet ?? (await workerApi.myPets(token)).currentPet;
        if (live) setRole(mine ? { kind: 'player', tokenId: mine.tokenId, name: mine.name } : { kind: 'unavailable' });
      } catch (e) {
        if (!live) return;
        if (statusOf(e) === 401) {
          // the session ended before anything was shown: the page is the visitor's at once
          authRef.current.endSession(false);
          return;
        }
        // the viewer could not be told: the entries stand without a «Connect»
        setRole({ kind: 'unavailable' });
      }
    })();
    return () => {
      live = false;
    };
  }, [auth.ready, auth.authenticated, pet, roleAttempt, tokenOf]);

  /** The page's answer to a refusal of the owner's right (`403 not_owner`: the pet was given away) or of the session (`401`). */
  const refused = useCallback((e: unknown) => {
    if (statusOf(e) === 401) authRef.current.endSession(true, true);
    else setRoleAttempt((n) => n + 1);
  }, []);

  const view: CatalogView = list.kind === 'ready' && role === null ? { kind: 'loading' } : list;
  return { view, role, tokenOf, refused, tryAgain: () => { setAttempt((n) => n + 1); setRoleAttempt((n) => n + 1); } };
}
