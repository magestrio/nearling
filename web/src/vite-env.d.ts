/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENV: 'dev' | 'prod' | 'e2e';
  readonly VITE_NEAR_NETWORK: 'testnet' | 'mainnet';
  readonly VITE_NEAR_RPC_URL: string;
  readonly VITE_CONTRACT_ID: string;
  readonly VITE_SERVER_ACCOUNT_ID: string;
  readonly VITE_TREASURY_ACCOUNT_ID: string;
  readonly VITE_PRIVY_APP_ID: string;
  readonly VITE_DEMO_PET_ID?: string;
  readonly VITE_DEV_ROUTE: 'true' | 'false';
  /** 'true' only in the e2e mode: the seams use their fakes. */
  readonly VITE_FAKES?: 'true';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
