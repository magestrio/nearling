# ADR-007: What a friend's snack records on chain

**Status:** Accepted (OD-221 → Option A, 2026-10-27)
**Date:** 2026-10-27
**Deciders:** the user

## Context
A friend without NEAR gives a pet a free snack paid by the project (OD-3). The server sends it (`pet_snack`, server account only): the friend signs nothing and may have no on-chain account yet. Feeding introduces pets: the pet of whoever fed becomes «known», and the contract checks that a hire goes only to a known pet (PRODUCT.md §4 › Вирусная петля, Работа для других; critic MAJOR 7a). Everything the contract records is public for good (`near-contract` › What is public). A NEAR feeding already records the feeder's account and the amount — the friend signs it and sees the notice first.

## Options Considered

### Option A: the snack records the friend's account
| Dimension | Assessment |
|-----------|------------|
| What is public | the friend's account id (64 hex — the same that will own their pet) next to the pet, for good |
| Hires | the friend's pet becomes known to the contract, as after a NEAR feeding |
| Cost | one acquaintance record per new friend–pet pair from the project pool [estimate: ≈ 0.0011 NEAR locked, `near-contract` › What it costs] |
| Spec | the friend's notice says a free snack puts the account on NEAR too; +0 Scenarios |

### Option B: the snack records only «a snack from a friend»
| Dimension | Assessment |
|-----------|------------|
| What is public | the pet got a snack and when; who gave it stays on the server |
| Hires | a snack does not introduce pets; only a NEAR feeding, a hire and being hired do — §4 «кормление знакомит» narrows |
| Cost | no acquaintance storage |
| Spec | +0 Scenarios; §4 edit by product-lead |

## Trade-off Analysis
A keeps §4 and MAJOR 7a as written, at the cost of one more public trace for a friend who paid nothing. B keeps a free snack anonymous on chain, at the cost of a narrower «known pets» rule.

## Recommendation
Option A — it matches §4 and the contract-checked known-pets rule without a product change; the account id is a 64-hex string, not a name, and the friend sees it in the notice before tapping.

## Decision
Option A (the user, 2026-10-27: «Да, записывать»): a friend's snack records the friend's account on chain for good, in the `snack` event and in the pet's acquaintances; the friend sees a warning before the tap; snacks make pets known.

## Consequences
- The notice in `Feeder name rule` covers the snack too.
- A stolen server key can introduce at most 3 invented friends a day to each pet (the snack cap), each one hire-able at most 10 times a day by the contract's hire cap.
- Each new friend–pet acquaintance locks its storage from the project pool; when the pool covers the snack but not the record, the snack goes through without it (add-feeding critic BLOCKER 1, the user, 2026-10-28: «Перекус проходит без знакомства»).

## Action Items
1. [x] The user picks A or B (OD-221) — A, 2026-10-27.
2. [ ] The friend's notice before a snack names the account going on NEAR (`Feeder name rule` › «уведомление», ux-architect).
