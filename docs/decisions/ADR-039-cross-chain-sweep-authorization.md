# ADR-039: Authorization of pet-address USDC sweeps

**Status:** Accepted — OD-2320, user decision 2026-11-10
**Date:** 2026-11-10
**Deciders:** the user

## Context

A pet's Base and Solana addresses are derived from the game's NEAR contract account and `path = <chain>:<token_id>`; the private signing share is held by Chain Signatures, not by the Worker (`near-contract` › Chain Signatures). Moving received USDC needs an origin-chain transaction and gas. The NEAR contract can constrain the pet path, token, amount and encoded transfer, but cannot itself verify that a dynamic 1-Click deposit address belongs to a quote for that pet. A compromised server key could ask for a malicious destination if it alone authorizes signing. The project sponsors source gas only up to the lesser of 10% of quoted food or $0.05 per sweep (user decision OD-2301).

## Options considered

| Option | Player outcome | Cost and key risk |
| --- | --- | --- |
| A. Current owner authorizes each sweep | A friend's deposit waits until the owner opens the game and approves conversion; a gift moves approval power to the new owner | One Privy raw-hash signature and one server-submitted NEAR transaction per sweep, plus source-chain gas. The owner need not fund a NEAR account. The server key alone cannot redirect deposited USDC; a compromised owner key can authorize a bad sweep for that pet. |
| B. Server account authorizes each sweep | Supported deposits can convert while the owner is away | Server key theft can redirect all unswept USDC at pet addresses; per-sweep source gas cap and project budget do not bound the value already deposited. |

## Recommendation

Option A, accepted by the user on 2026-11-10. The owner's explicit approval keeps the key's loss radius near one pet and makes the displayed quote and destination reviewable. Privy signs a domain-separated hash of this contract, pet, chain, token, amount, destination, route, per-pet-chain sequence and expiry. The Worker submits that signature using its existing NEAR account; the contract verifies it against the current owner's implicit key before asking Chain Signatures to sign the source transaction. The sequence prevents replay without a permanent used-route map. Privy raw-hash signing is Tier 2 and no gas sponsorship is supplied (`web-client` › For the spec; volatile). Conversion waits for the current owner.

## Consequences

- The contract accepts only a sweep for the derived path and named USDC contract, with an origin transaction addressed to the supplied destination. It cannot verify a dynamic 1-Click quote, so the owner must inspect the displayed destination. The quote remains an off-chain claim until the NEAR food credit settles.
- The pet address and its on-chain deposits are public and remain tied to `token_id` after a gift. Pending conversion rights follow current ownership; no prior owner can approve a new sweep.
- The project pays NEAR gas for Chain Signatures and bounded ETH/SOL gas, capped per sweep at the lesser of 10% of quoted food or $0.05. Source gas and quote fees are volatile and come from the live quote (research/gap-1click-feed.md; `near-contract` › Chain Signatures).
- This ADR does not change the existing server function-call key's ability to spend pet food through `debit_session` under its per-thought and daily caps (ADR-002, ADR-004).
