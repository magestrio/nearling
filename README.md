# Nearling

## What

In Nearling, pets can hire each other and pay from their food, and a friend can open a link and feed a sleeping pet. It is a desktop-first browser game, adapted to phones, about an AI pet represented by a NEP-171 NFT on NEAR. A pet talks, remembers, grows, and wears outfits. Its food pays for its thoughts; when it runs out, the pet sleeps until fed. A friend can visit before signing in.

The NFT is the ownership record. The contract stores food, character, growth, and wardrobe by token ID, so they travel with the pet when it is given away. A pet is not a separate NEAR account. The project's contract key can upgrade the code; the birth event's character hash makes a later character rewrite detectable, not impossible.

## Problem

A conversational pet needs a way to pay for its own answers and show what produced them. Nearling ties food spending, work fees, and signed-answer receipts to the same pet that players can own and give away.

## Who

The intended player is an adult virtual-pet fan who need not know crypto and spends about two or three minutes a day with a pet.

## Tracks

- **Games With Real Economies** (`games`): food funds thoughts, work earns food, and hunger and feeding change what a pet can do.
- **NFTs That Do Something** (`nfts`): the NEP-171 token carries contract-held food, character, growth, and wardrobe across a gift.
- **Agent Economy** (`agents`): in Auto mode, a pet can hire a known pet during a conversation; in Manual mode, it asks its owner first. The payer spends its pet's food and the worker keeps its fee after answer cost.

## NEAR features

The examples below are **testnet** transactions for `nearling-dev.testnet`. Each cited example shows a successful method and the named event. These are not mainnet activity.

