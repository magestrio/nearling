# ADR-003: Contract upgradeability

**Status:** Accepted — Option A, upgradeable by the user's key with published verified source (OD-92, the user's decision 2026-10-27: «Обновляемый твоим ключом»)
**Date:** 2026-10-27
**Deciders:** the user

## Context
The differentiator is "не перепишут и не сотрут": the character is sealed at birth and lives in the contract (PRODUCT.md §3 › Отличие). Whoever holds the contract account's full-access key can deploy new code, and new code can rewrite any state. "Removing all full-access keys cannot be undone." Publishing verified source (NEP-330, NearBlocks "Verify and Publish") lets a judge read the code that runs (`near-contract` › For the spec). The playtest uses real money on mainnet (§4).

Whatever the option, the birth event records the sha256 of the character; events stay in the explorer for good, so a later rewrite of the character in state is detectable by anyone.

## Options Considered

### Option A: Upgradeable by the user's full-access key
**Pros:** a bug in the caps or the debit found during the real-money playtest can be fixed.
**Cons:** the claim becomes "a rewrite is visible", not "a rewrite is impossible"; the README and the verification page must say the project's key can update the code.

### Option B: Locked at the mainnet launch (all full-access keys removed)
**Pros:** the claim is literal: nobody, the project included, can change the code or the state outside its methods.
**Cons:** no fix for any bug, ever; irreversible.

### Option C: Upgradeable until 2026-11-14, then locked
**Pros:** fixes during the playtest; literal claim after submission.
**Cons:** irreversible after the date; post-hackathon life of the game is out of scope by the user's decision, so locking decides it early.

## Trade-off Analysis
A keeps the game repairable at the cost of a weaker claim; B and C make the claim literal at the cost of never fixing a bug after locking.

## Recommendation
Option A with verified source — a real-money playtest without a fix path is the larger risk, and the character hash in the birth event keeps any rewrite visible for good.

## Decision
Option A (OD-92, the user, 2026-10-27). The contract account's full-access key stays with the user only and never in the Worker; the source is published and verified (NEP-330) before the mainnet launch and after every upgrade.

## Consequences
- The claim reads "a rewrite is visible for good", not "a rewrite is impossible": the README and the verification page say the user's key can update the code.
- A stolen full-access key can rewrite any state, pets' food included; a rewrite of a character stays detectable by its sha256 in the birth event.
- `add-verification` shows whether the contract can be updated and by which account, and compares the character with its birth hash (+~1 Scenario under A or C).
