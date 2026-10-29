// The public build-time values per Vite mode. Every value ends up in the browser bundle: nothing secret
// belongs here, and none lives in a .env file (the repo never commits those). vite.config.ts turns the
// mode's entry into `import.meta.env.VITE_*` constants.
export interface BuildEnv {
  VITE_ENV: 'dev' | 'prod' | 'e2e';
  VITE_NEAR_NETWORK: 'testnet' | 'mainnet';
  VITE_NEAR_RPC_URL: string;
  VITE_CONTRACT_ID: string;
  VITE_TREASURY_ACCOUNT_ID: string;
  VITE_PRIVY_APP_ID: string;
  /** The day-1 checks route (/__day1). Absent from the production build. */
  VITE_DEV_ROUTE: 'true' | 'false';
  /** 'true' only in the e2e mode: the seams use their fakes. No dev or prod build sets it. */
  VITE_FAKES: 'true' | undefined;
}

const dev: BuildEnv = {
  VITE_ENV: 'dev',
  VITE_NEAR_NETWORK: 'testnet',
  VITE_NEAR_RPC_URL: 'https://rpc.testnet.near.org',
  VITE_CONTRACT_ID: 'nearling-dev.testnet',
  VITE_TREASURY_ACCOUNT_ID: 'nearling-dev-treasury.testnet',
  VITE_PRIVY_APP_ID: 'cmvtjc1q100s30gl22hfxq7ap',
  VITE_DEV_ROUTE: 'true',
  VITE_FAKES: undefined,
};

// Names only until R1 mainnet fills them (main session, on the user's yes).
const prod: BuildEnv = {
  VITE_ENV: 'prod',
  VITE_NEAR_NETWORK: 'mainnet',
  VITE_NEAR_RPC_URL: '',
  VITE_CONTRACT_ID: '',
  VITE_TREASURY_ACCOUNT_ID: '',
  VITE_PRIVY_APP_ID: '',
  VITE_DEV_ROUTE: 'false',
  VITE_FAKES: undefined,
};

// Tests only (Playwright's web server): the seams are swapped for fakes; nothing leaves the machine.
const e2e: BuildEnv = {
  VITE_ENV: 'e2e',
  VITE_NEAR_NETWORK: 'testnet',
  VITE_NEAR_RPC_URL: 'http://127.0.0.1:1/rpc-is-faked',
  VITE_CONTRACT_ID: 'nearling-e2e.testnet',
  VITE_TREASURY_ACCOUNT_ID: 'nearling-e2e-treasury.testnet',
  VITE_PRIVY_APP_ID: 'e2e-app-id',
  VITE_DEV_ROUTE: 'true',
  VITE_FAKES: 'true',
};

/** `dev` and `e2e` by name; any other mode (production) is the prod entry. */
export function buildEnvFor(mode: string): BuildEnv {
  if (mode === 'dev') return dev;
  if (mode === 'e2e') return e2e;
  return prod;
}
