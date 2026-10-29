# Nearling

An AI pet as an NFT on NEAR. Built for NEAR HACKATHON, 2026-11-01 to 2026-11-14.

Sections other than Run locally and Verify are filled at submission.

## What

## Problem

## Who

## Tracks

## NEAR features

## Try it in 3 minutes

## Run locally

Needs Node 24, Rust (rustup, with the `wasm32-unknown-unknown` target) and `cargo-near` 0.22.0. Playwright's Chromium for the browser tests: `cd web && npx playwright install chromium`.

```
npm --prefix server install
npm --prefix web install
cp server/.dev.vars.example server/.dev.vars    # then fill the values; the file is gitignored
```

- Worker (local D1, port 8787): `npm --prefix server run dev`
- Web client (port 5173, proxies `/api` and `/health` to the Worker): `npm --prefix web run dev`
- Contract wasm: `cd contract && cargo near build non-reproducible-wasm`

The client is built for the dev environment (testnet) by `npm --prefix web run build` into `web/dist`, which the Worker serves as static assets. In a dev build, `/__day1` is a diagnostics page for Privy sign-in and one testnet transfer; a production-mode build does not contain it.

## Verify

```
bash scripts/verify.sh                       # contract, server, web, e2e, screens; one PASS / FAIL / SKIP line per step
bash scripts/verify.sh <change>              # e2e and screens limited to one OpenSpec change
bash scripts/verify.sh --only server,web     # chosen steps; logs in build/verify/<step>.log
```

- `contract`: `cargo test` in `contract/` builds the wasm and runs it in a local NEAR sandbox (near-workspaces).
- `server`: typecheck and vitest in the Workers pool (Miniflare D1, outbound calls answered by fixtures).
- `web`: typecheck, vitest, the dev build, and a check that a production-mode build contains neither the diagnostics page nor a test fake.
- `e2e`: Playwright against the Vite server in its `e2e` mode, where the Worker, NEAR RPC and Privy modules are replaced by fakes.
- `screens`: captures of the client at 1440x900 and 390x844 next to the design frames (needs the `design/` folder).

## Built Nov 1-14

## Known limitations

## Reused libraries

## Demo post

## Links
