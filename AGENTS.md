# Working in Nearling

## Layout

- [`contract/`](contract/Cargo.toml) is the Rust NEAR contract. Its integration tests use a local near-workspaces sandbox.
- [`server/`](server/package.json) is a Hono Cloudflare Worker. [`wrangler.jsonc`](server/wrangler.jsonc) binds two D1 databases and Durable Objects. Its numbered migrations are in `server/migrations/db/` and `server/migrations/events/`; tests run in the Workers Vitest pool.
- [`web/`](web/package.json) is the Vite and React game. Unit tests live beside source files, Playwright flows in `web/e2e/`, and frame captures in `web/e2e/screens/`.
- [`scripts/verify.sh`](scripts/verify.sh) orchestrates the contract, Worker, client, browser, and capture checks. [`scripts/dev.sh`](scripts/dev.sh) starts local development.

## Local commands

Use Node 24 and the Rust 1.99.1 toolchain with `wasm32-unknown-unknown`. Install each JavaScript package from its lockfile with `npm ci`. Copy `server/.dev.vars.example` to the ignored `server/.dev.vars` and supply local dev values before starting the app.

Automated tests need no secrets. Live gameplay needs local dev values for `NEARAI_API_KEY`, `NEAR_SERVER_KEY`, `NEAR_GAS_ACCOUNT_KEY`, `PRIVY_APP_ID`, `PRIVY_JWKS_URL`, `PRIVY_ASKED_PRIVACY_URL`, `INSULT_LIST`, `RIDDLE_LIST`, and `SKILL_KEY`. Pet-address sweeps also need `BASE_GAS_WALLET_KEY` and `SOLANA_GAS_WALLET_KEY`; `FASTNEAR_API_KEY` is optional if the free RPC throttles. Never put the values in `VITE_*` variables.

```sh
bash scripts/dev.sh
bash scripts/verify.sh --only contract,server,web,e2e
```

To check receipt signature, byte-hash, and hardware-link handling with fixtures:

```sh
npm --prefix web test -- src/verification/check.test.ts src/verification/checkMachine.test.ts src/verification/hardware.test.ts
```

The remaining package commands are:

```sh
cd contract && cargo near build non-reproducible-wasm
npm --prefix server run typecheck
npm --prefix server test
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
npm --prefix web run e2e
```

`scripts/dev.sh` applies local migrations to `nearling-db-dev` and `nearling-events-dev` with `--env dev --local`, then starts the Worker and client. For one migration tree, run from `server/`:

```sh
npx wrangler d1 migrations apply nearling-db-dev --env dev --local
npx wrangler d1 migrations apply nearling-events-dev --env dev --local
```

Dev deployment is a separate operation requiring configured credentials. From `server/`, remote migrations use the same database names with `--env dev --remote`; the Worker command is `npx wrangler deploy --env dev`. Every Wrangler command must name its environment.

## Conventions

- Keep dependency versions exact in the manifests and lockfiles. Add D1 migrations as new numbered files; do not edit migrations already applied to dev.
- Anchor automated tests with `// spec: <change> › <Requirement> › <Scenario>` using the exact requirement and scenario headings.
- The product spec and the screen reference frames behind the `// spec:` anchors and the `screens` verify step are kept outside this public repository.
- Restricted contract methods check `env::predecessor_account_id()` against stored authority. Preserve contract caps and event records when changing transactions.
- The client calls the Worker, NEAR RPC, and Privy through modules in `web/src/seams/`. Keep tests deterministic: mock outside calls, including paid inference, instead of making live calls in tests.
- Keep secrets in ignored local vars or Worker secret bindings. `VITE_*` values are public and must never contain secrets. Do not commit keys or local environment files.
