# ADR-041: Source-chain gas funding custody

**Status:** Accepted — OD-2322 and OD-2301, user decision 2026-11-10
**Date:** 2026-11-10
**Deciders:** the user

## Context

Chain Signatures supplies a signature, not ETH or SOL for an origin-chain USDC sweep (`near-contract` › Chain Signatures). The project sponsors source-chain gas only up to the lesser of 10% of quoted food or $0.05 per sweep (OD-2301). A Worker-held funding key can be stolen independently of the NEAR server key; its balance is the immediate loss ceiling. A managed sponsor might avoid a raw key in the Worker but adds a provider and unknown price or custody terms.

## Options considered

| Option | Player outcome | Cost and key risk |
| --- | --- | --- |
| A. Separate low-balance project hot wallets for Base and Solana | Automatic top-up when a payable sweep is ready, subject to project pause | ETH/SOL funding and source fees; theft loses up to the funded balances. Price per sweep `? [gap]`; the user can revoke and replace each wallet. |
| B. Managed source-chain gas sponsor | Similar wait if the service supports EVM and Solana pet-derived addresses | Provider fee and custody terms `? [gap]`; service outage stops conversion; key blast radius depends on its controls. |

## Recommendation

Option A, separate low-balance Base ETH and Solana SOL project gas wallets, accepted by the user on 2026-11-10. Each key's maximum immediate loss is its funded balance. The per-sweep gas cap and existing $120 project ceiling govern funding; live ETH/SOL fees and endpoint terms are volatile and require measurement.

## Consequences

- The source gas wallet funds only gas, never pet food or NEAR contract upgrades. Its private key must be kept separate from the pet Chain Signatures path and the NEAR full-access key.
- A compromised gas wallet can spend its balance but cannot authorize a USDC sweep from a pet address; that requires ADR-039's contract path.
- The build needs a per-chain funded-balance stop, revocation procedure and actual cost accounting even on failed sweeps. These are operational details, not new player Scenarios.
