# ADR-042: Chain-qualified pet address derivation

**Status:** Accepted — OD-2323, user decision 2026-11-10
**Date:** 2026-11-10
**Deciders:** the user

## Context

The Base and Solana addresses use `<chain>:<token_id>` paths. Chain Signatures derives addresses from the NEAR contract account, path and MPC public key; its knowledge skill advises a distinct path per chain (`near-contract` › Chain Signatures; references/facts.md §F). A path is part of the public address. Changing it after a deposit strands the old address unless the old path remains supported. This is a permanent public and recovery choice.

## Options considered

| Option | Player outcome | Cost and risk |
| --- | --- | --- |
| A. Same `token_id` path for Base and Solana | Matches today's §3 map; each chain still displays a different address format | One path namespace across chains; contrary to the skill's distinct-path advice. Chain Signatures fee per signature is unchanged. |
| B. Stable `<chain>:<token_id>` path per chain | The pet still keeps one address on each chain through gifts, with an explicit network binding | Two permanent paths per pet; contract and UI must never change them after the first address is shown. Same signing fee per sweep. |

## Recommendation

Option B, accepted by the user on 2026-11-10, before any address is shown or funded. It follows the skill's cross-chain derivation advice without changing the player's one-address-per-network promise. Chain Signatures availability, signer public key and fees are volatile and need confirmation at build time.

## Consequences

- PRODUCT.md §3/§4 and this change's `pet_address_view` and `sweep_sign` use the same `<chain>:<token_id>` path.
- A gift changes owner approval, not the contract account, path or address. The MPC public-key version used for shown addresses must remain pinned or old deposits need a recovery route; signer-key rotation support is a research gap.
- No address is copied until the game can derive and sign from the same pinned key version on both networks.
