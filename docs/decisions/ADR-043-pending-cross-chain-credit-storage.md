# ADR-043: Storage bound for pending wNEAR credits

**Status:** Accepted — OD-2324, user decision 2026-11-10
**Date:** 2026-11-10
**Deciders:** the user

## Context

`ft_on_transfer` must remember an eligible delivery until `wrap.near.near_withdraw` confirms or can be retried. This state stakes NEAR from the project pool; the stake is released when the route settles. Storage costs 0.00001 NEAR per byte plus record overhead (`near-contract` › What it costs). Pending-record bytes remain unmeasured. The paid mainnet probe found that unused wNEAR from a 1-Click delivery was credited to 1-Click's account inside `intents.near`, while 1-Click reported SUCCESS and no refund (`.claude/handoff/build-any-chain-feed/probe/trace.md`). Any payer can create a quote with a routing message, so an attacker who funds many minimum deliveries could occupy pending storage without a server key if unwrap stalls.

## Options considered

| Option | Player outcome | Project cost and failure |
| --- | --- | --- |
| A. Project pool stakes at most 100 eligible pending credits globally | New quotes and address copying pause at capacity; an already sent delivery is held in contract custody with zero unused returned and a public non-food receipt | ≤100 × measured pending-record stake plus a pre-staked 24-byte held total and sequence (0.00024 NEAR before serialization overhead); later resolved-id stake per release `? [gap]` until build measurement |
| B. Project pool stakes until its normal solvency check fails | More concurrent deliveries can enter recovery | Pending stake could occupy most of the available project pool before refusal; amount `? [gap]`; births and other pool-funded actions can pause |

## Recommendation

Option A, at most 100 eligible pending credits globally, accepted by the user on 2026-11-10. It preserves a hard ceiling on per-credit storage locked by an external payer. Capacity does not reject a real delivery: held wNEAR follows the operator-managed source refund chosen in ADR-054–056. The actual stake is measured in the build before any mainnet claim; NEAR/USD is volatile.

## Consequences

- The Worker stops issuing a new quote or copyable pet address when the 100-credit cap is full or the pool cannot stake its pending credit. Already issued addresses and incoming transfers cannot be stopped.
- Every real `wrap.near` delivery returns zero unused. At capacity or when new pending storage cannot be staked, a pre-staked fixed-size held total and sequence retain custody, while a `cross_chain_held` event preserves per-delivery evidence without new receipt-time storage. Held wNEAR is not food; only the project operator may release it to the project settlement account for a verified source refund. A permanent resolved-id marker is staked at release to prevent duplicate release; this later storage cost is unbounded by the 100 eligible-pending cap and needs build measurement. A failed unwrap remains recoverable. The `cross_chain_feed` event is permanent and the eligible pending stake is returned to the pool.
- The project's $120 spend guard includes any net storage stake or gas loss. A route's wNEAR itself belongs to the pet only after successful credit.
