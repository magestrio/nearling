import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { buildEnvFor } from './build-env';

// Plain Vite, not the Cloudflare Vite plugin: the Worker serves web/dist as static assets and
// `wrangler deploy --env <env>` must keep choosing the env (cf-worker skill, Setup).
// Modes: `dev` (the testnet build), `e2e` (fakes for the seams, tests only), production (names only, R1);
// their public values are in build-env.ts.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    // near-api-js 7.4.0 bundles a `util` polyfill (through is-my-json-valid) that reads process.env.NODE_DEBUG
    // while loading; a browser has no `process`, so the page would die on import.
    'process.env': {},
    // The mode's public values (build-env.ts) as constants; there are no .env files.
    ...Object.fromEntries(
      Object.entries(buildEnvFor(mode)).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
    ),
  },
  server: {
    port: 5173,
    strictPort: true,
    // `wrangler dev --env dev` listens on 8787
    proxy: {
      '/api': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // @privy-io/react-auth imports names from optional Solana peer dependencies the game does not install
    // (Privy's troubleshooting page for Vite); Rolldown fails on them unless a missing export is shimmed.
    // Our own imports are checked by tsc.
    rolldownOptions: { shimMissingExports: true },
  },
}));
