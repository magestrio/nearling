// The only module that talks to Privy. Google only (ADR-001; a dev build also takes Privy test accounts); the NEAR wallet is created on demand. The SDK is mounted
// lazily by auth.tsx: a browser with no session does not load it until a tap that needs it.
import { PrivyProvider, getIdentityToken, useLoginWithEmail, useLoginWithOAuth, useLoginWithSms, usePrivy, type PrivyClientConfig } from '@privy-io/react-auth';
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { config } from '../config';
import type { ProviderApi, SignInError } from './auth-context';
import { useNearWallet } from './nearWallet';
import { readTestLogin } from './testLogin';
import { makeTokenKeeper } from './token';

// A dev build also takes Privy's test accounts (email, SMS) for a scripted sign-in (`testLogin.ts`); production is Google only.
const PRIVY_CONFIG: PrivyClientConfig = {
  loginMethods: import.meta.env.VITE_DEV_ROUTE === 'true' ? ['google', 'email', 'sms'] : ['google'],
  appearance: { theme: 'dark' },
};

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Publishes what Privy knows as an AuthApi to the provider above, which hands it to the whole app. A session with no
 *  NEAR wallet is no sign-in yet: the app is told once the wallet exists, and the first token it gets carries it. */
function Bridge({ onApi }: { onApi: (api: ProviderApi) => void }) {
  const { ready, authenticated, user, logout } = usePrivy();
  const [signInError, setSignInError] = useState<SignInError | null>(null);
  // This load came back from Google: Privy strips `privy_oauth_code` from the address once it has read it, so it is looked
  // at in the first render, before any effect of the SDK has run.
  // A dev test sign-in comes back with no page load and no code in the address: it marks itself fresh when it is done.
  const [freshSignIn, setFreshSignIn] = useState(() => /[?&]privy_oauth_code=/.test(window.location.search));
  const { initOAuth } = useLoginWithOAuth({
    // the player closed Google's window, or something else went wrong (`Sign-in flow` › «отменил вход», «вход не удался»)
    onError: useCallback((code: string) => setSignInError(code === 'oauth_user_denied' || code === 'exited_auth_flow' ? 'cancelled' : 'failed'), []),
  });
  const testEmail = useLoginWithEmail();
  const testSms = useLoginWithSms();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const tokens = useMemo(() => makeTokenKeeper(getIdentityToken), []);

  // Privy's hooks hand out new functions on every render. A published api renders this Bridge again through the provider
  // above, so an api that changed with them would be published for good (React error #185): it changes with the data only.
  const privy = useRef({ initOAuth, logout, createWallet, signRawHash, testEmail, testSms });
  useLayoutEffect(() => {
    privy.current = { initOAuth, logout, createWallet, signRawHash, testEmail, testSms };
  });

  const linked = useMemo(() => {
    const wallet = user?.linkedAccounts.find((a) => a.type === 'wallet' && a.chainType === 'near');
    return wallet && 'address' in wallet ? wallet.address : null;
  }, [user]);

  const email = user?.google?.email ?? null;
  const create = useCallback(async () => (await privy.current.createWallet({ chainType: 'near' })).wallet.address, []);
  const wallet = useNearWallet({ ready, authenticated, linked, create, onCreated: tokens.forget });
  const nearAccountId = wallet.account;
  const signedIn = authenticated && nearAccountId !== null;

  useEffect(() => {
    if (!authenticated) tokens.forget();
  }, [authenticated, tokens]);

  const api = useMemo<ProviderApi>(
    () => ({
      ready: ready && !wallet.making,
      authenticated: signedIn,
      nearAccountId,
      walletFailed: wallet.failed,
      email,
      freshSignIn,
      signInError,
      login() {
        setSignInError(null);
        // Signed in with Google and the wallet is what is missing: the tap tries the wallet again. Any other tap goes to
        // Google, also when Privy still says `authenticated` (the Worker refused the session, or it ended in another tab):
        // a retry then changes nothing and the button would be dead.
        // The address is `/` only when Privy reads it (`Sign-in return data`): the tap that began the sign-in wrote the place
        // into the tab, and the tab goes back to it from there. A sign-in that does not start puts the address back.
        const place = window.location.pathname + window.location.search + window.location.hash;
        window.history.replaceState(null, '', '/');
        if (authenticated && nearAccountId === null) {
          wallet.retry();
          return;
        }
        void (async () => {
          try {
            const test = readTestLogin();
            if (test === null) {
              await privy.current.initOAuth({ provider: 'google' });
            } else {
              // the page stays: `/` with the place in the tab, as after Google, and `ReturnToPlace` leads it back
              if ('email' in test) await privy.current.testEmail.sendCode({ email: test.email });
              else await privy.current.testSms.sendCode({ phoneNumber: test.phone });
              await ('email' in test ? privy.current.testEmail : privy.current.testSms).loginWithCode({ code: test.code });
              setFreshSignIn(true);
            }
          } catch {
            if (window.location.pathname === '/') window.history.replaceState(null, '', place);
            setSignInError('failed');
          }
        })();
      },
      clearSignInError() {
        setSignInError(null);
      },
      async logout() {
        tokens.forget();
        await privy.current.logout();
      },
      createNearWallet: create,
      getIdentityToken: tokens.get,
      async signNearHash(hashHex) {
        if (!nearAccountId) throw new Error('no NEAR wallet to sign with');
        const { signature } = await privy.current.signRawHash({ address: nearAccountId, chainType: 'near', hash: `0x${hashHex}` });
        return hexToBytes(signature);
      },
    }),
    [ready, wallet.making, wallet.failed, wallet.retry, signedIn, authenticated, nearAccountId, create, tokens, email, freshSignIn, signInError],
  );

  useEffect(() => onApi(api), [api, onApi]);
  return null;
}

export function PrivyHost({ onApi }: { onApi: (api: ProviderApi) => void }) {
  return (
    <PrivyProvider appId={config.privyAppId} config={PRIVY_CONFIG}>
      <Bridge onApi={onApi} />
    </PrivyProvider>
  );
}
