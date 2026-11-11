# ADR-055: Resolve subminimum held wNEAR

**Status:** Accepted — OD-2341, user decision 2026-11-11
**Date:** 2026-11-11
**Deciders:** the user

## Context

Food has a 0.01 NEAR minimum. A real `wrap.near` delivery below it must still return zero unused after the 1-Click probe; otherwise 1-Click may keep the returned wNEAR (`.claude/handoff/build-any-chain-feed/probe/trace.md`). The origin payer is not authenticated by the NEAR sender string.

## Options considered

| Option | Player outcome | Cost |
| --- | --- | --- |
| A. Accumulate by pet until 0.01 NEAR | Several payments eventually become food for the named pet; senders see a held running total | +~3 Scenarios, per-pet storage stake and accounting `? [gap]`; different payers' amounts may combine |
| B. Resolve each delivery to its verified source refund address | A small payment never becomes food; payer sees a held status followed by a separate refund outcome | +~2 Scenarios, external refund and gas `? [gap]`; requires ADR-054's proof and authority |

## Decision

Option B, narrowed by the 2026-11-11 gate decision. Each held delivery below 0.01 NEAR follows ADR-054 and ADR-057 individually. It never accumulates or becomes food. If its amount is below the live 1-Click reverse quote minimum, it remains held in the contract and the payer is told it cannot be returned through that route now. The earlier promise to return every subminimum delivery does not apply to this case.

## Consequences

- Subminimum wNEAR remains held and non-food with an immutable receipt until its source is verified and a payable return quote is available.
- The payer sees a separate NEAR release and confirmed source refund; ADR-054's resolved-id marker prevents a second release.
