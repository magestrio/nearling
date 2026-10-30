import { useCallback, useEffect, useRef, useState } from 'react';

// Every player needs the embedded NEAR wallet: the Worker reads the account from the identity token, and a token with no
// wallet is no session (`Birth flow`, `Pet mint contract` › `receiver`). Nothing asks a new player to make one, so it is
// made right after sign-in, once, before the app is told the player is signed in; the token after it carries the wallet.
export interface NearWallet {
  account: string | null;
  /** true while the wallet is being made: the app waits, it is not a visitor yet */
  making: boolean;
  /** signed in, and the last attempt at the wallet failed: the player is no visitor, and has a tap to retry */
  failed: boolean;
  /** the next attempt, after a failed one (the player's next tap) */
  retry(): void;
}

export function useNearWallet({
  ready,
  authenticated,
  linked,
  create,
  onCreated,
}: {
  ready: boolean;
  authenticated: boolean;
  /** the wallet the user object carries */
  linked: string | null;
  create: () => Promise<string>;
  onCreated: () => void;
}): NearWallet {
  // the user object follows a little later than the answer of `create`
  const [made, setMade] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const account = authenticated ? (linked ?? made) : null;
  const needed = ready && authenticated && account === null;

  useEffect(() => {
    if (!authenticated) {
      setMade(null);
      setFailed(false);
    }
  }, [authenticated]);

  useEffect(() => {
    if (!needed || failed || inFlight.current) return;
    inFlight.current = true;
    create()
      .then((address) => {
        setMade(address);
        onCreated();
      })
      .catch((e: unknown) => {
        console.warn('NEAR wallet not created:', e);
        setFailed(true);
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [needed, failed, create, onCreated]);

  const retry = useCallback(() => setFailed(false), []);
  return { account, making: needed && !failed, failed: authenticated && account === null && failed, retry };
}
