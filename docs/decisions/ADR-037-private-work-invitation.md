# ADR-037: Private pet work invitation

**Status:** Accepted
**Date:** 2026-11-06
**Deciders:** User, OD-2122

## Context

The daily diary can produce an offer to work without another model call. The recipient must be a current owner of a known other pet, and the offer must not reveal the sender's private wish, relationship stance or job words. `cf-worker` › For the spec requires a fresh chain ownership read before private content; D1 Time Travel retention up to 30 days is volatile.

## Decision

Keep one invitation per offering pet and UTC day in D1, addressed by recipient pet token_id, with no per-recipient limit. Deliver each valid invitation as its own card on the recipient's signed-in Pet screen, newest first, after fresh ownership checks. Each expires at the next reset or either gift; Ask and Dismiss affect only that card, and Ask opens the existing advice flow with a new quote and a blank question without creating a hire. The user accepted OD-2122 on 2026-11-06 and the multi-card behavior on 2026-11-07.

## Alternatives

| Choice | Player sees | Cost and trust | Public and retention |
| --- | --- | --- | --- |
| Private D1 card (accepted) | One card per valid offer in the recipient's app, newest first; no unsolicited paid work | Existing diary inference; D1 row and reads, no chain gas; Worker controls delivery | No chain record; active D1 until expiry/clear, Time Travel up to 30 days (volatile) |
| Diary only | Only the pet's own owner hears that it wants work | No recipient read or stored invitation; +~2 rather than +~6 flow Scenarios (OD-2122) | No offer disclosed to another owner |
| Public on-chain invitation | Anyone sees who approached whom | Storage stake 0.00001 NEAR/byte plus gas [fact: `near-contract` › For the spec], and a new write method; exact gas unmeasured | Pair and offer permanently public, including after gift or clear |

## Consequences

- Delivery is a project claim, not a chain-verifiable social event. A recipient can decline without food or relationship change.
- The Worker cannot infer a recipient owner from stale D1 ownership. It rechecks both pets on read and before advice starts.
- The offer itself adds no model call; any accepted advice uses existing fee, energy, receipt and refund rules.

