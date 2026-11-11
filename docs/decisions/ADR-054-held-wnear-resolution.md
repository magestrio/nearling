# ADR-054: Resolve held wNEAR deliveries

**Status:** Accepted — OD-2340, user decision 2026-11-11
**Date:** 2026-11-11
**Deciders:** the user

## Context

The paid 1-Click mainnet probe returned unused wNEAR to 1-Click's account inside `intents.near`, with no payer refund despite provider SUCCESS (`.claude/handoff/build-any-chain-feed/probe/trace.md`). An invalid pet, route, sender, or full pending queue therefore leaves delivered wNEAR in game-contract custody, with a public delivery id and NEAR receipt. `sender_id` does not identify the originating payer. The existing contract full-access key can upgrade recovery behavior; the server key must not gain unrestricted access to held funds. No existing method releases held wNEAR until this decision is accepted.

## Options considered

| Option | Player outcome | Authority and cost |
| --- | --- | --- |
| A. Valid-pet owner may claim as food; project resolves invalid deliveries | Owner could turn a held valid-pet amount into food after checking its route; an invalid pet or route waits for a source refund | Owner claim needs a bounded contract method and proof; project operator handles invalid cases after source proof; +~4 Scenarios, stake and gas `? [gap]` |
| B. Project resolves every held delivery to a verified source refund address | Payer sees held, then a separate refund or unresolved state; no held delivery becomes food | Project operator verifies source transfer and pays through a separate route; +~3 Scenarios, refund fees, gas and source proof availability `? [gap]` |

## Decision

Option B. The project operator verifies the source transaction and refund address for every held delivery, then obtains a payable reverse 1-Click quote before using the user's existing contract-account full-access key to release wNEAR to a project settlement account. The operator sends a quoted return to the source-chain USDC address (ADR-057). An unquotable amount stays held; no pet owner may claim it as food. A NEAR release is visible before the source refund and is never itself labeled a refund.

## Consequences

- The 100 eligible-pending cap remains accepted under ADR-043; an over-cap delivery is held with zero unused returned.
- The public held event exposes delivery id, amount, reason and NEAR evidence forever. `held_refund_release` is operator-only; it records the delivery id, amount and transfer, and stakes a permanent resolved-id marker to prevent another release. The source-chain refund has its own public proof. The contract cannot verify the source payer or event-only receipt amount, so the operator remains trusted for these checks.
- The project must reserve funds for fixed receipt-time custody and later resolved-id storage; measured bytes, refund fees and sponsor cost remain build measurements (`near-contract` › For the spec › What it costs, volatile NEAR/USD).
- A live 1-Click minimum can prevent return of a small amount; ADR-055 narrows the earlier every-delivery refund promise.
