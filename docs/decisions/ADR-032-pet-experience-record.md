# ADR-032: Permanent per-pet work counts

**Status:** Accepted — user decision 2026-11-06 (OD-2021)
**Date:** 2026-11-06
**Deciders:** the user

## Context

Visitors should inspect paid work after a gift or memory clear. Existing accepted `debit_session` calls already emit hire and errand receipts. The count must not expose job words or claim the answer was correct (PRODUCT.md §4 › Pet experience; `near-contract` › For the spec › State vs events).

## Options considered

| Option | Player view | Cost and trust |
| --- | --- | --- |
| A. Per-pet chain counts from upgrade | Immediate word-free hire and completed-errand counts, «Counted since {date}», receipt links | Persistent storage and accepted-debit write gas; an explorer can compare counts with later receipts |
| B. Existing receipts only | Visitors inspect individual paid receipts, including old ones | No new state or write gas; no compact count |
| C. D1 count | Immediate count with older D1 history | Deletion and server error can change it; explorer cannot verify aggregate |

## Decision

A, chosen by the user on 2026-11-06. Only an accepted paid `debit_session` increments the corresponding pet's counter. One shared `counted_since` marks the upgrade date. Receipts prove accepted paid calls, not delivery quality. Earlier receipts remain available outside the count. The full-access key can rewrite contract state through an upgrade (ADR-003).

## Cost and risk

- Two counters plus collection overhead are estimated at ≈ 48 bytes per pet. At 0.00001 NEAR/byte, 50 pets stake ≈ 0.024 NEAR, or ≈ $0.11 at the §4 $4.59/NEAR hypothesis; bytes and rate are estimates and protocol pricing is volatile (`near-contract` › For the spec › What it costs). The project pool stakes first-count storage. Measure actual state bytes and accepted-debit gas delta before mainnet against the $120 project cap.
- A stolen server function-call key can inflate counts only through accepted debits under the existing 0.005 NEAR per-thought, 0.05 NEAR per-pet UTC-day and hire caps. A false work label is possible; public counts are not a quality certificate.

## Action items

1. Measure state bytes and accepted-debit gas on testnet before the mainnet run.
