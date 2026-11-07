# ADR-033: Owner approval of private experience

**Status:** Accepted — user decision 2026-11-06 (OD-2020)
**Date:** 2026-11-06
**Deciders:** the user

## Context

A paid owner errand may include private details. Its signed report can reach a confirmed shared-job contributor, and a voluntarily published exact-byte receipt can reach a link holder. A retained note can shape a later answer for someone else. A gift changes who owns that decision (PRODUCT.md §4 › Pet experience; `cf-worker` › For the spec; `near-ai` › For the spec).

## Options considered

| Option | Player view | Data and cost |
| --- | --- | --- |
| A. Current-owner approval per note and field | Owner reviews and approves; after a gift the new owner must approve again | D1 approval rows, no extra model call or on-chain write; approved notes reach NEAR AI on later hires |
| B. Automatic outside use and field | No review step; a report immediately changes later answers and public wording, including after a gift | Less UI and D1 state, but private report-derived content reaches strangers without a choice |

## Decision

A, chosen by the user on 2026-11-06. Keep up to six notes of 160 characters in D1, derived within the existing paid report call. The current owner approves each note and the field separately before outside use; approvals reset on transfer. Memory clear deletes notes, approval and field. A published field links to a paid report receipt and says «Worked on …», not «expert». The separate note list is owner-only, while the source report retains its existing access.

## Cost and risk

- A hypothesized 60 extra output tokens in the report cost ≈ 0.0097¢ at the existing 20% markup; up to ≈ 240 extra input tokens in a later worker answer cost ≈ 0.0012¢. Model prices are volatile (`near-ai` › Models and prices; PRODUCT.md §4 › Pet experience). Existing report output and «up to» limits stay in force, so a report may have no note.
- NEAR AI retention is unknown. D1 Time Travel may keep deleted rows up to 30 days on Workers Paid, a volatile plan fact (`cf-worker` › For the spec). Downloaded receipt bytes cannot be recalled.

## Action items

1. Show note disclosure in the existing exact-byte publication warning at build time.
