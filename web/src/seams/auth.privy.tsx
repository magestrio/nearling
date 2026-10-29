// The only module that talks to Privy. Google only (ADR-001); the NEAR wallet is created on demand.
import { PrivyProvider, getIdentityToken, useLoginWithOAuth, usePrivy } from '@privy-io/react-auth';
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains';
import { useMemo, type ReactNode } from 'react';
import { config } from '../config';
import { AuthContext, type AuthApi } from './auth-context';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function Bridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, logout } = usePrivy();
  const { initOAuth } = useLoginWithOAuth();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();

  const nearAccountId = useMemo(() => {
    const wallet = user?.linkedAccounts.find((a) => a.type === 'wallet' && a.chainType === 'near');
    return wallet && 'address' in wallet ? wallet.address : null;
  }, [user]);

  const api = useMemo<AuthApi>(
    () => ({
      ready,
      authenticated,
      nearAccountId,
      login() {
        void initOAuth({ provider: 'google' });
      },
      logout,
      async createNearWallet() {
        const { wallet } = await createWallet({ chainType: 'near' });
        return wallet.address;
      },
      getIdentityToken,
      async signNearHash(hashHex) {
        if (!nearAccountId) throw new Error('no NEAR wallet to sign with');
        const { signature } = await signRawHash({ address: nearAccountId, chainType: 'near', hash: `0x${hashHex}` });
        return hexToBytes(signature);
      },
    }),
    [ready, authenticated, nearAccountId, initOAuth, logout, createWallet, signRawHash],
  );

  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}

export function PrivyAuthProvider({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider
      appId={config.privyAppId}
      config={{ loginMethods: ['google'], appearance: { theme: 'dark' } }}
    >
      <Bridge>{children}</Bridge>
    </PrivyProvider>
  );
}
