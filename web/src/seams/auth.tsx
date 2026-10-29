import type { ComponentType, ReactNode } from 'react';
import { PrivyAuthProvider } from './auth.privy';

export { useAuth, type AuthApi } from './auth-context';

export const AuthProvider: ComponentType<{ children: ReactNode }> =
  import.meta.env.VITE_FAKES === 'true' ? (await import('./auth.fake')).FakeAuthProvider : PrivyAuthProvider;
