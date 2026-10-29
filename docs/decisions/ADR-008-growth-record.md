# ADR-008: What a growth transition records on chain

**Status:** Accepted (the user's decisions 2026-10-27: Product defaults «the contract moves the stage forward only, at most once a UTC day, no developer acceleration»; «growth in README is a «see Y» step on the demo pet's transaction»; OD-300 → «Та же черта окрепла»; critic MAJOR 1 → «Сразу после записи», «По часам цепи»). The details below were decided by default by tech-architect in the `add-pet-life` run.
**Date:** 2026-10-27
**Deciders:** the user

## Context
The pet grows baby → teen → adult on its 2nd and 3rd counted day — a UTC day on which it answered its owner (PRODUCT.md §4 › Рост, черты, настроение, энергия). Each transition brings one trait out of five, chosen by the server from the pet's deeds since the last transition. Stage and traits must live in the contract and outlive the server (§3 › Отличие); the transition is the README's «see Y» transaction for the `nfts` track. Everything the contract stores or emits is public for good (`near-contract` › What is public). The server's key is a function-call key without allowance (ADR-002): the contract, not the key, bounds what it can do.

## Options Considered

### Who counts the days
- **A — the server counts, the contract bounds the pace (chosen).** The server keeps counted days and deeds in D1 and calls `pet_grow` when a transition is due; the contract accepts only the next stage, at most one stage change per UTC day (`block_timestamp`, birth counts), a trait from the list of five.
- **B — the contract counts.** The server records every counted day on chain. The contract could then enforce «2nd / 3rd counted day» itself, but every day the owner talked to the pet would become public for good, and every pet would cost a transaction and gas per day of play — against «no rollback, two records per pet» in §4.

### Where stage and traits live
- **State + event (chosen).** Stage, up to two traits and the UTC day of the last stage change are fixed-size fields of the pet record, their storage paid at birth from the project pool; `pet_view` and `nft_token` return them. Each transition emits NEP-297 `grow` {token_id, stage, trait}.
- **Event only.** Cheaper in storage by a few bytes, but the stage would not be readable from the contract once our server is gone — against §3.

### What the transition shows of the deeds
- **Only the trait (chosen).** Deed counts and the feeding friends' accounts stay in D1, cleared at each transition and not kept after adult.
- **The counts too.** Would let anyone check the trait against deeds, but publishes for good how often the owner played riddles or used «Think hard» (§4: the player's topics must not stay on chain).

## Decision
A, state + event, only the trait. The trait may repeat at the adult transition: the contract accepts the teen's trait a second time, and the trait has grown stronger.

## Consequences
- A stolen server key can grow any pet, but no faster than a living owner could (teen the day after birth, adult a day later), only forward, with traits from the list but not earned by deeds — public for good. Revocation as in ADR-002.
- The server assigns a counted day to the UTC day of `block_timestamp`, as the contract does. A `pet_grow` that fails for any reason (second change in a day, the gas pause, RPC or network) is resent with the same trait until it is written; the server checks the stage on chain first and never resends a written transition. Until then the pet stays in its stage.
- Deleting the pet's memory does not touch counted days, deeds, mood or energy; growth continues (`Pet life data`).
- Gas: two transactions per pet, paid by the server account; already in §4 › Траты проекта.
- Re-check before the build: the Nov 4/6 protocol votes (`near-contract` › Volatile) do not change this design.
