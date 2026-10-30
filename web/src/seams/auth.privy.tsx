// The only module that talks to Privy. Google only (ADR-001); the NEAR wallet is created on demand. The SDK is mounted
// lazily by auth.tsx: a browser with no session does not load it until a tap that needs it.
import { PrivyProvider, getIdentityToken, useLoginWithOAuth, usePrivy, type PrivyClientConfig } from '@privy-io/react-auth';
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { config } from '../config';
import type { AuthApi } from './auth-context';
import { useNearWallet } from './nearWallet';
import { makeTokenKeeper } from './token';

const PRIVY_CONFIG: PrivyClientConfig = { loginMethods: ['google'], appearance: { theme: 'dark' } };

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Publishes what Privy knows as an AuthApi to the provider above, which hands it to the whole app. A session with no
 *  NEAR wallet is no sign-in yet: the app is told once the wallet exists, and the first token it gets carries it. */
function Bridge({ onApi }: { onApi: (api: AuthApi) => void }) {
  const { ready, authenticated, user, logout } = usePrivy();
  const { initOAuth } = useLoginWithOAuth();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const tokens = useMemo(() => makeTokenKeeper(getIdentityToken), []);

  // Privy's hooks hand out new functions on every render. A published api renders this Bridge again through the provider
  // above, so an api that changed with them would be published for good (React error #185): it changes with the data only.
  const privy = useRef({ initOAuth, logout, createWallet, signRawHash });
  useLayoutEffect(() => {
    privy.current = { initOAuth, logout, createWallet, signRawHash };
  });

  const linked = useMemo(() => {
    const wallet = user?.linkedAccounts.find((a) => a.type === 'wallet' && a.chainType === 'near');
    return wallet && 'address' in wallet ? wallet.address : null;
  }, [user]);

  const create = useCallback(async () => (await privy.current.createWallet({ chainType: 'near' })).wallet.address, []);
  const wallet = useNearWallet({ ready, authenticated, linked, create, onCreated: tokens.forget });
  const nearAccountId = wallet.account;
  const signedIn = authenticated && nearAccountId !== null;

  useEffect(() => {
    if (!authenticated) tokens.forget();
  }, [authenticated, tokens]);

  const api = useMemo<AuthApi>(
    () => ({
      ready: ready && !wallet.making,
      authenticated: signedIn,
      nearAccountId,
      walletFailed: wallet.failed,
      login() {
        // Signed in with Google and the wallet is what is missing: the tap tries the wallet again. Any other tap goes to
        // Google, also when Privy still says `authenticated` (the Worker refused the session, or it ended in another tab):
        // a retry then changes nothing and the button would be dead.
        if (authenticated && nearAccountId === null) wallet.retry();
        else void privy.current.initOAuth({ provider: 'google' });
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
    [ready, wallet.making, wallet.failed, wallet.retry, signedIn, authenticated, nearAccountId, create, tokens],
  );

  useEffect(() => onApi(api), [api, onApi]);
  return null;
}

export function PrivyHost({ onApi }: { onApi: (api: AuthApi) => void }) {
  return (
    <PrivyProvider appId={config.privyAppId} config={PRIVY_CONFIG}>
      <Bridge onApi={onApi} />
    </PrivyProvider>
  );
}
