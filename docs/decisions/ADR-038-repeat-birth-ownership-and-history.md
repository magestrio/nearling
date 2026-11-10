# ADR-038: Current ownership for repeat births

**Status:** Accepted — user decision 2026-11-08, scope unfreeze · Hatch again
**Date:** 2026-11-08
**Deciders:** the user

## Context

The contract currently maps each account to one lifetime birth token and rejects another mint. After gifting the only pet, that record remains even though the account owns none. The user chose a free hatch whenever the account currently owns zero pets. Birth history still matters for a repeat-birth playtest count and recovery. Existing chain birth events, token ownership, and Showcase totals are public for good (PRODUCT.md §8; `near-contract` › For the spec › State vs events).

## Options considered

| Option | Player and observer | Cost and risk |
| --- | --- | --- |
| A. Current ownership plus latest-birth pointer | A gifted-away pet does not block a new hatch; an explorer still sees each mint, and the latest birth is available for recovery | Reuses one account pointer and NEP-181 ownership; each extra pet stakes storage and receives starter food |
| B. Lifetime hatch flag | A giver never hatches again | Lowest incremental spend, but contradicts the user's chosen loop |
| C. Full per-account birth list in contract state | Every prior birth is returned in one view | Extra permanent storage stake per repeat and a growing public account history |

## Decision

Option A. `pet_mint` checks current token ownership, never the historical pointer. A successful birth replaces that account's latest-birth pointer and preserves the old mint's public event and token. `hatch_view` reports current owned count and latest birth distinctly. A server recovery matches the original signed transaction, not merely the existence of any past birth. The user approved the ownership rule on 2026-11-08; the pointer is the minimal storage choice consistent with it.

## Consequences

- Every birth remains public and increments the existing Showcase total; a transfer never erases an older birth.
- The contract must reject a pool debit above 0.023 NEAR for one birth. The previous `MAX_BIRTH_COST` was only a Worker pre-check, so it did not bound a stolen server key (contract/src/limits.rs; contract/src/lib.rs).
- Up to 50 births in one UTC day cost at most 1.15 NEAR of pool principal, plus server mint gas, at this ceiling. The measured longest old birth is 0.02093 NEAR including food; upgraded-state bytes and gas need measurement before mainnet (PRODUCT.md §4 › Hatch again; `near-contract` › For the spec › What it costs, protocol rates volatile).
- The Worker applies the $100 birth stop and reserves enough for a worst-case birth and mint gas under the existing $120 project ceiling. These USD figures are project policy, not contract state; an exchange-rate assumption is volatile (PRODUCT.md §4 › Hatch again).
- A stolen server signing key bypasses those Worker USD checks and can burn pool funds up to the chain's 50 births per UTC day and 0.023 NEAR per birth, until its function-call key is revoked. The 0.023 ceiling must therefore live in `pet_mint`, not only in the Worker.
- The user's full-access contract key remains required to deploy this change; the Worker key cannot upgrade it (ADR-003).
