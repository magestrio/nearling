# ADR-056: Disclose held-delivery status

**Status:** Accepted — OD-2342, user decision 2026-11-11
**Date:** 2026-11-11
**Deciders:** the user

## Context

The 1-Click probe showed SUCCESS and `refundedAmount = 0` although the NEAR receiver failed and no pet got food (`.claude/handoff/build-any-chain-feed/probe/trace.md`). A quote status link can be held by a signed-out payer. The on-chain held receipt is public for good, but product copy and the fields shown on the status page are a user decision.

## Options considered

| Option | Payer and owner see | Cost |
| --- | --- | --- |
| A. Amount, reason and NEAR evidence | A held, non-food state with amount, reason, delivery link and later resolution; no refund is claimed before proof | +~2 Scenarios; no extra on-chain storage, existing event and status read |
| B. Amount and NEAR evidence only | A held, non-food state and delivery link; reason remains in the public explorer event | +~1 Scenario; no extra on-chain storage |

## Decision

Option A. A matched payer status link and an existing pet's current owner see the held amount, reason and NEAR evidence, followed by the operator release and confirmed source refund as separate states. Provider SUCCESS and a NEAR release alone never appear as food or a completed refund.

For the chosen reverse 1-Click route (ADR-057), the payer also sees the quoted USDC net and minimum after fees, a distinct below-return-minimum held state, and a failed-return state that promises another attempt only after the operator recovers the wNEAR.

## Consequences

- Status must distinguish held contract custody from a source-chain refund and confirmed food.
- A quote-link holder may see the chosen detail without login; any pet-address sender link retains its existing public-only access boundary. The current owner sees the same held and resolution facts after a fresh ownership check.
