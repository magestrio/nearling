# ADR-031: On-chain Showcase totals from the upgrade date

**Status:** Accepted — successful on-chain activity only, with a partial-history label (user, 2026-11-04, Showcase defaults)
**Date:** 2026-11-04
**Deciders:** the user

## Context

Home needs counts that a visitor can inspect on the contract explorer. Hire receipts already appear in accepted `debit_session` transactions and friend snacks in accepted `pet_snack` transactions. Earlier transactions remain public, but this contract upgrade does not reconstruct their totals.

## Options Considered

| Option | What a visitor sees | Cost and trust |
| --- | --- | --- |
| A. Contract counters from upgrade | Two live totals and «since {upgrade date}» | Small persistent contract state and writes on accepted calls; each count ties to a public event |
| B. Worker counts D1 records | Totals could include earlier D1 history | No extra chain storage, but deletion or server error can alter them and an explorer cannot verify the aggregate |
| C. Explorer indexing of all logs | All-time totals if history is complete | Requires an indexer and sustained reads; provider cost and completeness unconfirmed |

## Decision

A. `showcase_view()` returns `hires_completed`, `friend_snacks` and `counted_since`. Accepted `debit_session` hire records and accepted friend `pet_snack` calls increment their counters in the same transaction. The recorded upgrade timestamp marks partial history.

## Consequences

- A failed or replayed call cannot increment a counter. `debit_session` and `pet_snack` keep their existing server-account checks and caps. Earlier events remain readable but are excluded from the displayed count.
- Two `u64` counters plus a timestamp require roughly 24 payload bytes, ≈ 0.00024 NEAR storage stake before collection overhead (arithmetic from near-contract › What it costs; protocol price is volatile at build). Extra write gas is unmeasured and is a build measurement, not a claim of zero cost.
- The contract's full-access key can upgrade code and rewrite state (ADR-003); the public events still reveal any mismatch after an upgrade.