| Behavior | Implementation | Testnet evidence |
| --- | --- | --- |
| Birth, ownership, and a character hash | [`pet_mint`, `nft_token`, `nft_tokens_for_owner`](contract/src/lib.rs), [`pet_born`](contract/src/events.rs) | [Pixel, token 0: `pet_mint`, `nft_mint`, `pet_born`](https://testnet.nearblocks.io/txns/3k7B8xjHntFZkWMvnqJ2cFpZPXmLDLVHnm2A2WPydusn) |
| Food pays for a thought; the contract records price, model, call hashes, signature, and signer | [`debit_session`](contract/src/lib.rs), [`receipt`](contract/src/events.rs), [`closeAndDebit`](server/src/debit.ts), [NEAR AI call and signature handling](server/src/nearai.ts) | [Token 5: `debit_session` with a `receipt`](https://testnet.nearblocks.io/txns/4u51yf5YCEm51yZfy3MEzGfw95svt8jPsYRAwNe71yKD) |
| Paid advice from another pet | [`debit_session`](contract/src/lib.rs), [`hire`](contract/src/events.rs), [hire processing](server/src/work/hire.ts) | [Token 4 paid token 2 for three player-requested answers; `hire` events have `kind: player`](https://testnet.nearblocks.io/txns/HqMJxPgUypW39Vki3pVPo8KST6SnbpgiMnq6o4ZNLK3q). No confirmed Auto pet-initiated hire transaction was found. |
| Feeding and waking | [`pet_feed`, `pet_snack`](contract/src/lib.rs), [feeding routes](server/src/routes/feeding.ts) | [Token 3: 0.01 NEAR `pet_feed` with a `feed` event](https://testnet.nearblocks.io/txns/6CeP291W3NJgScHuG8X43SzsxKmAuVsHyTHNzyoxHV9j). The event proves the feed; the transaction alone does not establish the pet's prior hunger state. |
| Growth and daily streak | [`pet_grow`, `streak_mark`](contract/src/lib.rs) | [Token 0 grew to Adult](https://testnet.nearblocks.io/txns/5aBa415NaviDteg7DRDCghxoA9ESMbSWHk4kduQ87b1C); [token 4 recorded a streak](https://testnet.nearblocks.io/txns/4uPdfpCEwGZAv4C38XNkXGYGWmbniUnFxyNHNhSbJAxc) |
| Daily riddle commit and reveal | [`riddle_commit`, `riddle_reveal`](contract/src/lib.rs) | [Successful commit](https://testnet.nearblocks.io/txns/4V5EXGVUCfRFFKZnU7RcewaXQenCC2raEMfJ47mrmRMq) and [successful reveal of a prior day's riddle](https://testnet.nearblocks.io/txns/J48j9f1UPK8HReL5D6Z3JgvEJecqHoipT1H9hdoihMhu) |
| Wardrobe and giving a pet away | [`outfit_buy`, `nft_transfer`](contract/src/lib.rs) | [Token 4 bought an outfit](https://testnet.nearblocks.io/txns/D3XdTVfu7Aj8eY2t8ikHoz8sRwCiLHCSN89TfoZvAW2h); [token 0 was transferred](https://testnet.nearblocks.io/txns/F26e99kMrznnA8tK7vF57cLwkYeP1sytiRXiUQa4SmH) |
| Feed from another chain or a pet address | [`ft_on_transfer`, `sweep_sign`](contract/src/lib.rs), [quote](server/src/routes/anyChainQuote.ts), [deposit](server/src/routes/anyChainDeposit.ts), [sweep](server/src/routes/anyChainSweep.ts) | No confirmed Nearling cross-chain food credit transaction was found. |

The contract enforces a 0.005 NEAR maximum per thought and a 0.05 NEAR debit limit per pet per UTC day in [`limits.rs`](contract/src/limits.rs). The per-pet food balance is contract state, not a wallet held by the NFT.

## Try it in 3 minutes

This is a read-only guest path on the testnet app. An already signed-in owner may be sent straight to their pet. New thoughts, hiring, and feeding require sign-in and may use testnet funds.

1. Open the home page in a signed-out tab. The page says **“This pet pays for its own thoughts. When the money runs out, it falls asleep.”**
2. Choose **“Find a pet to ask”**. The board has the same heading and, when pets are listed, a **“Search skills”** field. A currently available card says **“{name} can help now”**; availability may change.
3. Choose **“Visit {name}”** on a card, or open `/pet/0`. On the pet page choose **“Check it's really {name}”**. Use the name and hunger state shown there.
4. On the verification page, a checked character shows **“Character sealed at hatch”**. A checked signature shows **“Signed by key {signer}”**. When original request and reply bytes are available and match the receipt, it shows **“Request and reply match the receipt on NEAR”**. A signed-out visitor sees **“Anyone can check {name}'s record and receipts. Is {name} yours? Sign in to check its other thoughts word for word.”**
5. For a receipt with a model-signed completion, choose **“Check the hardware on NEAR AI”**. The page explains: **“This page checks the signature, not whose key it is. NEAR AI's page checks the key against the model's secure hardware — but only keys in use right now.”** The external page may no longer match an older signer after key rotation.

A separate signed-in feed example needs a pet that can be fed and an available payment option. Open its `/pet/<id>?via=feed` link, choose **“Feed {name}”**, then a free snack if available or a NEAR portion. After a confirmed ordinary feed without a known friend name the sheet says **“You fed {name}! {name} will remember you.”**; when a friend name is known, it appears before the period. A feed transaction alone does not establish that a pet was asleep.

## Run locally

Use Node 24, Rust 1.99.1 with the `wasm32-unknown-unknown` target, `cargo-near` 0.22.0, and Chromium for browser tests. The [server](server/package-lock.json) and [client](web/package-lock.json) have separate lockfiles.

```sh
cd server && npm ci && cd ..
cd web && npm ci && npx playwright install chromium && cd ..
cp server/.dev.vars.example server/.dev.vars
# Fill the dev values in server/.dev.vars locally.
bash scripts/dev.sh
```

`scripts/dev.sh` checks for the local env file, applies both local D1 migration trees (`nearling-db-dev` and `nearling-events-dev` with `--env dev --local`), builds the dev client for the Worker's assets, and starts the Worker at `http://localhost:8787` and Vite at `http://localhost:5173`. Vite proxies `/api` and `/health` to the Worker. The script stops the two processes it starts when it exits. Live gameplay needs configured dev credentials; automated tests use fixtures for outside services. Keep `.dev.vars` and keys out of git.

Build the testnet contract wasm with `cd contract && cargo near build non-reproducible-wasm`. The local start command does not deploy a contract.

## Verify

```sh
bash scripts/verify.sh --only contract,server,web,e2e
npm --prefix web test -- src/verification/check.test.ts src/verification/checkMachine.test.ts src/verification/hardware.test.ts
```

The verifier reports `PASS`, `FAIL`, or `SKIP` per step and writes details under `build/verify/`. Contract tests deploy to a local near-workspaces sandbox. Server tests run in the Workers pool with D1 and mocked outbound calls. Client unit and Playwright e2e tests use fixtures and mocked Worker, RPC, and Privy seams. The frame-capture `screens` step additionally needs the reference bundle kept outside the public clone.

To inspect a thought yourself:

1. On a pet page choose **“Check it's really {name}”** and select a receipt. [`verifyPointer`](web/src/verification/checkMachine.ts) reads the successful `debit_session` transaction from NEAR RPC and matches exactly one `receipt` event to the paying token and debit ID. It compares the event's model, price, calls, and pointer. A mismatch is shown as such.
2. For bytes the owner can see, or bytes deliberately published through a receipt link, [`checkCall`](web/src/verification/check.ts) hashes each original request and reply byte array with SHA-256 and compares it with that call's on-chain `req_sha256` and `res_sha256`. JSON must not be re-serialized. A public receipt offers **“Download request bytes”** and **“Download reply bytes”**. When bytes were cleared, the word-for-word comparison is unavailable although the public hashes remain.
3. The same checker recovers an EIP-191 secp256k1 signer from `<model_id>:<request_sha256>:<response_sha256>` for `provider_tee`, or the two hashes for `gateway`, and compares it with the receipt's signer. **“Signed by key {signer}”** proves that key signed the hashes; it alone does not establish who controlled the key.
4. For `provider_tee` with a completion ID, [`hardwareHref`](web/src/verification/hardware.ts) sends public receipt fields in a URL fragment to NEAR AI's verification page. Check that page's current attested signing address against the receipt. Nearling stores no historical attestation report, so a rotated key may no longer be checkable there. The game's signature mark alone is not a hardware attestation.

The Home totals come from the contract's [`showcase_view`](contract/src/lib.rs) via the Worker's [`showcaseView`](server/src/chain.ts). The separate events D1 has some feature-specific tables, including [`showcase_card_shared`](server/migrations/events/0001_showcase_card_shared.sql). After local migrations, `SELECT kind, delivery, COUNT(*) FROM showcase_card_shared GROUP BY kind, delivery;` gives counts of card deliveries only. There is no implemented full playtest funnel or measured retention query.

## Built Nov 1–14

The first repository commit was on 2026-10-29, after the hackathon announcement on October 19. Feature work continued through November 12: wardrobe on Nov 1; work and errands on Nov 3; verification and gifts on Nov 4; showcase on Nov 5; society and wills on Nov 7; repeat hatching and game layout on Nov 10; debates on Nov 11; any-chain feeding and fixes on Nov 12. This describes the work in this repository, including its earlier October setup.

## Known limitations

- A current NEAR AI hardware match can disappear after a model signing-key rotation because historical attestation reports are not stored.

## Reused libraries and code

The pet generator and 3D assembly in [`web/src/pet/proto/`](web/src/pet/proto/) were ported from the creator's earlier `pet-proto` design prototype. They are reused code.

The contract uses `near-sdk` and `near-contract-standards` 5.30.0; its test/build tools include `near-workspaces` 0.24.0 and `cargo-near-build` 0.11.5. The Worker uses Hono 4.13.14, `near-api-js` 7.4.0, `jose` 6.2.14, and Noble curves and hashes 2.2.0; its tools include Wrangler 4.155.0, the Workers Vitest plugin 1.4.10, Vitest 5.0.5, and TypeScript 6.0.3. The client uses React and React DOM 19.3.1, Three 0.186.1, React Three Fiber 9.8.2, drei 10.7.9, postprocessing 6.39.5, R3F postprocessing 3.2.2, Privy React Auth 3.51.0, `near-api-js` 7.4.0, Noble curves 1.8.0 and hashes 1.4.0; its tools include Vite 8.3.5, Playwright 1.58.2, Vitest 5.0.5, TypeScript 6.0.3, and jsdom 30.1.3. The complete dependency lists, including type packages and Rust test dependencies, are in [the contract manifest](contract/Cargo.toml), [the Worker manifest](server/package.json), and [the client manifest](web/package.json).

## Links

- [Testnet contract `nearling-dev.testnet`](https://testnet.nearblocks.io/address/nearling-dev.testnet)
