# ADR-040: Origin-chain observation and broadcast provider

**Status:** Accepted — OD-2321, user decision 2026-11-10
**Date:** 2026-11-10
**Deciders:** the user

## Context

The persistent Base and Solana addresses need deposit observation, an origin transaction broadcast after Chain Signatures, and a source-chain transaction link. The NEAR RPC cannot supply these chains. A provider receives public addresses, transaction identifiers and the requester's IP; its retention and current cost are not in `research/gap-1click-feed.md` or the knowledge skills. The quote path can still be paid directly from the sender's wallet, whose own RPC is chosen by that wallet.

## Options considered

| Option | Player outcome | Cost and privacy |
| --- | --- | --- |
| A. Public Base and Solana RPC endpoints | Deposit arrival may be delayed or unavailable under rate limits; source proof remains a chain transaction | Provider charge `? [gap]` per request; public address and IP leave the browser or Worker; retention `? [gap]` |
| B. Paid Base and Solana RPC service chosen by the user | More predictable monitoring and broadcast if its service level supports this workload | Provider charge `? [gap]` per request or month; public address, IP and possibly an account key reach it; retention `? [gap]` |

## Recommendation

Option A, public Base and Solana RPC endpoints, accepted by the user on 2026-11-10. This adds no chosen paid service but gives no reliability promise. Exact endpoint availability, published limits, terms and retention remain research gaps; prices and limits are volatile.

## Consequences

- The status page never calls an unobserved source deposit confirmed. Chain Signatures signing remains under ADR-039, regardless of RPC choice.
- The build must measure deposit detection delay and failed broadcasts on Base and Solana before claiming automatic conversion.
- Researcher must collect current prices per request or month, rate limits, IP/address retention and mainnet availability for concrete providers. These facts are volatile.
