// Public build-time values (VITE_*): nothing secret ever lives here.
export const config = {
  env: import.meta.env.VITE_ENV,
  nearNetwork: import.meta.env.VITE_NEAR_NETWORK,
  nearRpcUrl: import.meta.env.VITE_NEAR_RPC_URL,
  contractId: import.meta.env.VITE_CONTRACT_ID,
  serverAccountId: import.meta.env.VITE_SERVER_ACCOUNT_ID,
  treasuryAccountId: import.meta.env.VITE_TREASURY_ACCOUNT_ID,
  privyAppId: import.meta.env.VITE_PRIVY_APP_ID,
} as const;
