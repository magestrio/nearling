import { useEffect } from 'react';
import { navigate } from '../route';
import { queueAction } from '../screens/pet/parts';
import { useAuth } from '../seams/auth';
import { takeReturnPlace } from './returnPlace';

/** After Google sign-in Privy lands on `/`; the tab goes back to where the sign-in began, in every build. A sign-in whose
 *  wallet failed goes back too: `/` has no screen of its own, and the place's «Sign in with Google…» is the tap that
 *  tries the wallet again. Nothing the player tapped is run for them then («Feed {name}» waits for a sign-in that is whole). */
export function ReturnToPlace() {
  const auth = useAuth();
  useEffect(() => {
    const back = auth.authenticated || auth.walletFailed;
    if (!auth.ready || !back || window.location.pathname !== '/') return;
    const place = takeReturnPlace();
    if (place) {
      // «Feed {name}» tapped before the sign-in: the pet's screen runs it once it is back
      if (auth.authenticated) queueAction(place.action === 'feed' ? 'feed' : undefined);
      navigate(place.path);
    }
  }, [auth.ready, auth.authenticated, auth.walletFailed]);
  return null;
}
