# ADR-036: Pet will reserve and target privacy

**Status:** Accepted
**Date:** 2026-11-06
**Deciders:** User, OD-2120, OD-2121 and OD-2130

## Context

The pet's wish needs food it can save without starving and without ordinary debits taking it first. The existing contract keeps given food and project food per pet, while the Worker holds private diary words. The outcome must survive a gift; memory clear must release unspent food. A public target gives stronger proof of intent and less privacy. Contract state costs 0.00001 NEAR per byte locked [fact: `near-contract` › For the spec]; NEAR/USD and deployed gas are volatile and unmeasured.

## Decision

Keep the pet-chosen outfit target and reason in D1. Preallocate one per-pet public reserve amount and active flag at mint or contract upgrade from the project pool. Accepted paid hire settlement saves at most 25% of net earning, capped at one outfit price and food above Full plus three typical thoughts. Ordinary debits exclude it. `will_start` activates, `will_release` returns unspent food to the pet, and wish `outfit_buy` automatically buys the unowned target from the active reserve under the existing daily cap. If that cap rejects a fully funded purchase, the Worker retries automatically after UTC reset. The Worker proposes the item; the contract does not prove that item was the pet's private goal. A gift retains and pauses the reserve; the new owner chooses whether to resume or cancel it, while clear waits for release before erasing D1 words. The user accepted OD-2120, OD-2121 and OD-2130 on 2026-11-06 and the reset retry on 2026-11-06.

## Alternatives

| Choice | Player sees | Cost and trust | Public and retention |
| --- | --- | --- | --- |
| Private D1 target, public reserve (accepted) | A wish, progress and eventual outfit | No new model call; one bounded state field and transaction gas for start, release and purchase, to measure at build; trusts Worker for target | Reserve and outfit public for good; target deletable from active D1, Time Travel up to 30 days (volatile) |
| Salted target commitment on chain | Same view, with later proof that the purchased item matched the earlier target | Extra commitment state and reveal checks; +~3 Scenarios; salt must not leak before purchase | Commitment and later target permanently public; four-item target cannot be hidden after reveal |
| D1-only earmark | Same UI until ordinary spending races the wish | No new chain storage, but contract cannot stop ordinary debits spending saved food; fails the food guarantee | No public reserve; eventual outfit still public |

## Consequences

- A stolen server function-call key can activate, release or spend reserves only within each pet's food, one outfit price, existing 0.05 NEAR daily debit cap and purchasable-item rules. It cannot send reserve to an account. The server account's full-access key holder revokes it by deleting that key; the full-access contract key holder alone can deploy the upgrade (ADR-002/003).
- A malicious Worker can misstate the private target or present a different purchasable item at purchase. An observer can verify saved food and purchased item, not the pet's intention; the UI must not imply otherwise.
- Reserve storage stake and separate transaction gas add project cost. The exact stake and gas require build measurement before mainnet; the protocol stake rate above is stable, the USD conversion is volatile.
- The existing `outfit_buy` project-first path remains for an ordinary owner purchase; its wish path spends only reserve and emits `via: pet_wish`.

## Action items

1. Measure storage and gas and update the project spend ledger before mainnet.
